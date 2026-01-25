# Requirements (FileFn)

## Table of contents
- PKG-001, PKG-002, PKG-003, PKG-004, PKG-005, PKG-006, PKG-007
- STORAGE-001, STORAGE-002, STORAGE-003, STORAGE-004, STORAGE-005
- SERVER-001, SERVER-002, SERVER-003, SERVER-004
- UPLOAD-001, UPLOAD-002, UPLOAD-003, UPLOAD-004, UPLOAD-005, UPLOAD-006
- FILE-001, FILE-002, FILE-003, FILE-004
- VERSION-001
- DEDUPE-001
- AUTH-001
- AUTHZ-001, AUTHZ-002, AUTHZ-003, AUTHZ-004
- SHARE-001
- POLICY-001
- QUOTA-001
- RATE-001
- PROCESS-001, PROCESS-002, PROCESS-003
- CLIENT-001, CLIENT-002, CLIENT-003
- UI-001
- OBS-001, OBS-002

---

## PKG-001
- ID: PKG-001
- Priority: P0
- Statement: `@superfunctions/storage` MUST exist and define the canonical `StorageAdapter` interface used by FileFn.
- Rationale: Multiple superfunctions (and applications) must share a stable storage contract to avoid duplicated adapter code.
- Acceptance criteria:
  - `@superfunctions/storage` exports `StorageAdapter` and `StorageAdapterCapabilities` (or equivalents) matching SPEC.md.
  - `StorageAdapter.capabilities` gates behavior (signed URLs, multipart, proxy streaming).
- Test vectors: TV-API-BOOT-001 (positive), TV-API-BOOT-NEG-001 (negative)
- Notes:
  - This requirement is satisfied by type-level compile checks plus minimal runtime smoke tests.

## PKG-005
- ID: PKG-005
- Priority: P0
- Statement: `@superfunctions/files` MUST exist and define the canonical `FileProvider` interface used by FileFn and other superfunctions.
- Rationale: Separating file orchestration from storage primitives avoids coupling and keeps adapters minimal.
- Acceptance criteria:
  - `@superfunctions/files` exports `FileProvider` and `FileProviderContext` (or equivalents) matching SPEC.md.
- Test vectors: TV-API-BOOT-001 (positive), TV-API-BOOT-NEG-001 (negative)
- Notes:
  - Implementations should avoid redefining `FileProvider` types outside this package.

## PKG-006
- ID: PKG-006
- Priority: P1
- Statement: `@superfunctions/middleware` MUST provide shared rate limiting primitives used by FileFn.
- Rationale: Rate limiting should be reused across superfunctions (e.g., authfn and filefn) with shared persistence.
- Acceptance criteria:
  - `@superfunctions/middleware` exports `createRateLimiter()` and `RateLimiter` (or equivalents) matching SPEC.md.
  - `createRateLimiter()` accepts persistence via `@superfunctions/db` `Adapter` or `KVStoreAdapter`.
- Test vectors: TV-API-BOOT-001 (positive), TV-RATE-001 (positive), TV-RATE-NEG-001 (negative)
- Notes:
  - FileFn should not ship its own rate limiter implementation.

## PKG-007
- ID: PKG-007
- Priority: P1
- Statement: `@superfunctions/db` MUST export a `KVStoreAdapter` interface for middleware persistence use-cases (e.g., rate limiting).
- Rationale: Middleware needs a minimal KV contract that can be backed by Redis, DynamoDB, SQL, or in-memory stores.
- Acceptance criteria:
  - `@superfunctions/db` exports `KVStoreAdapter` matching SPEC.md.
- Test vectors: TV-API-BOOT-001 (positive), TV-API-BOOT-NEG-001 (negative)
- Notes:
  - This is additive and does not replace the relational `Adapter` interface.

## PKG-002
- ID: PKG-002
- Priority: P1
- Statement: The repository MUST provide `@superfunctions/storage-*` adapter packages for `s3`, `r2`, `gcs`, `azure`, `minio`, and `local`.
- Rationale: FileFn’s core value is provider abstraction.
- Acceptance criteria:
  - Each adapter exports a factory that returns an object implementing `StorageAdapter`.
  - Each adapter declares accurate `capabilities`.
