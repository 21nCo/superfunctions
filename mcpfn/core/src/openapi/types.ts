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
  name: string;
  in: OpenApiParameterLocation;
  required: boolean;
  style: "simple" | "form";
  explode: boolean;
  /** Query only: reserved characters are sent without percent-encoding. */
  allowReserved?: true;
  /**
   * `primitive` or `array` of primitives: the shape the executor serialises.
   * The input schema accepts no other shape, except `null` when the
   * parameter's schema allows it.
   */
  shape: "primitive" | "array";
}

/** The JSON request body the tool accepts. */
export interface OpenApiOperationRequestBody {
  required: boolean;
  /** The selected media type key: `application/json` or a `*+json` type. */
  contentType: string;
}

/**
 * Everything an executor needs to send one operation. The object is frozen and
 * the same instance is passed to every call of the tool.
 */
export interface OpenApiOperation {
  method: OpenApiMethod;
  /** Path template exactly as written in the document, such as `/users/{id}`. */
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags: readonly string[];
  deprecated: boolean;
  /** Parameters exposed as tool inputs. Forbidden headers (D9) are never listed. */
  parameters: readonly OpenApiOperationParameter[];
  requestBody?: OpenApiOperationRequestBody;
  /** Effective servers: the first non-empty level of operation, path item and document, else `[{ url: "/" }]`. */
  servers: readonly OpenApiServer[];
  /** Effective security requirements: operation level, else document level. */
  security?: readonly Record<string, readonly string[]>[];
}

export interface OpenApiServer {
  url: string;
  description?: string;
  variables?: Record<string, { default: string; enum?: string[]; description?: string }>;
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
  | "parameter-content"
  | "missing-path-parameter"
  | "non-json-body"
  | "unsupported-schema-keyword"
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

/** An operation selector: an operationId, `tag:<name>` or `METHOD /path`. */
export type OpenApiSelector = string;

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

/** A parsed OpenAPI 3.0/3.1 document. YAML parsing is the caller's job. */
export type OpenApiDocument = Record<string, unknown>;
