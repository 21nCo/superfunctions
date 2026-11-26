---
title: Routes
description: Every HTTP route filefn exposes — methods, paths, request shapes, response shapes, error codes.
---

# Routes

The kernel exposes 24 paths covering 27 operations. Every route is mounted under whatever prefix you wire (commonly `/filefn`).

For an interactive explorer, see the [API page](../../api/filefn).

## Upload sessions

| Method | Path | Description | Errors |
| --- | --- | --- | --- |
| POST | `/upload/init` | Create a new upload session. | `FILEFN_INVALID_FILE_ID`, `FILEFN_FORBIDDEN`, `FILEFN_POLICY_NOT_FOUND`, `FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED`, `FILEFN_POLICY_MAX_SIZE_EXCEEDED`, `FILEFN_QUOTA_EXCEEDED`, `FILEFN_NO_SUPPORTED_UPLOAD_MODE`, `FILEFN_STORAGE_STAT_UNAVAILABLE`, `FILEFN_STORAGE_PATH_NOT_PER_VERSION`, `FILEFN_IDEMPOTENCY_CONFLICT`, `FILEFN_AUTH_REQUIRED`, `FILEFN_RATE_LIMITED`. |
| GET | `/upload/:id/status` | Get session status (open, complete, aborted, expired). | `FILEFN_SESSION_NOT_FOUND`, `FILEFN_SESSION_TOKEN_REQUIRED`, `FILEFN_SESSION_TOKEN_INVALID`. |
| POST | `/upload/:id/parts/:n/sign` | Sign a single part for direct PUT to storage. | `FILEFN_INVALID_PART_NUMBER`, `FILEFN_UPLOAD_EXPIRED`, `FILEFN_UPLOAD_ABORTED`, `FILEFN_UPLOAD_ALREADY_COMPLETED`, `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS`, `FILEFN_RATE_LIMITED`. |
| PUT | `/upload/:id/parts/:n` | Upload part bytes through filefn (proxy mode). | `FILEFN_INVALID_PART_NUMBER`, `FILEFN_UPLOAD_EXPIRED`, `FILEFN_UPLOAD_ABORTED`, `FILEFN_UPLOAD_ALREADY_COMPLETED`, `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS`. |
| POST | `/upload/:id/parts/:n/complete` | Record a finished part's etag. | `FILEFN_INVALID_PART_NUMBER`, `FILEFN_INVALID_ETAG`, `FILEFN_PART_CONFLICT`, `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS`. |
| POST | `/upload/:id/complete` | Finalise the session. | `FILEFN_FORBIDDEN`, `FILEFN_UPLOAD_INCOMPLETE`, `FILEFN_UPLOAD_SIZE_MISMATCH`, `FILEFN_STORAGE_STAT_UNAVAILABLE`, `FILEFN_UPLOAD_EXPIRED`, `FILEFN_UPLOAD_ABORTED`, `FILEFN_UPLOAD_ALREADY_COMPLETED`, `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS`, `FILEFN_PROCESSING_ENQUEUE_FAILED`. |
| POST | `/upload/:id/abort` | Abort. Cleans up storage and DB rows. | `FILEFN_UPLOAD_ALREADY_COMPLETED`, `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS` (a completion is running). Otherwise idempotent. |

`POST /upload/init` allocates the `versionId` the session will publish and computes the session's storage key from it, so every session writes its own object key and proxy part keys (`<storageKey>.partN`). `POST /upload/:id/complete` creates the file version with that same `versionId`. A session that loses a race or is refused cannot change the bytes another session published. A policy `storagePath` must return a key that contains the session's full `versionId`; any other key is refused at init with `FILEFN_STORAGE_PATH_NOT_PER_VERSION`.

### Client-chosen file IDs

`POST /upload/init` accepts an optional `fileId`, so a client can keep one ID for a file before and after it syncs (for example an offline capture). A `null` or omitted `fileId` makes the server generate one.

- The ID must match `file_[A-Za-z0-9_-]{8,64}`. Any other value, including an empty string or a non-string, is refused with 400 `FILEFN_INVALID_FILE_ID`. Server-generated IDs and the client SDK's `generateFileId()` match it.
- An ID that names an existing file needs write permission on it; without it init returns 403 `FILEFN_FORBIDDEN`. A new ID is accepted and nothing is reserved.
- The first `POST /upload/:id/complete` that creates the file owns it. A later completion for the same ID is checked against the file as it is then: with write permission it adds a version and becomes the current version; without it the call returns 403 `FILEFN_FORBIDDEN`, the session ends as `aborted`, and the bytes it uploaded are deleted. This covers a session whose init ran before another principal created the file. The session is aborted before anything is deleted, so a retried completion returns 410 `FILEFN_UPLOAD_ABORTED` and can never publish it; if a delete fails, the expired-session cleanup deletes the rest once the session expires. That cleanup deletes a final object only for such a refused session: the object of any other expired session is kept, because a completion still running may publish it.
- A repeated `POST /upload/:id/complete` of the session that created the file returns the same `{ fileId, versionId }`.
- A retried `POST /upload/init` with the same `x-idempotency-key` and body returns the same session, and so the same `fileId`.

