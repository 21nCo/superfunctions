# Requirements (FileFn audit-fix: k7n2m9p4)

This requirements bundle defines the **fix scope** required to resolve the issues found in:
- `filefn/.conduct/issues/ISSUE_REPORT.md`
- `filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/audits/2026-01-25-nmzf1tn9-spec-audit.md`

The authoritative target contracts are those in `filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec` (spec_id `h3m9k2s`).

## Table of contents
- CLIENT-001
- CLIENT-002
- SERVER-001
- SERVER-002
- POLICY-001
- FILE-001
- FILE-002
- FILE-004
- VERSION-001
- DEDUPE-001
- UPLOAD-004
- UPLOAD-005
- UPLOAD-006
- STORAGE-001
- STORAGE-002
- STORAGE-005
- AUTHZ-001
- AUTHZ-003
- AUTHZ-004
- PKG-007
- PKG-006
- RATE-001
- PROCESS-001
- PROCESS-003
- OBS-001

## DEDUPE-001
- ID: DEDUPE-001
- Priority: P2
- Statement: When deduplication is enabled, FileFn MUST avoid storing duplicate bytes for identical content within the same tenant.
- Rationale: The audit reports a tenant-scoped dedupe service exists but is not configurable/wired through the public `createFileFn` API.
- Acceptance criteria:
  - FileFn config exposes `deduplication: { enabled, scope: 'tenant', algorithm: 'sha256' }`.
  - On upload completion, FileFn computes SHA-256 over the stored bytes and checks for an existing identical hash within the same tenant.
  - If a duplicate is found within the tenant, FileFn does not write duplicate bytes and instead references/reuses existing stored bytes.
  - Cross-tenant dedupe MUST NOT occur.
- Test vectors: TV-DEDUP-001 (positive), TV-DEDUP-NEG-001 (negative)
- Notes:
  - The byte reuse strategy is implementation-defined (e.g., reference existing storageKey) as long as it is tenant-safe.

---

## CLIENT-001
- ID: CLIENT-001
- Priority: P0
- Statement: `@filefn/client` MUST implement the canonical upload flow and public API shapes from the audited spec, including correct request fields and canonical envelope handling.
- Rationale: The issue report identifies client/server mismatches that block uploads; the audit identifies broader client API divergence.
- Acceptance criteria:
  - `createFileFnClient()` exposes `uploadFile`, `getFile`, `downloadUrl`, `deleteFile` with the signatures in SPEC.md.
  - `uploadFile()` sends `POST /upload/init` with `{ size, mimeType }` (not `fileSize`/`contentType`).
  - The client HTTP layer unwraps `{ ok: true, data }` responses and returns `data` to higher-level methods.
  - The client surfaces `{ ok: false, error }` as a structured error including `error.code` and `requestId` when present.
  - `UploadHandle.done()` returns `{ fileId, versionId }` from `POST /upload/:id/complete`.
- Test vectors: TV-CLIENT-UPLOAD-001 (positive), TV-CLIENT-ENVELOPE-UNWRAP-001 (positive), TV-CLIENT-UPLOAD-NEG-001 (negative)
- Notes:
  - This requirement is satisfied even when the server returns `warnings` and `requestId` fields in the envelope.

## CLIENT-002
- ID: CLIENT-002
- Priority: P2
- Statement: When offline mode is enabled, `@filefn/client` MUST stage uploads in OPFS and sync them when connectivity returns.
- Rationale: Offline mode exists in the codebase but is not integrated behind the canonical client config.
- Acceptance criteria:
  - `FileFnClientConfig.offline.enabled` gates offline behavior.
  - When offline and OPFS is available, uploads are staged and later resumed to completion.
  - When offline is enabled but OPFS is unavailable, the client fails with `FILEFN_OFFLINE_UNSUPPORTED`.
- Test vectors: TV-CLIENT-OFFLINE-001 (positive), TV-CLIENT-OFFLINE-NEG-001 (negative)
- Notes:
  - The exact OPFS directory layout is implementation-defined but MUST be deterministic given `opfsDir`.

## SERVER-001
- ID: SERVER-001
- Priority: P0
- Statement: `@filefn/server` MUST implement the `FileProvider` interface semantics from the audited spec, including correct `versionId` handling.
- Rationale: The audit reports partial conformance (e.g., `getFile` ignores `versionId`).
- Acceptance criteria:
  - Provider methods exist and accept a `FileProviderContext` with `principalId`, `tenantId`, and `requestId`.
  - `getFile({ fileId, versionId? })` returns metadata for the requested version when `versionId` is provided (subject to authorization).
  - Provider methods enforce authorization per AUTHZ-001.
