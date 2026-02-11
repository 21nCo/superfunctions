# Metadata
- Timestamp (UTC): 2026-01-24T13:46:33Z
- Agent name: unknown-agent
- Model: gpt-5.2 (xhigh reasoning)
- Launcher: Warp
- Workspace (absolute): /Users/ar/dev/superfunctions
- OS: macOS
- Shell: zsh 5.9
- Repo:
  - VCS: git
  - Branch: (detached) HEAD
  - Commit: ec7e3e4d5938dca77997723a0378ea58ed0ed485
  - Dirty: true
- Spec:
  - spec_type: new
  - spec_id: h3m9k2s
  - spec_folder: 2026-01-24-new-h3m9k2s-spec
  - spec_folder (absolute): /Users/ar/dev/superfunctions/filefn/.conduct/2026-01-24-new-h3m9k2s-spec
- Inputs read:
  - /Users/ar/dev/agent/intent/fileFn/filefn.intent.md
  - /Users/ar/dev/agent/intent/fileFn/filefn.intent.suggestions.md
  - /Users/ar/dev/agent/intent/fileFn/filefn-ar-notes.md
  - /Users/ar/dev/agent/intent/fileFn/ai-notes/auth-architecture.md
  - /Users/ar/dev/agent/intent/fileFn/ai-notes/auth-file-permissions-table.md
  - /Users/ar/dev/agent/intent/fileFn/ai-notes/authz-flexibility.md
  - /Users/ar/dev/agent/intent/fileFn/ai-notes/chatgpt-1.md
  - /Users/ar/dev/agent/intent/fileFn/ai-notes/policies.md
  - /Users/ar/dev/agent/intent/fileFn/ai-notes/resumability-custom.md
  - /Users/ar/dev/agent/intent/fileFn/ai-notes/resumability-tus.md
  - /Users/ar/dev/agent/intent/fileFn/ai-notes/storage-quota.md
  - /Users/ar/dev/agent/intent/super functions/changeset-070126.md
- Audit references: N/A

## Assumptions (explicit)
1. **Primary runtime**: `@filefn/server` targets Node.js (>=18) and Fetch-compatible runtimes (workers) as long as the configured `StorageAdapter` supports the selected upload/download modes.
2. **Upload strategy**: The canonical upload flow is **direct-to-storage** using **signed URLs** for multipart parts when supported by the `StorageAdapter`. A server-proxy upload mode exists as a fallback when an adapter cannot sign URLs.
3. **Protocol choice**: The canonical resumability protocol is **FileFn upload sessions** (not TUS). TUS compatibility is **Undefined** and **not required** by this spec.
4. **Multi-tenancy**: Tenant isolation is supported via an optional `tenantId` (e.g., `organizationId`) on file records. If tenant isolation is enabled by an application, the application MUST provide a resolver.
5. **Billing system**: `billfn` is expected to provide quota/metering, but FileFn only depends on a small `QuotaProvider` interface.

## Questions (do not block this spec)
1. Should server-proxy download streaming be supported by default, or only via signed URLs (with optional redirects)?
2. Which UI frameworks must `@uifn/files` support first (React, Svelte, both)?
3. Should deletes be soft-delete (retention) or hard-delete only? This spec defines hard-delete as the default.

# Overview
FileFn is a provider-agnostic file storage orchestration system for the Superfunctions ecosystem. It standardizes:
- large/resumable uploads (multipart, chunking, retries)
- secure access (policies, ACL/visibility, share links)
- file management APIs (upload, download, list, delete, replace/version)
- processing workflows (thumbnails, compression, image transforms, OCR, video/audio processing)
- storage quota enforcement via a billing/quota plugin

