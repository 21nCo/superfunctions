# FileFn spec audit (2026-01-24-new-h3m9k2s-spec)

## Metadata
- timestamp (UTC): 2026-01-25T17:35:42Z
- agent_name: unknown-agent
- model: gpt-5.2 (xhigh reasoning)
- launcher: Warp
- workspace/project (absolute): /Users/ar/dev/superfunctions
- OS + shell:
  - OS: macOS 26.0.1 (Darwin 25.0.0 arm64)
  - shell: zsh 5.9
- runtime/tooling:
  - node: v23.11.1
  - npm: 11.6.1
  - python: 3.12.3
- repo metadata:
  - VCS: git
  - branch: next
  - commit: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - dirty: true (see Appendix for `git status` excerpt)
- spec bundle paths audited:
  - relative: filefn/.conduct/2026-01-24-new-h3m9k2s-spec
  - absolute: /Users/ar/dev/superfunctions/filefn/.conduct/2026-01-24-new-h3m9k2s-spec
- codebase scope audited:
  - root: /Users/ar/dev/superfunctions
  - primary in-scope directories:
    - filefn/server/
    - filefn/client/
    - filefn/processing/
    - packages/storage/
    - packages/files/
    - packages/middleware/
    - packages/db/
    - packages/storage-s3/ packages/storage-r2/ packages/storage-gcs/ packages/storage-azure/ packages/storage-minio/ packages/storage-local/
    - uifn/files/
  - excluded folders (not exhaustively audited): everything outside the above directories
- commands executed during audit (high level):
  - environment + git: `uname -a`, `sw_vers`, `node -v`, `npm -v`, `zsh --version`, `git ...`
  - spec listing: `ls -1 filefn/.conduct/2026-01-24-new-h3m9k2s-spec`
  - build: `npm run build -- --filter=...`
  - test: `npm test -- --filter=...`
  - audit-spec reference: `curl -fsSL https://www.fetch.at/audit-spec.txt | ...`

## Audit scope
This is a **read-only** spec audit of the implementation in this repo against the authoritative spec bundle at `filefn/.conduct/2026-01-24-new-h3m9k2s-spec` (SPEC/REQUIREMENTS/TEST_VECTORS plus intent/plan artifacts present in the bundle).

## Spec bundle(s) audited
From `filefn/.conduct/2026-01-24-new-h3m9k2s-spec/`:
- `SPEC.md`
- `REQUIREMENTS.md`
- `TEST_VECTORS.md`
- `PLAN.md`
- `INTENT_AUDIT.md`
- `phases/*` and `phase-reports/*` (read for context only; compliance is determined directly from spec requirements)

## High-level findings
What is working well (meets spec intent in broad strokes):
- The repo contains all major packages (server/client/processing, storage + storage adapters, UI) and they **build successfully** together (TV-API-BOOT-001).
- The core **upload session state machine** exists and is well covered by unit/integration tests for the canonical multipart + signed URL path (UPLOAD-001/002/003).
- Storage adapter packages exist for all required providers and their test suites pass.
- Share links, processing artifacts routes, and UI primitives exist and are tested.

Major compliance gaps (spec-impacting):
- **Rate limiting primitives and KVStoreAdapter do not match the spec’s canonical APIs** (PKG-006, PKG-007). FileFn uses a different RateLimiter shape than SPEC.md.
- **Proxy upload fallback is not implemented** (UPLOAD-005): sessions can be created in `proxy` mode (e.g., `storage-local`), but no server endpoints accept bytes/chunks and the existing `sign` endpoint cannot operate in proxy mode.
- **Authorization enforcement is incomplete** (AUTHZ-001, FILE-004): upload-init/complete allow replacing an existing `fileId` without write checks; listFiles does not list “accessible” files per spec.
- **Event names do not match the spec/test vectors** (PROCESS-001): implementation emits `file.uploaded`/`file.deleted` instead of `file:uploaded`/`file:deleted`.
- **Client SDK public API diverges materially from SPEC.md and TEST_VECTORS** (CLIENT-001/002): method shapes and return types do not match, and offline mode is not integrated into the client’s main upload flow.
- **Observability integration is not implemented** (OBS-001): a logger helper exists, but FileFn does not accept/use a LogFn logger; additionally, the logger intentionally redacts requestId-like IDs that the spec expects to be present for correlation.

## Coverage summary
- PASS: 20
- PARTIAL: 12
- FAIL: 14
- UNVERIFIED: 0

