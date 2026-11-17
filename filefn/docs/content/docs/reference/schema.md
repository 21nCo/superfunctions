---
title: Schema
description: Every filefn DB table — columns, types, indexes — and how to migrate them.
---

# Schema

filefn ships seven tables, all prefixed with `namespace` (default `filefn`).

## `filefn_upload_sessions`

| Column | Type | Notes |
| --- | --- | --- |
| `uploadSessionId` | string (PK) | |
| `status` | string | `"pending" | "in_progress" | "completing" | "completed" | "aborted" | "refused"`. `completing` is held by one completion call; `refused` is a completion refused for permission. The status route reports them as `in_progress` and `aborted`. |
| `policy` | string | |
| `fileId` | string? | Set on completion. |
| `fileName` | string | |
| `mimeType` | string | |
| `size` | number | Declared total size. |
| `uploadMode` | string | `"multipart-signed-url" | "multipart-proxy"` |
| `chunkSizeBytes` | number | |
| `totalParts` | number | |
| `storageKey` | string | Computed from policy. |
| `storageUploadId` | string? | Adapter-specific multipart id. |
| `ownerId` | string | Or anonymous principal id. |
| `tenantId` | string? | |
| `idempotencyKey` | string? | Per (owner, tenant). |
| `idempotencyPayloadHash` | string? | |
| `completionClaim` | string? | `<ISO time> <random>`: the claim of the completion call holding the session (`completing`) or of the call that completed it. Added in `@filefn/server` 0.6.1; add this nullable column to existing tables. |
| `expiresAt` | string | ISO. |
| `createdAt` | string | ISO. |

Indexes:

- PK on `uploadSessionId`.
- Unique partial: `(ownerId, COALESCE(tenantId, ''), idempotencyKey)` where `idempotencyKey IS NOT NULL`.
- `(expiresAt)` for sweepers.

## `filefn_upload_parts`

| Column | Type | Notes |
| --- | --- | --- |
| `uploadSessionId` | string | |
| `partNumber` | number | |
| `etag` | string | |
| `size` | number | |
| `checksumSha256Base64` | string? | |

Index: `UNIQUE (uploadSessionId, partNumber)`.

## `filefn_files`

| Column | Type | Notes |
| --- | --- | --- |
| `fileId` | string (PK) | |
| `currentVersionId` | string | |
| `ownerId` | string | |
| `tenantId` | string? | |
| `visibility` | string | `"public" | "private" | "shared"` |
| `policy` | string | |
| `mimeType` | string | |
| `size` | number | |
| `name` | string | |
| `metadata` | json? | App-defined. |
| `createdAt` | string | |
| `updatedAt` | string | |

Indexes: `(ownerId)`, `(tenantId)`.

## `filefn_file_versions`

| Column | Type | Notes |
| --- | --- | --- |
| `versionId` | string (PK) | |
| `fileId` | string | |
| `storageKey` | string | |
| `mimeType` | string | |
| `size` | number | |
| `checksumSha256Base64` | string? | Required for dedup. |
| `tenantId` | string? | |
| `createdAt` | string | |

Indexes: `(fileId)`, `(checksumSha256Base64, tenantId)` for dedup lookups.

## `filefn_file_artifacts`

| Column | Type | Notes |
| --- | --- | --- |
| `artifactId` | string (PK) | |
| `fileId` | string | |
| `versionId` | string | |
| `kind` | string | e.g. `"thumbnail-thumb"`. |
| `storageKey` | string | |
| `mimeType` | string | |
| `size` | number? | |
| `metadata` | json? | `metadata.processing` is reserved; see below. |
| `createdAt` | string | |

Indexes: `(fileId)`, `(versionId)`.

Processing writes two things here:

- Each artifact's `metadata.processing` holds `{ processor, durationMs, idempotencyKey, storageTarget }`, for inline and queued processing alike. `storageTarget` is the target the object was written to; cleanup of a deleted version uses it once the file row is gone. FileFn overwrites a processor's own `processing` metadata key.
- Queued processing (`createProcessingJobHandler`) also writes one row of kind `filefn.processing-run` (`PROCESSING_RUN_KIND`) per processor instance and job idempotency key, written after that processor's artifacts, records that the processor finished, including runs with no artifacts. Its `artifactId` starts with `run_`, its `storageKey` names no stored object, and `metadata.processingRun` holds `{ processor, instance, idempotencyKey, durationMs, artifactCount }`. One more row of this kind per job idempotency key, with `metadata.processingCompleted` holding `{ idempotencyKey, artifactsCreated }`, records that the job emitted `processing.completed`. The artifact list, lookup and download operations never return these rows, and deleting the file removes them.

## `filefn_file_permissions`

| Column | Type | Notes |
| --- | --- | --- |
| `permissionId` | string (PK) | |
| `fileId` | string | |
| `userId` | string? | |
| `role` | string? | |
| `tenantId` | string? | |
| `canRead` | boolean | |
| `canWrite` | boolean | |
| `canDelete` | boolean | |
| `canShare` | boolean | |
| `expiresAt` | string? | |
| `createdAt` | string | |

Indexes: `(fileId)`, `(userId)`.

## `filefn_file_shares`

| Column | Type | Notes |
| --- | --- | --- |
| `tokenHash` | string (PK) | SHA-256 of plaintext token. |
| `fileId` | string | |
| `versionId` | string? | If pinned to a version. |
| `expiresAt` | string? | |
| `requiresAuth` | boolean | |
| `maxDownloads` | number? | |
| `downloads` | number | |
| `createdAt` | string | |
| `revokedAt` | string? | |

Index: `(fileId)`.

## Migration

```ts
import { getSchema } from "@filefn/server";

const { version, schemas } = getSchema({ namespace: "filefn" });
// Feed these table descriptors into your application's migration tooling.
console.log(version, schemas.map((table) => table.modelName));
```

This only reads schema descriptors; it does not apply a migration. Provision the tables and indexes with your host migration pipeline before serving traffic.

## See also

- [Adapters › DB](../adapters/db).
