# TEST VECTORS: datafn Audit Gap Resolution

---

## TV-TEST-001 — Client Test Baseline
- **Description**: All client tests pass after fixes.
- **Input**: `npm test -w @datafn/client`
- **Expected output**: 0 failures, all tests pass.

## TV-TEST-001N — Client Test Regression Guard
- **Description**: Intentionally broken test must fail.
- **Input**: Add a test that asserts `1 === 2`.
- **Expected output**: 1 failure reported.

## TV-TEST-002 — Server Test Baseline
- **Description**: All server tests pass after fixes.
- **Input**: `npm test -w @datafn/server`
- **Expected output**: 0 failures, all tests pass.

## TV-TEST-002N — Server Test Regression Guard
- **Description**: Same as TV-TEST-001N for server.
- **Input**: Add a test that asserts `1 === 2`.
- **Expected output**: 1 failure reported.

---

## TV-BUS-001 — Event Bus Error Isolation
- **Description**: A throwing handler does not block subsequent handlers.
- **Input**:
```json
{
  "setup": {
    "handlers": [
      { "id": "A", "action": "throw Error('boom')" },
      { "id": "B", "action": "record event" }
    ]
  },
  "emit": { "type": "mutation_applied", "resource": "task" }
}
```
- **Expected output**:
  - Handler B receives the event and records it
  - Error from Handler A is logged (console.error or onError callback)
  - No unhandled exception

## TV-BUS-001N — Event Bus Without Error Isolation (current behavior)
- **Description**: Verify that without the fix, handler B would NOT receive the event.
- **Expected output**: Handler B does NOT receive the event (pre-fix behavior).

---

## TV-SIG-001 — Signal Dispose
- **Description**: Disposed signal is cleaned up from registry and event bus.
- **Input**:
```json
{
  "setup": "create signal for resource 'task'",
  "action": "signal.dispose()",
  "then": "emit mutation_applied for resource 'task'"
}
```
- **Expected output**:
  - Signal is removed from SignalRegistry
  - Event bus subscription count decreases by 1
  - Signal does NOT refresh after the mutation event
  - `signal.get()` returns last cached value (not undefined)

## TV-SIG-001N — Signal Dispose Idempotency
- **Description**: Calling dispose twice does not throw.
- **Input**: `signal.dispose(); signal.dispose();`
- **Expected output**: No error. Second call is a no-op.

---