- Test vectors: TV-FILEPROVIDER-001 (positive), TV-FILEPROVIDER-NEG-001 (negative), TV-VERSION-GET-001 (positive)
- Notes:
  - Returning 404 for a non-existent versionId is allowed and preferred over leaking cross-file version existence.

## SERVER-002
- ID: SERVER-002
- Priority: P0
- Statement: `@filefn/server` MUST expose an HTTP router implementing the audited spec routes and MUST use canonical JSON envelopes for control-plane responses.
- Rationale: Client/server mismatches and missing routes cause runtime failures and audit non-compliance.
- Acceptance criteria:
  - Control-plane routes return `{ ok: true, data }` on success and `{ ok: false, error }` on failure.
  - `POST /upload/init` parses `{ size, mimeType }` and returns `data.uploadSessionId`.
  - Missing audited routes are implemented:
    - `GET /policies`
    - `GET /quota/storage` (when `quota.getUsage` exists)
    - `GET /:fileId/versions/:versionId` (version metadata)
  - `GET /:fileId/versions/:versionId/download` validates the version belongs to the file (VERSION-001).
- Test vectors: TV-UPLOAD-INIT-001 (positive), TV-POLICY-LIST-001 (positive), TV-QUOTA-GET-001 (positive), TV-VERSION-GET-001 (positive), TV-UPLOAD-INIT-NEG-001 (negative)
- Notes:
  - Streaming data-plane endpoints (proxy download) are exempt from JSON envelopes.

## POLICY-001
- ID: POLICY-001
- Priority: P0
- Statement: FileFn MUST expose policies that constrain uploads and MUST implement `GET /policies` to list policy constraints.
- Rationale: The audit reports `/policies` missing; the issue report depends on correct policy enforcement for content types.
- Acceptance criteria:
  - Policies define `contentTypes`, `maxSizeBytes`, `visibility`, and `storagePath`.
  - `GET /policies` returns the list of policy names and their constraints.
  - Upload init rejects disallowed `mimeType` with `FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED`.
- Test vectors: TV-POLICY-LIST-001 (positive), TV-UPLOAD-INIT-NEG-001 (negative)
- Notes:
  - Policy access hooks are allowed but not required for this audit-fix unless already present in the audited spec.

## FILE-001
- ID: FILE-001
- Priority: P0
- Statement: FileFn MUST list and return file metadata for files accessible to the principal (owned, granted, shared, public).
- Rationale: The audit reports list behavior returns only owned files and does not reflect accessibility semantics.
- Acceptance criteria:
  - `GET /` returns only files readable by the principal according to AUTHZ-001 + visibility semantics.
  - Anonymous listing includes public files only (and excludes private/shared).
  - List is deterministic for the same dataset and ordering strategy.
- Test vectors: TV-FILE-LIST-001 (positive), TV-FILE-LIST-NEG-001 (negative)
- Notes:
  - List filtering MAY be implemented by applying authorizer-provided filters.

## FILE-002
- ID: FILE-002
- Priority: P0
- Statement: FileFn MUST support downloading via signed URL or proxy streaming with authorization enforced.
- Rationale: The audit reports a `proxy://...` placeholder without a working proxy stream implementation.
- Acceptance criteria:
  - If `StorageAdapter.capabilities.signedDownloadUrls` is true, `GET /:fileId/download` returns a signed URL.
  - If `signedDownloadUrls` is false and `proxyStreamingDownload` is true, `GET /:fileId/download` returns a proxy URL and the proxy endpoint streams bytes.
  - Authorization is enforced for both signed and proxy download modes.
- Test vectors: TV-FILE-DOWNLOAD-001 (positive), TV-FILE-DOWNLOAD-PROXY-001 (positive), TV-FILE-DOWNLOAD-NEG-001 (negative)
- Notes:
  - Range requests are optional but SHOULD be supported when possible.

## FILE-004
- ID: FILE-004
- Priority: P1
- Statement: FileFn MUST support replacing a file by creating a new `FileVersion` under an existing `fileId` and MUST enforce write authorization for replacement.
- Rationale: The audit identifies a replace-by-fileId authorization vulnerability.
- Acceptance criteria:
  - `POST /upload/init` accepts `fileId` for replacement.
  - Replacement requires `write` authorization on the target file.
  - Completion updates `files.currentVersionId` only when authorized.
