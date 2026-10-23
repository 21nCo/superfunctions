# FileFn Production Readiness Audit

## Metadata
- **Timestamp (UTC)**: 2026-03-06T23:50:00Z
- **Agent name**: unknown-agent
- **Model**: claude-opus-4-6
- **Launcher**: VS Code
- **Workspace (absolute)**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: macOS Darwin 25.3.0
- **Shell**: zsh
- **Repo**:
  - VCS: git
  - Branch: next
  - Commit: 635bf2853807d9d76dba07a460dd0594f57d9147
  - Dirty: false (filefn/ clean)

## Audit Scope
- **Intent/notes paths audited**: pop.md (completion status), python/README.md (feature documentation)
- **Spec bundle paths audited**:
  - `filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/` (SPEC.md, REQUIREMENTS.md, INTENT_AUDIT.md, TEST_VECTORS.md, PLAN.md)
  - `filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/` (audit-fix spec bundle)
- **Codebase scope audited**: `filefn/` (server, client, processing, python)
- **Excluded**: node_modules, dist, .turbo, examples (except for structural checks)

## Inputs Audited

### Intent Sources
1. `pop.md` - Project completion tracker showing filefn as fully complete (ts code, ts publish, py code, py publish)
2. `filefn/python/README.md` - Python SDK documentation showing intended features

### Spec Bundle 1: `2026-01-24-new-h3m9k2s-spec`
- SPEC.md (808 lines) - Full technical specification
- REQUIREMENTS.md (607 lines) - 40+ requirements with acceptance criteria
- INTENT_AUDIT.md (193 lines) - 20-item intent inventory with coverage mapping
- TEST_VECTORS.md
- PLAN.md with 16 phases (PHASE_00 through PHASE_15)

### Spec Bundle 2: `2026-01-26-audit-fix-k7n2m9p4-spec`
- Audit-fix spec addressing findings from the initial implementation audit

## Commands Executed During Audit
- `git log --oneline -20 -- filefn/`
- `git diff --stat HEAD -- filefn/`
- `git rev-parse HEAD && git branch --show-current`
- File reads across all source, test, and spec files

---

## High-Level Findings

| Category | PASS | PARTIAL | FAIL | UNVERIFIED |
|----------|------|---------|------|------------|
| Core Upload Flow | 5 | 1 | 0 | 0 |
| File Management | 4 | 1 | 0 | 0 |
| Auth/Authz | 3 | 2 | 0 | 0 |
| Shares/Permissions | 2 | 0 | 0 | 0 |
| Processing | 1 | 2 | 0 | 0 |
| Client SDK | 2 | 2 | 0 | 0 |
| Observability | 2 | 1 | 0 | 0 |
| Infrastructure/Packages | 2 | 0 | 3 | 0 |
| **TOTAL** | **21** | **9** | **3** | **0** |

**Overall Assessment**: The core filefn implementation is **substantially complete** for a v0.1.0 release. The upload flow, file management, auth, shares, dedup, and client SDK are functional. However, there are **critical production readiness concerns** around scalability, mock processors, interface drift from spec, and missing packages.

---

## Intent Inventory (numbered)

Based on INTENT_AUDIT.md and SPEC.md:

1. Huge file handling via multipart uploads
2. Streaming upload/download support
3. Resumability for unreliable networks
4. Security with granular access control
5. Provider abstraction (pluggable cloud providers)
6. Signed URL generation and orchestration
7. Server SDK (@filefn/server) with full feature set
8. FileProvider interface in @superfunctions/files
9. Storage interfaces + adapter packages (s3, r2, gcs, azure, minio, local)
10. Client SDK (@filefn/client) with resumability + offline
11. UI library (@uifn/files) with pricing/plans/upload/quota
12. Processing SDK (@filefn/processing) with 6 processor types
13. Upload policies with constraints and storage path derivation
14. Authorization model (auth provider, authorizers, visibility, grants, shares, composition)
15. Quota enforcement via plugin interface
16. Rate limiting via shared middleware
17. Versioning semantics (replace, maxVersions pruning)
18. Deduplication (SHA-256, tenant-scoped)
19. Observability (events, logging, no secret leakage)
20. Provider constraint awareness (chunk sizes, part limits)

