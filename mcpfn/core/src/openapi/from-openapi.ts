import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
// Runtime imports go through the package name so the `@mcpfn/core/openapi`
// bundle shares the root entry's classes (instanceof, private fields) instead
// of carrying a second copy. Tests and typecheck map the name to src/index.ts.
import {
  createSchemaCompiler,
  McpFnRegistry,
  McpFnValidationError,
  type McpFnJsonSchema,
  type McpFnObjectSchema,
  type SchemaCompiler,
  type SchemaEngine,
} from "@mcpfn/core";
import {
  CONTEXT_FREE_FAILURES,
  documentItems,
  isDefaultDialect,
  isObject,
  isPrototypeName,
  NodeBudget,
  OpenApiSkip,
  parseComponentRef,
  rememberable,
  SchemaConverter,
  TOO_DEEP,
  type OpenApiVersion,
} from "./schema.js";
import { isForbiddenHeader } from "./headers.js";
import type {
  FromOpenApiOptions,
  FromOpenApiResult,
  OpenApiDocument,
  OpenApiDocumentFields,
  OpenApiMethod,
  OpenApiOperation,
  OpenApiOperationParameter,
  OpenApiOperationRef,
  OpenApiOperationRequestBody,
  OpenApiParameterLocation,
  OpenApiParameterQuery,
  OpenApiSecurityScheme,
  OpenApiServer,
  OpenApiSkippedOperation,
  OpenApiToolInfo,
} from "./types.js";

type JsonObject = Record<string, unknown>;

const METHODS = new Map<string, OpenApiMethod>([
  ["get", "GET"],
  ["put", "PUT"],
  ["post", "POST"],
  ["delete", "DELETE"],
  ["options", "OPTIONS"],
  ["head", "HEAD"],
  ["patch", "PATCH"],
  ["trace", "TRACE"],
]);

const SAFE_METHODS = new Set<OpenApiMethod>(["GET", "HEAD"]);
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 2000;

/** A remembered resolution: its target, or its skip thrown afresh. */
function settled(outcome: JsonObject | OpenApiSkip): JsonObject {
  if (outcome instanceof OpenApiSkip) throw new OpenApiSkip(outcome.code, outcome.message);
  return outcome;
}

function entryObject(value: unknown, kind: string): JsonObject {
  if (!isObject(value)) throw new OpenApiSkip("invalid-operation", `a ${kind} entry is not an object`);
  return value;
}

interface SelectorSet {
  operationIds: Set<string>;
  tags: Set<string>;
  routes: Set<string>;
}

function compileSelectors(
  option: "include" | "exclude",
  selectors: readonly unknown[] | undefined,
): SelectorSet | undefined {
  if (selectors === undefined) return undefined;
  if (!Array.isArray(selectors)) {
    throw new McpFnValidationError(`fromOpenAPI ${option} must be an array of selectors`);
  }
  const set: SelectorSet = { operationIds: new Set(), tags: new Set(), routes: new Set() };
  for (const selector of selectors) addSelector(set, option, selector);
  return set;
}

function addSelector(set: SelectorSet, option: "include" | "exclude", selector: unknown): void {
  // Exactly one own enumerable key, and it is operationId.
  const keys = isObject(selector) ? Object.keys(selector) : [];
  if (isObject(selector) && keys.length === 1 && keys[0] === "operationId" && typeof selector.operationId === "string" && selector.operationId) {
    // Exact form, for operationIds that read as a tag or route selector.
    set.operationIds.add(selector.operationId);
    return;
  }
  if (typeof selector !== "string" || selector.trim() === "") {
    throw new McpFnValidationError(
      `fromOpenAPI ${option} selector ${JSON.stringify(selector)} must be a non-empty string or { operationId }`,
    );
  }
  const route = /^([A-Za-z]+)\s+(\/\S*)$/.exec(selector);
  if (selector.startsWith("tag:")) {
    const tag = selector.slice("tag:".length);
    if (!tag) throw new McpFnValidationError(`fromOpenAPI ${option} selector "tag:" needs a tag name`);
    set.tags.add(tag);
  } else if (route && METHODS.has(route[1]!.toLowerCase())) {
    set.routes.add(`${route[1]!.toUpperCase()} ${route[2]}`);
  } else {
    set.operationIds.add(selector);
  }
}

type OperationIdentity = Pick<OpenApiOperation, "method" | "path" | "operationId" | "tags">;

function matches(set: SelectorSet, operation: OperationIdentity): boolean {
  return (
    (operation.operationId !== undefined && set.operationIds.has(operation.operationId)) ||
    operation.tags.some((tag) => set.tags.has(tag)) ||
    set.routes.has(`${operation.method} ${operation.path}`)
  );
}

function describeOperation(operation: OpenApiOperationRef): string {
  const route = `${operation.method ?? "*"} ${operation.path}`;
  return operation.operationId ? `${route} (operationId ${operation.operationId})` : route;
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, MAX_NAME_LENGTH);
}

function defaultName(operation: OpenApiOperation, prefix: string): string {
  if (operation.operationId) return sanitizeName(prefix + operation.operationId);
  const segments = operation.path
    .split("/")
    .map((segment) => segment.replace(/[{}]/g, ""))
    .filter(Boolean);
  return sanitizeName(prefix + [operation.method.toLowerCase(), ...segments].join("_"));
}