- Test vectors: TV-VERSION-REPLACE-001 (positive), TV-VERSION-REPLACE-NEG-001 (negative)
- Notes:
  - Denials must return `403 FILEFN_FORBIDDEN`.

## VERSION-001
- ID: VERSION-001
- Priority: P1
- Statement: FileFn MUST expose version history and MUST allow downloading and reading metadata for a specific version bound to a file.
- Rationale: The audit reports missing metadata route and a binding bug where version download does not verify `fileId`.
- Acceptance criteria:
  - `GET /:fileId/versions` lists versions in deterministic newest-first order.
  - `GET /:fileId/versions/:versionId` returns version metadata only when `versionId` belongs to `fileId`.
  - `GET /:fileId/versions/:versionId/download` rejects if `versionId` does not belong to `fileId`.
- Test vectors: TV-VERSION-LIST-001 (positive), TV-VERSION-GET-001 (positive), TV-VERSION-DOWNLOAD-BINDING-NEG-001 (negative)
- Notes:
  - Binding mismatch SHOULD return `404 FILEFN_NOT_FOUND`.

## UPLOAD-004
- ID: UPLOAD-004
- Priority: P1
- Statement: Upload init and upload complete MUST be idempotent when `x-idempotency-key` is provided, and part completion MUST be idempotent for the tuple `(uploadSessionId, partNumber, etag)`.
- Rationale: The audit reports init idempotency exists but payload hashing is incomplete, complete is not stable, and part completion is last-write-wins.
- Acceptance criteria:
  - Repeating init with the same idempotency key and same payload returns the same `uploadSessionId`.
  - Reusing the same idempotency key with a different payload returns `409 FILEFN_IDEMPOTENCY_CONFLICT`.
  - Repeating complete after success returns the same `(fileId, versionId)` regardless of later replacements.
  - Repeating part completion with the same `(session, partNumber, etag)` is a no-op success.
  - Completing the same `partNumber` with a different `etag` fails deterministically with `409 FILEFN_PART_CONFLICT`.
- Test vectors: TV-IDEMPOTENCY-001 (positive), TV-IDEMPOTENCY-NEG-001 (negative), TV-UPLOAD-PART-COMPLETE-IDEMP-001 (positive), TV-UPLOAD-PART-COMPLETE-IDEMP-NEG-001 (negative), TV-UPLOAD-COMPLETE-IDEMP-001 (positive), TV-UPLOAD-COMPLETE-IDEMP-NEG-001 (negative)
- Notes:
  - Idempotency scoping SHOULD include principalId/tenantId to avoid cross-actor collisions.

## UPLOAD-005
- ID: UPLOAD-005
- Priority: P0
- Statement: FileFn MUST select upload mode based on adapter capabilities and MUST support a proxy upload fallback.
- Rationale: The audit reports proxy mode is selectable but not implemented, blocking uploads for some adapters (e.g., local).
- Acceptance criteria:
  - If signed URL upload is supported, sign-part returns a storage URL.
  - If signed URL upload is not supported but `proxyStreamingUpload` is supported, sign-part returns a FileFn proxy upload URL.
  - `PUT /upload/:uploadSessionId/parts/:partNumber` accepts bytes and records the part.
  - If neither mode is supported, init fails with `FILEFN_NO_SUPPORTED_UPLOAD_MODE`.
- Test vectors: TV-UPLOAD-PROXY-001 (positive), TV-UPLOAD-MODE-NEG-001 (negative)
- Notes:
  - Proxy mode storage strategy for part bytes is implementation-defined but MUST be deterministic and reliable enough for completion.

## UPLOAD-006
- ID: UPLOAD-006
- Priority: P2
- Statement: Upload sessions MUST expire after a configured TTL and MUST be garbage-collectable.
- Rationale: The audit reports no cleanup routine and incomplete abort cleanup.
- Acceptance criteria:
  - Expired sessions cannot be completed and return `410 FILEFN_UPLOAD_EXPIRED`.
  - A cleanup routine can remove expired session records and abort provider multipart uploads when supported.
  - Cleanup MUST NOT delete non-expired sessions.