---

## Intent -> Spec Coverage Matrix

| # | Intent Item | Spec Coverage | Requirement IDs | Status |
|---|-------------|---------------|-----------------|--------|
| 1 | Huge file/multipart | SPEC Goals, Upload Sessions | STORAGE-004, UPLOAD-001, CLIENT-001 | COVERED |
| 2 | Streaming | SPEC Public API (openUploadStream/openDownloadStream) | UPLOAD-005, FILE-002 | COVERED |
| 3 | Resumability | SPEC Semantics (Upload sessions, Idempotency) | UPLOAD-001, UPLOAD-004, CLIENT-001 | COVERED |
| 4 | Security/access control | SPEC Security, Authorization, Policies | AUTHZ-001..004, SHARE-001, POLICY-001 | COVERED |
| 5 | Provider abstraction | SPEC Overview, StorageAdapter | PKG-001, PKG-002, STORAGE-001 | COVERED |
| 6 | Signed URLs | SPEC StorageAdapter, HTTP endpoints | STORAGE-005, UPLOAD-005, FILE-002 | COVERED |
| 7 | Server SDK features | SPEC @filefn/server, Routes, Semantics | SERVER-001..004, UPLOAD-001..006, FILE-001..004 | COVERED |
| 8 | FileProvider interface | SPEC @superfunctions/files | PKG-005, SERVER-001 | COVERED |
| 9 | Storage adapters | SPEC Overview | PKG-002 | COVERED |
| 10 | Client SDK | SPEC @filefn/client | CLIENT-001..003 | COVERED |
| 11 | UI library | SPEC @uifn/files | PKG-004, UI-001 | COVERED |
| 12 | Processing SDK | SPEC @filefn/processing | PROCESS-001..003 | COVERED |
| 13 | Policies | SPEC Public API, Semantics | POLICY-001, UPLOAD-002 | COVERED |
| 14 | Authorization model | SPEC Authorizer, composeAuthorizers | AUTHZ-001..004 | COVERED |
| 15 | Quota | SPEC QuotaProvider, Semantics | QUOTA-001, UPLOAD-003 | COVERED |
| 16 | Rate limiting | SPEC @superfunctions/middleware | PKG-006, PKG-007, RATE-001 | COVERED |
| 17 | Versioning | SPEC Semantics (File versioning) | FILE-004, VERSION-001 | COVERED |
| 18 | Deduplication | SPEC Semantics (Deduplication) | DEDUPE-001 | COVERED |
| 19 | Observability | SPEC Observability, Invariants | PROCESS-001, OBS-001..002 | COVERED |
| 20 | Provider constraints | SPEC Limits/caps | STORAGE-005 | COVERED |

**Spec completeness**: All 20 intent items are covered by the spec. No SPEC MISSING items.

---

## Requirement Coverage Summary

### Spec Bundle 1 (2026-01-24-new-h3m9k2s-spec)

| Status | Count | Requirement IDs |
|--------|-------|-----------------|
| PASS | 21 | PKG-001, PKG-003, PKG-005, STORAGE-001, STORAGE-002, STORAGE-003, SERVER-001, SERVER-002, SERVER-003, SERVER-004, UPLOAD-001, UPLOAD-002, UPLOAD-003, UPLOAD-004, UPLOAD-005, FILE-001, FILE-002, FILE-003, AUTH-001, AUTHZ-002, SHARE-001 |
| PARTIAL | 9 | STORAGE-005, UPLOAD-006, FILE-004, AUTHZ-001, AUTHZ-003, AUTHZ-004, QUOTA-001, OBS-001, PROCESS-002 |
| FAIL | 3 | PKG-002, PKG-004, UI-001 |
| N/A (external) | 7 | PKG-006, PKG-007, STORAGE-004, RATE-001, PROCESS-001, PROCESS-003, OBS-002 |

---

## Requirement-by-Requirement Results

