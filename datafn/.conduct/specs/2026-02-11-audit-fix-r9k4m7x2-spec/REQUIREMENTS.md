# REQUIREMENTS: datafn Audit Gap Resolution

## Table of Contents

| ID | Priority | Summary |
|----|----------|---------|
| TEST-001 | P0 | Fix client test failures |
| TEST-002 | P0 | Fix server test failures |
| BUS-001 | P0 | Event bus error isolation |
| SIG-001 | P0 | Signal dispose/lifecycle management |
| SIG-002 | P1 | Fine-grained signal invalidation |
| SIG-003 | P1 | Optimistic signal updates (back-propagation) |
| CLN-001 | P0 | Client destroy method |
| CLN-002 | P0 | Client clear method |
| DEB-001 | P0 | Debounced mutations |
| DEB-002 | P0 | KV debounced persistence |
| KV-001 | P1 | KV seed data (getOrSeed) |
| MUT-001 | P0 | Silent mutations flag |
| MUT-002 | P1 | System mutation flag |
| WS-001 | P0 | WebSocket reconnection with backoff |
| RET-001 | P0 | Push retry exponential backoff |
| OFF-001 | P1 | Batch offline fallback |
| OFF-002 | P1 | Atomic offline merge |
| OFF-003 | P1 | Deep merge for offline |
| CFG-001 | P1 | Configurable pull batch size |
| QRY-001 | P1 | AbortSignal support for queries |
| EXP-001 | P1 | Data export |
| EXP-002 | P1 | Data import |
| SD-001 | P2 | Soft-delete plugin |
| HEAL-001 | P2 | Self-healing persistence |
| BULK-001 | P2 | Bulk mutation fallback strategy |
| TAB-001 | P2 | Cross-tab coordination |
| SRCH-001 | P2 | Client-side search indexing |
| AUD-001 | P2 | Mutation audit trail enrichment |
| IDB-001 | P2 | IDB migration reliability |

---

## TEST-001 — Fix Client Test Failures
- **Priority**: P0
- **Statement**: All existing client test failures (14 failures across cloneUp, sync, storage-idb) MUST be fixed.
- **Rationale**: Pre-existing test failures mask regressions from new work. Clean baseline required.
- **Acceptance criteria**:
  - `npm test -w @datafn/client` reports 0 failures
  - cloneUp KV resource stats tests pass
  - Legacy global cursor format tests are updated to per-table cursors
  - IDB storage initialization tests pass
- **Test vectors**: TV-TEST-001, TV-TEST-001N
- **Notes**: Some tests may need updating (not fixing code) if the tests assert obsolete behavior (e.g., legacy cursor format).

---

## TEST-002 — Fix Server Test Failures
- **Priority**: P0
- **Statement**: All existing server test failures (19 failures across REST, pull, transact) MUST be fixed.
- **Rationale**: Same as TEST-001. Clean test baseline is prerequisite.
- **Acceptance criteria**:
  - `npm test -w @datafn/server` reports 0 failures
  - REST endpoint clientId passing tests pass
  - Pull cursor validation tests updated
  - Transact error code tests match implementation
- **Test vectors**: TV-TEST-002, TV-TEST-002N
- **Notes**: Error code mismatches (DFQL_INVALID vs DFQL_UNKNOWN_FIELD) should be resolved by standardizing on the more specific code.

---

## BUS-001 — Event Bus Error Isolation
- **Priority**: P0
- **Statement**: `EventBus.emit()` MUST wrap each handler invocation in try-catch so that a throwing handler does not prevent delivery to subsequent handlers.
- **Rationale**: A single buggy subscriber can currently break mutation event delivery, preventing signal refresh and sync scheduling.
- **Acceptance criteria**:
  - Handler A throws, Handler B still receives the event
  - Error is logged to console.error (or configurable error handler)
  - Event delivery order is preserved
  - No change to the EventBus public API signature
- **Test vectors**: TV-BUS-001, TV-BUS-001N
- **Notes**: The error handler SHOULD be injectable via `new EventBus({ onError })` for testability.