## Requirement-by-requirement results
### Results table
| ID | Priority | Status | Notes (very short) |
|---|---:|---:|---|
| PKG-001 | P0 | PASS | `@superfunctions/storage` types match SPEC (`packages/storage/src/types.ts`); build+tests pass. |
| PKG-005 | P0 | PASS | `@superfunctions/files` defines `FileProvider` per SPEC (`packages/files/src/types.ts`); build passes (no tests). |
| PKG-006 | P1 | FAIL | `@superfunctions/middleware` rate limiter API + persistence types differ from SPEC (`packages/middleware/src/rate-limit.ts`). |
| PKG-007 | P1 | FAIL | `@superfunctions/db` `KVStoreAdapter` shape differs from SPEC (ttlMs vs ttlSeconds; missing `incr`). |
| PKG-002 | P1 | PASS | All required `@superfunctions/storage-*` adapter packages exist and tests pass. |
| PKG-003 | P0 | PARTIAL | Packages exist/build; exported public API shapes differ from SPEC (notably `@filefn/client` and `@filefn/server` config/types). |
| PKG-004 | P2 | PASS | `@uifn/files` exports required UI primitives; tests pass. |
| STORAGE-001 | P0 | FAIL | `storage-azure` uses per-instance mutable `activeUploads` state; requires prior calls on same instance. |
| STORAGE-002 | P0 | PARTIAL | Adapters declare capabilities accurately; FileFn does not fully implement capability-gated flows (no proxy upload; no non-multipart signed upload). |
| STORAGE-003 | P0 | PASS | `statObject` + retry-safe `deleteObject` exist across adapters; tests pass. |
| STORAGE-004 | P0 | PASS | Multipart primitives exist and are tested for multipart-capable adapters. |
| STORAGE-005 | P1 | PARTIAL | Constraints only partially enforced; FileFn does not validate recorded sizes at complete. |
| SERVER-001 | P0 | PARTIAL | `createFileFn()` returns a `FileProvider` implementation; but provider surface doesn’t fully match expected semantics (e.g., ignores versionId). |
| SERVER-002 | P0 | PARTIAL | Router exists but is missing some SPEC routes (e.g., `/policies`, quota); JSON envelopes inconsistent (missing `warnings` in many success responses). |
| SERVER-003 | P0 | PASS | `getSchema()` exists; includes required models; uses DB adapter for persistence. |
| SERVER-004 | P1 | PASS | Namespace applied consistently; index names are namespace-safe. |
| UPLOAD-001 | P0 | PASS | Upload sessions init/status/sign/part-complete/complete/abort exist; tests cover core flow. |
| UPLOAD-002 | P0 | PASS | Policy constraints (content types, max size, storage path) enforced at init; tests cover negatives. |
| UPLOAD-003 | P0 | PASS | Quota enforced at init and re-checked at completion; warnings supported. |
| UPLOAD-004 | P1 | FAIL | Complete is not idempotent per spec; part-complete is not idempotent per tuple; idempotency payload hashing incomplete. |
| UPLOAD-005 | P0 | FAIL | Proxy upload fallback not implemented; signPart assumes multipart-signed-url only. |
| UPLOAD-006 | P2 | PARTIAL | TTL prevents completing expired sessions; but no GC routine/abort cleanup for expired sessions. |
| FILE-001 | P0 | FAIL | List endpoint returns only owned files; does not list all accessible (public/shared/granted). |
| FILE-002 | P0 | PARTIAL | Download uses signed URLs when supported; otherwise returns `proxy://...` placeholder (no proxy download stream implementation). |
| FILE-003 | P0 | PASS | Delete removes versions + file record and records negative quota (best-effort storage delete). |
| FILE-004 | P1 | FAIL | Replace-by-fileId works mechanically but lacks required write authorization enforcement. |
| VERSION-001 | P1 | PARTIAL | Version list route exists; version download route exists but does not verify version belongs to fileId. |
| DEDUPE-001 | P2 | PARTIAL | Tenant-scoped dedupe service exists; not configurable via `createFileFn` API (dedupe not wired). |
| AUTH-001 | P0 | PASS | Auth resolution order matches SPEC (`resolveSession` → `getSession` → `authenticate`); routes enforce 401 when required. |
| AUTHZ-001 | P0 | FAIL | Spec’s pluggable authorizer interface (resource+action) is not enforced across routes; uploads/replace lack checks. |
| AUTHZ-002 | P0 | PASS | Permission grants create/list/revoke exist; expired grants ignored by default authorizer. |
| AUTHZ-003 | P1 | PARTIAL | `shared` visibility is implemented in authorizer logic but policy/type system doesn’t support setting it; baseline behavior incomplete. |
| AUTHZ-004 | P2 | FAIL | `composeAuthorizers` signature/behavior differs from SPEC/test vectors (options object vs `(authorizers, options)`). |
| SHARE-001 | P1 | PASS | Share links support token once, expiration, optional auth, max downloads, revocation; token stored hashed. |
| POLICY-001 | P0 | PARTIAL | Policies constrain uploads; but `/policies` route missing and policies lack access hooks + shared visibility. |
| QUOTA-001 | P0 | PASS | Quota checks + usage recording exist on completion and delete (interface differs from SPEC, but behaviors exist). |
| RATE-001 | P1 | PARTIAL | Rate limiting behavior exists (429 + resetAt), but rate limiter API differs from SPEC and resetAt format is numeric (ms), not ISO8601. |
| PROCESS-001 | P1 | FAIL | Events emitted, but names don’t match required `file:uploaded`/`file:deleted`. |
| PROCESS-002 | P2 | PASS | `@filefn/processing` defines processors + built-ins and is tested. |
| PROCESS-003 | P1 | FAIL | FlowFn enqueue exists only when explicitly triggered; upload completion does not enqueue processing nor retry idempotently. |
| CLIENT-001 | P0 | FAIL | Client SDK does not match SPEC API and canonical upload flow; resumability API differs. |
| CLIENT-002 | P2 | FAIL | Offline modules exist but are not integrated behind `offline.enabled` in client config per SPEC. |
| CLIENT-003 | P1 | PASS | UploadHandle exposes `onProgress` and `abort` and is covered by tests. |
| UI-001 | P2 | PASS | UI primitives for plans/uploads/progress/file list/quota exist and are tested. |
| OBS-001 | P0 | FAIL | No LogFn integration; logger helper redacts correlation IDs the spec expects present. |
| OBS-002 | P1 | PASS | HTTP errors include stable `error.code` and include requestId when provided. |

