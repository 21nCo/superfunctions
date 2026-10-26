# ContentFn Requirements

## Table of Contents

### P0 (Core)

- API-001: ContentFn API surface and configuration
- API-002: Canonical envelope and error model
- DS-001: Dataset lifecycle and isolation
- SCHEMA-001: Schema upsert/get and validation
- SCHEMA-002: Schema version monotonicity and conflicts
- DOC-001: Document create/get/delete and system fields
- DOC-002: Draft vs published perspectives and ID mapping
- DOC-003: Publish/unpublish semantics and atomicity
- PATCH-001: Patch operations and path validation
- REV-001: Optimistic concurrency via `ifRev`
- HIST-001: Revision history and restore
- QRY-001: CFQL query semantics (filter/order/projection)
- QRY-002: Deterministic ordering and cursor pagination
- REF-001: Reference encoding and bounded expansion
- ASSET-001: Asset upload/get and metadata
- WH-001: Webhook registration and delivery semantics
- RT-001: Realtime event feed and subscriptions
- AUTH-001: Authorization hook and permission boundaries
- LIMIT-001: Limits and rate limiting behavior
- OBS-001: Observability and logging constraints
- STATUS-001: Status endpoint and capability discovery

### P1 (Tooling and portability)

- IMP-001: Dataset import/export
- SEARCH-001: Text match and search integration
- CLI-001: CLI interface (schema and content ops)

---

## P0 Requirements

### API-001: ContentFn API surface and configuration

**Priority**: P0  
**Statement**: The implementation MUST expose a `ContentfnAPI` with the namespaces and method signatures defined in `SPEC.md` (datasets, schema, docs, assets, webhooks, realtime) and MUST be constructible from a config that includes an `@superfunctions/db` adapter.  
**Rationale**: A stable API surface is required for `cmsfn`, `docsfn` providers, and application backends to integrate consistently.  
**Acceptance criteria**:
- Constructing the server API with a DB adapter returns an object exposing the documented namespaces and methods.
- Calling an API method returns a `ContentfnEnvelope<T>` and never throws for expected validation/auth/storage failures.
- When DB adapter is missing/invalid, construction fails deterministically with a clear error (implementation-defined; may throw at startup, not at runtime per-call).
**Test vectors**: TV-API-CONFIG-001, TV-API-CONFIG-002, TV-ENV-OK-001, TV-ENV-ERR-001  
**Notes**: This requirement covers the SDK surface; HTTP endpoints are covered by STATUS-001 and the endpoint-specific vectors.

---

### API-002: Canonical envelope and error model

**Priority**: P0  
**Statement**: All fallible ContentFn operations MUST return the canonical envelope `{ ok: true, result } | { ok: false, error }` with `ContentfnError.code` from the enumerated set and MUST include a human-readable `message`.  
**Rationale**: A consistent envelope enables robust clients, deterministic testing, and cross-function integrations.  
**Acceptance criteria**:
- Success responses always include `{ ok: true, result: ... }` and never include `error`.
- Failure responses always include `{ ok: false, error: { code, message, details } }` and never include `result`.
- Validation failures set `code="VALIDATION_FAILED"` (or `PATCH_INVALID` / `QUERY_INVALID` where applicable) and include `details.path` when a specific field/path is invalid.
**Test vectors**: TV-ENV-OK-001, TV-ENV-ERR-001, TV-PATCH-INVALID-001, TV-QRY-INVALID-001  
**Notes**: Transport (HTTP/WebSocket) MUST embed the same envelope semantics for request/response style messages.

---

### DS-001: Dataset lifecycle and isolation

**Priority**: P0  
**Statement**: The server MUST support dataset create/list/delete with name validation and MUST isolate all content operations by dataset.  
**Rationale**: Datasets enable prod/staging separation and multi-tenant hosting without cross-contamination.  
**Acceptance criteria**:
- Creating a dataset with a valid name succeeds; creating the same name twice returns `DATASET_ALREADY_EXISTS`.
- Creating a dataset with an invalid name returns `VALIDATION_FAILED`.
- Querying, getting, patching, publishing, asset operations, and webhooks in dataset A MUST NOT affect dataset B.
- Deleting a dataset makes subsequent operations on that dataset return `DATASET_NOT_FOUND`.
**Test vectors**: TV-DS-CREATE-001, TV-DS-CREATE-002, TV-DS-CREATE-003, TV-DS-ISOLATION-001, TV-DS-DELETE-001  
**Notes**: Retention overrides (e.g., soft-delete) are permitted only if they preserve isolation and are documented by the deployment.