---

## SIG-001 — Signal Dispose / Lifecycle Management
- **Priority**: P0
- **Statement**: Signals MUST expose a `dispose()` method that unsubscribes from the event bus and removes the signal from the SignalRegistry.
- **Rationale**: Without dispose, signals and event bus handlers accumulate indefinitely (GAP-28 memory leak).
- **Acceptance criteria**:
  - `signal.dispose()` removes the signal from `SignalRegistry`
  - `signal.dispose()` calls the stored eventBus unsubscribe function
  - After dispose, the signal does not refresh on new events
  - `signalRegistry.disposeAll()` disposes all registered signals
  - No event bus handler references remain after dispose
- **Test vectors**: TV-SIG-001, TV-SIG-001N
- **Notes**: A disposed signal's `get()` should return the last cached value (not throw).

---

## SIG-002 — Fine-Grained Signal Invalidation
- **Priority**: P1
- **Statement**: Signal invalidation MUST compare mutation event metadata (ids, fields, action) against the signal's cached state to avoid unnecessary re-fetches.
- **Rationale**: Current per-resource invalidation causes write amplification at Nucleus scale (GAP-12).
- **Acceptance criteria**:
  - `merge` mutation on record X does NOT refresh a signal whose cached results don't include record X
  - `insert` mutation always triggers refresh (new record may match filter)
  - `delete` mutation always triggers refresh (removed record may be in cache)
  - Relation footprint uses schema lookup (not name-equals-resource heuristic)
  - Existing microtask debounce behavior is preserved
- **Test vectors**: TV-SIG-002, TV-SIG-002N
- **Notes**: Conservative fallback: if cached IDs are unavailable, refresh (same as current behavior).

---

## SIG-003 — Optimistic Signal Updates (Back-Propagation)
- **Priority**: P1
- **Statement**: On `merge` mutations, signals SHOULD immediately patch their cached data with the mutation's record fields instead of waiting for a full re-fetch.
- **Rationale**: Eliminates perceptible lag between mutation and UI update (GAP-14).
- **Acceptance criteria**:
  - After a `merge` mutation, signal subscribers receive updated value within the same microtask
  - Patched value correctly merges mutation fields into cached record
  - A background re-fetch is still scheduled (debounced) for eventual consistency
  - `disableOptimistic: true` on signal opts out of back-propagation
  - `insert`/`delete`/`replace` mutations trigger full re-fetch (no patching)
- **Test vectors**: TV-SIG-003, TV-SIG-003N
- **Notes**: If the mutation's record ID is not in the cached result, skip patching (fall through to re-fetch).

---

## CLN-001 — Client Destroy
- **Priority**: P0
- **Statement**: `client.destroy()` MUST tear down all resources: stop sync, close WebSocket, dispose all signals, clear event bus, close storage, and set a destroyed flag.
- **Rationale**: Memory leaks, WebSocket leaks, and inability to switch users (GAP-10).
- **Acceptance criteria**:
  - After `destroy()`, `syncEngine.stop()` has been called
  - WebSocket is closed (if was open)
  - All signals are disposed
  - Event bus has no remaining subscriptions
  - Storage adapter is closed
  - Any method call on destroyed client throws `DFQL_INVALID`
  - All pending debounced mutations are flushed before teardown
- **Test vectors**: TV-CLN-001, TV-CLN-001N
- **Notes**: `destroy()` is async (storage close is async).

---

## CLN-002 — Client Clear
- **Priority**: P0
- **Statement**: `client.clear()` MUST wipe all local data (records, cursors, changelog, hydration state) without destroying the client.
- **Rationale**: Needed for user logout, data reset, and development workflows.
- **Acceptance criteria**:
  - After `clear()`, all storage records are deleted
  - All cursors are reset
  - All changelog entries are removed
  - All hydration states are reset to `notStarted`
  - Client remains usable after clear (can re-clone)
  - Signals are invalidated (re-fetch returns empty)
