# Metadata
- Timestamp (UTC): 2026-03-20T11:36:51Z
- Agent name: audit
- Model: Codex (GPT-5-based; exact version not exposed)
- Launcher: Codex Desktop
- Workspace/project (absolute): /Users/serro/Documents/dev/n/superfunctions
- OS + shell:
  - OS: Darwin Mac 25.3.0 arm64
  - Shell: /bin/zsh
- Repo metadata:
  - VCS: git
  - Branch: next
  - Commit: 6f9a47d6c5f8ac166932e0156efb910bf5e32652
  - Dirty: true (pre-existing changes outside this audit scope were present; they were not modified)
- Intent/notes paths audited:
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/intent/` (directory exists but contained no files)
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/python/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/examples/full-demo/README.md`
- Spec bundle paths audited:
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/`
    - `INTENT_AUDIT.md`
    - `PLAN.md`
    - `REQUIREMENTS.md`
    - `SPEC.md`
    - `TEST_VECTORS.md`
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/`
    - `INTENT_AUDIT.md`
    - `PLAN.md`
    - `REQUIREMENTS.md`
    - `SPEC.md`
    - `TEST_VECTORS.md`
- Codebase scope audited:
  - Primary: `filefn/**/*`
  - Shared dependencies reviewed for FileFn readiness: `packages/storage`, `packages/storage-*`, `packages/files`, `packages/middleware`, `packages/db`, `uifn/files`
  - Excluded from direct pass/fail unless needed as dependency evidence: unrelated non-FileFn packages elsewhere in the monorepo
- Commands executed during audit:
  - `rg --files filefn`
  - `find filefn -maxdepth 3 \( -name 'README.md' -o -name 'SPEC.md' \)`
  - `sed -n` / `nl -ba` reads across the intent docs, spec bundles, and implementation files
  - `git branch --show-current`
  - `git rev-parse HEAD`
  - `git status --short`
  - `date -u +'%Y-%m-%dT%H:%M:%SZ'`
  - `uname -a`
  - `(cd filefn/server && npm test -- --run)`
  - `(cd filefn/server && npm run typecheck)`
  - `(cd filefn/client && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd filefn/processing && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd uifn/files && npm test -- --run && npm run typecheck && npm run build)`
  - `(cd filefn/python && python3 -m pytest)`
  - `python3 -m py_compile $(find filefn/python/filefn -name '*.py')`
  - package sweeps over `packages/storage*`, `packages/storage`, `packages/middleware`, `packages/files`, and `packages/db` for tests/typecheck/build

# Audit scope
This was a full, read-only production-readiness audit of FileFn against:
1. the authoritative intent available in-repo (the package/example READMEs above), and
2. every file in both FileFn spec bundles.

The audit covered implementation behavior, API/package conformance, security/authz, determinism, cleanup semantics, observability, client/server contract alignment, shared package health, and the Python surface that is shipped and documented in-repo.

No implementation code was changed during the audit. Only this report and the required audit log entry were written.

# Inputs audited (intent + spec bundles)
## Intent / notes inputs
- `filefn/python/README.md`
  - Claims a Python SDK that is a complete "backend-in-a-box" with chunked/resumable uploads, storage abstraction, processing, dedupe, grants, policies, sharing, and observability.
- `filefn/examples/full-demo/README.md`
  - Claims end-to-end demo capability for upload, list, download, and delete.
- `filefn/.conduct/intent/`
  - Present but empty; no additional authoritative intent files were available there.

## Spec bundle 1: `2026-01-24-new-h3m9k2s-spec`
- `SPEC.md`: canonical FileFn architecture, public APIs, semantics, limits, goals/non-goals.
- `REQUIREMENTS.md`: 45 requirement IDs spanning shared packages, adapters, server, client, UI, authz, quota, rate limiting, processing, observability.
- `TEST_VECTORS.md`: golden vectors for envelopes, upload/download flows, grants, share links, rate limiting, UI, and observability.
- `PLAN.md`: phased implementation plan and dependency graph.
- `INTENT_AUDIT.md`: 20-item inventory extracted from upstream intent, used as a starting point and independently revalidated.

## Spec bundle 2: `2026-01-26-audit-fix-k7n2m9p4-spec`
- `SPEC.md`: corrective spec focused on client/server contract alignment, proxy flows, authz, rate limiting, observability, dedupe wiring, and Azure adapter statelessness.
- `REQUIREMENTS.md`: 25 requirement IDs refining a subset of bundle 1.
- `TEST_VECTORS.md`: deterministic vectors for the audit-fix requirements.
- `PLAN.md`: repair sequencing across client/server/shared packages.
- `INTENT_AUDIT.md`: 20-item corrective intent inventory.