---

### SCHEMA-001: Schema upsert/get and validation

**Priority**: P0  
**Statement**: The server MUST allow upserting and fetching a dataset schema and MUST validate schema shape (type names, field names, references, and deterministic validations) before accepting it.  
**Rationale**: A schema-driven CMS requires a canonical definition of allowed documents and constraints.  
**Acceptance criteria**:
- Upserting a valid schema returns `{ ok: true, result: { schemaHash } }`.
- Fetching after upsert returns the identical schema content (deep equality) for the dataset.
- Upserting an invalid schema returns `SCHEMA_INVALID` (or `VALIDATION_FAILED`) with `details.path` pointing to the invalid location.
**Test vectors**: TV-SCHEMA-UPSERT-001, TV-SCHEMA-GET-001, TV-SCHEMA-UPSERT-002  
**Notes**: `schemaHash` MUST change deterministically when schema content changes.

---

### SCHEMA-002: Schema version monotonicity and conflicts

**Priority**: P0  
**Statement**: Schema `version` MUST be monotonic per dataset and the server MUST reject upserts that attempt to decrease or re-use an existing version with different schema content.  
**Rationale**: Monotonic schema versions prevent ambiguous validation and enable deterministic migrations.  
**Acceptance criteria**:
- Upserting version 2 after version 1 succeeds when schema validates.
- Upserting version 1 after version 2 returns `SCHEMA_VERSION_CONFLICT`.
- Upserting the same version number with different content returns `SCHEMA_VERSION_CONFLICT`.
**Test vectors**: TV-SCHEMA-VERSION-001, TV-SCHEMA-VERSION-002  
**Notes**: Deployments MAY allow no-op re-upsert of identical schema content at the same version.

---

### DOC-001: Document create/get/delete and system fields

**Priority**: P0  
**Statement**: The server MUST support document create, get, and delete and MUST assign and maintain system fields (`_id`, `_type`, `_rev`, `_createdAt`, `_updatedAt`) as specified.  
**Rationale**: Documents are the fundamental unit of content and must have consistent identity and metadata.  
**Acceptance criteria**:
- Creating a document returns a document containing all required system fields.
- Getting an existing document returns the same `_id` and `_type` and current `_rev`.
- Getting a non-existent document returns `DOCUMENT_NOT_FOUND`.
- Deleting a document prevents subsequent get from returning it (unless soft-delete is explicitly configured).
**Test vectors**: TV-DOC-CREATE-001, TV-DOC-GET-001, TV-DOC-GET-002, TV-DOC-DELETE-001  
**Notes**: Deleting with `purge=true` MUST remove both draft and published forms.

---

### DOC-002: Draft vs published perspectives and ID mapping

**Priority**: P0  
**Statement**: Draft documents MUST use the `drafts.` ID prefix and the server MUST implement the `perspective` semantics described in `SPEC.md` (`published`, `draft`, `raw`).  
**Rationale**: Sanity-like workflows depend on drafts being distinct but mappable to published documents.  
**Acceptance criteria**:
- Creating with `asDraft=true` yields an ID with `drafts.` prefix.
- Publishing maps `drafts.{id}` to `{id}` deterministically.
- `perspective="published"` never returns draft content; `perspective="draft"` never returns published content.
**Test vectors**: TV-DOC-DRAFT-ID-001, TV-DOC-PERSPECTIVE-001, TV-DOC-PERSPECTIVE-002  
**Notes**: `perspective="raw"` response shape MUST be documented by implementation if supported.

---

### DOC-003: Publish/unpublish semantics and atomicity

**Priority**: P0  
**Statement**: Publishing and unpublishing MUST be atomic and MUST follow the semantics in `SPEC.md`, including emitting the appropriate events.  
**Rationale**: Consumers and previews require consistent perspective reads and reliable event triggers.  
**Acceptance criteria**:
- Publishing without an existing draft returns `DOCUMENT_NOT_FOUND` (or `VALIDATION_FAILED`) deterministically.
- Publishing updates the published document to match the draft content and sets `_publishedAt`.
- Unpublish removes the published representation and leaves the draft untouched.
- The event feed contains `doc.published` / `doc.unpublished` events with correct identifiers.
**Test vectors**: TV-DOC-PUBLISH-001, TV-DOC-PUBLISH-002, TV-DOC-UNPUBLISH-001, TV-RT-EVENTS-001  
**Notes**: Scheduled publishing (time-based) is allowed; semantics must remain atomic at publish time.