function cap(text: string, length: number): string {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  // Never leave half of a surrogate pair at the end.
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

function toolDescription(operation: OpenApiOperation): string {
  const text = [operation.summary, operation.description]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  return cap(text || `${operation.method} ${operation.path}`, MAX_DESCRIPTION_LENGTH);
}

function toolAnnotations(method: OpenApiMethod): ToolAnnotations {
  return {
    ...(SAFE_METHODS.has(method) ? { readOnlyHint: true } : {}),
    ...(method === "DELETE" ? { destructiveHint: true } : {}),
    ...(method === "PUT" || method === "DELETE" ? { idempotentHint: true } : {}),
    openWorldHint: true,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// OpenAPI 3.0/3.1: an absent or empty `servers` array means `[{ url: "/" }]`.
// An empty level (or one with no usable entry) defers to the next outer level.
function servers(...levels: unknown[]): OpenApiServer[] {
  for (const level of levels) {
    if (!Array.isArray(level)) continue;
    const usable = documentItems(level, "invalid-operation")
      .filter((server): server is JsonObject => isObject(server) && typeof server.url === "string")
      .map((server) => ({
        url: server.url as string,
        ...(typeof server.description === "string" ? { description: server.description } : {}),
        ...(isObject(server.variables)
          ? { variables: checkedVariables(server.variables) }
          : {}),
      }));
    if (usable.length > 0) return usable;
  }
  return [{ url: "/" }];
}

function security(...levels: unknown[]): OpenApiOperation["security"] {
  for (const level of levels) {
    if (Array.isArray(level)) {
      const requirements = documentItems(level, "invalid-operation").filter(isObject);
      // Scope lists reach the executor and the naming callback as arrays.
      for (const requirement of requirements) checkMetadata(checkedRequirements, requirement, (scopes) => scopes);
      return requirements as Record<string, string[]>[];
    }
  }
  return undefined;
}

/**
 * Why the effective security requirements cannot be read strictly: a level
 * that is present but not a list, a requirement that is not an object, or
 * one whose scopes are not a list of strings. `security` leaves such a
 * requirement out, so an executor that sends credentials must refuse the
 * operation rather than read the rest as the whole requirement.
 */
function securityProblem(...levels: unknown[]): string | undefined {
  for (const [index, level] of levels.entries()) {
    if (level === undefined) continue;
    const where = index === 0 ? "the operation's" : "the document's";
    if (!Array.isArray(level)) return `${where} security is not a list of requirements`;
    // A shared list (the document's) is read once.
    let problem = securityProblems.get(level);
    if (problem === undefined) {
      problem = requirementsProblem(level) ?? null;
      securityProblems.set(level, problem);
    }
    return problem === null ? undefined : problem.replace("{where}", where);
  }
  return undefined;
}

const securityProblems = new WeakMap<object, string | null>();

function requirementsProblem(level: readonly unknown[]): string | undefined {
  for (const requirement of level) {
    if (!isObject(requirement)) return "{where} security has a requirement that is not an object";
    for (const [name, scopes] of Object.entries(requirement)) {
      if (!Array.isArray(scopes) || !(scopes as unknown[]).every((scope) => typeof scope === "string")) {
        return `the scopes of the security scheme ${JSON.stringify(name)} are not a list of strings`;
      }
    }
  }
  return undefined;
}

function securityUnresolved(problem: string | undefined): { securityUnresolved?: string } {
  return problem === undefined ? {} : { securityUnresolved: problem };
}

/** Server variables, whose `enum` lists reach the executor and the naming callback as arrays. */
function checkedVariables(variables: JsonObject): OpenApiServer["variables"] {
  checkMetadata(checkedVariableMaps, variables, (variable) => (isObject(variable) ? variable.enum : undefined));
  return variables as OpenApiServer["variables"];
}

/**
 * Security requirements and server variables maps whose member lists were
 * checked, with the failure if one was irregular, so shared ones are read
 * once. Kept per role: each role reads different lists of the same object.
 */
const checkedRequirements = new WeakMap<object, OpenApiSkip | null>();
const checkedVariableMaps = new WeakMap<object, OpenApiSkip | null>();

/** Check the list `listOf` picks from each member of `metadata`, once per object and role (`checked`). */
function checkMetadata(checked: WeakMap<object, OpenApiSkip | null>, metadata: JsonObject, listOf: (member: unknown) => unknown): void {
  let failure = checked.get(metadata);
  if (failure === undefined) {
    failure = null;
    for (const member of Object.values(metadata)) {
      const list = listOf(member);
      if (!Array.isArray(list)) continue;
      try {
        documentItems(list, "invalid-operation");
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        failure = error;
        break;
      }
    }
    checked.set(metadata, failure);
  }
  if (failure) throw failure;
}

function optionalSecurity(requirements: OpenApiOperation["security"]): { security?: OpenApiOperation["security"] } {
  return requirements === undefined ? {} : { security: requirements };
}

function optionalSchemes(
  schemes: OpenApiOperation["securitySchemes"],
): { securitySchemes?: OpenApiOperation["securitySchemes"] } {
  return schemes === undefined ? {} : { securitySchemes: schemes };
}

const SCHEME_TYPES = new Set(["apiKey", "http", "oauth2", "openIdConnect", "mutualTLS"]);

/** What an executor needs of a security scheme object: its type and, for `apiKey` and `http`, where the credential goes. */
function schemeInfo(raw: JsonObject): OpenApiSecurityScheme | undefined {
  // A type OpenAPI does not define (such as "api-key") does not resolve, so its credential is not guessed.
  if (typeof raw.type !== "string" || !SCHEME_TYPES.has(raw.type)) return undefined;
  const placed = raw.type === "apiKey" && typeof raw.name === "string" && (raw.in === "header" || raw.in === "query" || raw.in === "cookie");
  return {
    type: raw.type,
    ...(placed ? { name: raw.name as string, in: raw.in as "header" | "query" | "cookie" } : {}),
    ...(raw.type === "http" && typeof raw.scheme === "string" ? { scheme: raw.scheme } : {}),
  };
}

/** Whether a parameter is the one an apiKey scheme sends its credential in; header names compare without case. */
function isCredentialParameter(scheme: OpenApiSecurityScheme, name: string, location: string): boolean {
  if (scheme.type !== "apiKey" || scheme.in !== location || scheme.name === undefined) return false;
  return location === "header" ? scheme.name.toLowerCase() === name.toLowerCase() : scheme.name === name;
}

function isJsonMediaType(key: string): boolean {
  const type = key.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/.test(type);
}

function isApplicationJson(key: string): boolean {
  return key.split(";")[0]!.trim().toLowerCase() === "application/json";
}

const SUCCESS_STATUS = /^2(?:\d\d|XX)$/i;

/** The `{name}` variables of a path template, scanned without backtracking. */
function templateVariables(path: string): string[] {
  const names: string[] = [];
  let start = path.indexOf("{");
  while (start !== -1) {
    const end = path.indexOf("}", start + 1);
    if (end === -1) break;
    if (end > start + 1) names.push(path.slice(start + 1, end));
    start = path.indexOf("{", end + 1);
  }
  return names;
}

interface Candidate {
  operation: OpenApiOperation;
  inputSchema: McpFnObjectSchema;
  outputSchema?: McpFnObjectSchema;
}

class OperationConverter {
  private readonly components: JsonObject;
  private readonly schemas: SchemaConverter;
  private compiler: SchemaCompiler | undefined;
  /** Tool schemas by content, when tools share them (see `toolSchema`). */
  private readonly shared = new Map<string, McpFnObjectSchema | undefined | OpenApiSkip>();
  /** Nodes in each tool schema's copy, which its catalog entry copies again (`register`). */
  private readonly copyNodes = new WeakMap<object, number>();
  /** Catalog copies charged, in document order, for tools holding each tool schema and not yet claimed when they register. */
  private readonly reserved = new WeakMap<object, number>();
  /** Shared tool schemas compiled once, at their first reuse, before reuses are charged. */
  private readonly reuseChecked = new WeakSet<object>();
  /** Shared schemas whose reuse check the document budget refused, with the room it left. */
  private readonly exhausted = new WeakMap<object, { room: number; error: OpenApiSkip }>();
  /** Shared tool schemas that check found the registry would refuse, with why: every tool holding one is skipped, the first included. */
  private readonly refused = new WeakMap<object, OpenApiSkip>();
  /**
   * Validator frames each tool schema stacks for one value
   * (`SchemaConverter.frames`), measured (and charged) only when the
   * @cfworker/json-schema depth check asks (`framesOf`).
   */
  private readonly toolFrames = new WeakMap<object, number | (() => number)>();
  /** How deep @cfworker/json-schema validates on this call's stack, measured once per call. */
  private readonly depth = new ValidationDepth((nodes) => this.schemas.chargeCopy(nodes));
  /** Why a schema checked as written failed to compile (null: it compiled), by source object and by content. */
  private readonly checkedAsWritten = new WeakMap<object, string | null | OpenApiSkip>();
  /** Request body schemas whose checked conversion failed for a reason of their own, for optional and required bodies. */
  private readonly bodyFailures = [new WeakMap<object, OpenApiSkip>(), new WeakMap<object, OpenApiSkip>()] as const;
  /** Why each request body schema chosen among several entries fails to compile (null when it compiles), for optional and required bodies. */
  private readonly bodyVerdicts = [new WeakMap<object, string | null>(), new WeakMap<object, string | null>()] as const;
  private readonly verdicts = new Map<string, string | null>();

  constructor(
    private readonly document: JsonObject,
    version: OpenApiVersion,
    /** Whether tools may share identical schema objects (see `toolSchema`). */
    private readonly shareSchemas: boolean,
    /** Whether an output schema must describe every documented success (`OpenApiExecutor.outputSchemaRule`). */
    private readonly everySuccess = false,
    /** Query and header parameters the executor supplies itself (`OpenApiExecutor.ownsParameter`). */
    private readonly ownsParameter?: (parameter: OpenApiParameterQuery) => boolean,
  ) {
    this.components = isObject(document.components) ? document.components : {};
    const dialect = document.jsonSchemaDialect;
    this.schemas = new SchemaConverter(
      version,
      isObject(this.components.schemas) ? this.components.schemas : {},
      NodeBudget.forDocument(document),
      version === "3.1" && dialect !== undefined && !isDefaultDialect(dialect) ? JSON.stringify(dialect) : undefined,
    );
  }

  /**
   * One operation as a tool candidate. The input and the output each get
   * their own node budget, which conversion and copying both charge.
   */
  candidate(path: string, pathItem: JsonObject, method: OpenApiMethod, raw: JsonObject): Candidate {
    // Catalog copies reserved for an operation that then fails are given back.
    this.pending = [];
    try {
      const { inputs, inputSchema } = this.input(path, pathItem, raw);
      const operation = deepFreeze(this.operation(path, pathItem, method, raw, inputs));
      const outputSchema = this.schemas.budgeted(() => this.outputSchema(raw, method));
      const holder = { schemas: this.pending, dropped: false };
      this.holders.set(operation, holder);
      for (const schema of holder.schemas) {
        if (!this.holdersOf.has(schema)) this.holdersOf.set(schema, []);
        this.holdersOf.get(schema)!.push(holder);
      }
      return { operation, inputSchema, ...(outputSchema ? { outputSchema } : {}) };
    } catch (error) {
      this.dropReservations(this.pending);
      throw error;
    } finally {
      this.pending = [];
    }
  }

  /** Tool schemas holding a catalog copy reserved for the operation being converted. */
  private pending: object[] = [];
  /** The catalog copies each converted operation reserved, given back once (`dropOperation`). */
  private readonly holders = new WeakMap<object, Holder>();
  /** The operations holding a reservation made with each tool schema. */
  private readonly holdersOf = new WeakMap<object, Holder[]>();

  /**
   * The outcome of following each component's `$ref` chain, per kind: every
   * link is decoded once per call, however many operations share the chain.
   */
  private readonly resolved = new Map<string, JsonObject | OpenApiSkip>();
  /** By kind, the outcome for each `$ref` entry object, so a shared entry is decoded once per call. */
  private readonly resolvedEntries = {
    parameters: new WeakMap<object, JsonObject | OpenApiSkip>(),
    requestBodies: new WeakMap<object, JsonObject | OpenApiSkip>(),
    responses: new WeakMap<object, JsonObject | OpenApiSkip>(),
  };

  /** Follow a `$ref` chain to a parameter, request body or response object. */
  resolve(value: unknown, kind: "parameters" | "requestBodies" | "responses"): JsonObject {
    // Every resolution is charged to the call's total, and each link it decodes.
    this.schemas.chargeWork(1);
    if (!isObject(value) || !("$ref" in value)) return entryObject(value, kind);
    const remembered = this.resolvedEntries[kind].get(value);
    if (remembered !== undefined) return settled(remembered);
    const visited = new Map<string, number>();
    let current: unknown = value;
    let outcome: JsonObject | OpenApiSkip | undefined;
    let cycleStart = -1;
    while (isObject(current) && "$ref" in current) {
      // Charged before each link is decoded: a walk the total refuses stops
      // there and leaves nothing remembered for a later operation to reuse.
      this.schemas.chargeWork(1);
      let name: string;
      try {
        name = parseComponentRef(current.$ref, kind);
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        outcome = error;
        break;
      }
      outcome = this.resolved.get(`${kind}/${name}`);
      if (outcome !== undefined) break;
      if (visited.has(name)) {
        cycleStart = visited.get(name)!;
        break;
      }
      visited.set(name, visited.size);
      const section = this.components[kind];
      if (!isObject(section) || !Object.hasOwn(section, name)) {
        outcome = new OpenApiSkip("unresolved-ref", `reference #/components/${kind}/${name} has no target`);
        break;
      }
      current = section[name];
    }
    if (outcome === undefined && cycleStart < 0) {
      outcome = isObject(current) ? current : new OpenApiSkip("invalid-operation", `a ${kind} entry is not an object`);
    }
    // Each name on the chain shares its outcome, except that a name on a
    // cycle reports the cycle through itself, as a walk starting there would.
    const names = [...visited.keys()];
    outcome ??= new OpenApiSkip("unresolved-ref", `reference cycle through #/components/${kind}/${names[cycleStart]}`);
    names.forEach((name, index) => {
      this.resolved.set(`${kind}/${name}`, cycleStart >= 0 && index >= cycleStart
        ? new OpenApiSkip("unresolved-ref", `reference cycle through #/components/${kind}/${name}`)
        : outcome);
    });
    const result = names.length > 0 ? this.resolved.get(`${kind}/${names[0]}`)! : outcome;
    this.resolvedEntries[kind].set(value, result);
    return settled(result);
  }

  operation(
    path: string,
    pathItem: JsonObject,
    method: OpenApiMethod,
    raw: JsonObject,
    { parameters, body }: OperationInputs,
  ): OpenApiOperation {
    return {
      method,
      path,
      ...(optionalString(raw.operationId) ? { operationId: raw.operationId as string } : {}),
      ...(optionalString(raw.summary) ? { summary: raw.summary as string } : {}),
      ...(optionalString(raw.description) ? { description: raw.description as string } : {}),
      tags: tagsOf(raw),
      deprecated: raw.deprecated === true,
      parameters: parameters.map(({ parameter }) => parameter),
      ...(body ? { requestBody: body.info } : {}),
      servers: servers(raw.servers, pathItem.servers, this.document.servers),
      ...optionalSecurity(security(raw.security, this.document.security)),
      ...securityUnresolved(securityProblem(raw.security, this.document.security)),
      ...optionalSchemes(this.securitySchemes(raw)),
    };
  }

  /** The resolved schemes named by each security requirement list, by list. */
  private readonly schemesByLevel = new WeakMap<object, Readonly<Record<string, OpenApiSecurityScheme>> | undefined>();
  /** Each security scheme name's resolution (null: it does not resolve). */
  private readonly schemeOutcomes = new Map<string, OpenApiSecurityScheme | null>();

  /**
   * The schemes the operation's effective security requirements name that
   * `components.securitySchemes` defines. A name that does not resolve
   * (also one whose `type` OpenAPI does not define) is left out, so an executor can tell it from `security` and refuse the
   * operation (`httpExecutor` does) rather than guess its credential.
   */
  securitySchemes(raw: JsonObject): Readonly<Record<string, OpenApiSecurityScheme>> | undefined {
    const level = [raw.security, this.document.security].find(Array.isArray);
    if (level === undefined) return undefined;
    if (this.schemesByLevel.has(level)) return this.schemesByLevel.get(level);
    let requirements: unknown[];
    try {
      requirements = documentItems(level, "invalid-operation");
    } catch (error) {
      if (error instanceof OpenApiSkip) return undefined;
      throw error;
    }
    const found = new Map<string, OpenApiSecurityScheme>();
    for (const requirement of requirements) {
      if (!isObject(requirement)) continue;
      for (const name of Object.keys(requirement)) {
        const scheme = found.has(name) ? undefined : this.securityScheme(name);
        if (scheme) found.set(name, scheme);
      }
    }
    const result = found.size === 0 ? undefined : deepFreeze(Object.fromEntries(found));
    this.schemesByLevel.set(level, result);
    return result;
  }

  /** A security scheme of `components.securitySchemes`, its `$ref` chain followed; a chain that ends nowhere gives none. */
  private securityScheme(name: string): OpenApiSecurityScheme | undefined {
    const known = this.schemeOutcomes.get(name);
    if (known !== undefined) return known ?? undefined;
    const section = isObject(this.components.securitySchemes) ? this.components.securitySchemes : {};
    let current: unknown = Object.hasOwn(section, name) ? section[name] : undefined;
    const visited = new Set([name]);
    while (isObject(current) && "$ref" in current) {
      this.schemas.chargeWork(1);
      let target: string;
      try {
        target = parseComponentRef(current.$ref, "securitySchemes");
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        current = undefined;
        break;
      }
      current = !visited.has(target) && Object.hasOwn(section, target) ? section[target] : undefined;
      visited.add(target);
    }
    const scheme = isObject(current) ? schemeInfo(current) : undefined;
    this.schemeOutcomes.set(name, scheme ?? null);
    return scheme;
  }

  /**
   * The tool input with the first request body entry it can be built with:
   * each entry is tried with the whole input (conversion, projection, a
   * compile check and the assembled copy) within its own node budget. When
   * none works, the first entry's failure is reported. The parameters are
   * converted once beforehand, within their own node budget, so every entry
   * gets the same budget whatever its position; an entry whose schema object
   * already failed is not converted again.
   */
  private input(path: string, pathItem: JsonObject, raw: JsonObject): { inputs: OperationInputs; inputSchema: McpFnObjectSchema } {
    // Parameters first, so their skip reasons come before the body's.
    const parameters = this.schemas.budgeted(() => this.parameters(path, pathItem, raw));
    const bodies = this.requestBodies(raw);
    // Within one operation an entry's result depends only on its schema object.
    const failed = new Map<unknown, OpenApiSkip>();
    const attempt = (index: number) =>
      this.schemas.budgeted(() => {
        const inputs = { parameters, body: bodies[index] };
        // A sole entry is checked when the tool is registered.
        return { inputs, inputSchema: this.inputSchema(inputs, bodies.length > 1) };
      });
    let failure: OpenApiSkip | undefined;
    for (let index = 0; ; index += 1) {
      try {
        const known = index > 0 ? failed.get(bodies[index]!.schema) : undefined;
        if (known) throw known;
        return attempt(index);
      } catch (error) {
        // No body or a sole entry: the failure is the operation's.
        if (bodies.length <= 1) throw error;
        const skip = candidateFailure(error);
        failed.set(bodies[index]!.schema, skip);
        failure ??= skip;
        if (index + 1 >= bodies.length) throw failure;
      }
    }
  }

  /** Parameters and the request body as one tool input schema (D11). */
  inputSchema({ parameters, body }: OperationInputs, checkBody = false): McpFnObjectSchema {
    const refs = new Set<string>();
    const groups: Array<[string, McpFnJsonSchema | boolean]> = [];
    const required: string[] = [];
    // The body first: an entry that fails costs no work on the parameter groups.
    let bodyGroup: McpFnJsonSchema | boolean | undefined;
    const bodyRefs = new Set<string>();
    if (body) {
      const check = () => {
        // A media type object without `schema` declares no schema: it accepts any JSON value.
        bodyGroup = body.schema === undefined ? {} : this.schemas.convertRoot(body.schema, "input", bodyRefs);
        this.assertProjectable(body.schema, "input", "request body");
        if (checkBody) this.assertBodyCompiles(body.schema, bodyGroup, bodyRefs, body.info.required);
      };
      // A checked entry's schema that failed for a reason of its own fails again without any work.
      if (checkBody && isObject(body.schema)) remembered(this.bodyFailures[body.info.required ? 1 : 0], body.schema, check);
      else check();
    }
    for (const location of ["path", "query", "header"] as const) {
      const members = parameters.filter(({ parameter }) => parameter.in === location);
      if (members.length === 0) continue;
      const properties = Object.fromEntries(
        members.map(({ parameter, schema: converted, refs: parameterRefs, description }) => {
          for (const name of parameterRefs) refs.add(name);
          return [
            parameter.name,
            description && isObject(converted) && !("$ref" in converted) && converted.description === undefined
              ? { ...converted, description }
              : converted,
          ];
        }),
      );
      const requiredNames = members.filter(({ parameter }) => parameter.required).map(({ parameter }) => parameter.name);
      groups.push([
        location,
        {
          type: "object",
          properties,
          ...(requiredNames.length > 0 ? { required: requiredNames } : {}),
          additionalProperties: false,
        },
      ]);
      if (requiredNames.length > 0) required.push(location);
    }
    for (const name of bodyRefs) refs.add(name);
    if (body && bodyGroup !== undefined) {
      groups.push(["body", bodyGroup]);
      if (body.info.required) required.push("body");
    }
    const root: McpFnObjectSchema = {
      type: "object",
      properties: Object.fromEntries(groups) as Record<string, McpFnJsonSchema>,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    };
    const definitions = this.schemas.definitions(refs, "input");
    return this.toolSchema("input", root, definitions, () => root)!;
  }

  /**
   * Leaving out the properties flagged for `mode` must be sound, and must not
   * hide a declaration the registry would reject: a schema that flags any is
   * also compiled as written.
   */
  private assertProjectable(schema: unknown, mode: "input" | "output", subject: string): void {
    if (schema === undefined || !this.schemas.flagsFor(schema, mode)) return;
    this.assertCompilesAsWritten(schema, subject);
    this.schemas.checkProjection(schema, mode);
  }

  /**
   * A tool schema built by `finish` (which may inline the converted `root` or
   * find it unusable) as a tree-shaped copy. In a registry `fromOpenAPI`
   * creates, tools with identical schemas share one deeply frozen copy, so
   * its Ajv compiles it once (it caches by schema object) and no tool can
   * change another's; `register` keeps the registry's observable state as
   * with fresh copies. A supplied registry gets a fresh copy per tool. Within
   * one call equal definition names are the same converted components, so
   * only the root is compared by content.
   */
  private toolSchema(
    kind: "input" | "output",
    root: McpFnJsonSchema | boolean,
    definitions: Record<string, McpFnJsonSchema | boolean>,
    finish: () => McpFnObjectSchema | undefined,
  ): McpFnObjectSchema | undefined {
    const produce = () => {
      const schema = finish();
      if (schema === undefined) return undefined;
      // Every copy is charged to the call's total node by node while it is
      // made, the root included (it may inline a component or hold a large
      // literal): a copy that fails is charged for what it copied. The root
      // goes first, so one that fails is charged nothing for the definitions.
      const budget = this.schemas.copyBudget();
      const copied: McpFnObjectSchema = Object.keys(definitions).length === 0
        ? treeCopy(schema, budget)
        : {
            ...(treeCopy(Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "definitions")), budget) as McpFnObjectSchema),
            definitions: treeCopy(definitions, budget),
          };
      this.copyNodes.set(copied, budget.used);
      // The catalog copy of the tool holding it, charged in document order.
      this.schemas.chargeCopy(budget.used);
      this.reserved.set(copied, 1);
      this.pending.push(copied);
      // Measured on the root as registered: an inlined root `$ref` stacks no frame.
      this.toolFrames.set(copied, () => this.schemas.frames(schema, kind));
      return copied;
    };
    if (!this.shareSchemas) return produce();
    const values = { json: true, chars: 0 };
    const key = contentKey(kind, treeCopy(root, this.schemas.copyBudget(), values), values, definitions);
    if (key === undefined) return produce();
    const known = this.shared.get(key);
    // A schema whose copy failed fails the same way for every tool with the same content.
    if (known instanceof OpenApiSkip) throw known;
    if (known !== undefined) {
      // A schema the registry will refuse holds no catalog copies: it is
      // compiled once, at its first reuse, to know. Its first holder's
      // reservation is given back now, and every holder gets its verdict.
      if (!this.reuseChecked.has(known)) {
        // A check the document budget refused fails the same way until there is
        // more room than it left: work it completed and kept is charged in that.
        const stale = this.exhausted.get(known);
        if (stale !== undefined && this.schemas.room() <= stale.room) throw stale.error;
        let skip: OpenApiSkip | undefined;
        try {
          const failure = this.compileFailure(known, () => this.framesOf(known));
          if (failure !== null) skip = invalidSkip(failure, kind);
        } catch (error) {
          // A check the document budget has no room for fails this tool only:
          // earlier holders keep their verdict, and a later reuse checks again
          // once released reservations make room. Any other skip refuses the schema.
          if (!(error instanceof OpenApiSkip)) throw error;
          if (!rememberable(error)) {
            this.exhausted.set(known, { room: this.schemas.room(), error });
            throw error;
          }
          skip = error;
        }
        this.reuseChecked.add(known);
        if (skip !== undefined) {
          this.shared.set(key, skip);
          this.refused.set(known, skip);
          // Every operation already holding it will be skipped: all it reserved goes back now.
          for (const holder of this.holdersOf.get(known) ?? []) this.release(holder);
          throw skip;
        }
      }
      this.schemas.chargeCopy(this.copyNodes.get(known) ?? 0);
      this.reserved.set(known, (this.reserved.get(known) ?? 0) + 1);
      this.pending.push(known);
      return known;
    }
    if (this.shared.has(key)) return undefined;
    try {
      const result = produce();
      this.shared.set(key, result && deepFreeze(result));
      return result;
    } catch (error) {
      // A refusal of the document budget alone is not remembered: a later tool may find room.
      if (error instanceof OpenApiSkip && rememberable(error)) this.shared.set(key, error);
      throw error;
    }
  }

  /**
   * Hold the catalog copy of a tool with these schemas (`register`): a
   * reservation made with a schema is claimed, the rest is charged now, or
   * nothing when it does not fit. Returns the nodes held, given back with
   * `releaseCopy` when the tool does not register.
   */
  holdCatalog(schemas: readonly object[]): number {
    let now = 0;
    let claimed = 0;
    for (const schema of schemas) {
      const nodes = this.copyNodes.get(schema) ?? 0;
      if ((this.reserved.get(schema) ?? 0) > 0) claimed += nodes;
      else now += nodes;
    }
    this.schemas.chargeCopy(now);
    for (const schema of schemas) this.claim(schema);
    return now + claimed;
  }

  /** Take one reservation made with `schema`, if any; whether there was one. */
  private claim(schema: object): boolean {
    const count = this.reserved.get(schema) ?? 0;
    if (count > 0) this.reserved.set(schema, count - 1);
    return count > 0;
  }

  /** Why the registry would refuse a tool schema here, found when it was reused (`toolSchema`). */
  refusal(schemas: readonly object[]): OpenApiSkip | undefined {
    for (const schema of schemas) {
      const skip = this.refused.get(schema);
      if (skip) return skip;
    }
    return undefined;
  }

  /** Give back the catalog copies a converted operation reserved, for a tool that will not register. */
  dropOperation(operation: object): void {
    const holder = this.holders.get(operation);
    if (holder) this.release(holder);
  }

  private release(holder: Holder): void {
    if (holder.dropped) return;
    holder.dropped = true;
    this.dropReservations(holder.schemas);
  }

  /** Give back the catalog copies reserved with these schemas. */
  private dropReservations(schemas: readonly object[]): void {
    for (const schema of schemas) {
      if (this.claim(schema)) this.schemas.releaseCopy(this.copyNodes.get(schema) ?? 0);
    }
  }

  releaseCopy(nodes: number): void {
    this.schemas.releaseCopy(nodes);
  }

  /** Whether @cfworker/json-schema validates a value against each of these tool schemas without overflowing its stack. */
  validatesDeepEnough(schemas: readonly object[]): boolean {
    let frames = 0;
    for (const schema of schemas) frames = Math.max(frames, this.framesOf(schema));
    return this.depth.fits(frames);
  }

  /** The frames a tool schema stacks (`toolFrames`), measured once. */
  private framesOf(schema: object): number {
    const known = this.toolFrames.get(schema);
    if (typeof known !== "function") return known ?? 0;
    const frames = known();
    this.toolFrames.set(schema, frames);
    return frames;
  }

  /**
   * The schema of the first 2xx `application/json` response entry that has
   * one. It is always converted, so the skip rules apply whatever its shape
   * or method; it becomes the output schema only when it accepts objects and
   * nothing else, and never for `HEAD`, whose response has no body. Under the
   * `every-success` rule, also only when every documented 2xx response
   * offers only JSON content with that same schema: a call that may succeed
   * with another body (or none) has no single output.
   */
  outputSchema(raw: JsonObject, method: OpenApiMethod): McpFnObjectSchema | undefined {
    const schema = this.responseSchema(raw);
    if (schema === undefined) return undefined;
    return this.convertOutput(schema, method, !this.everySuccess || this.everySuccessHas(raw, schema));
  }

  private responseSchema(raw: JsonObject): unknown {
    if (!isObject(raw.responses)) return undefined;
    // Key order: integer status codes ascend (JavaScript object order), then 2XX.
    for (const [status, value] of Object.entries(raw.responses)) {
      if (!SUCCESS_STATUS.test(status)) continue;
      const content = this.resolve(value, "responses").content;
      for (const [mediaType, media] of Object.entries(isObject(content) ? content : {})) {
        if (isApplicationJson(mediaType) && isObject(media) && media.schema !== undefined) return media.schema;
      }
    }
    return undefined;
  }

  /**
   * Whether every documented 2xx response has content, all of it JSON
   * (`application/json` or `*+json`) declaring `schema`. A `2XX` range
   * answers no: it covers `204` and `205`, which have no body. A response that
   * cannot be resolved describes no known body, so it answers no; it never
   * skips the operation.
   */
  private everySuccessHas(raw: JsonObject, schema: unknown): boolean {
    if (!isObject(raw.responses)) return false;
    for (const [status, value] of Object.entries(raw.responses)) {
      if (!SUCCESS_STATUS.test(status)) continue;
      // A 2XX range also documents 204 and 205, which carry no body.
      if (/^2XX$/i.test(status)) return false;
      let content: unknown;
      try {
        content = this.resolve(value, "responses").content;
      } catch (error) {
        if (error instanceof OpenApiSkip) return false;
        throw error;
      }
      const entries = Object.entries(isObject(content) ? content : {});
      if (entries.length === 0) return false;
      for (const [mediaType, media] of entries) {
        if (!isJsonMediaType(mediaType) || !isObject(media) || !sameSchema(media.schema, schema)) return false;
      }
    }
    return true;
  }

  private convertOutput(schema: unknown, method: OpenApiMethod, exclusive: boolean): McpFnObjectSchema | undefined {
    // structuredContent is always an object: a nullable or mixed schema
    // (3.0 `nullable`, `type: ["object", "null"]`, `oneOf` with a string) has none.
    const { values } = this.schemas.admits(schema);
    const objectOnly = exclusive && method !== "HEAD" && values.size === 1 && values.has("object");
    // A schema the registry would reject is not hidden by discarding it, nor
    // by leaving out writeOnly properties: those are checked as written
    // (which applies the same skip rules as converting it).
    if (!objectOnly) {
      this.assertCompilesAsWritten(schema, "response");
      return undefined;
    }
    const refs = new Set<string>();
    const root = this.schemas.convertRoot(schema, "output", refs);
    const definitions = this.schemas.definitions(refs, "output");
    // An output that cannot be projected soundly skips the operation, so no
    // tool returns structured content its schema would not have checked.
    this.assertProjectable(schema, "output", "response");
    return this.toolSchema("output", root, definitions, () => this.outputRoot(root, definitions));
  }

  /** The object root of an output schema, or none when it cannot be one. */
  private outputRoot(
    converted: McpFnJsonSchema | boolean,
    definitions: Record<string, McpFnJsonSchema | boolean>,
  ): McpFnObjectSchema | undefined {
    let root = converted;
    // A root `$ref` is inlined: draft-07 ignores keywords beside `$ref`, and
    // mcpFn needs `type: "object"` on the root itself.
    const seen = new Set<string>();
    while (isObject(root) && typeof root.$ref === "string" && Object.keys(root).length === 1) {
      const name = root.$ref.slice("#/definitions/".length);
      if (seen.has(name)) return undefined;
      seen.add(name);
      root = definitions[name]!;
    }
    if (!isObject(root)) return undefined;
    // Nor by replacing a root type, such as `["object", "bogus"]`, or root
    // definitions with the generated ones (`toolSchema`).
    const replacesDefinitions = Object.hasOwn(root, "definitions") && Object.keys(definitions).length > 0;
    if ((root.type !== undefined && root.type !== "object") || replacesDefinitions) {
      throwIfInvalid(this.compileVerdict(root, definitions, "output"), "response");
    }
    // The root may carry its object type only through a reference or a
    // composition (`{ $ref, description }` in 3.1, `allOf: [...]`); stating it
    // on the root narrows nothing, since only objects are accepted.
    return { ...root, type: "object" } as McpFnObjectSchema;
  }

  /** Checked once per source schema object, and compiled once per distinct converted schema. */
  private assertCompilesAsWritten(schema: unknown, subject: string): void {
    let verdict = isObject(schema) ? this.checkedAsWritten.get(schema) : undefined;
    if (verdict instanceof OpenApiSkip) throw verdict;
    if (verdict === undefined) {
      try {
        const refs = new Set<string>();
        const root = this.schemas.convertRoot(schema, "plain", refs);
        verdict = this.compileVerdict(root, this.schemas.definitions(refs, "plain"), "plain");
      } catch (error) {
        if (isObject(schema) && error instanceof OpenApiSkip && CONTEXT_FREE_FAILURES.has(error.code)) this.checkedAsWritten.set(schema, error);
        throw error;
      }
      if (isObject(schema)) this.checkedAsWritten.set(schema, verdict);
    }
    throwIfInvalid(verdict, subject);
  }

  /**
   * Why a selected schema fails to compile as the registry would compile it
   * (null when it compiles), before it is discarded or rewritten. Kept by
   * content, so a schema many operations share is copied and compiled once.
   */
  private compileVerdict(
    root: McpFnJsonSchema | boolean,
    definitions: Record<string, unknown>,
    mode: "plain" | "input" | "output",
    required = true,
    enclosed = false,
  ): string | null {
    if (!isObject(root)) return null;
    const budget = this.schemas.copyBudget();
    const values = { json: true, chars: 0 };
    const copy = treeCopy(root, budget, values);
    // Definitions with the same names differ between modes. The key holds
    // the whole copy, so it covers the wrapper built from it below.
    const key = contentKey(`compile:${mode}:${required}:${enclosed}`, copy, values, definitions);
    let failure = key === undefined ? undefined : this.verdicts.get(key);
    if (failure === undefined) {
      // The generated definitions go on a wrapper, as in a tool schema, so
      // they never replace definitions the schema itself declares.
      const wrapped = Object.keys(definitions).length > 0;
      // How deep a value nests is checked on the contract the registry
      // validates, never on a schema as written before projection. A schema
      // only checked (`plain`) is measured in place, as a compiler reads it.
      failure = this.compileFailure(
        wrapped ? { type: "object", properties: { value: copy }, definitions: treeCopy(definitions, budget) } : copy,
        // A required body stacks on the tool input's own frame, as when it registers.
        () => this.schemas.frames(root, mode, required) + (enclosed && required ? 1 : 0),
      );
      if (key !== undefined) this.verdicts.set(key, failure);
    }
    return failure;
  }

  private compileFailure(schema: object, frames: () => number): string | null {
    this.compiler ??= createSchemaCompiler();
    try {
      this.compiler.compile(schema);
    } catch (error) {
      if (error instanceof RangeError) return TOO_DEEP_VERDICT;
      return error instanceof Error ? error.message : String(error);
    }
    // @cfworker/json-schema follows references only while validating, so
    // its compile never overflows on a chain too deep to validate.
    return this.compiler.engine === "cfworker" && !this.depth.fits(frames()) ? TOO_DEEP_VERDICT : null;
  }

  /**
   * A request body schema compiles as the registry compiles it, checked once
   * per source schema object. An optional body is measured as in the tool
   * input, where a call may leave it out.
   */
  private assertBodyCompiles(schema: unknown, converted: McpFnJsonSchema | boolean, refs: ReadonlySet<string>, required: boolean): void {
    const verdicts = this.bodyVerdicts[required ? 1 : 0];
    let verdict = isObject(schema) ? verdicts.get(schema) : undefined;
    if (verdict === undefined) {
      verdict = this.compileVerdict(converted, this.schemas.definitions(refs, "input"), "input", required, true);
      if (isObject(schema)) verdicts.set(schema, verdict);
    }
    throwIfInvalid(verdict, "request body");
  }

  private parameters(path: string, pathItem: JsonObject, raw: JsonObject): ResolvedParameter[] {
    const resolved: ResolvedParameter[] = [];
    const schemes = Object.values(this.securitySchemes(raw) ?? {});
    for (const parameter of this.mergedParameters(pathItem, raw)) {
      const converted = this.parameter(parameter, schemes);
      if (converted) resolved.push(converted);
    }
    const templateNames = templateVariables(path);
    const declared = new Set(resolved.filter(({ parameter }) => parameter.in === "path").map(({ parameter }) => parameter.name));
    const missing = templateNames.find((name) => !declared.has(name));
    if (missing !== undefined) {
      throw new OpenApiSkip("missing-path-parameter", `path template variable {${missing}} has no path parameter`);
    }
    const extra = [...declared].find((name) => !templateNames.includes(name));
    if (extra !== undefined) {
      throw new OpenApiSkip("invalid-operation", `path parameter ${extra} is not in the path template`);
    }
    return resolved;
  }

  /** Path-level then operation-level parameters; an operation-level one overrides by name and location. */
  private mergedParameters(pathItem: JsonObject, raw: JsonObject): Iterable<JsonObject> {
    const merged = new Map<string, JsonObject>();
    for (const list of [pathItem.parameters, raw.parameters]) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        throw new OpenApiSkip("invalid-operation", "parameters is not an array");
      }
      for (const entry of documentItems(list, "invalid-operation")) {
        const parameter = this.resolve(entry, "parameters");
        if (typeof parameter.name !== "string" || typeof parameter.in !== "string") {
          throw new OpenApiSkip("invalid-operation", "a parameter has no name or in");
        }
        const key = `${parameter.in}:${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`;
        merged.set(key, parameter);
      }
    }
    return merged.values();
  }

  private parameter(raw: JsonObject, schemes: readonly OpenApiSecurityScheme[]): ResolvedParameter | undefined {
    const name = raw.name as string;
    const location = raw.in as string;
    // D9: a credential of the operation's own apiKey schemes is the executor's, never an input.
    if (schemes.some((scheme) => isCredentialParameter(scheme, name, location))) return undefined;
    if (location === "cookie") {
      throw new OpenApiSkip("cookie-parameter", `parameter ${name} is sent in a cookie`);
    }
    if (location !== "path" && location !== "query" && location !== "header") {
      throw new OpenApiSkip("invalid-operation", `parameter ${name} has unknown location ${JSON.stringify(location)}`);
    }
    if (location === "header" && isForbiddenHeader(name)) return undefined;
    if (location !== "path" && this.ownsParameter?.({ name, in: location, required: raw.required === true }) === true) {
      return undefined;
    }
    // A name every object inherits is never a group property: Ajv reads it
    // through the prototype and @cfworker/json-schema reads own properties only.
    if (isPrototypeName(name)) {
      throw new OpenApiSkip(
        "unsupported-parameter-name",
        `${location} parameter ${name} cannot be declared: the validators do not read the names every object inherits alike`,
      );
    }
    if (raw.schema === undefined) {
      throw new OpenApiSkip(
        "parameter-content",
        `parameter ${name} uses content instead of schema`,
      );
    }
    const defaultStyle = location === "query" ? "form" : "simple";
    const style = raw.style ?? defaultStyle;
    if (style !== defaultStyle) {
      throw new OpenApiSkip(
        "unsupported-parameter-style",
        `parameter ${name} uses style ${JSON.stringify(style)}`,
      );
    }
    const explode = typeof raw.explode === "boolean" ? raw.explode : style === "form";
    // Conversion runs first so its skip reasons (unsupported keywords,
    // unresolved or cyclic references) take precedence over the shape check.
    const refs = new Set<string>();
    const converted = this.schemas.convertRoot(raw.schema, "input", refs);
    this.schemas.checkDefinitions(refs, "input");
    this.assertProjectable(raw.schema, "input", `parameter ${name}`);
    const shape = this.parameterShape(name, location, raw.schema);
    if (location === "query" && shape === "array" && !explode) {
      throw new OpenApiSkip(
        "unsupported-parameter-style",
        `query parameter ${name} uses form style with explode: false`,
      );
    }
    return {
      parameter: {
        name,
        in: location,
        required: location === "path" ? true : raw.required === true,
        style: style as "simple" | "form",
        explode,
        ...(location === "query" && raw.allowReserved === true ? { allowReserved: true as const } : {}),
        shape,
      },
      schema: converted,
      refs,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    };
  }

  /**
   * The executor serialises a parameter as one primitive or as an array of
   * primitives, so the schema must accept exactly one of those shapes. Kinds
   * are derived through `$ref`, `allOf`, `anyOf` and `oneOf`; a schema without
   * a type (such as `{}`) can be an object and is skipped. `null` may accompany
   * either shape when the schema allows it.
   */
  private parameterShape(
    name: string,
    location: OpenApiParameterLocation,
    schema: unknown,
  ): "primitive" | "array" {
    const { values, items } = this.schemas.admits(schema);
    const unsupported = (detail: string) =>
      new OpenApiSkip("unsupported-parameter-schema", `${location} parameter ${name} ${detail}`);
    if (values.has("object")) throw unsupported("can be an object");
    if (!values.has("array")) return "primitive";
    if (PRIMITIVE_KINDS.some((kind) => values.has(kind))) {
      throw unsupported("can be both an array and a single value");
    }
    if (items.has("object") || items.has("array")) {
      throw unsupported("is an array whose items can be objects or arrays");
    }
    return "array";
  }

  /**
   * The JSON media entries of a declared request body, in the order they are
   * tried: object-valued `application/json` entries, then `*+json` ones
   * (none without a request body). A declared body without such an entry is
   * skipped, whether or not it is required, since the tool could never send it.
   * Parameters and the request body are resolved per occurrence: a parsed
   * document may share one operation object between path items, and the
   * path-level parameters and template differ.
   */
  private requestBodies(raw: JsonObject): ResolvedBody[] {
    if (raw.requestBody === undefined) return [];
    const body = this.resolve(raw.requestBody, "requestBodies");
    if (!isObject(body.content) || Object.keys(body.content).length === 0) {
      throw new OpenApiSkip("invalid-request-body", "request body declares no content");
    }
    const content = body.content;
    const keys = Object.keys(content);
    const candidates = [
      ...keys.filter(isApplicationJson),
      ...keys.filter((key) => isJsonMediaType(key) && !isApplicationJson(key)),
    ].filter((key) => isObject(content[key]));
    if (candidates.length === 0) {
      if (keys.some(isJsonMediaType)) {
        throw new OpenApiSkip(
          "invalid-request-body",
          `request body has no JSON media type object (${keys.join(", ")})`,
        );
      }
      throw new OpenApiSkip("non-json-body", `request body has no JSON media type (${keys.join(", ")})`);
    }
    return candidates.map((contentType) => ({
      info: { required: body.required === true, contentType },
      schema: (content[contentType] as JsonObject).schema,
    }));
  }
}

