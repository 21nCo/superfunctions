---
title: Errors
description: Every filefn error code with its HTTP status, message, common causes, and fixes.
---

# Errors

Every filefn error is a `FileFnError` with:

```ts
{
  code: string;          // "FILEFN_POLICY_NOT_FOUND"
  message: string;       // human-readable
  status: number;        // HTTP status
  details?: object;      // structured context
}
```

Wire-format envelope:

```json
{
  "ok": false,
  "error": {
    "code": "FILEFN_POLICY_NOT_FOUND",
    "message": "Policy 'public-image' not found",
    "details": { "policy": "public-image" }
  }
}
```

## Auth and access

| Code | HTTP | Cause | Fix |
| --- | --- | --- | --- |
| `FILEFN_AUTH_REQUIRED` | 401 | `auth.required: true` and no session resolved. | Sign in; ensure auth wiring forwards cookies / `Authorization`. |
| `FILEFN_FORBIDDEN` | 403 | Authorizer denied. On upload, the `fileId` names a file the caller cannot write: at init when the file exists, or at completion when another principal created it first (the session is then aborted, so a retry returns `FILEFN_UPLOAD_ABORTED`, and its bytes are deleted, by the expired-session cleanup if a delete fails). | Check ownership / grants; check the principal is in the right tenant. |
| `FILEFN_NOT_FOUND` | 404 | File / artifact / share / permission not found. | Confirm the id exists; remember anti-enumeration: 404 may mask a permission denial. |
| `FILEFN_SESSION_TOKEN_REQUIRED` | 401 | Anonymous upload missing `x-upload-session-token`. | Pass the token returned from `POST /upload/init`. |
| `FILEFN_SESSION_TOKEN_INVALID` | 403 | Wrong token for the session. | Re-init the upload, or check storage in the client. |

## Policy

| Code | HTTP | Cause | Fix |
| --- | --- | --- | --- |
| `FILEFN_POLICY_NOT_FOUND` | 400 | Policy name doesn't exist. | Pre-define the policy with `fileFn.definePolicy` or `policies` config. |
| `FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED` | 400 | MIME doesn't match `policy.contentTypes`. | Add the MIME or pick a different policy. |
| `FILEFN_POLICY_MAX_SIZE_EXCEEDED` | 400 | File bigger than `policy.maxSizeBytes`. | Bump the policy or split the upload. |

## Quota and limits

| Code | HTTP | Cause | Fix |
| --- | --- | --- | --- |
| `FILEFN_QUOTA_EXCEEDED` | 402 | `QuotaProvider.check` denied. | Surface plan info to the user; let them upgrade or delete. |
| `FILEFN_RATE_LIMITED` | 429 | Per-route rate limit hit. | Retry after `details.resetAt`. |

## Multipart

