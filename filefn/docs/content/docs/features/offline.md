---
title: Offline
description: A durable, principal-scoped OPFS queue with holds, verification, publication and idempotent replay.
---

# Offline

See [Core Concepts › Offline](../core-concepts/offline) for the overview. This page is the contract of `@filefn/client` 0.5 and later.

## Enabling

```ts
import { createFileFnClient } from "@filefn/client";

const client = createFileFnClient({
  baseUrl: "/filefn",
  getAuthHeaders,
  offline: {
    enabled: true,
    // Trusted identifiers from your session, never from user input.
    partition: { serviceId: "notes", principal: { kind: "user", principalId: session.userId } },
    // Or a guest: { kind: "guest", namespace: guestNamespaceId }
    queue: { hooks: { verify, publish } },
  },
});
```

Offline `uploadFile(...)` stages the file in the queue under `entryId = fileId` and returns a handle whose `done()` resolves once that generation is **published**. Without `partition`, an offline upload throws `FILEFN_OFFLINE_PARTITION_REQUIRED` and nothing is listed or replayed.

## Partitions

Every queue instance is bound to one partition: a `serviceId` and either a user (`principalId`, optional `tenantId`) or a guest `namespace`. Staging, listing, pending descriptors, replay, cancellation, hooks and cleanup only ever see that partition's entries; each journal also records its binding and is checked on every read. Identifiers that overlap (`a` + `b:c` against `a:b` + `c`, or a user and a guest with the same ID) are distinct partitions.

On logout or an account switch call `client.dispose()` (or `queue.dispose()`), then create a client for the new principal. A disposed instance rejects new calls with `FILEFN_QUEUE_DISPOSED`, aborts its in-flight uploads and hooks, and never writes their late results. The old principal's pending work stays in storage for that principal's next client, including a second tab still signed in as them.

## Locks and fallback

Every journal write, replay claim and cleanup runs under one exclusive `navigator.locks` lock per partition, shared by all tabs of the origin. An entry is processed under its own lock, taken only if free: a second tab gets `{ status: "busy" }`, and when a tab closes the browser releases its locks so another tab resumes from the journal.

Without Web Locks, pass `queue.coordinator`, an object with the shape of `navigator.locks.request(name, { ifAvailable?, signal? }, callback)` that excludes every cooperating tab. With neither, the queue fails closed: `queue.capabilities()` returns `{ durable: false, reason: "locks-unavailable" }`, `stage` returns `{ status: "refused", reason: "locks-unavailable" }`, other calls throw `FILEFN_QUEUE_LOCKS_UNAVAILABLE`, and staged work stays in storage for later. Without OPFS the reason is `storage-unavailable` (`FILEFN_OFFLINE_UNSUPPORTED` from `uploadFile`).

## Entries, generations and holds

```ts
const queue = client.getOfflineQueue();
const staged = await queue.stage({ entryId: "note-42", policy: "attachments", file, expectedGeneration: 1, hold: true });
// { status: "staged", entry: { generation: 2, operationId, state: "provisional", ... }, holdId }
// or { status: "refused", reason: "generation-conflict" | "publication-pending" | "capacity" | ... }
await queue.release("note-42", 2, staged.holdId);
```

- Each `stage` writes a new, immutable **generation** of the entry, with its own `operationId` and replay key. `expectedGeneration` (0 for a new entry) makes it a compare-and-set, so of two tabs staging from the same generation only one advances it.
- A **hold** belongs to one generation. A held generation is not uploaded further, verified or published. `release(entryId, generation, holdId)` removes only that hold; a hold of an older generation can never release a newer one.
- A newer generation supersedes an older one: the older one's late upload, verification or publication result is discarded (`{ status: "superseded" }`) and never touches the newer one. Staging is refused (`publication-pending`) while the current generation has an unconfirmed publication.

## Verification and publication

`process(entryId)` (or an `OfflineSync`) moves a generation through `staged → uploading → uploaded → verifying → verified → publishing → published`. Each step is journaled before its request or hook runs.

```ts
const hooks = {
  // Return { verified: false, reason } to reject; a throw is retried later.
  verify: async ({ fileId, versionId, operationId }) => ({ verified: await myBackend.check(fileId, versionId) }),
  publish: {
    run: async ({ operationId, fileId, versionId }) => ({ result: await myBackend.link(operationId, fileId, versionId) }),
    // Either declare run idempotent per operationId, or say whether an earlier run took effect.
    reconcile: async ({ operationId }) => (await myBackend.linked(operationId)) ? { published: true } : { published: false },
  },
};
```