- Test vectors: TV-STORAGE-ADAPTERS-001 (positive), TV-STORAGE-ADAPTERS-NEG-001 (negative)
- Notes:
  - “Negative” here includes mis-declared capabilities causing a conformance test failure.

## PKG-003
- ID: PKG-003
- Priority: P0
- Statement: The repository MUST provide `@filefn/server`, `@filefn/client`, and `@filefn/processing` packages.
- Rationale: The intent requires separate SDKs for server, client, and processing.
- Acceptance criteria:
  - Each package builds and exports the public API shapes defined in SPEC.md.
  - Package boundaries avoid re-exporting unrelated adapters (consumers import adapters directly).
- Test vectors: TV-API-BOOT-001 (positive), TV-API-BOOT-NEG-001 (negative)
- Notes:
  - “Negative” includes missing exports or incorrect package entrypoints.

## PKG-004
- ID: PKG-004
- Priority: P2
- Statement: The repository MUST provide `@uifn/files` with reusable file UX components.
- Rationale: The intent includes a UI library for pricing/plans, uploads, and usage analytics.
- Acceptance criteria:
  - `@uifn/files` exports `PricingPlans`, `UsageAnalytics`, `FileDropzone`, `UploadProgressList`, `FileList`, and `QuotaUsageBar`.
  - Components are framework-agnostic at the API level (props/events), even if implemented per framework.
- Test vectors: TV-UI-001 (positive), TV-UI-NEG-001 (negative), TV-UI-PLANS-001 (positive), TV-UI-PLANS-NEG-001 (negative)
- Notes:
  - The initial framework implementation is not mandated; only API shape + behavior are.

---

## STORAGE-001
- ID: STORAGE-001
- Priority: P0
- Statement: Storage adapters MUST be stateless and safe to share across requests.
- Rationale: Adapters must be plug-in primitives without per-request mutable state.
- Acceptance criteria:
  - Adapter factories accept config and return immutable adapter instances.
  - No adapter method requires prior method calls on the same instance to function correctly.
- Test vectors: TV-STORAGE-STATELESS-001 (positive), TV-STORAGE-STATELESS-NEG-001 (negative)
- Notes:
  - Holding SDK clients (e.g., S3Client) is allowed; request-scoped mutable caches are not.

## STORAGE-002
- ID: STORAGE-002
- Priority: P0
- Statement: `StorageAdapter` MUST expose `capabilities` that accurately describe supported upload/download modes.
- Rationale: FileFn must choose correct flows (signed URL vs proxy streaming).
- Acceptance criteria:
  - If `capabilities.multipart` is true, multipart methods exist and work.
  - If `capabilities.signedUploadUrls` is false, FileFn does not attempt signed upload URLs.
- Test vectors: TV-STORAGE-CAP-001 (positive), TV-STORAGE-CAP-NEG-001 (negative)
- Notes:
  - Capability mismatches must fail a conformance test.

## STORAGE-003
- ID: STORAGE-003
- Priority: P0
- Statement: `StorageAdapter` MUST support `statObject` and `deleteObject` for a storage key.
- Rationale: FileFn must validate and clean up stored bytes.
- Acceptance criteria:
  - `statObject` returns size and key for existing objects.
  - `deleteObject` deletes objects and is safe to retry.
- Test vectors: TV-STORAGE-STAT-001 (positive), TV-STORAGE-STAT-NEG-001 (negative)
- Notes:
  - “Safe to retry” means repeated deletes do not throw fatal errors.

## STORAGE-004
- ID: STORAGE-004
- Priority: P0
- Statement: If `capabilities.multipart` is true, the adapter MUST support create/sign-part/complete/abort multipart upload.
- Rationale: Huge files require multipart.
- Acceptance criteria:
  - `createMultipartUpload` returns a stable `uploadId`.
  - `signMultipartUploadPartUrl` returns a URL suitable for part upload.
  - `completeMultipartUpload` succeeds given recorded part ETags.
  - `abortMultipartUpload` cancels an in-progress upload.
- Test vectors: TV-UPLOAD-MULTIPART-001 (positive), TV-UPLOAD-MULTIPART-NEG-001 (negative)
- Notes:
  - Azure block blobs may map “ETag” to “blockId”; this is acceptable if consistent.

