# Metadata
- Timestamp (UTC): 2026-03-20T12:56:10Z
- Agent name: spec
- Model: Codex (GPT-5-based; exact version not exposed)
- Launcher: Codex Desktop
- Workspace/project (absolute): /Users/serro/Documents/dev/n/superfunctions/filefn
- OS + shell:
  - OS: Darwin Mac 25.3.0 arm64
  - Shell: /bin/zsh
- Repo metadata:
  - VCS: git
  - Branch: next
  - Commit: 6f9a47d6c5f8ac166932e0156efb910bf5e32652
  - Dirty: true
- Spec metadata:
  - spec_type: audit-fix
  - spec_id: kevfp02n
  - spec_folder: 2026-03-20-audit-fix-kevfp02n-spec
  - spec_folder (absolute): /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-20-audit-fix-kevfp02n-spec
- Inputs read (authoritative for this spec):
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/audits/2026-03-20-t8w3b4h3-full-audit.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/python/README.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/examples/full-demo/README.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/SPEC.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/REQUIREMENTS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/TEST_VECTORS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/PLAN.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/INTENT_AUDIT.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/SPEC.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/REQUIREMENTS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/TEST_VECTORS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/PLAN.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec/INTENT_AUDIT.md
- Audit references:
  - audit: /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/audits/2026-03-20-t8w3b4h3-full-audit.md
  - audited spec: /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec (spec_id: h3m9k2s)
  - prior audit-fix spec: /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec (spec_id: k7n2m9p4)

# Overview
This is a superseding **audit-fix** specification for FileFn.

The one-sentence goal is: **make FileFn production-ready across its TypeScript and Python surfaces by eliminating every unresolved audit finding without regressing already-passing behavior.**

This spec is authoritative for the unresolved surfaces identified in the 2026-03-20 audit. It preserves the canonical FileFn architecture from the prior bundles while extending it in the following ways that were missing or underspecified:
- upload-session authorization across every follow-up operation
- resumable upload contract parity between server and browser client
- elimination of the unsupported bare `signed-url` upload mode
- real proxy download behavior for file, share, and artifact flows
- deterministic listing and version-aware provider behavior
- delete cleanup semantics including permissions, shares, artifacts, temp upload data, and dedupe-safe storage deletion
- build/test/package readiness gates
- Python SDK parity, exported surfaces, and executable tests
- demo smoke verification for the bundled example

## Context
- Project name: Superfunctions monorepo, FileFn package family
- One-sentence goal: Make FileFn production-ready by closing the remaining audit gaps across TypeScript and Python surfaces.
- Target users:
  - application developers using `@filefn/server`, `@filefn/client`, and `@filefn/processing`
  - developers consuming FileFn through `@superfunctions/files`
  - Python application developers using the `filefn` package
- Target environments:
  - TypeScript server: Node.js >= 18 and Fetch-compatible runtimes where the configured storage adapter supports the selected mode
  - Browser client: modern browsers with Fetch and Streams; offline mode uses OPFS when available
  - Python: CPython >= 3.10 on macOS/Linux/Windows, online server workloads
  - Storage providers: S3, R2, GCS, Azure, MinIO, Local
- Languages/packages required:
  - TypeScript packages: `filefn/server`, `filefn/client`, `filefn/processing`, `uifn/files`, `packages/files`, `packages/storage*`, `packages/middleware`, `packages/db`
  - Python package: `filefn/python`
- Existing systems it must integrate with:
  - `@superfunctions/storage` and concrete storage adapters
  - `@superfunctions/files`
  - `@superfunctions/db` `Adapter` and `KVStoreAdapter`
  - `@superfunctions/middleware`
  - optional `@superfunctions/auth` provider
  - optional FlowFn queue provider
  - optional LogFn-style logger