## TV-SIG-002 — Fine-Grained Signal Invalidation
- **Description**: Signal with cached records [task:1, task:2] does NOT refresh when task:3 is merged.
- **Input**:
```json
{
  "signal": { "resource": "task", "cachedIds": ["task:1", "task:2"] },
  "event": { "type": "mutation_applied", "resource": "task", "ids": ["task:3"], "action": "merge" }
}
```
- **Expected output**: Signal does NOT refresh (ids don't intersect).

## TV-SIG-002N — Signal Refreshes on Insert
- **Description**: Signal always refreshes on insert (new record may match filter).
- **Input**:
```json
{
  "signal": { "resource": "task", "cachedIds": ["task:1"] },
  "event": { "type": "mutation_applied", "resource": "task", "ids": ["task:99"], "action": "insert" }
}
```
- **Expected output**: Signal refreshes (insert always triggers).

---

## TV-SIG-003 — Optimistic Signal Update
- **Description**: Merge mutation patches signal cache immediately.
- **Input**:
```json
{
  "signal_cache": [{ "id": "task:1", "title": "Old", "status": "open" }],
  "event": {
    "type": "mutation_applied",
    "resource": "task",
    "ids": ["task:1"],
    "action": "merge",
    "record": { "title": "New" }
  }
}
```
- **Expected output**:
  - Signal value immediately becomes `[{ "id": "task:1", "title": "New", "status": "open" }]`
  - A background re-fetch is scheduled

## TV-SIG-003N — No Optimistic on Delete
- **Description**: Delete mutation triggers full re-fetch, not optimistic patch.
- **Input**:
```json
{
  "event": { "type": "mutation_applied", "resource": "task", "ids": ["task:1"], "action": "delete" }
}
```
- **Expected output**: Signal triggers full re-fetch (not optimistic patch).

---

## TV-CLN-001 — Client Destroy
- **Description**: After destroy, all resources are released.
- **Input**:
```json
{
  "action": "client.destroy()",
  "then": "client.query({ resource: 'task' })"
}
```
- **Expected output**:
  - `destroy()` resolves successfully
  - Subsequent `query()` throws `DFQL_INVALID` with message containing "destroyed"
  - No active timers, WebSocket, or event handlers remain

## TV-CLN-001N — Destroy Flushes Debounced Mutations
- **Description**: Pending debounced mutations are flushed before destroy completes.
- **Input**:
```json
{
  "setup": "mutate with debounceKey='task:1', debounceMs=5000",
  "action": "immediately call client.destroy()"
}
```
- **Expected output**: The debounced mutation is applied to storage before destroy resolves.

---

## TV-CLN-002 — Client Clear
- **Description**: After clear, all data is wiped but client is usable.
- **Input**:
```json
{
  "setup": "insert task:1 into storage",
  "action": "client.clear()",
  "then": "query all tasks"
}
```
- **Expected output**:
  - Query returns empty result (data wiped)
  - Client is still functional (no DFQL_INVALID)
  - Hydration states reset to `notStarted`

## TV-CLN-002N — Clear Does Not Destroy
- **Description**: After clear, client methods still work.
- **Input**: `client.clear(); client.query({ resource: 'task' })`
- **Expected output**: Query succeeds (returns empty), no error.

---

## TV-DEB-001 — Debounced Mutations
- **Description**: Two rapid merges with same debounceKey produce one changelog entry.
- **Input**:
```json
{
  "mutations": [
    { "resource": "task", "operation": "merge", "id": "task:1", "record": { "title": "A" }, "debounceKey": "task:1", "debounceMs": 100 },
    { "resource": "task", "operation": "merge", "id": "task:1", "record": { "status": "done" }, "debounceKey": "task:1", "debounceMs": 100 }
  ],
  "timing": "both mutations within 50ms"
}
```
- **Expected output**:
  - One changelog entry with `{ title: "A", status: "done" }`
  - Local storage updated twice (optimistic on each call)
  - One `mutation_applied` event after debounce window

## TV-DEB-001N — Flush Forces Immediate Execution
- **Description**: `flush(key)` executes pending mutation immediately.
- **Input**:
```json
{
  "mutation": { "debounceKey": "task:1", "debounceMs": 10000 },
  "action": "immediately call flush('task:1')"
}
```
- **Expected output**: Mutation applied and changelog entry created immediately (not after 10s).

---

## TV-DEB-002 — KV Debounced Persistence
- **Description**: KV merge with debounceMs delays the underlying mutation.
- **Input**:
```json
{
  "calls": [
    { "method": "kv.merge", "key": "prefs", "value": { "theme": "dark" }, "debounceMs": 200 },
    { "method": "kv.merge", "key": "prefs", "value": { "lang": "es" }, "debounceMs": 200 }
  ],
  "timing": "both within 100ms"
}
```
- **Expected output**: One mutation with `{ theme: "dark", lang: "es" }` after 200ms quiet period.

## TV-DEB-002N — KV Without Debounce (Default)
- **Description**: Without debounceMs, KV operations are immediate.
- **Input**: `kv.set("prefs", { theme: "dark" })`
- **Expected output**: Mutation applied immediately (no delay).

---

## TV-KV-001 — KV Seed Data
- **Description**: `getOrSeed` returns defaults on first call, existing on second.
- **Input**:
```json
{
  "call_1": { "method": "kv.getOrSeed", "key": "settings", "defaults": { "volume": 50, "muted": false } },
  "call_2": { "method": "kv.getOrSeed", "key": "settings", "defaults": { "volume": 100, "muted": true } }
}
```
- **Expected output**:
  - Call 1 returns `{ "volume": 50, "muted": false }`
  - Call 2 returns `{ "volume": 50, "muted": false }` (existing value, NOT new defaults)

## TV-KV-001N — KV Seed Does Not Overwrite Null
- **Description**: Explicitly set null is not re-seeded.
- **Input**:
```json
{
  "setup": "kv.set('x', null)",
  "call": { "method": "kv.getOrSeed", "key": "x", "defaults": { "a": 1 } }
}
```
- **Expected output**: Returns `null` (does not re-seed).

---

## TV-MUT-001 — Silent Mutations
- **Description**: Silent mutation applies to storage but does not emit events.
- **Input**:
```json
{
  "mutation": { "resource": "task", "operation": "merge", "id": "task:1", "record": { "title": "X" }, "silent": true },
  "eventListener": "subscribe to mutation_applied for resource task"
}
```
- **Expected output**:
  - Storage contains `task:1` with `title: "X"`
  - Changelog has the entry
  - Event listener was NOT called
  - Signals for "task" did NOT refresh

## TV-MUT-001N — Non-Silent Mutation Emits Events
- **Description**: Default (non-silent) mutation emits events normally.
- **Input**: Same mutation without `silent: true`.
- **Expected output**: Event listener IS called. Signals refresh.

---

## TV-MUT-002 — System Mutation Flag
- **Description**: System mutation includes flag in event.
- **Input**:
```json
{
  "mutation": { "resource": "task", "operation": "merge", "id": "task:1", "record": { "title": "sys" }, "system": true }
}
```
- **Expected output**: Event payload includes `system: true`.

## TV-MUT-002N — Non-System Mutation
- **Description**: Normal mutation does not include system flag.
- **Input**: Same mutation without `system: true`.
- **Expected output**: Event payload does NOT include `system` field (or it's undefined/false).

---

## TV-WS-001 — WebSocket Reconnection
- **Description**: WebSocket reconnects automatically after disconnection.
- **Input**:
```json
{
  "setup": "connect WebSocket, then simulate close event",
  "expectations": [
    "ws_disconnected event emitted",
    "reconnect attempt after ~1000ms (±500ms jitter)",
    "on success: ws_connected event emitted",
    "hello message re-sent with current cursors"
  ]
}
```
- **Expected output**: WebSocket reconnects and resumes normal operation.

## TV-WS-001N — Reconnection Disabled
- **Description**: No reconnection when `wsReconnect.enabled: false`.
- **Input**: Configure `wsReconnect: { enabled: false }`, simulate WS close.
- **Expected output**: No reconnection attempts. `ws_disconnected` emitted but no `ws_connected` follows.

---

## TV-RET-001 — Push Retry Backoff
- **Description**: Push retries with increasing delay.
- **Input**:
```json
{
  "setup": "push fails with transport error 3 times, then succeeds",
  "config": { "pushRetryBackoff": { "baseDelayMs": 100, "multiplier": 2, "maxDelayMs": 1000, "jitterMs": 0 } }
}
```
- **Expected output**:
  - Attempt 1: immediate
  - Retry 1: ~100ms delay
  - Retry 2: ~200ms delay
  - Retry 3: ~400ms delay → succeeds
  - Total elapsed: ~700ms (±tolerance)

## TV-RET-001N — Immediate Retry Without Backoff Config
- **Description**: Default backoff parameters apply when not configured.
- **Input**: Push fails, no custom config.
- **Expected output**: Retries with default delays (baseDelayMs=1000).

---

## TV-OFF-001 — Batch Offline Fallback
- **Description**: Batch mutation falls back to individual offline handling.
- **Input**:
```json
{
  "setup": "no network (remote.push throws transport error)",
  "batch": [
    { "resource": "task", "operation": "merge", "id": "task:1", "record": { "title": "A" } },
    { "resource": "task", "operation": "merge", "id": "task:2", "record": { "title": "B" } }
  ]
}
```
- **Expected output**:
  - Both mutations applied to local storage
  - Both added to changelog
  - Two `mutation_applied` events emitted
  - Result indicates 2 mutations applied

## TV-OFF-001N — Batch Fails Without Storage
- **Description**: Without storage, batch fails entirely (no offline fallback).
- **Input**: Same batch but `storage` is undefined.
- **Expected output**: Error thrown (transport error, no fallback).

---

## TV-OFF-002 — Atomic Offline Merge
- **Description**: mergeRecord is atomic (single transaction).
- **Input**:
```json
{
  "existing": { "id": "task:1", "title": "Old", "status": "open" },
  "merge": { "title": "New" }
}
```
- **Expected output**: `{ "id": "task:1", "title": "New", "status": "open" }` — existing fields preserved.

## TV-OFF-002N — mergeRecord Upsert on Missing
- **Description**: mergeRecord creates record if it doesn't exist.
- **Input**: `mergeRecord("task", "task:99", { title: "New" })`
- **Expected output**: Record `{ "id": "task:99", "title": "New" }` created.

---

## TV-OFF-003 — Deep Merge Offline
- **Description**: Nested objects are shallow-merged (one level deep).
- **Input**:
```json
{
  "existing": { "id": "kv:prefs", "value": { "theme": "light", "lang": "en", "notifications": { "email": true } } },
  "merge": { "value": { "theme": "dark", "notifications": { "push": true } } }
}
```
- **Expected output**: `{ "id": "kv:prefs", "value": { "theme": "dark", "lang": "en", "notifications": { "push": true } } }`
  - `theme` overwritten, `lang` preserved, `notifications` overwritten (only one level deep)

## TV-OFF-003N — Arrays Not Deep Merged
- **Description**: Array fields are overwritten, not merged.
- **Input**:
```json
{
  "existing": { "tags": ["a", "b"] },
  "merge": { "tags": ["c"] }
}
```
- **Expected output**: `{ "tags": ["c"] }` (overwrite, not union).

---

## TV-CFG-001 — Configurable Pull Batch Size
- **Description**: Custom pullBatchSize is used in pull requests.
- **Input**: `DatafnSyncConfig.pullBatchSize = 500`
- **Expected output**: Pull request sends `limit: 500`.

## TV-CFG-001N — Invalid Pull Batch Size
- **Description**: Non-positive pullBatchSize rejected.
- **Input**: `pullBatchSize: -1`
- **Expected output**: Client init throws `DFQL_INVALID`.

---

## TV-QRY-001 — AbortSignal Support
- **Description**: Aborted query rejects with DFQL_ABORTED.
- **Input**:
```json
{
  "query": { "resource": "task" },
  "signal": "AbortController.abort() called before response"
}
```
- **Expected output**: Query rejects with `{ code: "DFQL_ABORTED" }`.

## TV-QRY-001N — Query Without Signal Succeeds
- **Description**: Query without signal is unaffected.
- **Input**: `{ "query": { "resource": "task" } }`
- **Expected output**: Normal query result (no abort behavior).

---

## TV-EXP-001 — Data Export
- **Description**: Export returns all records in structured format.
- **Input**: Local storage has `task:1`, `task:2`, join row `(task:1, tag:A)`.
- **Expected output**:
```json
{
  "version": 1,
  "exportedAt": "2026-02-11T20:00:00Z",
  "schema": [{ "name": "task", "version": 1 }],
  "resources": { "task": [{ "id": "task:1" }, { "id": "task:2" }] },
  "joins": { "join_task_tags_tag": [{ "from": "task:1", "to": "tag:A" }] }
}
```

## TV-EXP-001N — Export With Resource Filter
- **Description**: Export only specified resources.
- **Input**: `exportData({ resources: ["task"] })` — storage has task and user records.
- **Expected output**: Only task records in payload. No user records.

---

## TV-EXP-002 — Data Import
- **Description**: Import upserts records into storage.
- **Input**: Import payload with `{ "task": [{ "id": "task:1", "title": "Imported" }] }`.
- **Expected output**:
  - `task:1` exists in storage with `title: "Imported"`
  - Result: `{ ok: true, stats: { resources: { task: { imported: 1, skipped: 0 } } }, errors: [] }`

## TV-EXP-002N — Import Unknown Resource
- **Description**: Unknown resources are skipped.
- **Input**: Import payload with `{ "unknown_resource": [...] }`.
- **Expected output**: Resource skipped. `stats` does not include it. No error thrown.

---

## TV-SD-001 — Soft-Delete Plugin
- **Description**: Delete mutation converted to merge with isDeleted flag.
- **Input**: `table.mutate({ operation: "delete", id: "task:1" })` with soft-delete plugin enabled.
- **Expected output**: Record `task:1` still exists with `{ isDeleted: true, deletedAt: "<timestamp>" }`.

## TV-SD-001N — Query Excludes Soft-Deleted
- **Description**: Soft-deleted records auto-filtered from queries.
- **Input**: Query `{ resource: "task" }` where `task:1` has `isDeleted: true`.
- **Expected output**: `task:1` NOT in results.

---

## TV-HEAL-001 — Health Check Pass
- **Description**: Healthy storage returns ok.
- **Input**: `client.checkHealth()` with valid, accessible storage.
- **Expected output**: `{ ok: true, issues: [], action: "none" }`.

## TV-HEAL-001N — Health Check Fail
- **Description**: Corrupted storage detected.
- **Input**: `client.checkHealth()` with deleted object stores.
- **Expected output**: `{ ok: false, issues: ["Missing object store: task"], action: "reclone" }`.

---

## TV-BULK-001 — Bulk Mutation Fallback
- **Description**: Batch with one invalid mutation partially succeeds.
- **Input**:
```json
{
  "batch": [
    { "resource": "task", "operation": "merge", "id": "task:1", "record": { "title": "OK" } },
    { "resource": "INVALID", "operation": "merge", "id": "x:1", "record": {} }
  ],
  "fallbackToIndividual": true
}
```
- **Expected output**: task:1 succeeds. INVALID fails. Result has 1 applied, 1 error.

## TV-BULK-001N — Batch Without Fallback Fails Entirely
- **Description**: Without fallback, batch fails on any error.
- **Input**: Same batch without `fallbackToIndividual`.
- **Expected output**: Entire batch fails.

---

## TV-TAB-001 — Cross-Tab Event Relay
- **Description**: Mutation in one tab triggers signal refresh in another.
- **Input**:
```json
{
  "setup": "Two clients on same channel 'datafn:test'",
  "action": "Client A mutates task:1",
  "expected": "Client B event bus receives mutation_applied for task:1"
}
```
- **Expected output**: Client B's event bus fires `mutation_applied` with `fromRemoteTab: true`.

## TV-TAB-001N — Silent Mutations Not Relayed
- **Description**: Silent mutations are not sent cross-tab.
- **Input**: Client A mutates with `silent: true`.
- **Expected output**: Client B does NOT receive the event.

---

## TV-SRCH-001 — Client-Side Search
- **Description**: Local search index returns results offline.
- **Input**: Query with `search: "meeting notes"` on hydrated resource.
- **Expected output**: Results from local index matching "meeting notes".

## TV-SRCH-001N — Search Fallback to Remote
- **Description**: Non-hydrated resource falls back to remote search.
- **Input**: Query with `search: "x"` on non-hydrated resource.
- **Expected output**: Query routed to remote adapter.

---

## TV-AUD-001 — Audit Trail Enrichment
- **Description**: Changelog entry includes userId and timestamp.
- **Input**: Mutation with auth context `{ userId: "user:1" }`.
- **Expected output**: Changelog entry includes `userId: "user:1"` and `timestamp: "<ISO string>"`.

## TV-AUD-001N — Changelog Without Auth Context
- **Description**: Without auth context, userId is omitted.
- **Input**: Mutation without auth context.
- **Expected output**: Changelog entry has `timestamp` but `userId` is `undefined`.

---

## TV-IDB-001 — IDB Migration
- **Description**: V1 to V2 migration preserves data.
- **Input**: Open v1 database, close, open with v2 schema.
- **Expected output**: All v1 data accessible via v2 object stores.

## TV-IDB-001N — Failed Migration Preserves Data
- **Description**: Failed migration does not destroy original data.
- **Input**: Simulate migration error (e.g., store creation failure).
- **Expected output**: V1 database is still intact and accessible.