## STORAGE-005
- ID: STORAGE-005
- Priority: P1
- Statement: When supported by the provider, signed upload URLs SHOULD enforce content-type and content-length constraints.
- Rationale: Hardening signed URLs reduces abuse.
- Acceptance criteria:
  - For providers that support constraints, URLs are minted with those constraints.
  - If constraints cannot be enforced by provider, FileFn rejects at `upload/complete` by validating recorded sizes.
- Test vectors: TV-UPLOAD-INIT-001 (positive), TV-UPLOAD-INIT-NEG-002 (negative)
- Notes:
  - This is a SHOULD because enforcement depends on provider.

---

## SERVER-001
- ID: SERVER-001
- Priority: P0
- Statement: `@filefn/server` MUST export a `FileFn` instance/class that implements the `FileProvider` interface from `@superfunctions/files`.
- Rationale: Server SDK is the orchestration layer and must also be consumable as a provider.
- Acceptance criteria:
  - `FileFn` exposes provider methods (create session, sign part, complete, get/list/delete).
  - Methods accept a context containing `principalId` and `tenantId`.
- Test vectors: TV-FILEPROVIDER-001 (positive), TV-FILEPROVIDER-NEG-001 (negative)
- Notes:
  - “Negative” includes calling provider methods with missing permissions.

## SERVER-002
- ID: SERVER-002
- Priority: P0
- Statement: `@filefn/server` MUST expose a `@superfunctions/http` router implementing the HTTP API routes defined in SPEC.md.
- Rationale: Consumers need framework-agnostic HTTP endpoints.
- Acceptance criteria:
  - Router supports upload-session endpoints and file CRUD endpoints.
  - Responses use canonical envelopes for JSON routes.
- Test vectors: TV-UPLOAD-INIT-001 (positive), TV-UPLOAD-INIT-NEG-001 (negative)
- Notes:
  - Streaming responses (proxy download) are exempt from JSON envelope.

## SERVER-003
- ID: SERVER-003
- Priority: P0
- Statement: `@filefn/server` MUST persist file state using `@superfunctions/db` and MUST provide `getSchema()`.
- Rationale: Sessions, permissions, versions, and artifacts require durable state.
- Acceptance criteria:
  - `getSchema()` returns TableSchema entries for files, versions, uploadSessions, uploadParts, permissions, shareLinks, and artifacts.
  - All writes occur through the Adapter interface.
- Test vectors: TV-DB-SCHEMA-001 (positive), TV-DB-SCHEMA-NEG-001 (negative)
- Notes:
  - Exact table names depend on `namespace`.

## SERVER-004
- ID: SERVER-004
- Priority: P1
- Statement: `@filefn/server` MUST support DB namespace isolation via a `namespace` option.
- Rationale: Multiple superfunctions share a DB.
- Acceptance criteria:
  - All DB operations include `namespace`.
  - Index names are namespace-safe.
- Test vectors: TV-DB-NAMESPACE-001 (positive), TV-DB-NAMESPACE-NEG-001 (negative)
- Notes:
  - Mirrors `authfn` schema conventions.

---

## UPLOAD-001
- ID: UPLOAD-001
- Priority: P0
- Statement: FileFn MUST implement resumable upload sessions with init/status/sign-part/part-complete/complete/abort operations.
- Rationale: Resumability is a core problem statement requirement.
- Acceptance criteria:
  - `POST /upload/init` creates a session.
  - `GET /upload/:id/status` returns recorded parts.
  - `POST /upload/:id/parts/:n/sign` returns signed URL (or proxy instructions).
  - `POST /upload/:id/parts/:n/complete` records an ETag.
  - `POST /upload/:id/complete` creates a file version.
  - `POST /upload/:id/abort` aborts and prevents completion.
- Test vectors: TV-UPLOAD-INIT-001 (positive), TV-UPLOAD-COMPLETE-NEG-001 (negative)
- Notes:
  - “Abort then complete” must fail deterministically.

## UPLOAD-002
- ID: UPLOAD-002
- Priority: P0
- Statement: `POST /upload/init` MUST enforce policy constraints (content types, max size, storage path).
- Rationale: Policies are the mechanism for granular control.
- Acceptance criteria:
  - Disallowed `mimeType` is rejected.
  - Size exceeding policy is rejected.
  - Storage path is derived from policy and stored on session.