### Package Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| PKG-001 | @superfunctions/storage defines StorageAdapter | **PASS** | Used via imports in server package |
| PKG-002 | Storage adapter packages (s3, r2, gcs, azure, minio, local) | **FAIL** | Not present in filefn/ or packages/ - external dependency |
| PKG-003 | @filefn/server, @filefn/client, @filefn/processing exist | **PASS** | All three packages exist with correct exports |
| PKG-004 | @uifn/files UI components | **FAIL** | Not implemented anywhere in the codebase |
| PKG-005 | @superfunctions/files defines FileProvider | **PASS** | Used via imports |
| PKG-006 | @superfunctions/middleware rate limiting | **N/A** | External package, imported and used |
| PKG-007 | @superfunctions/db KVStoreAdapter | **N/A** | External package |

### Storage Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| STORAGE-001 | Adapters stateless and shareable | **PASS** | Factory pattern used throughout |
| STORAGE-002 | Capabilities accurately described | **PASS** | Capabilities gate behavior (signed URLs vs proxy) |
| STORAGE-003 | statObject and deleteObject | **PASS** | Used in upload completion and file deletion |
| STORAGE-004 | Multipart upload methods | **N/A** | Depends on adapter implementation |
| STORAGE-005 | Signed URL constraints | **PARTIAL** | contentLength passed to signMultipartUploadPartUrl but contentType constraints not enforced on signed URLs |

### Server Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| SERVER-001 | FileFn implements FileProvider | **PASS** | `createFileFn` returns object implementing FileProvider methods |
| SERVER-002 | HTTP router with canonical routes | **PASS** | `createRouter` implements all spec routes |
| SERVER-003 | Persistence via @superfunctions/db + getSchema() | **PASS** | 7 model schemas exported via `getSchema()` |
| SERVER-004 | Namespace isolation | **PASS** | All DB operations include `namespace` parameter |

### Upload Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| UPLOAD-001 | Resumable upload sessions | **PASS** | Full init/status/sign/complete-part/complete/abort flow |
| UPLOAD-002 | Policy enforcement on init | **PASS** | Content type and max size validated |
| UPLOAD-003 | Quota checks on init | **PASS** | Quota checked at init and re-checked at complete |
| UPLOAD-004 | Idempotency with x-idempotency-key | **PASS** | Idempotency key lookup with payload hash verification |
| UPLOAD-005 | Upload mode selection + proxy fallback | **PASS** | `selectUploadMode` correctly falls through; proxy upload implemented |
| UPLOAD-006 | Session expiration + GC | **PARTIAL** | Expiration enforced on operations; `cleanupExpiredSessions()` exists but no scheduler |

### File Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| FILE-001 | File metadata + list accessible files | **PASS** | getFile and listFiles implemented with authorization |
| FILE-002 | Download via signed URL or proxy | **PASS** | Both signed URL and proxy download paths implemented |
| FILE-003 | Delete with quota refund | **PASS** | Deletes versions, storage objects, and records negative quota |
| FILE-004 | Replace via new version | **PARTIAL** | Replace works but `maxVersions` pruning NOT implemented |

### Version/Dedup Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| VERSION-001 | Version history + specific version download | **PASS** | `listVersions` and `getVersion` with download implemented |
| DEDUPE-001 | Tenant-scoped deduplication | **PASS** | SHA-256 hash with tenant-scoped duplicate checking |

### Auth/Authz Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| AUTH-001 | Optional auth with session resolution | **PASS** | Three-step resolution: resolveSession -> getSession -> authenticate |
| AUTHZ-001 | Pluggable Authorizer | **PARTIAL** | Implementation uses simplified canRead/canWrite/canDelete instead of spec's resource+action model |
| AUTHZ-002 | Permission grants with expiration | **PASS** | Create, list, revoke grants with expiry support in DefaultAuthorizer |
| AUTHZ-003 | Visibility levels | **PARTIAL** | Implemented but `shared` visibility tenant check doesn't verify against explicit policy |
| AUTHZ-004 | composeAuthorizers | **PARTIAL** | Implemented with first-allow and all-must-allow strategies but uses simplified interface vs spec |
| SHARE-001 | Share links | **PASS** | Token hash, expiry, maxDownloads, requiresAuth, revocation all implemented |