# High-level findings
1. **Overall verdict: NOT production ready.** The TypeScript implementation is close in several areas, but a critical upload-session authorization gap, a broken client resume contract, invalid upload-mode selection, incomplete proxy fallbacks, and an incomplete Python SDK block a production-ready call.
2. **The shared TypeScript platform underneath FileFn is in relatively good shape.** `packages/storage`, all `packages/storage-*` adapters, `packages/middleware`, `packages/db`, `filefn/client`, `filefn/processing`, and `uifn/files` all passed the audit verification commands run here. `packages/files` typecheck/build passed but still has no test files.
3. **`@filefn/server` is the main blocker.** Its tests pass (`161/161`), but `npm run typecheck` fails because test fixtures no longer satisfy the current `@superfunctions/db` `Adapter` type, so the package is not green for publish/build pipelines.
4. **Critical security issue: upload-session follow-up operations are not authorized.** `getSessionStatus`, `signPart`, `uploadPartBytes`, `completePart`, `completeSession`, and `abortSession` all operate on `uploadSessionId` without verifying the caller still owns or may act on that session. Any authenticated actor who learns a session ID can continue, finish, or abort another actor's upload. Evidence: `filefn/server/src/upload-sessions/service.ts:308-392`, `395-517`, `519-780`.
5. **High-severity contract issue: resumable uploads do not actually resume across the real client/server boundary.** The server returns `uploadedParts`, while the client expects `recordedParts`, `chunkSizeBytes`, and `fileSize`; `resumeUpload()` therefore cannot consume the real server response shape. Evidence: `filefn/server/src/upload-sessions/service.ts:308-337`, `filefn/client/src/types.ts:53-59`, `filefn/client/src/upload-manager.ts:115-158`.
6. **High-severity behavior issue: the server still advertises a forbidden bare `signed-url` upload mode.** The audit-fix spec narrowed the valid modes to `multipart-signed-url` and `proxy`, but `selectUploadMode()` still returns `signed-url` whenever signed upload URLs exist without multipart support, and `signPart()` then assumes multipart signing exists. Evidence: `filefn/server/src/upload-sessions/service.ts:138-149`, `372-382`.
7. **Share-link and artifact proxy fallbacks are still placeholders.** When signed download URLs are unavailable, share links and artifact downloads return `proxy://...` pseudo-URLs instead of working HTTP routes. Evidence: `filefn/server/src/shares/service.ts:153-161`, `filefn/server/src/processing/service.ts:306-330`.
8. **The Python SDK is not production ready and is under-specified by the current spec bundles.** It has no tests, placeholder auth/rate-limit support, incomplete upload validations, inconsistent storage protocol method usage, empty top-level exports, and README claims that exceed what the code reliably provides. Evidence: `filefn/python/README.md`, `filefn/python/filefn/__init__.py:1`, `filefn/python/filefn/server/core.py:20-35,148-168`, `filefn/python/filefn/server/upload_sessions/service.py:136-157,235-315`, `filefn/python/filefn/server/processing/service.py:172-181`, `filefn/python/filefn/server/protocols.py:11-38`.
9. **There are additional production-readiness gaps not directly captured by the spec IDs.** Notably: processing artifact APIs ignore authorization context, file deletion leaves permission/share/artifact rows behind, and `listFiles()` is not deterministic or cursor-correct at scale.