### Per-requirement notes
#### PKG-001 — PASS
- Restatement: `@superfunctions/storage` exists and defines the canonical `StorageAdapter` interface.
- Expected: Types match SPEC.md; downstream packages compile.
- Evidence:
  - `packages/storage/src/types.ts` exports `StorageAdapter` + `StorageAdapterCapabilities`.
- Verification:
  - Build: `npm run build -- --filter=@superfunctions/storage ...` (TV-API-BOOT-001) passed.
  - Tests: `@superfunctions/storage` tests passed in the filtered `npm test` run.

#### PKG-005 — PASS
- Restatement: `@superfunctions/files` exists and defines the canonical `FileProvider` interface.
- Expected: Types match SPEC.md; `@filefn/server` implements it.
- Evidence:
  - `packages/files/src/types.ts` exports `FileProvider` + `FileProviderContext`.
- Verification:
  - Build: included in filtered build; passed.
  - Tests: no tests found for `@superfunctions/files` in filtered `npm test` run (limitation is test coverage only, not type-level conformance).

#### PKG-006 — FAIL
- Restatement: `@superfunctions/middleware` should provide shared rate limiting primitives matching SPEC.md.
- Expected: `createRateLimiter({ persistence: Adapter | KVStoreAdapter, ... })` returning a RateLimiter with a SPEC-compatible `check` API.
- Evidence:
  - `packages/middleware/src/rate-limit.ts` defines:
    - `createRateLimiter(config: { windowMs, maxRequests, persistence?: KVStoreAdapter, ... })`
    - `RateLimiter.check(key: string)`
    - a local `KVStoreAdapter` type with `set(key, value, ttlMs?)`.
- Verification:
  - Tests for `@superfunctions/middleware` pass, but they validate the implementation’s API, not SPEC.md.
- Status rationale: Spec-required API shapes and persistence integration are not present.

#### PKG-007 — FAIL
- Restatement: `@superfunctions/db` should export a `KVStoreAdapter` interface matching SPEC.md.
- Expected: `KVStoreAdapter.set({ key, value, ttlSeconds? })` and optional `incr` (per SPEC.md).
- Evidence:
  - `packages/db/src/adapter/types.ts` exports `KVStoreAdapter` with `set(key, value, ttlMs?)` and no `incr`.
- Verification:
  - Build passes.
  - Tests: `@superfunctions/db` fails in `src/adapters/drizzle/drizzle.test.ts` (this does not directly prove/specify KVStoreAdapter conformance, but indicates instability in that package’s test suite).
- Status rationale: The exported interface shape is not equivalent to SPEC.md.

#### PKG-002 — PASS
- Restatement: Storage adapter packages exist for s3/r2/gcs/azure/minio/local.
- Expected: Each package exports a factory returning a `StorageAdapter` with correct `capabilities`.
- Evidence:
  - `packages/storage-s3/src/adapter.ts`, `packages/storage-r2/src/adapter.ts`, `packages/storage-gcs/src/adapter.ts`, `packages/storage-azure/src/adapter.ts`, `packages/storage-minio/src/adapter.ts`, `packages/storage-local/src/adapter.ts`.