- Data model summary:
  - `files`: stable file records with current version pointer and access metadata
  - `fileVersions`: immutable stored versions bound to a file
  - `uploadSessions`: resumable uploads, initiator identity, optional anonymous session token hash, TTL, upload mode, completion result
  - `uploadParts`: recorded part metadata for resumable uploads
  - `filePermissions`: explicit grants
  - `fileShares`: tokenized share links with expiry/download counters
  - `fileArtifacts`: derived artifacts bound to file + version
  - `storageReferences` or equivalent derived reference accounting: implementation-defined, but spec requires dedupe-safe deletion semantics
- Security model:
  - authentication is optional, but every mutation/read path MUST still bind to a caller identity or explicit session/share capability token
  - authorization is enforced via pluggable `Authorizer` plus ownership, visibility, grants, and share-link rules
  - multi-tenancy via optional `tenantId`; cross-tenant dedupe is forbidden
  - signed URLs, share tokens, upload session tokens, and secrets MUST NOT be logged
- Performance constraints:
  - large-file uploads MUST work through multipart signed URLs when supported, otherwise through proxy upload
  - list pagination MUST be deterministic and stable under concurrency
  - retry/resume semantics MUST be deterministic
  - delete cleanup MUST not orphan storage or stale access rows
- Non-goals / out of scope:
  - TUS support
  - new storage adapters beyond the existing package set
  - CDN/media-delivery features
  - DAM/workflow features unrelated to the current FileFn scope
  - new unrelated UI components beyond current file UX intent
- Hard constraints:
  - canonical control-plane envelopes are mandatory
  - no placeholder proxy URIs are allowed in any public response
  - every production package surface MUST be build-green locally
  - Python parity is required because the package is shipped and documented in-repo

## Assumptions
1. TypeScript remains the canonical wire-protocol reference; Python MUST match semantics even where method names use snake_case.
2. Anonymous uploads remain supported only if FileFn can bind continuation to a server-minted opaque upload-session token; anonymous session continuation without such a token is invalid.
3. Delete semantics remain hard-delete semantics for file metadata and share/grant/artifact metadata unless another live record still references the same storage object.
4. No new external runtime dependencies are required to satisfy this spec; if a test-only dependency becomes necessary, it MUST be justified in implementation review and MUST NOT change runtime semantics.

# Glossary
- **Canonical envelope**: JSON wrapper `{ ok, data|error, requestId, warnings? }` used for every control-plane response.
- **Control-plane**: JSON metadata/API routes; no raw file bytes.
- **Data-plane**: raw byte transfer for upload/download, either direct-to-storage or proxied through FileFn.
- **Upload session token**: opaque server-minted token returned only for anonymous upload sessions; the server stores only a hash and requires the plaintext token on follow-up session operations.
- **Recorded part**: a part that FileFn has durably accepted and associated with an upload session.
- **Readable file set**: files visible to a caller because of ownership, visibility, grants, or share rules as defined by the authorizer stack.
- **Storage reference**: a logical reference from a file version or artifact to a storage key. Physical deletion is permitted only when no live reference remains.
- **Proxy descriptor**: a control-plane response containing a real FileFn HTTP URL for a proxy data-plane route.
- **Compatibility alias**: an optional additive response field kept temporarily for migration; aliases are not required unless stated in this spec.

# Goals / Non-goals
## Goals
FileFn MUST:
1. close every unresolved finding from the 2026-03-20 audit report;
2. preserve the canonical envelopes, route shapes, and shared package roles from the prior FileFn specs unless this bundle explicitly supersedes them;
3. make upload, download, list, delete, share, artifact, dedupe, observability, and processing flows production-safe;
4. make `@filefn/server`, `@filefn/client`, `@filefn/processing`, `@superfunctions/files`, and `filefn/python` locally verifiable and publishable;
5. define deterministic behavior for retries, pagination, idempotency, and cleanup;
6. remove ambiguity for Python parity and example/demo verification.

## Non-goals
1. Replacing the upload-session protocol with TUS.
2. Adding new storage backends not already present in the monorepo.
3. Introducing unrelated product features outside the audit scope.