interface ResolvedParameter {
  parameter: OpenApiOperationParameter;
  /** The converted (draft-07) schema and the component schemas it references. */
  schema: McpFnJsonSchema | boolean;
  refs: ReadonlySet<string>;
  description?: string;
}

interface ResolvedBody {
  info: OpenApiOperationRequestBody;
  schema: unknown;
}

interface OperationInputs {
  parameters: ResolvedParameter[];
  body: ResolvedBody | undefined;
}

const PRIMITIVE_KINDS = ["string", "number", "integer", "boolean"] as const;

/**
 * Deep copy in which no object is reachable by two paths (structuredClone
 * keeps sharing). Every copied node is charged to `budget`, so a document
 * that shares one object many times cannot expand without bound. `values`
 * records whether every copied value is one JSON represents exactly.
 */
function treeCopy<T>(value: T, budget: NodeBudget, values: CopiedValues = { json: true, chars: 0 }, ancestors = new Set<object>()): T {
  budget.charge(value);
  if (typeof value !== "object" || value === null) {
    if (!isJsonPrimitive(value)) values.json = false;
    if (typeof value === "string") values.chars += value.length;
    return value;
  }
  // YAML parsers can produce Date values (for example a timestamp `default`).
  if (value instanceof Date) return value.toISOString() as T;
  if (ancestors.has(value) || budget.isCircular(value)) {
    throw new OpenApiSkip("circular-object", "a schema value contains itself");
  }
  ancestors.add(value);
  try {
    return copyMembers(value, budget, values, ancestors) as T;
  } catch (error) {
    // The value met again is on the stack at or above this one, so the cycle is reachable from it.
    if (error instanceof OpenApiSkip && error.code === "circular-object") budget.markCircular(value);
    throw error;
  } finally {
    ancestors.delete(value);
  }
}