- Verification:
  - Tests: all storage adapter packages passed their test suites in the filtered `npm test` run.

#### PKG-003 — PARTIAL
- Restatement: The repo provides `@filefn/server`, `@filefn/client`, `@filefn/processing` that build and export the public API shapes in SPEC.md.
- Expected: Exported types and function signatures match SPEC.md (including client/server config shapes).
- Evidence:
  - Server exports: `filefn/server/src/index.ts` (`createFileFn`, `getSchema`, router/events, etc).
  - Client exports: `filefn/client/src/index.ts` (`createFileFnClient`).
  - Processing exports: `filefn/processing/src/index.ts`.
- Verification:
  - Build: all three packages build successfully.
  - Tests: `@filefn/server`, `@filefn/client`, `@filefn/processing` tests pass.
- Status rationale: Packages exist and build, but at least `@filefn/client` and `@filefn/server` deviate substantially from SPEC.md signatures (see CLIENT-001 and SERVER-002 notes).

#### PKG-004 — PASS
- Restatement: `@uifn/files` exists and exports the required file UX primitives.
- Expected: Exports include `PricingPlans`, `UsageAnalytics`, `FileDropzone`, `UploadProgressList`, `FileList`, `QuotaUsageBar`.
- Evidence:
  - `uifn/files/src/index.ts` exports these names.
- Verification:
  - Tests: `@uifn/files` passed in the filtered `npm test` run.

#### STORAGE-001 — FAIL
- Restatement: Storage adapters must be stateless and safe to share.
- Expected: No per-request mutable state that requires call ordering on the same instance.
- Evidence:
  - `packages/storage-azure/src/adapter.ts` stores `activeUploads: Map<uploadId, key>` and `signMultipartUploadPartUrl` / `completeMultipartUpload` validate `uploadId` against this map.
- Verification:
  - Static audit (no concurrency stress test was run).
- Status rationale: Azure adapter requires prior `createMultipartUpload` calls on the same adapter instance to succeed; violates stateless requirement.

#### STORAGE-002 — PARTIAL
- Restatement: `StorageAdapter.capabilities` must accurately describe supported modes and FileFn should be capability-gated.
- Expected: FileFn selects signed-url vs proxy flows correctly based on capabilities.
- Evidence:
  - Capabilities are present on all adapters (e.g. `packages/storage-local/src/adapter.ts`).
  - FileFn mode selection: `filefn/server/src/upload-sessions/service.ts` `selectUploadMode()`.
  - But `signPart()` in the same file assumes `storage.signMultipartUploadPartUrl` exists, regardless of selected mode.
- Verification:
  - Static audit for capability gating edge cases.
  - Tests cover multipart-signed-url with fake storage adapter; no tests cover proxy upload mode.
- Status rationale: Capabilities exist and are accurate, but FileFn’s behavior is not fully gated/implemented for non-multipart and proxy modes.

#### STORAGE-003 — PASS
- Restatement: `statObject` and retry-safe `deleteObject` are supported.
- Evidence:
  - Storage adapter implementations provide these methods (examples: `packages/storage-local/src/adapter.ts`, `packages/storage-azure/src/adapter.ts`).
- Verification:
  - Adapter package test suites passed in filtered `npm test`.

#### STORAGE-004 — PASS
- Restatement: Multipart-capable adapters support create/sign/complete/abort multipart.
- Evidence:
  - Implemented in `packages/storage-s3`, `storage-r2`, `storage-minio`, `storage-azure`.
- Verification:
  - Adapter package test suites passed in filtered `npm test`.

#### STORAGE-005 — PARTIAL
- Restatement: Signed upload URLs should enforce content-type/length constraints, or FileFn must validate at completion.
- Evidence:
  - FileFn passes only `constraints: { contentLength }` when signing parts (`filefn/server/src/upload-sessions/service.ts`).
  - No completion-time `statObject` validation exists to reconcile recorded part sizes vs actual bytes.
- Verification:
  - Static audit.
- Status rationale: Some constraints may be enforced by providers, but the spec-required fallback validation is not implemented.

#### SERVER-001 — PARTIAL
- Restatement: `@filefn/server` exports a `FileProvider` implementation.
- Expected: Provider methods exist and accept `principalId`/`tenantId` context.
- Evidence:
  - `filefn/server/src/index.ts` returns an object implementing the `FileProvider` methods.
- Verification:
  - Tests in `filefn/server/src/__tests__/*` pass.
- Status rationale: Provider exists, but some provider semantics diverge (e.g., `getFile` ignores `versionId` and returns only current).