- `state` is `provisional` until publication of that generation is confirmed, then `published`. A rejected verification (`phase: "rejected"`), a failed upload (`phase: "failed"`) and any ambiguous outcome (`pending: { stage, reason: "ambiguous" }`) stay provisional across reloads, in `list()` and in `whenSettled`.
- A publication whose outcome is unknown (a throw, or a reload while it ran) is never retried blindly. With `reconcile` the queue asks first; with `idempotent: true` it runs again with the same `operationId`; otherwise it stops at `needs-reconcile` until you call `queue.reconcile(entryId, generation, { published: true, result } | { published: false })`.
- Without a `verify` hook the server's confirmation of the upload (or, for a replayed completed session, the read-back of the stored file) is the verification; without `publish` a verified generation is published at once.
- `subscribe(listener)` reports `published` once per confirmed publication from the instance that confirmed it. `whenSettled(entryId, generation)` resolves on publication and rejects with `FILEFN_QUEUE_REJECTED`, `FILEFN_QUEUE_FAILED`, `FILEFN_QUEUE_SUPERSEDED`, `FILEFN_QUEUE_CANCELLED` or `FILEFN_QUEUE_DISPOSED`.

## Replay identity

Each generation's idempotency key is journaled before the first `upload/init` and sent as the `x-idempotency-key` header. A retry, in any tab or after a reload, uses the same key:

- If the server reports the session `completed`, the client reads the stored file back and records its `fileId` and `versionId` without signing any part again.
- If it reports the session `expired` or `aborted`, the queue journals a fresh key, then starts again with it.
- A network error or lost response leaves the generation provisional with `pending.reason: "ambiguous"`; the next attempt resolves it with the same key. After `maxUploadAttempts` (default 5) the queue stops trying until `reconcile(entryId, generation)` resets the count.

## Lifecycle and implicit replay

By default offline `uploadFile`, `getPendingLocalDescriptor` and `resolveRenderable({ preferLocal: true })` start a sync of the client's queue. With `offline.implicitReplay: false`, they only stage and read; work advances only through a sync you own:

```ts
const sync = client.createOfflineSync({ retryDelayMs: 2000 });
sync.start();    // sync now and on every "online" event
sync.dispose();  // stop for good; staged work stays
```

## Limits and cleanup

`queue.limits` sets `maxEntries` (default 500) and `maxBytes` (default 1 GiB) per partition. When a stage would exceed them, the queue first reclaims what is safe, then refuses with `{ status: "refused", reason: "capacity", limit: "entries" | "bytes", usage, limits }`. A browser quota error is the same refusal with `limit: "quota"`; nothing is half-written and pending work is kept.

Reclamation (on demand with `queue.reclaim()`, and before a capacity refusal) removes only: entry directories without a journal (a stage interrupted before it committed), data files the journal no longer names, the data of published generations, and published entries older than `terminalRetentionMs` (default 24 hours; any age under capacity pressure). Provisional entries are never reclaimed; `cancel(entryId, generation)` removes one explicitly.

## Crash recovery

| Interrupted at | After reload |
| --- | --- |
| Staging, before the journal write | No entry; the orphaned data is reclaimed. |
| Upload | `phase: "uploading"`; replayed with the recorded key. |
| Verification | `phase: "verifying"`; verified again. |
| Publication | `phase: "publishing"`; reconciled as above, never blindly repeated. |
| Cleanup after publication | `state: "published"`; the next pass removes the data. |

## Pre-0.5 uploads

Uploads staged by 0.4 and earlier (in `offline.opfsDir`, default `filefn-pending-uploads`) have no owner. They are never listed or replayed automatically. `queue.listLegacyUploads()` shows them, and `queue.migrateLegacyUpload(uploadSessionId, { ownershipVerified: true })` moves one into the current partition as a new entry (refused with `generation-conflict` if an entry with that ID exists; pass `entryId` to choose another); call it only when you have your own evidence that the upload belongs to this principal.

## Pending-local previews

```ts
const renderable = await client.resolveRenderable({ fileId, intent: "preview", preferLocal: true });
if (renderable.state === "pending-local") imgElement.src = (renderable.source as { url: string }).url;
```

The preview comes from the newest provisional generation of that file in the client's partition. Its `versionId` is the generation's `operationId`.

## Testing a consumer

The queue takes its storage root, lock coordinator and uploader as options, so a consumer can run it against deterministic adapters through the public API only:

```ts
import { OfflineQueue } from "@filefn/client";

const queue = new OfflineQueue({
  partition: { serviceId: "notes", principal: { kind: "guest", namespace: "guest-test" } },
  getRoot: async () => inMemoryDirectory,         // the FileSystemDirectoryHandle subset
  coordinator: inMemoryLocks,                       // navigator.locks-shaped
  uploader: { upload: async ({ fileId }) => ({ fileId, versionId: "ver_test" }) },
  hooks: { verify: async () => ({ verified: true }) },
});
```