### Policy/Quota/Rate

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| POLICY-001 | Upload policies | **PASS** | Policy registry with contentTypes, maxSizeBytes, visibility, storagePath |
| QUOTA-001 | Quota enforcement | **PARTIAL** | Quota checked but QuotaProvider interface simplified vs spec (no resource type) |
| RATE-001 | Rate limiting | **N/A** | Configured and passed through; implementation is in @superfunctions/middleware |

### Processing Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| PROCESS-001 | Lifecycle events | **PASS** | Events emitted for upload, delete, processing lifecycle |
| PROCESS-002 | Built-in processors | **PARTIAL** | All 6 processor types exist but OCR/video/audio are mock implementations |
| PROCESS-003 | FlowFn async enqueue | **PASS** | FlowFn queue integration implemented with fallback to setImmediate |

### Client Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| CLIENT-001 | Resumable uploads with progress + retry | **PASS** | UploadManager with progress callbacks, exponential backoff retry |
| CLIENT-002 | Offline OPFS staging + sync | **PARTIAL** | Implemented but `stopAutoSync` is a no-op placeholder |
| CLIENT-003 | Framework-agnostic hooks | **PARTIAL** | onProgress and abort exist but abort() in offline mode is a no-op |

### Observability Requirements

| Req ID | Statement | Status | Notes |
|--------|-----------|--------|-------|
| OBS-001 | Logger integration + no secret leakage | **PARTIAL** | Logger with redaction exists but `REDACT_PATTERNS` regex for long tokens (`[A-Za-z0-9\-_]{32,}`) may over-redact legitimate IDs |
| OBS-002 | Error codes + requestId | **PASS** | All errors use canonical envelope with stable codes |

---

## Spec Conflicts / Spec Gaps

### Interface Drift: Authorizer

**SPEC DRIFT** - The spec defines a rich Authorizer interface:
```ts
interface Authorizer {
  authorize(principal, resource: AuthorizerResource, action: AuthorizerAction, context?): Promise<AuthorizerResult>;
}
```

The implementation uses a simplified interface:
```ts
interface Authorizer {
  canRead(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
  canWrite(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
  canDelete(file: FileRecord, ctx: FileProviderContext): Promise<boolean>;
}
```

**Impact**: The spec's resource+action model supports scoped operations (metadata/content/permissions/audit) which the implementation cannot express. This is a deliberate simplification but diverges from spec.

### Interface Drift: QuotaProvider

**SPEC DRIFT** - The spec defines resource-typed quotas:
```ts
checkQuota(input: { principalId: string; resource: 'storage' | 'bandwidth' | 'processing'; amount: number; ... })
```

The implementation uses:
```ts
checkQuota(input: { principalId?: string; tenantId?: string; requestedBytes: number })
```

**Impact**: Bandwidth and processing quotas cannot be tracked separately. This limits billing integration granularity.

### Interface Drift: FileFnPolicy

**SPEC DRIFT** - The spec defines an `access` hook on policies:
```ts
access?: (input: { principal, action, file? }) => boolean | Promise<boolean>;
```

The implementation's `Policy` interface has no `access` hook.

**Impact**: Policy-level access restrictions beyond content type and size are not possible.

### Missing: maxVersions Pruning

**SPEC DRIFT** - `versioning.maxVersions` is defined in the spec config but not implemented. Old versions accumulate indefinitely.

### Event Naming Inconsistency

**SPEC DRIFT** - The spec defines events as `file:upload_started`, `file:part_recorded`, etc. The implementation uses mixed naming:
- `upload.started` (dot notation)
- `part.recorded` (dot notation)
- `file:uploaded` (colon notation)
- `file:deleted` (colon notation)
- `processing.started` (dot notation)

---

## Cross-Cutting Audits

### Security / Authorization / Validation