function copyMembers(value: object, budget: NodeBudget, values: CopiedValues, ancestors: Set<object>): unknown {
  let copy: unknown;
  if (Array.isArray(value)) {
    // Grown member by member, so the budget stops the copy before it is as long as the source.
    const items: unknown[] = [];
    for (const item of documentItems(value)) items.push(treeCopy(item, budget, values, ancestors));
    copy = items;
  } else {
    // Member by member through the call's key lists, so a failing member ends the work.
    const entries: Array<[string, unknown]> = [];
    for (const key of budget.ownKeys(value)) {
      values.chars += key.length;
      entries.push([key, treeCopy((value as Record<string, unknown>)[key], budget, values, ancestors)]);
    }
    copy = Object.fromEntries(entries);
  }
  return copy;
}

/** Run `task` unless it already failed for `key` for a reason of the key's own, remembering such a failure. */
function remembered(failures: WeakMap<object, OpenApiSkip>, key: object, task: () => void): void {
  const known = failures.get(key);
  if (known) throw known;
  try {
    task();
  } catch (error) {
    if (error instanceof OpenApiSkip && CONTEXT_FREE_FAILURES.has(error.code)) failures.set(key, error);
    throw error;
  }
}


/** Why building a tool from one alternative failed, as a skip; anything else is rethrown. */
function candidateFailure(error: unknown): OpenApiSkip {
  if (error instanceof OpenApiSkip) return error;
  if (error instanceof RangeError) return new OpenApiSkip("schema-too-large", TOO_DEEP);
  throw error;
}

