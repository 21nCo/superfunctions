# INTENT_AUDIT.md — FileFn

This document maps the extracted **Intent Inventory** to coverage in:
- `SPEC.md`
- `REQUIREMENTS.md`
- `TEST_VECTORS.md`

## Intent Inventory (exhaustive)
1. Support huge file handling including multipart uploads.
2. Support streaming (upload and/or download) where needed.
3. Support resumability for unreliable networks.
4. Provide security with granular access control.
5. Provide provider abstraction (pluggable cloud providers).
6. Provide signed URL generation and orchestration (upload + download).
7. Provide Server SDK `@filefn/server` that:
   - tracks upload sessions/metadata
   - coordinates multipart uploads
   - exposes file management APIs (upload, download, delete, replace, get, list)
   - uses `@superfunctions/http` for endpoints
   - supports versioning and deduplication
   - supports rate limiting (via shared middleware)
   - supports processing workflows with lifecycle events
   - accepts a FlowFn instance for async workflows
   - supports quota management via BillFn plugin
   - supports authentication + authorization via `@superfunctions/auth` (including `AuthProvider.getSession()` caching when available)
   - supports observability via LogFn and hooks
8. Provide `FileProvider` interface in `@superfunctions/files`, implemented by `@filefn/server`.
9. Provide storage interface `@superfunctions/storage` and stateless storage adapters:
   - `@superfunctions/storage-s3`
   - `@superfunctions/storage-r2`
   - `@superfunctions/storage-gcs`
   - `@superfunctions/storage-azure`
   - `@superfunctions/storage-minio`
   - `@superfunctions/storage-local`
10. Provide Client SDK `@filefn/client` that:
   - communicates with hosted filefn backend
   - supports multipart + client-side resumability (chunking, progress, retries)
   - supports offline caching/sync using OPFS when enabled
   - provides framework-agnostic hooks
   - orchestrates signed URLs
11. Provide UI library `@uifn/files` with:
   - pricing and plans
   - upload drop zone
   - storage quota usage and analytics
12. Provide Processing SDK `@filefn/processing` with:
   - thumbnail generation
   - compression
   - image processing: resize/crop/rotate
   - OCR
   - video processing
   - audio processing
13. Define policies for uploads (e.g., user-avatar) with:
   - allowed content types
   - max size
   - visibility defaults
   - storage path derivation
   - access rule hook
14. Authorization model requirements:
   - optional auth provider and custom session resolution
   - pluggable authorizers
   - visibility (`private/shared/public`)
   - permission grants to user/role/tenant with expiry
   - share links with token and constraints
   - operation scopes (metadata/content/permissions/audit)
   - authorizer composition helper
15. Quota responsibilities:
   - handled by billfn-like plugin interface
   - check quota before upload
   - record usage after upload
   - record negative usage after delete
16. Rate limiting:
   - configurable per operation category (upload init, sign, download)
   - uses shared `@superfunctions/middleware` primitives and persistence via `@superfunctions/db` `Adapter` or `KVStoreAdapter`
17. Versioning semantics:
   - replace creates a new version
   - maxVersions pruning
18. Deduplication semantics:
   - content-hash-based
   - tenant-scoped (no cross-tenant dedupe)
19. Observability:
   - lifecycle events with correlation IDs
   - must not log secrets (signed URLs, share tokens)
20. Provider constraint awareness:
   - chunk size and multipart limits should reflect provider rules (e.g., S3 part constraints)

## Coverage mapping
For each intent item: (a) SPEC.md coverage, (b) requirements, (c) test vectors.

1) Huge file handling + multipart
- SPEC.md: Goals; Public API (`StorageAdapter` multipart); Semantics → Upload sessions
- Requirements: STORAGE-004, UPLOAD-001, CLIENT-001
- Test vectors: TV-UPLOAD-MULTIPART-001, TV-UPLOAD-INIT-001, TV-CLIENT-UPLOAD-001

2) Streaming
- SPEC.md: Public API (`openUploadStream`/`openDownloadStream`); Semantics → Proxy upload fallback
- Requirements: UPLOAD-005, FILE-002
- Test vectors: TV-UPLOAD-MODE-001, TV-STORAGE-CAP-001

3) Resumability
- SPEC.md: Semantics → Upload sessions; Idempotency and retries
- Requirements: UPLOAD-001, UPLOAD-004, CLIENT-001
- Test vectors: TV-UPLOAD-STATUS-001, TV-IDEMPOTENCY-001, TV-CLIENT-UPLOAD-001

4) Security + granular access control
- SPEC.md: Security; Authorization; Policies; Share links
- Requirements: AUTHZ-001, AUTHZ-002, AUTHZ-003, SHARE-001, POLICY-001, OBS-001
- Test vectors: TV-FILE-GET-NEG-001, TV-PERM-GRANT-NEG-001, TV-SHARE-DOWNLOAD-NEG-001

