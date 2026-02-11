# Flux → datafn Comprehensive Gap Analysis

**Date**: 2026-02-07  
**Scope**: Full feature-parity audit of Nucleus `client/components/flux/` against `@datafn/*`  
**Method**: Independent line-level source review of both codebases  

Model: Cursor - Claude 4.6 Opus
---

## Executive Summary

datafn provides a strong foundation — schema-driven DFQL, local-first storage with IndexedDB, cursor-based sync engine, offline mutations, reactive signals, extension transport, and a plugin system. However, significant gaps remain before it can fully replace Flux in Nucleus. This audit identifies **38 gaps** across 6 categories, prioritized by migration-blocking severity.

| Priority | Count | Description |
|----------|-------|-------------|
| **P0 – Blocker** | 11 | Cannot migrate without these |
| **P1 – High** | 10 | Major UX/correctness regressions |
| **P2 – Medium** | 10 | Feature gaps that degrade quality |
| **P3 – Low** | 7 | Nice-to-haves, polish, hardening |

---

## Gap Inventory

### P0 — Migration Blockers

#### GAP-01: No KeyValue Store Abstraction

**Flux**: `KeyValueStore<T>` class (kv.store.ts:18-148) — a reactive, auto-persisting, debounced single-object store. Nucleus uses KV stores for user preferences, workspace settings, UI state. Features:
- `set()` with shallow-diff: only changed properties written to persistence (line 98)
- 3-second debounced persist (line 27, 135)
- `loadSeedData()` for first-run defaults (line 84-90)
- `loader()` callback for hydration from persistence (line 63-72)
- `modify()` with configurable debounce/immediate/no-persist modes (line 113-131)
- `previousValue` JSON snapshot for change detection (line 25, 50)
- Global registry: `kvStores: Map<Resource, KeyValueStore>` (line 17)

**datafn**: No equivalent. The `KVSequenceStore` in server sync is for sequence numbers, not application state. DFQL mutations operate on record collections, not singleton objects.

**Impact**: Nucleus KV stores (`local`, `preferences`, `workspace`, etc.) have no migration target. These are the most frequently written stores in the app.

**Recommendation**: Implement a `DatafnKVStore<T>` adapter in `@datafn/client` that:
- Wraps a single-record resource with `id = storeId`
- Exposes `get()`, `set(partial)`, `subscribe()` with Svelte-compatible contract
- Shallow-diffs on `set()` and only persists changed fields
- Supports configurable debounced persistence
- Seeds from a default value on first access
- Integrates with the sync changelog for cloud persistence

---

#### GAP-02: No In-Memory Reactive Store Loading

**Flux**: Resources flagged `isInMemory: true` (e.g., `linkTag`, `tz`) are loaded into Svelte `writable<T[]>()` stores at boot via `loadInMemoryStores()` (flux.ts:152-189). The `loaderCallback` pattern hydrates these stores and re-loads them after every mutation or sync-down (flux.ts:285-288, 909-912).

**datafn**: Signals are lazy — they fetch on first subscription and auto-refresh on mutations. But there is no mechanism to eagerly load a full dataset into a reactive store at initialization and keep it warm.

**Impact**: Components that rely on always-available in-memory data (link tags, time zones, finite collections) would need to add loading states or accept initial blank frames.

**Recommendation**: Add an `eagerLoad` or `isInMemory` flag to resource schema config. At `sync.start()` or after clone, pre-fetch these resources into signals and keep them hot. Consider a `client.preload(resources[])` API.

---

#### GAP-03: No ResourceStore Class Equivalent

**Flux**: `ResourceStore<T, C>` (resource.store.ts:164-736) is a full-featured CRUD controller per resource type. It provides:
- `create()` with auto-generated IDs, `createdAt/modifiedAt/createdBy/modifiedBy` stamping (line 222-251)
- `modify()` with immediate back-propagation to active stores (line 296-326)
- `trash()` / `restore()` / `archive()` / `unarchive()` with cascade hooks (lines 346-460)
- `bulkModify()` / `bulkTrash()` / `deleteMany()` (lines 464-501)
- `toggleLock()` (line 504-511)
- `selectMany()` with post-query filtering (active/archived/trash) (lines 524-631)
- Per-key debounced persistence via `resolveDebouncerForPersist()` (line 284-293)
- Extension environment delegation (every method checks `isExtensionEnvironment`)
- Singleton resolution via `static resolve(resource)` (line 726-735)

**datafn**: `createTable()` (table.ts:44-165) provides a thin handle with `query()`, `mutate()`, `signal()`, `subscribe()`, `transact()`. No CRUD helpers, no timestamp stamping, no soft-delete, no debouncing, no post-query filtering.