- **Test vectors**: TV-CLN-002, TV-CLN-002N
- **Notes**: `clear()` does NOT stop sync or close connections.

---

## DEB-001 — Debounced Mutations
- **Priority**: P0
- **Statement**: `table.mutate()` MUST support a `debounceKey` + `debounceMs` option that coalesces rapid mutations within the debounce window.
- **Rationale**: Without debouncing, rapid edits generate excessive changelog entries and sync traffic (GAP-05).
- **Acceptance criteria**:
  - Two `merge` mutations with same `debounceKey` within `debounceMs` produce only one changelog entry
  - The coalesced mutation contains merged fields from both calls
  - Local storage is updated immediately (optimistic) on each call
  - `flush(key)` forces immediate execution of pending debounced mutation
  - `flushAll()` flushes all pending debounced mutations
  - Debounce timers are cleaned up on `client.destroy()`
- **Test vectors**: TV-DEB-001, TV-DEB-001N
- **Notes**: Only `merge` operations are coalesced. `insert`/`delete`/`replace` with debounceKey execute immediately.

---

## DEB-002 — KV Debounced Persistence
- **Priority**: P0
- **Statement**: `kv.set()` and `kv.merge()` MUST support an optional `debounceMs` parameter for debounced persistence.
- **Rationale**: KV stores are the most frequently written data in Nucleus. Without debouncing, every toggle generates a mutation (NEW-01).
- **Acceptance criteria**:
  - `kv.set(key, value, { debounceMs: 3000 })` delays the underlying mutate by 3000ms
  - Multiple calls within the window coalesce
  - `kv.flush(key)` forces immediate write
  - Default behavior (no debounceMs) is immediate (backward-compatible)
- **Test vectors**: TV-DEB-002, TV-DEB-002N
- **Notes**: KV debounce delegates to the same debounce infrastructure as DEB-001.

---

## KV-001 — KV Seed Data
- **Priority**: P1
- **Statement**: `kv.getOrSeed(key, defaults)` MUST return the existing value or seed with defaults on first access.
- **Rationale**: Nucleus KV stores need first-run defaults (NEW-02).
- **Acceptance criteria**:
  - First call with a new key returns `defaults` and persists them
  - Second call returns the persisted value (not defaults)
  - Concurrent calls do not create duplicates
  - Seeded value goes through normal mutation path (appears in changelog for sync)
- **Test vectors**: TV-KV-001, TV-KV-001N
- **Notes**: If the existing value is `null` (explicitly set), `getOrSeed` returns `null` (does not re-seed).

---

## MUT-001 — Silent Mutations Flag
- **Priority**: P0
- **Statement**: Mutations with `silent: true` MUST apply locally and append to changelog but MUST NOT emit events or trigger signal refresh.
- **Rationale**: Bulk internal operations (sync-down, reconcile, import) trigger unnecessary UI refreshes (NEW-04).
- **Acceptance criteria**:
  - `silent: true` mutation applies to storage and changelog
  - No `mutation_applied` or `mutation_rejected` event is emitted
  - Signals do not refresh
  - Sync push still picks up the changelog entry
- **Test vectors**: TV-MUT-001, TV-MUT-001N
- **Notes**: The caller is responsible for manually refreshing signals after a batch of silent mutations if needed.

---

## MUT-002 — System Mutation Flag
- **Priority**: P1
- **Statement**: Mutations with `system: true` MUST propagate the flag in the `mutation_applied` event payload.
- **Rationale**: Background processes should not pollute modification timelines (NEW-03).
- **Acceptance criteria**:
  - `system: true` mutation emits event with `event.system === true`
  - `system: false` (or omitted) mutation emits event with `event.system === undefined`
  - Server-side authz is NOT affected by the system flag
- **Test vectors**: TV-MUT-002, TV-MUT-002N
- **Notes**: Auto-stamping of `modifiedBy`/`modifiedAt` is a plugin/middleware concern, not core datafn.

---