- Test vectors: TV-UPLOAD-INIT-001 (positive), TV-UPLOAD-INIT-NEG-001 (negative)
- Notes:
  - Policy access hooks may further restrict.

## UPLOAD-003
- ID: UPLOAD-003
- Priority: P0
- Statement: `POST /upload/init` MUST enforce quota checks via the configured `QuotaProvider` when present.
- Rationale: Storage quota is a first-class constraint.
- Acceptance criteria:
  - If quota provider denies, init fails with `FILEFN_QUOTA_EXCEEDED`.
  - If quota provider warns, response includes a warning.
- Test vectors: TV-UPLOAD-INIT-001 (positive), TV-QUOTA-NEG-001 (negative)
- Notes:
  - Quota must be re-checked at completion.

## UPLOAD-004
- ID: UPLOAD-004
- Priority: P1
- Statement: Upload init and complete MUST be idempotent when `x-idempotency-key` is provided.
- Rationale: Clients must safely retry on flaky networks.
- Acceptance criteria:
  - Repeating init with same key returns same `uploadSessionId`.
  - Repeating complete returns the same `(fileId, versionId)`.
- Test vectors: TV-IDEMPOTENCY-001 (positive), TV-IDEMPOTENCY-NEG-001 (negative)
- Notes:
  - “Negative” includes using same key with different payload causing conflict.

## UPLOAD-005
- ID: UPLOAD-005
- Priority: P0
- Statement: FileFn MUST select upload mode based on adapter capabilities and MUST support a proxy upload fallback.
- Rationale: Not all providers can mint signed URLs.
- Acceptance criteria:
  - With signed URL capable adapter, part signing returns URLs.
  - With non-signed adapter, server accepts chunk bytes and writes via `openUploadStream`.
- Test vectors: TV-UPLOAD-MODE-001 (positive), TV-UPLOAD-MODE-NEG-001 (negative)
- Notes:
  - Fallback behavior is capability-gated.

## UPLOAD-006
- ID: UPLOAD-006
- Priority: P2
- Statement: Upload sessions MUST expire after a configured TTL and MUST be garbage-collectable.
- Rationale: Prevent unbounded storage/cost from abandoned sessions.
- Acceptance criteria:
  - Expired sessions cannot be completed.
  - A cleanup routine can remove expired session records and abort provider multipart uploads when supported.
- Test vectors: TV-UPLOAD-EXPIRE-001 (positive), TV-UPLOAD-EXPIRE-NEG-001 (negative)
- Notes:
  - Cleanup scheduling is implementation-defined.

---

## FILE-001
- ID: FILE-001
- Priority: P0
- Statement: FileFn MUST support reading file metadata and listing files accessible to the principal.
- Rationale: Core file management.
- Acceptance criteria:
  - `GET /:fileId` returns metadata for current version.
  - `GET /` returns only accessible files (owned, shared, public within policy).
- Test vectors: TV-FILE-GET-001 (positive), TV-FILE-GET-NEG-001 (negative)
- Notes:
  - List filtering may be implemented via authorizer filters.

## FILE-002
- ID: FILE-002
- Priority: P0
- Statement: FileFn MUST support downloading via signed URL (or proxy stream) with authorization enforced.
- Rationale: Downloads are part of the required API surface.
- Acceptance criteria:
  - `GET /:fileId/download` returns a signed URL (or streams) only when authorized.
- Test vectors: TV-FILE-DOWNLOAD-001 (positive), TV-FILE-DOWNLOAD-NEG-001 (negative)
- Notes:
  - Optional redirect mode is allowed.

## FILE-003
- ID: FILE-003
- Priority: P0
- Statement: FileFn MUST support deleting files and freeing quota usage.
- Rationale: Lifecycle management and quota correctness.
- Acceptance criteria:
  - `DELETE /:fileId` deletes underlying objects and metadata.
  - Quota provider is called with negative usage equal to bytes freed.
- Test vectors: TV-FILE-DELETE-001 (positive), TV-FILE-DELETE-NEG-001 (negative)
- Notes:
  - Hard delete is the default.