#### SERVER-002 — PARTIAL
- Restatement: `@filefn/server` exposes an HTTP router implementing SPEC.md routes with canonical envelopes.
- Expected: Routes from SPEC.md exist (uploads, files, versions, permissions, share links, policies, processing, quota) and success envelopes include `warnings: []`.
- Evidence:
  - Router: `filefn/server/src/router.ts`.
  - Missing routes: `/policies`, `/quota/storage`, `GET /:fileId/versions/:versionId` (metadata).
  - Envelope inconsistency: `filefn/server/src/files/routes.ts` success responses omit `warnings`.
- Verification:
  - Static route audit + `@filefn/server` test suite passes.

#### SERVER-003 — PASS
- Restatement: FileFn persists state via DB adapter and provides `getSchema()`.
- Evidence:
  - `filefn/server/src/schema.ts` defines `files`, `fileVersions`, `uploadSessions`, `uploadParts`, `filePermissions`, `fileShares`, `fileArtifacts`.
- Verification:
  - `filefn/server/src/__tests__/upload-sessions.test.ts` asserts schema model names (TV-DB-SCHEMA-001).

#### SERVER-004 — PASS
- Restatement: Namespace isolation is supported.
- Evidence:
  - `namespace` passed into DB operations throughout server services/routes; schema index names prefix with `${ns}_...`.
- Verification:
  - Static audit + build/tests.

#### UPLOAD-001 — PASS
- Restatement: Resumable upload sessions exist with init/status/sign/part-complete/complete/abort.
- Evidence:
  - Service: `filefn/server/src/upload-sessions/service.ts`.
  - Routes: `filefn/server/src/upload-sessions/routes.ts`.
- Verification:
  - `filefn/server/src/__tests__/upload-sessions.test.ts` covers init, invalid part number, invalid etag, incomplete completion, expire, abort.

#### UPLOAD-002 — PASS
- Restatement: Upload init enforces policy constraints.
- Evidence:
  - Policy validation in `filefn/server/src/upload-sessions/service.ts`.
- Verification:
  - `filefn/server/src/__tests__/upload-sessions.test.ts` covers disallowed content type and max size (TV-UPLOAD-INIT-NEG-001/-002).

#### UPLOAD-003 — PASS
- Restatement: Upload init enforces quota checks and returns warnings.
- Evidence:
  - Quota provider checks in `filefn/server/src/upload-sessions/service.ts`.
- Verification:
  - `filefn/server/src/__tests__/upload-sessions.test.ts` covers quota exceeded; tests confirm warnings are supported by return shape.

#### UPLOAD-004 — FAIL
- Restatement: Upload init and upload complete must be idempotent when `x-idempotency-key` is provided.
- Expected: Repeating `complete` returns the same `(fileId, versionId)`; part-complete idempotent for `(session, part, etag)`.
- Evidence:
  - Init idempotency exists (stores `idempotencyKey` and `idempotencyPayloadHash`) in `filefn/server/src/upload-sessions/service.ts`.
  - Complete does not accept/consult idempotency key at HTTP route layer (`filefn/server/src/upload-sessions/routes.ts`).
  - “Idempotent complete” returns `{ fileId, versionId: file.currentVersionId }` when session status is completed; this can change if the file is later replaced.
  - Part completion upserts and overwrites etag/size for same part number without conflict detection.
- Verification:
  - Static audit; no test asserts the complete idempotency guarantee.

#### UPLOAD-005 — FAIL
- Restatement: FileFn must select upload mode based on capabilities and support proxy upload fallback.
- Expected: When `signedUploadUrls` is false and `proxyStreamingUpload` is true, server accepts bytes via `openUploadStream`.
- Evidence:
  - Mode selection includes `proxy` (`filefn/server/src/upload-sessions/service.ts`).
  - No proxy upload endpoints exist in `filefn/server/src/router.ts`.
  - `signPart()` throws `FILEFN_NO_SUPPORTED_UPLOAD_MODE` unless `signMultipartUploadPartUrl` exists.
- Verification:
  - Static audit; tests do not cover proxy upload mode.

#### UPLOAD-006 — PARTIAL
- Restatement: Sessions expire after TTL and are garbage-collectable.
- Expected: Expired sessions can’t be completed; cleanup routine exists.
- Evidence:
  - Completion rejects when `expiresAt` is in the past.
  - No cleanup routine exists (no deleteMany by expiresAt, no abort of provider multipart for expired sessions).
- Verification:
  - Tests cover “expired cannot complete” (`filefn/server/src/__tests__/upload-sessions.test.ts`).