## WS-001 — WebSocket Reconnection
- **Priority**: P0
- **Statement**: The SyncEngine MUST implement automatic WebSocket reconnection with configurable exponential backoff and jitter.
- **Rationale**: Network interruptions permanently disable real-time sync (GAP-17).
- **Acceptance criteria**:
  - WebSocket reconnects automatically after disconnection
  - Delay follows exponential backoff formula
  - Jitter is applied to each delay
  - `hello` with current cursors re-sent after reconnect
  - Backoff resets on successful connection
  - Reconnection stops on `syncEngine.stop()` or `client.destroy()`
  - `ws_disconnected` and `ws_connected` events emitted
  - Configurable via `DatafnSyncConfig.wsReconnect`
- **Test vectors**: TV-WS-001, TV-WS-001N
- **Notes**: `wsReconnect.enabled: false` disables reconnection entirely.

---

## RET-001 — Push Retry Exponential Backoff
- **Priority**: P0
- **Statement**: `pushWithRetries()` MUST wait between retry attempts using exponential backoff with jitter.
- **Rationale**: Immediate retries hammer the server during outages (GAP-18).
- **Acceptance criteria**:
  - First retry waits ~1s, second ~2s, third ~4s (with jitter)
  - Maximum delay is capped at `maxDelayMs`
  - Backoff resets on successful push
  - Configurable via `DatafnSyncConfig.pushRetryBackoff`
- **Test vectors**: TV-RET-001, TV-RET-001N
- **Notes**: The sleep function should use `setTimeout` wrapped in a Promise.

---

## OFF-001 — Batch Offline Fallback
- **Priority**: P1
- **Statement**: When a batch mutation fails with a transport error and storage exists, the client MUST fall back to individual offline mutation handling for each mutation in the batch.
- **Rationale**: Bulk operations fail entirely when offline instead of queuing (GAP-19).
- **Acceptance criteria**:
  - Batch of 3 mutations sent while offline: all 3 applied locally and added to changelog
  - `mutation_applied` emitted per mutation (unless silent)
  - Aggregated result returned with per-mutation status
  - Non-transport errors (validation, schema) still fail the entire batch
- **Test vectors**: TV-OFF-001, TV-OFF-001N
- **Notes**: Partial-apply semantics: some mutations may succeed locally even if later ones fail validation.

---

## OFF-002 — Atomic Offline Merge
- **Priority**: P1
- **Statement**: The storage adapter MUST provide a `mergeRecord()` method that performs read-modify-write in a single IndexedDB transaction.
- **Rationale**: Separate read + write allows concurrent writes to overwrite each other (GAP-21).
- **Acceptance criteria**:
  - `mergeRecord("task", "task:1", { title: "new" })` atomically reads, merges, and writes
  - If record doesn't exist, upserts with the partial as the full record
  - Concurrent calls to `mergeRecord` for the same record are serialized by IndexedDB transaction
  - `handleOfflineMutation()` for `merge` operations uses `mergeRecord` instead of separate read+write
- **Test vectors**: TV-OFF-002, TV-OFF-002N
- **Notes**: Memory adapter can use a simple lock or synchronous operation (no transactions needed).

---

## OFF-003 — Deep Merge for Offline
- **Priority**: P1
- **Statement**: Offline merge operations MUST support one-level-deep merge for object-type fields.
- **Rationale**: Updating a nested property currently overwrites the entire parent object (GAP-31).
- **Acceptance criteria**:
  - Merging `{ preferences: { theme: "dark" } }` into `{ preferences: { lang: "en", theme: "light" } }` produces `{ preferences: { lang: "en", theme: "dark" } }`
  - Top-level scalars still overwrite
  - Arrays still overwrite (no array merging)
  - Null values overwrite (not skipped)
  - Works with the atomic `mergeRecord` from OFF-002
- **Test vectors**: TV-OFF-003, TV-OFF-003N
- **Notes**: Only one level deep. `{ a: { b: { c: 1 } } }` merged with `{ a: { b: { d: 2 } } }` produces `{ a: { b: { d: 2 } } }` (second level overwrites).

---

