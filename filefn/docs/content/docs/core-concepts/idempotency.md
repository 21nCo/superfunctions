---
title: Idempotency
description: How filefn deduplicates upload-init calls and prevents accidental duplicate sessions.
---

# Idempotency

`POST /upload/init` is the only filefn endpoint where retries can produce wrong results — if a network blip causes the same init to run twice, you'd end up with two sessions, two `fileId`s, and two storage objects for the same logical upload.

filefn solves this with `x-idempotency-key`.

## How it works

Pass the header on `init`:

```http
POST /filefn/upload/init
x-idempotency-key: f9f1e51a-9a76-4c0a-9f96-3a5e1cdd2a8b
```

The server:

1. Computes a stable hash of the canonical request payload (`policy + fileName + size + mimeType + metadata`, sorted keys).
2. Looks up `uploadSessions` by `(idempotencyKey, ownerId, tenantId)`.
3. If a row exists with the **same** payload hash → return the existing session.
4. If a row exists with a **different** payload hash → fail with `FILEFN_IDEMPOTENCY_CONFLICT`.
5. Otherwise → create a new session and store the key + hash.

A replayed session also reports its `status`. A `completed` one carries the stored `fileId` and `versionId`, and `versionConfirmed: true` while that version is still stored under its file, so the client confirms the file instead of uploading again, without needing read permission on it; `expired` (past its TTL) and `aborted` are final, and the client starts again under a new key.

An `in_progress` replay whose completion was already decided adds `completionStarted: true` (so does the session status): send no part, finish it with the completion call.

An offline replay (`@filefn/client`'s queue) also sends `x-filefn-replay-scope`: `unpinned` on its first `upload/init`, then the `replayScope` that init returned (an opaque fingerprint of the caller's owner and tenant). A marked init without an authenticated caller is refused with 401, also where auth is optional, and one whose caller has another owner or tenant than the pinned scope with 409 `FILEFN_REPLAY_SCOPE_MISMATCH`; neither creates anything. Unmarked requests are unchanged.

Servers before 0.8 read the key only from the header. 0.8 also honors an `idempotencyKey` in the JSON body (what `@filefn/client` 0.4 and earlier sent) for one minor version, with a deprecation warning; a request giving both must give the same value.

Unauthenticated (anonymous) callers get no idempotency: they all share one scope, and only the caller that created a session holds its `uploadSessionToken`, so a retry always creates a fresh session with its own token. The abandoned session expires on its own.

## What's in the payload hash

```ts
{
  policy: string,
  fileName: string,
  size: number,
  mimeType: string,
  metadata: Record<string, JSONValue> | undefined,
}
```

`metadata` keys are sorted before hashing. `metadata: undefined` and `metadata: {}` hash identically.

## Why this matters

- **Accidental double-clicks** — a user double-clicks the upload button. Both requests hit `/upload/init`. Without idempotency, you get two sessions. With it, both clients converge on the same session.
- **Mobile network blips** — the client sent the request, the server processed it, the response was lost. The client retries with the same key. The server returns the cached session.
- **OPFS-staged offline retries** — the offline pipeline retries with a stable key for the staged upload.

## When *not* to set the key

If you legitimately want two distinct uploads of the same content (e.g. backing up the same file twice), don't reuse the key. The default behaviour is to mint a fresh session per init request when no key is sent.

## Bundled clients

`@filefn/client`, the Python client, and the Swift client all generate stable idempotency keys per `uploadFile(...)` call automatically. You can override:

```ts
// Persist both before the first attempt, and pass the same pair on every retry.
const fileId = saved.fileId ?? generateFileId();
const idempotencyKey = saved.idempotencyKey ?? `upload-${fileId}`;
client.uploadFile({ policy: "public-image", file, fileId, idempotencyKey });
```

Useful when your app has its own retry logic and wants to stitch retries to a particular logical upload. The server matches a replay on the key *and* the request, file ID included: a retry without `fileId` gets a newly generated one and is refused with `FILEFN_IDEMPOTENCY_CONFLICT`. A key is 1-255 visible ASCII characters (it travels in the `x-idempotency-key` header); anything else throws `FILEFN_INVALID_IDEMPOTENCY_KEY` before a request is sent.

Offline, your key becomes the prefix of each staged generation's own key (`<key>:<operation id>`), so a later generation, or a re-staging after a cancel, never replays an earlier generation's session.

## Idempotency vs. dedup

These are different.

- **Idempotency** prevents accidental duplicate *sessions*. It runs at the protocol layer.
- **Dedup** (when `dedup.enabled`) prevents accidental duplicate *storage objects*. It runs at the file-version layer, scoped per policy / tenant. See [Dedup](./dedup).

You generally want both turned on.