The unique `files.fileId` column decides which completion creates the file, so several FileFn processes can share one database. Within a process FileFn also runs the completion calls of each upload session one at a time, and, per `fileId`, the commit step of each completion (the database writes that create the file, add the version or record a refusal) one at a time. Storage finalization and the deletes of a refused upload run outside that step, so a completion slow in storage never holds up another session or another database. On adapters with unique constraints the commit step is serialized per database adapter object, so completions against different databases do not wait on each other; on adapters without them it is serialized per store: a completion whose `fileId` is busy waits only when one of the busy completions' upload sessions is visible in its own database, so adapter objects (such as wrappers) over one store wait on each other and independent stores do not. A completion call that waits more than 30 seconds for an earlier call of the same session (for example a slow proxy stitch, or a request cancelled mid-completion), or, before its storage finalization, for a commit step of its `fileId` already running, returns 409 `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS` without changing anything; retry the completion after a short delay. A completion waiting for its own commit step has already finalized its storage upload, so it keeps waiting instead. A later call never runs alongside one still in progress, with two exceptions where that is harmless: once the earlier call's session has expired (the later call then only reports `FILEFN_UPLOAD_EXPIRED` or the recorded result, or takes over the commit step), and, on adapters with unique constraints, after 30 seconds between commit steps of different sessions of one `fileId`, which the unique constraint arbitrates as it does across processes. On database adapters without unique constraints (`capabilities.schema.constraints` is `false`, such as the memory adapter) the in-process guard is the only one, so those adapters support a single FileFn process only.

An upload session completes at most once, also across FileFn processes sharing one database. Before it changes anything, a completion call claims the session with a conditional write that moves it from `pending` or `in_progress` to `completing`. While a call holds that claim:

- Another `POST /upload/:id/complete` of the session waits for it (polling the session, for at most 30 seconds) and then returns the same `{ fileId, versionId }`; if it is still running after 30 seconds, the call returns 409 `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS` without changing anything. It never repeats storage finalization or a refusal. Once the session is `publishing`, it finishes the recorded publication instead of waiting.
- `POST /upload/:id/abort` and the part calls return 409 `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS`. An abort ends the session with the same kind of conditional write before deleting anything, so an abort and a completion never both proceed.
- `GET /upload/:id/status` reports the session (`completing` or `publishing`) as `in_progress`.