- Test vectors: TV-UPLOAD-EXPIRE-001 (positive), TV-UPLOAD-GC-001 (positive), TV-UPLOAD-GC-NEG-001 (negative)
- Notes:
  - Scheduling of cleanup is implementation-defined; the existence of an exported/manual cleanup entrypoint is sufficient.

## STORAGE-001
- ID: STORAGE-001
- Priority: P0
- Statement: Storage adapters MUST be stateless and safe to share across requests.
- Rationale: The audit reports `storage-azure` uses per-instance mutable state.
- Acceptance criteria:
  - Adapter methods do not require call ordering on the same instance to function.
  - Azure adapter multipart signing/completion works without relying on an in-memory `activeUploads` map.
- Test vectors: TV-STORAGE-AZURE-STATELESS-001 (positive), TV-STORAGE-STATELESS-NEG-001 (negative)
- Notes:
  - Persisting multipart correlation in FileFn DB is allowed; per-instance mutable maps are not.

## STORAGE-002
- ID: STORAGE-002
- Priority: P0
- Statement: `StorageAdapter.capabilities` MUST accurately describe supported upload/download modes and FileFn MUST gate behavior on those capabilities.
- Rationale: The audit reports FileFn selects proxy but still calls signed-url multipart methods.
- Acceptance criteria:
  - When `signedUploadUrls=false`, FileFn MUST NOT call `signMultipartUploadPartUrl`.
  - When `proxyStreamingUpload=false`, FileFn MUST NOT advertise/select proxy mode.
- Test vectors: TV-STORAGE-CAP-001 (positive), TV-STORAGE-CAP-NEG-001 (negative)
- Notes:
  - Capability gating must be covered by unit tests using fake adapters.

## STORAGE-005
- ID: STORAGE-005
- Priority: P1
- Statement: When provider-level constraints cannot be enforced, FileFn MUST validate uploaded bytes at completion and reject mismatches.
- Rationale: The audit reports missing completion-time size reconciliation.
- Acceptance criteria:
  - FileFn validates total bytes (and per-part when applicable) against expected `size` at `POST /upload/:id/complete`.
  - On mismatch, completion fails deterministically with `409 FILEFN_UPLOAD_SIZE_MISMATCH`.
- Test vectors: TV-UPLOAD-COMPLETE-001 (positive), TV-UPLOAD-COMPLETE-VALIDATE-SIZE-NEG-001 (negative)
- Notes:
  - Validation may use `StorageAdapter.statObject` after multipart completion.

## AUTHZ-001
- ID: AUTHZ-001
- Priority: P0
- Statement: FileFn MUST enforce authorization for all file operations via a pluggable `Authorizer` interface.
- Rationale: The audit reports incomplete authz enforcement, including a critical replace vulnerability.
- Acceptance criteria:
  - Upload init/sign/part-complete/complete/download/list/delete routes perform authorization checks using `{ resource, action }`.
  - Denials return `403 FILEFN_FORBIDDEN`.
  - List operations apply authorizer filters when provided.
- Test vectors: TV-FILE-GET-001 (positive), TV-FILE-GET-NEG-001 (negative), TV-VERSION-REPLACE-NEG-001 (negative)
- Notes:
  - Authorization MUST be enforced even when authentication is optional.

## AUTHZ-003
- ID: AUTHZ-003
- Priority: P1
- Statement: FileFn MUST support visibility levels `private`, `shared`, and `public` as baseline authorization behavior.
- Rationale: The audit reports `shared` is partially implemented but not end-to-end supported.
- Acceptance criteria:
  - `public` allows read(content) without explicit grants.
  - `shared` allows read(content) within tenant.
  - `private` requires owner/admin/grant.
- Test vectors: TV-VISIBILITY-001 (positive), TV-VISIBILITY-NEG-001 (negative)
- Notes:
  - Policy access hooks may further restrict.

## AUTHZ-004
- ID: AUTHZ-004
- Priority: P2
- Statement: `@filefn/server` MUST export `composeAuthorizers(authorizers, options?)` matching the audited spec signature and semantics.
- Rationale: The audit reports a signature mismatch.
- Acceptance criteria:
  - `composeAuthorizers([a,b], { strategy: 'first-allow' })` allows if any allows.
  - `composeAuthorizers([a,b], { strategy: 'all-must-allow' })` allows only if all allow.
- Test vectors: TV-AUTHZ-COMPOSE-001 (positive), TV-AUTHZ-COMPOSE-NEG-001 (negative)
- Notes:
  - Denial reasons must be deterministic.

