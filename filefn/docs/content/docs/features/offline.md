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

Offline `uploadFile(...)` stages the file in the queue under `entryId = fileId` and returns a handle whose `done()` resolves once that generation is **published**. Without `partition`, an offline upload throws `FILEFN_OFFLINE_PARTITION_REQUIRED` and nothing is listed or replayed; without `currentPrincipal` it throws `FILEFN_OFFLINE_PRINCIPAL_CHECK_REQUIRED`. A guest partition also needs `offline.uploader` (`FILEFN_OFFLINE_GUEST_TRANSPORT_REQUIRED`): the server gives anonymous callers no idempotent replay, so the built-in transport could never reconcile a guest upload whose completion response was lost. Your uploader must replay idempotently per `idempotencyKey` (for example by acting for an authenticated guest principal) and call `assertPrincipal()` before each request.

## Partitions

Every queue instance is bound to one partition: a `serviceId` and either a user (`principalId`, optional `tenantId`) or a guest `namespace`. Staging, listing, pending descriptors, replay, cancellation, hooks and cleanup only ever see that partition's entries; each journal also records its binding and is checked on every read. Identifiers that overlap (`a` + `b:c` against `a:b` + `c`, or a user and a guest with the same ID) are distinct partitions.

On logout or an account switch call `client.dispose()` (or `queue.dispose()`), then create a client for the new principal. A disposed instance rejects new calls with `FILEFN_QUEUE_DISPOSED`, aborts its in-flight uploads and hooks, and never writes their late results. The old principal's pending work stays in storage for that principal's next client, including a second tab still signed in as them.

Uploads and hooks use the client's live credentials, which other tabs can change (a shared cookie, for example). So the queue calls `currentPrincipal` (`OfflineQueueOptions.currentPrincipal` for a queue you construct; it must not call the queue):

- before claiming each step, and through `assertPrincipal()` right before every request of an upload, automatic retries included (the built-in transport does this; a custom `uploader` or hook should too). On a switch, nothing more is sent;
- before recording any outcome. An outcome that arrives after a switch, success or failure (such as the 403 a server returns to the new account), is not recorded and uses up no attempt: the entry stays as journaled, with `{ status: "provisional", reason: "principal-mismatch" }`, and continues under the same key once the right principal is back (an `OfflineSync` retries it);
- before every local read or write of the partition. While it returns another principal (or null), `list`, `get`, `getPendingLocalDescriptor`, `hold`, `release`, `cancel`, `reconcile`, `usage`, `reclaim` and `listLegacyUploads` throw `FILEFN_QUEUE_PRINCIPAL_MISMATCH`, and `stage` returns `{ status: "refused", reason: "principal-mismatch" }`; the client's `getPendingLocalDescriptor` and `resolveRenderable` show nothing local. When the principal returns, the same instance works again.

## Locks and fallback

Every journal write, replay claim and cleanup runs under one exclusive `navigator.locks` lock per partition, shared by all tabs of the origin. An entry is processed under its own lock, taken only if free: a second tab gets `{ status: "busy" }` (an `OfflineSync` tries again later), and when a tab closes the browser releases its locks so another tab resumes from the journal.

Without Web Locks, pass `queue.coordinator`, an object with the shape of `navigator.locks.request(name, { ifAvailable?, signal? }, callback)` that excludes every cooperating tab. With neither, the queue fails closed: `queue.capabilities()` returns `{ durable: false, reason: "locks-unavailable" }`, `stage` returns `{ status: "refused", reason: "locks-unavailable" }`, other calls throw `FILEFN_QUEUE_LOCKS_UNAVAILABLE`, and staged work stays in storage for later. Without OPFS the reason is `storage-unavailable`. `client.getOfflineQueue()` still returns the queue in both cases, so you can check `capabilities()`; an offline `uploadFile` then rejects `done()` with `FILEFN_QUEUE_REFUSED` (`details.reason` is the refusal) and no sync starts.

## Entries, generations and holds

```ts
const queue = client.getOfflineQueue();
const current = await queue.get("note-42");
const staged = await queue.stage({ entryId: "note-42", policy: "attachments", file, expectedGeneration: current?.generation ?? 0, hold: true });
// { status: "staged", entry: { generation, operationId, state: "provisional", ... }, holdId }
// or { status: "refused", reason: "generation-conflict" | "publication-pending" | "capacity" | "principal-mismatch" | ... }
await queue.release("note-42", staged.entry.generation, staged.holdId);
```

