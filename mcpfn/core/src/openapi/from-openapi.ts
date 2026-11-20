import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
// Runtime imports go through the package name so the `@mcpfn/core/openapi`
// bundle shares the root entry's classes (instanceof, private fields) instead
// of carrying a second copy. Tests and typecheck map the name to src/index.ts.
import {
  McpFnRegistry,
  McpFnValidationError,
  type McpFnJsonSchema,
  type McpFnObjectSchema,
} from "@mcpfn/core";
import {
  isObject,
  OpenApiSkip,
  parseComponentRef,
  SchemaConverter,
  type OpenApiVersion,
} from "./schema.js";
import type {
  FromOpenApiOptions,
  FromOpenApiResult,
  OpenApiDocument,
  OpenApiMethod,
  OpenApiOperation,
  OpenApiOperationParameter,
  OpenApiOperationRef,
  OpenApiOperationRequestBody,
  OpenApiParameterLocation,
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

// D9: credentials and transport headers are the executor's job, never inputs.
// OpenAPI itself says Accept, Content-Type and Authorization header parameters
// SHALL be ignored.
const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "accept",
  "content-type",
]);

function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return FORBIDDEN_HEADERS.has(lower) || lower.startsWith("proxy-");
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
  for (const selector of selectors) {
    if (typeof selector !== "string" || selector.trim() === "") {
      throw new McpFnValidationError(
        `fromOpenAPI ${option} selector ${JSON.stringify(selector)} must be a non-empty string`,
      );
    }
    const route = /^([A-Za-z]+)\s+(\/\S*)$/.exec(selector);
    if (selector.startsWith("tag:")) {
      const tag = selector.slice(4);
      if (!tag) {
        throw new McpFnValidationError(`fromOpenAPI ${option} selector "tag:" needs a tag name`);
      }
      set.tags.add(tag);
    } else if (route && METHODS.has(route[1]!.toLowerCase())) {
      set.routes.add(`${route[1]!.toUpperCase()} ${route[2]}`);
    } else {
      set.operationIds.add(selector);
    }
  }
  return set;
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
    const usable = level
      .filter((server): server is JsonObject => isObject(server) && typeof server.url === "string")
      .map((server) => ({
        url: server.url as string,
        ...(typeof server.description === "string" ? { description: server.description } : {}),
        ...(isObject(server.variables)
          ? { variables: server.variables as OpenApiServer["variables"] }
          : {}),
      }));
    if (usable.length > 0) return usable;
  }
  return [{ url: "/" }];
}

function security(...levels: unknown[]): OpenApiOperation["security"] {
  for (const level of levels) {
    if (Array.isArray(level)) {
      return level.filter(isObject) as Record<string, string[]>[];
    }
  }
  return undefined;
}

function isJsonMediaType(key: string): boolean {
  const type = key.split(";")[0]!.trim().toLowerCase();
  return type === "application/json" || /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/.test(type);
}

function isApplicationJson(key: string): boolean {
  return key.split(";")[0]!.trim().toLowerCase() === "application/json";
}

interface Candidate {
  operation: OpenApiOperation;
  inputSchema: McpFnObjectSchema;
  outputSchema?: McpFnObjectSchema;
}

class OperationConverter {
  private readonly components: JsonObject;
  readonly schemas: SchemaConverter;

  constructor(
    private readonly document: JsonObject,
    version: OpenApiVersion,
  ) {
    this.components = isObject(document.components) ? document.components : {};
    this.schemas = new SchemaConverter(
      version,
      isObject(this.components.schemas) ? this.components.schemas : {},
    );
  }