---

### PATCH-001: Patch operations and path validation

**Priority**: P0  
**Statement**: The server MUST implement the patch operations in `SPEC.md` (`set`, `unset`, `inc`, `dec`, `insert`, `splice`) and MUST validate patch paths and operation shapes deterministically.  
**Rationale**: Patch semantics are essential for efficient edits and collaborative tooling.  
**Acceptance criteria**:
- A valid patch updates the document and returns the updated document with a new `_rev`.
- Invalid paths or malformed operations return `PATCH_INVALID` with `details.path` when applicable.
- Numeric operations (`inc`/`dec`) on non-numeric fields return `PATCH_INVALID`.
**Test vectors**: TV-PATCH-SET-001, TV-PATCH-UNSET-001, TV-PATCH-INVALID-001, TV-PATCH-NONNUM-001  
**Notes**: Array addressing by `_key` MAY be supported; if supported, it MUST be documented and deterministic.

---

### REV-001: Optimistic concurrency via `ifRev`

**Priority**: P0  
**Statement**: Mutations that include `ifRev` MUST enforce optimistic concurrency and MUST return `REV_CONFLICT` when the provided revision does not match the current document revision.  
**Rationale**: Concurrency control is required to avoid accidental overwrite and support collaborative editing.  
**Acceptance criteria**:
- Patch with the correct `ifRev` succeeds.
- Patch with an outdated `ifRev` fails with `REV_CONFLICT` and includes `expectedRev`/`actualRev` in `details`.
**Test vectors**: TV-REV-CONFLICT-001, TV-PATCH-SET-001  
**Notes**: The same rule applies to publish/unpublish when `ifRev` is provided.

---

### HIST-001: Revision history and restore

**Priority**: P0  
**Statement**: The server MUST record immutable revisions for successful mutations and MUST support listing history and restoring a prior revision as specified.  
**Rationale**: Editorial workflows require auditability, diffing, and rollback.  
**Acceptance criteria**:
- After mutations, history lists revisions in reverse chronological order with pagination.
- Restoring an unknown revision returns `VALIDATION_FAILED` or `DOCUMENT_NOT_FOUND` deterministically.
- Restoring a revision writes to the draft perspective and results in a new `_rev`.
**Test vectors**: TV-HIST-LIST-001, TV-RESTORE-001, TV-RESTORE-002  
**Notes**: Revision bodies SHOULD be stored compactly; storage strategy is implementation-defined.

---

### QRY-001: CFQL query semantics (filter/order/projection)

**Priority**: P0  
**Statement**: The server MUST execute CFQL queries with filtering, ordering, projection, and limit semantics exactly as defined in `SPEC.md`.  
**Rationale**: A deterministic query API is required for content delivery and `cmsfn` browsing experiences.  
**Acceptance criteria**:
- Filtering returns only documents that satisfy the filter expression.
- Projection returns only requested fields (plus system fields unless explicitly excluded by documented rules).
- Invalid filters/operators return `QUERY_INVALID` with `details.path`.
**Test vectors**: TV-QRY-001, TV-QRY-PROJECTION-001, TV-QRY-INVALID-001  
**Notes**: The `match` operator MAY require a search backend; if unsupported, it MUST fail deterministically with `QUERY_INVALID`.

---

### QRY-002: Deterministic ordering and cursor pagination

**Priority**: P0  
**Statement**: Query results MUST be deterministically ordered and cursor pagination MUST be stable and opaque as defined in `SPEC.md`.  
**Rationale**: Deterministic pagination is required for reliable UIs and sync-like consumption.  
**Acceptance criteria**:
- When no `orderBy` is specified, results are ordered by `_updatedAt desc, _id asc`.
- When `orderBy` is specified, `_id asc` is appended as a tie-breaker if missing.
- Repeating the same query over the same dataset state returns identical ordering and cursors.
**Test vectors**: TV-QRY-ORDER-DEFAULT-001, TV-QRY-CURSOR-001, TV-QRY-ORDER-TIEBREAK-001  
**Notes**: Cursor encoding is opaque; clients MUST NOT parse it.