FileFn is delivered as multiple packages:
- `@superfunctions/storage` (shared): `StorageAdapter` interface + related types
- `@superfunctions/files` (shared): `FileProvider` interface + related types
- `@superfunctions/middleware` (shared): reusable middleware primitives (including rate limiting)
- `@superfunctions/storage-*` (shared): concrete adapters (S3, R2, GCS, Azure, MinIO, Local)
- `@filefn/server`: stateful orchestration + HTTP API router
- `@filefn/client`: client SDK for uploads/downloads with offline support
- `@filefn/processing`: processing SDK (processors + contracts)
- `@uifn/files`: UI components for file UX

Note: Some early intent material placed `FileProvider` in `@superfunctions/storage`. This spec standardizes on `@superfunctions/files` so storage adapters remain focused on storage primitives.

# Glossary
- **StorageAdapter**: A stateless provider adapter implementing object-store primitives and/or signed URL generation.
- **FileProvider**: A higher-level interface for file orchestration (sessions, ACL, versions) implemented by `@filefn/server` and shared via `@superfunctions/files`.
- **UploadSession**: A server-tracked resumable upload state machine.
- **UploadPart**: A chunk/part within an upload session (multipart or chunked-proxy).
- **File**: A logical file record with stable `fileId`, current version pointer, and access controls.
- **FileVersion**: An immutable content version of a file, with its own storage key and checksum.
- **Artifact**: A derived output from processing (thumbnail, compressed variant, OCR text, transcoded media).
- **Policy**: A named ruleset that constrains uploads (content types, size), defines storage paths, and defines access rules.
- **Visibility**: `private | shared | public` for baseline access behavior.
- **Permission Grant**: An explicit access grant to a user/role/tenant, optionally expiring.
- **Share Link**: A tokenized link granting read access to a file/version, optionally expiring and/or requiring authentication.
- **QuotaProvider**: A plugin interface (typically implemented by billfn) for quota checks and usage recording.
- **RateLimiter**: A shared rate limiting primitive from `@superfunctions/middleware`.
- **FlowFn**: Optional plugin for async processing (queues/streams/workflows).
- **LogFn**: Optional plugin for structured logging.
- **OPFS**: Origin Private File System (browser storage) used for offline staging/caching.
- **Correlation ID / requestId**: A stable identifier used for stitching logs, events, and requests.

# Goals
FileFn MUST:
1. Support huge files via multipart and streaming-friendly uploads.
2. Support resumability (network unreliability) with deterministic resumption state.
3. Provide secure, granular access control (policies + ACL + visibility + share links).
4. Provide provider abstraction (S3/R2/GCS/Azure/MinIO/Local) via stateless adapters.
5. Provide signed URL orchestration (upload + download) when adapter supports it.
6. Provide processing workflows (sync/async), including thumbnails, compression, image processing, OCR, and video/audio processing.
7. Provide quota enforcement via a plugin interface (billfn expected).
8. Provide versioning and deduplication.
9. Provide client SDK (resumable uploads + offline support).
10. Provide UI components for file UX.

# Non-goals
1. FileFn is not a CDN, media delivery network, or cache invalidation system.
2. FileFn is not a full Digital Asset Management (DAM) system (taxonomy, approvals, editorial workflows).
3. FileFn is not an authentication provider; it delegates authentication to `@superfunctions/auth` compatible providers.
4. FileFn is not a billing system; it delegates metering/quota to a `QuotaProvider`.
5. Malware scanning/quarantine and EXIF/PII sanitization are OPTIONAL hooks; they are not required by this spec unless implemented via policies/processors.
6. Folder/collection resources, hierarchical permissions, and path-based permission inheritance are out of scope for FileFn v0.
7. Admin/ops endpoints (global search, analytics, audit log APIs, backup/restore) are out of scope for FileFn v0.

# Public API
This section defines public TypeScript APIs. Namespaces and file paths are illustrative.

