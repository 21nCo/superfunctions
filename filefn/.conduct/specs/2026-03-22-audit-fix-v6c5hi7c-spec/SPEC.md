# Metadata
- Timestamp (UTC): 2026-03-22T11:40:39Z
- Agent name: unknown-agent
- Model: gpt-5-codex
- Launcher: Codex Desktop
- Workspace/project (absolute): /Users/serro/Documents/dev/n/superfunctions/filefn
- Monorepo root (absolute): /Users/serro/Documents/dev/n/superfunctions
- OS + shell:
  - OS: Darwin ArBook.local 25.3.0 arm64
  - Shell: /bin/zsh
- Repo metadata:
  - VCS: git
  - Branch: next
  - Commit: b69090aaa83f0515924aa9b11df3b1fcd4de3a1a
  - Dirty: true (pre-existing unrelated workspace changes are present)
- Spec metadata:
  - spec_type: audit-fix
  - spec_id: v6c5hi7c
  - spec_folder: 2026-03-22-audit-fix-v6c5hi7c-spec
  - spec_folder (absolute): /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-22-audit-fix-v6c5hi7c-spec
- Inputs read (authoritative for this spec):
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/audits/2026-03-22-k1x3xxg7-full-audit.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/audits/2026-03-22-lfdh4ke1-full-audit.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-20-audit-fix-kevfp02n-spec/SPEC.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-20-audit-fix-kevfp02n-spec/REQUIREMENTS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-20-audit-fix-kevfp02n-spec/TEST_VECTORS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-20-audit-fix-kevfp02n-spec/PLAN.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-20-audit-fix-kevfp02n-spec/INTENT_AUDIT.md
  - /Users/serro/Documents/dev/n/superfunctions/AGENTS.md
  - /Users/serro/Documents/dev/n/nucleus/AGENTS.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/python/README.md
  - /Users/serro/Documents/dev/n/superfunctions/filefn/examples/full-demo/README.md
- Audit references:
  - readiness audit: /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/audits/2026-03-22-lfdh4ke1-full-audit.md
  - audit-fix compliance audit: /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/audits/2026-03-22-k1x3xxg7-full-audit.md
  - superseded spec bundle: /Users/serro/Documents/dev/n/superfunctions/filefn/.conduct/specs/2026-03-20-audit-fix-kevfp02n-spec

# Overview
This is a superseding **audit-fix** specification for FileFn.

The one-sentence goal is: **make FileFn the canonical file platform for Nucleus by fixing the remaining audit failures, adding the missing migration/runtime capabilities, and enabling a final state where Nucleus uses native FileFn IDs with only a temporary migration compatibility layer.**

## Context
- Project name: FileFn package family in the Superfunctions monorepo
- One-sentence goal: Replace Nucleus’s legacy file upload/render/storage integration with FileFn-native upload, storage, rendering, offline preview, and migration flows while fixing all unresolved FileFn audit issues.
- Target users:
  - application developers using `@filefn/server`, `@filefn/client`, `@filefn/processing`, and the new `@filefn/viewer`
  - Nucleus maintainers migrating existing upload, preview, and file-view flows
  - Python application developers consuming the FileFn server/storage surfaces
- Target environments:
  - TypeScript server runtimes: Node.js >= 18 and Fetch-compatible server runtimes
  - Browser client runtimes: modern browsers with Fetch, Streams, OPFS, Blob/Object URL APIs
  - Python server runtimes: CPython >= 3.10
  - Storage: S3-compatible backends, local storage, and other existing `@superfunctions/storage*` adapters
  - Online and offline browser modes are both in scope
- Languages/packages required:
  - TypeScript: `filefn/server`, `filefn/client`, `filefn/processing`, new `filefn/viewer`, `packages/storage`, `packages/storage-*`, `packages/files`, `packages/db`, `packages/middleware`
  - Python: `filefn/python`
  - External integration target: `/Users/serro/Documents/dev/n/nucleus`
- Existing systems it must integrate with:
  - `@superfunctions/storage` adapters
  - `@superfunctions/db`
  - `@superfunctions/files`
  - Nucleus client upload/view/store flows
  - Nucleus persistence/migration scripts