# Public API
## Package boundaries
### TypeScript packages
- `filefn/server/package.json` MUST publish as `@filefn/server`.
- `filefn/client/package.json` MUST publish as `@filefn/client`.
- `filefn/processing/package.json` MUST publish as `@filefn/processing`.
- `packages/files/package.json` MUST publish as `@superfunctions/files` and MUST include FileProvider conformance tests.

### Python package
- `filefn/python/pyproject.toml` MUST continue to publish the Python package as `filefn`.
- `filefn/python/filefn/__init__.py` MUST export at minimum:
```python
from .server import create_file_fn, FileFn, FileFnConfig
```
- `filefn/python/filefn/processing/__init__.py` MUST export thumbnail, compression, OCR, image-transform, video, and audio processor factories.

## `@filefn/server` TypeScript surface
```ts
export interface FileFnConfig {
  db: import('@superfunctions/db').Adapter;
  storage: import('@superfunctions/storage').StorageAdapter;
  policies?: Policy[];
  auth?: AuthConfig;
  quota?: QuotaProvider;
  rateLimit?: {
    persistence: import('@superfunctions/db').Adapter | import('@superfunctions/db').KVStoreAdapter;
    algorithm?: 'fixed-window' | 'sliding-window' | 'token-bucket';
    limits: {
      uploadInit: { windowSeconds: number; maxRequests: number };
      uploadSign: { windowSeconds: number; maxRequests: number };
      uploadComplete: { windowSeconds: number; maxRequests: number };
      download: { windowSeconds: number; maxRequests: number };
      shareDownload?: { windowSeconds: number; maxRequests: number };
      artifactDownload?: { windowSeconds: number; maxRequests: number };
    };
  };
  dedup?: {
    enabled?: boolean;
  };
  processing?: {
    enabled?: boolean;
    processors?: Processor[];
    flowFn?: FlowFnProvider;
  };
  logger?: Logger;
  authorizer?: Authorizer;
  namespace?: string;
  defaultChunkSizeBytes?: number;
  uploadSessionTtlSeconds?: number;
  signedUrlTtlSeconds?: number;
}
```

### `FileProvider` conformance
```ts
export interface FileProvider {
  createUploadSession(input: {
    policy: string;
    fileName: string;
    size: number;
    mimeType: string;
    fileId?: string;
    metadata?: Record<string, any>;
    idempotencyKey?: string;
  }, ctx: FileProviderContext): Promise<{
    uploadSessionId: string;
    uploadMode: 'multipart-signed-url' | 'proxy';
    chunkSizeBytes: number;
    totalParts: number;
    expiresAt: string;
    uploadSessionToken?: string; // returned only for anonymous sessions
  }>;

  getUploadSessionStatus(input: { uploadSessionId: string }, ctx: FileProviderContext): Promise<{
    uploadSessionId: string;
    status: 'pending' | 'in_progress' | 'completed' | 'aborted';
    totalParts: number;
    recordedParts: number[];
    chunkSizeBytes: number;
    fileSize: number;
    expiresAt: string;
  }>;

  signUploadPart(input: {
    uploadSessionId: string;
    partNumber: number;
    contentLength: number;
  }, ctx: FileProviderContext): Promise<{
    url: string;
    headers?: Record<string, string>;
    expiresAt: string;
  }>;

  completeUploadPart(input: {
    uploadSessionId: string;
    partNumber: number;
    etag: string;
    size: number;
  }, ctx: FileProviderContext): Promise<{ recorded: true }>;

  completeUploadSession(input: { uploadSessionId: string }, ctx: FileProviderContext): Promise<{
    fileId: string;
    versionId: string;
  }>;

  abortUploadSession(input: { uploadSessionId: string }, ctx: FileProviderContext): Promise<{ aborted: true }>;

  getFile(input: { fileId: string; versionId?: string }, ctx: FileProviderContext): Promise<FileMetadata>;
  listFiles(input: { cursor?: string; limit?: number }, ctx: FileProviderContext): Promise<{
    files: FileMetadata[];
    nextCursor?: string;
  }>;
  deleteFile(input: { fileId: string }, ctx: FileProviderContext): Promise<{ deleted: true }>;
}
```