A completion publishes in two steps. After storage finalization and its checks, it moves the session from `completing` to `publishing` with one conditional write on its claim, which gets a fresh publication revision, recording what it publishes (`completionPublication`: the version ID, its object, and the file version it replaces, or none for a new file); only then does it write the version and the file. A completion that fails before that write returns the session to its earlier status, so it can be retried or aborted at once. A `publishing` session is never returned, aborted, expired or deleted with its file: abort, the part calls and `DELETE /:fileId` return 409 `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS`, and the next completion call (also past the session's expiry), or else the expiry sweep once the session has expired, finishes the recorded publication without checking the quota again: it inserts the version row, then points the file at it (creating a new file, or moving the file only from the recorded version), then marks the session completed. These steps are idempotent, so overlapping calls finish one publication once. A call writes a row only while the session still has the publication revision it read, so a call whose decision another call replaced writes nothing; a row write already in flight when another call completed the session and the file was deleted, or refused the publication, is removed again by that call, or else by the expiry sweep, which keeps the record of a refused publication and of a deleted file's publications for good and removes such rows at every run, however late they land; the call that marks the session completed records usage, emits `file:uploaded` and triggers processing, and a cleanup failure after that (temporary parts or unused objects) never skips them: part rows whose objects could not be deleted stay for the expiry sweep. A replacement inserts its version before moving the file, so the file never points at a missing version; if another writer moved the file on meanwhile, the file keeps that writer's version and this one stays in its history. A new file that another principal created first is written only with the caller's write permission (the publication's base is recorded again under a new revision), otherwise the session is refused. A new file records the version that created it (`originVersionId`): if a later upload replaced it before the creating publication finished, the file keeps the later version and the creating one joins its history. A session an earlier `@filefn/server` left partly published (its file points at its version, but it never completed) is moved to `publishing` by the next completion call, abort (which then returns 409) or expiry sweep, and finished the same way. If its version row is missing too, it is moved only once its own object is confirmed in storage at its full size; otherwise it stays as it is, with no completion, usage, event or processing: completion and abort return 409 `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS` and the expiry sweep keeps it. A claim older than `completionTimeoutSeconds` (default 900), such as one left by a crashed or stalled process, is taken over by the next completion call, in another process or (after waiting 30 seconds for the earlier call) in the same one; if that call is refused before claiming (for example by the quota), it ends the stale claim, so the session can be aborted, unless the earlier holder moved it to `publishing` or completed it meanwhile: then it finishes or returns that. A holder taken over writes no file or version row: its move to `publishing`, and its refusal, are conditional on its claim. `completionTimeoutSeconds` must exceed the longest time one database write may stay in flight (the database's statement and connection timeouts): the takeover relies on it, and the expiry sweep deletes a refused publication's objects only that long after the refusal. A multipart takeover that finds the upload already completed by the earlier holder publishes the object it left. A proxy upload keeps its part objects until the session is completed, and every completion after the session's first claim stitches them into an object of its own, so a stalled holder still writing its stitch never rewrites or truncates the published object; the call that completes the session deletes the parts and the objects it does not publish, and an abort or the expiry sweep deletes them too: each claim records the earlier retakes whose objects may remain, and the expiry sweep ends a proxy session as aborted, deletes those objects, and deletes the session row only once every delete succeeded (a failed delete keeps it for the next sweep). A proxy stitch that fails part-way aborts its write instead of committing a partial object.

## Files

| Method | Path | Description |
| --- | --- | --- |
| GET | `/files` | List files (filtered by principal / tenant). |
| GET | `/:fileId` | Get file metadata. |
| DELETE | `/:fileId` | Delete file (and all versions / artifacts). Returns 409 `FILEFN_UPLOAD_COMPLETION_IN_PROGRESS`, deleting nothing, while an upload session of the file is `completing` or `publishing`; retry once it completes. A session whose completer crashed is finished by the session's next completion call (a `completing` one once its claim is older than `completionTimeoutSeconds`), or else by the expiry sweep once the session expires, so the wait is bounded by the session TTL. Other open sessions of the file are aborted first, each with a write conditional on its status, so a session a completion claims meanwhile also gets 409 instead of being torn down. |

## Versions

| Method | Path | Description |
| --- | --- | --- |
| GET | `/:fileId/versions` | List versions. |
| GET | `/:fileId/versions/:versionId` | Get version metadata. |
| GET | `/:fileId/versions/:versionId/download` | Resolve download URL for a specific version. |

## Downloads

| Method | Path | Description |
| --- | --- | --- |
| GET | `/:fileId/download` | Resolve download URL (signed URL or proxy URL). |
| GET | `/proxy/files/:fileId/download` | Proxy-mode download (always streams through filefn). |
| GET | `/proxy/files/:fileId/versions/:versionId/download` | Proxy-mode version download. |

## Artifacts

| Method | Path | Description |
| --- | --- | --- |
| GET | `/:fileId/artifacts` | List artifacts. |
| GET | `/:fileId/artifacts/:artifactId/download` | Resolve artifact download URL. |
| GET | `/proxy/files/:fileId/artifacts/:artifactId/download` | Proxy-mode artifact download. |
| POST | `/:fileId/process` | Manually trigger processing. |

## Render intents

| Method | Path | Description |
| --- | --- | --- |
| GET | `/:fileId/render` | Resolve a render intent (`thumbnail`, `preview`, `full`). |

## Permissions / grants

| Method | Path | Description |
| --- | --- | --- |
| POST | `/:fileId/permissions` | Create a grant. |
| GET | `/:fileId/permissions` | List grants. |
| DELETE | `/:fileId/permissions/:permissionId` | Revoke a grant. |

## Share links

| Method | Path | Description |
| --- | --- | --- |
| POST | `/:fileId/share-links` | Create a share link. |
| GET | `/:fileId/share-links` | List share links. |
| DELETE | `/:fileId/share-links/:token` | Revoke a share link. |
| GET | `/share-links/:token/download` | Resolve a share-link download URL. |
| GET | `/proxy/share-links/:token/download` | Proxy-mode share-link download. |

## Capabilities

| Method | Path | Description |
| --- | --- | --- |
| GET | `/policies` | List registered policies. |
| GET | `/quota/storage` | Get storage quota for the principal/tenant. |

## Common headers

| Header | Direction | Description |
| --- | --- | --- |
| `Authorization` | request | Whatever your `auth.resolveSession` reads. Typical: `Bearer <token>`. |
| `x-request-id` | request / response | Correlation id; auto-generated if absent. |
| `x-idempotency-key` | request | On `POST /upload/init` to dedupe retries. |
| `x-filefn-replay-scope` | request | On `POST /upload/init` from an offline replay: `unpinned`, then the `replayScope` its first init returned. Refused without an authenticated caller (401) or for another owner or tenant (409). |
| `x-upload-session-token` | request | Anonymous session token for unauthenticated uploads. |
| `x-filefn-client-version` | request | Sent by the bundled clients. |
| `etag` | response | On part PUTs. |

## See also

- [API explorer](../../api/filefn) — full interactive spec.
- [Errors](./errors) — per-error reference.
- [Envelopes](./envelopes) — request / response wrapper.