## FILE-004
- ID: FILE-004
- Priority: P1
- Statement: FileFn MUST support replacing a file by creating a new `FileVersion` under an existing `fileId`.
- Rationale: Versioning is explicitly required.
- Acceptance criteria:
  - Upload init can target an existing `fileId`.
  - Completion creates a new version and updates current version pointer.
- Test vectors: TV-VERSION-REPLACE-001 (positive), TV-VERSION-REPLACE-NEG-001 (negative)
- Notes:
  - Authorization must require write permission.

---

## VERSION-001
- ID: VERSION-001
- Priority: P1
- Statement: FileFn MUST expose version history and allow downloading a specific version.
- Rationale: Users need rollback and audit.
- Acceptance criteria:
  - `GET /:fileId/versions` returns ordered versions.
  - `GET /:fileId/versions/:versionId/download` returns access to that version.
- Test vectors: TV-VERSION-LIST-001 (positive), TV-VERSION-LIST-NEG-001 (negative)
- Notes:
  - Version ordering is newest-first.

## DEDUPE-001
- ID: DEDUPE-001
- Priority: P2
- Statement: When deduplication is enabled, FileFn MUST avoid storing duplicate bytes for identical content within the same tenant.
- Rationale: Cost and efficiency.
- Acceptance criteria:
  - SHA-256 is computed for completed versions.
  - A second upload of identical bytes within the tenant does not write a second physical object.
- Test vectors: TV-DEDUP-001 (positive), TV-DEDUP-NEG-001 (negative)
- Notes:
  - Cross-tenant dedupe is forbidden.

---

## AUTH-001
- ID: AUTH-001
- Priority: P0
- Statement: FileFn MUST support optional authentication via `@superfunctions/auth` provider and/or a custom session resolver, and MUST support cached session retrieval via `AuthProvider.getSession()` when available.
- Rationale: Must integrate with authfn or any auth system while avoiding redundant authentication work per request.
- Acceptance criteria:
  - If configured and auth is required, missing session yields `401 FILEFN_AUTH_REQUIRED`.
  - If not configured, principal is null and policies/authorizers determine access.
  - If `auth.provider.getSession` exists, FileFn MUST consult it before calling `auth.provider.authenticate`.
- Test vectors: TV-AUTH-001 (positive), TV-AUTH-NEG-001 (negative), TV-AUTH-SESSION-CACHE-001 (positive), TV-AUTH-SESSION-CACHE-NEG-001 (negative)
- Notes:
  - Session-to-principal mapping is configurable.

## AUTHZ-001
- ID: AUTHZ-001
- Priority: P0
- Statement: FileFn MUST enforce authorization for all file operations via a pluggable `Authorizer` interface.
- Rationale: Granular access control is a core requirement.
- Acceptance criteria:
  - Each route performs an authorization check with a resource + action.
  - Denials return `403 FILEFN_FORBIDDEN`.
- Test vectors: TV-FILE-GET-001 (positive), TV-FILE-GET-NEG-001 (negative)
- Notes:
  - Authorizer may return filters for list endpoints.

## AUTHZ-002
- ID: AUTHZ-002
- Priority: P0
- Statement: FileFn MUST support explicit permission grants to user/role/tenant with optional expiration.
- Rationale: Sharing requires durable grants.
- Acceptance criteria:
  - Grants can be created, listed, and revoked.
  - Expired grants are ignored.
- Test vectors: TV-PERM-GRANT-001 (positive), TV-PERM-GRANT-NEG-001 (negative)
- Notes:
  - Owner and admin bypass grants.

## AUTHZ-003
- ID: AUTHZ-003
- Priority: P1
- Statement: FileFn MUST support visibility levels `private`, `shared`, and `public` as baseline authorization behavior.
- Rationale: Visibility is an explicit part of the intent’s suggested model.
- Acceptance criteria:
  - `public` allows read(content) without explicit grants.
  - `shared` allows read(content) within tenant, subject to policy.
  - `private` requires owner/admin/grant.
- Test vectors: TV-VISIBILITY-001 (positive), TV-VISIBILITY-NEG-001 (negative)
- Notes:
  - Visibility can be overridden by policy access hooks.