## Browser client surface
```ts
export interface FileFnClientConfig {
  baseUrl: string;
  getAuthHeaders?: () => Promise<Record<string, string>>;
  chunkSizeBytes?: number;
  concurrency?: number;
  retryDelaysMs?: number[];
  offline?: {
    enabled: boolean;
    opfsDir?: string;
  };
}

export interface UploadHandle {
  uploadSessionId: string;
  abort(): Promise<void>;
  onProgress(cb: (input: {
    bytesUploaded: number;
    bytesTotal: number;
    partNumber?: number;
  }) => void): void;
  done(): Promise<{ fileId: string; versionId: string }>;
}
```

The browser client MUST:
- preserve and replay `uploadSessionToken` for anonymous resumable sessions;
- consume `recordedParts`, `chunkSizeBytes`, and `fileSize` from upload status;
- handle `multipart-signed-url` and `proxy` modes without heuristics;
- throw `FILEFN_OFFLINE_UNSUPPORTED` when offline mode is requested but unavailable.

## Python public surface
```python
class FileFnConfig(BaseModel):
    db: Any
    storage: Any
    policies: list[Policy] = []
    auth: AuthConfig | None = None
    quota: QuotaProvider | None = None
    rate_limit: RateLimitConfig | None = None
    dedup: dict[str, Any] | None = None
    processing: dict[str, Any] | None = None
    logger: Any | None = None
    authorizer: Authorizer | None = None
    namespace: str = 'filefn'
    default_chunk_size_bytes: int | None = None
    upload_session_ttl_seconds: int | None = None
    signed_url_ttl_seconds: int | None = None

class FileFn:
    async def create_upload_session(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
    async def get_upload_session_status(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
    async def sign_upload_part(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
    async def complete_upload_part(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
    async def complete_upload_session(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
    async def abort_upload_session(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
    async def get_file(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
    async def list_files(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
    async def delete_file(self, input: dict[str, Any], ctx: Any) -> dict[str, Any]: ...
```

Python semantics MUST match the TypeScript semantics defined in this spec. Snake_case method names are allowed; wire semantics are not.

## HTTP routes
### Control-plane routes
- `POST /upload/init`
- `GET /upload/:uploadSessionId/status`
- `POST /upload/:uploadSessionId/parts/:partNumber/sign`
- `POST /upload/:uploadSessionId/parts/:partNumber/complete`
- `POST /upload/:uploadSessionId/complete`
- `POST /upload/:uploadSessionId/abort`
- `GET /`
- `GET /:fileId`
- `DELETE /:fileId`
- `GET /:fileId/download`
- `GET /:fileId/versions`
- `GET /:fileId/versions/:versionId`
- `GET /:fileId/versions/:versionId/download`
- `POST /:fileId/permissions`
- `GET /:fileId/permissions`
- `DELETE /:fileId/permissions/:permissionId`
- `POST /:fileId/share-links`
- `GET /:fileId/share-links`
- `GET /share-links/:token/download`
- `DELETE /:fileId/share-links/:token`
- `GET /:fileId/artifacts`
- `GET /:fileId/artifacts/:artifactId/download`
- `POST /:fileId/process`
- `GET /policies`
- `GET /quota/storage`

### Data-plane routes
- `PUT /upload/:uploadSessionId/parts/:partNumber`
- `GET /proxy/files/:fileId/download`
- `GET /proxy/files/:fileId/versions/:versionId/download`
- `GET /proxy/share-links/:token/download`
- `GET /proxy/files/:fileId/artifacts/:artifactId/download`

# Data formats / protocol
## Canonical success envelope
```json
{ "ok": true, "data": {}, "warnings": [], "requestId": "req_..." }
```
Rules:
- `warnings` MAY be omitted only when not applicable.
- `requestId` MUST be echoed when the request carried `x-request-id`; otherwise the server SHOULD generate one.