#### FILE-001 — FAIL
- Restatement: FileFn supports reading metadata and listing files accessible to the principal.
- Expected: List includes owned + shared + public + granted, filtered by authorizer.
- Evidence:
  - `filefn/server/src/files/service.ts` `listFiles()` filters only `{ ownerId = principalId }` when a principal is present.
- Verification:
  - `filefn/server/src/__tests__/files.test.ts` explicitly tests “list files owned by principal” only.

#### FILE-002 — PARTIAL
- Restatement: Download via signed URL or proxy stream with authorization.
- Expected: If signed download URLs are unsupported, server should stream bytes via proxy.
- Evidence:
  - `filefn/server/src/files/service.ts` returns `proxy://{storageKey}` when signed download URLs are unavailable.
  - No router route implements streaming/proxy behavior; routes always return JSON `{ url: ... }`.
- Verification:
  - Tests cover signed download URL case.

#### FILE-003 — PASS
- Restatement: Delete files and free quota usage.
- Evidence:
  - `filefn/server/src/files/service.ts` deletes all versions, then deletes file record, then records negative quota.
- Verification:
  - `filefn/server/src/__tests__/files.test.ts` covers delete happy-path and forbidden delete.

#### FILE-004 — FAIL
- Restatement: Replace a file by creating a new version under an existing fileId, requiring write permission.
- Evidence:
  - Replace flow exists by passing `fileId` to `createUploadSession` and updating `files.currentVersionId` on completion (`filefn/server/src/upload-sessions/service.ts`).
  - No write authorization check exists for targeting an existing fileId (any principal can supply an existing fileId).
- Verification:
  - Tests cover owner replacement, but there is no negative test for non-owner replacement.

#### VERSION-001 — PARTIAL
- Restatement: Expose version history and allow downloading a specific version.
- Evidence:
  - Router exposes `GET /:fileId/versions` and `GET /:fileId/versions/:versionId/download`.
  - `getDownloadUrl()` fetches version by `versionId` only and does not verify `version.fileId === fileId`.
- Verification:
  - Tests cover listing versions; version download cross-check is not tested.
- Status rationale: Feature exists but has a correctness/security hole.

#### DEDUPE-001 — PARTIAL
- Restatement: When dedupe enabled, avoid duplicate bytes within tenant.
- Evidence:
  - `filefn/server/src/dedup/service.ts` computes SHA-256 (base64) and checks duplicates tenant-scoped.
  - Upload completion can invoke dedupe if a `dedup` service is provided (`filefn/server/src/upload-sessions/service.ts`).
  - `createFileFn()` does not expose a configuration path to enable/wire dedupe.
- Verification:
  - Static audit + dedicated dedupe tests exist in `filefn/server/tests/dedup.test.ts` (package tests passed in filtered run).

#### AUTH-001 — PASS
- Restatement: Optional auth with session cache support.
- Evidence:
  - `filefn/server/src/auth.ts` implements `resolveSession` → `provider.getSession` → `provider.authenticate`.
- Verification:
  - Covered indirectly by server integration tests using `resolveSession`.

#### AUTHZ-001 — FAIL
- Restatement: Enforce authorization for all operations via pluggable Authorizer interface.
- Evidence:
  - File service has a simple `Authorizer` (`canRead/canWrite/canDelete`) and applies it in file read/download/delete.
  - Upload init/complete do not consult any authorizer for create/replace.
  - Spec’s resource+action authorizer interface is not implemented.
- Verification:
  - Static audit + tests show authz is only partially applied.

#### AUTHZ-002 — PASS
- Restatement: Permission grants exist and support expiration.
- Evidence:
  - `filefn/server/src/authz/grants.service.ts` and `grants.routes.ts` implement create/list/revoke.
  - `filefn/server/src/authz/authorizer.ts` ignores expired grants.
- Verification:
  - `filefn/server` tests include share/grant coverage; full server test suite passed.

#### AUTHZ-003 — PARTIAL
- Restatement: Support `private`, `shared`, `public` visibility baseline behavior.
- Evidence:
  - Default authorizers include `shared` tenant reads.
  - Policy type only supports `public | private` and upload completion assigns visibility from policy.
- Verification:
  - Static audit.

#### AUTHZ-004 — FAIL
- Restatement: Export `composeAuthorizers()` helper matching SPEC’s signature and semantics.
- Evidence:
  - `filefn/server/src/authz/authorizer.ts` exports `composeAuthorizers(options: {strategy, authorizers})`.
  - This does not match SPEC/test vectors (expects `composeAuthorizers([a,b], { strategy })`).
- Verification:
  - Static audit + type signature mismatch.

#### SHARE-001 — PASS
- Restatement: Share links with token, expiration, auth requirement, max downloads, revocation.
- Evidence:
  - `filefn/server/src/shares/service.ts` stores token hashes; returns token once; enforces constraints.