**Impact**: Every Nucleus store (NodeStore, CollectionStore, TaskStore, etc.) extends ResourceStore. Migration requires either reimplementing these patterns per-store or building an equivalent abstraction in datafn.

**Recommendation**: Build a `ResourceStoreAdapter` or enhance `createTable()` with:
- `table.insert(data)` / `table.merge(id, partial)` / `table.delete(id)` convenience methods
- Auto-stamping of `createdAt/modifiedAt/createdBy/modifiedBy` via a plugin or table config
- Soft-delete pattern support (trash/archive/restore as configurable behaviors)
- Debounced mutation option (per-record-key debouncing)

---

#### GAP-04: No ActiveResourceStore (Per-Record Reactive Wrapper)

**Flux**: `ActiveResourceStore<T>` (resource.store.ts:50-159) wraps a single record in a Svelte `writable`, providing:
- Immediate reactive updates on `modify()` (back-propagation, line 319-326)
- UI-only state toggles: `toggleEditMode()`, `toggleReadMode()` (line 104-112)
- Singleton cache: `activeResources = new Map()` (line 45), `static resolve(id)` (line 131-141)
- `static destroy(id)` for cleanup (line 143-157)
- `resolveExportContent()` for clipboard (line 117-119)

**datafn**: No per-record reactive wrapper. Signals operate at the query level, not the individual record level.

**Impact**: Nucleus's editor experience depends on `ActiveResourceStore` for instant reactivity on the currently-open record. Without it, every keystroke would need to round-trip through a query signal refresh.

**Recommendation**: Implement a `RecordSignal<T>` that:
- Wraps a single record by ID in a reactive container
- Supports optimistic local mutations with immediate subscriber notification
- Caches instances by record ID with `resolve(id)` / `destroy(id)` lifecycle
- Supports transient UI state (edit mode, focus mode) without persistence

---

#### GAP-05: No Debounced Mutations

**Flux**: Two debouncing layers:
1. `ResourceStore`: per-record-key 1500ms debouncers via `resolveDebouncerForPersist()` (resource.store.ts:284-293)
2. `KeyValueStore`: global 3000ms debounced persist via `_debouncedPersist` (kv.store.ts:27, 135)

Both prevent write amplification during rapid editing (e.g., typing in a document, adjusting settings).

**datafn**: No debouncing anywhere in `client/src/`. Every `mutate()` call immediately writes to storage and appends to changelog. The push engine uses a fixed interval but individual writes are not debounced.

**Impact**: Without debouncing, rapid edits generate one mutation per keystroke → one changelog entry per keystroke → excessive sync traffic and IndexedDB write pressure. This is a major performance regression for editor-heavy apps.

**Recommendation**: Add a `debounce` option to `table.mutate()` or a `debouncedMerge(id, partial, opts)` method. The debouncer should:
- Be keyed by record ID (not global) to avoid blocking writes to different records
- Coalesce partial merges within the debounce window
- Flush on explicit request or component unmount
- Be configurable per-table or per-call (default 1500ms)

---

#### GAP-06: No Data Mapper / Field Transformation Layer

**Flux**: `DataMapper` (dataMapper.ts:10-91) processes every record flowing through sync:
- **Date parsing**: Converts string `createdAt`, `modifiedAt`, `date`, `startDate`, `endDate` fields to `Date` objects (line 56-75)
- **ID normalization**: Ensures all IDs follow `resource:uuid` format (line 47)
- **Encryption stubs**: Framework for field-level encrypt/decrypt (lines 11-14, 28-30, 84-90)

Applied on every `processSyncDown`, `processCloneDown`, and `select`/`selectMany` return.

**datafn**: No runtime field transformation. Records are stored and returned as-is. Date fields remain strings. No ID normalization. No encryption hooks.

**Impact**: Nucleus code assumes `record.createdAt instanceof Date`. Without automatic date parsing, every consumer would need manual coercion. ID format inconsistencies would cause lookup failures.

**Recommendation**: Implement a `DataMapper` plugin or middleware in `@datafn/client`:
- Auto-coerce `date` type fields (from schema) to `Date` objects on read
- Normalize ID formats based on resource schema
- Support field-level encryption/decryption via schema `encrypt` flag
- Run on all query results and sync-down data

---

#### GAP-07: No Reconciliation Workflow

**Flux**: `reconcile()` (flux.ts:1245-1288) compares per-resource local record counts against cloud counts. For any resource where local < cloud, it re-clones the missing records. Triggered on large sync-down detection (flux.ts:857-859).

**datafn**: No reconciliation. Sync relies entirely on cursor-based pull. If records are missed (network errors, storage corruption, bugs), they remain missing indefinitely.