## Canonical error envelope
```json
{
  "ok": false,
  "error": {
    "code": "FILEFN_...",
    "message": "...",
    "details": {}
  },
  "requestId": "req_..."
}
```

### Required stable error codes
- `FILEFN_AUTH_REQUIRED` (401)
- `FILEFN_FORBIDDEN` (403)
- `FILEFN_NOT_FOUND` (404)
- `FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED` (400)
- `FILEFN_POLICY_MAX_SIZE_EXCEEDED` (400)
- `FILEFN_QUOTA_EXCEEDED` (402)
- `FILEFN_RATE_LIMITED` (429)
- `FILEFN_INVALID_PART_NUMBER` (400)
- `FILEFN_INVALID_ETAG` (400)
- `FILEFN_UPLOAD_INCOMPLETE` (409)
- `FILEFN_UPLOAD_EXPIRED` (410)
- `FILEFN_IDEMPOTENCY_CONFLICT` (409)
- `FILEFN_PART_CONFLICT` (409)
- `FILEFN_UPLOAD_SIZE_MISMATCH` (409)
- `FILEFN_NO_SUPPORTED_UPLOAD_MODE` (500)
- `FILEFN_OFFLINE_UNSUPPORTED` (400)
- `FILEFN_SESSION_TOKEN_REQUIRED` (401)
- `FILEFN_SESSION_TOKEN_INVALID` (403)
- `FILEFN_PROCESSING_ENQUEUE_FAILED` (503)

## Upload init request body
```json
{
  "policy": "user-avatar",
  "fileName": "avatar.png",
  "size": 2097152,
  "mimeType": "image/png",
  "fileId": "file_... (optional)",
  "metadata": {} (optional)
}
```

The server MUST reject `fileSize` and `contentType` as canonical field names. A compatibility shim MAY accept them transiently, but canonical responses and tests MUST use `size` and `mimeType`.

## Upload init success data
```json
{
  "uploadSessionId": "upl_0001",
  "uploadMode": "multipart-signed-url",
  "chunkSizeBytes": 8388608,
  "totalParts": 1,
  "expiresAt": "2026-03-21T12:56:10Z",
  "uploadSessionToken": "upls_live_... (only when anonymous)"
}
```

## Upload status success data
```json
{
  "uploadSessionId": "upl_0001",
  "status": "in_progress",
  "totalParts": 3,
  "recordedParts": [1, 2],
  "chunkSizeBytes": 8388608,
  "fileSize": 16777217,
  "expiresAt": "2026-03-21T12:56:10Z"
}
```

A transitional `uploadedParts` alias MAY be included for one implementation cycle, but canonical clients and tests MUST use `recordedParts`.

## Upload session authentication headers
- `x-request-id`: optional
- `x-idempotency-key`: optional for init and complete
- `x-upload-session-token`: REQUIRED for anonymous session follow-up requests; ignored for authenticated sessions

## Download descriptor success data
For file/version/share/artifact control-plane download routes:
```json
{
  "url": "/proxy/files/file_0001/download or https://storage.example/...",
  "headers": { "content-type": "image/png" },
  "fileName": "avatar.png",
  "mimeType": "image/png"
}
```
Rules:
- `url` MUST always be a real signed URL or a real FileFn HTTP route.
- `url` MUST NEVER use `proxy://` or any non-HTTP pseudo-scheme.
- `fileName` and `mimeType` are required on share-link download descriptors and optional on internal file/artifact descriptors.

# Semantics
## Authentication and upload-session binding
- Every upload session MUST bind to exactly one caller identity context:
  - authenticated sessions bind to `principalId` + `tenantId`;
  - anonymous sessions bind to a server-minted upload session token.
- The server MUST store only a hash of `uploadSessionToken`.
- Follow-up upload-session operations (`status`, `sign`, proxy `PUT`, `completePart`, `complete`, `abort`) MUST reject callers that do not present the same identity context.
- When replacing an existing file (`fileId` present), FileFn MUST authorize at init and MUST re-authorize at complete before publishing the new version.

