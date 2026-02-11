# PLAN.md (FileFn) — Phased Implementation Plan

## Architecture sketch
- `packages/storage/` (`@superfunctions/storage`)
  - Owns the canonical `StorageAdapter` TypeScript interface.
  - Owns adapter conformance tests (as part of package tests).
- `packages/files/` (`@superfunctions/files`)
  - Owns the canonical `FileProvider` TypeScript interface.
- `packages/middleware/` (`@superfunctions/middleware`)
  - Owns reusable middleware primitives, including rate limiting.
  - Rate limiting persistence is provided via `@superfunctions/db` `Adapter` or `KVStoreAdapter`.
- `packages/db/` (`@superfunctions/db`)
  - Adds `KVStoreAdapter` interface (additive) used by middleware.
- `packages/storage-s3/`, `packages/storage-r2/`, `packages/storage-minio/`, `packages/storage-gcs/`, `packages/storage-azure/`, `packages/storage-local/`
  - Implement `StorageAdapter` for each provider.
  - Declare accurate `capabilities`.
- `filefn/server/` (`@filefn/server`)
  - Owns persistent models (files/versions/sessions/parts/permissions/shares/artifacts).
  - Owns upload-session orchestration, policy enforcement, auth/authz integration, quotas, and rate limiting.
  - Exposes `router` (via `@superfunctions/http`) and implements `FileProvider` from `@superfunctions/files`.
- `filefn/client/` (`@filefn/client`)
  - Owns resumable uploads, signed URL orchestration, retries, progress.
  - Owns offline staging (OPFS) and sync.
- `filefn/processing/` (`@filefn/processing`)
  - Owns processor contracts and built-in processors.
  - Provides a runner usable from server and FlowFn workers.
- `uifn/files/` (`@uifn/files`)
  - Owns UI components for uploading, progress, file listing, and quota usage.

## Dependency graph
1. `@superfunctions/storage` + `@superfunctions/files` + `@superfunctions/middleware` (interfaces) → required by everything else.
2. `@superfunctions/db` (`KVStoreAdapter` additive) → used by `@superfunctions/middleware` persistence.
3. `@superfunctions/storage-*` adapters → required by `@filefn/server` runtime behavior.
4. `@filefn/server` → required by `@filefn/client` integration tests.
5. `@filefn/processing` → integrated into `@filefn/server`.
6. `@filefn/client` → used by `@uifn/files`.

## Phases overview
Definition: **No phase is complete unless its verification steps pass.**

### Phase 00
Goal: Scaffold packages + shared test harness.
Delivered capability: Repo builds with empty packages + placeholder exports.
Verification: `npm run build` and per-package builds.

### Phase 01
Goal: Implement shared contracts + primitives (`@superfunctions/storage`, `@superfunctions/files`, `@superfunctions/middleware`, `@superfunctions/db` additive KV).
Delivered capability: Interfaces are stable and testable, and shared rate limiting primitives exist.
Verification: `npm run build -- --filter=@superfunctions/storage --filter=@superfunctions/files --filter=@superfunctions/middleware --filter=@superfunctions/db` and `npm test -- --filter=@superfunctions/storage --filter=@superfunctions/middleware`.

### Phase 02
Goal: Implement baseline storage adapters needed to unblock server tests (local + S3).
Delivered capability: Signed URL + multipart for S3; local adapter for dev/testing.
Verification: adapter conformance tests.

### Phase 03
Goal: Implement `@filefn/server` core (schema, policies, auth plumbing, upload sessions).
Delivered capability: Upload init/status/sign/part-complete/complete/abort endpoints working end-to-end with fake/local storage.
Verification: server unit + integration tests executing upload vectors.

### Phase 04
Goal: Implement server file management (get/list/download) + versioning, and apply download rate limiting when configured.
Delivered capability: File read/list/download + version endpoints with authz enforcement; download routes respect `rateLimit.limits.download`.
Verification: API tests for file + version vectors (+ TV-RATE-NEG-001 download variant).

### Phase 05
Goal: Implement permissions + share links + visibility semantics + delete semantics (including quota negative usage) + secret-safe observability.
Delivered capability: Grants/share links work end-to-end; delete frees quota; logs/events do not leak signed URLs or share tokens.
Verification: API tests for permission/share/visibility/delete/observability vectors.

### Phase 06
Goal: Implement `@filefn/client` resumable uploads (online mode).
Delivered capability: Client can upload with retries + progress and resume.
Verification: client integration tests against server.

### Phase 07
Goal: Implement `@filefn/processing` contracts + Release 1 processors (thumbnail + compression) and integrate.
Delivered capability: Processing jobs produce artifacts.
Verification: processing vectors + artifact listing/download.

### Phase 08
Goal: Add storage adapters (R2 + MinIO + Local hardening).
Delivered capability: S3-compatible providers supported.
Verification: adapter conformance suite.

### Phase 09
Goal: Add storage adapters (GCS).
Delivered capability: GCS supported.
Verification: adapter conformance suite.

### Phase 10
Goal: Add storage adapters (Azure).
Delivered capability: Azure supported.
Verification: adapter conformance suite.

### Phase 11
Goal: Release 2 processing (OCR + image transforms).
Delivered capability: OCR + image variants.
Verification: processing vectors.

### Phase 12
Goal: Release 3 processing (video + audio).
Delivered capability: video/audio variants produced by processors.
Verification: processing vectors.

### Phase 13
Goal: Deduplication.
Delivered capability: tenant-scoped dedup avoids duplicate storage writes.
Verification: dedupe vectors.

### Phase 14
Goal: Client offline support (OPFS staging + sync).
Delivered capability: offline uploads stage and sync when online.
Verification: offline vectors.

### Phase 15
Goal: `@uifn/files` UI components.
Delivered capability: dropzone, progress, list, quota bar components.
Verification: UI unit tests + story/demo harness.

## Definition of Done (global)
- All requirements assigned to the phase are implemented.
- All referenced test vectors for those requirements pass.
- `npm run build` and `npm test` pass for impacted packages.
- No secrets (signed URLs, share tokens) are logged.