**Impact**: Data loss scenario — if a pull partially fails or IndexedDB storage is corrupted, there's no self-healing mechanism.

**Recommendation**: Implement `sync.reconcile()` that:
- Compares local record counts or checksums per resource against server
- Identifies and re-clones missing records
- Can be triggered manually or automatically after detecting sync anomalies
- Runs as a background operation without blocking the UI

---

#### GAP-08: No Two-Tier Clone Priority (FIR/IFR)

**Flux**: Resources are classified as:
- **FIR (Finite)**: Collections, properties, views — small datasets cloned first at boot (resource.config.ts)
- **IFR (Infinite)**: Nodes, tasks, sessions — large datasets paginated after essentials are ready

`initializeEssentialDataForCloudUser()` (flux.ts:1132-1161) clones FIR first, then IFR boot resources, enabling the app to render before all data arrives.

**datafn**: `SyncEngine.cloneNow()` (engine.ts:188-212) clones all non-remote-only resources sequentially with no priority ordering.

**Impact**: App boot time regression. Users see a blank screen until ALL resources are cloned, instead of seeing a functional UI after essential data loads.

**Recommendation**: Add resource priority to schema config (`clonePriority: "essential" | "deferred"` or numeric). Clone engine should:
1. Clone essential resources first
2. Emit a `ready` event after essentials complete
3. Clone deferred resources in background
4. Support pagination for large resources during clone

---

#### GAP-09: Local-Only Mode (Anonymous / No-Auth)

**Flux**: `isLocalMode = true` when no `userId` (flux.ts:71). In local mode:
- Mutations persist locally without creating sync mutation records (flux.ts:261-263)
- Sync operations are skipped entirely
- The app functions as a fully offline tool

**datafn**: `clientId` is required for mutations (mutate.ts:42-44). Storage factory resolution rejects missing `userId` (client.ts:225-229). Offlinability requires both storage AND sync config.

**Impact**: Cannot support anonymous/offline-first users who haven't signed up. This is a core Nucleus use case — users can use the app locally before creating an account.

**Recommendation**: Support a `localOnly` mode in client config that:
- Allows mutations without `userId` / `authContext`
- Skips changelog entries (no sync needed)
- Disables sync engine entirely
- Allows later upgrade to synced mode via `cloneUp()` when user signs up

---

#### GAP-10: Client Destroy / Cleanup

**Flux**: `terminate()` (flux.ts:1545) invalidates persistence; `clear()` (flux.ts:1555) deletes all IndexedDB databases.

**datafn**: No `destroy()`, `close()`, or `clear()` method on the client. The sync engine has `stop()` but:
- WebSocket connections are not reconnected (TODO at engine.ts:147)
- Event bus subscriptions leak (querySignal.ts:126 — unsubscribe never called)
- IndexedDB connections are never closed
- Push interval is cleared but visibility listener cleanup is fragile

**Impact**: Memory leaks in long-running sessions. Hot-reload during development leaks resources. Multi-user apps cannot cleanly switch between users.

**Recommendation**: Add `client.destroy()` that:
- Calls `syncEngine.stop()`
- Closes WebSocket connection
- Clears all signal subscriptions and event bus handlers
- Closes IndexedDB connection
- Nullifies all references for GC
- Also add `client.clear()` for full data wipe

---

#### GAP-11: Schema Validation Bug — Not Thrown