- Verification:
  - `filefn/server/src/__tests__/shares.test.ts` is present and server tests passed.

#### POLICY-001 — PARTIAL
- Restatement: Policies constrain uploads and influence storage paths and access.
- Evidence:
  - `filefn/server/src/policies.ts` supports contentTypes, maxSizeBytes, visibility, storagePath.
  - No `/policies` route exists in router.
  - No policy access hook exists.
- Verification:
  - Tests cover constraint enforcement on init.

#### QUOTA-001 — PASS
- Restatement: Enforce quotas and record usage on completion/deletion.
- Evidence:
  - Quota checked at init and complete; usage recorded on complete; negative usage on delete.
- Verification:
  - Quota-negative test exists for init; deletion path calls `recordUsage` negative.

#### RATE-001 — PARTIAL
- Restatement: Rate limiting enforced when configured; reject 429 with reset info.
- Evidence:
  - Upload init and download call `rateLimiter.check(...)` and map to `FILEFN_RATE_LIMITED`.
  - The `resetAt` propagated is numeric epoch millis, not ISO.
  - FileFn config expects a `RateLimiter` instance, not SPEC’s `rateLimit` config.
- Verification:
  - `filefn/server/src/__tests__/upload-sessions.test.ts` and `files.test.ts` include 429 cases.

#### PROCESS-001 — FAIL
- Restatement: Emit lifecycle events for uploads and deletes with required names.
- Evidence:
  - `filefn/server/src/events.ts` defines and emits `file.uploaded` / `file.deleted`.
- Verification:
  - Static audit.
- Status rationale: Event naming does not match SPEC/test vectors (`file:uploaded`, `file:deleted`).

#### PROCESS-002 — PASS
- Restatement: `@filefn/processing` defines processor contracts and built-in processors.
- Evidence:
  - `filefn/processing/src/processors/*` and `filefn/processing/src/types.ts`.
- Verification:
  - `@filefn/processing` tests passed in filtered run.

#### PROCESS-003 — FAIL
- Restatement: With FlowFn, FileFn should enqueue processing after upload completion and retry idempotently.
- Evidence:
  - `filefn/server/src/processing/service.ts` can enqueue when `triggerProcessing` is called.
  - Upload completion does not call `triggerProcessing`; no idempotent retry logic is present.
- Verification:
  - Static audit; server tests cover processing when explicitly triggered.

#### CLIENT-001 — FAIL
- Restatement: Client supports resumable multipart uploads with retries/progress, matching the canonical flow.
- Evidence:
  - `filefn/client/src/index.ts` exports `uploadFile(input): UploadHandle` (not async) and only `uploadFile`/`resumeUpload`.
  - SPEC expects `uploadFile(...) -> Promise<UploadHandle>` and additional methods (`getFile`, `downloadUrl`, `deleteFile`).
- Verification:
  - Client tests pass, but validate the implemented API, not SPEC.md.

#### CLIENT-002 — FAIL
- Restatement: When offline mode enabled, stage uploads in OPFS and sync.
- Evidence:
  - Offline modules exist (`filefn/client/src/offline/*`), but `FileFnClientConfig` does not include `offline` and `createFileFnClient` does not branch on offline enabled.
- Verification:
  - Static audit; offline tests exist but are not driven through SPEC client config.

#### CLIENT-003 — PASS
- Restatement: Upload handle exposes progress callbacks and abort.
- Evidence:
  - `filefn/client/src/types.ts` defines `UploadHandle.onProgress` and `abort`.
- Verification:
  - Client tests passed in filtered run.

#### UI-001 — PASS
- Restatement: UI primitives exist for pricing/plans, uploading, progress, file listing, quota usage/analytics.
- Evidence:
  - `uifn/files/src/index.ts` exports all required names and includes expected behaviors.
- Verification:
  - `@uifn/files` tests passed in filtered run.

#### OBS-001 — FAIL
- Restatement: Integrate with LogFn when provided and never log secrets.
- Evidence:
  - Server exports `createLogger` + `redactSecrets` (`filefn/server/src/observability/logger.ts`), but `createFileFn` does not accept a logger and does not log request lifecycle.
  - `redactSecrets` intentionally redacts `requestId/fileId/uploadSessionId` unless UUID-shaped, conflicting with spec vectors using `req_001`.
  - Tests assert this redaction behavior (`filefn/server/src/__tests__/observability.test.ts`).
- Verification:
  - Static audit + tests.

#### OBS-002 — PASS
- Restatement: Error responses include stable `error.code` and should include requestId.
- Evidence:
  - `filefn/server/src/errors.ts` enumerates stable codes; route error responses include `requestId`.