## Upload mode selection
- `multipart-signed-url` MUST be selected only when `capabilities.signedUploadUrls === true` and `capabilities.multipart === true`.
- `proxy` MUST be selected only when `capabilities.proxyStreamingUpload === true`.
- Bare `signed-url` is invalid and MUST NOT appear in responses.
- If no valid mode exists, init MUST fail with `FILEFN_NO_SUPPORTED_UPLOAD_MODE`.

## Proxy upload semantics
- `PUT /upload/:uploadSessionId/parts/:partNumber` MUST durably write the part bytes and MUST return a synthetic or provider ETag that is stable for idempotent retries of the same accepted bytes.
- Successful proxy `PUT` MUST create or update the recorded part for `(uploadSessionId, partNumber)`.
- If the same `(uploadSessionId, partNumber)` is written with different bytes/etag after it is recorded, the server MUST fail deterministically with `FILEFN_PART_CONFLICT`.

## Idempotency and conflict rules
- Upload init with the same `x-idempotency-key` and identical effective input MUST return the original successful response.
- Upload init with the same `x-idempotency-key` and different effective input MUST fail with `FILEFN_IDEMPOTENCY_CONFLICT`.
- Upload part completion is idempotent only for the exact tuple `(uploadSessionId, partNumber, etag, size)`.
- Upload complete is idempotent for the same upload session and MUST return the original `{ fileId, versionId }` once completion succeeded.
- Upload complete MUST fail with `FILEFN_UPLOAD_INCOMPLETE` until all parts are recorded.
- Upload complete MUST fail with `FILEFN_UPLOAD_SIZE_MISMATCH` when the final physical byte size differs from the declared session size.

## List semantics
- `GET /` MUST return only the readable file set.
- Ordering MUST be `updatedAt DESC, fileId ASC`.
- Cursor pagination MUST be based on the last returned `(updatedAt, fileId)` pair.
- Default `limit` is `20`; max `limit` is `100`.
- The server MUST not perform a fixed-size unsorted prefetch and then filter in memory.

## Version and artifact binding
- `getFile({ fileId, versionId })` MUST honor `versionId`; when `versionId` is present, returned metadata and download descriptor MUST describe that version, not merely the current version.
- Version metadata/download routes MUST verify that `versionId` belongs to `fileId`.
- Artifact listing and artifact download MUST verify that `artifact.fileId === :fileId` and that the caller can read the parent file.

## Download fallback semantics
- If signed download URLs are supported, FileFn MAY return a signed URL.
- Otherwise FileFn MUST return a proxy descriptor pointing to the matching FileFn HTTP route.
- Share-link download descriptors MUST increment the download counter only after the server has successfully produced a usable signed URL or is about to start a proxy stream.
- Artifact download descriptors MUST return `/proxy/files/:fileId/artifacts/:artifactId/download` when proxy download is required.

## Delete and cleanup semantics
- Delete MUST remove, revoke, or invalidate:
  - `files`
  - `fileVersions`
  - `filePermissions`
  - `fileShares`
  - `fileArtifacts`
  - `uploadSessions` and `uploadParts` still associated with the deleted file, if any
- Delete MUST delete artifact storage objects and version storage objects only when no remaining live record references the storage key.
- Quota MUST be decremented only for storage bytes whose last live reference was removed.
- Upload-session GC/abort MUST clean multipart uploads, proxy temp objects, and `uploadParts` rows.

## Deduplication semantics
- Dedupe MUST be configurable from the public TypeScript and Python entry points.
- Dedupe MUST scope matches by tenant. `tenantId = null` counts as its own dedupe domain.
- Cross-tenant reuse of bytes is forbidden.
- Delete/reference semantics MUST remain correct when dedupe causes multiple logical records to point at the same storage key.