## `@superfunctions/storage`
### Types
```ts
export type StorageAdapterName =
  | 's3'
  | 'r2'
  | 'gcs'
  | 'azure'
  | 'minio'
  | 'local'
  | (string & {});

export interface StorageAdapterCapabilities {
  signedUploadUrls: boolean;
  signedDownloadUrls: boolean;
  multipart: boolean;
  proxyStreamingUpload: boolean;
  proxyStreamingDownload: boolean;
}

export interface SignedUrlConstraints {
  contentType?: string;
  contentLength?: number;
  checksumSha256Base64?: string;
}

export interface MultipartPartDescriptor {
  partNumber: number;
  etag: string;
  size: number;
  checksumSha256Base64?: string;
}

export interface StorageObjectStat {
  key: string;
  size: number;
  contentType?: string;
  etag?: string;
  lastModifiedAt?: string; // ISO8601
}
```

### StorageAdapter
```ts
export interface StorageAdapter {
  name: StorageAdapterName;
  capabilities: StorageAdapterCapabilities;

  // Stat / delete
  statObject(input: { key: string }): Promise<StorageObjectStat>;
  deleteObject(input: { key: string }): Promise<void>;

  // Signed URLs (when capabilities.signed*Urls)
  signUploadUrl?(input: {
    key: string;
    expiresInSeconds: number;
    constraints?: SignedUrlConstraints;
  }): Promise<{ url: string; headers?: Record<string, string> }>;

  signDownloadUrl?(input: {
    key: string;
    expiresInSeconds: number;
    constraints?: { responseContentType?: string };
  }): Promise<{ url: string; headers?: Record<string, string> }>;

  // Multipart (when capabilities.multipart)
  createMultipartUpload?(input: {
    key: string;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<{ uploadId: string }>;

  signMultipartUploadPartUrl?(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds: number;
    constraints?: SignedUrlConstraints;
  }): Promise<{ url: string; headers?: Record<string, string> }>;

  completeMultipartUpload?(input: {
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }): Promise<void>;

  abortMultipartUpload?(input: { key: string; uploadId: string }): Promise<void>;

  // Proxy streaming fallbacks (when capabilities.proxyStreaming*)
  openUploadStream?(input: { key: string; contentType?: string }): Promise<WritableStream>;
  openDownloadStream?(input: { key: string; range?: { start: number; endInclusive: number } }): Promise<ReadableStream>;
}
```

## `@superfunctions/files`
### FileProvider
`FileProvider` is the interface other superfunctions can depend on (e.g., `datafn`, `browsefn`).
```ts
export interface FileProviderContext {
  principalId?: string;
  tenantId?: string;
  requestId?: string;
}

export interface FileProvider {
  createUploadSession(input: {
    policy: string;
    fileName: string;
    size: number;
    mimeType: string;
    fileId?: string; // when replacing an existing file
    metadata?: Record<string, any>;
    idempotencyKey?: string;
  }, ctx: FileProviderContext): Promise<{ uploadSessionId: string }>;

  getUploadSessionStatus(input: { uploadSessionId: string }, ctx: FileProviderContext): Promise<any>;

  signUploadPart(input: {
    uploadSessionId: string;
    partNumber: number;
    contentLength: number;
    checksumSha256Base64?: string;
  }, ctx: FileProviderContext): Promise<{ url: string; headers?: Record<string, string> }>;

  completeUploadPart(input: {
    uploadSessionId: string;
    partNumber: number;
    etag: string;
    size: number;
    checksumSha256Base64?: string;
  }, ctx: FileProviderContext): Promise<void>;

  completeUploadSession(input: {
    uploadSessionId: string;
  }, ctx: FileProviderContext): Promise<{ fileId: string; versionId: string }>;

  abortUploadSession(input: { uploadSessionId: string }, ctx: FileProviderContext): Promise<void>;

  getFile(input: { fileId: string; versionId?: string }, ctx: FileProviderContext): Promise<any>;
  listFiles(input: { cursor?: string; limit?: number }, ctx: FileProviderContext): Promise<any>;
  deleteFile(input: { fileId: string }, ctx: FileProviderContext): Promise<void>;
}
```