- Data model summary:
  - `files`: canonical logical file records
  - `fileVersions`: immutable stored versions
  - `uploadSessions` / `uploadParts`: resumable upload state
  - `fileArtifacts`: derived artifacts such as image thumbnails and PDF previews
  - `filePermissions` / `fileShares`: access-control metadata
  - OPFS pending-upload metadata: browser-local staged file bytes and preview state
  - legacy migration manifest rows: deterministic descriptions of old Nucleus file resources and their rewrite targets
- Security model:
  - authentication MAY be optional, but every continuation route MUST bind to caller identity or a server-minted session/share capability
  - authorization MUST be enforced at file/version/artifact/share/render boundaries
  - multi-tenant dedupe and migration MUST be tenant-safe
  - signed URLs, upload session tokens, share tokens, auth headers, and credentials MUST NOT be logged
- Performance constraints:
  - large uploads MUST remain resumable and proxy-capable
  - offline local preview MUST be immediate and must not require a completed server round-trip
  - render selection MUST be deterministic and bounded
  - migration MUST support large existing file inventories without requiring a full byte copy when policy/storage constraints do not require one
- Non-goals / out of scope:
  - OCR, text extraction, and content indexing
  - generic DAM workflows
  - video poster extraction/generation
  - new storage backends outside the existing adapter family
  - long-lived compatibility with the Nucleus `file:` resource model
- Hard constraints:
  - final steady state MUST use native FileFn IDs in Nucleus
  - temporary migration compatibility is allowed only during cutover
  - multi-bucket support MUST be implemented as a storage-router plugin/wrapper, not as FileFn-core bucket branching
  - offline unsynced files MUST persist to OPFS and support immediate local preview/access
  - browser HEIC conversion MUST be supported; server-side/non-browser HEIC conversion is SHOULD-level, not MUST-level
  - Python server/storage semantics MUST stay parity-targeted for every new server/storage capability in this bundle

## Assumptions
1. Nucleus can tolerate a temporary dual-read/dual-resolve migration window, but not a long-lived dual-write steady state.
2. Existing legacy file bytes SHOULD be adopted in place by backfilling FileFn records against existing storage objects whenever policy/routing allows it.
3. FileFn-native IDs MAY be client-generated before upload using a canonical helper, so offline/local references can be stable before remote completion.
4. The new viewer package is framework-agnostic core logic; Nucleus-specific Svelte wrappers MAY live in the Nucleus repo.
5. `@uifn/files` remains experimental and is not the canonical viewer package for the migration cutover.

# Glossary
- **Canonical envelope**: JSON wrapper `{ ok, data|error, requestId, warnings? }` used by every control-plane route.
- **Control-plane**: JSON metadata APIs, never raw file bytes.
- **Data-plane**: raw byte upload/download/proxy streams.
- **Logical storage target**: an abstract storage class name such as `durable` or `temporary` selected by FileFn policy.
- **Physical bucket route**: the concrete storage adapter/bucket selected by the storage-router plugin for a logical storage target.
- **Renderable intent**: one of `thumbnail`, `preview`, `full`, or `download`.
- **Renderable descriptor**: the resolved remote or local source a viewer can use for a renderable intent.
- **Local pending file**: an OPFS-persisted upload that has not yet completed remote sync.
- **Compatibility layer**: temporary Nucleus-side logic able to resolve both legacy file references and native FileFn IDs during cutover.
- **Legacy manifest**: exported deterministic JSON/JSONL rows describing pre-FileFn Nucleus file records and storage objects.
- **Import manifest**: the legacy manifest enriched with the target FileFn file IDs, artifact mappings, and migration status.
- **Rewrite manifest**: deterministic mapping from legacy Nucleus references to final FileFn-native references.
- **Artifact**: a derived file representation stored in `fileArtifacts`, such as an image thumbnail or PDF preview image.
- **Preferred representation**: the renderable source that best matches a render intent, chosen deterministically by FileFn.

# Goals / Non-goals
## Goals
FileFn MUST:
1. fix every unresolved failure or partial finding from the 2026-03-22 compliance audit against the prior audit-fix bundle;
2. preserve the previously specified production-readiness guarantees unless this bundle explicitly supersedes them;
3. add routed multi-bucket storage support without hard-coding bucket selection into FileFn core;
4. add a canonical render/view model so consumers no longer need to persist ad-hoc `url` / `thumbnailUrl` shapes;
5. add PDF preview thumbnails and browser HEIC conversion;
6. support offline OPFS persistence plus immediate local preview/access for unsynced files;
7. provide a deterministic migration path for existing Nucleus file data, using native FileFn IDs as the final state;
8. enable Nucleus to delete its legacy file upload/render code after the migration cutover succeeds;
9. maintain Python parity for all server/storage semantics touched by this bundle.