## PKG-007
- ID: PKG-007
- Priority: P1
- Statement: `@superfunctions/db` MUST export a `KVStoreAdapter` interface matching the audited spec.
- Rationale: Rate limiting primitives depend on a stable KV interface.
- Acceptance criteria:
  - `KVStoreAdapter.set({ key, value, ttlSeconds? })` uses seconds (not ms) and accepts an object input.
  - `KVStoreAdapter.incr` exists as an optional atomic helper.
- Test vectors: TV-KVSTORE-001 (positive), TV-KVSTORE-NEG-001 (negative)
- Notes:
  - This is additive; it must not break existing relational Adapter interfaces.

## PKG-006
- ID: PKG-006
- Priority: P1
- Statement: `@superfunctions/middleware` MUST export rate limiting primitives matching the audited spec.
- Rationale: The audit reports rate limiter API mismatch and inconsistent resetAt formats.
- Acceptance criteria:
  - `createRateLimiter({ persistence, algorithm?, prefix? })` exists.
  - `RateLimiter.check({ key, windowSeconds, limit })` returns `{ allowed, remaining, resetAt: ISO8601 }`.
- Test vectors: TV-RATE-001 (positive), TV-RATE-NEG-001 (negative)
- Notes:
  - The implementation may support additional algorithms, but the exported API must match.

## RATE-001
- ID: RATE-001
- Priority: P1
- Statement: When rate limiting is configured, FileFn MUST enforce limits and MUST reject requests exceeding limits with `429 FILEFN_RATE_LIMITED` including ISO8601 reset information.
- Rationale: The audit reports FileFn uses a different rate limiter shape and uses numeric resetAt.
- Acceptance criteria:
  - FileFn config uses `rateLimit` object per audited spec (not a pre-built limiter).
  - Over-the-limit requests return canonical error envelope with `error.code=FILEFN_RATE_LIMITED`.
  - `error.details.resetAt` is ISO8601.
- Test vectors: TV-RATE-NEG-001 (positive), TV-RATE-001 (positive)
- Notes:
  - Separate rate limits per route category must be supported.

## PROCESS-001
- ID: PROCESS-001
- Priority: P1
- Statement: FileFn MUST emit lifecycle events with canonical names for uploads and deletes.
- Rationale: The audit reports event names diverge from spec/test vectors.
- Acceptance criteria:
  - At minimum, `file:uploaded` and `file:deleted` are emitted.
  - Event payload includes `fileId`, `versionId` (when applicable), and `requestId` (when available).
  - Event payload MUST NOT contain signed URLs.
- Test vectors: TV-OBS-001 (positive), TV-OBS-NEG-001 (negative)
- Notes:
  - Additional event names from the audited spec may be emitted.

## PROCESS-003
- ID: PROCESS-003
- Priority: P1
- Statement: When FlowFn is provided, FileFn SHOULD enqueue processing asynchronously after upload completion and SHOULD retry failures idempotently.
- Rationale: The audit reports processing enqueue is not triggered on upload completion.
- Acceptance criteria:
  - When processing is enabled, upload completion triggers processing.
  - When FlowFn is present, a processing job is enqueued.
  - Replays of the same job do not duplicate artifacts.
- Test vectors: TV-PROCESS-001 (positive), TV-PROCESS-NEG-001 (negative), TV-PROCESS-FLOW-001 (positive), TV-PROCESS-FLOW-NEG-001 (negative)
- Notes:
  - This is SHOULD because FlowFn is optional; however, when FlowFn is configured, the enqueue behavior is expected.

## OBS-001
- ID: OBS-001
- Priority: P0
- Statement: FileFn MUST integrate with LogFn when provided and MUST NOT log secrets while preserving correlation IDs.
- Rationale: The audit reports missing LogFn integration and over-redaction of correlation IDs.
- Acceptance criteria:
  - FileFn accepts a logger in config and logs structured entries for key lifecycle operations.
  - Logs include `requestId`, `uploadSessionId`, `fileId`, `versionId` when known.
  - Signed URLs and share tokens are redacted/omitted.
  - Correlation IDs like `req_001` MUST NOT be redacted.
- Test vectors: TV-OBS-LOG-001 (positive), TV-OBS-LOG-NEG-001 (negative), TV-OBS-REDACTION-001 (positive)
- Notes:
  - Redaction rules MUST be deterministic.