## AUTHZ-004
- ID: AUTHZ-004
- Priority: P2
- Statement: `@filefn/server` MUST export `composeAuthorizers()` to combine multiple `Authorizer` implementations into one.
- Rationale: FileFn must support flexible authorization composition (ownership + ACL + custom rules).
- Acceptance criteria:
  - `composeAuthorizers([a,b], { strategy: 'first-allow' })` returns allow if any authorizer allows.
  - `composeAuthorizers([a,b], { strategy: 'all-must-allow' })` returns allow only if all allow.
  - Denial reasons are deterministic and do not leak secrets.
- Test vectors: TV-AUTHZ-COMPOSE-001 (positive), TV-AUTHZ-COMPOSE-NEG-001 (negative)
- Notes:
  - This helper is a pure function and is safe for use in application code.

## SHARE-001
- ID: SHARE-001
- Priority: P1
- Statement: FileFn MUST support share links with token, expiration, optional auth requirement, max downloads, and revocation.
- Rationale: Public sharing is a common file workflow.
- Acceptance criteria:
  - Share link create returns a token exactly once.
  - Token download is authorized by link constraints.
  - Revoked/expired links fail.
- Test vectors: TV-SHARE-CREATE-001 (positive), TV-SHARE-DOWNLOAD-NEG-001 (negative)
- Notes:
  - Token storage uses hashes.

## POLICY-001
- ID: POLICY-001
- Priority: P0
- Statement: FileFn MUST support defining policies that constrain uploads and influence storage paths and access.
- Rationale: Policies are the primary mechanism for fine-grained file rules.
- Acceptance criteria:
  - A policy defines contentTypes, maxSizeBytes, visibility, and storagePath function.
  - Upload init rejects uploads that violate policy.
- Test vectors: TV-POLICY-LIST-001 (positive), TV-UPLOAD-INIT-NEG-001 (negative)
- Notes:
  - Policy access hooks can add additional restrictions.

---

## QUOTA-001
- ID: QUOTA-001
- Priority: P0
- Statement: When a `QuotaProvider` is configured, FileFn MUST enforce storage quotas and record usage on completion and deletion.
- Rationale: Storage quota management is explicitly required (billfn plugin expected).
- Acceptance criteria:
  - Quota checked at upload init and complete.
  - Usage recorded after completion.
  - Negative usage recorded after delete.
- Test vectors: TV-UPLOAD-COMPLETE-001 (positive), TV-FILE-DELETE-001 (positive), TV-QUOTA-NEG-001 (negative)
- Notes:
  - Quota provider interface is minimal and reusable across superfunctions.

## RATE-001
- ID: RATE-001
- Priority: P1
- Statement: When rate limiting is configured, FileFn MUST enforce limits using `@superfunctions/middleware` and MUST reject requests exceeding limits with `429 FILEFN_RATE_LIMITED`.
- Rationale: Protects resources and prevents abuse while keeping rate limiting logic shared across superfunctions.
- Acceptance criteria:
  - Upload init/sign/download have separate counters as configured.
  - Response includes reset information.
- Test vectors: TV-RATE-001 (positive), TV-RATE-NEG-001 (negative)
- Notes:
  - Rate limiting keys should incorporate principalId and route category (tenantId where applicable).

---

## PROCESS-001
- ID: PROCESS-001
- Priority: P1
- Statement: FileFn MUST emit lifecycle events for uploads, deletes, and processing.
- Rationale: The intent requires event emitters and hooks for custom workflows.
- Acceptance criteria:
  - Events are emitted for `file:uploaded` and `file:deleted` at minimum.
  - Event payloads include identifiers and requestId.
- Test vectors: TV-OBS-001 (positive), TV-OBS-NEG-001 (negative)
- Notes:
  - Event ordering is best-effort except within a single request.

## PROCESS-002
- ID: PROCESS-002
- Priority: P2
- Statement: `@filefn/processing` MUST define processor contracts and provide built-in processors for thumbnails, compression, image transforms, OCR, video, and audio.
- Rationale: Processing and workflows are explicitly required.
- Acceptance criteria:
  - Processor interfaces exist and are used by server.
  - Built-in processors are selectable by configuration.
- Test vectors: TV-PROCESS-001 (positive), TV-PROCESS-NEG-001 (negative)
- Notes:
  - Heavy processors (video/audio) may run in dedicated worker environments.