# Intent Inventory
1. Support huge-file handling through multipart/chunked uploads.
2. Support streaming uploads and/or downloads where the provider/runtime requires it.
3. Support resumability on unreliable networks.
4. Provide secure access with granular authorization.
5. Provide provider abstraction via pluggable storage adapters.
6. Provide signed upload and download URL orchestration when supported.
7. Provide a server SDK (`@filefn/server`) for upload lifecycle, metadata, downloads, listing, deletion, routing, schema, policy, quota, and processing orchestration.
8. Provide a shared `FileProvider` contract in `@superfunctions/files`.
9. Provide a shared storage contract plus stateless concrete adapters in `@superfunctions/storage` and `@superfunctions/storage-*`.
10. Provide a browser client SDK (`@filefn/client`) for resumable uploads, retries, progress, and downloads.
11. Provide offline mode (OPFS staging + later sync) when enabled.
12. Provide a UI package (`@uifn/files`) for dropzone, progress, file listing, quota usage, and plan selection.
13. Provide a processing SDK (`@filefn/processing`) with thumbnail, compression, image-transform, OCR, video, and audio processors.
14. Provide policy-driven upload constraints and storage-path/default-visibility behavior.
15. Provide an authorization model including owner access, grants, visibility, share links, and replace-by-file write checks.
16. Provide quota enforcement on upload and quota release on delete.
17. Provide rate limiting using shared middleware/KV abstractions.
18. Provide version history plus version-specific metadata/download behavior.
19. Provide tenant-scoped deduplication with public wiring/configuration.
20. Provide observability with lifecycle events, correlation IDs, and secret-safe logging.
21. Gate upload/download behavior on actual provider capabilities and constraints.
22. Provide a Python SDK that matches its README claims of a complete backend-in-a-box for uploads, sharing, dedupe, policies, processing, and observability.
23. Provide a working end-to-end demo flow for upload, list, download, and delete.

# Intent → Spec coverage matrix
| Intent # | Intent item | Spec coverage | Coverage verdict | Implementation verdict |
|---|---|---|---|---|
| 1 | Huge-file multipart/chunked upload support | Bundle 1: STORAGE-004, UPLOAD-001, CLIENT-001. Bundle 2: UPLOAD-005. | Covered | PARTIAL |
| 2 | Streaming upload/download support | Bundle 1: UPLOAD-005, FILE-002. Bundle 2: UPLOAD-005, FILE-002. | Covered | PARTIAL |
| 3 | Resumability on unreliable networks | Bundle 1: UPLOAD-001, UPLOAD-004, CLIENT-001. Bundle 2: CLIENT-001, UPLOAD-004. | Covered | FAIL |
| 4 | Granular security/access control | Bundle 1: AUTH-001, AUTHZ-001..004, SHARE-001. Bundle 2: AUTHZ-001, AUTHZ-003, AUTHZ-004, FILE-004. | Covered | FAIL |
| 5 | Provider abstraction | Bundle 1: PKG-001, PKG-002, STORAGE-001..005. Bundle 2: STORAGE-001, STORAGE-002, STORAGE-005. | Covered | PARTIAL |
| 6 | Signed upload/download orchestration | Bundle 1: STORAGE-005, UPLOAD-005, FILE-002, SHARE-001. Bundle 2: UPLOAD-005, FILE-002, STORAGE-005. | Covered | PARTIAL |
| 7 | Server SDK + router + schema + orchestration | Bundle 1: SERVER-001..004, FILE-001..004, VERSION-001, PROCESS-001..003, QUOTA-001, RATE-001. Bundle 2: SERVER-001, SERVER-002, POLICY-001, VERSION-001, RATE-001. | Covered | PARTIAL |
| 8 | Shared `FileProvider` contract | Bundle 1: PKG-005, SERVER-001. Bundle 2: SERVER-001. | Covered | PARTIAL |
| 9 | Shared storage contract + stateless adapters | Bundle 1: PKG-001, PKG-002, STORAGE-001..004. Bundle 2: STORAGE-001, STORAGE-002. | Covered | PARTIAL |
| 10 | Browser client resumable upload SDK | Bundle 1: CLIENT-001, CLIENT-003. Bundle 2: CLIENT-001. | Covered | FAIL |
| 11 | Offline mode | Bundle 1: CLIENT-002. Bundle 2: CLIENT-002. | Covered | PARTIAL |
| 12 | UI package for dropzone/progress/list/quota/plans | Bundle 1: PKG-004, UI-001. | Covered | PASS |
| 13 | Processing SDK with thumbnail/compression/image/OCR/video/audio | Bundle 1: PROCESS-002, PROCESS-003. Bundle 2: PROCESS-003. | Covered | PARTIAL |
| 14 | Policy-driven upload constraints/path/default visibility | Bundle 1: POLICY-001, UPLOAD-002. Bundle 2: POLICY-001. | Covered | PASS |
| 15 | Authorization model incl. grants/share/replace checks | Bundle 1: AUTHZ-001..004, SHARE-001, FILE-004. Bundle 2: AUTHZ-001, AUTHZ-003, AUTHZ-004, FILE-004. | Covered | FAIL |
| 16 | Quota enforcement/release | Bundle 1: UPLOAD-003, QUOTA-001, FILE-003. | Covered | PASS |
| 17 | Shared rate limiting | Bundle 1: PKG-006, PKG-007, RATE-001. Bundle 2: PKG-006, PKG-007, RATE-001. | Covered | PARTIAL |
| 18 | Version history + specific-version metadata/download | Bundle 1: FILE-004, VERSION-001, SERVER-001. Bundle 2: SERVER-001, VERSION-001. | Covered | PARTIAL |
| 19 | Tenant-scoped dedupe with public wiring | Bundle 1: DEDUPE-001. Bundle 2: DEDUPE-001. | Covered | FAIL |
| 20 | Observability, request IDs, secret-safe logging | Bundle 1: PROCESS-001, OBS-001, OBS-002. Bundle 2: PROCESS-001, OBS-001. | Covered | PASS |
| 21 | Capability-gated provider behavior | Bundle 1: STORAGE-005, UPLOAD-005. Bundle 2: STORAGE-002, UPLOAD-005, FILE-002. | Covered | FAIL |
| 22 | Python SDK matches README claims | No bundle requirements explicitly cover the Python package surface. | SPEC MISSING | FAIL |
| 23 | End-to-end demo upload/list/download/delete | Bundle 1 indirectly covers this through UPLOAD-001, FILE-001, FILE-002, FILE-003, CLIENT-001. | Covered indirectly | PARTIAL |

