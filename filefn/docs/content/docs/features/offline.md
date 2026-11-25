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
    // Who the client's credentials act for right now (null when signed out).
    currentPrincipal: () => (session.userId ? { kind: "user", principalId: session.userId } : null),
    queue: { hooks: { verify, publish } },
  },
});
```

Offline `uploadFile(...)` stages the file in the queue under `entryId = fileId` and returns a handle whose `done()` resolves once that generation is **published**. Without `partition`, an offline upload throws `FILEFN_OFFLINE_PARTITION_REQUIRED` and nothing is listed or replayed; without `currentPrincipal` it throws `FILEFN_OFFLINE_PRINCIPAL_CHECK_REQUIRED`.

## Partitions

Every queue instance is bound to one partition: a `serviceId` and either a user (`principalId`, optional `tenantId`) or a guest `namespace`. Staging, listing, pending descriptors, replay, cancellation, hooks and cleanup only ever see that partition's entries; each journal also records its binding and is checked on every read. Identifiers that overlap (`a` + `b:c` against `a:b` + `c`, or a user and a guest with the same ID) are distinct partitions.

On logout or an account switch call `client.dispose()` (or `queue.dispose()`), then create a client for the new principal. A disposed instance rejects new calls with `FILEFN_QUEUE_DISPOSED`, aborts its in-flight uploads and hooks, and never writes their late results. The old principal's pending work stays in storage for that principal's next client, including a second tab still signed in as them.

Uploads and hooks use the client's live credentials, which other tabs can change (a shared cookie, for example). So before every upload and every hook the queue calls `currentPrincipal` (`OfflineQueueOptions.currentPrincipal` for a queue you construct) and runs the step only while it returns the partition's principal. Otherwise the entry stays pending, unchanged, with `{ status: "provisional", reason: "principal-mismatch" }`; it continues once the right principal is back.

## Locks and fallback

Every journal write, replay claim and cleanup runs under one exclusive `navigator.locks` lock per partition, shared by all tabs of the origin. An entry is processed under its own lock, taken only if free: a second tab gets `{ status: "busy" }` (an `OfflineSync` tries again later), and when a tab closes the browser releases its locks so another tab resumes from the journal.

Without Web Locks, pass `queue.coordinator`, an object with the shape of `navigator.locks.request(name, { ifAvailable?, signal? }, callback)` that excludes every cooperating tab. With neither, the queue fails closed: `queue.capabilities()` returns `{ durable: false, reason: "locks-unavailable" }`, `stage` returns `{ status: "refused", reason: "locks-unavailable" }`, other calls throw `FILEFN_QUEUE_LOCKS_UNAVAILABLE`, and staged work stays in storage for later. Without OPFS the reason is `storage-unavailable` (`FILEFN_OFFLINE_UNSUPPORTED` from `uploadFile`).

## Entries, generations and holds

```ts
const queue = client.getOfflineQueue();
const current = await queue.get("note-42");
const staged = await queue.stage({ entryId: "note-42", policy: "attachments", file, expectedGeneration: current?.generation ?? 0, hold: true });
// { status: "staged", entry: { generation, operationId, state: "provisional", ... }, holdId }
// or { status: "refused", reason: "generation-conflict" | "publication-pending" | "idempotency-key-reused" | "capacity" | ... }
await queue.release("note-42", staged.entry.generation, staged.holdId);
```

- Each `stage` writes a new, immutable **generation** of the entry, with its own `operationId` and replay key. Generation numbers increase and are never reused within a partition, even after an entry is cancelled or reclaimed, so a stale reference never acts on a replacement. `expectedGeneration` (0 for a new entry) makes it a compare-and-set, so of two tabs staging from the same generation only one advances it. A caller-supplied `idempotencyKey` that an earlier generation of the entry used is refused (`idempotency-key-reused`): the server would replay the earlier session and never receive the new bytes.
- A **hold** belongs to one generation. A held generation is not uploaded further, verified or published. `hold` returns `{ status: "held", holdId }`, or `{ status: "refused", reason: "publication-started" | "final" }` once a hold can no longer stop it. `release(entryId, generation, holdId)` removes only that hold; a hold of an older generation can never release a newer one.
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
- Which hooks a generation needs is recorded when it is staged: those of the staging instance, plus any the processing instance has. An instance without a needed hook stops with `{ status: "provisional", reason: "hook-unavailable" }` and never skips the step. With no hook at all, the server's confirmation of the upload (or, for a replayed completed session, the read-back of the recorded version) is the verification and a verified generation is published at once.
- `reconcile` throws `FILEFN_QUEUE_BUSY` while any tab is processing the entry, so it never races a running publication hook, and rejects an outcome whose `published` is not `true` or `false`.
- `subscribe(listener)` reports `published` once per confirmed publication from the instance that confirmed it. `whenSettled(entryId, generation)` resolves on publication and rejects with `FILEFN_QUEUE_REJECTED`, `FILEFN_QUEUE_FAILED`, `FILEFN_QUEUE_RETRY_LIMIT`, `FILEFN_QUEUE_SUPERSEDED`, `FILEFN_QUEUE_CANCELLED` or `FILEFN_QUEUE_DISPOSED`. It also re-reads the entry every `observeIntervalMs` (default 1000), so it settles when another tab finishes the work.

## Replay identity

Each generation's idempotency key is journaled before the first `upload/init` and sent as the `x-idempotency-key` header. A retry, in any tab or after a reload, uses the same key:

- If the server reports the session `completed`, the client reads the recorded version back (`GET /{fileId}/versions/{versionId}`) and records it without signing any part again. A version that no longer exists (its file was deleted, even if the ID was reused since) is not confirmed: the generation stays provisional.
- If it reports the session `expired` or `aborted`, the queue journals a fresh key, then starts again with it.
- A network error, a lost response or a conflict the server marks retryable (a completion of the same session still running in another tab) leaves the generation provisional with `pending.reason: "ambiguous"`; the next attempt resolves it with the same key. Only a failure no replay can fix (an idempotency conflict, a validation error) is `failed`.
- After `maxUploadAttempts` (default 5) the queue stops trying and records `pending: { stage: "upload", reason: "retry-limit" }`: listeners get a `provisional` event, `whenSettled` rejects with `FILEFN_QUEUE_RETRY_LIMIT`, and a sync reports it to `onSyncError` with `code: "retry-limit"`. The entry keeps its key; `reconcile(entryId, generation)` resets the count.

## Lifecycle and implicit replay

By default offline `uploadFile`, `getPendingLocalDescriptor` and `resolveRenderable({ preferLocal: true })` start a sync of the client's queue. With `offline.implicitReplay: false`, they only stage and read; work advances only through a sync you own:

```ts
const sync = client.createOfflineSync({ retryDelayMs: 2000 });
sync.start();    // sync now and on every "online" event
sync.dispose();  // stop for good and abort the step it is running; staged work stays
```

A sync requested while a pass runs gets a follow-up pass, so newly staged work never waits for the next `online` event. Ambiguous and busy entries are retried after `retryDelayMs`, doubling up to a minute.

## Limits and cleanup

`queue.limits` sets `maxEntries` (default 500) and `maxBytes` (default 1 GiB) per partition. When a stage would exceed them, the queue first reclaims what is safe, then refuses with `{ status: "refused", reason: "capacity", limit: "entries" | "bytes", usage, limits }`. A browser quota error is the same refusal with `limit: "quota"`; nothing is half-written and pending work is kept.

Reclamation (on demand with `queue.reclaim()`, and before a capacity refusal) removes only: entry directories without a committed journal (a first stage interrupted before its journal committed leaves none, or an empty one), data files the journal no longer names, the data of published generations, and published entries older than `terminalRetentionMs` (default 24 hours; any age under capacity pressure). Provisional entries, journals of another binding or a newer layout, and the entry being staged are never reclaimed; `cancel(entryId, generation)` removes one explicitly.

## Crash recovery

| Interrupted at | After reload |
| --- | --- |
| Staging, before the journal write | No entry; the orphaned data (and an empty first journal) is reclaimed, and the entry can be staged again. |
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

The preview comes from the newest provisional generation of that file in the client's partition. Its `versionId` is the generation's `operationId`. Its object URL is revoked once that generation is published or the entry is removed (seen by `list()`, `reclaim()` or `whenSettled`).

## Testing a consumer

The queue takes its storage root, lock coordinator and uploader as options, so a consumer can run it against deterministic adapters through the public API only:

```ts
import { OfflineQueue } from "@filefn/client";

const queue = new OfflineQueue({
  partition: { serviceId: "notes", principal: { kind: "guest", namespace: "guest-test" } },
  currentPrincipal: () => ({ kind: "guest", namespace: "guest-test" }),
  getRoot: async () => inMemoryDirectory,         // the FileSystemDirectoryHandle subset
  coordinator: inMemoryLocks,                       // navigator.locks-shaped
  uploader: { upload: async ({ fileId }) => ({ fileId, versionId: "ver_test" }) },
  hooks: { verify: async () => ({ verified: true }) },
});
```
