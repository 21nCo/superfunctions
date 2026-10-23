# Metadata
- Timestamp (UTC): 2026-01-26T08:26:13Z
- Agent name: unknown-agent
- Model: gpt-5.2
- Launcher: CLI
- Workspace/project (absolute): /Users/ar/dev/superfunctions
- OS + shell:
  - OS: macOS (Darwin 25.0.0 arm64)
  - shell: zsh 5.9 (assumed)
- Repo metadata:
  - VCS: git
  - Branch: next
  - Commit: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - Dirty: true
- Spec metadata:
  - spec_type: audit-fix
  - spec_id: k7n2m9p4
  - spec_folder: 2026-01-26-audit-fix-k7n2m9p4-spec
  - spec_folder (absolute): /Users/ar/dev/superfunctions/.conduct/specs/2026-01-26-audit-fix-k7n2m9p4-spec
- Inputs read (authoritative for this spec):
  - https://www.fetch.at/spec.txt
  - /Users/ar/dev/superfunctions/filefn/.conduct/issues/ISSUE_REPORT.md
  - /Users/ar/dev/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/audits/2026-01-25-nmzf1tn9-spec-audit.md
  - /Users/ar/dev/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/SPEC.md
  - /Users/ar/dev/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/REQUIREMENTS.md
  - /Users/ar/dev/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/TEST_VECTORS.md
  - /Users/ar/dev/superfunctions/filefn/server/src/errors.ts
- Audit references (this spec fixes audit findings):
  - audit: /Users/ar/dev/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec/audits/2026-01-25-nmzf1tn9-spec-audit.md
  - audited spec: /Users/ar/dev/superfunctions/filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec (spec_id: h3m9k2s)

# Overview
This is an **audit-fix** specification to resolve the FileFn issues documented in:
- the client/server mismatch issue report, and
- the spec compliance audit of `filefn/.conduct/specs/2026-01-24-new-h3m9k2s-spec`.

The target outcome is that the current repository implementation **MUST** conform to the canonical contracts from the audited spec (h3m9k2s), and the specific mismatches and gaps listed in the issue report + audit **MUST** be eliminated without regressions to already-passing behaviors.

## Context
- Project name: Superfunctions monorepo (`/Users/ar/dev/superfunctions`), focus package: **FileFn** (`filefn/*`, plus shared packages `packages/db`, `packages/middleware`, `packages/storage-*`).
- One-sentence goal: Make FileFn uploads/downloads and SDKs compliant with the canonical spec by fixing client/server API mismatches, missing proxy flows, incomplete authz, idempotency gaps, event/logging divergence, and shared rate-limit/KV APIs.
- Target users: application developers using FileFn as a server SDK (`@filefn/server`) and browser client SDK (`@filefn/client`).
- Target environments:
  - server: Node.js (>=18) and Fetch-compatible runtimes where supported
  - client: modern browsers (Fetch + Streams); offline mode uses OPFS when available
  - storage providers: S3/R2/GCS/Azure/MinIO/Local via `@superfunctions/storage-*`
- Languages/packages required: TypeScript; existing monorepo packages only (no new external runtime deps unless already present).
- Existing systems it must integrate with:
  - `@superfunctions/storage` and concrete adapters
  - `@superfunctions/db` Adapter and KVStoreAdapter
  - `@superfunctions/middleware` RateLimiter
  - `@superfunctions/auth` (optional) for authentication
  - optional FlowFn and LogFn integrations
- Data model summary: persistent tables for `files`, `fileVersions`, `uploadSessions`, `uploadParts`, `filePermissions`, `fileShares`, `fileArtifacts` (see audited spec).
- Security model:
  - optional authentication; enforced via `FILEFN_AUTH_REQUIRED` when required
  - authorization via pluggable `Authorizer` (resource + action)
  - multi-tenancy via optional `tenantId`
  - secrets: signed URLs and share tokens MUST NOT be logged