# Requirement coverage summary
## Bundle 1: `2026-01-24-new-h3m9k2s-spec`
- PASS: 25
- PARTIAL: 15
- FAIL: 5
- UNVERIFIED: 0

## Bundle 2: `2026-01-26-audit-fix-k7n2m9p4-spec`
- PASS: 10
- PARTIAL: 8
- FAIL: 7
- UNVERIFIED: 0

Note: these counts cover the spec-defined TypeScript/shared surfaces. The Python SDK is called out separately because it is documented and shipped in-repo but is not specified by either bundle.

# Requirement-by-requirement results
## Bundle 1: `2026-01-24-new-h3m9k2s-spec`
| ID | Status | Evidence / notes |
|---|---|---|
| PKG-001 | PASS | `packages/storage` exists; tests, typecheck, and build passed. |
| PKG-005 | PASS | `packages/files` exists and typecheck/build passed; no package tests exist yet. |
| PKG-006 | PASS | `packages/middleware/src/rate-limit.ts` exports shared rate limiting primitives; tests/typecheck/build passed. |
| PKG-007 | PASS | `packages/db/src/adapter/types.ts:446-454` exports `KVStoreAdapter`; tests/typecheck/build passed. |
| PKG-002 | PASS | `packages/storage-s3`, `-r2`, `-gcs`, `-azure`, `-minio`, `-local` all exist and passed the audit verification sweep. |
| PKG-003 | FAIL | `filefn/client/package.json:2` publishes `filefn` instead of `@filefn/client`; `filefn/server` typecheck fails. |
| PKG-004 | PASS | `uifn/files/src/index.ts` exports dropzone/progress/list/quota/plans; `uifn/files` passed 38 tests plus typecheck/build. |
| STORAGE-001 | PASS | Adapters are shareable and Azure is explicitly stateless (`packages/storage-azure/src/adapter.ts:90-103,206-292`). |
| STORAGE-002 | PASS | Adapter capabilities are exposed consistently across the storage packages; FileFn gating defects are captured under bundle 2 `STORAGE-002`. |
| STORAGE-003 | PASS | Storage interface/adapters provide `statObject` and `deleteObject`; verified in shared package sweep. |
| STORAGE-004 | PASS | Multipart-capable adapters implement multipart methods and pass their tests. |
| STORAGE-005 | PARTIAL | Completion-time size validation exists (`filefn/server/src/upload-sessions/service.ts:614-625`), but provider-side enforcement is uneven across adapters. |
| SERVER-001 | PARTIAL | `createFileFn()` returns a provider-like object, but `getFile()` ignores `versionId` (`filefn/server/src/index.ts:215-217`). |
| SERVER-002 | PARTIAL | Router and canonical envelopes exist, but the upload-status contract still diverges from the client and some proxy surfaces remain placeholders. |
| SERVER-003 | PASS | Durable schema and DB-backed models exist; `getSchema()` is exported. |
| SERVER-004 | PASS | Namespace is threaded through services and DB operations. |
| UPLOAD-001 | PARTIAL | Init/status/sign/part-complete/complete/abort are implemented, but authz and real resume compatibility are broken. |
| UPLOAD-002 | PASS | Policy constraints are enforced during init (`filefn/server/src/upload-sessions/service.ts:190-205`). |
| UPLOAD-003 | PASS | Quota is checked during init and recorded on completion/deletion. |
| UPLOAD-004 | PARTIAL | Init/part/complete behavior is mostly retry-safe, but complete is not keyed and proxy data-plane writes still upsert before explicit completion. |
| UPLOAD-005 | FAIL | `selectUploadMode()` still returns bare `signed-url`, which the audit-fix bundle forbids and the service cannot actually honor. |
| UPLOAD-006 | PARTIAL | `cleanupExpiredSessions()` exists, but it leaves `uploadParts` rows and aborted proxy-temp objects behind. |
| FILE-001 | PARTIAL | Accessible listing exists, but `listFiles()` fetches 1000 unsorted rows then filters in memory, so it is not deterministic or complete at scale. |
| FILE-002 | PASS | Main file downloads support signed URLs or proxy streaming with authz (`filefn/server/src/files/routes.ts`, `filefn/server/src/files/service.ts`). |
| FILE-003 | PARTIAL | Delete removes file rows and frees quota, but leaves grants/share/artifact rows orphaned (`filefn/server/src/files/service.ts:249-314`). |
| FILE-004 | PARTIAL | Replace-by-file creates a new version, but write auth is only checked at init; later upload-session actions bypass ownership/authorizer checks. |
| VERSION-001 | PARTIAL | Version history and bound download/metadata routes exist, but the provider surface still ignores `versionId`. |
| DEDUPE-001 | FAIL | Dedup logic exists in `upload-sessions/service.ts`, but TS `createFileFn()` never wires a dedup service into it. |
| AUTH-001 | PASS | `resolvePrincipal()` supports `resolveSession`, `provider.getSession()`, and `provider.authenticate()` (`filefn/server/src/auth.ts:18-52`). |
| AUTHZ-001 | FAIL | Upload-session and processing-artifact paths bypass full authorization enforcement. |
| AUTHZ-002 | PASS | Durable grants exist with list/create/revoke behavior and passing tests. |
| AUTHZ-003 | PARTIAL | Visibility levels exist in the default authorizer, but not all surfaces enforce them consistently. |
| AUTHZ-004 | PASS | `composeAuthorizers()` is exported and covered by tests. |
| SHARE-001 | PARTIAL | Token/expiry/auth/max-download/revoke behavior exists, but no real proxy fallback is returned when signed URLs are unsupported. |
| POLICY-001 | PASS | Policies are registrable, enforced, and listed via `/policies`. |
| QUOTA-001 | PASS | Quota provider integration works for init, complete, and delete paths. |
| RATE-001 | PARTIAL | Shared rate limiting works, but FileFn config does not support separate per-route-category limits called for by the spec notes. |
| PROCESS-001 | PASS | Upload/delete/processing lifecycle events are emitted. |
| PROCESS-002 | PASS | `@filefn/processing` exports contracts and built-in processors for thumbnail/compression/OCR/image/video/audio; tests/typecheck/build passed. |
| PROCESS-003 | PARTIAL | FlowFn enqueue exists, but retry/idempotent job semantics are not implemented. |
| CLIENT-001 | FAIL | The client resume flow expects fields the real server does not return, so resumable uploads are broken across the actual boundary. |
| CLIENT-002 | PARTIAL | Offline OPFS staging exists, but abort/progress behavior is effectively stubbed in offline mode. |
| CLIENT-003 | PASS | The client exposes framework-agnostic primitives (`UploadHandle`, retry helpers, client factory). |
| UI-001 | PASS | `uifn/files` exports and tests the requested UX primitives. |
| OBS-001 | PASS | Logger redacts secrets while preserving safe correlation IDs (`filefn/server/src/observability/logger.ts`). |
| OBS-002 | PASS | Control-plane routes emit stable error codes with `requestId`. |