## `@superfunctions/db` (additive)
### KVStoreAdapter
`KVStoreAdapter` is an optional persistence interface used by shared middleware (e.g., rate limiting). It is additive to existing `Adapter` DB capabilities.
```ts
export interface KVStoreAdapter {
  get(key: string): Promise<string | null>;
  set(input: { key: string; value: string; ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;

  // Optional atomic helper used by rate limiting implementations.
  incr?(input: { key: string; by?: number; ttlSeconds?: number }): Promise<{ value: number }>;
}
```

## `@superfunctions/middleware`
### Rate limiting
```ts
import type { Adapter, KVStoreAdapter } from '@superfunctions/db';

export type RateLimitAlgorithm = 'fixed-window' | 'token-bucket' | 'leaky-bucket';

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
  persistence: Adapter | KVStoreAdapter;
  algorithm?: RateLimitAlgorithm;
  prefix?: string;
}): RateLimiter;
```

## `@filefn/server`
```ts
import type { Adapter, KVStoreAdapter, TableSchema } from '@superfunctions/db';
import type { AuthProvider, AuthSession } from '@superfunctions/auth';
import type { Router } from '@superfunctions/http';
import type { StorageAdapter } from '@superfunctions/storage';
import type { FileProvider } from '@superfunctions/files';
import type { RateLimitAlgorithm } from '@superfunctions/middleware';
import type { Logger } from 'logfn';

export interface FileFnPrincipal {
  principalId: string;
  userId?: string;
  role?: string;
  tenantId?: string;
  scopes?: string[];
  claims?: Record<string, any>;
}

export interface AuthorizerResource {
  type: 'file' | 'fileVersion' | 'uploadSession' | 'shareLink' | 'policy' | 'admin';
  id: string;
  data?: any;
}

export interface AuthorizerAction {
  operation: 'read' | 'write' | 'delete' | 'share' | 'manage';
  scope?: 'content' | 'metadata' | 'permissions' | 'audit' | 'artifacts';
}

export interface AuthorizerResult {
  allowed: boolean;
  reason?: string;
  // For list operations
  filters?: {
    where?: any[];
  };
}

export interface Authorizer {
  authorize(
    principal: FileFnPrincipal | null,
    resource: AuthorizerResource,
    action: AuthorizerAction,
    context?: { requestId?: string; ip?: string; userAgent?: string }
  ): Promise<AuthorizerResult>;
}

export function composeAuthorizers(
  authorizers: Authorizer[],
  options?: { strategy: 'first-allow' | 'all-must-allow' }
): Authorizer;

export interface QuotaProvider {
  checkQuota(input: { principalId: string; resource: 'storage' | 'bandwidth' | 'processing'; amount: number; tenantId?: string }):
    Promise<{ allowed: boolean; reason?: string; current?: number; limit?: number; warning?: string }>;
  recordUsage(input: { principalId: string; resource: 'storage' | 'bandwidth' | 'processing'; amount: number; tenantId?: string; metadata?: any }): Promise<void>;
  getUsage?(input: { principalId: string; resource: 'storage' | 'bandwidth' | 'processing'; tenantId?: string }): Promise<any>;
}


export interface FileFnPolicy {
  contentTypes: string[];
  maxSizeBytes: number;
  visibility: 'private' | 'shared' | 'public';
  storagePath: (input: { principal: FileFnPrincipal | null; metadata?: Record<string, any> }) => string;
  access?: (input: { principal: FileFnPrincipal | null; action: AuthorizerAction; file?: any }) => boolean | Promise<boolean>;
}

export interface FileFnConfig<TSession extends AuthSession = AuthSession> {
  namespace?: string;
  database: Adapter;
  storage: StorageAdapter;

  // Auth
  auth?: {
    // `AuthProvider` MAY implement `getSession(req)` to return a cached/current session for the request.
    provider?: AuthProvider<TSession>;
    resolveSession?: (req: Request) => Promise<TSession | null>;
    mapSessionToPrincipal?: (session: TSession) => FileFnPrincipal;
    requireAuthByDefault?: boolean;
  };

  // Authorization
  authorization?: {
    authorizer?: Authorizer;
  };

  // Policies
  policies?: Record<string, FileFnPolicy>;

  // Quota / rate limiting
  quota?: QuotaProvider;
  rateLimit?: {
    // FileFn uses `@superfunctions/middleware` for rate limiting; persistence may be DB-backed or KV-backed.
    persistence: Adapter | KVStoreAdapter;
    algorithm?: RateLimitAlgorithm;
    limits: {
      uploadInit?: { limit: number; windowSeconds: number };
      uploadPartSign?: { limit: number; windowSeconds: number };
      download?: { limit: number; windowSeconds: number };
    };
  };

  // Processing
  processing?: {
    flow?: any; // FlowFn instance (optional)
    enabled?: boolean;
  };

  // Versioning / dedupe
  versioning?: { enabled: boolean; maxVersions?: number };
  deduplication?: { enabled: boolean; scope: 'tenant'; algorithm: 'sha256' };

  // Limits
  limits?: {
    maxFileSizeBytes?: number;
    defaultChunkSizeBytes?: number;
    uploadSessionTtlSeconds?: number;
    signedUrlTtlSeconds?: number;
  };

  // Observability
  logger?: Logger;
}

export class FileFn implements FileProvider {
  constructor(config: FileFnConfig);

  readonly router: Router;

  definePolicy(name: string, policy: FileFnPolicy): void;
  on(eventName: string, handler: (payload: any) => Promise<void> | void): void;
}

export function getSchema(config?: { namespace?: string }): { version: number; schemas: TableSchema[] };
```