| Area | Status | Finding |
|------|--------|---------|
| Share token generation | **PASS** | Uses `crypto.randomBytes(32)` - cryptographically secure |
| Share token storage | **PASS** | SHA-256 hash stored, not raw token |
| Share token comparison | **FAIL** | Uses string equality (`===`) instead of constant-time comparison. Timing attacks possible. |
| Signed URL TTL | **PASS** | Default 900s (15min) configurable |
| Storage key tenant scoping | **PASS** | Storage paths include tenantId when present |
| Input validation on routes | **PARTIAL** | Body parsing uses `as` casts without validation. No schema validation on request bodies. Malformed input could cause runtime errors. |
| Auth on upload part bytes | **PASS** | Auth required on proxy upload endpoint |
| IDOR on version download | **PASS** | Version binding check ensures version belongs to specified file |
| Grant ownership check | **PASS** | Only file owner can create/list/revoke grants |
| Share link ownership check | **PASS** | Only file owner can create/revoke share links |
| Processing trigger auth | **PARTIAL** | Auth check exists but uses `auth.required` instead of `auth.required !== false` pattern used elsewhere |

### Determinism Invariants

| Area | Status | Finding |
|------|--------|---------|
| SHA-256 dedup hashing | **PASS** | Uses Node.js crypto, deterministic |
| Multipart part ordering | **PASS** | Parts sorted by partNumber before completion |
| Idempotency hash | **PARTIAL** | Uses simple djb2-like hash (`hash = ((hash << 5) - hash) + char`) which has high collision risk. Production should use SHA-256. |
| ID generation | **PARTIAL** | Uses `Date.now().toString(36)` + `Math.random()` - not cryptographically unique. Risk of collision under high concurrency. Should use crypto.randomUUID(). |

### Limits / Caps

| Area | Status | Finding |
|------|--------|---------|
| defaultChunkSizeBytes | **PASS** | 8 MiB default |
| uploadSessionTtlSeconds | **PASS** | 86400 (24h) default |
| signedUrlTtlSeconds | **PASS** | 900 (15min) default |
| maxFileSizeBytes | **FAIL** | Not enforced globally. Only policy-level maxSizeBytes. No server-wide cap. |
| listFiles scalability | **FAIL** | `listFiles` fetches ALL files (limit 1000) then filters in-memory. Not viable for production with >1000 files. Grants are also fetched without filtering. |
| Processing memory | **PARTIAL** | `getData()` in processing loads entire file into memory. Large files will cause OOM. |

### Error Handling + Canonical Envelopes

| Area | Status | Finding |
|------|--------|---------|
| Error class | **PASS** | `FileFnError` with code, message, status, details |
| Error codes | **PASS** | 20+ error codes enumerated in `ErrorCodes` |
| Canonical envelope (success) | **PASS** | `{ ok: true, data, requestId }` |
| Canonical envelope (error) | **PASS** | `{ ok: false, error: { code, message, details }, requestId }` |
| Unhandled errors | **PARTIAL** | Non-FileFnError exceptions are re-thrown. If these reach the router, they produce unstructured 500 errors. |
| Processing error handling | **FAIL** | `setImmediate` callback errors are caught but only emit an event - no logging, no retry tracking. |

### Compatibility / Versioning / Migrations

| Area | Status | Finding |
|------|--------|---------|
| Package versions | **PASS** | All packages at 0.1.0 |
| Schema version | **PASS** | `getSchema()` returns `version: 1` |
| Client-server compatibility | **PARTIAL** | Client expects `UploadStatusResponse.recordedParts` and `chunkSizeBytes`/`fileSize` but server returns `uploadedParts` without chunkSizeBytes/fileSize. Resume will fail. |
| Python SDK parity | **PARTIAL** | Python SDK exists with parallel structure but not audited for feature parity |

---

## Recommendations (Ranked)

### Critical (Must Fix for Production)

1. **[CRITICAL] listFiles scalability** - `files/service.ts:114`: Fetches all files (limit 1000) and grants with no WHERE clause, then filters in memory. Replace with pushdown queries using authorizer-provided filters or at minimum owner/tenant filtering at the DB level.

2. **[CRITICAL] Client-server status response mismatch** - Client `UploadStatusResponse` expects `recordedParts`, `chunkSizeBytes`, `fileSize` but server `getSessionStatus` returns `uploadedParts`, `totalParts` without chunkSizeBytes/fileSize. Resume uploads will fail.

3. **[CRITICAL] Share token timing attack** - `shares/service.ts:101-106`: Token hash comparison uses `===` instead of `crypto.timingSafeEqual()`. Allows timing-based token enumeration.

4. **[CRITICAL] Request body validation** - All route handlers use `request.json() as T` without any validation. Malformed requests could cause undefined behavior or crashes.

