# ApiFn — Requirements

## Table of Contents

### Core (CORE)
- CORE-001: Project scaffolding and TypeScript config
- CORE-002: Core types and interfaces
- CORE-003: Configuration file support

### Route Introspection (INTRO)
- INTRO-001: Extract routes from Router
- INTRO-002: Parse schema descriptors from meta
- INTRO-003: Path parameter conversion
- INTRO-004: Include/exclude filtering
- INTRO-005: Routes without descriptors

### Schema Conversion (SCHEMA)
- SCHEMA-001: Zod to JSON Schema conversion
- SCHEMA-002: TypeBox pass-through
- SCHEMA-003: Plain JSON Schema pass-through
- SCHEMA-004: Schema type detection
- SCHEMA-005: Schema deduplication via $ref

### OpenAPI Generation (OPENAPI)
- OPENAPI-001: Generate valid OpenAPI 3.1.0 document
- OPENAPI-002: Operation objects from routes
- OPENAPI-003: Parameter extraction
- OPENAPI-004: Request body generation
- OPENAPI-005: Response generation
- OPENAPI-006: Tag collection
- OPENAPI-007: Security scheme support
- OPENAPI-008: Server objects
- OPENAPI-009: Deterministic output
- OPENAPI-010: fromRouter convenience function
- OPENAPI-011: Import/parse existing OpenAPI
- OPENAPI-012: Validate OpenAPI document
- OPENAPI-013: 3.0 to 3.1 upconversion

### Collections (COLL)
- COLL-001: Read OpenCollection YAML
- COLL-002: Write OpenCollection YAML
- COLL-003: Validate against OpenCollection schema
- COLL-004: Generate collection from OpenAPI
- COLL-005: Generate collection from Router
- COLL-006: Bruno interoperability
- COLL-007: Folder structure and ordering

### Environment Management (ENV)
- ENV-001: Environment file read/write
- ENV-002: Variable interpolation
- ENV-003: Secret variable references
- ENV-004: Environment precedence
- ENV-005: Multiple environments per collection

### CLI (CLI)
- CLI-001: `apifn init` command
- CLI-002: `apifn generate` command
- CLI-003: `apifn export` command
- CLI-004: `apifn test` command
- CLI-005: `apifn diff` command
- CLI-006: `apifn serve` command
- CLI-007: `apifn mock` command
- CLI-008: `apifn snippet` command
- CLI-009: `apifn validate` command
- CLI-010: Global flags and config loading
- CLI-011: Exit codes for CI/CD

### Collection Runner (RUN)
- RUN-001: Sequential execution
- RUN-002: Parallel execution
- RUN-003: Variable resolution
- RUN-004: Pre-request scripts
- RUN-005: Test/post-response scripts
- RUN-006: Bail on failure
- RUN-007: Timeout enforcement
- RUN-008: Retry logic
- RUN-009: Reporter interface
- RUN-010: Run report generation
- RUN-011: Request/response capture

### Test Assertions (ASSERT)
- ASSERT-001: Status code assertions
- ASSERT-002: Response body assertions
- ASSERT-003: Header assertions
- ASSERT-004: Response time assertions
- ASSERT-005: JSON path assertions
- ASSERT-006: Schema validation assertions
- ASSERT-007: Custom assertion functions

### Breaking Change Detection (DIFF)
- DIFF-001: Detect endpoint removal
- DIFF-002: Detect required parameter addition
- DIFF-003: Detect type narrowing
- DIFF-004: Detect response field removal
- DIFF-005: Detect security requirement changes
- DIFF-006: Detect non-breaking additions
- DIFF-007: Summary generation
- DIFF-008: Deterministic results
- DIFF-009: JSON and human-readable output

### UI Components — React (UI-R)
- UI-R-001: ApiExplorer component
- UI-R-002: EndpointViewer component
- UI-R-003: SchemaViewer component
- UI-R-004: TryIt console component
- UI-R-005: RequestHistory component
- UI-R-006: ResponseDiff component
- UI-R-007: PerformanceOverlay component
- UI-R-008: Theme support (light/dark/auto)
- UI-R-009: Responsive layout

### UI Components — Svelte (UI-S)
- UI-S-001: ApiExplorer component
- UI-S-002: EndpointViewer component
- UI-S-003: SchemaViewer component
- UI-S-004: TryIt console component
- UI-S-005: RequestHistory component
- UI-S-006: ResponseDiff component
- UI-S-007: PerformanceOverlay component
- UI-S-008: Theme support (light/dark/auto)
- UI-S-009: Responsive layout

### CLI Serve (SERVE)
- SERVE-001: Local explorer server
- SERVE-002: Hot reload on spec changes
- SERVE-003: Proxy to target API
- SERVE-004: CORS configuration

### docsfn Plugin (DOCS)
- DOCS-001: DocsContentProvider implementation
- DOCS-002: API reference renderer (React)
- DOCS-003: API reference renderer (Svelte)
- DOCS-004: Auto-sidebar generation
- DOCS-005: Try-it integration in docs
- DOCS-006: Split by tag/path

