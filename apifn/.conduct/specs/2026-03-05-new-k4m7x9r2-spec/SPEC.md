# ApiFn — Full Specification

## Metadata

| Field | Value |
|---|---|
| Timestamp | 2026-03-05T22:00:00Z |
| Agent Name | unknown-agent |
| Model | claude-4.6-opus |
| Launcher | Cursor |
| Workspace | /Users/serro/Documents/dev/n/superfunctions |
| OS | darwin 25.3.0 |
| Shell | zsh |
| Git Branch | next |
| Git Commit | 664f92c880a6a5a150d115bf60e30f37c4107062 |
| Git Dirty | Yes |
| Spec Folder | 2026-03-05-new-k4m7x9r2-spec |
| Spec Type | new |
| Spec ID | k4m7x9r2 |
| Input Paths | apifn/.conduct/intent-v0.md |

---

## 1. Overview

ApiFn is a self-hosted, code-first API development platform for the Superfunctions ecosystem. It extracts API schemas directly from `@superfunctions/http` route definitions, generates OpenAPI 3.1 specifications with zero manual YAML authoring, stores executable API collections in the open [OpenCollection](https://spec.opencollection.com/) YAML format (git-native, Bruno-compatible), and provides an interactive API explorer with live runtime performance data via watchfn.

ApiFn combines four capabilities that no existing tool unifies:

1. **Code-derived schemas** — OpenAPI 3.1 generated from typed route definitions, not maintained separately.
2. **OpenCollection YAML collections** — Git-native, human-readable, interoperable with Bruno and any OpenCollection-compatible tool.
3. **Live performance overlay** — Per-endpoint p50/p95/p99 latency, error rates, and throughput from watchfn.
4. **Embedded documentation** — First-class docsfn plugin for API reference pages within documentation sites.

**Version**: 1.0.0
**Target Release**: Q4 2026
**Status**: Specification

---

## 2. Glossary

| Term | Definition |
|---|---|
| **Route** | A `Route<TContext>` object from `@superfunctions/http` with method, path, handler, middleware, and meta fields. |
| **Router** | A `Router<TContext>` object returned by `createRouter()` from `@superfunctions/http`. |
| **Schema Descriptor** | A typed annotation on a route's `meta` field that declares request/response shapes using zod, TypeBox, or plain JSON Schema. |
| **Introspection** | The process of programmatically extracting route metadata (method, path, params, schema descriptors) from a Router instance. |
| **OpenAPI Document** | A JSON/YAML document conforming to the OpenAPI 3.1.0 specification. |
| **OpenCollection** | An open YAML-based specification for defining executable API collections, created by Bruno. See [spec.opencollection.com](https://spec.opencollection.com/). |
| **Collection** | A directory of OpenCollection YAML files (`.yml`) organized by folders, with an `opencollection.yml` root file. |
| **Environment** | A set of named key-value variables (e.g. `baseUrl`, `authToken`) that can be substituted into collection requests at runtime. |
| **Collection Run** | A single execution of some or all requests in a collection against an environment, producing a run report. |
| **Schema Diff** | A comparison between two OpenAPI documents that identifies additions, removals, and modifications, classified as breaking or non-breaking. |
| **Breaking Change** | A schema modification that could cause existing API consumers to fail (removed endpoint, narrowed response type, changed required fields, etc.). |
| **Try-It Console** | An interactive UI widget that lets users compose and send HTTP requests to a live API and inspect responses. |
| **API Explorer** | A full-page UI for browsing all endpoints, viewing schemas, sending requests, and inspecting performance data. |
| **Performance Overlay** | A UI layer that displays watchfn-sourced runtime metrics (latency percentiles, error rate, throughput) per endpoint. |
| **Mock Server** | A local HTTP server that returns synthetic responses matching an OpenAPI schema, without a real backend. |
| **Code Snippet** | A generated code example showing how to call an endpoint in a specific language/library (curl, fetch, axios, Python requests, etc.). |

---

## 3. Goals

1. **Zero-drift API documentation** — OpenAPI specs are generated from running code, never manually authored or maintained.
2. **OpenCollection interoperability** — Collections use the standard OpenCollection YAML format; they MUST be importable by Bruno and any OpenCollection-compatible tool.
3. **Developer-first testing** — Collections are executable, git-native, and runnable from CLI in CI/CD.
4. **Embedded API reference** — API docs live inside your documentation site via docsfn, not on a separate portal.
5. **Runtime-aware** — Live performance data from watchfn surfaces directly in the API explorer and docs.
6. **Self-hosted** — All data stays local; no cloud accounts, no telemetry, no vendor lock-in.
7. **Ecosystem-native** — Deep integration with authfn (test tokens), secfn (rate limits), logfn (structured logging), testfn (test adapters), watchfn (APM).
8. **Multi-framework** — UI components for React and Svelte; Python adapters for FastAPI and Flask.
9. **CI/CD-native** — Breaking change detection, collection testing, and OpenAPI export all work headlessly.

## 4. Non-Goals

1. **Hosted API platform** — ApiFn is not a hosted SaaS; it does not provide cloud storage, team accounts, or cloud sync.
2. **API Gateway** — ApiFn does not proxy or route production traffic; it observes and documents.
3. **General-purpose HTTP client** — The Try-It console is scoped to API development, not a replacement for curl/HTTPie for arbitrary requests.
4. **GraphQL support** — ApiFn targets REST/HTTP APIs only. GraphQL introspection is out of scope.
5. **API monetization** — No built-in billing for API consumers (billfn handles that separately).
6. **Load testing** — The collection runner validates correctness, not performance under load.

---

## 5. Public API

### 5.1 Core — `@apifn/core`

```typescript
// --- Route Introspection ---

interface IntrospectOptions {
  /** Include routes matching these path prefixes only */
  include?: string[];
  /** Exclude routes matching these path prefixes */
  exclude?: string[];
  /** Base path to prepend to all route paths */
  basePath?: string;
}

interface IntrospectedRoute {
  method: HttpMethod;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters: ParameterDescriptor[];
  requestBody?: RequestBodyDescriptor;
  responses: Record<string, ResponseDescriptor>;
  security?: SecurityRequirement[];
  meta: Record<string, any>;
}

/**
 * Extract structured route metadata from a @superfunctions/http Router.
 * Reads schema descriptors from route.meta if present.
 */
function introspectRouter(
  router: Router<any>,
  options?: IntrospectOptions
): IntrospectedRoute[];

// --- Schema Descriptors ---

interface SchemaDescriptor {
  /** Human-readable summary */
  summary?: string;
  /** Detailed description */
  description?: string;
  /** Unique operation identifier */
  operationId?: string;
  /** Tags for grouping */
  tags?: string[];
  /** Whether this endpoint is deprecated */
  deprecated?: boolean;
  /** Request body schema (zod, TypeBox, or JSON Schema) */
  body?: ZodType | TSchema | JsonSchema;
  /** Query parameter schemas */
  query?: Record<string, ZodType | TSchema | JsonSchema>;
  /** Path parameter schemas */
  params?: Record<string, ZodType | TSchema | JsonSchema>;
  /** Header parameter schemas */
  headers?: Record<string, ZodType | TSchema | JsonSchema>;
  /** Response schemas keyed by status code */
  responses?: Record<string | number, {
    description: string;
    schema?: ZodType | TSchema | JsonSchema;
    headers?: Record<string, ZodType | TSchema | JsonSchema>;
  }>;
  /** Security requirements */
  security?: SecurityRequirement[];
}

/**
 * Helper to create a typed schema descriptor for use in route.meta.
 * Returns the descriptor as-is but provides type checking.
 */
function apiSchema(descriptor: SchemaDescriptor): SchemaDescriptor;

// --- OpenAPI Generation ---

interface OpenAPIGenerateOptions {
  /** OpenAPI info object */
  info: {
    title: string;
    version: string;
    description?: string;
    termsOfService?: string;
    contact?: { name?: string; url?: string; email?: string };
    license?: { name: string; url?: string };
  };
  /** Server URLs */
  servers?: Array<{ url: string; description?: string }>;
  /** Global security schemes */
  securitySchemes?: Record<string, SecuritySchemeObject>;
  /** Global security requirements */
  security?: SecurityRequirement[];
  /** External docs */
  externalDocs?: { url: string; description?: string };
  /** Custom x- extensions on the root document */
  extensions?: Record<string, any>;
}

interface OpenAPIDocument {
  openapi: "3.1.0";
  info: OpenAPIInfoObject;
  servers?: ServerObject[];
  paths: PathsObject;
  components?: ComponentsObject;
  security?: SecurityRequirement[];
  tags?: TagObject[];
  externalDocs?: ExternalDocsObject;
  [key: `x-${string}`]: any;
}

/**
 * Generate an OpenAPI 3.1.0 document from introspected routes.
 */
function generateOpenAPI(
  routes: IntrospectedRoute[],
  options: OpenAPIGenerateOptions
): OpenAPIDocument;

/**
 * Convenience: introspect router + generate OpenAPI in one call.
 */
function fromRouter(
  router: Router<any>,
  options: OpenAPIGenerateOptions & IntrospectOptions
): OpenAPIDocument;

// --- OpenAPI Import ---

/**
 * Parse and validate an OpenAPI 3.1 or 3.0 document (JSON or YAML string).
 * Returns a normalized 3.1 document.
 */
function parseOpenAPI(input: string | object): OpenAPIDocument;

/**
 * Validate an OpenAPI document against the 3.1 JSON Schema.
 * Returns validation errors or empty array.
 */
function validateOpenAPI(doc: OpenAPIDocument): ValidationError[];

// --- Schema Diff ---

interface DiffResult {
  breaking: DiffEntry[];
  nonBreaking: DiffEntry[];
  /** Overall: true if any breaking changes exist */
  hasBreakingChanges: boolean;
  summary: {
    added: number;
    removed: number;
    modified: number;
    breaking: number;
    nonBreaking: number;
  };
}

interface DiffEntry {
  type: "added" | "removed" | "modified";
  breaking: boolean;
  path: string;
  description: string;
  before?: any;
  after?: any;
}

/**
 * Compare two OpenAPI documents and detect breaking/non-breaking changes.
 */
function diffOpenAPI(
  before: OpenAPIDocument,
  after: OpenAPIDocument
): DiffResult;
```

### 5.2 Collections — `@apifn/collections`

```typescript
// --- OpenCollection Read/Write ---

interface Collection {
  /** Collection metadata from opencollection.yml */
  info: CollectionInfo;
  /** Environments */
  environments: Record<string, Environment>;
  /** Request items organized by folder */
  items: CollectionItem[];
  /** Root directory path */
  rootDir: string;
}

interface CollectionInfo {
  name: string;
  version?: string;
  description?: string;
  type?: "collection";
}

interface CollectionItem {
  kind: "request" | "folder";
  name: string;
  /** Relative path within the collection */
  path: string;
  /** For kind: "request" — the parsed OpenCollection request YAML */
  request?: OpenCollectionRequest;
  /** For kind: "folder" — child items */
  children?: CollectionItem[];
  /** Sequence number for ordering */
  seq?: number;
}

interface OpenCollectionRequest {
  info: { name: string; type: "http"; seq?: number };
  http: {
    method: string;
    url: string;
    headers?: Array<{ name: string; value: string; enabled?: boolean }>;
    body?: { type: string; data: string };
    auth?: "inherit" | "none" | AuthConfig;
    params?: {
      path?: Array<{ name: string; value: string }>;
      query?: Array<{ name: string; value: string; enabled?: boolean }>;
    };
  };
  runtime?: {
    scripts?: Array<{
      type: "pre-request" | "tests" | "post-response";
      code: string;
    }>;
  };
  settings?: {
    encodeUrl?: boolean;
    timeout?: number;
    followRedirects?: boolean;
    maxRedirects?: number;
  };
}

interface Environment {
  name: string;
  variables: Record<string, string>;
}

/**
 * Read an OpenCollection from a directory.
 * Expects opencollection.yml at root.
 */
function readCollection(dir: string): Promise<Collection>;

/**
 * Write a Collection back to disk as OpenCollection YAML.
 */
function writeCollection(collection: Collection): Promise<void>;

/**
 * Validate a collection against the OpenCollection JSON Schema.
 */
function validateCollection(collection: Collection): ValidationError[];

/**
 * Generate an OpenCollection from an OpenAPI document.
 * Creates one request per operation.
 */
function openAPIToCollection(
  doc: OpenAPIDocument,
  options?: {
    baseUrl?: string;
    groupBy?: "tag" | "path";
    includeExamples?: boolean;
  }
): Collection;

/**
 * Generate an OpenCollection from a @superfunctions/http router directly.
 */
function routerToCollection(
  router: Router<any>,
  options?: {
    baseUrl?: string;
    groupBy?: "tag" | "path";
    includeExamples?: boolean;
  } & IntrospectOptions
): Collection;

// --- Collection Runner ---

interface RunOptions {
  /** Environment to use */
  environment: string | Environment;
  /** Only run requests matching these paths/patterns */
  include?: string[];
  /** Skip requests matching these paths/patterns */
  exclude?: string[];
  /** Run requests in parallel (default: sequential) */
  parallel?: boolean;
  /** Max concurrent requests when parallel=true */
  concurrency?: number;
  /** Global timeout per request in ms (default: 30000) */
  timeout?: number;
  /** Abort on first failure */
  bail?: boolean;
  /** Number of retries for failed requests */
  retries?: number;
  /** Delay between sequential requests in ms */
  delay?: number;
  /** Custom HTTP client (default: built-in fetch-based) */
  httpClient?: HttpClient;
  /** Reporter for progress updates */
  reporter?: RunReporter;
  /** Variables that override environment variables */
  overrides?: Record<string, string>;
}

interface RunReport {
  id: string;
  collectionName: string;
  environment: string;
  startedAt: string;
  completedAt: string;
  duration: number;
  results: RequestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errors: number;
    duration: number;
  };
}

interface RequestResult {
  name: string;
  path: string;
  method: string;
  url: string;
  status: "passed" | "failed" | "skipped" | "error";
  statusCode?: number;
  duration: number;
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  response?: { status: number; headers: Record<string, string>; body: string; size: number };
  assertions: AssertionResult[];
  error?: string;
}

interface AssertionResult {
  name: string;
  passed: boolean;
  expected?: any;
  actual?: any;
  error?: string;
}

interface RunReporter {
  onStart?(collection: Collection, options: RunOptions): void;
  onRequestStart?(item: CollectionItem): void;
  onRequestComplete?(result: RequestResult): void;
  onComplete?(report: RunReport): void;
}

/**
 * Execute a collection run.
 */
function runCollection(
  collection: Collection,
  options: RunOptions
): Promise<RunReport>;
```

### 5.3 CLI — `@apifn/cli`

```
apifn init [dir]                  Initialize a new OpenCollection in [dir]
apifn generate [router-path]      Generate OpenAPI from a router file
apifn export [format] [output]    Export OpenAPI as YAML or JSON
apifn test [collection-dir]       Run a collection's tests
apifn diff <before> <after>       Detect breaking changes between specs
apifn serve [router-or-spec]      Start local API explorer
apifn mock [spec]                 Start mock server from OpenAPI spec
apifn snippet <spec> <path>       Generate code snippets for an endpoint
apifn validate <spec>             Validate an OpenAPI document
```

**Global flags:**

| Flag | Description |
|---|---|
| `--config <path>` | Path to apifn config file (default: `apifn.config.ts`) |
| `--env <name>` | Environment name for test/serve commands |
| `--format <json\|yaml>` | Output format (default: yaml) |
| `--verbose` | Enable verbose output |
| `--quiet` | Suppress non-error output |
| `--no-color` | Disable colored output |

### 5.4 UI Components — `@apifn/react` and `@apifn/svelte`

```typescript
// React
interface ApiExplorerProps {
  /** OpenAPI document or URL to fetch it from */
  spec: OpenAPIDocument | string;
  /** Base URL for try-it requests (default: first server in spec) */
  baseUrl?: string;
  /** watchfn client for live performance data */
  watchfn?: WatchFnClient;
  /** Auth configuration for try-it console */
  auth?: AuthConfig;
  /** Custom theme */
  theme?: "light" | "dark" | "auto";
  /** Custom CSS class */
  className?: string;
  /** Route prefix for navigation (default: "/") */
  routePrefix?: string;
}

function ApiExplorer(props: ApiExplorerProps): JSX.Element;

interface TryItProps {
  /** The endpoint to target */
  endpoint: { method: string; path: string; spec: OperationObject };
  /** Base URL */
  baseUrl: string;
  /** Auth config */
  auth?: AuthConfig;
  /** watchfn metrics for this endpoint */
  metrics?: EndpointMetrics;
}

function TryIt(props: TryItProps): JSX.Element;

interface SchemaViewerProps {
  schema: SchemaObject;
  name?: string;
  expandDepth?: number;
}

function SchemaViewer(props: SchemaViewerProps): JSX.Element;

interface EndpointViewerProps {
  method: string;
  path: string;
  operation: OperationObject;
  baseUrl?: string;
  metrics?: EndpointMetrics;
}

function EndpointViewer(props: EndpointViewerProps): JSX.Element;

interface RequestHistoryProps {
  history: RequestResult[];
  onSelect?: (result: RequestResult) => void;
}

function RequestHistory(props: RequestHistoryProps): JSX.Element;

interface ResponseDiffProps {
  left: RequestResult;
  right: RequestResult;
}

function ResponseDiff(props: ResponseDiffProps): JSX.Element;

interface PerformanceOverlayProps {
  metrics: EndpointMetrics;
}

function PerformanceOverlay(props: PerformanceOverlayProps): JSX.Element;

// Svelte: same props as interfaces, exported as Svelte components
```

### 5.5 docsfn Plugin — `@apifn/docsfn`

```typescript
/**
 * DocsContentProvider that reads from apifn.
 * Returns kind: "api" entries for each tag group or the full spec.
 */
interface ApifnDocsProviderOptions {
  /** OpenAPI document, router, or path to spec file */
  source: OpenAPIDocument | Router<any> | string;
  /** Split into multiple pages by tag (default: true) */
  splitByTag?: boolean;
  /** Include try-it console (default: true) */
  tryIt?: boolean;
  /** watchfn client for performance overlay */
  watchfn?: WatchFnClient;
  /** Base URL for try-it requests */
  baseUrl?: string;
}

function createApifnProvider(
  options: ApifnDocsProviderOptions
): DocsContentProvider;

// React component
function ApifnApiReference(props: {
  api: ApiReference;
  tryIt?: boolean;
  watchfn?: WatchFnClient;
  baseUrl?: string;
}): JSX.Element;

// Svelte component: same props
```

### 5.6 Mock Server — `@apifn/mock`

```typescript
interface MockServerOptions {
  /** OpenAPI document */
  spec: OpenAPIDocument;
  /** Port (default: 4010) */
  port?: number;
  /** Generate responses from examples or schema (default: "schema") */
  responseMode?: "examples" | "schema" | "random";
  /** Validate incoming requests against schemas */
  validateRequests?: boolean;
  /** Delay responses by ms (simulates latency) */
  delay?: number;
  /** CORS configuration */
  cors?: boolean | CorsOptions;
}

function createMockServer(options: MockServerOptions): {
  start(): Promise<{ url: string; port: number }>;
  stop(): Promise<void>;
  router: Router<any>;
};
```

### 5.7 Code Snippets — `@apifn/snippets`

```typescript
type SnippetTarget =
  | "curl"
  | "fetch"
  | "axios"
  | "node-fetch"
  | "python-requests"
  | "python-httpx"
  | "go-http"
  | "ruby-net-http"
  | "php-curl"
  | "csharp-httpclient"
  | "java-okhttp";

interface SnippetOptions {
  /** Target language/library */
  target: SnippetTarget;
  /** Include auth headers */
  auth?: { type: string; token?: string; key?: string };
  /** Base URL */
  baseUrl: string;
  /** Indentation (default: 2 spaces) */
  indent?: number;
}

/**
 * Generate a code snippet for an OpenAPI operation.
 */
function generateSnippet(
  operation: OperationObject,
  path: string,
  method: string,
  options: SnippetOptions
): string;

/**
 * Generate snippets for all operations in a spec.
 */
function generateAllSnippets(
  spec: OpenAPIDocument,
  options: SnippetOptions
): Record<string, string>;
```

### 5.8 Ecosystem Integrations

```typescript
// --- watchfn Integration ---

interface EndpointMetrics {
  method: string;
  path: string;
  latency: { p50: number; p95: number; p99: number; avg: number };
  throughput: { rpm: number; total: number };
  errors: { rate: number; count: number; lastError?: string };
  availability: number;
  lastUpdated: string;
}

/**
 * Fetch metrics for all endpoints from a watchfn instance.
 */
function fetchEndpointMetrics(
  watchfnUrl: string,
  options?: { timeRange?: string; endpoints?: string[] }
): Promise<EndpointMetrics[]>;

/**
 * Create a middleware that reports apifn-specific metrics to watchfn.
 */
function apifnWatchMiddleware(config: {
  watchfn: WatchFnClient;
}): Middleware<any>;

// --- authfn Integration ---

/**
 * Mint a short-lived API key for collection testing.
 */
function mintTestToken(
  authfn: AuthFnInstance,
  options: {
    /** Scopes for the token */
    scopes?: string[];
    /** Endpoints the token can access */
    resourceIds?: string[];
    /** TTL in seconds (default: 300 = 5 minutes) */
    ttl?: number;
    /** Token name prefix (default: "apifn-test") */
    namePrefix?: string;
  }
): Promise<{ token: string; expiresAt: Date; keyId: string }>;

// --- secfn Integration ---

interface RateLimitInfo {
  endpoint: string;
  method: string;
  remaining: number;
  limit: number;
  resetAt: number;
  blocked: boolean;
}

/**
 * Fetch rate limit headroom for endpoints from secfn.
 */
function fetchRateLimits(
  rateLimiter: RateLimiter,
  endpoints: Array<{ method: string; path: string }>,
  context: { userId?: string; ip: string }
): Promise<RateLimitInfo[]>;

// --- logfn Integration ---

/**
 * Create a collection run reporter that logs to logfn.
 */
function logfnReporter(logger: Logger): RunReporter;

// --- testfn Integration ---

/**
 * TestFrameworkAdapter for testfn that runs OpenCollection collections.
 */
class ApifnTestAdapter extends BaseAdapter {
  name: "apifn";
  discover(patterns: string[]): Promise<TestCase[]>;
  run(tests: TestCase[], options: RunOptions): Promise<TestResult[]>;
  supports(framework: string): boolean;
}
```

### 5.9 Python — `apifn`

```python
# --- FastAPI Adapter ---

from apifn import introspect_fastapi, generate_openapi, ApifnConfig

config = ApifnConfig(
    title="My API",
    version="1.0.0",
)

# Introspect FastAPI app and return augmented OpenAPI
spec = introspect_fastapi(app, config)

# --- Flask Adapter ---

from apifn.flask import introspect_flask

spec = introspect_flask(app, config)

# --- Collection Runner ---

from apifn.collections import read_collection, run_collection, RunOptions

collection = read_collection("./api-collection")
report = run_collection(collection, RunOptions(environment="development"))

# --- Schema Diff ---

from apifn.diff import diff_openapi

result = diff_openapi(old_spec, new_spec)
if result.has_breaking_changes:
    print(f"Found {result.summary.breaking} breaking changes")
```

---

## 6. Data Formats

### 6.1 OpenAPI 3.1.0

All generated documents MUST conform to the [OpenAPI 3.1.0 specification](https://spec.openapis.org/oas/v3.1.0). The `openapi` field MUST be `"3.1.0"`. JSON Schema used within component schemas MUST conform to JSON Schema Draft 2020-12 as required by OpenAPI 3.1.

### 6.2 OpenCollection YAML

Collections MUST follow the [OpenCollection specification](https://spec.opencollection.com/). Key structural rules:

- Root file MUST be `opencollection.yml`.
- Request files MUST use `.yml` extension.
- Folder configuration files MUST be `folder.yml`.
- Environment files MUST be in `environments/` directory as `.yml` files.
- Variable interpolation uses `{{variableName}}` syntax.
- Auth inheritance uses `auth: inherit` to inherit from parent folder/collection.

Example collection structure:
```
my-api/
├── opencollection.yml
├── environments/
│   ├── development.yml
│   ├── staging.yml
│   └── production.yml
├── auth/
│   ├── folder.yml
│   ├── login.yml
│   └── refresh-token.yml
├── users/
│   ├── folder.yml
│   ├── list-users.yml
│   ├── get-user.yml
│   ├── create-user.yml
│   └── update-user.yml
└── orders/
    ├── folder.yml
    ├── create-order.yml
    └── get-orders.yml
```

### 6.3 Environment File Format

Environments follow the OpenCollection environment format:

```yaml
variables:
  baseUrl: "http://localhost:3000"
  authToken: ""
  apiVersion: "v1"
```

Secret variables MUST use `{{process.env.VAR_NAME}}` references or be marked with `secret: true` to avoid committing sensitive values.

### 6.4 ApiFn Configuration File

```typescript
// apifn.config.ts
import { defineConfig } from "@apifn/cli";

export default defineConfig({
  // OpenAPI generation
  openapi: {
    info: {
      title: "My API",
      version: "1.0.0",
    },
    servers: [
      { url: "http://localhost:3000", description: "Development" },
    ],
  },

  // Router file for introspection
  router: "./src/router.ts",

  // Collection directory
  collection: "./api-collection",

  // Output directory for generated specs
  output: "./.apifn",

  // Environment defaults
  defaultEnvironment: "development",

  // Integrations
  watchfn: {
    url: "http://localhost:4000",
  },

  // Diff settings
  diff: {
    failOnBreaking: true,
    ignoreExtensions: true,
  },

  // Snippet targets
  snippets: ["curl", "fetch", "python-requests"],
});
```

### 6.5 Diff Report Format

```json
{
  "timestamp": "2026-03-05T22:00:00Z",
  "before": { "title": "My API", "version": "1.0.0" },
  "after": { "title": "My API", "version": "1.1.0" },
  "hasBreakingChanges": true,
  "summary": {
    "added": 2,
    "removed": 1,
    "modified": 3,
    "breaking": 1,
    "nonBreaking": 5
  },
  "breaking": [
    {
      "type": "removed",
      "breaking": true,
      "path": "paths./users/{id}.delete",
      "description": "Endpoint DELETE /users/{id} was removed"
    }
  ],
  "nonBreaking": [
    {
      "type": "added",
      "breaking": false,
      "path": "paths./orders.get",
      "description": "New endpoint GET /orders added"
    }
  ]
}
```

### 6.6 Run Report Format

```json
{
  "id": "run-2026-03-05-001",
  "collectionName": "My API",
  "environment": "development",
  "startedAt": "2026-03-05T22:00:00Z",
  "completedAt": "2026-03-05T22:00:05Z",
  "duration": 5000,
  "summary": {
    "total": 12,
    "passed": 10,
    "failed": 1,
    "skipped": 0,
    "errors": 1,
    "duration": 5000
  },
  "results": [
    {
      "name": "Get Users",
      "path": "users/list-users.yml",
      "method": "GET",
      "url": "http://localhost:3000/users",
      "status": "passed",
      "statusCode": 200,
      "duration": 45,
      "assertions": [
        { "name": "status is 200", "passed": true }
      ]
    }
  ]
}
```

---

## 7. Semantics

### 7.1 Route Introspection Rules

1. `introspectRouter()` MUST call `router.getRoutes()` to obtain all registered routes.
2. For each route, the introspector MUST extract `method`, `path`, and `meta`.
3. If `meta` contains a `SchemaDescriptor` (detected by the presence of known keys: `body`, `query`, `params`, `responses`, `summary`, `operationId`, `tags`), it MUST be parsed into the corresponding `IntrospectedRoute` fields.
4. Path parameters (`:paramName` syntax from `@superfunctions/http`) MUST be converted to OpenAPI `{paramName}` syntax.
5. Routes without schema descriptors MUST still be included in the output with empty parameters/responses (the endpoint exists even if undocumented).
6. If `include` or `exclude` options are provided, routes MUST be filtered by path prefix matching.

### 7.2 Schema Conversion Rules

1. Zod schemas MUST be converted to JSON Schema using `zod-to-json-schema` (or equivalent).
2. TypeBox schemas (`@sinclair/typebox`) MUST be used directly as they already produce JSON Schema.
3. Plain JSON Schema objects MUST be passed through unchanged.
4. The converter MUST detect the schema type by duck-typing:
   - Has `_def` property → Zod
   - Has `[Symbol.for('TypeBox.Kind')]` property → TypeBox
   - Otherwise → JSON Schema
5. `$ref` references MUST be used for schemas that appear in multiple locations (deduplication into `components/schemas`).

### 7.3 OpenAPI Generation Rules

1. Each unique combination of (method, path) MUST produce exactly one Operation Object.
2. Path parameters MUST be extracted from the path pattern and included as `in: "path"` parameters.
3. Query parameters from `SchemaDescriptor.query` MUST be included as `in: "query"` parameters.
4. If no responses are described, the generator MUST emit a default `200` response with `description: "Success"`.
5. Tags MUST be collected from all operations and emitted as a top-level `tags` array.
6. Schema names for `components/schemas` MUST be derived from the zod/TypeBox type name if available, or auto-generated from the operation context (e.g. `CreateUserBody`, `GetUserResponse`).

### 7.4 Collection Execution Semantics

1. Requests MUST be executed in the order specified by the `seq` field in each request YAML.
2. Variable interpolation (`{{varName}}`) MUST be resolved against: (a) run overrides, (b) environment variables, (c) collection variables, (d) `process.env`, in that precedence order.
3. Pre-request scripts MUST execute before the HTTP request is sent.
4. Post-response / test scripts MUST execute after the response is received.
5. If `bail: true`, execution MUST stop after the first failed request.
6. If `parallel: true`, requests with no sequential dependency MAY execute concurrently up to `concurrency` limit.
7. Timeouts MUST be enforced per-request; a timed-out request MUST report status `"error"`.

### 7.5 Diff Detection Rules

**Breaking changes** (MUST be detected):
- Endpoint removed
- Required request parameter added
- Request parameter type narrowed
- Response field removed
- Response type narrowed
- Status code removed from responses
- Security requirement added

**Non-breaking changes** (MUST be detected):
- Endpoint added
- Optional request parameter added
- Response field added
- Description/summary changed
- Example changed
- Deprecated flag added

### 7.6 Mock Server Behavior

1. The mock server MUST serve all paths defined in the OpenAPI spec.
2. In `"schema"` mode, response bodies MUST be generated deterministically from the JSON Schema (using sensible defaults: strings → `"string"`, numbers → `0`, booleans → `true`, etc.).
3. In `"examples"` mode, response bodies MUST use the first `example` or `examples` value if present, falling back to schema generation.
4. In `"random"` mode, response bodies MUST be valid against the schema but use randomized values.
5. If `validateRequests: true`, the mock server MUST validate incoming request bodies and parameters against their schemas and return `400` with validation errors for invalid requests.

---

## 8. Invariants

1. **OpenAPI validity**: Every document produced by `generateOpenAPI()` MUST validate against the official OpenAPI 3.1.0 JSON Schema with zero errors.
2. **OpenCollection validity**: Every collection produced by `openAPIToCollection()` or `routerToCollection()` MUST validate against the OpenCollection JSON Schema.
3. **Deterministic generation**: Given the same Router instance (same routes in the same order) and the same `OpenAPIGenerateOptions`, `generateOpenAPI()` MUST produce byte-identical output.
4. **Deterministic diff**: Given the same two OpenAPI documents, `diffOpenAPI()` MUST produce identical `DiffResult` objects.
5. **Idempotent write**: `writeCollection(readCollection(dir))` MUST produce files byte-identical to the originals (no reformatting).
6. **Round-trip preservation**: `parseOpenAPI(JSON.stringify(generateOpenAPI(routes, opts)))` MUST return a document structurally equal to the original output.
7. **Variable isolation**: Collection runs MUST NOT mutate the original `Environment` object; each run operates on a copy.
8. **Script sandbox**: Pre-request and test scripts MUST NOT have access to Node.js globals (`fs`, `process`, `require`) beyond explicitly injected APIs (`expect`, `res`, `req`, `env`).

---

## 9. Security

1. **No secrets in YAML**: Collection files MUST NOT contain literal secret values. Secrets MUST be referenced via `{{process.env.VAR_NAME}}` or environment variable references.
2. **Token scoping**: Test tokens minted via `mintTestToken()` MUST have a maximum TTL of 3600 seconds (1 hour). Callers MAY request shorter TTLs.
3. **CORS for explorer**: The `apifn serve` explorer MUST serve with CORS restricted to `localhost` by default. Custom origins MUST be opt-in via config.
4. **Script execution**: Collection test scripts MUST execute in a sandboxed context. They MUST NOT be able to access the filesystem, spawn processes, or make network requests outside the collection run's HTTP client.
5. **Mock server isolation**: The mock server MUST only serve routes defined in the spec. It MUST NOT proxy or forward requests to external servers.
6. **Auth config validation**: Auth configurations in collections MUST be validated before use. Invalid auth types MUST produce a clear error, not silently skip authentication.

---

## 10. Limits and Caps

| Limit | Value | Rationale |
|---|---|---|
| Max routes per router | 10,000 | Prevents OOM during introspection |
| Max schema depth | 20 levels | Prevents infinite recursion in nested schemas |
| Max OpenAPI document size | 50 MB | Prevents memory exhaustion during parsing |
| Max collection items | 5,000 | Prevents filesystem exhaustion |
| Max concurrent requests (parallel run) | 50 | Prevents connection exhaustion |
| Max request timeout | 300,000 ms (5 min) | Prevents hung runs |
| Max test token TTL | 3,600 s (1 hour) | Security boundary |
| Max environment variables | 1,000 | Prevents variable resolution overhead |
| Max script execution time | 10,000 ms (10 s) | Prevents hung scripts |
| Max response body capture | 10 MB | Prevents memory exhaustion in reports |
| Max request history (UI) | 500 entries | Browser memory management |
| Max diff entries | 10,000 | Prevents display overload |

---

## 11. Observability

### MUST log/emit:
- Collection run start/complete events (via logfn if configured)
- Individual request results in collection runs
- OpenAPI generation timing
- Diff computation results
- CLI command execution (command, args, duration, exit code)
- Mock server request/response pairs (in debug mode)
- Schema conversion errors (detailed, with path to problematic schema)

### MUST NOT log/emit:
- Secret values from environments or auth tokens
- Full request/response bodies in production-level logging (only in debug/trace)
- User filesystem paths outside the workspace
- Internal stack traces in non-error scenarios

---

## 12. Compatibility / Versioning Strategy

1. **OpenAPI**: Target 3.1.0 for generation. MUST accept 3.0.x documents for import (with automatic upconversion to 3.1.0).
2. **OpenCollection**: Target version 0.1+ as defined at [spec.opencollection.com](https://spec.opencollection.com/). MUST track the latest stable version of the OpenCollection specification.
3. **Bruno interop**: Collections generated by apifn MUST be openable in Bruno 3.0.0+. Collections created in Bruno MUST be readable by apifn.
4. **@superfunctions/http**: Compatible with `@superfunctions/http` 0.1.x. Route introspection depends on the `getRoutes()` method and `meta` field.
5. **zod**: Compatible with zod v3.x. Uses `zod-to-json-schema` for conversion.
6. **TypeBox**: Compatible with `@sinclair/typebox` v0.32+. TypeBox schemas are already JSON Schema.
7. **Node.js**: Requires Node.js 18+ (for native fetch).
8. **Python**: Requires Python 3.10+.

---

## 13. Undefined / Explicitly Deferred

Nothing is deferred. All features described in the intent document and this specification are in-scope for v1.0.0.
