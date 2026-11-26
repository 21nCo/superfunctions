import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { McpFnObjectSchema, McpFnRegistry } from "@mcpfn/core";

/** Upper-case HTTP method of an OpenAPI 3.0/3.1 operation. */
export type OpenApiMethod =
  | "GET"
  | "PUT"
  | "POST"
  | "DELETE"
  | "OPTIONS"
  | "HEAD"
  | "PATCH"
  | "TRACE";

/** Where an operation parameter is sent. `cookie` parameters are outside the supported set. */
export type OpenApiParameterLocation = "path" | "query" | "header";

/**
 * A parameter the tool accepts, after `$ref` resolution and the path-level /
 * operation-level merge. Only the default styles are supported: `simple` for
 * path and header parameters, `form` with `explode: true` for query parameters.
 */
export interface OpenApiOperationParameter {
  readonly name: string;
  readonly in: OpenApiParameterLocation;
  readonly required: boolean;
  readonly style: "simple" | "form";
  readonly explode: boolean;
  /** Query only: reserved characters are sent without percent-encoding. */
  readonly allowReserved?: true;
  /**
   * `primitive` or `array` of primitives: the shape the executor serialises.
   * The input schema accepts no other shape, except `null` when the
   * parameter's schema allows it.
   */
  readonly shape: "primitive" | "array";
}

/** The JSON request body the tool accepts. */
export interface OpenApiOperationRequestBody {
  readonly required: boolean;
  /** The selected media type key: `application/json` or a `*+json` type. */
  readonly contentType: string;
}

/**
 * Everything an executor needs to send one operation. The object is deeply
 * frozen, so every field is read-only, and the same instance is passed to the
 * `name` callback and to every call of the tool.
 */
export interface OpenApiOperation {
  readonly method: OpenApiMethod;
  /** Path template exactly as written in the document, such as `/users/{id}`. */
  readonly path: string;
  readonly operationId?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly deprecated: boolean;
  /** Parameters exposed as tool inputs. Forbidden headers (D9) are never listed. */
  readonly parameters: readonly OpenApiOperationParameter[];
  readonly requestBody?: OpenApiOperationRequestBody;
  /** Effective servers: the first non-empty level of operation, path item and document, else `[{ url: "/" }]`. */
  readonly servers: readonly OpenApiServer[];
  /** Effective security requirements: operation level, else document level. */
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
}

export interface OpenApiServer {
  readonly url: string;
  readonly description?: string;
  readonly variables?: Readonly<
    Record<string, { readonly default: string; readonly enum?: readonly string[]; readonly description?: string }>
  >;
}

/** Identifies an operation that was not turned into a tool. */
export interface OpenApiOperationRef {
  /** Absent when the whole path item was skipped (for example a path item `$ref`). */
  method?: OpenApiMethod;
  path: string;
  operationId?: string;
}

export type OpenApiSkipCode =
  | "excluded"
  | "not-included"
  | "deprecated"
  | "mutation-not-allowed"
  | "external-ref"
  | "unsupported-ref"
  | "unresolved-ref"
  | "cookie-parameter"
  | "unsupported-parameter-style"
  | "unsupported-parameter-schema"
  | "unsupported-parameter-name"
  | "unsupported-property-name"
  | "parameter-content"
  | "missing-path-parameter"
  | "non-json-body"
  | "invalid-request-body"
  | "unsupported-schema-keyword"
  | "unsupported-access-flag"
  | "unsupported-dialect"
  | "schema-too-large"
  | "unsupported-component-name"
  | "circular-object"
  | "invalid-operation"
  | "invalid-schema";

export interface OpenApiSkippedOperation {
  operation: OpenApiOperationRef;
  code: OpenApiSkipCode;
  /** Human-readable reason naming the construct that caused the skip. */
  reason: string;
}

export interface OpenApiExecuteRequest {
  operation: OpenApiOperation;
  /** Arguments exactly as validated by the registry against the tool's input schema. */
  args: Record<string, unknown>;
  signal: AbortSignal;
}

/** Sends a validated tool call to the API. The HTTP implementation is separate (MCP-6). */
export interface OpenApiExecutor {
  execute(request: OpenApiExecuteRequest): CallToolResult | Promise<CallToolResult>;
}

/**
 * An operation selector: an operationId, `tag:<name>` or `METHOD /path` as a
 * string, or `{ operationId }`, which matches that operationId exactly even
 * when it reads as a tag or route selector.
 */
export type OpenApiSelector = string | { readonly operationId: string };

export interface FromOpenApiOptions<TContext = undefined> {
  executor: OpenApiExecutor;
  /** When present, only matching operations are exposed. */
  include?: readonly OpenApiSelector[];
  /** Matching operations are never exposed; `exclude` wins over `include`. */
  exclude?: readonly OpenApiSelector[];
  /** Expose methods other than GET and HEAD without listing their operationId in `include`. */
  allowMutations?: boolean;
  /** Expose operations marked `deprecated: true`. */
  includeDeprecated?: boolean;
  /** Overrides the generated tool name. An invalid or duplicate name is an error. */
  name?: (operation: OpenApiOperation) => string;
  /** Prepended to generated names before sanitisation and truncation. */
  prefix?: string;
  /** Registry to register the tools on; a new one is created when omitted. */
  registry?: McpFnRegistry<TContext>;
}

export interface OpenApiToolInfo {
  name: string;
  description: string;
  operation: OpenApiOperation;
  inputSchema: McpFnObjectSchema;
  outputSchema?: McpFnObjectSchema;
  annotations: ToolAnnotations;
}

export interface FromOpenApiResult<TContext = undefined> {
  registry: McpFnRegistry<TContext>;
  tools: OpenApiToolInfo[];
  skipped: OpenApiSkippedOperation[];
}

/**
 * The standard top-level fields of an OpenAPI 3.0/3.1 document, typed loosely
 * so that documents typed by their producer (such as the interface
 * `@apifn/core`'s `fromRouter` returns) are accepted as they are; the content
 * is validated at run time. `fromOpenAPI` constrains its document type
 * parameter by this interface, so an inferred literal may carry any other
 * top-level field, while a value sharing none of these fields is refused.
 */
export interface OpenApiDocumentFields {
  readonly openapi?: unknown;
  readonly swagger?: unknown;
  readonly info?: unknown;
  readonly jsonSchemaDialect?: unknown;
  readonly servers?: unknown;
  readonly paths?: unknown;
  readonly webhooks?: unknown;
  readonly components?: unknown;
  readonly security?: unknown;
  readonly tags?: unknown;
  readonly externalDocs?: unknown;
}

/**
 * A parsed OpenAPI 3.0/3.1 document. YAML parsing is the caller's job. Also
 * accepts `x-*` extensions where the type is named, such as an annotated
 * literal or a call that supplies the context type explicitly.
 */
export interface OpenApiDocument extends OpenApiDocumentFields {
  readonly [extension: `x-${string}`]: unknown;
}