### Code Snippets (SNIP)
- SNIP-001: curl generation
- SNIP-002: JavaScript fetch generation
- SNIP-003: axios generation
- SNIP-004: Python requests generation
- SNIP-005: Additional targets (Go, Ruby, PHP, C#, Java)
- SNIP-006: Auth injection in snippets
- SNIP-007: Variable substitution in snippets

### Mock Server (MOCK)
- MOCK-001: Serve all spec paths
- MOCK-002: Schema-based response generation
- MOCK-003: Example-based responses
- MOCK-004: Random mode
- MOCK-005: Request validation
- MOCK-006: Configurable delay
- MOCK-007: CORS support

### watchfn Integration (WATCH)
- WATCH-001: Fetch endpoint metrics
- WATCH-002: Display metrics in explorer
- WATCH-003: Display metrics in docsfn
- WATCH-004: apifn-specific middleware

### authfn Integration (AUTH)
- AUTH-001: Mint short-lived test tokens
- AUTH-002: Token injection in collection runs
- AUTH-003: Token TTL enforcement

### secfn Integration (SEC)
- SEC-001: Fetch rate limit headroom
- SEC-002: Display rate limits in explorer

### logfn Integration (LOG)
- LOG-001: logfn reporter for collection runs
- LOG-002: Structured logging throughout CLI

### testfn Integration (TESTFN)
- TESTFN-001: ApifnTestAdapter implementation
- TESTFN-002: Collection discovery
- TESTFN-003: Result mapping to testfn format

### Python (PY)
- PY-001: FastAPI introspection adapter
- PY-002: Flask introspection adapter
- PY-003: OpenAPI augmentation
- PY-004: Collection runner (Python)
- PY-005: Schema diff (Python)

### CI/CD Integration (CI)
- CI-001: GitHub Actions workflow
- CI-002: Non-zero exit on breaking changes
- CI-003: Report output formats
- CI-004: PR comment integration

---

## Requirement Details

---

### CORE-001: Project Scaffolding and TypeScript Config

- **ID**: CORE-001
- **Priority**: P0
- **Statement**: The project MUST be scaffolded as a multi-package structure under `apifn/` with TypeScript configuration, build tooling (tsup), and test tooling (vitest).
- **Rationale**: Consistent with superfunctions ecosystem conventions (docsfn, watchfn patterns).
- **Acceptance Criteria**:
  - [ ] `apifn/core/package.json` exists with name `@apifn/core`
  - [ ] `apifn/cli/package.json` exists with name `@apifn/cli`
  - [ ] `apifn/collections/package.json` exists with name `@apifn/collections`
  - [ ] `apifn/react/package.json` exists with name `@apifn/react`
  - [ ] `apifn/svelte/package.json` exists with name `@apifn/svelte`
  - [ ] `apifn/docsfn/package.json` exists with name `@apifn/docsfn`
  - [ ] `apifn/mock/package.json` exists with name `@apifn/mock`
  - [ ] `apifn/snippets/package.json` exists with name `@apifn/snippets`
  - [ ] `apifn/python/pyproject.toml` exists with name `apifn`
  - [ ] All TS packages have `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
  - [ ] `npm run build` succeeds from each package directory
  - [ ] `npm run test` succeeds (even if no tests yet) from each package directory
- **Test Vectors**: TV-CORE-001
- **Notes**: Package versions start at 0.0.1. Workspace entries added to root package.json.

---

### CORE-002: Core Types and Interfaces

- **ID**: CORE-002
- **Priority**: P0
- **Statement**: `@apifn/core` MUST export all type interfaces defined in SPEC.md Section 5.1 (IntrospectOptions, IntrospectedRoute, SchemaDescriptor, OpenAPIGenerateOptions, OpenAPIDocument, DiffResult, DiffEntry, ValidationError).
- **Rationale**: Types are the foundation that all other packages depend on.
- **Acceptance Criteria**:
  - [ ] All types from SPEC Section 5.1 are exported from `@apifn/core`
  - [ ] Types compile without errors
  - [ ] No runtime dependencies for types-only imports
- **Test Vectors**: TV-CORE-002
- **Notes**: Types must be importable via `@apifn/core` and `@apifn/core/types`.

---

### CORE-003: Configuration File Support

- **ID**: CORE-003
- **Priority**: P1
- **Statement**: ApiFn MUST support a `apifn.config.ts` (or `.js`, `.mjs`) configuration file as defined in SPEC Section 6.4.
- **Rationale**: Configuration centralizes settings for generation, testing, and serving.
- **Acceptance Criteria**:
  - [ ] `defineConfig()` helper exported from `@apifn/cli`
  - [ ] Config loaded from `apifn.config.ts` by default
  - [ ] Config path overridable via `--config` flag
  - [ ] Config validated with clear error messages for invalid fields
  - [ ] All config fields from SPEC Section 6.4 are supported
- **Test Vectors**: TV-CORE-003
- **Notes**: Uses `jiti` or `tsx` for TypeScript config loading (consistent with vitest, nuxt patterns).

---

### INTRO-001: Extract Routes from Router

- **ID**: INTRO-001
- **Priority**: P0
- **Statement**: `introspectRouter()` MUST call `router.getRoutes()` and return an `IntrospectedRoute[]` containing all registered routes.
- **Rationale**: This is the foundational capability — extracting API structure from code.
- **Acceptance Criteria**:
  - [ ] Given a router with N routes, `introspectRouter()` returns N `IntrospectedRoute` objects
  - [ ] Each result contains correct `method` and `path`
  - [ ] Results preserve route ordering from the router
- **Test Vectors**: TV-INTRO-001, TV-INTRO-002
- **Notes**: None.

---

### INTRO-002: Parse Schema Descriptors from Meta

- **ID**: INTRO-002
- **Priority**: P0
- **Statement**: `introspectRouter()` MUST parse `SchemaDescriptor` objects from `route.meta` when present, populating `summary`, `description`, `operationId`, `tags`, `deprecated`, `parameters`, `requestBody`, `responses`, and `security` on the `IntrospectedRoute`.
- **Rationale**: Schema descriptors are how developers annotate routes with API documentation.
- **Acceptance Criteria**:
  - [ ] Routes with `meta` containing SchemaDescriptor keys produce fully populated IntrospectedRoute objects
  - [ ] All SchemaDescriptor fields are mapped correctly
  - [ ] Zod schemas in meta are recognized and preserved for later conversion
  - [ ] TypeBox schemas in meta are recognized and preserved
  - [ ] Plain JSON Schema objects in meta are recognized and preserved
- **Test Vectors**: TV-INTRO-003, TV-INTRO-004
- **Notes**: Detection rules per SPEC Section 7.2.

---

### INTRO-003: Path Parameter Conversion

- **ID**: INTRO-003
- **Priority**: P0
- **Statement**: Path parameters using `@superfunctions/http` syntax (`:paramName`) MUST be converted to OpenAPI syntax (`{paramName}`) in the `IntrospectedRoute.path` field.
- **Rationale**: OpenAPI uses `{param}` syntax; the router uses `:param` syntax.
- **Acceptance Criteria**:
  - [ ] `/users/:id` becomes `/users/{id}`
  - [ ] `/orders/:orderId/items/:itemId` becomes `/orders/{orderId}/items/{itemId}`
  - [ ] Converted parameters appear in `IntrospectedRoute.parameters` as `in: "path"`
- **Test Vectors**: TV-INTRO-005
- **Notes**: None.

---

### INTRO-004: Include/Exclude Filtering

- **ID**: INTRO-004
- **Priority**: P1
- **Statement**: `introspectRouter()` MUST support `include` and `exclude` arrays in `IntrospectOptions` that filter routes by path prefix matching.
- **Rationale**: Large routers may contain internal/admin routes that should be excluded from public API docs.
- **Acceptance Criteria**:
  - [ ] `include: ["/api/v1"]` returns only routes whose path starts with `/api/v1`
  - [ ] `exclude: ["/internal"]` removes routes whose path starts with `/internal`
  - [ ] When both are provided, include is applied first, then exclude
  - [ ] Empty or undefined filters return all routes
- **Test Vectors**: TV-INTRO-006
- **Notes**: None.

---

### INTRO-005: Routes Without Descriptors

- **ID**: INTRO-005
- **Priority**: P0
- **Statement**: Routes without a `SchemaDescriptor` in `meta` MUST still be included in introspection results, with empty `parameters`, undefined `requestBody`, and a default `200` response.
- **Rationale**: An undocumented endpoint still exists and should appear in the API spec.
- **Acceptance Criteria**:
  - [ ] Route with `meta: undefined` produces a valid IntrospectedRoute
  - [ ] Route with `meta: {}` produces a valid IntrospectedRoute
  - [ ] Default response is `{ "200": { description: "Success" } }`
- **Test Vectors**: TV-INTRO-007
- **Notes**: None.

---

### SCHEMA-001: Zod to JSON Schema Conversion

- **ID**: SCHEMA-001
- **Priority**: P0
- **Statement**: Schema descriptors using zod schemas MUST be converted to JSON Schema (Draft 2020-12) for inclusion in OpenAPI documents.
- **Rationale**: Zod is the most popular TypeScript schema library; developers expect to use it.
- **Acceptance Criteria**:
  - [ ] `z.object({ name: z.string(), age: z.number() })` produces `{ type: "object", properties: { name: { type: "string" }, age: { type: "number" } }, required: ["name", "age"] }`
  - [ ] `z.string().optional()` produces a non-required field
  - [ ] `z.enum(["a", "b"])` produces `{ enum: ["a", "b"] }`
  - [ ] `z.array(z.string())` produces `{ type: "array", items: { type: "string" } }`
  - [ ] Nested objects are converted recursively
- **Test Vectors**: TV-SCHEMA-001, TV-SCHEMA-002
- **Notes**: Uses `zod-to-json-schema` library. Zod is a peer dependency, not a hard dependency.

---

### SCHEMA-002: TypeBox Pass-Through

- **ID**: SCHEMA-002
- **Priority**: P1
- **Statement**: Schema descriptors using TypeBox schemas MUST be included directly in OpenAPI documents as JSON Schema, since TypeBox schemas are already valid JSON Schema.
- **Rationale**: TypeBox produces JSON Schema natively; no conversion needed.
- **Acceptance Criteria**:
  - [ ] `Type.Object({ name: Type.String() })` is included as-is in the OpenAPI output
  - [ ] TypeBox-specific symbols are stripped from the output (only JSON Schema properties remain)
- **Test Vectors**: TV-SCHEMA-003
- **Notes**: `@sinclair/typebox` is a peer dependency.

---

### SCHEMA-003: Plain JSON Schema Pass-Through

- **ID**: SCHEMA-003
- **Priority**: P0
- **Statement**: Schema descriptors using plain JSON Schema objects MUST be included directly in OpenAPI documents without modification.
- **Rationale**: Some developers prefer raw JSON Schema; it must work without a schema library.
- **Acceptance Criteria**:
  - [ ] `{ type: "object", properties: { id: { type: "string" } } }` passes through unchanged
- **Test Vectors**: TV-SCHEMA-004
- **Notes**: None.

---

### SCHEMA-004: Schema Type Detection

- **ID**: SCHEMA-004
- **Priority**: P0
- **Statement**: The schema conversion system MUST automatically detect whether a schema is a zod schema, TypeBox schema, or plain JSON Schema using the duck-typing rules in SPEC Section 7.2.
- **Rationale**: Developers should not need to specify which schema library they're using.
- **Acceptance Criteria**:
  - [ ] Object with `_def` property detected as zod
  - [ ] Object with `Symbol.for('TypeBox.Kind')` detected as TypeBox
  - [ ] Plain objects detected as JSON Schema
  - [ ] Unknown types produce a descriptive error
- **Test Vectors**: TV-SCHEMA-005
- **Notes**: None.

---

### SCHEMA-005: Schema Deduplication via $ref

- **ID**: SCHEMA-005
- **Priority**: P1
- **Statement**: When the same schema object (by reference equality or structural equality for named schemas) appears in multiple locations, the generator MUST extract it into `components/schemas` and use `$ref` references.
- **Rationale**: Prevents bloated specs with duplicated schemas.
- **Acceptance Criteria**:
  - [ ] Same zod schema used in two routes appears once in `components/schemas` with `$ref` in both operations
  - [ ] Schema name derived from type name or operation context
  - [ ] Unnamed schemas with identical structure are still deduplicated
- **Test Vectors**: TV-SCHEMA-006
- **Notes**: None.

---

### OPENAPI-001: Generate Valid OpenAPI 3.1.0 Document

- **ID**: OPENAPI-001
- **Priority**: P0
- **Statement**: `generateOpenAPI()` MUST produce a document with `openapi: "3.1.0"` that validates against the official OpenAPI 3.1.0 JSON Schema with zero errors.
- **Rationale**: Core invariant — generated specs must be standards-compliant.
- **Acceptance Criteria**:
  - [ ] Output has `openapi: "3.1.0"`
  - [ ] Output validates against OpenAPI 3.1.0 JSON Schema
  - [ ] Output contains `info`, `paths` at minimum
  - [ ] All JSON Schema within components conforms to Draft 2020-12
- **Test Vectors**: TV-OPENAPI-001
- **Notes**: Use `@readme/openapi-parser` or `swagger-parser` for validation in tests.

---

### OPENAPI-002: Operation Objects from Routes

- **ID**: OPENAPI-002
- **Priority**: P0
- **Statement**: Each unique (method, path) pair from introspected routes MUST produce exactly one Operation Object in the `paths` section.
- **Rationale**: 1:1 mapping from routes to operations.
- **Acceptance Criteria**:
  - [ ] GET /users → `paths./users.get`
  - [ ] POST /users → `paths./users.post`
  - [ ] GET /users/{id} → `paths./users/{id}.get`
  - [ ] `operationId` set from descriptor or auto-generated
- **Test Vectors**: TV-OPENAPI-002
- **Notes**: None.

---

### OPENAPI-003: Parameter Extraction

- **ID**: OPENAPI-003
- **Priority**: P0
- **Statement**: Path parameters MUST be extracted from the route path. Query, header parameters MUST be extracted from `SchemaDescriptor.query` and `SchemaDescriptor.headers`.
- **Rationale**: Accurate parameter documentation is essential for API consumers.
- **Acceptance Criteria**:
  - [ ] Path params from `/users/{id}` appear as `in: "path", required: true`
  - [ ] Query params from descriptor appear as `in: "query"` with correct schema
  - [ ] Header params from descriptor appear as `in: "header"`
  - [ ] Parameters have `name`, `in`, `required`, `schema` fields
- **Test Vectors**: TV-OPENAPI-003
- **Notes**: None.

---

### OPENAPI-004: Request Body Generation

- **ID**: OPENAPI-004
- **Priority**: P0
- **Statement**: If `SchemaDescriptor.body` is present, the operation MUST include a `requestBody` with `content: { "application/json": { schema } }`.
- **Rationale**: Request body documentation is essential for POST/PUT/PATCH endpoints.
- **Acceptance Criteria**:
  - [ ] Body schema appears under `requestBody.content.application/json.schema`
  - [ ] `requestBody.required` is true by default
  - [ ] Body schema is properly converted from zod/TypeBox/JSON Schema
- **Test Vectors**: TV-OPENAPI-004
- **Notes**: Future: support `multipart/form-data` and other content types.

---

### OPENAPI-005: Response Generation

- **ID**: OPENAPI-005
- **Priority**: P0
- **Statement**: `SchemaDescriptor.responses` MUST be mapped to OpenAPI Response Objects. If no responses are described, a default `200 Success` response MUST be generated.
- **Rationale**: Every operation needs at least one response documented.
- **Acceptance Criteria**:
  - [ ] Custom responses appear under their status codes with description and schema
  - [ ] Missing responses produce `{ "200": { description: "Success" } }`
  - [ ] Response headers are included when specified
- **Test Vectors**: TV-OPENAPI-005
- **Notes**: None.

---

### OPENAPI-006: Tag Collection

- **ID**: OPENAPI-006
- **Priority**: P1
- **Statement**: Tags from all operations MUST be collected and emitted as a top-level `tags` array with unique entries.
- **Rationale**: Tags enable grouping in API explorers and documentation.
- **Acceptance Criteria**:
  - [ ] Tags from all operations are collected into `tags` array
  - [ ] Duplicate tags are deduplicated
  - [ ] Tags are sorted alphabetically
- **Test Vectors**: TV-OPENAPI-006
- **Notes**: None.

---

### OPENAPI-007: Security Scheme Support

- **ID**: OPENAPI-007
- **Priority**: P1
- **Statement**: Security schemes provided in `OpenAPIGenerateOptions.securitySchemes` MUST be emitted in `components/securitySchemes`. Per-operation security from `SchemaDescriptor.security` MUST be emitted on the operation.
- **Rationale**: API authentication documentation is critical for consumers.
- **Acceptance Criteria**:
  - [ ] Global security schemes appear in `components/securitySchemes`
  - [ ] Per-operation security appears on the operation object
  - [ ] Supported types: `apiKey`, `http` (bearer/basic), `oauth2`, `openIdConnect`
- **Test Vectors**: TV-OPENAPI-007
- **Notes**: None.

---

### OPENAPI-008: Server Objects

- **ID**: OPENAPI-008
- **Priority**: P1
- **Statement**: Server objects from `OpenAPIGenerateOptions.servers` MUST be emitted in the `servers` array.
- **Rationale**: Consumers need to know where to send requests.
- **Acceptance Criteria**:
  - [ ] Servers appear in the output with `url` and `description`
  - [ ] If no servers provided, output contains no `servers` field (valid per OpenAPI)
- **Test Vectors**: TV-OPENAPI-008
- **Notes**: None.

---

### OPENAPI-009: Deterministic Output

- **ID**: OPENAPI-009
- **Priority**: P0
- **Statement**: Given the same Router instance and the same options, `generateOpenAPI()` MUST produce byte-identical output on every invocation.
- **Rationale**: Determinism enables diffing, snapshot testing, and CI validation.
- **Acceptance Criteria**:
  - [ ] Two consecutive calls with the same inputs produce identical JSON
  - [ ] Object keys are sorted deterministically
  - [ ] Array ordering is stable
- **Test Vectors**: TV-OPENAPI-009
- **Notes**: Use sorted JSON serialization internally.

---

### OPENAPI-010: fromRouter Convenience Function

- **ID**: OPENAPI-010
- **Priority**: P1
- **Statement**: `fromRouter()` MUST introspect a router and generate an OpenAPI document in a single call, combining `introspectRouter()` and `generateOpenAPI()`.
- **Rationale**: Convenience for the common case.
- **Acceptance Criteria**:
  - [ ] `fromRouter(router, opts)` produces the same result as `generateOpenAPI(introspectRouter(router), opts)`
  - [ ] Accepts both `IntrospectOptions` and `OpenAPIGenerateOptions` fields
- **Test Vectors**: TV-OPENAPI-010
- **Notes**: None.

---

### OPENAPI-011: Import/Parse Existing OpenAPI

- **ID**: OPENAPI-011
- **Priority**: P1
- **Statement**: `parseOpenAPI()` MUST accept a JSON string, YAML string, or JavaScript object and return a normalized `OpenAPIDocument`.
- **Rationale**: Needed for diff, import, and working with existing specs.
- **Acceptance Criteria**:
  - [ ] JSON string input → parsed document
  - [ ] YAML string input → parsed document
  - [ ] JavaScript object input → normalized document
  - [ ] Invalid input throws descriptive error
- **Test Vectors**: TV-OPENAPI-011
- **Notes**: Uses `yaml` package for YAML parsing.

---

### OPENAPI-012: Validate OpenAPI Document

- **ID**: OPENAPI-012
- **Priority**: P1
- **Statement**: `validateOpenAPI()` MUST validate a document against the OpenAPI 3.1 JSON Schema and return an array of `ValidationError` objects (empty if valid).
- **Rationale**: Users need to verify their specs are valid.
- **Acceptance Criteria**:
  - [ ] Valid document → empty array
  - [ ] Invalid document → array with error paths and messages
- **Test Vectors**: TV-OPENAPI-012
- **Notes**: None.

---

### OPENAPI-013: 3.0 to 3.1 Upconversion

- **ID**: OPENAPI-013
- **Priority**: P2
- **Statement**: `parseOpenAPI()` MUST accept OpenAPI 3.0.x documents and upconvert them to 3.1.0 format.
- **Rationale**: Many existing specs are 3.0; import must handle them.
- **Acceptance Criteria**:
  - [ ] 3.0 `nullable: true` converted to `type: ["string", "null"]`
  - [ ] 3.0 `example` preserved
  - [ ] `openapi` field updated to `"3.1.0"`
  - [ ] Output validates as 3.1.0
- **Test Vectors**: TV-OPENAPI-013
- **Notes**: Best-effort conversion; edge cases documented.

---

### COLL-001: Read OpenCollection YAML

- **ID**: COLL-001
- **Priority**: P0
- **Statement**: `readCollection()` MUST read a directory containing `opencollection.yml` and return a `Collection` object with all requests, folders, and environments parsed.
- **Rationale**: Reading is the fundamental collection operation.
- **Acceptance Criteria**:
  - [ ] Reads `opencollection.yml` for collection info
  - [ ] Reads all `.yml` request files recursively
  - [ ] Reads `folder.yml` for folder metadata
  - [ ] Reads `environments/*.yml` for environments
  - [ ] Respects `seq` ordering
  - [ ] Missing `opencollection.yml` throws descriptive error
- **Test Vectors**: TV-COLL-001
- **Notes**: None.

---

### COLL-002: Write OpenCollection YAML

- **ID**: COLL-002
- **Priority**: P0
- **Statement**: `writeCollection()` MUST write a `Collection` object back to disk as OpenCollection YAML files.
- **Rationale**: Enables programmatic collection generation and modification.
- **Acceptance Criteria**:
  - [ ] Creates `opencollection.yml` at root
  - [ ] Creates request `.yml` files in correct directories
  - [ ] Creates `folder.yml` for folders with metadata
  - [ ] Creates `environments/*.yml` files
  - [ ] `readCollection(writeCollection(collection))` produces structurally equal result
- **Test Vectors**: TV-COLL-002
- **Notes**: Idempotent write invariant per SPEC Section 8.

---

### COLL-003: Validate Against OpenCollection Schema

- **ID**: COLL-003
- **Priority**: P1
- **Statement**: `validateCollection()` MUST validate a collection against the OpenCollection JSON Schema and return validation errors.
- **Rationale**: Ensures collections are spec-compliant.
- **Acceptance Criteria**:
  - [ ] Valid collection → empty errors
  - [ ] Invalid request (missing http.method) → error with path
  - [ ] Invalid environment (missing variables) → error with path
- **Test Vectors**: TV-COLL-003
- **Notes**: Uses OpenCollection JSON Schema from [schema.opencollection.com](https://schema.opencollection.com/).

---

### COLL-004: Generate Collection from OpenAPI

- **ID**: COLL-004
- **Priority**: P0
- **Statement**: `openAPIToCollection()` MUST generate an OpenCollection from an OpenAPI document, creating one request per operation.
- **Rationale**: Enables bootstrapping collections from existing specs.
- **Acceptance Criteria**:
  - [ ] Each operation produces one `.yml` request file
  - [ ] Requests grouped by tag or path prefix as configured
  - [ ] Request URL uses `{{baseUrl}}` variable
  - [ ] Request body populated from examples or schema defaults
  - [ ] Path parameters use `{{paramName}}` variables
  - [ ] Environment created with `baseUrl` from spec servers
- **Test Vectors**: TV-COLL-004
- **Notes**: None.

---

### COLL-005: Generate Collection from Router

- **ID**: COLL-005
- **Priority**: P0
- **Statement**: `routerToCollection()` MUST combine router introspection and collection generation in one call.
- **Rationale**: Convenience for the common use case.
- **Acceptance Criteria**:
  - [ ] Produces same result as `openAPIToCollection(fromRouter(router, opts))`
  - [ ] Accepts both `IntrospectOptions` and collection generation options
- **Test Vectors**: TV-COLL-005
- **Notes**: None.

---

### COLL-006: Bruno Interoperability

- **ID**: COLL-006
- **Priority**: P0
- **Statement**: Collections generated by apifn MUST be openable in Bruno 3.0.0+. Collections created in Bruno 3.0.0+ (YAML format) MUST be readable by apifn.
- **Rationale**: OpenCollection is Bruno's format; interop is essential for adoption.
- **Acceptance Criteria**:
  - [ ] apifn-generated collection opens in Bruno without errors
  - [ ] Bruno-generated YAML collection readable by apifn's `readCollection()`
  - [ ] All standard OpenCollection fields round-trip correctly
- **Test Vectors**: TV-COLL-006
- **Notes**: Tested manually against Bruno 3.0.0 beta; automated tests use fixture files.

---

### COLL-007: Folder Structure and Ordering

- **ID**: COLL-007
- **Priority**: P1
- **Statement**: Collections MUST preserve folder hierarchy and request ordering via `seq` fields.
- **Rationale**: Execution order matters for collection runs.
- **Acceptance Criteria**:
  - [ ] Folders appear as directories on disk
  - [ ] `seq` field controls ordering within a folder
  - [ ] Nested folders are supported to arbitrary depth
- **Test Vectors**: TV-COLL-007
- **Notes**: None.

---

### ENV-001: Environment File Read/Write

- **ID**: ENV-001
- **Priority**: P0
- **Statement**: ApiFn MUST read and write environment files in the `environments/` directory using OpenCollection environment YAML format.
- **Rationale**: Environments are essential for targeting different servers.
- **Acceptance Criteria**:
  - [ ] Read `environments/development.yml` → `{ name: "development", variables: { ... } }`
  - [ ] Write creates valid YAML environment files
  - [ ] Multiple environments per collection supported
- **Test Vectors**: TV-ENV-001
- **Notes**: None.

---

### ENV-002: Variable Interpolation

- **ID**: ENV-002
- **Priority**: P0
- **Statement**: `{{variableName}}` syntax in request URLs, headers, body, and parameters MUST be resolved against the active environment's variables.
- **Rationale**: Variable substitution is core to collection portability.
- **Acceptance Criteria**:
  - [ ] `{{baseUrl}}/users` with `baseUrl: "http://localhost:3000"` → `http://localhost:3000/users`
  - [ ] Nested variables: `{{baseUrl}}/{{apiVersion}}/users` resolves both
  - [ ] Unresolved variables produce a warning and remain as `{{varName}}`
  - [ ] Variables in headers, body, query params all resolve
- **Test Vectors**: TV-ENV-002
- **Notes**: None.

---

### ENV-003: Secret Variable References

- **ID**: ENV-003
- **Priority**: P1
- **Statement**: Secret values MUST be referenced via `{{process.env.VAR_NAME}}` syntax to avoid committing secrets to version control.
- **Rationale**: Security requirement — no secrets in YAML files.
- **Acceptance Criteria**:
  - [ ] `{{process.env.API_KEY}}` resolves to `process.env.API_KEY` at runtime
  - [ ] Missing env var produces a clear error message
  - [ ] `.env` file support (via dotenv)
- **Test Vectors**: TV-ENV-003
- **Notes**: None.

---

### ENV-004: Environment Precedence

- **ID**: ENV-004
- **Priority**: P1
- **Statement**: Variable resolution MUST follow precedence: (1) run overrides → (2) environment variables → (3) collection variables → (4) `process.env`.
- **Rationale**: Clear precedence prevents confusion about which value is used.
- **Acceptance Criteria**:
  - [ ] Override wins over environment variable
  - [ ] Environment variable wins over collection variable
  - [ ] Collection variable wins over process.env
  - [ ] Precedence documented in CLI help
- **Test Vectors**: TV-ENV-004
- **Notes**: None.

---

### ENV-005: Multiple Environments Per Collection

- **ID**: ENV-005
- **Priority**: P1
- **Statement**: A collection MUST support multiple named environments (e.g., development, staging, production).
- **Rationale**: Developers need to target different environments.
- **Acceptance Criteria**:
  - [ ] `apifn test --env staging` uses `environments/staging.yml`
  - [ ] `apifn serve --env production` uses production variables
  - [ ] Environment list discoverable via `readCollection().environments`
- **Test Vectors**: TV-ENV-005
- **Notes**: None.

---

### CLI-001: `apifn init` Command

- **ID**: CLI-001
- **Priority**: P1
- **Statement**: `apifn init [dir]` MUST scaffold a new OpenCollection directory with `opencollection.yml`, a default environment, and a sample request.
- **Rationale**: Reduces friction for getting started.
- **Acceptance Criteria**:
  - [ ] Creates `opencollection.yml` with collection info
  - [ ] Creates `environments/development.yml` with `baseUrl` variable
  - [ ] Creates a sample request file
  - [ ] Interactive prompts for collection name and base URL
  - [ ] `--yes` flag for non-interactive mode
- **Test Vectors**: TV-CLI-001
- **Notes**: None.

---

### CLI-002: `apifn generate` Command

- **ID**: CLI-002
- **Priority**: P0
- **Statement**: `apifn generate [router-path]` MUST load a router from the specified TypeScript file, introspect it, and generate an OpenAPI document.
- **Rationale**: Core developer workflow — generate spec from code.
- **Acceptance Criteria**:
  - [ ] Loads router from TS file using dynamic import (after tsx/jiti compilation)
  - [ ] Generates OpenAPI document
  - [ ] Writes to output path (default: `.apifn/openapi.yml`)
  - [ ] Uses config from `apifn.config.ts` if present
  - [ ] Prints summary (number of routes, output path)
- **Test Vectors**: TV-CLI-002
- **Notes**: Router file must export a `Router` instance as default or named export.

---

### CLI-003: `apifn export` Command

- **ID**: CLI-003
- **Priority**: P1
- **Statement**: `apifn export [format] [output]` MUST export the generated OpenAPI document as YAML or JSON.
- **Rationale**: Enables interop with external tools (Postman, Scalar, etc.).
- **Acceptance Criteria**:
  - [ ] `apifn export yaml ./api.yml` writes YAML
  - [ ] `apifn export json ./api.json` writes JSON
  - [ ] Default format is YAML
  - [ ] Stdout output when no output path specified
- **Test Vectors**: TV-CLI-003
- **Notes**: None.

---

### CLI-004: `apifn test` Command

- **ID**: CLI-004
- **Priority**: P0
- **Statement**: `apifn test [collection-dir]` MUST execute a collection run and report results.
- **Rationale**: Collection testing is a primary use case.
- **Acceptance Criteria**:
  - [ ] Runs all requests in the collection
  - [ ] Uses `--env` flag to select environment
  - [ ] Prints pass/fail summary
  - [ ] Exit code 0 on all pass, 1 on any failure
  - [ ] `--bail` flag stops on first failure
  - [ ] `--parallel` flag enables concurrent execution
  - [ ] JSON report output with `--reporter json`
- **Test Vectors**: TV-CLI-004
- **Notes**: None.

---

### CLI-005: `apifn diff` Command

- **ID**: CLI-005
- **Priority**: P1
- **Statement**: `apifn diff <before> <after>` MUST compare two OpenAPI documents and report breaking/non-breaking changes.
- **Rationale**: CI/CD workflow for preventing breaking API changes.
- **Acceptance Criteria**:
  - [ ] Accepts file paths or URLs for before/after specs
  - [ ] Prints human-readable diff report
  - [ ] `--format json` outputs machine-readable JSON
  - [ ] Exit code 0 if no breaking changes, 1 if breaking changes exist
  - [ ] `--fail-on-breaking` flag (default: true)
- **Test Vectors**: TV-CLI-005
- **Notes**: None.

---

### CLI-006: `apifn serve` Command

- **ID**: CLI-006
- **Priority**: P1
- **Statement**: `apifn serve [router-or-spec]` MUST start a local web server hosting the interactive API explorer.
- **Rationale**: Local API exploration during development.
- **Acceptance Criteria**:
  - [ ] Serves API explorer on `http://localhost:4100` (default port)
  - [ ] Accepts router file path or OpenAPI spec path
  - [ ] Hot-reloads when router/spec file changes
  - [ ] `--port` flag to change port
  - [ ] `--open` flag to open browser automatically
- **Test Vectors**: TV-CLI-006
- **Notes**: None.

---

### CLI-007: `apifn mock` Command

- **ID**: CLI-007
- **Priority**: P2
- **Statement**: `apifn mock [spec]` MUST start a mock server that serves synthetic responses matching the OpenAPI spec.
- **Rationale**: Frontend development without a backend.
- **Acceptance Criteria**:
  - [ ] Serves all paths from the spec
  - [ ] `--mode schema|examples|random` selects response generation mode
  - [ ] `--port` flag to change port (default: 4010)
  - [ ] `--validate-requests` flag enables request validation
  - [ ] `--delay <ms>` flag adds response delay
- **Test Vectors**: TV-CLI-007
- **Notes**: None.

---

### CLI-008: `apifn snippet` Command

- **ID**: CLI-008
- **Priority**: P2
- **Statement**: `apifn snippet <spec> <path> [--target <target>]` MUST generate a code snippet for the specified endpoint.
- **Rationale**: Quick code generation for API consumers.
- **Acceptance Criteria**:
  - [ ] Generates snippet for the specified endpoint path
  - [ ] `--target curl` generates curl command
  - [ ] `--target fetch` generates JavaScript fetch code
  - [ ] Prints to stdout
  - [ ] `--all` flag generates snippets for all endpoints
- **Test Vectors**: TV-CLI-008
- **Notes**: None.

---

### CLI-009: `apifn validate` Command

- **ID**: CLI-009
- **Priority**: P1
- **Statement**: `apifn validate <spec>` MUST validate an OpenAPI document and report errors.
- **Rationale**: Spec validation without generation.
- **Acceptance Criteria**:
  - [ ] Accepts JSON or YAML file path
  - [ ] Prints validation errors with paths
  - [ ] Exit code 0 if valid, 1 if invalid
- **Test Vectors**: TV-CLI-009
- **Notes**: None.

---

### CLI-010: Global Flags and Config Loading

- **ID**: CLI-010
- **Priority**: P1
- **Statement**: All CLI commands MUST support global flags (`--config`, `--verbose`, `--quiet`, `--no-color`) and load configuration from `apifn.config.ts` by default.
- **Rationale**: Consistent CLI experience.
- **Acceptance Criteria**:
  - [ ] `--config` overrides default config path
  - [ ] `--verbose` increases output detail
  - [ ] `--quiet` suppresses non-error output
  - [ ] `--no-color` disables ANSI colors
  - [ ] Config values serve as defaults for command-specific flags
- **Test Vectors**: TV-CLI-010
- **Notes**: None.

---

### CLI-011: Exit Codes for CI/CD

- **ID**: CLI-011
- **Priority**: P0
- **Statement**: CLI commands MUST exit with code 0 on success and non-zero on failure, with specific codes for different failure types.
- **Rationale**: CI/CD pipelines depend on exit codes.
- **Acceptance Criteria**:
  - [ ] `apifn test` → 0 on pass, 1 on test failure, 2 on error
  - [ ] `apifn diff` → 0 on no breaking changes, 1 on breaking changes, 2 on error
  - [ ] `apifn validate` → 0 on valid, 1 on invalid, 2 on error
  - [ ] Other commands → 0 on success, 1 on error
- **Test Vectors**: TV-CLI-011
- **Notes**: None.

---

### RUN-001: Sequential Execution

- **ID**: RUN-001
- **Priority**: P0
- **Statement**: By default, `runCollection()` MUST execute requests sequentially in `seq` order.
- **Rationale**: Sequential is the safe default; later requests may depend on earlier ones.
- **Acceptance Criteria**:
  - [ ] Requests execute one at a time
  - [ ] Order matches `seq` field in YAML
  - [ ] Folders execute in seq order, with child requests before next folder
- **Test Vectors**: TV-RUN-001
- **Notes**: None.

---

### RUN-002: Parallel Execution

- **ID**: RUN-002
- **Priority**: P1
- **Statement**: When `parallel: true`, `runCollection()` MUST execute requests concurrently up to `concurrency` limit.
- **Rationale**: Faster collection runs for independent requests.
- **Acceptance Criteria**:
  - [ ] Requests execute concurrently
  - [ ] `concurrency` limits simultaneous requests (default: 5)
  - [ ] Results are returned in completion order but report preserves original order
- **Test Vectors**: TV-RUN-002
- **Notes**: None.

---

### RUN-003: Variable Resolution

- **ID**: RUN-003
- **Priority**: P0
- **Statement**: Variable interpolation during collection runs MUST follow the precedence rules in ENV-004.
- **Rationale**: Consistent variable behavior.
- **Acceptance Criteria**:
  - [ ] All `{{varName}}` in URL, headers, body, params are resolved
  - [ ] Precedence: overrides > environment > collection > process.env
  - [ ] Unresolved variables produce warnings in the run report
- **Test Vectors**: TV-RUN-003
- **Notes**: None.

---

### RUN-004: Pre-Request Scripts

- **ID**: RUN-004
- **Priority**: P1
- **Statement**: Pre-request scripts in OpenCollection YAML MUST execute before the HTTP request is sent, with access to request data and environment variables.
- **Rationale**: Enables dynamic request construction (e.g., signing, token refresh).
- **Acceptance Criteria**:
  - [ ] Script executes before request
  - [ ] Script can modify request headers, body, URL via injected `req` object
  - [ ] Script has access to `env` for reading/writing variables
  - [ ] Script errors abort the request with status "error"
- **Test Vectors**: TV-RUN-004
- **Notes**: Scripts execute in a sandboxed context per SPEC Section 9.4.

---

### RUN-005: Test/Post-Response Scripts

- **ID**: RUN-005
- **Priority**: P0
- **Statement**: Test scripts in OpenCollection YAML MUST execute after the HTTP response is received, with access to `res` (response), `req` (request), and assertion helpers.
- **Rationale**: Core testing functionality.
- **Acceptance Criteria**:
  - [ ] Script executes after response
  - [ ] `res.status`, `res.body`, `res.headers` available
  - [ ] `expect` / assertion API available
  - [ ] `test("name", fn)` syntax supported (OpenCollection standard)
  - [ ] Assertion failures recorded in run report
- **Test Vectors**: TV-RUN-005
- **Notes**: None.

---

### RUN-006: Bail on Failure

- **ID**: RUN-006
- **Priority**: P1
- **Statement**: When `bail: true`, collection execution MUST stop after the first failed request.
- **Rationale**: Fast feedback when debugging.
- **Acceptance Criteria**:
  - [ ] Remaining requests marked as "skipped"
  - [ ] Summary reflects actual executed + skipped counts
- **Test Vectors**: TV-RUN-006
- **Notes**: None.

---

### RUN-007: Timeout Enforcement

- **ID**: RUN-007
- **Priority**: P0
- **Statement**: Each request MUST be subject to a timeout (default 30,000ms, configurable). Timed-out requests MUST report status `"error"`.
- **Rationale**: Prevents hung runs.
- **Acceptance Criteria**:
  - [ ] Request exceeding timeout is aborted
  - [ ] Result status is "error" with message "Request timed out after Xms"
  - [ ] Configurable via `RunOptions.timeout` and per-request `settings.timeout`
- **Test Vectors**: TV-RUN-007
- **Notes**: Per-request timeout overrides global timeout.

---

### RUN-008: Retry Logic

- **ID**: RUN-008
- **Priority**: P2
- **Statement**: When `retries > 0`, failed requests MUST be retried up to the specified count before being marked as failed.
- **Rationale**: Handles flaky network conditions.
- **Acceptance Criteria**:
  - [ ] Request retried up to N times
  - [ ] Final status reflects last attempt
  - [ ] All attempts recorded in the result
- **Test Vectors**: TV-RUN-008
- **Notes**: None.

---

### RUN-009: Reporter Interface

- **ID**: RUN-009
- **Priority**: P1
- **Statement**: `runCollection()` MUST accept a `RunReporter` that receives callbacks for start, request start, request complete, and run complete events.
- **Rationale**: Enables custom output formats and integrations.
- **Acceptance Criteria**:
  - [ ] `onStart` called once at beginning
  - [ ] `onRequestStart` called before each request
  - [ ] `onRequestComplete` called after each request
  - [ ] `onComplete` called once at end with full report
  - [ ] Built-in reporters: console (default), JSON, silent
- **Test Vectors**: TV-RUN-009
- **Notes**: None.

---

### RUN-010: Run Report Generation

- **ID**: RUN-010
- **Priority**: P0
- **Statement**: `runCollection()` MUST return a `RunReport` object matching the format in SPEC Section 6.6.
- **Rationale**: Machine-readable results for CI/CD integration.
- **Acceptance Criteria**:
  - [ ] Report contains `id`, `collectionName`, `environment`, timing, summary, results
  - [ ] Summary has `total`, `passed`, `failed`, `skipped`, `errors`, `duration`
  - [ ] Each result has `name`, `path`, `method`, `url`, `status`, `duration`, `assertions`
- **Test Vectors**: TV-RUN-010
- **Notes**: None.

---

### RUN-011: Request/Response Capture

- **ID**: RUN-011
- **Priority**: P1
- **Statement**: Each `RequestResult` MUST capture the sent request (method, URL, headers, body) and received response (status, headers, body, size).
- **Rationale**: Debugging failed requests requires full context.
- **Acceptance Criteria**:
  - [ ] Request details captured
  - [ ] Response details captured (body truncated at 10MB per SPEC limits)
  - [ ] Sensitive headers (Authorization) can be redacted via config
- **Test Vectors**: TV-RUN-011
- **Notes**: None.

---

### ASSERT-001: Status Code Assertions

- **ID**: ASSERT-001
- **Priority**: P0
- **Statement**: Test scripts MUST be able to assert on HTTP status codes.
- **Rationale**: Most basic API test assertion.
- **Acceptance Criteria**:
  - [ ] `expect(res.status).to.equal(200)` passes for 200 response
  - [ ] `expect(res.status).to.equal(200)` fails for 404 response
- **Test Vectors**: TV-ASSERT-001
- **Notes**: None.

---

### ASSERT-002: Response Body Assertions

- **ID**: ASSERT-002
- **Priority**: P0
- **Statement**: Test scripts MUST be able to assert on response body content (JSON, text).
- **Rationale**: Validate API response data.
- **Acceptance Criteria**:
  - [ ] `expect(res.body.name).to.equal("John")` for JSON responses
  - [ ] `expect(res.body).to.have.property("id")` for property checks
  - [ ] `expect(res.body.items).to.have.length(5)` for array checks
- **Test Vectors**: TV-ASSERT-002
- **Notes**: None.

---

### ASSERT-003: Header Assertions

- **ID**: ASSERT-003
- **Priority**: P1
- **Statement**: Test scripts MUST be able to assert on response headers.
- **Acceptance Criteria**:
  - [ ] `expect(res.headers["content-type"]).to.include("application/json")`
- **Test Vectors**: TV-ASSERT-003
- **Notes**: None.

---

### ASSERT-004: Response Time Assertions

- **ID**: ASSERT-004
- **Priority**: P1
- **Statement**: Test scripts MUST be able to assert on response duration.
- **Acceptance Criteria**:
  - [ ] `expect(res.responseTime).to.be.below(500)` passes for fast responses
- **Test Vectors**: TV-ASSERT-004
- **Notes**: None.

---

### ASSERT-005: JSON Path Assertions

- **ID**: ASSERT-005
- **Priority**: P2
- **Statement**: Test scripts SHOULD support JSON path expressions for deep value assertions.
- **Acceptance Criteria**:
  - [ ] `expect(res.body).to.have.jsonPath("$.users[0].name", "Alice")`
- **Test Vectors**: TV-ASSERT-005
- **Notes**: Uses a JSONPath library.

---

### ASSERT-006: Schema Validation Assertions

- **ID**: ASSERT-006
- **Priority**: P1
- **Statement**: Test scripts MUST be able to validate response bodies against a JSON Schema or OpenAPI response schema.
- **Acceptance Criteria**:
  - [ ] `expect(res.body).to.matchSchema(schema)` validates against JSON Schema
  - [ ] Validation errors included in assertion result
- **Test Vectors**: TV-ASSERT-006
- **Notes**: None.

---

### ASSERT-007: Custom Assertion Functions

- **ID**: ASSERT-007
- **Priority**: P2
- **Statement**: Test scripts SHOULD support custom JavaScript assertion functions.
- **Acceptance Criteria**:
  - [ ] Custom function receives `res` and can throw to fail
  - [ ] Custom assertions appear in the assertion results
- **Test Vectors**: TV-ASSERT-007
- **Notes**: None.

---

### DIFF-001 through DIFF-009

(Breaking change detection requirements — see SPEC Section 7.5 for complete rules)

### DIFF-001: Detect Endpoint Removal
- **ID**: DIFF-001
- **Priority**: P0
- **Statement**: `diffOpenAPI()` MUST detect when an endpoint (method + path) is removed and classify it as a breaking change.
- **Rationale**: Removing an endpoint breaks existing consumers.
- **Acceptance Criteria**:
  - [ ] Removed endpoint appears in `breaking` array with type `"removed"`
- **Test Vectors**: TV-DIFF-001

### DIFF-002: Detect Required Parameter Addition
- **ID**: DIFF-002
- **Priority**: P0
- **Statement**: `diffOpenAPI()` MUST detect when a new required parameter is added to an existing endpoint and classify it as breaking.
- **Acceptance Criteria**:
  - [ ] New required parameter in `breaking` array
  - [ ] New optional parameter in `nonBreaking` array
- **Test Vectors**: TV-DIFF-002

### DIFF-003: Detect Type Narrowing
- **ID**: DIFF-003
- **Priority**: P1
- **Statement**: `diffOpenAPI()` MUST detect when a request parameter or body field type is narrowed (e.g., `string | number` → `string`).
- **Acceptance Criteria**:
  - [ ] Type narrowing in `breaking` array
- **Test Vectors**: TV-DIFF-003

### DIFF-004: Detect Response Field Removal
- **ID**: DIFF-004
- **Priority**: P0
- **Statement**: `diffOpenAPI()` MUST detect when a response field is removed and classify it as breaking.
- **Acceptance Criteria**:
  - [ ] Removed response field in `breaking` array
- **Test Vectors**: TV-DIFF-004

### DIFF-005: Detect Security Requirement Changes
- **ID**: DIFF-005
- **Priority**: P1
- **Statement**: `diffOpenAPI()` MUST detect when security requirements are added to an endpoint.
- **Acceptance Criteria**:
  - [ ] Added security requirement in `breaking` array
  - [ ] Removed security requirement in `nonBreaking` array
- **Test Vectors**: TV-DIFF-005

### DIFF-006: Detect Non-Breaking Additions
- **ID**: DIFF-006
- **Priority**: P1
- **Statement**: `diffOpenAPI()` MUST detect endpoint additions, optional parameter additions, and response field additions as non-breaking.
- **Acceptance Criteria**:
  - [ ] New endpoint in `nonBreaking` array
  - [ ] New optional param in `nonBreaking` array
  - [ ] New response field in `nonBreaking` array
- **Test Vectors**: TV-DIFF-006

### DIFF-007: Summary Generation
- **ID**: DIFF-007
- **Priority**: P1
- **Statement**: `DiffResult.summary` MUST contain counts: `added`, `removed`, `modified`, `breaking`, `nonBreaking`.
- **Acceptance Criteria**:
  - [ ] Counts are accurate
- **Test Vectors**: TV-DIFF-007

### DIFF-008: Deterministic Results
- **ID**: DIFF-008
- **Priority**: P0
- **Statement**: Given the same two OpenAPI documents, `diffOpenAPI()` MUST produce identical `DiffResult` objects.
- **Acceptance Criteria**:
  - [ ] Two calls with same inputs → structurally equal output
- **Test Vectors**: TV-DIFF-008

### DIFF-009: JSON and Human-Readable Output
- **ID**: DIFF-009
- **Priority**: P1
- **Statement**: The diff result MUST be serializable to JSON (SPEC Section 6.5 format) and renderable as a human-readable table.
- **Acceptance Criteria**:
  - [ ] JSON output matches SPEC Section 6.5 format
  - [ ] CLI prints a readable table with colors
- **Test Vectors**: TV-DIFF-009

---

### UI-R-001 through UI-R-009

(React UI components — see SPEC Section 5.4)

### UI-R-001: ApiExplorer Component
- **ID**: UI-R-001
- **Priority**: P1
- **Statement**: `@apifn/react` MUST export an `ApiExplorer` component that renders a full API explorer from an OpenAPI document.
- **Acceptance Criteria**:
  - [ ] Renders sidebar with all endpoints grouped by tag
  - [ ] Clicking endpoint shows EndpointViewer
  - [ ] Search/filter endpoints by name or path
  - [ ] Responsive layout
- **Test Vectors**: TV-UI-R-001

### UI-R-002: EndpointViewer Component
- **ID**: UI-R-002
- **Priority**: P1
- **Statement**: `EndpointViewer` MUST display method, path, parameters, request body, response schemas, and description for a single endpoint.
- **Acceptance Criteria**:
  - [ ] Method badge with color coding (GET=green, POST=blue, etc.)
  - [ ] Parameter table with name, type, required, description
  - [ ] Request/response body schemas rendered
- **Test Vectors**: TV-UI-R-002

### UI-R-003: SchemaViewer Component
- **ID**: UI-R-003
- **Priority**: P1
- **Statement**: `SchemaViewer` MUST render a JSON Schema as a collapsible, readable tree.
- **Acceptance Criteria**:
  - [ ] Object properties displayed with types
  - [ ] Nested objects collapsible
  - [ ] Required fields marked
  - [ ] `expandDepth` controls initial expansion
- **Test Vectors**: TV-UI-R-003

### UI-R-004: TryIt Console Component
- **ID**: UI-R-004
- **Priority**: P1
- **Statement**: `TryIt` MUST provide an interactive request builder that sends real HTTP requests and displays responses.
- **Acceptance Criteria**:
  - [ ] URL bar with method selector
  - [ ] Parameter inputs (path, query, header)
  - [ ] Body editor with JSON syntax highlighting
  - [ ] Auth configuration (Bearer, API Key, Basic)
  - [ ] Send button that executes the request
  - [ ] Response display with status, headers, body, timing
  - [ ] Response body syntax highlighting
- **Test Vectors**: TV-UI-R-004

### UI-R-005: RequestHistory Component
- **ID**: UI-R-005
- **Priority**: P2
- **Statement**: `RequestHistory` MUST display a list of past requests with status, method, path, and duration.
- **Acceptance Criteria**:
  - [ ] Chronological list of requests
  - [ ] Click to view full request/response
  - [ ] Clear history button
  - [ ] Max 500 entries per SPEC limits
- **Test Vectors**: TV-UI-R-005

### UI-R-006: ResponseDiff Component
- **ID**: UI-R-006
- **Priority**: P2
- **Statement**: `ResponseDiff` MUST display a side-by-side comparison of two responses.
- **Acceptance Criteria**:
  - [ ] Side-by-side JSON diff with highlighting
  - [ ] Status code and headers comparison
  - [ ] Duration comparison
- **Test Vectors**: TV-UI-R-006

### UI-R-007: PerformanceOverlay Component
- **ID**: UI-R-007
- **Priority**: P2
- **Statement**: `PerformanceOverlay` MUST display watchfn metrics (latency percentiles, error rate, throughput) for an endpoint.
- **Acceptance Criteria**:
  - [ ] Latency percentiles (p50, p95, p99) displayed as bar/chart
  - [ ] Error rate as percentage
  - [ ] Throughput as requests/minute
  - [ ] Last updated timestamp
- **Test Vectors**: TV-UI-R-007

### UI-R-008: Theme Support
- **ID**: UI-R-008
- **Priority**: P2
- **Statement**: UI components MUST support light, dark, and auto (system preference) themes.
- **Acceptance Criteria**:
  - [ ] `theme="light"` renders light theme
  - [ ] `theme="dark"` renders dark theme
  - [ ] `theme="auto"` follows system preference
  - [ ] CSS variables for customization
- **Test Vectors**: TV-UI-R-008

### UI-R-009: Responsive Layout
- **ID**: UI-R-009
- **Priority**: P2
- **Statement**: UI components MUST be responsive and usable on mobile viewports.
- **Acceptance Criteria**:
  - [ ] Sidebar collapses to hamburger menu on mobile
  - [ ] Try-It console stacks vertically on mobile
  - [ ] Readable at 375px width
- **Test Vectors**: TV-UI-R-009

---

### UI-S-001 through UI-S-009

Svelte UI components mirror React components (UI-R-001 through UI-R-009) with identical acceptance criteria. Each Svelte component MUST provide the same functionality as its React counterpart.

- **UI-S-001**: ApiExplorer (Svelte) — same as UI-R-001
- **UI-S-002**: EndpointViewer (Svelte) — same as UI-R-002
- **UI-S-003**: SchemaViewer (Svelte) — same as UI-R-003
- **UI-S-004**: TryIt (Svelte) — same as UI-R-004
- **UI-S-005**: RequestHistory (Svelte) — same as UI-R-005
- **UI-S-006**: ResponseDiff (Svelte) — same as UI-R-006
- **UI-S-007**: PerformanceOverlay (Svelte) — same as UI-R-007
- **UI-S-008**: Theme support (Svelte) — same as UI-R-008
- **UI-S-009**: Responsive layout (Svelte) — same as UI-R-009

---

### SERVE-001 through SERVE-004

### SERVE-001: Local Explorer Server
- **ID**: SERVE-001
- **Priority**: P1
- **Statement**: `apifn serve` MUST start a local HTTP server serving the ApiExplorer UI.
- **Acceptance Criteria**:
  - [ ] Server starts on configurable port (default 4100)
  - [ ] Serves React-based explorer by default
  - [ ] OpenAPI spec loaded from router or file
- **Test Vectors**: TV-SERVE-001

### SERVE-002: Hot Reload on Spec Changes
- **ID**: SERVE-002
- **Priority**: P2
- **Statement**: The explorer server MUST watch for changes to the router/spec file and reload automatically.
- **Acceptance Criteria**:
  - [ ] File changes trigger spec regeneration
  - [ ] Browser refreshes via WebSocket or SSE
- **Test Vectors**: TV-SERVE-002

### SERVE-003: Proxy to Target API
- **ID**: SERVE-003
- **Priority**: P2
- **Statement**: The explorer server SHOULD proxy Try-It requests to the target API to avoid CORS issues.
- **Acceptance Criteria**:
  - [ ] Requests from Try-It console are proxied through the serve server
  - [ ] Original headers and body preserved
- **Test Vectors**: TV-SERVE-003

### SERVE-004: CORS Configuration
- **ID**: SERVE-004
- **Priority**: P2
- **Statement**: The explorer server MUST serve with CORS restricted to localhost by default, with opt-in for custom origins.
- **Acceptance Criteria**:
  - [ ] Default: only localhost allowed
  - [ ] `--cors <origin>` flag allows custom origins
- **Test Vectors**: TV-SERVE-004

---

### DOCS-001 through DOCS-006

### DOCS-001: DocsContentProvider Implementation
- **ID**: DOCS-001
- **Priority**: P1
- **Statement**: `@apifn/docsfn` MUST export a `createApifnProvider()` function that returns a `DocsContentProvider` compatible with docsfn's manifest pipeline.
- **Acceptance Criteria**:
  - [ ] Returns `RawContentEntry[]` with `kind: "api"`
  - [ ] Accepts OpenAPI document, Router, or file path as source
  - [ ] `splitByTag: true` produces one entry per tag group
  - [ ] `splitByTag: false` produces a single entry for the full spec
- **Test Vectors**: TV-DOCS-001

### DOCS-002: API Reference Renderer (React)
- **ID**: DOCS-002
- **Priority**: P1
- **Statement**: `@apifn/docsfn` MUST export an `ApifnApiReference` React component that renders an API reference from an `ApiReference` manifest entry.
- **Acceptance Criteria**:
  - [ ] Renders endpoint list with method badges
  - [ ] Renders parameters, request/response schemas
  - [ ] Optional Try-It console embedded
  - [ ] Optional watchfn performance overlay
- **Test Vectors**: TV-DOCS-002

### DOCS-003: API Reference Renderer (Svelte)
- **ID**: DOCS-003
- **Priority**: P1
- **Statement**: `@apifn/docsfn` MUST export a Svelte `ApifnApiReference` component with identical functionality to DOCS-002.
- **Acceptance Criteria**: Same as DOCS-002.
- **Test Vectors**: TV-DOCS-003

### DOCS-004: Auto-Sidebar Generation
- **ID**: DOCS-004
- **Priority**: P1
- **Statement**: The docsfn provider MUST generate sidebar entries for API reference pages, grouped by tag or path prefix.
- **Acceptance Criteria**:
  - [ ] Each tag group appears as a sidebar group
  - [ ] Individual endpoints appear as sidebar links within groups
- **Test Vectors**: TV-DOCS-004

### DOCS-005: Try-It Integration in Docs
- **ID**: DOCS-005
- **Priority**: P2
- **Statement**: The API reference renderer MUST optionally include an embedded Try-It console for each endpoint.
- **Acceptance Criteria**:
  - [ ] `tryIt: true` shows Try-It panel per endpoint
  - [ ] `tryIt: false` hides it
  - [ ] `baseUrl` configures the target server
- **Test Vectors**: TV-DOCS-005

### DOCS-006: Split by Tag/Path
- **ID**: DOCS-006
- **Priority**: P1
- **Statement**: The provider MUST support splitting the API spec into multiple documentation pages by tag or path prefix.
- **Acceptance Criteria**:
  - [ ] `splitByTag: true` → one page per tag
  - [ ] Each page has its own slug (e.g., `/api/users`, `/api/orders`)
- **Test Vectors**: TV-DOCS-006

---

### SNIP-001 through SNIP-007

### SNIP-001: curl Generation
- **ID**: SNIP-001
- **Priority**: P1
- **Statement**: `generateSnippet()` with `target: "curl"` MUST produce a valid curl command for the operation.
- **Acceptance Criteria**:
  - [ ] Includes method, URL, headers, body
  - [ ] Proper escaping of special characters
- **Test Vectors**: TV-SNIP-001

### SNIP-002: JavaScript fetch Generation
- **ID**: SNIP-002
- **Priority**: P1
- **Statement**: `generateSnippet()` with `target: "fetch"` MUST produce valid JavaScript using the Fetch API.
- **Acceptance Criteria**:
  - [ ] Includes method, URL, headers, body
  - [ ] Proper JSON.stringify for body
  - [ ] Async/await syntax
- **Test Vectors**: TV-SNIP-002

### SNIP-003: axios Generation
- **ID**: SNIP-003
- **Priority**: P2
- **Statement**: `generateSnippet()` with `target: "axios"` MUST produce valid axios code.
- **Acceptance Criteria**:
  - [ ] Uses `axios.get/post/put/delete` methods
- **Test Vectors**: TV-SNIP-003

### SNIP-004: Python requests Generation
- **ID**: SNIP-004
- **Priority**: P1
- **Statement**: `generateSnippet()` with `target: "python-requests"` MUST produce valid Python using the `requests` library.
- **Acceptance Criteria**:
  - [ ] Uses `requests.get/post/put/delete`
  - [ ] Proper dict/JSON handling
- **Test Vectors**: TV-SNIP-004

### SNIP-005: Additional Targets
- **ID**: SNIP-005
- **Priority**: P2
- **Statement**: `generateSnippet()` SHOULD support additional targets: `go-http`, `ruby-net-http`, `php-curl`, `csharp-httpclient`, `java-okhttp`, `python-httpx`, `node-fetch`.
- **Acceptance Criteria**:
  - [ ] Each target produces valid code in its language
- **Test Vectors**: TV-SNIP-005

### SNIP-006: Auth Injection in Snippets
- **ID**: SNIP-006
- **Priority**: P1
- **Statement**: Snippets MUST include authentication headers when auth config is provided.
- **Acceptance Criteria**:
  - [ ] Bearer token → `Authorization: Bearer <token>` header
  - [ ] API Key → appropriate header or query param
  - [ ] Placeholder values for secrets (e.g., `YOUR_API_KEY`)
- **Test Vectors**: TV-SNIP-006

### SNIP-007: Variable Substitution in Snippets
- **ID**: SNIP-007
- **Priority**: P2
- **Statement**: Snippets MUST substitute the provided `baseUrl` and any example values from the spec.
- **Acceptance Criteria**:
  - [ ] `baseUrl` replaces server URL in snippet
  - [ ] Example values from spec used for parameters
- **Test Vectors**: TV-SNIP-007

---

### MOCK-001 through MOCK-007

### MOCK-001: Serve All Spec Paths
- **ID**: MOCK-001
- **Priority**: P2
- **Statement**: The mock server MUST register handlers for all paths defined in the OpenAPI spec.
- **Acceptance Criteria**:
  - [ ] Each path+method combination returns a response
  - [ ] Undefined paths return 404
- **Test Vectors**: TV-MOCK-001

### MOCK-002: Schema-Based Response Generation
- **ID**: MOCK-002
- **Priority**: P2
- **Statement**: In `"schema"` mode, the mock server MUST generate deterministic response bodies from JSON Schema using sensible defaults.
- **Acceptance Criteria**:
  - [ ] `type: "string"` → `"string"`, `type: "number"` → `0`, `type: "boolean"` → `true`
  - [ ] Objects contain all required properties
  - [ ] Arrays contain 1 item
- **Test Vectors**: TV-MOCK-002

### MOCK-003: Example-Based Responses
- **ID**: MOCK-003
- **Priority**: P2
- **Statement**: In `"examples"` mode, the mock server MUST use `example`/`examples` from the spec.
- **Acceptance Criteria**:
  - [ ] First example used when available
  - [ ] Falls back to schema generation when no examples
- **Test Vectors**: TV-MOCK-003

### MOCK-004: Random Mode
- **ID**: MOCK-004
- **Priority**: P2
- **Statement**: In `"random"` mode, the mock server MUST generate valid but randomized responses.
- **Acceptance Criteria**:
  - [ ] Responses validate against their schemas
  - [ ] Values differ between requests
- **Test Vectors**: TV-MOCK-004

### MOCK-005: Request Validation
- **ID**: MOCK-005
- **Priority**: P2
- **Statement**: When `validateRequests: true`, the mock server MUST validate incoming requests against their schemas.
- **Acceptance Criteria**:
  - [ ] Invalid request body → 400 with validation errors
  - [ ] Missing required parameters → 400 with error
  - [ ] Valid requests proceed normally
- **Test Vectors**: TV-MOCK-005

### MOCK-006: Configurable Delay
- **ID**: MOCK-006
- **Priority**: P2
- **Statement**: `delay` option MUST add artificial latency to mock responses.
- **Acceptance Criteria**:
  - [ ] `delay: 100` adds ~100ms to response time
- **Test Vectors**: TV-MOCK-006

### MOCK-007: CORS Support
- **ID**: MOCK-007
- **Priority**: P2
- **Statement**: The mock server MUST support CORS configuration.
- **Acceptance Criteria**:
  - [ ] `cors: true` enables permissive CORS
  - [ ] Custom CORS options supported
- **Test Vectors**: TV-MOCK-007

---

### WATCH-001 through WATCH-004

### WATCH-001: Fetch Endpoint Metrics
- **ID**: WATCH-001
- **Priority**: P2
- **Statement**: `fetchEndpointMetrics()` MUST retrieve performance metrics from a running watchfn instance.
- **Acceptance Criteria**:
  - [ ] Returns `EndpointMetrics[]` with latency, throughput, errors per endpoint
  - [ ] Supports time range filtering
  - [ ] Supports endpoint filtering
- **Test Vectors**: TV-WATCH-001

### WATCH-002: Display Metrics in Explorer
- **ID**: WATCH-002
- **Priority**: P2
- **Statement**: The API explorer MUST display watchfn metrics alongside endpoint documentation when a watchfn client is configured.
- **Acceptance Criteria**:
  - [ ] PerformanceOverlay visible per endpoint
  - [ ] Metrics update periodically (configurable interval)
  - [ ] Graceful degradation when watchfn unavailable
- **Test Vectors**: TV-WATCH-002

### WATCH-003: Display Metrics in docsfn
- **ID**: WATCH-003
- **Priority**: P2
- **Statement**: The docsfn API reference renderer MUST optionally display watchfn metrics.
- **Acceptance Criteria**:
  - [ ] Metrics shown when `watchfn` prop provided
  - [ ] Hidden when `watchfn` not provided
- **Test Vectors**: TV-WATCH-003

### WATCH-004: apifn-specific Middleware
- **ID**: WATCH-004
- **Priority**: P2
- **Statement**: ApiFn MUST provide a `@superfunctions/http` middleware that reports per-route metrics to watchfn.
- **Acceptance Criteria**:
  - [ ] Middleware captures request duration, status code, path
  - [ ] Reports to watchfn via its event API
- **Test Vectors**: TV-WATCH-004

---

### AUTH-001 through AUTH-003

### AUTH-001: Mint Short-Lived Test Tokens
- **ID**: AUTH-001
- **Priority**: P2
- **Statement**: `mintTestToken()` MUST create a short-lived API key via authfn with configurable scopes and TTL.
- **Acceptance Criteria**:
  - [ ] Returns `{ token, expiresAt, keyId }`
  - [ ] Token works with authfn's authenticate flow
  - [ ] Max TTL enforced at 3600 seconds
  - [ ] Default TTL is 300 seconds (5 minutes)
- **Test Vectors**: TV-AUTH-001

### AUTH-002: Token Injection in Collection Runs
- **ID**: AUTH-002
- **Priority**: P2
- **Statement**: Collection runs MUST support automatic injection of minted tokens into request Authorization headers.
- **Acceptance Criteria**:
  - [ ] Token injected as `Bearer <token>` when configured
  - [ ] Overrides auth configuration in collection requests
- **Test Vectors**: TV-AUTH-002

### AUTH-003: Token TTL Enforcement
- **ID**: AUTH-003
- **Priority**: P2
- **Statement**: `mintTestToken()` MUST reject TTL values exceeding 3600 seconds.
- **Acceptance Criteria**:
  - [ ] TTL > 3600 → error "TTL exceeds maximum of 3600 seconds"
  - [ ] TTL ≤ 0 → error "TTL must be positive"
- **Test Vectors**: TV-AUTH-003

---

### SEC-001 through SEC-002

### SEC-001: Fetch Rate Limit Headroom
- **ID**: SEC-001
- **Priority**: P2
- **Statement**: `fetchRateLimits()` MUST query secfn's RateLimiter for each endpoint's remaining request headroom.
- **Acceptance Criteria**:
  - [ ] Returns `RateLimitInfo[]` with `remaining`, `limit`, `resetAt`, `blocked`
  - [ ] Does not consume a rate limit token (read-only check)
- **Test Vectors**: TV-SEC-001
- **Notes**: May require a `peek()` method on secfn's RateLimiter; if not available, uses `check()` in dry-run mode or reads storage directly.

### SEC-002: Display Rate Limits in Explorer
- **ID**: SEC-002
- **Priority**: P2
- **Statement**: The API explorer MUST display rate limit headroom per endpoint when secfn is configured.
- **Acceptance Criteria**:
  - [ ] Shows remaining/limit count per endpoint
  - [ ] Shows reset time
  - [ ] Warns when headroom is low (< 10%)
- **Test Vectors**: TV-SEC-002

---

### LOG-001 through LOG-002

### LOG-001: logfn Reporter for Collection Runs
- **ID**: LOG-001
- **Priority**: P2
- **Statement**: `logfnReporter()` MUST return a `RunReporter` that logs collection run events via logfn.
- **Acceptance Criteria**:
  - [ ] `onStart` → `info` log with collection name and environment
  - [ ] `onRequestComplete` → `info` or `error` log per result
  - [ ] `onComplete` → `info` log with summary
  - [ ] Uses `child()` for per-request context
- **Test Vectors**: TV-LOG-001

### LOG-002: Structured Logging Throughout CLI
- **ID**: LOG-002
- **Priority**: P2
- **Statement**: All CLI commands MUST use logfn for structured logging when available, falling back to console otherwise.
- **Acceptance Criteria**:
  - [ ] `--verbose` sets log level to `debug`
  - [ ] `--quiet` sets log level to `error`
  - [ ] Structured JSON output when logfn configured with sinkHttp
- **Test Vectors**: TV-LOG-002

---

### TESTFN-001 through TESTFN-003

### TESTFN-001: ApifnTestAdapter Implementation
- **ID**: TESTFN-001
- **Priority**: P2
- **Statement**: ApiFn MUST provide a `BaseAdapter` implementation for testfn that enables running OpenCollection collections as test suites.
- **Acceptance Criteria**:
  - [ ] Extends `BaseAdapter` from `@testfn/core`
  - [ ] `name` is `"apifn"`
  - [ ] `supports("apifn")` returns true
- **Test Vectors**: TV-TESTFN-001

### TESTFN-002: Collection Discovery
- **ID**: TESTFN-002
- **Priority**: P2
- **Statement**: `ApifnTestAdapter.discover()` MUST find OpenCollection directories matching the provided patterns.
- **Acceptance Criteria**:
  - [ ] Discovers collections by finding `opencollection.yml` files
  - [ ] Returns one `TestCase` per request in the collection
- **Test Vectors**: TV-TESTFN-002

### TESTFN-003: Result Mapping to testfn Format
- **ID**: TESTFN-003
- **Priority**: P2
- **Statement**: `ApifnTestAdapter.run()` MUST map `RequestResult` to testfn's `TestResult` format.
- **Acceptance Criteria**:
  - [ ] `passed` → `{ status: "passed" }`
  - [ ] `failed` → `{ status: "failed", error: { ... } }`
  - [ ] `error` → `{ status: "failed", error: { ... } }`
  - [ ] Duration preserved
- **Test Vectors**: TV-TESTFN-003

---

### PY-001 through PY-005

### PY-001: FastAPI Introspection Adapter
- **ID**: PY-001
- **Priority**: P2
- **Statement**: The Python `apifn` package MUST provide `introspect_fastapi()` that extracts and augments OpenAPI from a FastAPI application.
- **Acceptance Criteria**:
  - [ ] Uses FastAPI's native `app.openapi()` as base
  - [ ] Augments with apifn-specific metadata
  - [ ] Returns a standard OpenAPI dict
- **Test Vectors**: TV-PY-001

### PY-002: Flask Introspection Adapter
- **ID**: PY-002
- **Priority**: P2
- **Statement**: The Python `apifn` package MUST provide `introspect_flask()` for Flask applications.
- **Acceptance Criteria**:
  - [ ] Extracts routes from Flask app
  - [ ] Generates OpenAPI from route definitions
  - [ ] Supports Flask-RESTful and Flask-RESTX
- **Test Vectors**: TV-PY-002

### PY-003: OpenAPI Augmentation
- **ID**: PY-003
- **Priority**: P2
- **Statement**: Python adapters MUST be able to augment existing OpenAPI specs with additional metadata (watchfn metrics, examples).
- **Acceptance Criteria**:
  - [ ] Adds `x-apifn-*` extensions
  - [ ] Preserves all original OpenAPI content
- **Test Vectors**: TV-PY-003

### PY-004: Collection Runner (Python)
- **ID**: PY-004
- **Priority**: P2
- **Statement**: The Python package MUST provide `run_collection()` for executing OpenCollection collections.
- **Acceptance Criteria**:
  - [ ] Reads OpenCollection YAML directories
  - [ ] Executes requests with variable interpolation
  - [ ] Returns run report
- **Test Vectors**: TV-PY-004

### PY-005: Schema Diff (Python)
- **ID**: PY-005
- **Priority**: P2
- **Statement**: The Python package MUST provide `diff_openapi()` for comparing OpenAPI documents.
- **Acceptance Criteria**:
  - [ ] Same breaking/non-breaking classification as TypeScript version
  - [ ] Returns equivalent diff result structure
- **Test Vectors**: TV-PY-005

---

### CI-001 through CI-004

### CI-001: GitHub Actions Workflow
- **ID**: CI-001
- **Priority**: P2
- **Statement**: ApiFn MUST provide a reusable GitHub Actions workflow for API spec validation and diff.
- **Acceptance Criteria**:
  - [ ] Action validates OpenAPI spec
  - [ ] Action diffs against base branch spec
  - [ ] Action runs collection tests
  - [ ] Configurable failure conditions
- **Test Vectors**: TV-CI-001

### CI-002: Non-Zero Exit on Breaking Changes
- **ID**: CI-002
- **Priority**: P0
- **Statement**: `apifn diff` MUST exit with code 1 when breaking changes are detected (unless `--fail-on-breaking false`).
- **Rationale**: CI pipelines must be able to gate on breaking changes.
- **Acceptance Criteria**:
  - [ ] Breaking changes → exit code 1
  - [ ] No breaking changes → exit code 0
  - [ ] `--fail-on-breaking false` → always exit code 0
- **Test Vectors**: TV-CI-002

### CI-003: Report Output Formats
- **ID**: CI-003
- **Priority**: P1
- **Statement**: CLI test and diff commands MUST support JSON output format for machine consumption.
- **Acceptance Criteria**:
  - [ ] `--reporter json` or `--format json` outputs JSON to stdout
  - [ ] JSON parseable by CI tools
- **Test Vectors**: TV-CI-003

### CI-004: PR Comment Integration
- **ID**: CI-004
- **Priority**: P2
- **Statement**: The GitHub Actions workflow SHOULD post a summary comment on PRs with diff results and test outcomes.
- **Acceptance Criteria**:
  - [ ] PR comment shows breaking/non-breaking change summary
  - [ ] PR comment shows test pass/fail summary
  - [ ] Comment updates on subsequent pushes
- **Test Vectors**: TV-CI-004