  /** Follow a `$ref` chain to a parameter, request body or response object. */
  resolve(value: unknown, kind: "parameters" | "requestBodies" | "responses"): JsonObject {
    let current = value;
    const seen = new Set<string>();
    while (isObject(current) && "$ref" in current) {
      const name = parseComponentRef(current.$ref, kind);
      if (seen.has(name)) {
        throw new OpenApiSkip("unresolved-ref", `reference cycle through #/components/${kind}/${name}`);
      }
      seen.add(name);
      const section = this.components[kind];
      if (!isObject(section) || !Object.hasOwn(section, name)) {
        throw new OpenApiSkip("unresolved-ref", `reference #/components/${kind}/${name} has no target`);
      }
      current = section[name];
    }
    if (!isObject(current)) {
      throw new OpenApiSkip("invalid-operation", `a ${kind} entry is not an object`);
    }
    return current;
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
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
      deprecated: raw.deprecated === true,
      parameters: parameters.map(({ parameter }) => parameter),
      ...(body ? { requestBody: body.info } : {}),
      servers: servers(raw.servers, pathItem.servers, this.document.servers),
      ...(security(raw.security, this.document.security) !== undefined
        ? { security: security(raw.security, this.document.security) }
        : {}),
    };
  }

  /** Parameters and the request body as one tool input schema (D11). */
  inputSchema({ parameters, body }: OperationInputs): McpFnObjectSchema {
    const refs = new Set<string>();
    const groups: Array<[string, McpFnJsonSchema | boolean]> = [];
    const required: string[] = [];
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
    if (body) {
      groups.push(["body", this.schemas.convert(body.schema, "input", refs)]);
      if (body.info.required) required.push("body");
    }
    const definitions = this.schemas.definitions(refs, "input");
    return {
      type: "object",
      properties: Object.fromEntries(groups) as Record<string, McpFnJsonSchema>,
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
      ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
    };
  }

  /**
   * The first 2xx response with `application/json` content. Its schema is
   * always converted, so the skip rules apply whatever its shape; it becomes
   * the output schema only when it accepts objects and nothing else.
   */
  outputSchema(raw: JsonObject): McpFnObjectSchema | undefined {
    if (!isObject(raw.responses)) return undefined;
    let media: unknown;
    // Key order: integer status codes ascend (JavaScript object order), then 2XX.
    for (const [status, value] of Object.entries(raw.responses)) {
      if (!/^2(?:\d\d|XX)$/i.test(status)) continue;
      const response = this.resolve(value, "responses");
      const content = isObject(response.content) ? response.content : {};
      const mediaType = Object.keys(content).find(isApplicationJson);
      if (mediaType === undefined) continue;
      media = content[mediaType];
      break;
    }
    if (!isObject(media) || media.schema === undefined) return undefined;
    const refs = new Set<string>();
    let root = this.schemas.convert(media.schema, "output", refs);
    const definitions = this.schemas.definitions(refs, "output");
    // structuredContent is always an object: a nullable or mixed schema
    // (3.0 `nullable`, `type: ["object", "null"]`, `oneOf` with a string) has none.
    const { values } = this.schemas.admits(media.schema);
    if (values.size !== 1 || !values.has("object")) return undefined;
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
    // The root may carry its object type only through a reference or a
    // composition (`{ $ref, description }` in 3.1, `allOf: [...]`); stating it
    // on the root narrows nothing, since only objects are accepted.
    return {
      ...root,
      type: "object",
      ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
    } as McpFnObjectSchema;
  }

  /**
   * Parameters and request body of one operation at one path. Resolved per
   * occurrence: a parsed document may share one operation object between
   * path items, and the path-level parameters and template differ.
   */
  inputs(path: string, pathItem: JsonObject, raw: JsonObject): OperationInputs {
    return { parameters: this.parameters(path, pathItem, raw), body: this.requestBody(raw) };
  }

  private parameters(path: string, pathItem: JsonObject, raw: JsonObject): ResolvedParameter[] {
    const merged = new Map<string, JsonObject>();
    for (const list of [pathItem.parameters, raw.parameters]) {
      if (list === undefined) continue;
      if (!Array.isArray(list)) {
        throw new OpenApiSkip("invalid-operation", "parameters is not an array");
      }
      for (const entry of list) {
        const parameter = this.resolve(entry, "parameters");
        if (typeof parameter.name !== "string" || typeof parameter.in !== "string") {
          throw new OpenApiSkip("invalid-operation", "a parameter has no name or in");
        }
        const key = `${parameter.in}:${parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name}`;
        merged.set(key, parameter);
      }
    }
    const resolved: ResolvedParameter[] = [];
    for (const parameter of merged.values()) {
      const converted = this.parameter(parameter);
      if (converted) resolved.push(converted);
    }
    const templateNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    const declared = new Set(resolved.filter(({ parameter }) => parameter.in === "path").map(({ parameter }) => parameter.name));
    for (const name of templateNames) {
      if (!declared.has(name)) {
        throw new OpenApiSkip("missing-path-parameter", `path template variable {${name}} has no path parameter`);
      }
    }
    for (const name of declared) {
      if (!templateNames.includes(name)) {
        throw new OpenApiSkip("invalid-operation", `path parameter ${name} is not in the path template`);
      }
    }
    return resolved;
  }

  private parameter(raw: JsonObject): ResolvedParameter | undefined {
    const name = raw.name as string;
    const location = raw.in as string;
    if (location === "cookie") {
      throw new OpenApiSkip("cookie-parameter", `parameter ${name} is sent in a cookie`);
    }
    if (location !== "path" && location !== "query" && location !== "header") {
      throw new OpenApiSkip("invalid-operation", `parameter ${name} has unknown location ${JSON.stringify(location)}`);
    }
    if (location === "header" && isForbiddenHeader(name)) return undefined;
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
    const converted = this.schemas.convert(raw.schema, "input", refs);
    this.schemas.definitions(refs, "input");
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
   * The JSON media entry of a declared request body: the first usable
   * (object-valued) `application/json` entry, otherwise the first usable
   * `*+json` one. A declared body without such an entry is skipped, whether
   * or not it is required, since the tool could never send it.
   */
  private requestBody(raw: JsonObject): ResolvedBody | undefined {
    if (raw.requestBody === undefined) return undefined;
    const body = this.resolve(raw.requestBody, "requestBodies");
    if (!isObject(body.content) || Object.keys(body.content).length === 0) {
      throw new OpenApiSkip("invalid-request-body", "request body declares no content");
    }
    const content = body.content;
    const keys = Object.keys(content);
    const usable = (key: string) => isObject(content[key]);
    const contentType = keys.find((key) => isApplicationJson(key) && usable(key)) ??
      keys.find((key) => isJsonMediaType(key) && usable(key));
    if (contentType === undefined) {
      if (keys.some(isJsonMediaType)) {
        throw new OpenApiSkip(
          "invalid-request-body",
          `request body has no JSON media type object (${keys.join(", ")})`,
        );
      }
      throw new OpenApiSkip("non-json-body", `request body has no JSON media type (${keys.join(", ")})`);
    }
    const media = content[contentType] as JsonObject;
    return {
      info: { required: body.required === true, contentType },
      // A media type object without `schema` accepts any JSON value.
      schema: media.schema !== undefined ? media.schema : {},
    };
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

/** Deep copy in which no object is reachable by two paths (structuredClone keeps sharing). */
function treeCopy<T>(value: T, ancestors = new Set<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  // YAML parsers can produce Date values (for example a timestamp `default`).
  if (value instanceof Date) return value.toISOString() as T;
  if (ancestors.has(value)) {
    throw new OpenApiSkip("circular-object", "a schema value contains itself");
  }
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? value.map((item) => treeCopy(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, treeCopy(item, ancestors)]));
  ancestors.delete(value);
  return copy as T;
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
 */
export function fromOpenAPI<TContext = undefined>(
  document: OpenApiDocument,
  options: FromOpenApiOptions<TContext>,
): FromOpenApiResult<TContext> {
  if (!isObject(document)) {
    throw new McpFnValidationError("fromOpenAPI expects a parsed OpenAPI document object");
  }
  const version = documentVersion(document as JsonObject);
  validateOptions(options);
  const include = compileSelectors("include", options.include);
  const exclude = compileSelectors("exclude", options.exclude);
  let source: JsonObject;
  try {
    // Work on a private copy: later changes to the caller's object cannot
    // alter registered schemas or the operations given to the executor.
    source = structuredClone(document) as JsonObject;
  } catch (error) {
    throw new McpFnValidationError("fromOpenAPI expects a plain JSON document", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const converter = new OperationConverter(source, version);
  const skipped: OpenApiSkippedOperation[] = [];
  const candidates: Candidate[] = [];
  const paths = isObject(source.paths) ? source.paths : {};

  for (const [path, pathItem] of Object.entries(paths)) {
    // Paths Object extensions carry arbitrary values and are not path items.
    if (path.startsWith("x-")) continue;
    if (!isObject(pathItem)) {
      skipped.push({ operation: { path }, code: "invalid-operation", reason: "path item is not an object" });
      continue;
    }
    if ("$ref" in pathItem) {
      const ref = pathItem.$ref;
      const external = typeof ref === "string" && !ref.startsWith("#");
      skipped.push({
        operation: { path },
        code: external ? "external-ref" : "unsupported-ref",
        reason: `path item reference ${JSON.stringify(ref)} is not supported`,
      });
      continue;
    }
    for (const [key, value] of Object.entries(pathItem)) {
      const method = METHODS.get(key);
      if (!method) continue;
      const ref: OpenApiOperationRef = {
        method,
        path,
        ...(isObject(value) && typeof value.operationId === "string" && value.operationId
          ? { operationId: value.operationId }
          : {}),
      };
      if (!isObject(value)) {
        skipped.push({ operation: ref, code: "invalid-operation", reason: "operation is not an object" });
        continue;
      }
      // Filtering needs only identity fields, so it runs before conversion.
      const identity: OperationIdentity = {
        method,
        path,
        operationId: ref.operationId,
        tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
      };
      const filtered = filterReason(identity, value.deprecated === true, include, exclude, options);
      if (filtered) {
        skipped.push({ operation: ref, ...filtered });
        continue;
      }
      try {
        const inputs = converter.inputs(path, pathItem, value);
        const operation = deepFreeze(converter.operation(path, pathItem, method, value, inputs));
        // The selected response is converted for every method so its skip
        // rules apply alike; a HEAD response has no body, so no structured output.
        const selectedOutput = converter.outputSchema(value);
        const outputSchema = method === "HEAD" ? undefined : selectedOutput;
        // Each tool owns its schema objects: component conversions are cached
        // and shared, and a schema must not reach one object by two paths.
        candidates.push({
          operation,
          inputSchema: treeCopy(converter.inputSchema(inputs)),
          ...(outputSchema ? { outputSchema: treeCopy(outputSchema) } : {}),
        });
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        skipped.push({ operation: ref, code: error.code, reason: error.message });
      }
    }
  }

  const registry = options.registry ?? new McpFnRegistry<TContext>();
  const names = new ToolNames(options, registry);
  // name() results are checked before anything is registered.
  const chosen = options.name ? candidates.map(({ operation }) => names.choose(operation)) : undefined;
  const tools: OpenApiToolInfo[] = [];
  const executor = options.executor;
  candidates.forEach((candidate, index) => {
    const { operation, inputSchema, outputSchema } = candidate;
    const name = chosen ? chosen[index]! : names.next(operation);
    const description = toolDescription(operation);
    const annotations = toolAnnotations(operation.method);
    try {
      registry.register({
        name,
        description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        annotations,
        handler: (args, _context, extra) => executor.execute({ operation, args, signal: extra.signal }),
      });
    } catch (error) {
      if (!isValidationError(error)) throw error;
      const ref: OpenApiOperationRef = {
        method: operation.method,
        path: operation.path,
        ...(operation.operationId ? { operationId: operation.operationId } : {}),
      };
      const cause = (error.details as { cause?: unknown } | undefined)?.cause;
      skipped.push({
        operation: ref,
        code: "invalid-schema",
        reason: `${error.message}${typeof cause === "string" ? `: ${cause}` : ""}`,
      });
      return;
    }
    names.claim(name);
    tools.push({
      name,
      description,
      operation,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      annotations,
    });
  });
  return { registry, tools, skipped };
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
 * one with the same name to `_2`. Suffix search resumes where the last one for
 * that base stopped, keeping many collisions linear.
 */
class ToolNames<TContext> {
  private readonly used = new Set<string>();
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
    let attempt = this.nextSuffix.get(base) ?? 1;
    let name = attempt === 1 ? base : suffixed(base, attempt);
    while (this.taken(name)) {
      attempt += 1;
      name = suffixed(base, attempt);
    }
    this.suffixOf.set(name, [base, attempt]);
    return name;
  }

  claim(name: string): void {
    this.used.add(name);
    const suffix = this.suffixOf.get(name);
    if (suffix) this.nextSuffix.set(suffix[0], suffix[1] + 1);
    this.suffixOf.clear();
  }
}

function suffixed(base: string, attempt: number): string {
  const suffix = `_${attempt}`;
  return base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
}