## Bundle 2: `2026-01-26-audit-fix-k7n2m9p4-spec`
| ID | Status | Evidence / notes |
|---|---|---|
| DEDUPE-001 | FAIL | TS public wiring still does not pass a dedup service into `createUploadSessionService()`. |
| CLIENT-001 | FAIL | Envelope unwrapping was fixed, but the live resume/status contract is still incompatible and blocks real resumable uploads. |
| CLIENT-002 | PARTIAL | Offline mode is integrated, but offline handles still have no real abort/progress behavior. |
| SERVER-001 | FAIL | `FileProvider.getFile({ fileId, versionId })` still ignores `versionId` (`filefn/server/src/index.ts:215-217`). |
| SERVER-002 | PARTIAL | Missing routes and canonical envelopes are present, but `/upload/:id/status` still returns the wrong shape for the audited client contract. |
| POLICY-001 | PASS | `/policies` exists and returns policy constraints; init policy enforcement also works. |
| FILE-001 | PARTIAL | Accessible list semantics are implemented conceptually, but ordering/cursor behavior is unstable and incomplete. |
| FILE-002 | PASS | Main file download supports signed URLs or proxy download routes with authz and version binding. |
| FILE-004 | FAIL | Replacement remains vulnerable because later upload-session actions are not bound to the initiating principal/session owner. |
| VERSION-001 | PASS | Version metadata route exists and version download/metadata binding checks are enforced in `FileService`. |
| UPLOAD-004 | PARTIAL | Init + part completion + complete are mostly deterministic, but complete is not keyed and proxy data-plane behavior remains looser than the audited semantics. |
| UPLOAD-005 | FAIL | Upload mode selection still allows forbidden bare `signed-url`, and the implementation then assumes multipart-specific methods exist. |
| UPLOAD-006 | PARTIAL | Expiry/GC entrypoint exists, but cleanup is incomplete for proxy temp data and upload-part records. |
| STORAGE-001 | PASS | Azure adapter no longer uses per-instance mutable upload maps and passed its verification sweep. |
| STORAGE-002 | FAIL | FileFn still does not fully gate behavior on capabilities because `signed-url` mode falls through to multipart signing. |
| STORAGE-005 | PASS | Completion-time size validation is implemented with `statObject()` (`filefn/server/src/upload-sessions/service.ts:614-625`). |
| AUTHZ-001 | FAIL | Upload-session follow-up methods and processing artifact methods do not consistently enforce authorizer semantics. |
| AUTHZ-003 | PARTIAL | `private/shared/public` exists, but end-to-end readable/listable semantics are still uneven. |
| AUTHZ-004 | PASS | `composeAuthorizers(authorizers, options?)` matches the tested audited signature. |
| PKG-007 | PASS | `KVStoreAdapter` shape matches the audited spec, including optional `incr`. |
| PKG-006 | PASS | Shared rate limiter returns ISO8601 `resetAt` and is backed by `KVStoreAdapter`/`Adapter`. |
| RATE-001 | PARTIAL | FileFn uses `rateLimit` and returns ISO8601 reset data, but separate route-category limits are still not supported. |
| PROCESS-001 | PASS | `file:uploaded` and `file:deleted` are emitted with request IDs and without signed URLs. |
| PROCESS-003 | PARTIAL | Upload completion triggers processing and FlowFn enqueue, but retry/idempotent queue semantics are not implemented. |
| OBS-001 | PASS | Secret redaction and correlation ID preservation are verified in TS observability tests. |