## `@filefn/client`
```ts
export interface FileFnClientConfig {
  baseUrl: string;
  getAuthHeaders?: () => Promise<Record<string, string>>;

  // Upload
  chunkSizeBytes?: number;
  concurrency?: number;
  retryDelaysMs?: number[];

  // Offline
  offline?: {
    enabled: boolean;
    opfsDir?: string;
  };
}

export interface UploadProgress {
  bytesUploaded: number;
  bytesTotal: number;
  partNumber?: number;
}

export interface UploadHandle {
  uploadSessionId: string;
  abort(): Promise<void>;
  onProgress(cb: (p: UploadProgress) => void): void;
  done(): Promise<{ fileId: string; versionId: string }>;
}

export function createFileFnClient(config: FileFnClientConfig): {
  uploadFile(input: { policy: string; file: File; metadata?: Record<string, any> }): Promise<UploadHandle>;
  getFile(fileId: string): Promise<any>;
  downloadUrl(fileId: string, opts?: { versionId?: string }): Promise<string>;
  deleteFile(fileId: string): Promise<void>;
};
```

## `@filefn/processing`
```ts
export type ProcessorKind =
  | 'thumbnail'
  | 'compression'
  | 'image-transform'
  | 'ocr'
  | 'video'
  | 'audio';

export interface ProcessorContext {
  requestId?: string;
  fileId: string;
  versionId: string;
  tenantId?: string;
}

export interface ProcessorInput {
  kind: ProcessorKind;
  mimeType: string;
  content: ReadableStream | ArrayBuffer;
  options?: Record<string, any>;
}

export interface ProcessorOutputArtifact {
  kind: string;
  mimeType: string;
  content: ReadableStream | ArrayBuffer;
  metadata?: Record<string, any>;
}

export interface Processor {
  kind: ProcessorKind;
  supports(input: { mimeType: string }): boolean;
  run(input: ProcessorInput, ctx: ProcessorContext): Promise<ProcessorOutputArtifact[]>;
}
```

## `@uifn/files`
UI package exports framework-specific components (framework support is application-chosen).
At minimum it MUST include:
- `PricingPlans` (pricing and plan selection)
- `QuotaUsageBar` (current usage vs quota)
- `UsageAnalytics` (usage breakdown and trends)
- `FileDropzone`
- `UploadProgressList`
- `FileList`

