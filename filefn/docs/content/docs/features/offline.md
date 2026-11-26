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
    // Who the client's credentials act for right now (null when signed out),
    // from local state: it is called offline too, so no network request.
    currentPrincipal: () => (session.userId ? { kind: "user", principalId: session.userId } : null),
    // Headers that act for exactly `principal` (null when there are none).
    getAuthHeaders: (principal) => headersIssuedFor(principal),
    queue: { hooks: { verify, publish } },
  },
});
```

Offline `uploadFile(...)` stages the file in the queue under `entryId = fileId` and returns a handle whose `done()` resolves once that generation is **published**. Without `partition`, an offline upload throws `FILEFN_OFFLINE_PARTITION_REQUIRED` and nothing is listed or replayed; without `currentPrincipal` it throws `FILEFN_OFFLINE_PRINCIPAL_CHECK_REQUIRED`; a user partition replayed by the built-in transport without `offline.getAuthHeaders` throws `FILEFN_OFFLINE_CREDENTIALS_REQUIRED`. `currentPrincipal` is called before every local read and staging, also offline: it must answer from local state (a session store or cookie your app keeps current, across tabs), never from a network request, or offline staging is refused as a principal mismatch. A guest partition also needs `offline.uploader` (`FILEFN_OFFLINE_GUEST_TRANSPORT_REQUIRED`): the server gives anonymous callers no idempotent replay, so the built-in transport could never reconcile a guest upload whose completion response was lost. Your uploader must replay idempotently per `idempotencyKey` (for example by acting for an authenticated guest principal) and call `assertPrincipal()` before each request.

## Partitions

Every queue instance is bound to one partition: a `serviceId` and either a user (`principalId`, optional `tenantId`) or a guest `namespace`. Staging, listing, pending descriptors, replay, cancellation, hooks and cleanup only ever see that partition's entries; each journal also records its binding and is checked on every read. Identifiers that overlap (`a` + `b:c` against `a:b` + `c`, or a user and a guest with the same ID) are distinct partitions.

On logout or an account switch call `client.dispose()` (or `queue.dispose()`), then create a client for the new principal. A disposed instance rejects new calls with `FILEFN_QUEUE_DISPOSED`, aborts its in-flight uploads and hooks, and never writes their late results. The old principal's pending work stays in storage for that principal's next client, including a second tab still signed in as them.

Uploads and hooks use the client's live credentials, which other tabs can change (a shared cookie, for example). So the queue calls `currentPrincipal` (`OfflineQueueOptions.currentPrincipal` for a queue you construct; it must not call the queue):

- before a pass reads the entry, after the read and before anything it read is returned, reported to a listener or used to settle a waiter, right before every journal, meta or data file it commits and every file it removes, and again right before it starts a verification or publication hook (after the claim is journaled). The `assertPrincipal()` a hook receives also rejects (AbortError) once its step is stopped. Through `assertPrincipal()` it also runs right before every request of an upload, automatic retries and parts included (the built-in transport does this; a custom `uploader` or hook should too). On a switch, nothing more is written, started or sent;
- before recording any outcome. An outcome that arrives after a switch, success or failure (such as the 403 a server returns to the new account), is not recorded and uses up no attempt. `process` then returns `{ status: "stopped", reason: "principal-mismatch" }`, with no entry data, and the entry continues under the same key once the right principal is back (an `OfflineSync` retries it). A pass whose `signal` aborted returns `{ status: "stopped", reason: "aborted" }` the same way;
- before every local read or write of the partition, and again before a read is returned. `processAll` stops at the first mismatch, of its listing or of any entry, and throws `FILEFN_QUEUE_PRINCIPAL_MISMATCH` without returning the results of the entries before it. While it returns another principal (or null), `list`, `get`, `getPendingLocalDescriptor`, `hold`, `release`, `cancel`, `reconcile`, `usage`, `reclaim`, `listLegacyUploads` and `migrateLegacyUpload` throw `FILEFN_QUEUE_PRINCIPAL_MISMATCH` (a switch during the read included), and `stage` returns `{ status: "refused", reason: "principal-mismatch" }`. A check also follows the last storage step of `stage` and `cancel` (the old data's or the entry's removal): a switch during it returns no snapshot and settles no waiter, while what was already committed stays for its principal (a generation staged that way is listed when that principal is back). The client's `getPendingLocalDescriptor` and `resolveRenderable` show nothing local. Every result that carries entry data also passes a principal check after the last callback its call ran (a listener, an `onWork` listener, a waiter): when one of them switched the account, `process` returns `{ status: "stopped", reason: "principal-mismatch" }`, `reconcile` throws `FILEFN_QUEUE_PRINCIPAL_MISMATCH` and `stage` returns `{ status: "refused", reason: "principal-mismatch" }`, while the committed outcome stays in the journal for its principal. When the principal returns, the same instance works again.

The built-in transport sends only the headers `offline.getAuthHeaders(principal)` returns for the partition's own principal (required; null leaves the replay provisional), resolved between two `currentPrincipal` checks for every request, retry and part, and checks once more right before sending. The client's `getAuthHeaders` is never used for replays: it acts for whoever is signed in now, so an account that switched away and back while it ran could lend another account's headers. The queue's partition (a frozen copy: `queue.partition` and the partition passed to hooks cannot be changed) and the transport (`baseUrl`, `fetch`, retry options) are captured when the client makes its queue; later changes to the client's config never redirect queued work. Replays never send ambient credentials (`credentials: "omit"`, whatever the client's `credentials`): a cookie is the browser's, not the partition's, and another tab can switch it after the last check. `getAuthHeaders(principal)` must therefore authenticate the request on its own, with a bearer or session token your server issued for that principal; a cookie-session app issues such a token or supplies `offline.uploader`.

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
- A **hold** belongs to one generation. A held generation is not uploaded further, verified or published. An upload already running (in any tab) checks for holds under the partition lock before each request (in `assertPrincipal`): once a hold is taken it sends no further request and stops as `held` without using an attempt, and resumes under the same key once released. A request it admitted before the hold committed still completes (at most one per running upload); its result is journaled, but the generation is still not verified or published while held. A verification already running finishes, but nothing is published while the hold lasts. `hold` returns `{ status: "held", holdId }`, or `{ status: "refused", reason: "publication-started" | "final" }` once a hold can no longer stop it. `release(entryId, generation, holdId)` removes only that hold; a hold of an older generation can never release a newer one.
- A newer generation supersedes an older one: the older one's late upload, verification or publication result is discarded (`{ status: "superseded" }`) and never touches the newer one. Staging is refused (`publication-pending`) while the current generation has an unconfirmed publication.

## Verification and publication

`process(entryId)` (or an `OfflineSync`) moves a generation through `staged → uploading → uploaded → verifying → verified → publishing → published`. Each step is journaled before its request or hook runs.

```ts
const hooks = {
  // Return { verified: false, reason } to reject; a throw is retried later.
  verify: async ({ fileId, versionId, operationId }) => ({ verified: await myBackend.check(fileId, versionId) }),
  publish: {
    // Resolve with nothing or { result } (JSON); any other value confirms nothing.
    run: async ({ operationId, fileId, versionId }) => ({ result: await myBackend.link(operationId, fileId, versionId) }),
    // Either declare run idempotent per operationId, or say whether an earlier run took effect.
    reconcile: async ({ operationId }) => (await myBackend.linked(operationId)) ? { published: true } : { published: false },
  },
};
```

- A verifier decides only with a plain `{ verified: true }` or `{ verified: false, reason? }` (a string reason). Any other value (an extra key such as `{ verified: true, ok: false }`, a class instance, a non-string reason) decides nothing: the generation stays provisional at `verifying` and is verified again.
- `state` is `provisional` until publication of that generation is confirmed, then `published`. A rejected verification (`phase: "rejected"`), a failed upload (`phase: "failed"`) and any ambiguous outcome (`pending: { stage, reason: "ambiguous" }`) stay provisional across reloads, in `list()` and in `whenSettled`.
- A publication whose outcome is unknown (a throw, or a reload while it ran) is never retried blindly. With `reconcile` the queue asks first; with `idempotent: true` it runs again with the same `operationId`; otherwise it stops at `needs-reconcile` until you call `queue.reconcile(entryId, generation, { published, result?, attemptId })`. Each move to `publishing`, and each idempotent rerun, starts a new attempt (the `operationId` stays the same), shown as the entry's `publicationAttemptId` and passed to hooks as `context.publicationAttemptId`; an outcome must name the current attempt, and one for an earlier attempt (a late readback) is refused with `FILEFN_QUEUE_STALE_ATTEMPT`. `published: false` must mean that attempt can no longer take effect; it reopens publication under a new attempt.
- Which hooks a generation needs is recorded when it is staged (those of the staging instance), and every journal write an instance makes while the generation is not final adds that instance's own hooks in the same write (a processing step, `queue.reconcile` reopening a publication, a hold or release, cleanup), so an instance that started verifying with both hooks leaves publication required for every later instance. A generation whose verification has started always needs it, and one verified without a hook (none was required then) is verified by the hook before any further publication attempt once a verifier is required: from `verified` it is verified first; from an unconfirmed publication (`publishing`) a `reconcile` hook settles the earlier attempt first (`published: false` reopens it at `verified`, where the verifier runs), and an idempotent `run` is not repeated: it stops at `needs-reconcile` until you reconcile the earlier attempt. The requirement is journaled as soon as an instance adopts it, so it survives a reopened publication and a reload: an instance with a verifier that only calls `queue.reconcile(..., { published: false })` leaves the verifier required for a publisher-only instance. An instance without a needed hook stops with `{ status: "provisional", reason: "hook-unavailable" }` and never skips the step. With no hook at all, the server's confirmation of the upload (or, for a replayed completed session, the read-back of the recorded version) is the verification and a verified generation is published at once.
- An entry stays claimed until the upload or hook a pass started settles, even when the pass was aborted or its queue disposed and its result is discarded. Until then another tab or call gets `busy`, and `reconcile` throws `FILEFN_QUEUE_BUSY`, so no reconciliation or rerun overlaps a hook that is still running. It rejects an outcome without a boolean `published` and an `attemptId`, or with a `result` that is not JSON. A `publish.run` that resolves with anything but nothing or a plain object (own, enumerable data properties with string keys, no accessors; not a `Date`, `Map`, array or class instance) whose only keys are `result` (exact JSON) and, optionally, `published: true` confirms nothing (`{ published: false }`, `{ ok: false, result: null }` or any other key included): the publication stays unconfirmed (`ambiguous`), like a throw, and a `reconcile` hook's check that is not such a plain object of exactly `{ published: true, result? }` or `{ published: false }`, or whose `published: true` comes with such a result, is treated the same way; `queue.reconcile` refuses an outcome that is not a plain object of `published`, `attemptId` and (only when published) `result`. Nothing is cleaned up for an unconfirmed publication. Exact JSON is what a JSON round trip keeps unchanged: null, booleans, strings, finite numbers, dense arrays and plain objects of these. False, null, a primitive, a BigInt, NaN, Infinity or -0, a function, symbol or undefined member, a symbol key, a `toJSON` method, a sparse array or a class instance such as a `Date` is not; `queue.reconcile` refuses such a `result` with `FILEFN_QUEUE_INVALID_INPUT`.
- `subscribe(listener)` reports `published` once per confirmed publication from the instance that confirmed it; reconciling an already published generation changes nothing and reports nothing. `whenSettled(entryId, generation)` resolves on publication and rejects with `FILEFN_QUEUE_REJECTED`, `FILEFN_QUEUE_FAILED`, `FILEFN_QUEUE_RETRY_LIMIT`, `FILEFN_QUEUE_SUPERSEDED`, `FILEFN_QUEUE_CANCELLED` or `FILEFN_QUEUE_DISPOSED`; a waiter of a generation that was published and then replaced or cancelled resolves as published. It also re-reads the entry every `observeIntervalMs` (default 1000), so it settles when another tab finishes the work.

## Replay identity

Each generation's idempotency key is journaled before the first `upload/init` and sent as the `x-idempotency-key` header. A retry, in any tab or after a reload, uses the same key:

- If the server reports the session `completed`, the client records the recorded version without signing any part again. A server 0.8 or later checks, for the session's owner, that the version is still stored under its file and says so with `versionConfirmed: true`; the client settles on that without reading the file, so an uploader with write but no read permission (an inbox or quarantine policy) is not left ambiguous. Without the flag (an older server) the client reads the version back (`GET /{fileId}/versions/{versionId}`). A version that no longer exists (its file was deleted, even if the ID was reused since) is never confirmed either way: the generation stays provisional. A hold, a principal switch or a disposal that stops the read-back is not an attempt: a held generation returns `held` and, once released, the read-back runs under the same key.
- A completed session that did not record its own version (completed by a server before 0.8) is not confirmed either: the file's current version may come from a later upload. The generation stays provisional.
- If the replayed `upload/init` reports the session `expired` or `aborted`, the queue journals a fresh key, then starts again with it. The server reports a session whose completion is still running (a live completion claim, or a decided publication) as in progress, never expired. A session past its expiry whose completion crashed (its claim is stale) is ended like any unfinished one, by `upload/init` or by a completion call (which records the end before its 410), so a replay always reaches a durable answer instead of looping on the same key. The server reports `expired` only after moving the session to `expired` with a conditional write, which no completion claim can follow, so only a session that can no longer publish gets a new key. An expired session an earlier FileFn left partly published is finished as a publication instead.
- A 410 `FILEFN_UPLOAD_EXPIRED` or `FILEFN_UPLOAD_ABORTED` from part signing, a part upload, part completion or completion does not end the session on its own: another request may have completed it, or a live completion may still publish it. The generation stays `ambiguous` under the same key, and the next attempt's `upload/init` settles it (reconciled when completed, a fresh key when ended).
- A replay-reported end is final on the server too: a session recorded as `expired` takes no part signing, part upload, part completion or completion claim on any worker, whatever that worker's clock says, so the old key can never publish after the client moved on.
- A network error, a lost response, a 5xx, a conflict the server marks retryable or that a replay settles (a completion still running in another tab, a session already completed, a session not found), and the statuses 401, 403, 408, 423, 425 and 429 leave the generation provisional with `pending.reason: "ambiguous"`; the next attempt resolves it with the same key. FileFn error codes from the proxy part route are kept for this. A success without a well-formed `fileId` (the server grammar `file_[A-Za-z0-9_-]{8,64}`) and `versionId` (1-256 letters, digits, `_` or `-`, so no `/`, `.` or whitespace) is ambiguous too; a well-formed `fileId` other than the requested one is `failed`. A 4xx without a FileFn error code (a signed storage URL's 404 after FileFn completed or swept the session, a proxy's refusal) says nothing about the FileFn session and is ambiguous too. Only a failure no replay can fix (FileFn's own 4xx refusal with its error code, such as an idempotency conflict or a validation error) is `failed`. A lasting authorization refusal therefore ends at the retry limit, not `failed`.
- After `maxUploadAttempts` (default 5) failed or ambiguous upload attempts (an attempt cut short by disposal, an abort or a principal switch does not count) the queue stops trying and records `pending: { stage: "upload", reason: "retry-limit" }`: listeners get a `provisional` event, `whenSettled` rejects with `FILEFN_QUEUE_RETRY_LIMIT`, and a sync reports it to `onSyncError` with `code: "retry-limit"`. The entry keeps its key; `reconcile(entryId, generation)` resets the count.

## Lifecycle and implicit replay

By default offline `uploadFile`, `getPendingLocalDescriptor` and `resolveRenderable({ preferLocal: true })` start a sync of the client's queue. With `offline.implicitReplay: false`, they only stage and read; work advances only through a sync you own:

```ts
const sync = client.createOfflineSync({ retryDelayMs: 2000 });
sync.start();    // sync now and on every "online" event
sync.dispose();  // stop for good and abort the step it is running; staged work stays
```

Disposing the queue disposes every `OfflineSync` driving it at once (`queue.onDispose`): its `online` listener, idle poll and retry timers go without waiting for another event. `start()` on a sync whose queue is disposed throws and registers nothing, and a start that fails part-way leaves nothing registered. A started sync also runs a pass as soon as work becomes runnable (`queue.onWork`): its queue, or a queue of the same partition in another tab, stages a generation, releases a hold or reconciles an entry, or another tab's queue is disposed while driving entries. Tabs announce this on a `BroadcastChannel` per partition (`queue.channel` replaces it; the message carries no entry data). While started and online, a sync whose pass left nothing to retry runs another pass after `idlePollMs` (default 30 seconds; 0 turns it off), which finds work no announcement reached, such as an entry another tab claimed and left when it closed. A sync requested while a pass runs gets a follow-up pass, so newly staged work never waits for the next `online` event; so does a pass in which a generation was superseded, so the newer generation is driven even if the tab that staged it has closed. Ambiguous, busy, held (another tab may release it) and principal-mismatch entries, entries whose processing threw, and a pass that failed or was refused for a principal mismatch are looked at again after `retryDelayMs`, doubling up to a minute. `processAll` isolates entries: an error in one (a storage failure, say) is returned as `{ entryId, error }` and reported to `onSyncError` with that entry ID, and the pass goes on. `client.dispose()` disposes the implicit sync and every sync `createOfflineSync` made, and a sync whose queue was disposed disposes itself without reporting an error. A legacy-store sync that is disposed records no retry and delivers no result, even when its client ignores the abort. Once a sync is disposed, its pass journals nothing more: no claim, attempt, default verification or publication, or cleanup, no new upload or hook starts, and no progress, error or completion callback runs, even when `dispose()` is called inside one. The same holds when its queue is disposed, from inside a callback or elsewhere: the sync disposes itself and schedules no retry or poll. Every journal write checks this right before it commits. Callbacks are fenced on the principal too: a sync checks `currentPrincipal` before each `onSyncError`, `onSyncProgress` and `onSyncComplete` call and before it returns its summary, and the queue checks it before delivering an event to each listener and before settling `whenSettled` waiters. Once a callback (or anything else) switches the account, no later callback or listener of that pass sees the old principal's entries, the pass returns an empty summary and is retried later, and the waiters stay pending until a read under their own principal settles them. A call that returns entry data (`process`, `stage`, `reconcile`, `get`, `list`, `migrateLegacyUpload`, `getPendingLocalDescriptor`) checks the principal after its last callback or storage step and before it returns; on a mismatch it returns or throws nothing of the old principal (`stopped`/`refused` with `principal-mismatch`, or `FILEFN_QUEUE_PRINCIPAL_MISMATCH`) and the committed work stays with its owner. `whenSettled` waiters that a read settles (`get`, `list`, `cancel`, `reclaim`) settle only after that call returned, behind a fresh principal check, so a waiter callback that switches the account cannot make the read hand over the old principal's entries. A step's `assertPrincipal` and `signal` die with the step: kept by a hook and called after the step ended, or after its queue was disposed, `assertPrincipal` rejects with an `AbortError`.

## Limits and cleanup

`queue.limits` sets `maxEntries` (default 500) and `maxBytes` (default 1 GiB) per partition. Replacing a generation credits only the bytes of its data file still present. When a stage would exceed them, the queue first reclaims what is safe, then refuses with `{ status: "refused", reason: "capacity", limit: "entries" | "bytes", usage, limits }`. A browser quota error during a stage first runs the same safe reclamation (orphaned files and entries, data of published generations; never pending or provisional data or the entry being staged) and, when that freed anything, admits the stage once more. A quota error that remains, or one anywhere else in a stage (opening the storage root and reclamation included), is the same refusal with `limit: "quota"`; nothing is half-written and pending work and publication records are kept. `migrateLegacyUpload` returns the same refusal when storage runs out while it opens the legacy store, prepares or writes its admission claim, or stages the entry; the legacy upload (and a claim already written) stays, so a retry completes the migration.

Reclamation (on demand with `queue.reclaim()`, and before a capacity refusal) removes only: entry directories without a committed journal (a first stage interrupted before its journal committed leaves none, or an empty one), data files the journal no longer names, the data of published generations, and published entries older than `terminalRetentionMs` (default 24 hours; any age under capacity pressure). A removed published generation leaves a small tombstone (the last 64, within the retention), so a `whenSettled` waiter in another tab still resolves as published rather than cancelled. Provisional entries (failed and rejected generations included: they may hold the only copy of the user's file, so they stay until `cancel`, and a full partition refuses new work instead) and journals of another binding or a newer layout are never reclaimed; of the entry being staged, only data files its journal does not name are (all of its data when it has no committed journal, such as remains of a first staging killed before its journal existed, so a restage is not refused for them). A published entry's data is removed before its tombstone is written, so under a full disk the tombstone fits in the room the data frees. `cancel(entryId, generation)` removes one explicitly. Staging a new generation over a published one leaves the same tombstone, so a waiter of the published generation resolves rather than reporting it superseded.

## Crash recovery

| Interrupted at | After reload |
| --- | --- |
| Staging, before the journal write | No entry; the orphaned data (and an empty first journal) is reclaimed, and the entry can be staged again. |
| Upload | `phase: "uploading"`; replayed with the recorded key. |
| Verification | `phase: "verifying"`; verified again. |
| Publication | `phase: "publishing"`; reconciled as above, never blindly repeated. This includes a pass stopped between journaling the claim and starting the hook: nothing is written after a stop, so the claim stays for reconciliation. |
| Cleanup after publication | `state: "published"`; the next pass removes the data. |

## Pre-0.5 uploads

Uploads staged by 0.4 and earlier (in `offline.opfsDir`, default `filefn-pending-uploads`) have no owner. They are never listed or replayed automatically. `queue.listLegacyUploads()` shows them, and `queue.migrateLegacyUpload(uploadSessionId, { ownershipVerified: true })` moves one into the current partition as a new entry (refused with `generation-conflict` if an entry with that ID exists; pass `entryId` to choose another); call it only when you have your own evidence that the upload belongs to this principal. A legacy upload is admitted once, whatever `entryId` and however many tabs or partitions (other services included) migrate it: the migration runs under one lock of the legacy directory and records which partition admitted it before writing the entry. A repeat in that partition returns the entry it became, or `{ status: "refused", reason: "already-migrated" }` once that entry is gone or replaced by a newer generation (a later generation is never returned as the migrated one); any other partition gets `already-migrated`. A migrated upload keeps its replay key, so a session it already completed is reconciled rather than uploaded again, only when no other legacy upload shares that key and no generation of the partition has used it; otherwise it gets a fresh key, so it is never confirmed with another upload's stored version. A staging that fails takes nothing over, so a retry keeps the key.

## Pending-local previews

```ts
const renderable = await client.resolveRenderable({ fileId, intent: "preview", preferLocal: true });
if (renderable.state === "pending-local") imgElement.src = (renderable.source as { url: string }).url;
```

The preview comes from the newest unpublished generation of that file in the client's partition: among entries whose staged data is still present, the highest generation (ties broken by entry ID); touching an entry (a hold, a failed attempt) does not change the choice. No preview URL is created or returned unless the principal is still the partition's after the read, even when the read waited on the lock. Its `versionId` is the generation's `operationId`. Its object URL is revoked once that generation is published or the entry is removed (seen by `list()`, `reclaim()` or `whenSettled`), and every preview URL the queue issued is revoked as soon as any of its principal checks (a call, an event or waiter delivery, `principalIsCurrent`) finds another principal or none, such as after an account switch in another tab.

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