/**
 * How many frames @cfworker/json-schema stacks validating one value before
 * its stack overflows, measured with the engine on this call's stack rather
 * than fixed: chains of references of a given length are validated, and
 * what passed and what overflowed is kept for the call, so tools with equal
 * depths get one verdict however warm the engine is. Until a chain
 * overflows, each probe at least doubles the longest that passed, so rising
 * depths cost few probes; after that the limit is bisected. Each probe is
 * charged to the call's budget.
 */
class ValidationDepth {
  private passes = 1;
  private overflows = Number.POSITIVE_INFINITY;

  constructor(private readonly charge: (nodes: number) => void) {}

  fits(frames: number): boolean {
    if (frames <= this.passes) return true;
    if (frames >= this.overflows) return false;
    if (this.overflows === Number.POSITIVE_INFINITY) this.probe(Math.max(frames, 2 * this.passes));
    while (frames > this.passes && frames < this.overflows) {
      this.probe(Math.floor((this.passes + this.overflows) / 2));
    }
    return frames <= this.passes;
  }

  private probe(frames: number): void {
    this.charge(frames);
    if (chainValidates(frames)) {
      this.passes = Math.max(this.passes, frames);
      if (this.overflows <= this.passes) this.overflows = this.passes + 1;
    } else {
      this.overflows = Math.min(this.overflows, frames);
      if (this.passes >= this.overflows) this.passes = this.overflows - 1;
    }
  }
}

