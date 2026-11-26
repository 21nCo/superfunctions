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
  /**
   * Parameters exposed as tool inputs. Forbidden headers and parameters
   * named by an `apiKey` security scheme of the operation (D9), and those the
   * executor owns (`OpenApiExecutor.ownsParameter`), are never listed.
   */
  readonly parameters: readonly OpenApiOperationParameter[];
  readonly requestBody?: OpenApiOperationRequestBody;
  /** Effective servers: the first non-empty level of operation, path item and document, else `[{ url: "/" }]`. */
  readonly servers: readonly OpenApiServer[];
  /** Effective security requirements: operation level, else document level. */
  readonly security?: readonly Readonly<Record<string, readonly string[]>>[];
  /**
   * Present when the effective security requirements are malformed (a level
   * that is not a list, a requirement that is not an object, scopes that are
   * not a list of strings): why. `security` then lists only the well-formed
   * requirements, so an executor that sends credentials should refuse the
   * operation (`httpExecutor` does).
   */
  readonly securityUnresolved?: string;
  /**
   * The security schemes `security` names that `components.securitySchemes`
   * defines, by name (`$ref` followed). Present when at least one resolves.
   */
  readonly securitySchemes?: Readonly<Record<string, OpenApiSecurityScheme>>;
}

/**
 * A security scheme an operation accepts, as far as an executor needs it.
 * Credentials are the executor's job (D9): a parameter named by an `apiKey`
 * scheme of the operation is never a tool input.
 */
export interface OpenApiSecurityScheme {
  /** As written, such as `apiKey`, `http`, `oauth2`, `openIdConnect` or `mutualTLS`. */
  readonly type: string;
  /** `apiKey` only: the parameter that carries the credential. */
  readonly name?: string;
  /** `apiKey` only: where that parameter is sent. */
  readonly in?: "header" | "query" | "cookie";
  /** `http` only: the authorization scheme, such as `bearer`. */
  readonly scheme?: string;
}

/** A query or header parameter `fromOpenAPI` asks an executor about (`OpenApiExecutor.ownsParameter`). */
export interface OpenApiParameterQuery {
  readonly name: string;
  readonly in: "query" | "header";
  readonly required: boolean;
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
  | "invalid-schema"
  | "unsupported-by-executor";

export interface OpenApiSkippedOperation {
  operation: OpenApiOperationRef;
  code: OpenApiSkipCode;
  /** Human-readable reason naming the construct that caused the skip. */
  reason: string;
}

export interface OpenApiExecuteRequest<TContext = unknown> {
  operation: OpenApiOperation;
  /** Arguments exactly as validated by the registry against the tool's input schema. */
  args: Record<string, unknown>;
  /** The trusted context the server's `context` factory built for this call. */
  context: TContext;
  signal: AbortSignal;
  /** Whether the tool declares an output schema, so a success must carry `structuredContent`. */
  hasOutputSchema: boolean;
  /**
   * With an output schema: whether a value satisfies it, so an executor can
   * report a success the schema does not describe instead of returning
   * structured content the registry would reject.
   */
  checkOutput?: (value: Record<string, unknown>) => boolean;
}

/** Sends a validated tool call to the API, such as the one `httpExecutor` returns. */
export interface OpenApiExecutor<TContext = unknown> {
  execute(request: OpenApiExecuteRequest<TContext>): CallToolResult | Promise<CallToolResult>;
  /**
   * Why this executor cannot send an operation, or `undefined` when it can.
   * `fromOpenAPI` skips such operations (`unsupported-by-executor`) instead
   * of exposing tools whose every call would fail.
   */
  unsupported?(operation: OpenApiOperation): string | undefined;
  /**
   * Whether the executor supplies a query or header parameter itself, such
   * as a header the operator sets. `fromOpenAPI` then leaves the parameter
   * out of the tool input and `OpenApiOperation.parameters`, so no caller
   * value for it is accepted. Path parameters are always inputs.
   */
  ownsParameter?(parameter: OpenApiParameterQuery): boolean;
  /**
   * Whether the executor can send a request body under this documented media
   * type, as written in the request body's `content`. `fromOpenAPI` then
   * chooses the request body only among the JSON entries the executor can
   * send, so the tool uses that entry's schema and media type together. When
   * it can send none of them, every entry is tried as without this hook, and
   * `unsupported` decides.
   */
  sendsRequestMedia?(contentType: string): boolean;
  /**
   * Which response schema becomes a tool's output schema. `first-success`
   * (the default): the first 2xx JSON schema. `every-success`: that schema
   * only when every documented 2xx response offers only JSON content with
   * the same schema, so no documented success falls outside it (a `2XX`
   * range, which covers the bodyless `204` and `205`, gives none).
   */
  readonly outputSchemaRule?: "first-success" | "every-success";
}

/**
 * An operation selector: an operationId, `tag:<name>` or `METHOD /path` as a
 * string, or `{ operationId }`, which matches that operationId exactly even
 * when it reads as a tag or route selector.
 */
export type OpenApiSelector = string | { readonly operationId: string };

export interface FromOpenApiOptions<TContext = undefined> {
  executor: OpenApiExecutor<NoInfer<TContext>>;
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
