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

function servers(...levels: unknown[]): OpenApiServer[] {
  for (const level of levels) {
    if (!Array.isArray(level)) continue;
    return level
      .filter((server): server is JsonObject => isObject(server) && typeof server.url === "string")
      .map((server) => ({
        url: server.url as string,
        ...(typeof server.description === "string" ? { description: server.description } : {}),
        ...(isObject(server.variables)
          ? { variables: server.variables as OpenApiServer["variables"] }
          : {}),
      }));
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

  operation(path: string, pathItem: JsonObject, method: OpenApiMethod, raw: JsonObject): OpenApiOperation {
    const parameters = this.parameters(path, pathItem, raw);
    const requestBody = this.requestBody(raw);
    return {
      method,
      path,
      ...(optionalString(raw.operationId) ? { operationId: raw.operationId as string } : {}),
      ...(optionalString(raw.summary) ? { summary: raw.summary as string } : {}),
      ...(optionalString(raw.description) ? { description: raw.description as string } : {}),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
      deprecated: raw.deprecated === true,
      parameters: parameters.map(({ parameter }) => parameter),
      ...(requestBody ? { requestBody: requestBody.info } : {}),
      servers: servers(raw.servers, pathItem.servers, this.document.servers),
      ...(security(raw.security, this.document.security) !== undefined
        ? { security: security(raw.security, this.document.security) }
        : {}),
    };
  }

  /** Parameters and the request body as one tool input schema (D11). */
  inputSchema(path: string, pathItem: JsonObject, raw: JsonObject): McpFnObjectSchema {
    const refs = new Set<string>();
    const groups: Array<[string, McpFnJsonSchema | boolean]> = [];
    const required: string[] = [];
    const parameters = this.parameters(path, pathItem, raw);
    for (const location of ["path", "query", "header"] as const) {
      const members = parameters.filter(({ parameter }) => parameter.in === location);
      if (members.length === 0) continue;
      const properties = Object.fromEntries(
        members.map(({ parameter, schema, description }) => {
          const converted = this.schemas.convert(schema, "input", refs);
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
    const body = this.requestBody(raw);
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

  /** The first 2xx response with `application/json` content, when its schema is an object schema. */
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
    const target = this.schemas.resolve(media.schema);
    const type = isObject(target) ? target.type : undefined;
    if (type !== "object" && !isObjectOnly(type)) return undefined;
    const refs = new Set<string>();
    let root = this.schemas.convert(media.schema, "output", refs);
    const definitions = this.schemas.definitions(refs, "output");
    // A root `$ref` is inlined: mcpFn needs `type: "object"` on the root itself.
    const seen = new Set<string>();
    while (isObject(root) && typeof root.$ref === "string" && Object.keys(root).length === 1) {
      const name = root.$ref.slice("#/definitions/".length);
      if (seen.has(name)) return undefined;
      seen.add(name);
      root = definitions[name]!;
    }
    // A 3.0 `nullable` object became ["object", "null"]: structuredContent is
    // always an object, so only a plain object schema is declared.
    if (!isObject(root) || !(root.type === "object" || isObjectOnly(root.type))) return undefined;
    return {
      ...root,
      type: "object",
      ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
    } as McpFnObjectSchema;
  }

  private readonly parameterCache = new WeakMap<JsonObject, ResolvedParameter[]>();

  private parameters(path: string, pathItem: JsonObject, raw: JsonObject): ResolvedParameter[] {
    const cached = this.parameterCache.get(raw);
    if (cached) return cached;
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
    this.parameterCache.set(raw, resolved);
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
      schema: raw.schema,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    };
  }

  private parameterShape(
    name: string,
    location: OpenApiParameterLocation,
    schema: unknown,
  ): "primitive" | "array" {
    const target = this.schemas.resolve(schema);
    if (isObjectValued(target)) {
      throw new OpenApiSkip(
        "unsupported-parameter-schema",
        `${location} parameter ${name} is object-valued`,
      );
    }
    if (!hasType(target, "array")) return "primitive";
    const items = isObject(target) ? this.schemas.resolve(target.items) : undefined;
    if (isObjectValued(items) || hasType(items, "array")) {
      throw new OpenApiSkip(
        "unsupported-parameter-schema",
        `${location} parameter ${name} is an array of non-primitive values`,
      );
    }
    return "array";
  }

  private readonly bodyCache = new WeakMap<JsonObject, { info: OpenApiOperationRequestBody; schema: unknown } | null>();

  private requestBody(raw: JsonObject): { info: OpenApiOperationRequestBody; schema: unknown } | undefined {
    if (raw.requestBody === undefined) return undefined;
    const cached = this.bodyCache.get(raw);
    if (cached !== undefined) return cached ?? undefined;
    const body = this.resolve(raw.requestBody, "requestBodies");
    const content = isObject(body.content) ? body.content : {};
    const keys = Object.keys(content);
    let result: { info: OpenApiOperationRequestBody; schema: unknown } | null = null;
    if (keys.length > 0) {
      const contentType = keys.find(isApplicationJson) ?? keys.find(isJsonMediaType);
      if (contentType === undefined) {
        throw new OpenApiSkip(
          "non-json-body",
          `request body has no JSON media type (${keys.join(", ")})`,
        );
      }
      const media = content[contentType];
      result = {
        info: { required: body.required === true, contentType },
        schema: isObject(media) && media.schema !== undefined ? media.schema : {},
      };
    }
    this.bodyCache.set(raw, result);
    return result ?? undefined;
  }
}

interface ResolvedParameter {
  parameter: OpenApiOperationParameter;
  schema: unknown;
  description?: string;
}

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

function isObjectOnly(type: unknown): boolean {
  return Array.isArray(type) && type.length === 1 && type[0] === "object";
}

function hasType(schema: unknown, type: string): boolean {
  if (!isObject(schema)) return false;
  return schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type));
}

function isObjectValued(schema: unknown): boolean {
  return (
    hasType(schema, "object") ||
    (isObject(schema) && (isObject(schema.properties) || isObject(schema.additionalProperties)))
  );
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
  const version = documentVersion(document);
  validateOptions(options);
  const include = compileSelectors("include", options.include);
  const exclude = compileSelectors("exclude", options.exclude);
  let source: JsonObject;
  try {
    // Work on a private copy: later changes to the caller's object cannot
    // alter registered schemas or the operations given to the executor.
    source = structuredClone(document);
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
        const operation = deepFreeze(converter.operation(path, pathItem, method, value));
        // A HEAD response has no body, so it never has structured output.
        const outputSchema = method === "HEAD" ? undefined : converter.outputSchema(value);
        // Each tool owns its schema objects: component conversions are cached
        // and shared, and a schema must not reach one object by two paths.
        candidates.push({
          operation,
          inputSchema: treeCopy(converter.inputSchema(path, pathItem, value)),
          ...(outputSchema ? { outputSchema: treeCopy(outputSchema) } : {}),
        });
      } catch (error) {
        if (!(error instanceof OpenApiSkip)) throw error;
        skipped.push({ operation: ref, code: error.code, reason: error.message });
      }
    }
  }

  const registry = options.registry ?? new McpFnRegistry<TContext>();
  const names = assignNames(candidates, options, registry);
  const tools: OpenApiToolInfo[] = [];
  const executor = options.executor;
  candidates.forEach((candidate, index) => {
    const name = names[index]!;
    const { operation, inputSchema, outputSchema } = candidate;
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
      if (!(error instanceof McpFnValidationError)) throw error;
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

function assignNames<TContext>(
  candidates: Candidate[],
  options: FromOpenApiOptions<TContext>,
  registry: McpFnRegistry<TContext>,
): string[] {
  const used = new Set<string>();
  const taken = (name: string) => used.has(name) || registry.has(name);
  return candidates.map(({ operation }) => {
    let name: string;
    if (options.name) {
      const chosen: unknown = options.name(operation);
      if (typeof chosen !== "string" || !TOOL_NAME.test(chosen)) {
        throw new McpFnValidationError(
          `name() returned an invalid tool name ${JSON.stringify(chosen)} for ${describeOperation(operation)}`,
        );
      }
      if (taken(chosen)) {
        throw new McpFnValidationError(
          `name() returned the duplicate tool name ${JSON.stringify(chosen)} for ${describeOperation(operation)}`,
        );
      }
      name = chosen;
    } else {
      const base = defaultName(operation, options.prefix ?? "");
      name = base;
      for (let attempt = 2; taken(name); attempt += 1) {
        const suffix = `_${attempt}`;
        name = base.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
      }
    }
    used.add(name);
    return name;
  });
}