# Spec conflicts / spec gaps
## Conflicts across the two bundles
- I did **not** find a material unresolved contradiction between the two FileFn bundles.
- Bundle 2 behaves as a corrective refinement over a subset of bundle 1, rather than a competing spec.
- The main narrowing is upload-mode selection: bundle 1 discussed signed URLs more generally, while bundle 2 explicitly constrains the valid modes to `multipart-signed-url` or `proxy`. I treated that as a refinement, not a true spec conflict.

## Spec gaps surfaced by this audit
1. **Python SDK coverage is missing from both bundles.** The repository ships `filefn/python` and its README makes production-grade claims, but neither spec bundle defines Python package requirements, parity expectations, or verification vectors.
2. **Delete cleanup semantics are under-specified.** The bundles require delete + quota release, but do not explicitly state whether file permissions, share links, and artifacts must be deleted/invalidated when a file is deleted.
3. **Processing artifact authorization is under-specified.** The bundles cover processing and observability, but not artifact read authorization semantics in the same detail as file authorization.
4. **Example/demo verification is only indirectly covered.** The example README claims full end-to-end behavior, but no bundle encodes a smoke test for the demo apps themselves.

# Cross-cutting audits
## Security / authz / validation boundaries
- **Critical:** upload-session follow-up methods ignore effective ownership/authorization after init. `getSessionStatus()` and `signPart()` explicitly discard `ctx` (`filefn/server/src/upload-sessions/service.ts:314,345`), while the other upload-session operations only verify existence/status/expiry. This makes `uploadSessionId` effectively act like a bearer capability.
- **High:** processing artifact listing/download ignores authorization context. `listArtifacts()` and `getArtifactDownloadUrl()` both `void ctx`, so any caller reaching those routes can fetch artifact metadata/URLs without a file-level authz check (`filefn/server/src/processing/service.ts:290-330`).
- **High:** share-link proxy fallback is not real. Returning `proxy://...` is not a usable or secure HTTP fallback (`filefn/server/src/shares/service.ts:161`, `filefn/server/src/processing/service.ts:330`).
- **Moderate:** delete leaves permissions, shares, and artifacts in place, which creates stale access state and orphaned metadata (`filefn/server/src/files/service.ts:282-292` plus absence of cleanup for related tables).
- **Moderate:** share download counts are incremented before confirming a usable signed/proxy URL is actually produced (`filefn/server/src/shares/service.ts:146-151`).