- Each `stage` writes a new, immutable **generation** of the entry, with its own `operationId` and replay key. Generation numbers increase and are never reused within a partition, even after an entry is cancelled or reclaimed, so a stale reference never acts on a replacement. `expectedGeneration` (0 for a new entry) makes it a compare-and-set, so of two tabs staging from the same generation only one advances it. The replay key is unique to the generation: a caller-supplied `idempotencyKey` (1-200 visible ASCII characters, else `FILEFN_QUEUE_INVALID_INPUT`) is only its prefix, followed by the generation's `operationId`. So no other generation, of this entry or another, before or after a cancel or reclaim, can replay this generation's session; the server matches replays on the key and request metadata, not the bytes.
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
- A publication whose outcome is unknown (a throw, or a reload while it ran) is never retried blindly. With `reconcile` the queue asks first; with `idempotent: true` it runs again with the same `operationId`; otherwise it stops at `needs-reconcile` until you call `queue.reconcile(entryId, generation, { published, result?, attemptId })`. Each move to `publishing` starts a new attempt, shown as the entry's `publicationAttemptId` and passed to hooks as `context.publicationAttemptId`; an outcome must name the current attempt, and one for an earlier attempt (a late readback) is refused with `FILEFN_QUEUE_STALE_ATTEMPT`. `published: false` must mean that attempt can no longer take effect; it reopens publication under a new attempt.
- Which hooks a generation needs is recorded when it is staged (those of the staging instance), and again before a verification or publication starts (the processing instance's). A generation whose verification has started always needs it. An instance without a needed hook stops with `{ status: "provisional", reason: "hook-unavailable" }` and never skips the step. With no hook at all, the server's confirmation of the upload (or, for a replayed completed session, the read-back of the recorded version) is the verification and a verified generation is published at once.
- An entry stays claimed until the upload or hook a pass started settles, even when the pass was aborted or its queue disposed and its result is discarded. Until then another tab or call gets `busy`, and `reconcile` throws `FILEFN_QUEUE_BUSY`, so no reconciliation or rerun overlaps a hook that is still running. It rejects an outcome without a boolean `published` and an `attemptId`.
- `subscribe(listener)` reports `published` once per confirmed publication from the instance that confirmed it; reconciling an already published generation changes nothing and reports nothing. `whenSettled(entryId, generation)` resolves on publication and rejects with `FILEFN_QUEUE_REJECTED`, `FILEFN_QUEUE_FAILED`, `FILEFN_QUEUE_RETRY_LIMIT`, `FILEFN_QUEUE_SUPERSEDED`, `FILEFN_QUEUE_CANCELLED` or `FILEFN_QUEUE_DISPOSED`. It also re-reads the entry every `observeIntervalMs` (default 1000), so it settles when another tab finishes the work.

## Replay identity

Each generation's idempotency key is journaled before the first `upload/init` and sent as the `x-idempotency-key` header. A retry, in any tab or after a reload, uses the same key:

- If the server reports the session `completed`, the client reads the recorded version back (`GET /{fileId}/versions/{versionId}`) and records it without signing any part again. A version that no longer exists (its file was deleted, even if the ID was reused since) is not confirmed: the generation stays provisional.
- A completed session that did not record its own version (completed by a server before 0.8) is not confirmed either: the file's current version may come from a later upload. The generation stays provisional.
- If the session is confirmed `expired` or `aborted`, at `upload/init` or by a 410 `FILEFN_UPLOAD_EXPIRED` or `FILEFN_UPLOAD_ABORTED` from part signing, a part upload, part completion or completion, the queue journals a fresh key, then starts again with it.
- A network error, a lost response, a 5xx, a conflict the server marks retryable or that a replay settles (a completion still running in another tab, a session already completed, a session not found), and the statuses 401, 403, 408, 423, 425 and 429 leave the generation provisional with `pending.reason: "ambiguous"`; the next attempt resolves it with the same key. FileFn error codes from the proxy part route are kept for this. A success that names no `versionId` is ambiguous too. Only a failure no replay can fix (an idempotency conflict, a validation error or another 4xx) is `failed`. A lasting authorization refusal therefore ends at the retry limit, not `failed`.
- After `maxUploadAttempts` (default 5) failed or ambiguous upload attempts (an attempt cut short by disposal, an abort or a principal switch does not count) the queue stops trying and records `pending: { stage: "upload", reason: "retry-limit" }`: listeners get a `provisional` event, `whenSettled` rejects with `FILEFN_QUEUE_RETRY_LIMIT`, and a sync reports it to `onSyncError` with `code: "retry-limit"`. The entry keeps its key; `reconcile(entryId, generation)` resets the count.

## Lifecycle and implicit replay

By default offline `uploadFile`, `getPendingLocalDescriptor` and `resolveRenderable({ preferLocal: true })` start a sync of the client's queue. With `offline.implicitReplay: false`, they only stage and read; work advances only through a sync you own:

```ts
const sync = client.createOfflineSync({ retryDelayMs: 2000 });
sync.start();    // sync now and on every "online" event
sync.dispose();  // stop for good and abort the step it is running; staged work stays
```

A sync requested while a pass runs gets a follow-up pass, so newly staged work never waits for the next `online` event; so does a pass in which a generation was superseded, so the newer generation is driven even if the tab that staged it has closed. Ambiguous, busy and principal-mismatch entries (and a pass refused for a principal mismatch) are retried after `retryDelayMs`, doubling up to a minute. Once a sync is disposed, its pass journals nothing more: no claim, attempt, default verification or publication, or cleanup, and no new upload or hook starts.

## Limits and cleanup

`queue.limits` sets `maxEntries` (default 500) and `maxBytes` (default 1 GiB) per partition. Replacing a generation credits only the bytes of its data file still present. When a stage would exceed them, the queue first reclaims what is safe, then refuses with `{ status: "refused", reason: "capacity", limit: "entries" | "bytes", usage, limits }`. A browser quota error is the same refusal with `limit: "quota"`; nothing is half-written and pending work is kept.

Reclamation (on demand with `queue.reclaim()`, and before a capacity refusal) removes only: entry directories without a committed journal (a first stage interrupted before its journal committed leaves none, or an empty one), data files the journal no longer names, the data of published generations, and published entries older than `terminalRetentionMs` (default 24 hours; any age under capacity pressure). A removed published generation leaves a small tombstone (the last 64, within the retention), so a `whenSettled` waiter in another tab still resolves as published rather than cancelled. Provisional entries, journals of another binding or a newer layout, and the entry being staged are never reclaimed; `cancel(entryId, generation)` removes one explicitly.

## Crash recovery

| Interrupted at | After reload |
| --- | --- |
| Staging, before the journal write | No entry; the orphaned data (and an empty first journal) is reclaimed, and the entry can be staged again. |
| Upload | `phase: "uploading"`; replayed with the recorded key. |
| Verification | `phase: "verifying"`; verified again. |
| Publication | `phase: "publishing"`; reconciled as above, never blindly repeated. A pass stopped before its hook ran withdraws the claim (`phase: "verified"`). |
| Cleanup after publication | `state: "published"`; the next pass removes the data. |

## Pre-0.5 uploads

Uploads staged by 0.4 and earlier (in `offline.opfsDir`, default `filefn-pending-uploads`) have no owner. They are never listed or replayed automatically. `queue.listLegacyUploads()` shows them, and `queue.migrateLegacyUpload(uploadSessionId, { ownershipVerified: true })` moves one into the current partition as a new entry (refused with `generation-conflict` if an entry with that ID exists; pass `entryId` to choose another); call it only when you have your own evidence that the upload belongs to this principal. A legacy upload is admitted once per partition, whatever `entryId` and however many tabs migrate it: a repeat returns the entry it became, or `{ status: "refused", reason: "already-migrated" }` once that entry is gone. It keeps its own replay key, so a session it already completed is reconciled rather than uploaded again.

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
  uploader: { upload: async ({ fileId, assertPrincipal }) => (await assertPrincipal(), { fileId, versionId: "ver_test" }) },
  hooks: { verify: async () => ({ verified: true }) },
});
```