# Data model
This section defines the minimum persistent data model required by this spec. Exact DB field names and indexes are implementation-defined, but the schema MUST support the API shapes in TEST_VECTORS.md and the behaviors in Semantics.

Model naming:
- The canonical schema is exposed via `getSchema()` as `schemas: TableSchema[]`.
- Each schema entry MUST have a stable `modelName` (e.g., `files`, `fileVersions`, ...).

## `files`
Represents a logical file (stable identity) and its current version pointer.
Required fields:
- `fileId` (string)
- `currentVersionId` (string)
- `ownerId` (string)
- `tenantId` (string | null)
- `visibility` (`private | shared | public`)
- `policy` (string)
- `mimeType` (string)
- `size` (number; current version size)
- `createdAt` (ISO8601 string)

## `fileVersions`
Represents an immutable content version for a file.
Required fields:
- `versionId` (string)
- `fileId` (string)
- `storageKey` (string)
- `mimeType` (string)
- `size` (number)
- `checksumSha256Base64` (string | null)
- `createdAt` (ISO8601 string)

## `uploadSessions`
Represents resumable upload state.
Required fields:
- `uploadSessionId` (string)
- `status` (`pending | in_progress | completed | aborted | expired`)
- `policy` (string)
- `fileId` (string | null; set when replacing)
- `fileName` (string)
- `mimeType` (string)
- `size` (number)
- `uploadMode` (string)
- `chunkSizeBytes` (number)
- `totalParts` (number)
- `expiresAt` (ISO8601 string)
- `createdAt` (ISO8601 string)

## `uploadParts`
Represents recorded completion metadata for a specific part.
Required fields:
- `uploadSessionId` (string)
- `partNumber` (number)
- `etag` (string)
- `size` (number)
- `checksumSha256Base64` (string | null)

## `filePermissions`
Represents explicit grants.
Required fields:
- `permissionId` (string)
- `fileId` (string)
- `userId` (string | null)
- `role` (string | null)
- `tenantId` (string | null)
- `canRead` (boolean)
- `canWrite` (boolean)
- `canDelete` (boolean)
- `canShare` (boolean)
- `expiresAt` (ISO8601 string | null)
- `createdAt` (ISO8601 string)

## `fileShares`
Represents share links.
Required fields:
- `tokenHash` (string)
- `fileId` (string)
- `versionId` (string | null)
- `expiresAt` (ISO8601 string | null)
- `requiresAuth` (boolean)
- `maxDownloads` (number | null)
- `downloads` (number)
- `createdAt` (ISO8601 string)
- `revokedAt` (ISO8601 string | null)

## `fileArtifacts`
Represents derived artifacts created by processors.
Required fields:
- `artifactId` (string)
- `fileId` (string)
- `versionId` (string)
- `kind` (string)
- `storageKey` (string)
- `mimeType` (string)
- `createdAt` (ISO8601 string)

# Data formats / protocol
FileFn HTTP API uses JSON for control-plane operations and signed URLs / streams for data-plane transfer.

## Canonical envelopes
### Success
```json
{ "ok": true, "data": { }, "warnings": [], "requestId": "req_..." }
```

### Error
```json
{ "ok": false, "error": { "code": "FILEFN_...", "message": "...", "details": { } }, "requestId": "req_..." }
```

## Headers
- `authorization`: forwarded to the configured auth provider.
- `x-request-id` (optional): if present, FileFn MUST propagate it to logs/events and include it in responses.
- `x-idempotency-key` (optional): used to make upload-init and upload-complete idempotent.

## Routes (mounted by the application)
These paths are relative to where the application mounts `fileFn.router` (e.g., `/api/files`).

### Upload sessions
- `POST /upload/init` → create upload session
- `GET /upload/:uploadSessionId/status` → resumability state
- `POST /upload/:uploadSessionId/parts/:partNumber/sign` → signed URL + required headers
- `POST /upload/:uploadSessionId/parts/:partNumber/complete` → record ETag/checksum
- `POST /upload/:uploadSessionId/complete` → finalize upload, create/replace file version
- `POST /upload/:uploadSessionId/abort` → abort upload