## Determinism invariants
- `listFiles()` is nondeterministic: it reads the first 1000 files with no `orderBy`, filters in memory, and synthesizes `nextCursor` from an unstable set (`filefn/server/src/files/service.ts:101-162`). This can skip readable files and make pagination drift under load.
- The client/server resume protocol is nondeterministic because the client and server disagree on status payload shape. Real-world resume behavior therefore depends on mock-only assumptions rather than the deployed API.
- Upload mode selection is not deterministic with capability sets that advertise signed URLs without multipart support; the server chooses a mode it cannot finish.

## Limits / caps
- Session expiry exists, but cleanup is incomplete for proxy temp parts and upload-part rows.
- Rate limiting returns ISO reset information, but the FileFn config still lacks separate limit buckets per route category.
- `packages/files` has no tests, which reduces confidence in the shared `FileProvider` contract despite the package building cleanly.
- The Python package has zero tests and still declares `Development Status :: 3 - Alpha` in `pyproject.toml`, which is inconsistent with the README’s broader completeness claims.

## Error handling + canonical envelopes
- The TypeScript control-plane routes are largely aligned on canonical success/error envelopes.
- The biggest control-plane contract miss is the upload-status payload, which is still not the shape the client expects.
- Error-code stability and `requestId` propagation are in good shape on the TypeScript routes that were exercised.
- Proxy pseudo-URLs (`proxy://...`) are effectively a control-plane contract break, because they cannot be consumed by normal clients.

## Compatibility / versioning / migrations
- Version metadata and bound download routes were fixed in the server file service, but the provider-level `getFile()` call path still ignores `versionId`.
- The client package name is incompatible with the canonical package boundary (`filefn` vs `@filefn/client`).
- `@filefn/server` test/build compatibility is incomplete because `tsc` currently fails on test fixture adapter typing, even while Vitest passes.
- Python imports are only partially validated locally because the current environment does not have the `superfunctions` dependency installed for full import/runtime checks.

## Python SDK readiness (out-of-spec but in-repo)
- `filefn/python/filefn/__init__.py` is effectively empty.
- `AuthConfig` is a placeholder and `rate_limit` is explicitly marked “Not implemented in python yet” (`filefn/python/filefn/server/core.py:20-35`).
- The Python upload-session service repeats the bare `signed-url` mode problem, contains incomplete expiry logic, and marks critical validations as omitted (`filefn/python/filefn/server/upload_sessions/service.py:136-157,276-315`).
- The Python processing service calls `upload_object`, but the declared `StorageAdapter` protocol only defines `put_object`, so the interface contract is internally inconsistent (`filefn/python/filefn/server/processing/service.py:172-181` vs `filefn/python/filefn/server/protocols.py:11-18`).
- `python3 -m pytest` collected **0 tests** during this audit.