5) Provider abstraction
- SPEC.md: Overview; `@superfunctions/storage` and adapters
- Requirements: PKG-001, PKG-002, STORAGE-001
- Test vectors: TV-STORAGE-ADAPTERS-001, TV-STORAGE-ADAPTERS-NEG-001

6) Signed URL generation/orchestration
- SPEC.md: StorageAdapter `sign*Url`; HTTP endpoints; Semantics
- Requirements: STORAGE-005 (SHOULD), UPLOAD-005, FILE-002, CLIENT-001
- Test vectors: TV-UPLOAD-PART-SIGN-001, TV-FILE-DOWNLOAD-001, TV-CLIENT-UPLOAD-001

7) Server SDK features list
- SPEC.md: Public API `@filefn/server`; Routes; Semantics; Quotas; Rate limiting; Observability
- Requirements: SERVER-001..004, UPLOAD-001..006, FILE-001..004, VERSION-001, QUOTA-001, RATE-001, PROCESS-001, OBS-001..002
- Test vectors: TV-UPLOAD-INIT-001, TV-UPLOAD-COMPLETE-001, TV-FILE-GET-001, TV-FILE-DELETE-001

8) FileProvider interface
- SPEC.md: `@superfunctions/files` → FileProvider
- Requirements: PKG-005, SERVER-001
- Test vectors: TV-FILEPROVIDER-001, TV-FILEPROVIDER-NEG-001

9) Storage interfaces + adapter list
- SPEC.md: Overview; Public API (`StorageAdapter`); adapter list in overview
- Requirements: PKG-002
- Test vectors: TV-STORAGE-ADAPTERS-001

10) Client SDK features list
- SPEC.md: Public API `@filefn/client`; Semantics (upload sessions)
- Requirements: CLIENT-001, CLIENT-002, CLIENT-003
- Test vectors: TV-CLIENT-UPLOAD-001, TV-CLIENT-OFFLINE-001, TV-CLIENT-HOOKS-001

11) UI library (pricing/plans, upload, quota usage/analytics)
- SPEC.md: `@uifn/files` section
- Requirements: PKG-004, UI-001
- Test vectors: TV-UI-001, TV-UI-PLANS-001

12) Processing SDK
- SPEC.md: Public API `@filefn/processing`; Semantics → Processing
- Requirements: PROCESS-002, PROCESS-003
- Test vectors: TV-PROCESS-001, TV-PROCESS-FLOW-001

13) Policies
- SPEC.md: Public API (`FileFnPolicy`); Semantics → Policies
- Requirements: POLICY-001, UPLOAD-002
- Test vectors: TV-UPLOAD-INIT-NEG-001, TV-POLICY-LIST-001

14) Authorization model details + composition
- SPEC.md: Public API (`Authorizer`, `composeAuthorizers`); Semantics → Authorization
- Requirements: AUTHZ-001..004, SHARE-001
- Test vectors: TV-AUTHZ-COMPOSE-001, TV-PERM-GRANT-001, TV-VISIBILITY-001

15) Quota via billfn plugin
- SPEC.md: Public API (`QuotaProvider`); Semantics → Quotas
- Requirements: QUOTA-001, UPLOAD-003, FILE-003
- Test vectors: TV-QUOTA-NEG-001, TV-FILE-DELETE-001

16) Rate limiting
- SPEC.md: Public API (`@superfunctions/middleware` + `KVStoreAdapter`); Semantics → Rate limiting
- Requirements: PKG-006, PKG-007, RATE-001
- Test vectors: TV-RATE-001, TV-RATE-NEG-001

17) Versioning semantics
- SPEC.md: Semantics → File versioning
- Requirements: FILE-004, VERSION-001
- Test vectors: TV-VERSION-REPLACE-001, TV-VERSION-LIST-001

18) Deduplication
- SPEC.md: Semantics → Deduplication
- Requirements: DEDUPE-001
- Test vectors: TV-DEDUP-001, TV-DEDUP-NEG-001

19) Observability (events + no secret leakage)
- SPEC.md: Observability; Invariants (no secret leakage)
- Requirements: PROCESS-001, OBS-001
- Test vectors: TV-OBS-001, TV-OBS-LOG-NEG-001

20) Provider constraints
- SPEC.md: Limits / caps → Provider constraints
- Requirements: STORAGE-005
- Test vectors: TV-UPLOAD-INIT-NEG-002

## Final audit statement
No missing intent items.

Changes made during audit: Updated UI scope to include pricing/plans and usage analytics; added `composeAuthorizers` coverage (SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, PHASE_05/PHASE_15); updated architecture to split `FileProvider` into `@superfunctions/files`, add shared rate limiting primitives (`@superfunctions/middleware` + `KVStoreAdapter`), and incorporate `AuthProvider.getSession()` caching semantics.
