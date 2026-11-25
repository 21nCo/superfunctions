---
title: Changelog
description: Notable filefn releases and migration notes.
---

# Changelog

filefn follows semver. The `@filefn/server` version is the spine of these notes. Breaking changes are flagged.

## Unreleased

- Upload init and complete that cannot verify a stored size return `500 FILEFN_STORAGE_STAT_UNAVAILABLE` with the message `Upload size cannot be verified`. A complete whose proxy parts are missing returns `409 FILEFN_UPLOAD_INCOMPLETE` with the message `Upload incomplete`. Neither response names the storage adapter or the upload session.
- A metric sink passed directly in the `observability` configuration receives upload failures (`filefn.upload` / `failure`, with `labels.reason` of `size_unverified`, `parts_missing`, or `size_mismatch`), quota denials (`filefn.quota` / `denied`), and processing duration (`filefn.processing` / `complete`, with `durationMs`). Those labels are a closed set: no file id, session id, error text, or usage figure.

## 0.7.0 — security

An unauthenticated caller is the principal `anonymous` and owns nothing. A public upload stays readable and listable by anyone. A private one needs a grant made to `anonymous`. That caller cannot replace or delete the upload, and cannot create, list, or revoke share links or grants. Existing share links and grants on anonymous uploads keep working. Grants can no longer be listed or revoked over HTTP; only an owner manages grants. A share link can be created only by a signed-in user who holds `canShare` on the file. Where no such user exists, review the rows in the database: set `revokedAt` on `fileShares`, and delete the `filePermissions` rows you do not want whose file is owned by `anonymous`. Never return the principal id `anonymous` from `resolveSession`.

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