### High (Should Fix Before GA)

5. **[HIGH] ID generation collision risk** - `upload-sessions/service.ts:81-82`: `Date.now().toString(36)` + `Math.random()` is not cryptographically unique. Use `crypto.randomUUID()` for all ID generation.

6. **[HIGH] Idempotency hash weakness** - `upload-sessions/service.ts:84-103`: djb2-style hash for payload verification has high collision probability. Use SHA-256.

7. **[HIGH] maxFileSizeBytes not enforced** - The spec defines a server-wide `maxFileSizeBytes` (default 100 MiB) but only policy-level maxSizeBytes is checked.

8. **[HIGH] maxVersions pruning not implemented** - Old versions accumulate indefinitely. Implement version cleanup per `versioning.maxVersions` config.

9. **[HIGH] Processing memory usage** - `processing/service.ts:174-198`: Entire file loaded into memory for processing. Large files (e.g., video) will cause OOM. Should stream when possible.

10. **[HIGH] Event naming inconsistency** - Mixed dot/colon notation makes event subscription unreliable. Standardize to spec's `file:*` prefix.

### Medium (Improvement)

11. **[MEDIUM] Mock processors** - OCR (`ocr.ts:124-133`), video transcoding (`video.ts:226-247`), and audio transcoding (`audio.ts:146-168`) return hardcoded/mock data. Should be clearly documented as stubs or replaced with real implementations (e.g., Tesseract.js, FFmpeg).

12. **[MEDIUM] Authorizer interface simplification** - The simplified canRead/canWrite/canDelete interface is pragmatic for v0 but blocks scoped operations. Plan migration path to spec's resource+action model.

13. **[MEDIUM] QuotaProvider resource types** - Implementation only tracks bytes. Spec envisions bandwidth and processing quotas. Plan for future extension.

14. **[MEDIUM] Processing error swallowing** - `processing/service.ts:145-157`: `setImmediate` errors are caught and emit event but no logging. Add logger.error() call.

15. **[MEDIUM] stopAutoSync no-op** - `offline/sync.ts:74-76`: `stopAutoSync()` is a placeholder. Event listener removal needed for proper cleanup.

16. **[MEDIUM] Over-aggressive log redaction** - `observability/logger.ts:20`: Pattern `[A-Za-z0-9\-_]{32,}` will redact any string 32+ alphanumeric chars, including valid IDs like UUIDs or base64 hashes.

### Low (Polish)

17. **[LOW] Policy access hook** - Spec defines `access` function on policies. Implementation could add this for finer-grained policy-level authorization.

18. **[LOW] Upload session schema completeness** - `completionVersionId` field is used in code but not in the schema definition.

19. **[LOW] Missing @uifn/files package** - UI components not implemented. Tracked in pop.md as not needed for filefn itself.

20. **[LOW] Missing storage adapter packages** - PKG-002 requires s3/r2/gcs/azure/minio/local adapters. These may exist in `packages/` but were not found under filefn.

---

## Appendix: Files Audited

### Server (`filefn/server/src/`)
- index.ts, errors.ts, events.ts, schema.ts, policies.ts, router.ts, auth.ts
- policies.routes.ts, quota.routes.ts
- files/service.ts, files/routes.ts
- upload-sessions/service.ts, upload-sessions/routes.ts
- authz/authorizer.ts, authz/grants.service.ts, authz/grants.routes.ts
- shares/service.ts, shares/routes.ts
- dedup/service.ts
- processing/service.ts, processing/routes.ts
- observability/logger.ts

### Client (`filefn/client/src/`)
- index.ts, client.ts, upload-manager.ts, types.ts, retry.ts
- offline/opfs-store.ts, offline/sync.ts

### Processing (`filefn/processing/src/`)
- types.ts
- processors/thumbnail.ts, compression.ts, ocr.ts, image-transform.ts, video.ts, audio.ts

### Package configs
- filefn/server/package.json, filefn/client/package.json, filefn/processing/package.json

### Specs
- filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/ (SPEC.md, REQUIREMENTS.md, INTENT_AUDIT.md)
- filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/ (referenced)