| Code | HTTP | Cause | Fix |
| --- | --- | --- | --- |
| `FILEFN_INVALID_PART_NUMBER` | 400 | `partNumber < 1` or `> totalParts`. | Use the part numbers returned by init. |
| `FILEFN_INVALID_ETAG` | 400 | etag empty or malformed. | Read `ETag` from the storage PUT response and pass it through. |
| `FILEFN_UPLOAD_INCOMPLETE` | 409 | `complete` called before all parts are recorded, or a recorded proxy part object is missing. The message is `Upload incomplete` and does not include the session id. | Record every part, and keep the part objects, before `complete`. |
| `FILEFN_UPLOAD_EXPIRED` | 410 | Session past TTL. | Call `init` again with a new idempotency key. |
| `FILEFN_UPLOAD_ABORTED` | 410 | Session was aborted. | Same — start a new session. |
| `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS` | 409 | On `complete`: another completion call of the same upload session (in any FileFn process sharing the database), or the commit step of a completion of the same `fileId` in the same database in this process, is still running and did not finish within 30 seconds. On `abort` or a part call: a completion of the session is running or publishing (a completion call finishes it). On `DELETE /:fileId`: an upload session of the file is completing or publishing. Nothing was changed; `details.retryable` is `true`. | Retry `POST /upload/:id/complete` after a short delay; it returns the completed result. An abort cannot end a session whose completion is running. |
| `FILEFN_UPLOAD_ALREADY_COMPLETED` | 409 | `complete` called twice. | Treat as success; the file id is in the previous response. |
| `FILEFN_IDEMPOTENCY_CONFLICT` | 409 | Same idempotency key + different request body. | Use a new idempotency key, or replay with the same body. |
| `FILEFN_PART_CONFLICT` | 409 | Same part recorded with a different etag. | Check for concurrent retries; pick a single canonical etag. |
| `FILEFN_UPLOAD_SIZE_MISMATCH` | 409 | Sum of part sizes ≠ `size` declared at init. | Re-check declared size before init. |
| `FILEFN_NO_SUPPORTED_UPLOAD_MODE` | 500 | Adapter doesn't support multipart and proxy is disabled. | Use a multipart-capable adapter (S3, GCS, R2, MinIO, Azure). |
| `FILEFN_STORAGE_STAT_UNAVAILABLE` | 500 | Init requires a storage adapter that implements `statObject`. Completion returns this code if a required stat cannot verify the uploaded object or its parts. The message is `Upload size cannot be verified`. | Check adapter support and availability, then retry. |
| `FILEFN_STORAGE_PATH_NOT_PER_VERSION` | 500 | The key the policy's `storagePath` returned does not contain the session's full `versionId`, so two upload sessions could write one object. Refused at init before any session row or storage upload is created. | Include the whole `versionId`, unshortened, in the key your `storagePath` returns. |
| `FILEFN_INVALID_FILE_ID` | 400 | The `fileId` sent to `POST /upload/init` does not match `file_[A-Za-z0-9_-]{8,64}` (or is not a string). Refused before any session row or storage upload is created. | Send an ID in that grammar, such as `generateFileId()` output, or omit `fileId` to let the server generate one. |
| `FILEFN_OFFLINE_UNSUPPORTED` | 400 | Client requested OPFS but the runtime doesn't support it. | Skip OPFS, upload directly. |
| `FILEFN_SESSION_NOT_FOUND` | 404 | The `uploadSessionId` doesn't exist. | Use the id returned from init; sessions expire after TTL. |

## Share links

| Code | HTTP | Cause | Fix |
| --- | --- | --- | --- |
| `FILEFN_SHARE_NOT_FOUND` | 404 | Token doesn't match any share row. | Token is invalid or revoked. |
| `FILEFN_SHARE_REVOKED` | 410 | Share was revoked. | Surface a "this link is no longer valid" message. |
| `FILEFN_SHARE_EXPIRED` | 410 | Share past `expiresAt`. | Same. |
| `FILEFN_SHARE_DOWNLOADS_EXCEEDED` | 410 | `maxDownloads` exhausted. | Same. |
| `FILEFN_SHARE_DOWNLOAD_CONFLICT` | 409 | Too many concurrent downloads of the link. | Retry. |

## Permissions

| Code | HTTP | Cause | Fix |
| --- | --- | --- | --- |
| `FILEFN_PERMISSION_NOT_FOUND` | 404 | `DELETE` on missing permission id. | Check the id; idempotent delete is safe to skip 404s in your client. |

## Processing

| Code | HTTP | Cause | Fix |
| --- | --- | --- | --- |
| `FILEFN_PROCESSING_ENQUEUE_FAILED` | 503 | The processing queue's `add` rejected. | Check queue health; retry. |
| `FILEFN_INVALID_RENDER_INTENT` | 400 | Unknown render intent. | Use `thumbnail` / `preview` / `full` (or a registered custom intent). |

## See also

- [Routes](./routes) — per-route error matrix.
- [Envelopes](./envelopes) — wire-format details.