- Verification:
  - Multiple server tests assert error codes (policy errors, forbidden, rate limited, etc.).

## Cross-cutting audits (security/determinism/limits/errors/compat)
### Security / authz / validation boundaries
Key issues:
- Unauthorized replacement vulnerability (FILE-004 / AUTHZ-001): upload-init accepts `fileId` without any `canWrite` check; upload completion updates `files.currentVersionId` unconditionally.
- Version download binding bug (VERSION-001): `getDownloadUrl(fileId, versionId)` does not verify the version belongs to the file.
- Proxy mode is selectable but not implemented (UPLOAD-005): can lead to 500s for certain adapters (e.g., `storage-local`).

Positive notes:
- `storage-local` contains explicit path traversal protection.
- Share tokens are stored hashed and never returned again.

### Determinism invariants
- Init idempotency exists, but the payload hash omits fields (e.g., `metadata`, `fileId`) and is a non-cryptographic hash; collisions or false-positives are possible (UPLOAD-004).
- Completion idempotency is not stable for replaced files because it returns `files.currentVersionId` rather than a completion-stored versionId.
- Part completion is “last write wins” instead of idempotent-by-tuple.

### Limits / caps
- Policy `maxSizeBytes` is enforced.
- No global `limits.maxFileSizeBytes` enforcement per SPEC.md.
- No provider-specific multipart limits (min part size, max part count) are enforced.
- Upload session TTL exists; no GC routine.

### Error handling
- Error codes are stable and centralized (`filefn/server/src/errors.ts`).
- Canonical envelope inconsistency: some success responses omit `warnings: []`.
- Some error details are `undefined` rather than `{}`.

### Compatibility / versioning
- DB schema version is `1` and `getSchema()` returns model names consistent with SPEC.md.
- Namespace-safe index names are used.
- Rate limiting and quota interfaces diverge from SPEC.md; clients and integrations written against SPEC.md will not typecheck against this implementation.

## Recommendations
Ranked fix order (highest leverage first):
1) Implement authorization for replace/create paths (AUTHZ-001, FILE-004): require `canWrite` when `fileId` targets an existing file; apply consistent authz to upload flows.
2) Implement proxy upload fallback (UPLOAD-005) and proxy download streaming (FILE-002) or adjust capabilities/routers to remove unsupported modes.
3) Fix idempotency guarantees (UPLOAD-004):
   - carry idempotency keys through HTTP complete,
   - store and return a stable `(fileId, versionId)` on completion,
   - make part completion idempotent with conflict detection.
4) Align middleware + db KVStore/rate limiter APIs with SPEC.md (PKG-006, PKG-007, RATE-001), or revise spec (but this audit assumes spec is authoritative).
5) Fix version download binding (VERSION-001) by verifying `fileId` on the version record.
6) Align event names with spec (`file:uploaded`, `file:deleted`) (PROCESS-001).
7) Bring `@filefn/client` in line with SPEC.md (CLIENT-001/002): async `uploadFile`, add `getFile/downloadUrl/deleteFile`, and integrate offline mode config.
8) Add LogFn integration and ensure correlation IDs remain present (OBS-001) while still redacting secrets.

## Appendix: commands run + environment details
### Key commands (executed)
- `ls -1 filefn/.conduct/2026-01-24-new-h3m9k2s-spec`
- `git --no-pager rev-parse HEAD && git --no-pager status -sb`
- `uname -a && sw_vers && node -v && npm -v && python3 --version && zsh --version`
- `npm run build -- --filter=@filefn/server --filter=@filefn/client --filter=@filefn/processing --filter=@uifn/files --filter=@superfunctions/storage --filter=@superfunctions/storage-* --filter=@superfunctions/middleware --filter=@superfunctions/db --filter=@superfunctions/files`
- `npm test -- --filter=@filefn/server --filter=@filefn/client --filter=@filefn/processing --filter=@uifn/files --filter=@superfunctions/storage --filter=@superfunctions/storage-* --filter=@superfunctions/middleware --filter=@superfunctions/db --filter=@superfunctions/files`
- `curl -fsSL https://www.fetch.at/audit-spec.txt | sed -n '1,180p'`

### Test summary (from filtered run)
- PASS: @filefn/server, @filefn/client, @filefn/processing, @uifn/files, @superfunctions/storage, @superfunctions/middleware, and all `@superfunctions/storage-*` packages.
- FAIL: @superfunctions/db (failures in Drizzle adapter tests).
- No tests: @superfunctions/files (no test files found).

### `git status -sb` excerpt (audit time)
- `## next`
- working tree dirty (multiple modified/untracked files present)