- Performance constraints:
  - multipart signed-url uploads for large files
  - proxy upload/download fallback for adapters lacking signed URLs
  - deterministic resumability state for retries/resume
- Non-goals / out of scope:
  - implementing TUS protocol
  - adding new storage adapters beyond those already present
  - adding unrelated UI features in `@uifn/files`
- Hard constraints:
  - canonical JSON envelopes for control-plane responses
  - stable error codes
  - deterministic idempotency semantics

# Glossary
- **Canonical envelope**: JSON wrapper `{ ok, data|error, requestId, warnings? }` used on control-plane routes.
- **Control-plane**: JSON APIs (init/sign/complete/list/metadata). No file bytes.
- **Data-plane**: actual file bytes transfer, via signed URLs or proxy streaming.
- **Proxy upload**: file bytes sent to FileFn server, which writes to storage using `StorageAdapter.openUploadStream` and/or provider primitives.
- **Proxy download**: file bytes streamed from FileFn server to client using `StorageAdapter.openDownloadStream`.
- **Upload mode**: strategy selected per adapter capabilities: `multipart-signed-url` or `proxy`.
- **Idempotency key**: `x-idempotency-key` header used to ensure retry-safe init/complete semantics.

# Goals / Non-goals
## Goals
FileFn changes in this audit-fix MUST:
1. Restore end-to-end uploads by aligning `@filefn/client` and `@filefn/server` request/response contracts.
2. Ensure HTTP control-plane responses use canonical envelopes and clients correctly unwrap them.
3. Implement capability-gated proxy upload and proxy download fallback flows.
4. Enforce authorization for all relevant operations (especially replace-by-fileId and list).
5. Fix idempotency guarantees for upload init, part completion, and session completion.
6. Align `@superfunctions/db` KVStoreAdapter and `@superfunctions/middleware` rate limiting APIs to the canonical spec.
7. Fix event names and logging integration to match spec while preventing secret leakage.
8. Ensure client SDK public API matches the canonical spec (including offline mode gating).

## Non-goals
1. Re-designing the audited h3m9k2s public API surface.
2. Introducing new persistence backends (e.g., Redis) beyond the existing adapter abstractions.

# Public API
This audit-fix targets conformance with the audited h3m9k2s spec. This section restates the canonical surfaces that are currently divergent.

## Canonical HTTP envelopes
### Success envelope (control-plane)
All JSON success responses MUST follow this shape:
```json
{ "ok": true, "data": {}, "warnings": [], "requestId": "req_..." }
```

Rules:
- `warnings` MAY be omitted only when it is not applicable; if present it MUST be an array.
- `requestId` MUST be included when an `x-request-id` is provided (and SHOULD be included otherwise when generated).

### Error envelope (control-plane)
All JSON error responses MUST follow this shape:
```json
{ "ok": false, "error": { "code": "FILEFN_...", "message": "...", "details": {} }, "requestId": "req_..." }
```

Rules:
- `error.code` MUST be stable and MUST match the enumerated codes in `filefn/server/src/errors.ts` plus any new codes added by this spec.
- `details` MUST be an object when present; if there are no details, `{}` is preferred.

## Upload init request (client ↔ server)
`POST /upload/init` request body MUST use:
```json
{
  "policy": "string",
  "fileName": "string",
  "size": 123,
  "mimeType": "image/png",
  "fileId": "file_... (optional)",
  "metadata": {} (optional)
}
```

Client implementations MUST NOT send `fileSize`/`contentType` to this endpoint; compatibility shims are optional and are not required by this spec.

## Proxy upload data-plane (newly specified)
When `uploadMode` is `proxy`, the sign-part step MUST return a URL hosted by FileFn for uploading bytes.

### Upload bytes endpoint
The server MUST implement a data-plane route for proxy part upload:
- `PUT /upload/:uploadSessionId/parts/:partNumber`

