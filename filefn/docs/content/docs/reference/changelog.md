---
title: Changelog
description: Notable filefn releases and migration notes.
---

# Changelog

filefn follows semver. The `@filefn/server` version is the spine of these notes. Breaking changes are flagged.

## Unreleased

- **Breaking (`@filefn/client` 0.5):** offline uploads go to a durable OPFS queue bound to `offline.partition` (a service and a user or guest namespace). Without a partition, an offline `uploadFile` throws `FILEFN_OFFLINE_PARTITION_REQUIRED`; `offline.currentPrincipal` is also required (it must answer from local state, without a network request), and queued uploads and hooks run only while it returns the partition's principal. Replays with the built-in transport need `offline.getAuthHeaders(principal)` (`FILEFN_OFFLINE_CREDENTIALS_REQUIRED` otherwise) and send only its headers, with no cookies (`credentials: "omit"`) unless `offline.replayAmbientCredentials` opts in; the client's partition (frozen) and transport are captured when its queue is made. A hold stops an upload already running in any tab before its next request. Tabs announce runnable work to each other on a `BroadcastChannel`, and a started `OfflineSync` also polls while idle (`idlePollMs`). The queue journals each generation's replay key, holds, verification and publication; coordinates tabs with `navigator.locks` (or `offline.queue.coordinator`) and refuses durable work without either; and enforces entry and byte limits. Uploads staged by 0.4 and earlier are no longer replayed automatically: migrate them with `OfflineQueue.migrateLegacyUpload` once you can prove whose they are. Call `client.dispose()` on logout or account switch. See Features › Offline.
- `@filefn/client` sends the `upload/init` idempotency key in the `x-idempotency-key` header. It used to send it in the body, which the server ignored. A key must be 1-255 visible ASCII characters (`FILEFN_INVALID_IDEMPOTENCY_KEY` otherwise), and an application retry must pass the same `fileId` as its first call. Offline, each staged generation sends its own key (the caller's key, if any, is its prefix); a guest partition needs `offline.uploader`; `queue.reconcile` outcomes name their `attemptId`.
- `upload/init` also honors an `idempotencyKey` in the JSON body, with a deprecation warning, until the next minor release; a request giving both forms must give the same value. An idempotent replay reports the session's `status`, and a completed session's `fileId` and `versionId`, so a client confirms the stored file instead of uploading again and starts an expired or aborted session again under a new key. A completed session that never recorded its own version reports no `fileId` or `versionId`.
- A proxy part upload that finds its session completed by another request meanwhile returns `409 FILEFN_UPLOAD_ALREADY_COMPLETED` (it returned `410 FILEFN_UPLOAD_ABORTED`), and completing a session whose live completion claim outlasts its expiry waits for that completion instead of returning `410 FILEFN_UPLOAD_EXPIRED`. An offline replay starts again under a new key only when `upload/init` reports the session ended, which a replay now does only after moving the session to `expired` with a conditional write that excludes any later completion claim; an expired session an earlier FileFn left partly published is finished as a publication instead. A session recorded as `expired` refuses part signing, part uploads, part completion and completion with `410 FILEFN_UPLOAD_EXPIRED` on every worker, whatever its clock says.
- Cross-origin hosts must allow the `x-idempotency-key` request header (keyed uploads and every offline replay send it); the Hono quickstart and the production example now list it.
- Upload init and complete that cannot verify a stored size return `500 FILEFN_STORAGE_STAT_UNAVAILABLE` with the message `Upload size cannot be verified`. A complete whose proxy parts are missing returns `409 FILEFN_UPLOAD_INCOMPLETE` with the message `Upload incomplete`. Neither response names the storage adapter or the upload session.
- A metric sink passed directly in the `observability` configuration receives upload failures (`filefn.upload` / `failure`, with `labels.reason` of `size_unverified`, `parts_missing`, or `size_mismatch`), quota denials (`filefn.quota` / `denied`), and processing duration (`filefn.processing` / `complete`, with `durationMs`). Those labels are a closed set: no file id, session id, error text, or usage figure.
- A processing service built on its own with `createProcessingService` never serves an artifact whose parent file row is missing. `getArtifactDownloadUrl` answers `404 FILEFN_NOT_FOUND` (`Artifact not found`) for it with or without a `readChecker`; before, a service without a `readChecker` signed a URL for it. An artifact whose file row exists is served as before. `createFileFn` always configured a `readChecker`, so it already behaved this way. Standalone hosts that create artifact rows without a `files` row must create the file row first.

## 0.7.0 — security

An unauthenticated caller is the principal `anonymous` and owns nothing. A public upload stays readable and listable by anyone. A private one needs a grant made to `anonymous`. That caller cannot replace or delete the upload, and cannot create, list, or revoke share links or grants. Existing share links and grants on anonymous uploads keep working. Signed-in owners can manage grants for their own files over HTTP. Creating a share link requires a signed-in user with `canShare` on the file. To clean up legacy access on files owned by `anonymous`, set `revokedAt` on unwanted `fileShares` rows for those files and delete unwanted `filePermissions` rows for those files. Never return the principal id `anonymous` from `resolveSession`.

The same release also sanitizes storage keys, checks the stored upload size, tightens artifact keys and download headers, and scopes idempotency to the caller. Init validation, roles, rate limits, owner quota, and log hygiene land here, including the same key, init, and size checks in the Python client.

Packages in this release: `@filefn/server` 0.7.0, `@filefn/processing` 0.4.0, `@filefn/processing-container` 0.2.0, `@filefn/client` 0.4.0, `@filefn/admin` 0.1.1, `@superfunctions/storage-local` 0.3.0, and Python `filefn` 0.2.0.

## 0.6.1

- A completion fences itself against an abort or a duplicate complete of the same session.

## 0.6.0

- Import an object that already exists in storage.
- Processing can run in a container.

## 0.5.0

- A client can supply processing artifacts for a version.

## 0.4.2

- A client can choose the file id at init.
- The client migrates a pending upload onto that id.

## 0.4.1

- Storage keys are per upload session.

## 0.4.0

- Processing runs from a queue, including Cloudflare Queues.

## 0.3.1

- Workers type definitions aligned with the Workers runtime.

## 0.3.0

- Mount FileFn on Workers with a base path, deferred work, and cryptographic ids.
- Client transport for that runtime.

## 0.2.1

- Patch release on the 0.2 runtime.

## 0.2.0

- Runtime stores and observability.

## 0.1.1

- Patch release on the initial server.

## 0.1.0

- Initial server: multipart upload, policies, storage adapters, and the first clients.

## See also

- [GitHub releases](https://github.com/21nCo/superfunctions/releases) — full release notes.