**Flux**: N/A (Flux doesn't validate schemas at init).

**datafn**: `client.ts:151` creates a `ClientError` on schema validation failure but **does not throw it**. Invalid schemas silently pass through.

**Impact**: Misconfigured schemas produce cryptic downstream errors instead of a clear validation failure at initialization.

**Recommendation**: Fix `client.ts:151` to `throw createClientError(...)` instead of bare `createClientError(...)`.

---

### P1 — High Priority

#### GAP-12: Coarse Signal Invalidation

**Flux**: `loadInMemoryStores()` reloads only the specific resource that was mutated (flux.ts:285-288). ActiveResourceStore back-propagation updates only the affected record.

**datafn**: `querySignal.ts:126-131` subscribes to `mutation_applied` events and refreshes when the event's `resource` matches. This means ANY mutation to ANY record in the resource triggers ALL signals for that resource to re-fetch — even if the query's filter would exclude the mutated record.

**Impact**: Write amplification. Modifying one task re-fetches every task-related query signal, causing unnecessary re-renders and network/storage I/O.

**Recommendation**: Implement selective invalidation:
- Compare mutation's `affectedIds` against the signal's cached result IDs
- Compare mutation's `fields` against the signal's `select`/`omit`/`filters`
- Only refresh if the mutation could plausibly affect the query result
- Add `signal.invalidate()` for manual control

---

#### GAP-13: No Soft-Delete / Trash / Archive Pattern

**Flux**: First-class support:
- `trash(id)`: Sets `trashInformation` field (resource.store.ts:346-367)
- `restore(id)`: Clears `trashInformation` (resource.store.ts:424-435)
- `archive(id)` / `unarchive(id)`: Sets/clears `isArchived` (lines 394-421)
- Cascade hooks: `onTrash()`, `onRestore()`, `onArchive()`, `onUnarchive()` for child propagation
- Post-query filtering: `activeResourceFilter`, `archivedResourceFilter` (resource.store.ts:603-631)

**datafn**: No built-in soft-delete. `delete` operation is permanent. No archive concept. No cascade hooks.

**Impact**: Nucleus relies heavily on trash/restore for undo-delete. Archive is used for completed goals/tasks. Without this, migration requires custom per-store implementation.

**Recommendation**: Add soft-delete support via:
- Schema-level `softDelete: true` flag on resources
- Auto-add `trashedAt` / `archivedAt` fields
- `table.trash(id)` / `table.restore(id)` / `table.archive(id)` convenience methods
- Auto-filter trashed/archived records from default queries (configurable)
- `afterMutation` plugin hook for cascading to related resources

---

#### GAP-14: No Back-Propagation on Mutations

**Flux**: `ResourceStore.modify()` immediately updates the `ActiveResourceStore` writable BEFORE persisting (resource.store.ts:319-326). The UI updates on the same tick as the mutation call.

**datafn**: Mutations write to storage → emit `mutation_applied` → signal re-fetches from storage → UI updates. This is a multi-tick async round-trip.

**Impact**: Perceptible lag on every edit. In Flux, typing in the editor updates the title bar instantly. In datafn, there's a flash of stale data.

**Recommendation**: Implement optimistic signal updates:
- When `mutation_applied` is emitted, immediately patch the signal's cached value with the mutation data (without re-fetching)
- Fall back to full re-fetch only when the patch can't be applied (e.g., mutation affects sort order or filter criteria)
- Support `isPreventBackPropagation` flag for batched operations

---

#### GAP-15: No Extension Environment Deep Integration

**Flux**: Every mutation path checks `isExtensionEnvironment` (flux.ts:266-277) and routes through `extensionFlux` → `relayToSidePanel` / `relayToContentScript` / `relayToBackgroundScript`. The `fluxExtentionMediator.ts` (183 lines) provides a full message-passing bridge for every Flux method.

**datafn**: Has `client/src/extension/transport.ts` with a generic `createExtensionTransport(bus)` that wraps all DFQL operations over a `MessageBus`. This is architecturally cleaner but:
- Not deeply integrated into the mutation/query paths — it's an alternative `DatafnRemoteAdapter`, not a bifurcation of the local path
- No equivalent of `delegateToFlux()` which handles INIT_FLUX, CLONE_DOWN, SYNC_DOWN, RECONCILE
- No automatic relay of events between extension contexts

**Impact**: Extension environments in Nucleus (sidebar, content script, popup) all share a single Flux instance in the background script. datafn's transport layer doesn't cover initialization, sync orchestration, or event relay between contexts.

**Recommendation**: Extend the extension transport to support:
- Lifecycle operations: init, clone, sync start/stop
- Event relay: broadcast `mutation_applied` / `sync_applied` events across all extension contexts
- Singleton orchestration: ensure only one context owns the sync engine
- Consider a `DatafnExtensionHost` / `DatafnExtensionClient` pair

---

#### GAP-16: No Data Export / Import

**Flux**: `export()` (flux.ts:1579-1588) reads all sync resources into a JSON object. `import(data)` (flux.ts:1592-1654) writes data per resource, clones up, reloads stores, dispatches events.

**datafn**: No export or import functionality exists.

**Impact**: Users cannot back up or restore their data. Migration between devices without cloud requires manual data transfer.

**Recommendation**: Add `client.exportData()` and `client.importData(data)` that:
- Export all local records as a structured JSON object (keyed by resource)
- Import with upsert semantics (merge into existing data)
- Optionally trigger `cloneUp()` after import for cloud users
- Support filtering by resource

---

#### GAP-17: WebSocket Reconnection Not Implemented

**Flux**: N/A (Flux doesn't use WebSockets — sync is poll-based).

**datafn**: `SyncEngine.connectWs()` (engine.ts:105-151) connects a WebSocket for real-time pull triggers. The `onclose` handler has a comment "Reconnect logic could go here" (engine.ts:147) but **does nothing**. On disconnect, real-time sync silently degrades to push-interval-only.

**Impact**: Any network interruption permanently disables real-time sync for the session. Users must refresh the page to restore WebSocket connectivity.

**Recommendation**: Implement reconnection with exponential backoff:
- On close: reconnect after 1s, 2s, 4s, 8s… up to 60s max
- On connect: re-send `hello` with current cursor
- Track connection state for UI indicator
- Jitter to prevent thundering herd

---

#### GAP-18: No Exponential Backoff on Sync Retries

**Flux**: Sync-up retries are limited to 10 batch iterations (flux.ts:687-735), which provides implicit rate limiting.

**datafn**: `pushWithRetries()` (engine.ts:328-368) retries immediately on failure with no delay between attempts. A failing server gets hammered with rapid retries.

**Impact**: Server overload during outages. Network congestion. Wasted battery on mobile.

**Recommendation**: Add configurable exponential backoff to push retries:
- Base delay: 1s, multiplier: 2, max delay: 60s
- Add jitter (0-500ms random)
- Reset backoff on successful push

---

#### GAP-19: Batch Offline Fallback Not Implemented

**Flux**: Batch operations (`BULK_MERGE`, `BULK_DELETE`, `BULK_INSERT`) work offline via the mutation queue (flux.ts:349-350, 421-438, 554-574).

**datafn**: `mutate.ts:153` explicitly notes "batch offline fallback not scope of P21". When a batch mutation fails remotely, it throws instead of falling back to offline.

**Impact**: Bulk operations (e.g., bulk trash, bulk tag) fail entirely when offline instead of queuing for later sync.

**Recommendation**: Implement batch offline fallback by iterating `handleOfflineMutation()` for each mutation in the batch. Ensure atomicity semantics are documented (batch may partially apply locally).

---

#### GAP-20: Offline Mutations Don't Handle Relations/Joins

**Flux**: Mutations include full relation context (link `in`/`out` fields) which are persisted locally (flux.ts processCloneDown normalizes these).

**datafn**: `handleOfflineMutation()` (offline/mutate.ts:20-85) only operates on the record store. Many-many join rows, FK updates, and relation mutations (`relate`, `unrelate`, `modifyRelation`) are not applied to local storage.

**Impact**: Offline relation changes (e.g., linking a task to a goal, tagging a node) are lost from local state until the next sync pull.

**Recommendation**: Extend `handleOfflineMutation()` to handle:
- `relate`: Write to join store
- `unrelate`: Delete from join store
- `modifyRelation`: Update join row metadata
- FK field updates in the record store for many-one relations

---

#### GAP-21: Non-Atomic Read-Modify-Write in Offline Merge

**Flux**: Persistence layer handles atomicity at the IndexedDB transaction level.

**datafn**: `handleOfflineMutation()` for `merge` operations (offline/mutate.ts:60-70) reads with `getRecord()`, merges in JS, then writes with `upsertRecord()` — in separate IndexedDB transactions. A concurrent write between read and write would be silently overwritten.

**Impact**: Data corruption under concurrent mutation scenarios (multiple tabs, extension contexts, or rapid user actions).

**Recommendation**: Implement read-modify-write within a single IndexedDB transaction, or add a `mergeRecord(id, partial)` method to the storage adapter that does it atomically.

---

### P2 — Medium Priority

#### GAP-22: No FlexSearch / Client-Side Search Indexing

**Flux**: `index()` (flux.ts:1204-1220) triggers background FlexSearch indexing for fields declared in `searchIndices`. Enables instant local full-text search without server roundtrip.

**datafn**: Schema supports `indices.search` field declarations. Server has a `searchfn` plugin stub. But there is no client-side search index — all search queries go to remote.

**Impact**: Search requires network connectivity and has latency. No offline search capability.

**Recommendation**: Integrate client-side search (FlexSearch, MiniSearch, or similar):
- Build indices from `indices.search` schema fields
- Update indices on local mutations
- Route search queries to local index when hydrated
- Fall back to remote when not hydrated or for vector/semantic search

---

#### GAP-23: No DOM-Based Sync Status Propagation

**Flux**: `propagateSyncStatus()` (flux.ts:1290-1304) directly updates DOM elements with `data-syncfeedback="true"` via `data-syncstatus` attributes. This bypasses the reactive system for global sync indicators.

**datafn**: Emits `sync_applied` / `sync_failed` events via the event bus. No built-in UI feedback mechanism.

**Impact**: Nucleus's sync feedback indicators (per-resource loading spinners) need to be reimplemented using the event bus.

**Recommendation**: This is acceptable as-is — datafn's event bus is the correct architectural approach. Document the event-based pattern for building sync indicators. Optionally add a `client.syncStatus` reactive signal that aggregates per-resource sync state.

---

#### GAP-24: Hardcoded Pull Batch Size

**Flux**: Clone down limit is configurable via `CLONE_DOWN_LIMIT` env var (default 500, flux.ts:79-80). Sync up limit via `VITE_SYNC_UP_LIMIT` (default 20, flux.ts:763).

**datafn**: Pull batch size is hardcoded to `limit: 100` (engine.ts:231). Push batch size is configurable. Clone has no pagination.

**Impact**: Pull performance cannot be tuned for different network/data conditions. Clone of large datasets may timeout or cause memory pressure.

**Recommendation**: Make pull batch size configurable in `DatafnSyncConfig`. Add pagination support to clone for large resources.

---

#### GAP-25: No `isRemoteOnly` Query Routing

**Flux**: Resources flagged `isRemoteOnly` (e.g., `vector`, `accessLog`) are always queried via API, never stored locally (flux.ts:395-404, 443-457).

**datafn**: Schema supports `isRemoteOnly` on resources (core/src/types.ts). The clone engine skips these (engine.ts:192). But query routing (query.ts:68) only checks `isRemoteOnly` on the resource definition — it needs to also skip hydration checks and always route to remote.

**Impact**: Remote-only resources work but the routing logic should be verified end-to-end.

**Recommendation**: Audit and test the full `isRemoteOnly` path: schema declaration → clone skip → query routing → mutation handling. Ensure remote-only resources never write to local storage.

---

#### GAP-26: No AbortSignal Support for Queries

**Flux**: `select()` and `selectMany()` support `AbortSignal` for cancellation (flux.ts:388-390, 437-439).

**datafn**: No `AbortSignal` support in `executeQuery()` or the remote adapter.

**Impact**: Long-running queries cannot be cancelled. Navigation away from a page continues to process abandoned requests.

**Recommendation**: Add optional `signal?: AbortSignal` to `DfqlQuery` and propagate through the remote adapter's `fetch()` calls.

---

#### GAP-27: Event Bus Error Isolation

**Flux**: Uses DOM `CustomEvent` dispatch which isolates handler errors.

**datafn**: `EventBus.emit()` (bus.ts:46-52) iterates handlers with no try-catch. A throwing handler aborts delivery to remaining handlers.

**Impact**: A buggy event subscriber can break mutation event delivery, preventing signal refresh and sync scheduling.

**Recommendation**: Wrap each handler invocation in try-catch within `emit()`. Log errors but continue delivery.

---

#### GAP-28: Signal Memory Leak

**datafn**: `createQuerySignal()` (querySignal.ts:126) subscribes to the event bus but never stores or calls the unsubscribe function. Signals persist in the `SignalRegistry` map indefinitely.

**Impact**: Memory grows monotonically as the user navigates to different views that create new signals. Event bus handler list grows, slowing all event delivery.

**Recommendation**: 
- Track subscriber count in signals
- When subscriber count drops to zero, start a grace period (e.g., 30s)
- If still zero subscribers after grace period, unsubscribe from event bus and remove from registry
- Alternatively, support explicit `signal.dispose()` tied to component lifecycle

---

#### GAP-29: Double Event Emission on Offline Fallback

**datafn**: When a remote mutation fails with a transport error (mutate.ts:137-180):
1. `emitRejectionForError()` emits `mutation_rejected` (line 137-148)
2. Offline fallback succeeds
3. `emitMutationEvents()` emits `mutation_applied` (line 180)

Consumers see both rejection and acceptance for the same mutation.

**Impact**: UI flicker — error toast appears then immediately disappears. Signal refreshes twice.

**Recommendation**: Don't emit `mutation_rejected` until offline fallback has been attempted. Only emit rejection if both remote AND offline paths fail.

---

#### GAP-30: Plugin Hooks Skipped on Offline Fallback Path

**datafn**: When a remote mutation fails and falls back to offline (mutate.ts:155-176), `afterMutation` plugin hooks are not run on the offline result.

**Impact**: Plugins that depend on `afterMutation` (e.g., analytics, audit logging, search index updates) miss offline mutations entirely.

**Recommendation**: Run `afterMutation` hooks on the offline mutation result, just as the local-first path does (mutate.ts:91-93).

---

#### GAP-31: Shallow Merge Only in Offline Mutations

**Flux**: Persistence layer handles deep merge at the IndexedDB/Dexie level.

**datafn**: `handleOfflineMutation()` merge (offline/mutate.ts:64) uses `{ ...existing, ...record }` — a one-level shallow merge. Nested objects are overwritten entirely.

**Impact**: Updating a single property in a nested object (e.g., `preferences.theme = "dark"`) overwrites the entire `preferences` object, losing sibling properties.

**Recommendation**: Implement deep merge or dot-path merge for offline `merge` operations. At minimum, support one-level-deep merge for known object fields.

---

### P3 — Low Priority

#### GAP-32: No Mutation-Level Audit Trail

**Flux**: `insertMutation()` (flux.ts:320-342) creates detailed mutation records with `userId`, `timestamp`, `resource`, `resourceId`, `action`, and full `params`. This serves as both a sync queue and an audit log.

**datafn**: Changelog entries contain `clientId`, `mutationId`, `resource`, `operation`, `record` data. Less structured than Flux's mutation records.

**Impact**: Audit/versioning capabilities are reduced. Difficult to answer "who changed what when" from the changelog alone.

**Recommendation**: Enrich changelog entries with `userId` (from auth context) and structured action metadata. Consider a separate audit log that persists after changelog entries are ACK'd.

---

#### GAP-33: No `reinitializeIfRequired()` Self-Healing

**Flux**: `reinitializeIfRequired()` (flux.ts:1532) checks if the `local` KV record exists; if not, reinitializes persistence. Also reinitializes on sync-up when `local` is missing (flux.ts:668).

**datafn**: No self-healing for corrupted or missing persistence state.

**Impact**: If IndexedDB is cleared (browser settings, storage pressure), the app silently breaks instead of recovering.

**Recommendation**: Add a health check on sync start that verifies storage integrity. If corrupted, trigger a fresh clone.

---

#### GAP-34: No `cloneUp` Progress / Pagination

**Flux**: `cloneUp()` (flux.ts:1485-1524) iterates all sync resources and pushes entire tables to cloud.

**datafn**: `cloneUp()` in `client/src/sync/cloneUp.ts` exists and is more sophisticated (batched, hash-based idempotency, deterministic ordering). This is **better than Flux**.

**Impact**: None — datafn's implementation is superior. No gap.

**Recommendation**: No action needed. datafn's cloneUp is already more robust.

---

#### GAP-35: `generateMutationId()` Collision Risk

**datafn**: `mutate.ts:22` uses `Date.now() + Math.random().toString(36).slice(2)` for mutation IDs. `Math.random()` has limited entropy and `Date.now()` has millisecond resolution.

**Impact**: In high-throughput scenarios (batch mutations, multiple tabs), ID collisions are theoretically possible.

**Recommendation**: Use `crypto.randomUUID()` with fallback, consistent with the client's `generateId` function.

---

#### GAP-36: `setHydrationState` Race Condition

**datafn**: `IndexedDbStorageAdapter.setHydrationState()` (indexedDbStorage.ts:478-491) reads current state in one transaction, then writes in another. Concurrent calls could read stale state.

**Impact**: During rapid clone/sync operations, hydration state could be incorrectly set (e.g., two concurrent clones both read `notStarted` and both proceed).

**Recommendation**: Combine read + validate + write into a single IDB transaction using a `readwrite` mode.

---

#### GAP-37: V1→V2 IndexedDB Migration Reliability

**datafn**: The `onupgradeneeded` handler in `indexedDbStorage.ts:113-247` performs async cursor iteration inside a synchronous callback. Comments acknowledge this is fragile (lines 228-239).

**Impact**: Users upgrading from v1 storage schema may experience data loss.

**Recommendation**: Test the migration path thoroughly. Consider a two-phase approach: detect v1 on init, run migration as a separate async step before opening the v2 database.

---

#### GAP-38: No Configurable Clone Pagination

**Flux**: Clone down supports pagination with configurable limit (500 default, flux.ts:79-80). V2 uses cursor-based pagination (flux.ts:1095-1125).

**datafn**: `SyncEngine.cloneNow()` requests all data per resource without pagination (engine.ts:196-200). Server `executeClone()` returns full datasets.

**Impact**: Large datasets (10k+ records per resource) may cause timeouts or memory exhaustion during initial clone.

**Recommendation**: Add cursor-based pagination to clone:
- Server: support `limit`/`cursor` in clone request
- Client: loop until all pages received
- Progress events for UI feedback

---

## Cross-Cutting Concerns

### Items datafn Does Better Than Flux

| Feature | datafn Advantage |
|---------|-----------------|
| **Schema-driven** | Declarative schema with validation, vs Flux's loose config |
| **DFQL query language** | Rich filter operators, aggregations, relation expansion — Flux has raw persistence calls |
| **Plugin system** | Lifecycle hooks (before/after query/mutation/sync) — Flux has none |
| **Cursor-based sync** | Monotonic `serverSeq` ordering vs Flux's timestamp-based approach |
| **Type safety** | Generic types on client, table handles — Flux uses loose `any` types |
| **Multi-tenant isolation** | `createForUser()` storage factory with namespace isolation |
| **Transaction support** | Atomic multi-step `transact()` — Flux has no equivalent |
| **Relation system** | First-class many-one, one-many, many-many, htree with DFQL expansion |
| **cloneUp** | Batched, hash-based idempotent, deterministically ordered |
| **Server runtime** | Full HTTP server with auth, idempotency, REST generation |
| **Framework agnostic** | Not tied to Svelte — signal interface is generic |

### Migration Strategy Recommendations

1. **Phase 0**: Fix P0 blockers (GAP-01 through GAP-11) before attempting any migration
2. **Phase 1**: Build a Flux compatibility shim that wraps datafn's table API with ResourceStore/KeyValueStore interfaces
3. **Phase 2**: Migrate one simple resource (e.g., `property` or `view`) end-to-end as a proof of concept
4. **Phase 3**: Migrate remaining resources incrementally, starting with FIR then IFR
5. **Phase 4**: Remove the compatibility shim and migrate to native datafn patterns
6. **Phase 5**: Remove Flux entirely

### Estimated Effort

| Priority | Estimated Dev-Weeks |
|----------|-------------------|
| P0 Blockers | 6–8 weeks |
| P1 High | 3–4 weeks |
| P2 Medium | 2–3 weeks |
| P3 Low | 1–2 weeks |
| **Total** | **12–17 weeks** |

---

## Appendix: Feature Matrix

| Feature | Flux | datafn | Gap? |
|---------|------|--------|------|
| Schema validation | No | Yes | datafn better |
| DFQL query language | No (raw persistence) | Yes | datafn better |
| KeyValue stores | Yes (KV class) | No | **P0** |
| In-memory reactive stores | Yes (isInMemory) | No | **P0** |
| ResourceStore CRUD class | Yes (full) | Partial (thin table) | **P0** |
| ActiveResourceStore (per-record) | Yes | No | **P0** |
| Debounced mutations | Yes (per-key) | No | **P0** |
| Data mapper / field transform | Yes (dates, IDs, encrypt) | No | **P0** |
| Reconciliation | Yes | No | **P0** |
| Clone priority (FIR/IFR) | Yes | No | **P0** |
| Local-only mode | Yes | No | **P0** |
| Client destroy/cleanup | Yes | No | **P0** |
| Schema validation throw | N/A | Bug | **P0** |
| Signal invalidation granularity | Fine (per-record) | Coarse (per-resource) | **P1** |
| Soft-delete / trash / archive | Yes | No | **P1** |
| Back-propagation (instant UI) | Yes | No | **P1** |
| Extension deep integration | Yes (bifurcated paths) | Partial (transport only) | **P1** |
| Data export/import | Yes | No | **P1** |
| WebSocket reconnection | N/A | TODO | **P1** |
| Sync retry backoff | Implicit | No | **P1** |
| Batch offline fallback | Yes | No | **P1** |
| Offline relation/join handling | Yes | No | **P1** |
| Atomic offline merge | Yes | No | **P1** |
| Client-side search indexing | Yes (FlexSearch) | No | **P2** |
| Sync status UI feedback | Yes (DOM) | Partial (events) | **P2** |
| Configurable pull batch size | Yes | No (hardcoded 100) | **P2** |
| isRemoteOnly routing | Yes | Partial | **P2** |
| AbortSignal on queries | Yes | No | **P2** |
| Event bus error isolation | Yes (DOM events) | No | **P2** |
| Signal memory leak | N/A | Yes (leak) | **P2** |
| Double event on fallback | N/A | Yes (bug) | **P2** |
| Plugin hooks on fallback | N/A | Skipped | **P2** |
| Deep merge offline | Yes | No (shallow only) | **P2** |
| Mutation audit trail | Yes (rich) | Basic (changelog) | **P3** |
| Self-healing persistence | Yes | No | **P3** |
| Clone pagination | Yes (cursor-based) | No | **P3** |
| Mutation ID entropy | N/A | Low | **P3** |
| Hydration state atomicity | N/A | Race condition | **P3** |
| IDB migration reliability | N/A | Fragile | **P3** |
| Plugin system | No | Yes | datafn better |
| Cursor-based sync | Timestamp-based | Yes (serverSeq) | datafn better |
| Transaction support | No | Yes | datafn better |
| Relation system | Manual (links table) | First-class DFQL | datafn better |
| Multi-tenant isolation | No | Yes | datafn better |
| Type safety | Loose | Generic types | datafn better |
| Framework agnostic | No (Svelte) | Yes | datafn better |

---

*End of gap analysis.*