Request:
- Headers:
  - `content-type`: MUST match the session `mimeType` (or `application/octet-stream` when session type is that)
  - `content-length`: MUST be present for non-empty bodies
- Body: raw bytes for that part

Response (JSON success envelope):
```json
{ "ok": true, "data": { "etag": "...", "size": 123, "recorded": true }, "requestId": "req_..." }
```

Server-side behavior:
- The server MUST persist the part bytes durably enough to support `POST /upload/:uploadSessionId/complete`.
- The server MUST record the part as completed (equivalent to calling `POST /upload/:id/parts/:n/complete`).

## Proxy download data-plane (newly specified)
When `StorageAdapter.capabilities.signedDownloadUrls` is false and `proxyStreamingDownload` is true, the server MUST provide a proxy download URL.

### Proxy download endpoint
- `GET /proxy/files/:fileId/download`
- `GET /proxy/files/:fileId/versions/:versionId/download`

Behavior:
- These endpoints MUST stream bytes from `StorageAdapter.openDownloadStream`.
- These endpoints MUST enforce authorization equivalently to the corresponding control-plane download route.

## Client SDK surface (conformance)
`@filefn/client` MUST expose:
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
  onProgress(cb: (p: { bytesUploaded: number; bytesTotal: number; partNumber?: number }) => void): void;
  done(): Promise<{ fileId: string; versionId: string }>;
}