---

### REF-001: Reference encoding and bounded expansion

**Priority**: P0  
**Statement**: References MUST use the canonical encoding and reference expansion in queries MUST be bounded by `maxExpandDepth` and MUST be cycle-safe and deterministic.  
**Rationale**: References are core to content graphs; expansion must be safe and predictable.  
**Acceptance criteria**:
- Reference objects are stored and returned in canonical shape.
- Expansion returns referenced documents projected per nested projection rules.
- Expansion beyond depth limit returns `QUERY_TOO_COMPLEX` (or truncates deterministically if documented).
- Cycles do not cause non-termination and are handled deterministically.
**Test vectors**: TV-REF-ENCODE-001, TV-REF-EXPAND-001, TV-REF-EXPAND-002, TV-REF-CYCLE-001  
**Notes**: Weak references may allow broken refs; behavior MUST be documented.

---

### ASSET-001: Asset upload/get and metadata

**Priority**: P0  
**Statement**: The server MUST support asset upload and retrieval and MUST store asset metadata sufficient to reference and render assets in documents.  
**Rationale**: Assets are first-class in CMS workflows.  
**Acceptance criteria**:
- Upload returns `assetId` and a stable `url`.
- Getting a missing asset returns `ASSET_NOT_FOUND`.
- Image uploads store width/height metadata when determinable.
- Uploads exceeding `maxPayloadBytes` fail with `PAYLOAD_TOO_LARGE`.
**Test vectors**: TV-ASSET-UPLOAD-001, TV-ASSET-UPLOAD-002, TV-ASSET-GET-001, TV-ASSET-GET-002  
**Notes**: URL signing and access control are deployment-specific but MUST not violate authorization (AUTH-001).

---

### WH-001: Webhook registration and delivery semantics

**Priority**: P0  
**Statement**: The server MUST support webhook register/list/delete per dataset and MUST deliver events using the webhook payload and signature semantics defined in `SPEC.md`.  
**Rationale**: Webhooks power incremental rebuilds, downstream caches, and preview updates.  
**Acceptance criteria**:
- Registering a webhook returns a webhook ID; listing returns the registered webhook.
- Registering an invalid URL fails with `VALIDATION_FAILED`.
- On publish, a `doc.published` webhook is delivered with required fields and signature header when configured.
**Test vectors**: TV-WH-REGISTER-001, TV-WH-REGISTER-002, TV-WH-DELIVERY-001  
**Notes**: Delivery retries are required; exact backoff parameters are configurable.

---

### RT-001: Realtime event feed and subscriptions

**Priority**: P0  
**Statement**: The server MUST expose a realtime event feed that can stream content change events and MUST support subscribing to at least document-level events for live preview.  
**Rationale**: Sanity-like experiences rely on live updates and collaborative tooling.  
**Acceptance criteria**:
- A client can subscribe to document events and receives `doc.updated` / `doc.published` messages for that dataset/doc.
- Unauthorized subscriptions fail with `AUTH_REQUIRED` or `PERMISSION_DENIED` deterministically.
- Event messages include `eventId`, `type`, `dataset`, and `timestamp`.
**Test vectors**: TV-RT-SUBSCRIBE-001, TV-RT-SUBSCRIBE-002, TV-RT-EVENTS-001  
**Notes**: Query-level subscriptions are allowed; if implemented they MUST reuse deterministic query semantics.

---

### AUTH-001: Authorization hook and permission boundaries

**Priority**: P0  
**Statement**: The server MUST provide an authorization hook that can allow/deny actions per request and MUST return `PERMISSION_DENIED` when denied without leaking protected document content.  
**Rationale**: Self-hosted deployments require integrating with diverse auth systems.  
**Acceptance criteria**:
- When the authorization hook denies an action, the operation returns `PERMISSION_DENIED`.
- Denied operations do not return document bodies, asset bytes, or sensitive metadata.
- Authorization is evaluated per dataset and per operation type.
**Test vectors**: TV-AUTH-ALLOW-001, TV-AUTH-DENY-001  
**Notes**: Authn (identity) is deployment-defined; ContentFn consumes `ctx` only.

---

### LIMIT-001: Limits and rate limiting behavior