# Recommendations
1. **Fix upload-session authorization first.** Bind every upload-session follow-up operation to session owner/tenant or an equivalent authorizer decision. This is the highest-severity issue. Reference: intent items 3, 4, 15; requirements `AUTHZ-001`, `FILE-004`, `UPLOAD-004`, `UPLOAD-005`.
2. **Repair the resumability contract end-to-end.** Make `/upload/:id/status` match the client’s expected schema or vice versa, and remove the unsupported bare `signed-url` mode entirely. Reference: intent items 1, 2, 3, 10, 21; requirements `CLIENT-001`, `SERVER-001`, `SERVER-002`, `UPLOAD-005`, `STORAGE-002`.
3. **Replace placeholder proxy URLs with real routes everywhere.** Share-link downloads and artifact downloads need working proxy HTTP paths and matching authz checks. Reference: intent items 2, 4, 6, 15, 20; requirements `FILE-002`, `SHARE-001`, plus the out-of-spec artifact auth gap.
4. **Make the server package publish-green.** `@filefn/server` must pass `npm run typecheck` and `npm run build` in CI, not just Vitest. Update test fixture adapters or TypeScript config so package builds do not fail on stale mocks. Reference: intent item 7; requirements `PKG-003`, `SERVER-002`.
5. **Tighten data consistency and cleanup.** Make list ordering/cursor deterministic, delete related permission/share/artifact records when files are deleted, and fully clean proxy temp objects/upload-part rows during abort/GC. Reference: intent items 15, 16, 18; requirements `FILE-001`, `FILE-003`, `UPLOAD-006`, `VERSION-001`.
6. **Decide the Python support posture explicitly.** Either complete the Python implementation with parity tests and corrected protocols, or mark it experimental and reduce the README claims until it is actually production ready. Reference: intent item 22; current verdict `SPEC MISSING` + implementation `FAIL`.
7. **Add missing confidence checks.** Add tests for `packages/files`, artifact authorization, delete cleanup, and a basic example smoke test. Reference: intent items 8, 20, 23.

# Appendix
## Verification summary
- `filefn/server`
  - `npm test -- --run`: PASS (`19` files, `161` tests)
  - `npm run typecheck`: FAIL due test fixture `Adapter` typing drift (`internal` missing on mocked adapters)
- `filefn/client`
  - `npm test -- --run`: PASS (`6` files, `40` tests)
  - `npm run typecheck`: PASS
  - `npm run build`: PASS
- `filefn/processing`
  - `npm test -- --run`: PASS (`4` files, `55` tests)
  - `npm run typecheck`: PASS
  - `npm run build`: PASS
- `uifn/files`
  - `npm test -- --run`: PASS (`1` file, `38` tests)
  - `npm run typecheck`: PASS
  - `npm run build`: PASS
- Shared packages used by FileFn
  - `packages/storage`, `packages/storage-s3`, `packages/storage-r2`, `packages/storage-gcs`, `packages/storage-azure`, `packages/storage-minio`, `packages/storage-local`: tests/typecheck/build PASS in the audit sweep
  - `packages/middleware`: tests/typecheck/build PASS
  - `packages/db`: tests/typecheck/build PASS
  - `packages/files`: typecheck/build PASS; `npm test -- --run` reports no test files
- Python
  - `python3 -m pytest` in `filefn/python`: collected `0` tests
  - `python3 -m py_compile` over `filefn/python/filefn/**/*.py`: PASS

## Key implementation references
- Upload-session authz gap and invalid upload mode:
  - `filefn/server/src/upload-sessions/service.ts:138-149`
  - `filefn/server/src/upload-sessions/service.ts:308-392`
  - `filefn/server/src/upload-sessions/service.ts:395-517`
  - `filefn/server/src/upload-sessions/service.ts:519-818`
- Resume contract mismatch:
  - `filefn/server/src/upload-sessions/service.ts:308-337`
  - `filefn/client/src/types.ts:53-59`
  - `filefn/client/src/upload-manager.ts:115-158`
- Provider-level `versionId` bug:
  - `filefn/server/src/index.ts:215-217`
- List/delete consistency issues:
  - `filefn/server/src/files/service.ts:101-162`
  - `filefn/server/src/files/service.ts:249-355`
- Placeholder proxy fallbacks and processing auth gaps:
  - `filefn/server/src/shares/service.ts:146-161`
  - `filefn/server/src/processing/service.ts:290-330`
  - `filefn/server/src/processing/routes.ts:56-104`
- Python readiness issues:
  - `filefn/python/README.md`
  - `filefn/python/filefn/__init__.py:1`
  - `filefn/python/filefn/server/core.py:20-35,148-168`
  - `filefn/python/filefn/server/upload_sessions/service.py:136-157,235-315`
  - `filefn/python/filefn/server/processing/service.py:172-181`
  - `filefn/python/filefn/server/protocols.py:11-38`

## Environment details
- Working directory: `/Users/serro/Documents/dev/n/superfunctions`
- Date audited: `2026-03-20`
- Time zone in user context: `Asia/Kolkata`
- UTC timestamp used for report/logging: `2026-03-20T11:36:51Z`
