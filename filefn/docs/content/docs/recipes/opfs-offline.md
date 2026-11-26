---
title: OPFS offline
description: Reliable uploads when the network is bad — OPFS-staged content with automatic resume on reconnect.
---

# OPFS offline

Goal: a flaky-network-friendly upload that persists across tab reloads and resumes when the user reconnects.

## Enable

```ts
const client = createFileFnClient({
  baseUrl: "/filefn",
  offline: {
    enabled: true,
    partition: { serviceId: "app", principal: { kind: "user", principalId: session.userId } },
    // Who the live credentials act for now (another tab may have switched
    // accounts), read from local state: it is called offline too.
    currentPrincipal: () => readLocalSessionPrincipal(),
    // Credentials issued for exactly this principal (null when there are none).
    getAuthHeaders: (principal) => readHeadersFor(principal),
  },
});
```

That's it. Every `uploadFile(...)` call made offline:

1. Stages the bytes as a new generation in the user's partition of the durable queue.
2. Returns an `UploadHandle` whose `done()` waits for publication.
3. Is replayed when `navigator.onLine` becomes `true`, when another tab announces work, and on idle polls.

## Showing pending-local previews

```ts
const renderable = await client.resolveRenderable({
  fileId,
  intent: "preview",
  preferLocal: true,
});

if (renderable.state === "pending-local") {
  imgElement.src = (renderable.source as { url: string }).url; // blob: URL
}
```

## Listing pending uploads

```ts
const queue = client.getOfflineQueue();
for (const entry of await queue.list()) {
  console.log(entry.fileName, entry.size, entry.phase, entry.state, entry.attempts);
}
```

`list()` returns only this partition's entries and throws
`FILEFN_QUEUE_PRINCIPAL_MISMATCH` while another account is signed in. Useful
for an "uploads in progress" UI that survives reloads. Do not read the
pre-0.5 unscoped `OPFSStore` for this: it cannot see the partitioned journals,
and its records belong to no verified principal (see
[Features › Offline](../features/offline) for `listLegacyUploads` and
`migrateLegacyUpload`).

## Cancelling

```ts
const handle = client.uploadFile({ policy: "user-image", file });
handle.abort(); // removes OPFS row, cancels in-flight requests
```

## Quota

Before staging, check `navigator.storage.estimate()`:

```ts
const { quota = 0, usage = 0 } = await navigator.storage.estimate();
if (quota - usage < file.size) {
  // Skip OPFS — upload directly without offline persistence.
  // Or surface the issue and prompt the user to clear OPFS.
}
```

## Headless mode

If you want full control over when queued work runs (e.g. an Electron app),
turn implicit replay off and drive the partitioned queue with an explicit
`OfflineSync`:

```ts
const client = createFileFnClient({
  baseUrl: "/filefn",
  offline: { enabled: true, implicitReplay: false, partition, currentPrincipal, getAuthHeaders },
});

const sync = client.createOfflineSync({ onSyncError: (error, entryId) => report(error, entryId) });
sync.start();                               // online events, cross-tab wakeups, idle polls
await client.getOfflineQueue().process(id); // advance one entry now
sync.dispose();                             // or client.dispose(), which disposes it too
```

## See also

- [Features › Offline](../features/offline) — full reference.
- [Core Concepts › Offline](../core-concepts/offline) — design rationale.