**Priority**: P0  
**Statement**: The server MUST enforce configured limits (payload size, patch ops, query depth/limit, expand depth) and MUST return the correct limit error code.  
**Rationale**: Limits prevent abuse and ensure predictable performance.  
**Acceptance criteria**:
- Oversized JSON requests return `PAYLOAD_TOO_LARGE`.
- Queries exceeding complexity constraints return `QUERY_TOO_COMPLEX`.
- Patches exceeding max operations return `VALIDATION_FAILED` or `PAYLOAD_TOO_LARGE` deterministically (documented choice).
**Test vectors**: TV-LIMIT-PAYLOAD-001, TV-REF-EXPAND-002, TV-LIMIT-PATCHOPS-001  
**Notes**: Rate limiting may be global or per-identity; behavior MUST be deterministic for the same inputs.

---

### OBS-001: Observability and logging constraints

**Priority**: P0  
**Statement**: The server MUST emit structured logs for schema and mutation events and MUST NOT log raw document bodies or raw asset bytes by default.  
**Rationale**: Operators need operational visibility without leaking PII/secrets into logs.  
**Acceptance criteria**:
- Mutation logs include action, dataset, document ID, and actor (if available) but exclude document body content unless explicitly enabled.
- Asset upload logs include metadata (size/type) but exclude raw bytes.
- Webhook failure logs include destination and error summary without including secrets.
**Test vectors**: TV-OBS-LOGGING-001, TV-OBS-LOGGING-002  
**Notes**: Log sink and format are implementation-defined; required fields are not.

---

### STATUS-001: Status endpoint and capability discovery

**Priority**: P0  
**Statement**: The server MUST expose `GET /contentfn/status` that returns server time, declared capabilities, and effective limits in a success envelope.  
**Rationale**: Clients must feature-detect and operators must inspect runtime configuration.  
**Acceptance criteria**:
- Status endpoint returns `{ ok: true, result: { serverTime, capabilities, limits } }`.
- Capabilities list includes at least: `content.schema`, `content.docs`, `content.assets`, `content.webhooks`, and `content.realtime` when enabled.
**Test vectors**: TV-STATUS-001, TV-STATUS-002  
**Notes**: The status endpoint SHOULD be callable without auth in trusted deployments; otherwise it MUST be authorized like other endpoints.

---

## P1 Requirements

### IMP-001: Dataset import/export

**Priority**: P1  
**Statement**: The server MUST support exporting and importing datasets in a deterministic format that preserves documents, assets metadata, schema versions, and revisions.  
**Rationale**: Self-hosted systems need backup/restore and environment promotion.  
**Acceptance criteria**:
- Export returns an artifact with schema + documents + assets metadata + revision history references.
- Import into a new dataset reproduces query results deterministically.
- Importing malformed artifacts returns `VALIDATION_FAILED`.
**Test vectors**: TV-IMP-EXPORT-001, TV-IMP-IMPORT-001, TV-IMP-IMPORT-002  
**Notes**: Asset binary transfer MAY be handled out-of-band; if so, it MUST be documented.

---

### SEARCH-001: Text match and search integration

**Priority**: P1  
**Statement**: The server MUST support a deterministic `match` filter operator (or fail deterministically when not configured) and SHOULD provide a reference integration path for `searchfn` indexing.  
**Rationale**: Editorial and delivery workflows require text discovery.  
**Acceptance criteria**:
- When search is enabled, `match` filters return expected hits deterministically.
- When search is disabled, queries using `match` return `QUERY_INVALID` with a clear message.
**Test vectors**: TV-QRY-MATCH-001, TV-QRY-MATCH-002  
**Notes**: Ranking/scoring is implementation-defined; ordering MUST still be deterministic.

---

### CLI-001: CLI interface (schema and content ops)

**Priority**: P1  
**Statement**: The project MUST provide a CLI that can validate and upsert schema, export/import datasets, and perform basic document operations against a running server.  
**Rationale**: Self-hosted deployments require repeatable automation and migrations.  
**Acceptance criteria**:
- CLI can validate a schema file locally and report deterministic errors.
- CLI can export a dataset and import it into another dataset.
- Invalid CLI inputs produce non-zero exit codes and human-readable errors.
**Test vectors**: TV-CLI-001, TV-CLI-002, TV-CLI-003  
**Notes**: CLI transport (direct DB vs HTTP) is implementation-defined; it MUST be documented.