## PROCESS-003
- ID: PROCESS-003
- Priority: P1
- Statement: When FlowFn is provided, FileFn SHOULD enqueue processing asynchronously and retry failures idempotently.
- Rationale: Processing should not block HTTP.
- Acceptance criteria:
  - Upload completion enqueues a processing job.
  - Retried jobs do not duplicate artifacts.
- Test vectors: TV-PROCESS-FLOW-001 (positive), TV-PROCESS-FLOW-NEG-001 (negative)
- Notes:
  - This is SHOULD because FlowFn is optional.

---

## CLIENT-001
- ID: CLIENT-001
- Priority: P0
- Statement: `@filefn/client` MUST support resumable multipart uploads with progress callbacks and retries.
- Rationale: Client-side resumability is explicit in the intent.
- Acceptance criteria:
  - Client can init, sign parts, upload parts, record parts, and complete.
  - Client can resume from status by re-uploading only missing parts.
- Test vectors: TV-CLIENT-UPLOAD-001 (positive), TV-CLIENT-UPLOAD-NEG-001 (negative)
- Notes:
  - Retry delays are configurable.

## CLIENT-002
- ID: CLIENT-002
- Priority: P2
- Statement: When offline mode is enabled, `@filefn/client` MUST stage uploads in OPFS and sync when online.
- Rationale: Offline caching/sync is part of the intent.
- Acceptance criteria:
  - Client persists pending uploads in OPFS.
  - Client resumes and completes uploads when connectivity returns.
- Test vectors: TV-CLIENT-OFFLINE-001 (positive), TV-CLIENT-OFFLINE-NEG-001 (negative)
- Notes:
  - If OPFS is unavailable, behavior is implementation-defined (may fall back or error).

## CLIENT-003
- ID: CLIENT-003
- Priority: P1
- Statement: `@filefn/client` MUST expose framework-agnostic primitives/hooks for upload state.
- Rationale: The intent requests framework-agnostic hooks.
- Acceptance criteria:
  - Upload handle exposes `onProgress` and `abort`.
- Test vectors: TV-CLIENT-HOOKS-001 (positive), TV-CLIENT-HOOKS-NEG-001 (negative)
- Notes:
  - Framework adapters can be implemented in `@uifn/files`.

---

## UI-001
- ID: UI-001
- Priority: P2
- Statement: `@uifn/files` MUST provide components for pricing/plans, uploading, progress, file listing, and quota usage/analytics.
- Rationale: UI scope is explicit.
- Acceptance criteria:
  - `PricingPlans` renders available plans and allows selecting a plan.
  - `UsageAnalytics` renders quota usage and basic usage breakdown.
  - `FileDropzone` handles drag/drop and file selection.
  - `QuotaUsageBar` displays used/limit and warning state.
- Test vectors: TV-UI-001 (positive), TV-UI-NEG-001 (negative), TV-UI-PLANS-001 (positive), TV-UI-PLANS-NEG-001 (negative)
- Notes:
  - UI components integrate with `@filefn/client` and/or a billing client chosen by the application.

---

## OBS-001
- ID: OBS-001
- Priority: P0
- Statement: FileFn MUST integrate with LogFn when provided and MUST NOT log secrets (signed URLs, share tokens).
- Rationale: Observability is required without leaking sensitive data.
- Acceptance criteria:
  - Logs include requestId, fileId, uploadSessionId.
  - Signed URLs and share tokens are redacted or omitted.
- Test vectors: TV-OBS-LOG-001 (positive), TV-OBS-LOG-NEG-001 (negative)
- Notes:
  - Use logfn pipeline redaction where appropriate.

## OBS-002
- ID: OBS-002
- Priority: P1
- Statement: All HTTP error responses MUST include a stable `error.code` and SHOULD include `requestId`.
- Rationale: Clients and UIs need stable error handling.
- Acceptance criteria:
  - Errors return canonical error envelope.
  - Codes are enumerated and documented.
- Test vectors: TV-ERROR-001 (positive), TV-ERROR-NEG-001 (negative)
- Notes:
  - Error codes are defined in TEST_VECTORS.md and SPEC.md semantics.