### File management
- `GET /` → list accessible files
- `GET /:fileId` → file metadata (current version)
- `GET /:fileId/download` → download URL or proxy stream
- `DELETE /:fileId` → delete file

### Versioning
- `GET /:fileId/versions` → list versions
- `GET /:fileId/versions/:versionId` → version metadata
- `GET /:fileId/versions/:versionId/download` → download URL or proxy stream

### Permissions and sharing
- `GET /:fileId/permissions` → list grants
- `POST /:fileId/permissions` → create grant
- `DELETE /:fileId/permissions/:permissionId` → revoke grant
- `POST /:fileId/share-links` → create share link
- `GET /share-links/:token/download` → access shared download
- `DELETE /:fileId/share-links/:token` → revoke share link

### Policies
- `GET /policies` → list policies (names + constraints)

### Processing
- `POST /:fileId/process` → trigger processing (if enabled)
- `GET /:fileId/artifacts` → list artifacts
- `GET /:fileId/artifacts/:artifactId/download` → artifact download URL

### Quota (optional)
- `GET /quota/storage` → current principal storage usage (if `quota.getUsage` exists)

# Semantics

## Upload sessions
### State machine
`UploadSession.status` MUST be one of:
- `pending` (created, no parts recorded)
- `in_progress` (some parts recorded)
- `completed` (file version created)
- `aborted` (explicit abort)
- `expired` (TTL elapsed; may be GC’d)

### Multipart + signed URLs (canonical)
1. Client calls `POST /upload/init` with `{ policy, fileName, size, mimeType, metadata?, fileId? }`.
2. Server validates:
   - policy exists and allows `mimeType`
   - `size` ≤ policy max and ≤ server max
   - quota allows `size`
   - authorization allows `write` on target resource (create or replace)
3. Server creates `UploadSession` and (if adapter is multipart) creates a storage multipart upload.
4. For each part, client calls `POST /upload/:id/parts/:partNumber/sign`.
5. Client uploads part bytes to storage using returned URL/headers.
6. Client calls `POST /upload/:id/parts/:partNumber/complete` with `{ etag, size, checksum? }`.
7. When all parts are recorded, client calls `POST /upload/:id/complete`.
8. Server completes multipart, creates/updates `File` + `FileVersion`, records quota usage, emits events, and optionally triggers processing.

### Proxy upload fallback
If `storage.capabilities.signedUploadUrls` is false, FileFn MUST support proxy upload of chunks (server receives bytes and streams into `storage.openUploadStream` when available).

### Idempotency and retries
- `POST /upload/init` MUST be idempotent when `x-idempotency-key` is provided.
- `POST /upload/:id/parts/:partNumber/sign` MAY return a new URL each call; repeated calls MUST NOT corrupt server state.
- `POST /upload/:id/parts/:partNumber/complete` MUST be idempotent for the tuple `(uploadSessionId, partNumber, etag)`.
- `POST /upload/:id/complete` MUST be idempotent: repeating after success MUST return the same `(fileId, versionId)`.

## File versioning
- A `File` has a stable `fileId`.
- Each upload completion creates a new immutable `FileVersion`.
- Replace semantics: when `upload/init` is called with `fileId`, the resulting completion MUST create a new version attached to that file.
- `versioning.maxVersions` (when set) MUST delete or hide older versions according to policy (default: delete oldest from storage and DB).

## Deduplication
- When `deduplication.enabled` is true, FileFn MUST compute a SHA-256 content hash for each completed version.
- Dedupe scope MUST be tenant-scoped (`scope: 'tenant'`): the same content hash in another tenant MUST NOT be reused.
- If a duplicate is found within the tenant, FileFn MUST avoid storing duplicate bytes (implementation MAY reference the existing storage object).