## Non-goals
1. Long-lived support for the Nucleus `file:` resource model in steady state.
2. Generic content-management features unrelated to upload, render, preview, migration, and file access.
3. New media-processing domains beyond image thumbnails and PDF preview images.
4. Video poster generation.

# Public API
## Package boundaries
### TypeScript packages
- `filefn/server/package.json` MUST publish as `@filefn/server`.
- `filefn/client/package.json` MUST publish as `@filefn/client`.
- `filefn/processing/package.json` MUST publish as `@filefn/processing`.
- `filefn/viewer/package.json` MUST publish as `@filefn/viewer`.
- `packages/files/package.json` MUST publish as `@superfunctions/files`.
- `@uifn/files` MAY remain experimental and MUST NOT become the canonical FileFn viewer dependency for the migration cutover.

### Python package
- `filefn/python/pyproject.toml` MUST continue to publish `filefn`.
- The Python server surface MUST expose the same logical capabilities introduced in this bundle for storage routing, render/artifact access, processing, and migration support where those capabilities are server/storage features.

## TypeScript server surface
```ts
export interface Policy {
  id: string;
  visibility?: 'private' | 'public' | 'tenant';
  contentTypes?: string[];
  maxSizeBytes?: number;
  storageTarget?: string; // logical target, default 'durable'
  artifactStorageTarget?: string; // logical target for derived artifacts, default policy.storageTarget
  lifecycle?: 'durable' | 'temporary';
  renderProfile?: 'default' | 'nucleus';
}

export interface FileFnConfig {
  db: import('@superfunctions/db').Adapter;
  storage: import('@superfunctions/storage').StorageAdapter;
  policies?: Policy[];
  auth?: AuthConfig;
  quota?: QuotaProvider;
  rateLimit?: RateLimitConfig;
  dedup?: { enabled?: boolean };
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

### New/extended HTTP routes
The canonical router continues to mount routes at the FileFn root. The following routes are required:
- `GET /:fileId`
- `GET /:fileId/download`
- `GET /:fileId/versions/:versionId/download`
- `GET /:fileId/artifacts`
- `GET /:fileId/artifacts/:artifactId/download`
- `GET /:fileId/render?intent=thumbnail|preview|full|download[&versionId=...]`

### Render descriptor response shape
```ts
export interface RenderDescriptor {
  fileId: string;
  versionId: string;
  intent: 'thumbnail' | 'preview' | 'full' | 'download';
  state: 'ready' | 'processing' | 'pending-local' | 'unsupported';
  mimeType: string;
  name: string;
  size: number;
  source:
    | {
        mode: 'artifact';
        artifactId: string;
        artifactKind: string;
        url: string;
        headers?: Record<string, string>;
      }
    | {
        mode: 'original';
        url: string;
        headers?: Record<string, string>;
      }
    | {
        mode: 'placeholder';
        placeholderKind: 'generic-file' | 'pdf-processing' | 'unsupported-preview';
      };
  warnings?: string[];
}
```

## Client surface
```ts
export interface UploadPreprocessorInput {
  fileId: string;
  file: File | Blob;
  fileName: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

export interface UploadPreprocessorResult {
  file: File | Blob;
  fileName: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
  localArtifacts?: Array<{
    kind: string;
    file: File | Blob;
    mimeType: string;
  }>;
}

export interface UploadPreprocessor {
  name: string;
  applies(input: UploadPreprocessorInput): boolean | Promise<boolean>;
  process(input: UploadPreprocessorInput): Promise<UploadPreprocessorResult>;
}

export interface UploadInput {
  policy: string;
  file: File | Blob;
  fileName?: string;
  metadata?: Record<string, unknown>;
  fileId?: string;
  idempotencyKey?: string;
}

export interface FileFnClient {
  generateFileId(): string;
  uploadFile(input: UploadInput): UploadHandle;
  resumeUpload(uploadSessionId: string, file: Blob, options?: { uploadSessionToken?: string }): UploadHandle;
  getFile(fileId: string, options?: { versionId?: string }): Promise<Record<string, unknown>>;
  listArtifacts(fileId: string): Promise<Array<Record<string, unknown>>>;
  downloadUrl(fileId: string, options?: { versionId?: string }): Promise<string>;
  downloadArtifact(fileId: string, artifactId: string): Promise<string>;
  resolveRenderable(input: {
    fileId: string;
    intent: 'thumbnail' | 'preview' | 'full' | 'download';
    versionId?: string;
    preferLocal?: boolean;
  }): Promise<RenderDescriptor>;
  deleteFile(fileId: string): Promise<void>;
}

export function createHeicConversionPreprocessor(config?: {
  targetFormat?: 'jpeg' | 'png';
  quality?: number;
}): UploadPreprocessor;
```

## Viewer package surface
```ts
export interface ViewerResolver {
  resolve(input: {
    fileId: string;
    intent: 'thumbnail' | 'preview' | 'full' | 'download';
    versionId?: string;
    preferLocal?: boolean;
  }): Promise<RenderDescriptor>;
}

export interface ViewerSource {
  fileId: string;
  intent: 'thumbnail' | 'preview' | 'full' | 'download';
  state: 'ready' | 'processing' | 'pending-local' | 'unsupported';
  mimeType: string;
  url?: string;
  placeholderKind?: 'generic-file' | 'pdf-processing' | 'unsupported-preview';
  revoke?: () => void;
}

export function createViewerResolver(client: import('@filefn/client').FileFnClient): ViewerResolver;
export function resolveViewerSource(input: {
  client: import('@filefn/client').FileFnClient;
  fileId: string;
  intent: 'thumbnail' | 'preview' | 'full' | 'download';
  versionId?: string;
  preferLocal?: boolean;
}): Promise<ViewerSource>;
```

## Storage-router plugin surface
This bundle does not change the core `StorageAdapter` method signatures. Multi-bucket behavior is introduced as a plugin/wrapper.

```ts
export interface RoutedStorageConfig {
  defaultTarget: string;
  targets: Record<string, import('@superfunctions/storage').StorageAdapter>;
  resolveTarget(input: { key: string }): string;
  normalizeKey?(input: { key: string; target: string }): string;
}

export function createRoutedStorageAdapter(config: RoutedStorageConfig): import('@superfunctions/storage').StorageAdapter;
```

Python MUST expose the equivalent logical capability through:
```python
def create_routed_storage_adapter(
    *,
    default_target: str,
    targets: dict[str, StorageAdapter],
    resolve_target: Callable[[str], str],
    normalize_key: Callable[[str, str], str] | None = None,
) -> StorageAdapter: ...
```

# Data formats / protocol
## Canonical envelopes
Every control-plane route MUST use:

Success:
```json
{
  "ok": true,
  "data": {},
  "requestId": "req_123",
  "warnings": []
}
```

Failure:
```json
{
  "ok": false,
  "error": {
    "code": "FILEFN_NOT_FOUND",
    "message": "File not found",
    "details": {}
  },
  "requestId": "req_123"
}
```

## Stable error codes
This bundle requires the following codes in addition to the previously specified codes:
- `FILEFN_INVALID_UPLOAD_SESSION_TOKEN`
- `FILEFN_IDEMPOTENCY_CONFLICT`
- `FILEFN_NO_SUPPORTED_UPLOAD_MODE`
- `FILEFN_UPLOAD_INCOMPLETE`
- `FILEFN_RENDER_UNSUPPORTED`
- `FILEFN_PREVIEW_NOT_READY`
- `FILEFN_MIGRATION_MANIFEST_INVALID`
- `FILEFN_MIGRATION_CONFLICT`

## Canonical artifact kinds
The following artifact kinds are reserved and MUST be used exactly:
- image thumbnails:
  - `thumbnail-small`
  - `thumbnail-medium`
  - `thumbnail-large`
- PDF preview images:
  - `pdf-preview-page-1-small`
  - `pdf-preview-page-1-medium`
  - `pdf-preview-page-1-large`

Additional artifact kinds MAY exist, but they MUST NOT change the meaning of the reserved names.

## Render intent selection
The render route and viewer resolver MUST map intents deterministically:
- `thumbnail`
  - images: prefer `thumbnail-small`, then `thumbnail-medium`, then original
  - PDFs: prefer `pdf-preview-page-1-small`, then `pdf-preview-page-1-medium`, then placeholder
- `preview`
  - images: prefer `thumbnail-large`, then original
  - PDFs: prefer `pdf-preview-page-1-large`, then `pdf-preview-page-1-medium`, then placeholder
- `full`
  - use the original file download URL
- `download`
  - use the original file download URL

## Legacy migration manifest
The canonical manifest row shape is:
```json
{
  "legacyFileResourceId": "file:image_abc123",
  "targetFileId": "file_legacy_7w9m2p",
  "ownerId": "user_123",
  "tenantId": "tenant_456",
  "policyId": "nucleus-durable-default",
  "storageTarget": "durable",
  "primaryObject": {
    "bucket": "tidyfiles.us-east-1",
    "key": "user_123/image/guid_name.png",
    "mimeType": "image/png",
    "size": 12345,
    "checksumSha256Base64": null
  },
  "thumbnailObject": {
    "bucket": "tidyfiles.us-east-1",
    "key": "user_123/image/thumbnail_guid_name.jpg",
    "mimeType": "image/jpeg",
    "size": 1234
  },
  "legacyMetadata": {},
  "createdAt": "2026-03-22T00:00:00Z",
  "updatedAt": "2026-03-22T00:00:00Z",
  "references": [
    {
      "resourceType": "node",
      "resourceId": "node:abc",
      "field": "file"
    }
  ]
}
```

The importer MUST emit a deterministic mapping row:
```json
{
  "legacyFileResourceId": "file:image_abc123",
  "targetFileId": "file_legacy_7w9m2p",
  "currentVersionId": "ver_legacy_3k2m8p",
  "status": "imported",
  "warnings": []
}
```

# Semantics
## Upload/session/auth semantics
1. Upload init MUST bind to the initiating caller identity or, for anonymous init, to a server-minted opaque upload session token.
2. Init replay with the same idempotency key and identical payload MUST return the original semantic success result, including the original anonymous upload session token if one was issued.
3. Replace-by-file uploads MUST be authorized at init and re-authorized at completion.
4. Upload completion MUST persist file metadata, emit the canonical uploaded event, and trigger processing when configured.
5. Abort and garbage collection MUST clean temporary upload state deterministically and idempotently.

## Metadata semantics
1. File-level metadata from upload init or migration import MUST be stored on the `files` row.
2. Version-level metadata that differs per version MAY be stored on `fileVersions` when needed by processing or migration provenance.
3. Metadata used for idempotency hashing MUST match the persisted file metadata for the completed upload.

## Storage routing semantics
1. FileFn core MUST remain bucket-agnostic.
2. Policy selects a logical `storageTarget`.
3. Storage-router plugin maps logical targets to physical adapters/buckets.
4. Imported legacy objects MAY point at pre-existing physical buckets as long as their logical target resolution remains deterministic.
5. The same file MAY have original bytes and artifacts routed to different logical storage targets if policy requires it.

## Processing semantics
1. TypeScript `createFileFn()` MUST pass the created processing service into upload-session completion.
2. The image thumbnail processor remains supported and MUST keep its reserved artifact kinds.
3. A PDF preview processor MUST generate first-page image artifacts using the reserved PDF preview artifact kinds.
4. Processing MUST be idempotent per `(fileId, versionId, processor-set)` tuple.
5. Artifact access MUST be authorized through the parent-file read boundary.

## Offline/local preview semantics
1. OPFS pending-upload metadata MUST include `fileId`, `fileName`, `mimeType`, and any local artifact descriptors needed for immediate preview.
2. If a caller omits `fileId`, the client MUST generate one before staging when local preview or offline sync is enabled.
3. Unsynced local images MUST render from OPFS bytes immediately.
4. Unsynced local PDFs MUST support immediate access and preview; if a PDF thumbnail is not yet locally available, the viewer MUST return a deterministic placeholder while still allowing full-file open.
5. Once remote sync completes, the same `fileId` MUST resolve to the remote file/version without requiring caller-side ID rewriting.

## Render/view semantics
1. Consumers MUST NOT persist direct signed URLs as the canonical file identity.
2. Consumers SHOULD persist only `fileId` and optionally `versionId`.
3. Renderers MUST resolve live remote URLs and local object URLs on demand.
4. The viewer MUST prefer local pending sources when `preferLocal=true` and a pending upload exists for the file.
5. The viewer MUST revoke generated object URLs when the consumer releases the resolved source.

## Nucleus migration semantics
1. Final state Nucleus write paths MUST create and persist native FileFn IDs only.
2. Temporary compatibility MAY resolve legacy `file:` resource IDs during cutover, but new writes MUST NOT create new legacy file records.
3. Legacy migration MUST be manifest-driven and deterministic.
4. The migration MUST support in-place adoption of existing stored objects whenever policy/storage routing allows it.
5. The cutover MUST provide a rollback manifest and a completion report before legacy code deletion.

# Invariants
1. `listFiles` ordering MUST be `updatedAt DESC, fileId ASC`.
2. `getFile({ versionId })`, artifact access, render resolution, and downloads MUST enforce binding to the parent `fileId`.
3. Client-generated FileFn IDs MUST be deterministic for the life of the upload and MUST survive offline sync.
4. The same legacy manifest input MUST generate the same target FileFn IDs and rewrite mapping on repeated dry runs.
5. No control-plane response may return `proxy://...`.
6. A render descriptor MUST always resolve to exactly one primary source or one deterministic placeholder; selection MUST NOT be random.
7. Temporary compatibility logic MUST be removable without changing the final FileFn wire protocol.

# Security
1. Upload session tokens, share tokens, auth headers, signed URLs, and provider credentials MUST be redacted from logs on both TS and Python surfaces.
2. File/version/artifact/share/render authorization MUST use the same caller binding rules for control-plane and proxy data-plane flows.
3. Migration scripts MUST validate ownership/tenant mappings before importing legacy rows.
4. Legacy manifest rows with ambiguous ownership, conflicting references, or cross-tenant object reuse MUST fail validation with `FILEFN_MIGRATION_CONFLICT`.
5. Local OPFS preview metadata MUST NOT store plaintext secrets or signed URLs.

# Limits/caps
1. The Nucleus-aligned default durable policy MUST accept:
   - image: `image/png`, `image/jpeg`, `image/jpg`, `image/webp`, `image/gif`, `image/svg+xml`, `image/heic`
   - video: `video/mp4`, `video/quicktime`
   - audio: `audio/wav`, `audio/mpeg`
   - document: `application/pdf`, `text/markdown`, `text/plain`
2. The Nucleus-aligned max file size MUST default to `104857600` bytes (`100 MiB`) unless a consumer opts into a stricter policy.
3. Thumbnail and PDF preview processors MUST emit `small`, `medium`, and `large` variants only.
4. `listFiles.limit` MUST default to `20` and cap at `100`.
5. Migration scripts MUST support dry-run without mutating storage or databases.

# Observability
1. FileFn MUST emit correlated events for upload start, upload complete, processing complete, migration import, and migration rewrite.
2. `requestId` MUST flow through server logs and control-plane envelopes when provided.
3. Migration runs MUST emit structured summaries:
   - manifest rows read
   - rows imported
   - rows skipped
   - rows failed
   - references rewritten
4. Safe identifiers such as `fileId`, `versionId`, `artifactId`, `policyId`, `storageTarget`, and `requestId` MUST remain visible in logs unless they appear inside a secret-bearing field.

# Compatibility / versioning strategy
1. This bundle supersedes `2026-03-20-audit-fix-kevfp02n-spec`.
2. Existing FileFn control-plane envelopes remain canonical and are extended only additively.
3. New viewer/render APIs are additive.
4. Temporary Nucleus compatibility logic is allowed only for migration and MUST be removable after cutover verification.
5. Final steady state:
   - Nucleus stores FileFn-native `fileId` references
   - render/view logic resolves on demand through FileFn client/viewer APIs
   - legacy Nucleus `file:` resource creation and legacy signed-URL refresh code are deleted

# Undefined / Explicitly user-deferred only
The following are explicitly Undefined and therefore NOT required by this spec:
1. video poster/thumbnail generation
2. OCR or content extraction from PDFs/images
3. long-lived support for the Nucleus `file:` resource model after cutover
4. non-browser/server-side HEIC conversion parity beyond the SHOULD-level recommendation captured in requirements