## CFG-001 — Configurable Pull Batch Size
- **Priority**: P1
- **Statement**: `DatafnSyncConfig` MUST accept a `pullBatchSize` option that controls the `limit` parameter in pull requests.
- **Rationale**: Pull batch size is currently hardcoded to 200 (GAP-24).
- **Acceptance criteria**:
  - `pullBatchSize: 500` sends `limit: 500` in pull requests
  - Default is 200 (preserves current behavior)
  - Value must be a positive integer; invalid values rejected at client init
- **Test vectors**: TV-CFG-001, TV-CFG-001N
- **Notes**: Minimum value: 10. Maximum value: 10000.

---

## QRY-001 — AbortSignal Support
- **Priority**: P1
- **Statement**: `DfqlQuery` MUST accept an optional `signal?: AbortSignal` that aborts in-flight remote queries.
- **Rationale**: Long-running queries cannot be cancelled when user navigates away (GAP-26).
- **Acceptance criteria**:
  - `signal` is passed through to `fetch()` in the HTTP transport
  - Aborted query rejects with error code `DFQL_ABORTED`
  - Local queries ignore the signal (execute to completion)
  - Signal cancellation does not corrupt client state
- **Test vectors**: TV-QRY-001, TV-QRY-001N
- **Notes**: The AbortSignal is not stored (it's per-call).

---

## EXP-001 — Data Export
- **Priority**: P1
- **Statement**: `client.exportData()` MUST return a structured JSON payload containing all local records and join rows.
- **Rationale**: Users cannot back up or restore their data (GAP-16).
- **Acceptance criteria**:
  - Exported payload includes `version: 1`, `exportedAt`, schema metadata, all records, and join rows
  - Optional `resources` filter limits export to specified resources
  - Remote-only resources are excluded
  - Export does not modify any data
- **Test vectors**: TV-EXP-001, TV-EXP-001N
- **Notes**: Large exports may be memory-intensive; no streaming support in v1.

---

## EXP-002 — Data Import
- **Priority**: P1
- **Statement**: `client.importData()` MUST upsert records and join rows from a `DatafnExportPayload` into local storage.
- **Rationale**: Complement to EXP-001 for restore/migration.
- **Acceptance criteria**:
  - Records are upserted (existing records updated, new records inserted)
  - Join rows are upserted
  - Unknown resources in payload are skipped (not errored)
  - Schema fields are validated; invalid fields are skipped with error in result
  - `triggerCloneUp: true` calls `cloneUp()` after import
  - Return value includes per-resource stats and errors
- **Test vectors**: TV-EXP-002, TV-EXP-002N
- **Notes**: Import is NOT atomic (partial import is possible on error).

---

## SD-001 — Soft-Delete Plugin
- **Priority**: P2
- **Statement**: datafn MUST provide a `createSoftDeletePlugin()` that converts `delete` mutations to `merge` with `deletedAt`/`isDeleted` fields, and auto-filters deleted records from queries.
- **Rationale**: Nucleus relies heavily on trash/restore (GAP-13).
- **Acceptance criteria**:
  - `delete` mutation on configured resource becomes `merge { isDeleted: true, deletedAt: <now> }`
  - Queries auto-add `isDeleted: { $ne: true }` filter (unless `includeDeleted: true` metadata)
  - `table.restore(id)` convenience method available
  - Plugin is configurable per-resource (not all resources use soft-delete)
  - Plugin runs on both client and server (runsOn: ["client", "server"])
- **Test vectors**: TV-SD-001, TV-SD-001N
- **Notes**: The plugin adds `isDeleted` and `deletedAt` fields; schema must declare them (plugin does not auto-modify schema).

---

## HEAL-001 — Self-Healing Persistence
- **Priority**: P2
- **Statement**: `client.checkHealth()` MUST verify storage accessibility and hydration state consistency, returning actionable results.
- **Rationale**: IndexedDB corruption or clearing causes silent breakage (GAP-33).
- **Acceptance criteria**:
  - Returns `{ ok: true }` when storage is healthy
  - Returns `{ ok: false, issues: [...], action: "reclone" }` when storage is corrupted
  - Detects inaccessible IndexedDB
  - Detects missing object stores
  - Detects stuck hydration state (hydrating with no active clone)
- **Test vectors**: TV-HEAL-001, TV-HEAL-001N
- **Notes**: `checkHealth()` does NOT auto-recover. Caller decides based on `action` field.

---

## BULK-001 — Bulk Mutation Fallback Strategy
- **Priority**: P2
- **Statement**: Batch mutations with `fallbackToIndividual: true` MUST retry each mutation individually when the batch fails.
- **Rationale**: A single bad record in a batch blocks all records (NEW-05).
- **Acceptance criteria**:
  - Batch of 5 mutations, 1 invalid: 4 succeed, 1 reports error
  - Result includes per-mutation status
  - Works for both remote and offline paths
- **Test vectors**: TV-BULK-001, TV-BULK-001N
- **Notes**: Only applies when the batch as a whole fails. If the batch succeeds, individual retry is not needed.

---

## TAB-001 — Cross-Tab Coordination
- **Priority**: P2
- **Statement**: When `crossTab: true`, the client MUST relay non-silent `mutation_applied` events via BroadcastChannel to other same-origin tabs.
- **Rationale**: Edits in one tab are invisible in others until pull interval fires (NEW-06).
- **Acceptance criteria**:
  - Mutation in Tab A causes signal refresh in Tab B (within ~100ms)
  - Silent mutations are NOT relayed
  - No echo loops (source tab does not process its own messages)
  - BroadcastChannel closed on `client.destroy()`
  - Feature is opt-in (default: disabled)
  - Messages contain only event metadata (resource, ids, action, fields, mutationId)
- **Test vectors**: TV-TAB-001, TV-TAB-001N
- **Notes**: `BroadcastChannel` is not available in all environments (e.g., some WebView contexts). Feature degrades gracefully (no-op if unavailable).

---

## SRCH-001 — Client-Side Search Indexing
- **Priority**: P2
- **Statement**: datafn MUST support a client-side search plugin that builds local search indices from schema `indices.search` fields.
- **Rationale**: Search requires network; no offline search capability (GAP-22).
- **Acceptance criteria**:
  - Local search index built at clone/pull time for configured resources
  - Index updated on local mutations
  - Queries with `search` field routed to local index when hydrated
  - Fallback to remote when not hydrated
  - Index is stored in memory (not persisted to IndexedDB)
- **Test vectors**: TV-SRCH-001, TV-SRCH-001N
- **Notes**: Use MiniSearch for implementation. Bundle size should be minimal (~5KB gzipped).

---

## AUD-001 — Mutation Audit Trail Enrichment
- **Priority**: P2
- **Statement**: Changelog entries MUST include `userId` (when available) and `timestamp` fields.
- **Rationale**: Current changelog lacks audit context (GAP-32).
- **Acceptance criteria**:
  - Changelog entries include `userId` from auth context (if provided)
  - Changelog entries include `timestamp` as ISO 8601 string
  - Existing changelog entries without these fields are not retroactively modified
  - Push still works with enriched changelog entries
- **Test vectors**: TV-AUD-001, TV-AUD-001N
- **Notes**: `userId` comes from the client config's auth context, not from the mutation itself.

---

## IDB-001 — IDB Migration Reliability
- **Priority**: P2
- **Statement**: The IndexedDB `onupgradeneeded` handler MUST use a two-phase approach for schema migrations that require async operations.
- **Rationale**: Current handler performs async cursor iteration in a synchronous callback, which is fragile (GAP-37).
- **Acceptance criteria**:
  - V1 → V2 migration detects v1 schema on open
  - Migration runs as a separate async step before opening v2 database
  - Migration errors are caught and reported (not silently swallowed)
  - If migration fails, the old database is preserved (not deleted)
- **Test vectors**: TV-IDB-001, TV-IDB-001N
- **Notes**: This may require restructuring the storage adapter initialization flow.