export function createFileFnClient(config: FileFnClientConfig): {
  uploadFile(input: { policy: string; file: File; metadata?: Record<string, any> }): Promise<UploadHandle>;
  getFile(fileId: string): Promise<any>;
  downloadUrl(fileId: string, opts?: { versionId?: string }): Promise<string>;
  deleteFile(fileId: string): Promise<void>;
};
```

## Shared package APIs (conformance)
### `@superfunctions/db` KVStoreAdapter
```ts
export interface KVStoreAdapter {
  get(key: string): Promise<string | null>;
  set(input: { key: string; value: string; ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  incr?(input: { key: string; by?: number; ttlSeconds?: number }): Promise<{ value: number }>;
}
```

### `@superfunctions/middleware` RateLimiter
```ts
export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: string; // ISO8601
  retryAfterSeconds?: number;
}

export interface RateLimiter {
  check(input: { key: string; windowSeconds: number; limit: number }): Promise<RateLimitDecision>;
}

export function createRateLimiter(input: {
  persistence: import('@superfunctions/db').Adapter | import('@superfunctions/db').KVStoreAdapter;
  algorithm?: 'fixed-window' | 'token-bucket' | 'leaky-bucket';
  prefix?: string;
}): RateLimiter;
```

# Data formats / protocol
## Required headers
- `x-request-id` (optional): if present, server MUST echo to response envelope and propagate to logs/events.
- `x-idempotency-key` (optional): if present, upload init and upload complete MUST be idempotent.
- `authorization` (optional): forwarded to auth provider; required when `requireAuthByDefault` applies.

# Semantics (audit-fix focus)
## Client ↔ server contract
- Client upload init MUST send `size` and `mimeType` to match server parsing.
- Client HTTP layer MUST unwrap `{ ok: true, data }` envelopes and return `data` to higher-level helpers.
- Client MUST surface `{ ok: false, error }` envelopes as structured errors containing at least `error.code`, `message`, `details`, and `requestId` when provided.

## Upload mode selection
- Server MUST select `multipart-signed-url` when `signedUploadUrls=true` and `multipart=true`.
- Server MUST select `proxy` when `signedUploadUrls=false` and `proxyStreamingUpload=true`.
- If neither signed nor proxy upload is supported, server MUST fail upload init with `FILEFN_NO_SUPPORTED_UPLOAD_MODE`.

## Authorization enforcement
- Upload init MUST authorize:
  - create: resource `{ type: 'file', id: 'new' }`, action `{ operation: 'write', scope: 'content' }`
  - replace: resource `{ type: 'file', id: fileId }`, action `{ operation: 'write', scope: 'content' }`
- Upload completion MUST authorize `{ type: 'uploadSession', id: uploadSessionId }` write, and MUST re-check file write authorization when replacing.
- List MUST only return accessible files (owned/public/shared/granted), applying authorizer filters if provided.

## Version binding
- `GET /:fileId/versions/:versionId` and `.../:versionId/download` MUST verify `versionId` belongs to `fileId`.
- If the binding fails, server MUST return `404 FILEFN_NOT_FOUND` (to avoid leaking version existence).

## Idempotency
- Upload init idempotency:
  - scope keying MUST include (principalId, tenantId, policy, fileId?, fileName, size, mimeType, metadata) in the payload hash.
  - same key + same payload MUST return the same `uploadSessionId`.
  - same key + different payload MUST return `409 FILEFN_IDEMPOTENCY_CONFLICT`.
- Upload part completion idempotency:
  - `(uploadSessionId, partNumber, etag)` MUST be idempotent.
  - same `(uploadSessionId, partNumber)` with a different `etag` MUST fail deterministically with `409 FILEFN_PART_CONFLICT`.
- Upload complete idempotency:
  - repeated completion MUST return the same `(fileId, versionId)`.
  - completion MUST persist the resulting `(fileId, versionId)` against the upload session so later replaces do not change the returned `versionId`.

## Proxy upload semantics
- Proxy part upload endpoint MUST:
  - enforce ordering and bounds (`partNumber` in range)
  - record checksum/etag deterministically (sha256 over bytes is RECOMMENDED)
  - persist bytes until session completion

## Proxy download semantics
- Proxy download endpoints MUST support streaming and SHOULD support HTTP range requests when `StorageAdapter.openDownloadStream` supports ranges.

## Rate limiting
- FileFn MUST configure rate limiting via `config.rateLimit` (not a pre-constructed instance).
- When rate limited, server MUST return `429 FILEFN_RATE_LIMITED` and include `details.resetAt` as ISO8601.

## Processing trigger
- When processing is enabled, upload completion MUST trigger processing.
- When FlowFn is provided, processing SHOULD be enqueued and retries SHOULD be idempotent.

## Deduplication
- When deduplication is enabled, upload completion MUST compute SHA-256 over stored bytes and avoid storing duplicate bytes within the same tenant.
- Cross-tenant deduplication is forbidden.

# Invariants
1. Canonical envelopes: control-plane routes MUST return stable, parseable envelopes.
2. No secret leakage: signed URLs and share tokens MUST NOT appear in logs or event payloads.
3. Determinism: idempotency outcomes MUST not vary across retries for the same inputs.
4. Correctness: version downloads MUST not cross file boundaries.

# Security
- Replace-by-fileId MUST enforce write authorization; providing an existing `fileId` without permission MUST not create a new version.
- Version download endpoints MUST not allow `versionId` enumeration across files; use `404 FILEFN_NOT_FOUND` on binding mismatch.

# Limits / caps
Defaults SHOULD match the audited spec:
- maxFileSizeBytes: 100 MiB
- defaultChunkSizeBytes: 8 MiB
- uploadSessionTtlSeconds: 86400
- signedUrlTtlSeconds: 900

# Observability
- Events MUST use canonical names at minimum:
  - `file:uploaded`
  - `file:deleted`
- Event payloads MUST include `requestId` when available.
- If a logger is provided, FileFn MUST emit structured logs that include correlation IDs (`requestId`, `uploadSessionId`, `fileId`, `versionId`) and MUST redact signed URLs and share tokens.

# Compatibility / versioning strategy
- Any changes to exported TypeScript types in published packages MUST follow semver (breaking changes => major bump).
- The HTTP API is stable within a major version; route additions are non-breaking.

# Undefined / Explicitly user-deferred only
None.
