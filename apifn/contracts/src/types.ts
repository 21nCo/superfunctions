// Public contract types. Field names and version strings are part of the
// versioned wire contract; additive changes only within a version.

export const CATALOG_VERSION = "apifn.operation-catalog/v1" as const;
export const MANIFEST_VERSION = 1 as const;
export const RELEASE_DESCRIPTOR_VERSION = "apifn.release-descriptor/v1" as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type HttpMethod = "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace";

export type DiagnosticCode =
  | "INVALID_SPEC"
  | "INVALID_MANIFEST"
  | "MISSING_OPERATION_ID"
  | "DUPLICATE_OPERATION_ID"
  | "UNMATCHED_OPERATION_BINDING"
  | "NAME_COLLISION"
  | "UNRESOLVED_REF"
  | "UNKNOWN_SECURITY_SCHEME"
  | "UNSUPPORTED_SERIALIZATION"
  | "UNKNOWN_REPLACEMENT"
  | "AGENT_POLICY_REQUIRED"
  | "CREDENTIAL_REDACTED"
  | "INVALID_RELEASE";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: "error" | "warning";
  message: string;
  /** JSON pointer into the source document named by `source`. */
  pointer: string;
  source: "spec" | "manifest" | "release";
  /** Stable operation ID when the diagnostic concerns one operation. */
  operation?: string;
}

// ---------------------------------------------------------------------------
// Companion manifest (authored next to the OpenAPI document)
// ---------------------------------------------------------------------------

export interface ApiManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  api: { id: string; version: string };
  /** Media types clients must support. Defaults to `["application/json"]`. */
  serialization?: { mediaTypes: string[] };
  provenance?: { source?: string; revision?: string; exporter?: string };
  operations: OperationBinding[];
}

/**
 * Binds a stable operation ID to one spec operation: by OpenAPI operationId,
 * or by route (method and path together), never both.
 */
export type OperationBinding = OperationBindingFields &
  (
    | { /** Bind by OpenAPI operationId... */ operationId: string; method?: never; path?: never }
    | { operationId?: never; /** ...or by route, which survives operationId renames. Case-insensitive. */ method: string; path: string }
  );

interface OperationBindingFields {
  /** Stable operation identity; never derived from method names or paths. */
  id: string;
  /** Naming override for generated method/tool names. */
  name?: string;
  sdk?: { include?: boolean; excludeTargets?: string[] };
  /** Agent exposure is opt-in and independent of SDK inclusion. */
  agent?: { expose?: boolean };
  deprecation?: { replacement?: string; since?: string; message?: string };
  /** Reference to an execution policy owned by the runtime (e.g. MCP tools). */
  executionPolicy?: string;
}

// ---------------------------------------------------------------------------
// Operation catalog
// ---------------------------------------------------------------------------

export interface CatalogEncoding {
  /** Part content type; null keeps the default for the property type. */
  contentType: string | null;
  style: "form" | "deepObject";
  explode: boolean;
  allowReserved: boolean;
}

export interface CatalogContent {
  mediaType: string;
  schema: JsonValue | null;
  /**
   * Per-property serialization for `application/x-www-form-urlencoded` and
   * `multipart/form-data` bodies, keyed by property name; empty otherwise.
   */
  encoding: Record<string, CatalogEncoding>;
}

export interface CatalogParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  deprecated: boolean;
  /** `simple` for path and header, `form` or `deepObject` for query, `form` for cookie. */
  style: "simple" | "form" | "deepObject";
  explode: boolean;
  allowReserved: boolean;
  description: string | null;
  schema: JsonValue | null;
}

export interface CatalogServer {
  /** URL template without user info, query or fragment. */
  url: string;
  description: string | null;
  variables: Record<string, { default: string; enum: string[] | null; description: string | null }>;
}

export interface CatalogResponse {
  status: string;
  kind: "success" | "error" | "default";
  description: string;
  contents: CatalogContent[];
}

export interface SecurityRequirementTerm {
  scheme: string;
  scopes: string[];
}

export interface CatalogOperation {
  id: string;
  name: string;
  openapiOperationId: string | null;
  method: HttpMethod;
  path: string;
  summary: string | null;
  description: string | null;
  tags: string[];
  parameters: CatalogParameter[];
  requestBody: { required: boolean; contents: CatalogContent[] } | null;
  responses: CatalogResponse[];
  /** Path- or operation-level server override; null uses the catalog servers. */
  servers: CatalogServer[] | null;
  /**
   * Accepted credential combinations: any one alternative (OR) whose terms
   * are all satisfied (AND). An empty alternative allows anonymous calls.
   * This describes what the API accepts; it grants nothing.
   */
  security: { alternatives: SecurityRequirementTerm[][] };
  sdk: { include: boolean; excludedTargets: string[] };
  agent: { expose: boolean };
  deprecation: {
    deprecated: boolean;
    replacement: string | null;
    since: string | null;
    message: string | null;
  };
  executionPolicyRef: string | null;
}

export interface CatalogSecurityScheme {
  type: "apiKey" | "http" | "mutualTLS" | "oauth2" | "openIdConnect";
  description: string | null;
  scheme?: string;
  bearerFormat?: string;
  in?: "query" | "header" | "cookie";
  name?: string;
  openIdConnectUrl?: string;
  flows?: Partial<Record<"implicit" | "password" | "clientCredentials" | "authorizationCode", CatalogOAuthFlow>>;
}

export interface CatalogOAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: string[];
}

export interface OperationCatalog {
  catalogVersion: typeof CATALOG_VERSION;
  api: { id: string; version: string; title: string };
  source: {
    specDigest: string;
    manifestDigest: string;
    provenance: { source: string | null; revision: string | null; exporter: string | null };
  };
  serialization: { mediaTypes: string[] };
  servers: CatalogServer[];
  securitySchemes: Record<string, CatalogSecurityScheme>;
  operations: CatalogOperation[];
  /** Component schemas reachable from operations, keyed by component name. */
  schemas: Record<string, JsonValue>;
}

export interface BuildCatalogResult {
  catalog: OperationCatalog | null;
  /** `sha256:<hex>` of the canonical catalog JSON; null when errors occurred. */
  digest: string | null;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Release descriptor
// ---------------------------------------------------------------------------

export interface ArtifactInput {
  kind: "sdk" | "agent-tools";
  target: string;
  package: { name: string; version: string };
}

export interface ReleaseArtifact extends ArtifactInput {
  /** Stable operation IDs the artifact exposes, sorted. */
  operations: string[];
}

export interface ReleaseDescriptor {
  descriptorVersion: typeof RELEASE_DESCRIPTOR_VERSION;
  releaseId: string;
  api: { id: string; version: string };
  catalogDigest: string;
  specDigest: string;
  manifestDigest: string;
  generator: { name: string; version: string };
  artifacts: ReleaseArtifact[];
}

export interface CreateReleaseInput {
  catalog: OperationCatalog;
  generator: { name: string; version: string };
  artifacts: ArtifactInput[];
  /** Defaults to an ID derived from the descriptor content. */
  releaseId?: string;
}

export interface CreateReleaseResult {
  descriptor: ReleaseDescriptor | null;
  diagnostics: Diagnostic[];
}