/** Whether @cfworker/json-schema validates a value through `frames` frames: a root and a chain of references after it. */
function chainValidates(frames: number): boolean {
  const definitions: Record<string, object> = {};
  for (let index = 1; index < frames; index += 1) {
    definitions[`d${index}`] = index + 1 < frames ? { $ref: `#/definitions/d${index + 1}` } : {};
  }
  try {
    createSchemaCompiler("cfworker").compile(frames > 1 ? { $ref: "#/definitions/d1", definitions } : {})(null);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

/** The catalog copies one converted operation reserved, and whether they were given back. */
interface Holder {
  schemas: object[];
  dropped: boolean;
}

/** A compile verdict for a stack overflow, kept like any other verdict. */
const TOO_DEEP_VERDICT = "\0too deep";

function throwIfInvalid(failure: string | null, subject: string): void {
  if (failure !== null) throw invalidSkip(failure, subject);
}

/** The skip for a schema that failed to compile (`compileFailure`). */
function invalidSkip(failure: string, subject: string): OpenApiSkip {
  if (failure === TOO_DEEP_VERDICT) return new OpenApiSkip("schema-too-large", TOO_DEEP);
  return new OpenApiSkip("invalid-schema", `the ${subject} schema is not a valid JSON Schema: ${failure}`);
}

interface CopiedValues {
  json: boolean;
  /** The length of the copied strings and object keys, which a content key serialises. */
  chars: number;
}

/**
 * Content keys hold at most this many characters of strings, object keys and
 * definition names (at most six times as many once escaped); a schema with
 * more gets none, and is checked again for each source object.
 */
const MAX_KEY_CHARS = 4096;

/** A value JSON round-trips exactly (not -0, which it writes as 0). */
function isJsonPrimitive(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    value === null ||
    (Number.isFinite(value) && !Object.is(value, -0))
  );
}

/**
 * A key for a produced schema copy, its kind and its definition names. A copy
 * holding a value JSON does not represent exactly (such as `undefined` or a
 * non-finite number), or more string content than a key may hold, gets none
 * and is never shared.
 */
function contentKey(kind: string, copy: unknown, values: CopiedValues, definitions: object): string | undefined {
  const names = Object.keys(definitions);
  const chars = names.reduce((total, name) => total + name.length, values.chars);
  return values.json && chars <= MAX_KEY_CHARS ? JSON.stringify([kind, names, copy]) : undefined;
}

function documentVersion(document: JsonObject): OpenApiVersion {
  if (Object.hasOwn(document, "swagger")) {
    throw new McpFnValidationError(
      "Swagger 2.0 documents are not supported; convert the document to OpenAPI 3.0 or 3.1",
    );
  }
  const version = document.openapi;
  if (typeof version === "string") {
    if (/^3\.0\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return "3.0";
    if (/^3\.1\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return "3.1";
  }
  throw new McpFnValidationError(
    `Unsupported OpenAPI version ${JSON.stringify(version)}; expected 3.0.x or 3.1.x`,
  );
}

function validateOptions<TContext>(options: FromOpenApiOptions<TContext>): void {
  if (!isObject(options)) {
    throw new McpFnValidationError("fromOpenAPI options must be an object");
  }
  if (!options.executor || typeof options.executor.execute !== "function") {
    throw new McpFnValidationError("fromOpenAPI requires an executor with an execute function");
  }
  if (options.executor.unsupported !== undefined && typeof options.executor.unsupported !== "function") {
    throw new McpFnValidationError("fromOpenAPI executor.unsupported must be a function");
  }
  if (options.executor.ownsParameter !== undefined && typeof options.executor.ownsParameter !== "function") {
    throw new McpFnValidationError("fromOpenAPI executor.ownsParameter must be a function");
  }
  if (options.name !== undefined && typeof options.name !== "function") {
    throw new McpFnValidationError("fromOpenAPI name must be a function");
  }
  if (options.prefix !== undefined && typeof options.prefix !== "string") {
    throw new McpFnValidationError("fromOpenAPI prefix must be a string");
  }
}

/**
 * Convert the operations of an OpenAPI 3.0/3.1 document into MCP tools on an
 * `McpFnRegistry`. Operations outside the supported set, or filtered out, are
 * listed in `skipped` with a reason. Tool calls are delegated to the executor.
 *
 * The first signature takes an `OpenApiDocument` (a literal with `x-*`
 * extensions, also when the context type is given explicitly); the second
 * takes any type with the standard fields, such as a producer interface that
 * declares no index signature.
 */
export function fromOpenAPI<TContext = undefined>(
  document: OpenApiDocument,
  options: FromOpenApiOptions<TContext>,
): FromOpenApiResult<TContext>;
export function fromOpenAPI<TContext = undefined, TDocument extends OpenApiDocumentFields = OpenApiDocumentFields>(
  document: TDocument,
  options: FromOpenApiOptions<TContext>,
): FromOpenApiResult<TContext>;
export function fromOpenAPI<TContext>(
  document: OpenApiDocumentFields,
  options: FromOpenApiOptions<TContext>,
): FromOpenApiResult<TContext> {
  if (!isObject(document)) {
    throw new McpFnValidationError("fromOpenAPI expects a parsed OpenAPI document object");
  }
  const version = documentVersion(document as JsonObject);
  validateOptions(options);
  const filters: Filters<TContext> = {
    include: compileSelectors("include", options.include),
    exclude: compileSelectors("exclude", options.exclude),
    options,
  };
  const source = privateCopy(document);
  const converter = new OperationConverter(
    source,
    version,
    options.registry === undefined,
    options.executor.outputSchemaRule === "every-success",
    options.executor.ownsParameter ? (parameter) => options.executor.ownsParameter!(parameter) : undefined,
  );
  const skipped: OpenApiSkippedOperation[] = [];
  const candidates: Candidate[] = [];
  for (const [path, pathItem] of Object.entries(isObject(source.paths) ? source.paths : {})) {
    // Paths Object extensions carry arbitrary values and are not path items.
    if (path.startsWith("x-")) continue;
    const unusable = pathItemSkip(path, pathItem);
    if (unusable) skipped.push(unusable);
    else convertPathItem(converter, filters, path, pathItem as JsonObject, skipped, candidates);
  }
  return register(converter, candidates, skipped, options);
}

function convertPathItem<TContext>(
  converter: OperationConverter,
  filters: Filters<TContext>,
  path: string,
  pathItem: JsonObject,
  skipped: OpenApiSkippedOperation[],
  candidates: Candidate[],
): void {
  for (const [key, value] of Object.entries(pathItem)) {
    const method = METHODS.get(key);
    if (!method) continue;
    const outcome = convertOperation(converter, filters, path, pathItem, method, value);
    if ("skip" in outcome) skipped.push(outcome.skip);
    else candidates.push(outcome.candidate);
  }
}

interface Filters<TContext> {
  include: SelectorSet | undefined;
  exclude: SelectorSet | undefined;
  options: FromOpenApiOptions<TContext>;
}

function privateCopy(document: object): JsonObject {
  try {
    // Work on a private copy: later changes to the caller's object cannot
    // alter registered schemas or the operations given to the executor.
    return structuredClone(document) as JsonObject;
  } catch (error) {
    throw new McpFnValidationError("fromOpenAPI expects a plain JSON document", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function pathItemSkip(path: string, pathItem: unknown): OpenApiSkippedOperation | undefined {
  if (!isObject(pathItem)) {
    return { operation: { path }, code: "invalid-operation", reason: "path item is not an object" };
  }
  if (!("$ref" in pathItem)) return undefined;
  const ref = pathItem.$ref;
  const external = typeof ref === "string" && !ref.startsWith("#");
  return {
    operation: { path },
    code: external ? "external-ref" : "unsupported-ref",
    reason: `path item reference ${JSON.stringify(ref)} is not supported`,
  };
}

function convertOperation<TContext>(
  converter: OperationConverter,
  { include, exclude, options }: Filters<TContext>,
  path: string,
  pathItem: JsonObject,
  method: OpenApiMethod,
  value: unknown,
): { skip: OpenApiSkippedOperation } | { candidate: Candidate } {
  const operationId = isObject(value) && typeof value.operationId === "string" && value.operationId
    ? value.operationId
    : undefined;
  const ref: OpenApiOperationRef = { method, path, ...(operationId ? { operationId } : {}) };
  if (!isObject(value)) {
    return { skip: { operation: ref, code: "invalid-operation", reason: "operation is not an object" } };
  }
  try {
    // Filtering needs only identity fields, so it runs before conversion.
    const identity: OperationIdentity = { method, path, operationId, tags: tagsOf(value) };
    const filtered = filterReason(identity, value.deprecated === true, include, exclude, options);
    if (filtered) return { skip: { operation: ref, ...filtered } };
    return { candidate: converter.candidate(path, pathItem, method, value) };
  } catch (error) {
    const skip = candidateFailure(error);
    return { skip: { operation: ref, code: skip.code, reason: skip.message } };
  }
}

function tagsOf(raw: JsonObject): string[] {
  return Array.isArray(raw.tags)
    ? documentItems(raw.tags, "invalid-operation").filter((tag): tag is string => typeof tag === "string")
    : [];
}

function register<TContext>(
  converter: OperationConverter,
  candidates: Candidate[],
  skipped: OpenApiSkippedOperation[],
  options: FromOpenApiOptions<TContext>,
): FromOpenApiResult<TContext> {
  const registry = options.registry ?? new McpFnRegistry<TContext>();
  const executor = options.executor;
  // Operations the executor cannot send are skipped before any name is chosen or checked.
  candidates = candidates.filter(({ operation }) => {
    const unsupported = executor.unsupported?.(operation);
    if (typeof unsupported !== "string") return true;
    converter.dropOperation(operation);
    skipped.push({ operation: operationRef(operation), code: "unsupported-by-executor", reason: unsupported });
    return false;
  });
  const names = new ToolNames(options, registry);
  // name() results are checked before anything is registered.
  const chosen = options.name ? candidates.map(({ operation }) => names.choose(operation)) : undefined;
  const tools: OpenApiToolInfo[] = [];
  // Shared schemas (see OperationConverter.toolSchema) leave the registry's
  // Ajv as fresh copies would: it resolves later schemas against the
  // anonymous schema it compiled last, which a cached object does not
  // replace, so the last registration (and any after a failed one, whose
  // object Ajv half-registered) gets fresh copies.
  const failed = new WeakSet<object>();
  const fresh = <T extends object | undefined>(schema: T, last: boolean): T =>
    schema !== undefined && Object.isFrozen(schema) && (last || failed.has(schema)) ? deepFreeze(structuredClone(schema)) : schema;
  // Input and output schemas a validator overflowed its stack on: tools with
  // the same schemas (shared by content) get the same verdict, however warm the engine is.
  const overflowed = new WeakMap<object, WeakSet<object>>();
  let engine: string | undefined;
  candidates.forEach((candidate, index) => {
    const { operation } = candidate;
    const pair: [object, object] = [candidate.inputSchema, candidate.outputSchema ?? NO_OUTPUT];
    const refusal = converter.refusal(pair);
    if (overflowed.get(pair[0])?.has(pair[1]) || refusal) {
      converter.dropOperation(operation);
      skipped.push(refusal ? { operation: operationRef(operation), code: refusal.code, reason: refusal.message } : tooDeepSkip(operation));
      return;
    }
    engine ??= createSchemaCompiler().engine;
    // The catalog entry's copy is held before the tool registers, and given
    // back when it does not, so only copies made stay charged.
    let catalogNodes = 0;
    try {
      if (engine === "cfworker" && !converter.validatesDeepEnough(pair)) {
        converter.dropOperation(operation);
        if (!overflowed.has(pair[0])) overflowed.set(pair[0], new WeakSet());
        overflowed.get(pair[0])!.add(pair[1]);
        skipped.push(tooDeepSkip(operation));
        return;
      }
      catalogNodes = converter.holdCatalog(pair);
    } catch (error) {
      // Measuring or holding ran out of budget: the tool's reservations go back.
      converter.dropOperation(operation);
      const skip = candidateFailure(error);
      skipped.push({ operation: operationRef(operation), code: skip.code, reason: skip.message });
      return;
    }
    const last = index === candidates.length - 1;
    const inputSchema = fresh(candidate.inputSchema, last);
    const outputSchema = fresh(candidate.outputSchema, last);
    const name = chosen ? chosen[index]! : names.next(operation);
    const description = toolDescription(operation);
    const annotations = toolAnnotations(operation.method);
    // Lets an executor tell a success the schema does not describe from one it does, compiled at the first call.
    let compiled: ((value: unknown) => boolean) | undefined;
    const checkOutput = outputSchema
      ? (value: Record<string, unknown>) => {
          try {
            compiled ??= createSchemaCompiler(engine as SchemaEngine).compile(outputSchema);
          } catch {
            // A schema this engine cannot compile is left to the registry's verdict.
            return true;
          }
          try {
            return compiled(value) === true;
          } catch {
            // Such as a value nested too deeply to validate.
            return false;
          }
        }
      : undefined;
    try {
      registry.register({
        name,
        description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        annotations,
        handler: (args, context, extra) =>
          executor.execute({
            operation,
            args,
            context,
            signal: extra.signal,
            hasOutputSchema: outputSchema !== undefined,
            ...(checkOutput ? { checkOutput } : {}),
          }),
      });
    } catch (error) {
      converter.releaseCopy(catalogNodes);
      if (!isValidationError(error)) throw error;
      failed.add(inputSchema);
      if (outputSchema) failed.add(outputSchema);
      if (isStackOverflow(error)) {
        if (!overflowed.has(pair[0])) overflowed.set(pair[0], new WeakSet());
        overflowed.get(pair[0])!.add(pair[1]);
        skipped.push(tooDeepSkip(operation));
      } else {
        skipped.push(registrationSkip(operation, error));
      }
      return;
    }
    names.claim(name);
    // The catalog gets its own copies: changing them cannot make the listed
    // schemas disagree with the ones the registry compiled.
    tools.push({
      name,
      description,
      operation,
      inputSchema: structuredClone(inputSchema),
      ...(outputSchema ? { outputSchema: structuredClone(outputSchema) } : {}),
      annotations: { ...annotations },
    });
  });
  return { registry, tools, skipped };
}

const NO_OUTPUT = Object.freeze({});

/** The same schema object, or one written identically (as in two responses with the same inline schema). */
function sameSchema(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function operationRef(operation: OpenApiOperation): OpenApiOperationRef {
  return {
    method: operation.method,
    path: operation.path,
    ...(operation.operationId ? { operationId: operation.operationId } : {}),
  };
}

/** A validator that overflowed its stack compiling a tool schema: a stack overflow, as any other, means the schema nests too deeply. */
function tooDeepSkip(operation: OpenApiOperation): OpenApiSkippedOperation {
  return { operation: operationRef(operation), code: "schema-too-large", reason: TOO_DEEP };
}

/** The registry reports a validator's RangeError by its message, the one V8 gives a stack overflow. */
function isStackOverflow(error: McpFnValidationError): boolean {
  const cause = (error.details as { cause?: unknown } | undefined)?.cause;
  return typeof cause === "string" && cause.startsWith("Maximum call stack size exceeded");
}

function registrationSkip(operation: OpenApiOperation, error: McpFnValidationError): OpenApiSkippedOperation {
  const cause = (error.details as { cause?: unknown } | undefined)?.cause;
  return {
    operation: operationRef(operation),
    code: "invalid-schema",
    reason: typeof cause === "string" ? `${error.message}: ${cause}` : error.message,
  };
}

/**
 * A registry from the other module format (ESM and CommonJS entries each
 * bundle their own class) throws an McpFnValidationError that fails instanceof.
 */
function isValidationError(error: unknown): error is McpFnValidationError {
  return (
    error instanceof McpFnValidationError ||
    (error instanceof Error && error.name === "McpFnValidationError")
  );
}

function filterReason<TContext>(
  operation: OperationIdentity,
  deprecated: boolean,
  include: SelectorSet | undefined,
  exclude: SelectorSet | undefined,
  options: FromOpenApiOptions<TContext>,
): Pick<OpenApiSkippedOperation, "code" | "reason"> | undefined {
  if (exclude && matches(exclude, operation)) {
    return { code: "excluded", reason: "matched an exclude selector" };
  }
  if (include && !matches(include, operation)) {
    return { code: "not-included", reason: "matched no include selector" };
  }
  if (deprecated && options.includeDeprecated !== true) {
    return { code: "deprecated", reason: "operation is deprecated; set includeDeprecated to expose it" };
  }
  if (
    !SAFE_METHODS.has(operation.method) &&
    options.allowMutations !== true &&
    !(operation.operationId !== undefined && include?.operationIds.has(operation.operationId))
  ) {
    return {
      code: "mutation-not-allowed",
      reason: `${operation.method} is not exposed by default; list the operationId in include or set allowMutations`,
    };
  }
  return undefined;
}

/**
 * Tool names in document order. A name is claimed only once its tool is
 * registered, so an operation skipped at registration does not push the next
 * one with the same name to `_2`. A taken name stays taken, so suffix search
 * resumes at the first name not yet seen taken for that emitted stem (distinct
 * long bases can truncate to the same stem) and suffix width, keeping many
 * collisions linear.
 */
class ToolNames<TContext> {
  private readonly used = new Set<string>();
  /** The first suffix not yet seen taken, by suffix width and emitted stem. */
  private readonly nextSuffix = new Map<string, number>();
  private readonly suffixOf = new Map<string, [string, number]>();

  constructor(
    private readonly options: FromOpenApiOptions<TContext>,
    private readonly registry: McpFnRegistry<TContext>,
  ) {}

  private taken(name: string): boolean {
    return this.used.has(name) || this.registry.has(name);
  }

  /** The name() callback result; invalid or duplicate names are errors. */
  choose(operation: OpenApiOperation): string {
    const chosen: unknown = this.options.name!(operation);
    if (typeof chosen !== "string" || !TOOL_NAME.test(chosen)) {
      throw new McpFnValidationError(
        `name() returned an invalid tool name ${JSON.stringify(chosen)} for ${describeOperation(operation)}`,
      );
    }
    if (this.taken(chosen)) {
      throw new McpFnValidationError(
        `name() returned the duplicate tool name ${JSON.stringify(chosen)} for ${describeOperation(operation)}`,
      );
    }
    this.used.add(chosen);
    return chosen;
  }

  /** The generated name, with `_2`, `_3`, … after a collision. */
  next(operation: OpenApiOperation): string {
    const base = defaultName(operation, this.options.prefix ?? "");
    this.suffixOf.clear();
    if (!this.taken(base)) return base;
    // Suffixes with the same number of digits share the emitted stem.
    for (let digits = 1; ; digits += 1) {
      const stem = base.slice(0, MAX_NAME_LENGTH - digits - 1);
      const key = `${digits}:${stem}`;
      const end = 10 ** digits;
      let attempt = this.nextSuffix.get(key) ?? (digits === 1 ? 2 : end / 10);
      while (attempt < end && this.taken(`${stem}_${attempt}`)) attempt += 1;
      this.nextSuffix.set(key, attempt);
      if (attempt < end) {
        const name = `${stem}_${attempt}`;
        this.suffixOf.set(name, [key, attempt]);
        return name;
      }
    }
  }

  claim(name: string): void {
    this.used.add(name);
    const suffix = this.suffixOf.get(name);
    if (suffix) this.nextSuffix.set(suffix[0], suffix[1] + 1);
    this.suffixOf.clear();
  }
}