## Rate limiting semantics
- FileFn MUST use `rateLimit.limits` by route category: `uploadInit`, `uploadSign`, `uploadComplete`, `download`, optional `shareDownload`, optional `artifactDownload`.
- Rate-limit errors MUST return `FILEFN_RATE_LIMITED` with ISO8601 `resetAt` in `error.details.resetAt`.
- Python parity for rate-limit config is required when the Python server surface is used.

## Processing semantics
- Upload completion MUST trigger processing when processing is enabled.
- When FlowFn is configured, FileFn MUST enqueue a job idempotently using a deterministic key derived from at least `(fileId, versionId, processor configuration)`.
- If enqueue fails, the server MUST fail with `FILEFN_PROCESSING_ENQUEUE_FAILED`.
- Artifact list/download routes MUST enforce the same read authorization as the parent file.

## Python parity semantics
- Python MUST not contain placeholder auth/rate-limit implementations.
- Python upload mode selection, status shape, version-aware reads, share/download behavior, and dedupe behavior MUST match the canonical semantics above.
- Python storage protocol usage MUST be internally consistent (`put_object`, not an undeclared `upload_object`).
- Python tests MUST execute the same semantic vectors as the TypeScript tests for the covered flows.

# Invariants
1. No public response MAY contain `proxy://` or any non-HTTP placeholder URL.
2. Retrying the same successful init or complete request MUST return the same semantic result.
3. The same ordered file set and cursor inputs MUST produce the same ordered outputs until the underlying readable set changes.
4. A `versionId` or `artifactId` from another file MUST be indistinguishable from missing and MUST return `404 FILEFN_NOT_FOUND`.
5. Upload-session identity binding MUST not weaken when auth is optional.
6. Logs/events MUST preserve `requestId` and safe resource IDs while redacting secrets.
7. Python and TypeScript MAY differ in naming conventions, but MUST NOT differ in wire semantics, auth rules, or cleanup rules.

# Security
- FileFn MUST apply read/write/delete/share authorization before returning metadata, download descriptors, or data-plane streams.
- Upload session tokens, share tokens, signed URLs, bearer tokens, API keys, secrets, and passwords MUST be redacted from logs.
- Upload session tokens and share tokens MUST be stored hashed, not in plaintext.
- Anonymous upload-session follow-up requests without a valid session token MUST fail before revealing session status.
- Share-link download counters MUST not be consumed by internal failures before a usable download path exists.
- Multi-tenant dedupe MUST not reveal or reuse other-tenant content.

# Limits / caps
- Default upload session TTL: 86400 seconds.
- Default signed URL TTL: 900 seconds.
- Default chunk size: 8 MiB.
- `listFiles.limit`: default 20, max 100.
- Upload-session token lifetime MUST NOT exceed the upload-session TTL.
- FileFn MAY reject zero-length proxy `PUT` requests without `content-length` when the route cannot otherwise determine deterministically whether the client intended an empty body.

# Observability
- The following events MUST exist and remain canonical:
  - `file:uploaded`
  - `file:deleted`
  - `processing.started`
  - `processing.completed`
  - `processing.failed`
- Event payloads MUST include `requestId` when available.
- Event payloads and logs MUST NOT include signed URLs, share tokens, upload session tokens, or bearer credentials.
- Loggers MUST preserve safe correlation identifiers such as `req_001`, `file_001`, `upl_001`, and `ver_001`.

# Compatibility / versioning strategy
- This spec is additive where possible and corrective where necessary.
- The upload-status response MAY include a deprecated `uploadedParts` alias temporarily, but canonical clients and tests MUST use `recordedParts`.
- `@filefn/client` package renaming to `@filefn/client` is a required corrective change; keeping the old unscoped name is undefined and not required.
- Python parity is now explicitly in scope; a Python surface that diverges from this spec is non-compliant.

# Undefined / Explicitly user-deferred only
No explicit user deferrals were given.

The following remain Undefined and are not required by this spec:
- TUS compatibility
- new storage providers beyond the existing package set
- soft-delete/retention workflows
- CDN/media-delivery features
- DAM/editorial workflow features
- UI components beyond the current FileFn upload/list/quota/plans scope