## Policies
- Policies are named and configured server-side.
- The policy chosen for an upload session MUST be stored on the resulting file/version.
- Policies MAY implement additional access checks (`policy.access`).

## Authentication
- Authentication is optional. If configured, FileFn MUST resolve a principal via:
  1) `auth.resolveSession(req)` if provided, else
  2) `auth.provider.getSession?.(req)` if it returns a non-null session, else
  3) `auth.provider.authenticate(req)` if provided, else
  4) null principal
- `AuthProvider.authenticate()` SHOULD cache the resolved session for the lifetime of the request such that subsequent `getSession(req)` calls do not re-authenticate.
- If a route requires authentication and principal is null, FileFn MUST return `401 FILEFN_AUTH_REQUIRED`.

## Authorization
- Authorization MUST be enforced via:
  1) a custom `authorization.authorizer` if provided, else
  2) the built-in authorizer implementing:
     - owner has full permissions
     - role `admin` has full permissions
     - visibility `public` allows read(content)
     - visibility `shared` allows read(content) within tenant
     - explicit permission grants (user/role/tenant) override visibility
     - share links grant read(content) within constraints

## Share links
- Share link tokens MUST be random, unguessable, and stored as hashes in DB.
- Share links MUST support:
  - expiration (`expiresAt`)
  - optional `requiresAuth`
  - optional `maxDownloads`
  - revocation

## Quotas
- Quota checks MUST occur at least at `upload/init` and `upload/complete`.
- Usage MUST be recorded after successful completion.
- Deleting a file/version MUST record negative usage equal to bytes freed.

## Rate limiting
- Rate limiting is optional. If configured, FileFn MUST enforce limits using `@superfunctions/middleware` backed by `rateLimit.persistence`.
- Rate limit keys SHOULD incorporate (in order of preference) `principalId`, `tenantId`, and route category; if unauthenticated, a fallback such as IP MAY be used.

## Processing
- Processing is triggered on completion and/or explicit `POST /:fileId/process`.
- If FlowFn is provided, processing SHOULD run asynchronously via a queue/workflow.
- If FlowFn is not provided, processing MAY run inline for small transforms but MUST be bounded by configured limits.

# Invariants
1. **Idempotency**: endpoints with idempotency keys MUST not create duplicate file versions.
2. **Deterministic hashing**: SHA-256 must be computed on the exact byte sequence stored.
3. **Ordering**: multipart completion MUST use parts in ascending `partNumber`.
4. **No secret leakage**: signed URLs and share tokens MUST NOT be logged.
5. **Consistency**: a `completed` upload session MUST have a corresponding `FileVersion`.

# Security
- Signed URLs MUST use short TTLs (default `signedUrlTtlSeconds = 900`).
- Signed upload URLs SHOULD constrain content type and length when supported.
- Storage keys MUST be tenant-scoped when tenantId exists.
- Share link token storage MUST use a secure hash (SHA-256 or stronger) and constant-time comparisons.

# Limits / caps
Defaults (override via config):
- maxFileSizeBytes: 100 MiB
- defaultChunkSizeBytes: 8 MiB
- uploadSessionTtlSeconds: 86400 (24h)
- signedUrlTtlSeconds: 900 (15m)

Provider constraints (informing chunking):
- S3 multipart minimum part size is 5 MiB (except last part)
- S3 maximum parts is 10,000

# Observability
- FileFn MUST emit lifecycle events including:
  - `file:upload_started`
  - `file:part_recorded`
  - `file:uploaded`
  - `file:deleted`
  - `file:version_created`
  - `file:processing_started`
  - `file:processing_completed`
  - `file:processing_failed`
- Events MUST include `requestId` when available.
- If `logger` is provided, FileFn MUST log structured events with correlation IDs.

# Compatibility / versioning strategy
- Each package MUST follow semver.
- HTTP API paths are stable within a major version; breaking changes require a major bump.

# Undefined / Explicitly user-deferred only
None.
