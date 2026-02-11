# SPEC: datafn Audit Gap Resolution

## Metadata
- **timestamp**: 2026-02-11T20:30:00Z
- **agent_name**: unknown-agent
- **model**: Claude 4.6 Opus (high thinking)
- **launcher**: Cursor
- **workspace_root**: /Users/ar/dev
- **project_root**: /Users/ar/dev/superfunctions/datafn
- **OS**: darwin (macOS), shell: zsh
- **repo**:
  - is_git_repo: true
  - branch: next
  - commit: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - dirty: true (419 modified files)
- **spec_folder**: `2026-02-11-audit-fix-r9k4m7x2-spec`
- **spec_folder_path**: `/Users/ar/dev/superfunctions/datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec`
- **spec_type**: `audit-fix`
- **spec_id**: `r9k4m7x2`
- **input_paths**:
  - `.conduct/audits/2026-02-11-nucleus-migration-gap-status-audit.md` (primary audit)
  - `.conduct/audits/2026-02-07-flux-datafn-comprehensive-gap-analysis.md`
  - `.conduct/audits/2026-02-06-nucleus-gap-analysis-t2.md`
  - `.conduct/audits/flux-to-datafn-migration-gap-analysis.md`
  - `.conduct/audits/2026-02-09-x7m3k9p2-full-audit.md`
  - `.conduct/intent/datafn.intent.md`
  - `.conduct/intent/implementation.md`
  - `.conduct/intent/migration-plan-from-nucleus.md`
- **audit_reference**: `.conduct/audits/2026-02-11-nucleus-migration-gap-status-audit.md`
- **related_spec**: `2026-02-06-audit-fix-k4m2p9x7-spec` (prior audit-fix spec, partially complete)

---

## Overview

This spec addresses **all remaining open and partially-resolved gaps** identified across four sequential gap analyses of the datafn codebase against the Nucleus Flux implementation. The audit dated 2026-02-11 consolidated 38 previously flagged gaps and 6 newly identified gaps, finding 17 still open, 4 partially resolved, and 6 new. This spec covers all 27 items, plus resolution of 33 pre-existing test failures.

The work is organized into 20 phases, sequenced so that foundational items (test fixes, event bus hardening, lifecycle management) come first, enabling later phases (debouncing, signal improvements, offline enhancements) to build on stable infrastructure.

---

## Glossary

| Term | Definition |
|------|-----------|
| **DFQL** | Data Function Query Language — the JSON-based query/mutation protocol used by datafn |
| **Signal** | A reactive query result container that auto-refreshes when relevant mutations occur |
| **Footprint** | The set of resource names a signal depends on, used for invalidation matching |
| **EventBus** | The in-process pub/sub event system in `@datafn/client` |
| **Changelog** | The local append-only log of mutations pending sync via push |
| **SyncEngine** | The client module managing clone/pull/push/reconcile operations |
| **KV** | Key-Value store — a built-in resource for singleton/settings data |
| **Debounce** | Delaying execution until a quiet period has elapsed, coalescing rapid calls |
| **Back-propagation** | Immediately patching a signal's cached value from mutation data without re-fetching |
| **Silent mutation** | A mutation that applies locally but does not emit events (suppresses signal refresh) |
| **BroadcastChannel** | Browser API for same-origin cross-tab messaging |
| **Exponential backoff** | Retry strategy where delay doubles on each failure (with optional jitter) |
| **Jitter** | Random offset added to retry delays to prevent thundering herd |
| **Soft-delete** | Marking a record as deleted (via field) instead of physically removing it |
| **Deep merge** | Recursive merging of nested objects, preserving sibling properties at each level |
| **Atomic merge** | A read-modify-write operation executed in a single storage transaction |

---

## Goals

1. Resolve all 17 OPEN gaps from the 2026-02-11 audit
2. Complete all 4 PARTIALLY resolved gaps
3. Implement all 6 NEWLY identified gaps
4. Fix all 33 pre-existing test failures (14 client + 19 server)
5. Achieve production-readiness for Nucleus migration

## Non-Goals

1. Nucleus refactoring (Phase 13 of prior spec `2026-02-06-audit-fix-k4m2p9x7-spec`) — remains a separate effort
2. ResourceStore / ActiveResourceStore wrappers — by-design decision; Nucleus builds its own
3. GraphQL generation — deferred per implementation.md
4. Schema migration generation (diffing) — separate tooling effort
5. Vector/semantic search — server-side only, out of scope for client search

---

## Public API

### New Client Configuration Options

```typescript
interface DatafnSyncConfig {
  // ... existing fields ...
  pullBatchSize?: number;       // Default: 200. Configurable pull limit per request.
  pushRetryBackoff?: {
    baseDelayMs?: number;       // Default: 1000
    maxDelayMs?: number;        // Default: 60000
    multiplier?: number;        // Default: 2
    jitterMs?: number;          // Default: 500
  };
  wsReconnect?: {
    enabled?: boolean;          // Default: true
    baseDelayMs?: number;       // Default: 1000
    maxDelayMs?: number;        // Default: 60000
    multiplier?: number;        // Default: 2
    jitterMs?: number;          // Default: 500
  };
}
```

### New Client Methods

```typescript
interface DatafnClient {
  // ... existing methods ...

  /** Tear down client: stop sync, close connections, unsubscribe all, release resources. */
  destroy(): Promise<void>;

  /** Wipe all local data (IndexedDB stores, cursors, changelog, hydration state). */
  clear(): Promise<void>;

  /** Export all local records as structured JSON. */
  exportData(options?: { resources?: string[] }): Promise<DatafnExportPayload>;

  /** Import records from a structured JSON payload. */
  importData(data: DatafnExportPayload, options?: { triggerCloneUp?: boolean }): Promise<DatafnImportResult>;

  /** Check storage health and trigger recovery if corrupted. */
  checkHealth(): Promise<DatafnHealthResult>;
}
```

### New Mutation Options

```typescript
interface DfqlMutationOptions {
  // ... existing fields ...

  /** When true, suppress mutation_applied event emission. Default: false. */
  silent?: boolean;

  /** When provided, debounce the mutation by this key. Coalesces within debounceMs window. */
  debounceKey?: string;

  /** Debounce delay in ms. Default: 1500. Only applies when debounceKey is set. */
  debounceMs?: number;

  /** When true, marks mutation as system-initiated (skips auto-stamping in plugins). */
  system?: boolean;

  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}
```

### New KV Methods

```typescript
interface DatafnKV {
  // ... existing methods ...

  /** Get value or seed with defaults if not found. */
  getOrSeed<T>(key: string, defaults: T): Promise<T>;
}
```

### New Signal API

```typescript
interface DatafnSignal<T> {
  // ... existing fields ...

  /** Explicitly dispose the signal, unsubscribing from event bus and removing from registry. */
  dispose(): void;
}
```

### New Batch Mutation Options

```typescript
interface DfqlBatchMutationOptions {
  // ... existing fields ...

  /** When true, if batch fails, retry each mutation individually. Default: false. */
  fallbackToIndividual?: boolean;
}
```

### New Storage Adapter Methods

```typescript
interface DatafnStorageAdapter {
  // ... existing methods ...

  /** Atomic read-modify-write merge. MUST execute in a single transaction. */
  mergeRecord(resource: string, id: string, partial: Record<string, unknown>): Promise<Record<string, unknown>>;

  /** Close all connections and release resources. */
  close(): Promise<void>;

  /** Delete all data across all stores. */
  clearAll(): Promise<void>;

  /** Health check: verify core stores exist and are accessible. */
  healthCheck(): Promise<{ ok: boolean; issues: string[] }>;
}
```

### Export/Import Envelopes

```typescript
interface DatafnExportPayload {
  version: 1;
  exportedAt: string; // ISO 8601
  schema: { name: string; version: number }[];
  resources: Record<string, Record<string, unknown>[]>;
  joins?: Record<string, Record<string, unknown>[]>;
}

interface DatafnImportResult {
  ok: boolean;
  stats: {
    resources: Record<string, { imported: number; skipped: number }>;
    joins: Record<string, { imported: number; skipped: number }>;
  };
  errors: Array<{ resource: string; id: string; code: string; message: string }>;
}

interface DatafnHealthResult {
  ok: boolean;
  issues: string[];
  action?: "none" | "reclone";
}
```

---

## Semantics

### §1 — Event Bus Error Isolation
- `EventBus.emit()` MUST wrap each handler invocation in a try-catch.
- A throwing handler MUST NOT prevent delivery to subsequent handlers.
- Errors MUST be logged via `console.error` (or a configurable error handler).
- The error handler SHOULD be configurable via `EventBus` constructor options.

### §2 — Signal Lifecycle Management
- Each signal MUST store the unsubscribe function returned by `eventBus.subscribe()`.
- Signals MUST expose a `dispose()` method that:
  1. Calls the stored unsubscribe function
  2. Removes the signal from the `SignalRegistry`
  3. Marks the signal as disposed (subsequent `get()` calls return last cached value, no refresh)
- The `SignalRegistry` SHOULD support a `disposeAll()` method for bulk cleanup.
- Signals MAY implement automatic disposal after a grace period when subscriber count reaches zero (configurable, default: disabled).

### §3 — Client Destroy and Clear
- `client.destroy()` MUST:
  1. Call `syncEngine.stop()` (if running)
  2. Close WebSocket connection (if open)
  3. Call `signalRegistry.disposeAll()` to clean up all signals
  4. Call `eventBus.clear()` to remove all subscriptions
  5. Call `storage.close()` (if storage exists)
  6. Set an internal `destroyed` flag
  7. Any subsequent method call on a destroyed client MUST throw `DFQL_INVALID` with message "Client has been destroyed"
- `client.clear()` MUST:
  1. Call `storage.clearAll()` to wipe all data
  2. NOT destroy the client (it remains usable after clear)
  3. Reset hydration state for all resources to `notStarted`

### §4 — Debounced Mutations
- When `debounceKey` is provided on a mutation, the mutation MUST be coalesced with any pending mutation for the same key.
- Coalescing MUST shallow-merge the `record` fields of successive mutations for the same key.
- The debounced mutation MUST execute after `debounceMs` milliseconds of quiet (no new mutation for that key).
- A `flush(debounceKey?: string)` method MUST be exposed to force immediate execution of pending debounced mutations.
- `flushAll()` MUST flush all pending debounced mutations.
- Debounced mutations MUST still be applied optimistically to local storage immediately (only the changelog append and remote push are debounced).
- If the client is destroyed, all pending debounced mutations MUST be flushed synchronously before teardown.

### §5 — KV Enhancements
- **KV Debounced Persistence**: `kv.set()` and `kv.merge()` MUST accept an optional `debounceMs` parameter.
  - When provided, the underlying `kvTable.mutate()` call is debounced by the KV key.
  - Default debounce: none (immediate, backward-compatible). Callers opt in.
  - The `kv` API MUST expose `kv.flush(key?)` to force pending debounced writes.
- **KV Seed Data**: `kv.getOrSeed(key, defaults)` MUST:
  1. Attempt `kv.get(key)`
  2. If result is `null`/`undefined`, call `kv.set(key, defaults)` and return `defaults`
  3. If result exists, return it unchanged
  4. The seed operation MUST be idempotent (concurrent calls for the same key MUST NOT create duplicates)

### §6 — Silent Mutations and System Flag
- When `silent: true` is set on a mutation:
  - The mutation MUST still apply to local storage and append to changelog
  - The mutation MUST NOT emit `mutation_applied` or `mutation_rejected` events
  - Signal refresh MUST NOT be triggered
- When `system: true` is set on a mutation:
  - The event payload MUST include `system: true`
  - Plugins/middleware SHOULD use this flag to skip auto-stamping of `modifiedBy`/`modifiedAt`
- `silent` and `system` are orthogonal and MAY be combined.

### §7 — WebSocket Reconnection
- On WebSocket `close` event, the SyncEngine MUST attempt reconnection using exponential backoff.
- Backoff parameters: `baseDelayMs` (default 1000), `multiplier` (default 2), `maxDelayMs` (default 60000), `jitterMs` (default 500).
- Delay formula: `min(baseDelayMs * multiplier^attempt + random(0, jitterMs), maxDelayMs)`
- On successful reconnection, the client MUST re-send the `hello` message with current per-table cursors.
- On successful reconnection, backoff state MUST reset.
- Reconnection MUST be disabled when `syncEngine.stop()` is called or client is destroyed.
- The SyncEngine MUST emit a `ws_disconnected` event on close and `ws_connected` event on reconnect.
- Reconnection MAY be disabled via `wsReconnect.enabled: false`.

### §8 — Push Retry Exponential Backoff
- `pushWithRetries()` MUST wait between retry attempts using exponential backoff.
- Same formula as §7: `min(baseDelayMs * multiplier^attempt + random(0, jitterMs), maxDelayMs)`
- Defaults: baseDelayMs=1000, multiplier=2, maxDelayMs=60000, jitterMs=500.
- On successful push, backoff state MUST reset.
- Backoff parameters MUST be configurable via `DatafnSyncConfig.pushRetryBackoff`.

### §9 — Fine-Grained Signal Invalidation
- Signal footprint MUST be extended to include:
  1. Resource names (existing)
  2. Record IDs from cached result set (when available)
  3. Field names from `select`/`omit` clauses (when available)
- On `mutation_applied` event, a signal MUST only refresh when:
  1. `event.resource` is in the signal's footprint (existing check), AND
  2. At least one of:
     a. The signal has no cached record IDs (conservative: always refresh), OR
     b. `event.ids` intersects the signal's cached record IDs, OR
     c. The mutation is an `insert` (may match the signal's filter criteria), OR
     d. The mutation is a `delete` (may remove a cached record)
- Relation footprint MUST use schema lookup to map relation names to target resource names (replace the current heuristic that assumes relation name equals resource name).

### §10 — Optimistic Signal Updates (Back-Propagation)
- When a `mutation_applied` event is received for a `merge` operation:
  - If the signal's cached data contains a record with the mutated ID, the signal SHOULD immediately patch the cached record with the mutation's `record` fields.
  - The patched value MUST be emitted to subscribers without waiting for a storage re-fetch.
  - A background re-fetch SHOULD still be scheduled (debounced) to ensure eventual consistency.
- For `insert`, `delete`, and `replace` operations, the signal MUST fall back to a full re-fetch (these cannot be safely patched).
- Back-propagation MUST be skippable via a `disableOptimistic: true` option on the signal.

### §11 — Offline Improvements
- **Batch Offline Fallback**: When a batch mutation fails with a transport error and storage exists:
  - The client MUST iterate each mutation in the batch and call `handleOfflineMutation()` individually.
  - Results MUST be aggregated and returned as a batch result.
  - `mutation_applied` events MUST be emitted per mutation (unless `silent: true`).
- **Atomic Offline Merge**: The storage adapter MUST provide a `mergeRecord(resource, id, partial)` method that:
  - Reads the existing record, merges with `partial`, and writes back in a single IndexedDB transaction.
  - If the record does not exist, upserts with `partial` as the full record.
- **Deep Merge**: Offline merge operations MUST support one-level-deep merge for object-type fields:
  - Top-level scalar fields: overwrite (existing behavior)
  - Top-level object fields: shallow-merge the nested object (preserving sibling keys)
  - Arrays: overwrite (no array merging)

### §12 — Sync Configurability and AbortSignal
- `DatafnSyncConfig.pullBatchSize` MUST be respected by `pullWithPerTableCursors()` as the `limit` parameter.
- Default: 200 (current behavior, now configurable).
- `DfqlQuery` MUST accept an optional `signal?: AbortSignal` field.
- The remote adapter's HTTP calls MUST pass the signal to `fetch()`.
- If aborted, the query MUST reject with a `DFQL_ABORTED` error code.
- Local queries MAY ignore the signal (they are fast enough).

### §13 — Data Export and Import
- `client.exportData()` MUST:
  1. Read all records from all non-remote-only resources via storage
  2. Read all join rows for many-many relations
  3. Return a `DatafnExportPayload` with version, timestamp, schema metadata, and data
  4. Support optional `resources` filter to export a subset
- `client.importData()` MUST:
  1. Validate the payload version and schema compatibility
  2. Upsert records into local storage per resource
  3. Upsert join rows for many-many relations
  4. Return a `DatafnImportResult` with per-resource stats
  5. When `triggerCloneUp: true`, call `cloneUp()` after import
  6. Emit `mutation_applied` events for imported records (unless the caller wraps in a silent batch)

### §14 — Soft-Delete Plugin
- datafn MUST provide a `createSoftDeletePlugin(config)` function in `@datafn/client`.
- The plugin MUST:
  1. Intercept `delete` mutations on configured resources and convert them to `merge` with `{ deletedAt: new Date(), isDeleted: true }`
  2. Intercept queries on configured resources and auto-add `{ isDeleted: { $ne: true } }` filter (unless `includeDeleted: true` is set in query metadata)
  3. Expose `table.restore(id)` as a convenience that merges `{ deletedAt: null, isDeleted: false }`
- Archive behavior (setting `isArchived`) is a separate concern and SHOULD be handled by application-level code, not the plugin.

### §15 — Self-Healing Persistence and System Mutations
- `client.checkHealth()` MUST:
  1. Verify that the storage adapter is accessible (call `healthCheck()`)
  2. Verify that all non-remote-only resources have valid hydration state
  3. If any resource is in an inconsistent state (e.g., `hydrating` but no clone in progress), report it
  4. Return `{ ok, issues, action }` where action is `"reclone"` if recovery requires a fresh clone
- The storage adapter's `healthCheck()` MUST verify:
  1. The IndexedDB database is openable
  2. All expected object stores exist
  3. The cursor store is readable
- `system: true` on mutations MUST be propagated in the event payload as `event.system: true`.

### §16 — Bulk Mutation Fallback
- When `fallbackToIndividual: true` is set on a batch mutation and the batch fails:
  - The client MUST retry each mutation individually via the remote adapter.
  - Successfully applied mutations MUST be tracked.
  - Failures MUST be collected and returned in the batch result's `errors` array.
  - The final result MUST indicate partial success (some applied, some failed).

### §17 — Cross-Tab Coordination
- When running in a browser environment with `BroadcastChannel` available:
  - The client MUST create a `BroadcastChannel` named `datafn:${namespace}` (where namespace is derived from config).
  - On `mutation_applied` events (non-silent), the client MUST post a message to the channel with the event payload.
  - On receiving a message from the channel, the client MUST emit a `mutation_applied` event on the local event bus (with a `fromRemoteTab: true` flag to prevent re-broadcast).
  - This enables signals in other tabs to refresh when mutations occur.
- `BroadcastChannel` MUST be closed on `client.destroy()`.
- Cross-tab coordination MUST be opt-in via `crossTab: true` in client config. Default: `false`.

### §18 — Client-Side Search Indexing
- When the schema declares `indices.search` fields on a resource, the client MAY build a local search index.
- The client MUST support a `searchfn` client plugin that:
  1. Builds indices from `indices.search` schema fields at clone/pull time
  2. Updates indices on local mutations
  3. Intercepts queries with `search` field and routes to local index when hydrated
  4. Falls back to remote when not hydrated
- The search index implementation SHOULD use MiniSearch (small bundle, good performance).

### §19 — Audit Trail Enrichment and IDB Migration
- Changelog entries MUST include `userId` when available from auth context.
- Changelog entries MUST include `timestamp` (ISO 8601).
- The IndexedDB `onupgradeneeded` handler MUST:
  1. Detect v1 schema and perform migration in a controlled manner
  2. If async operations are needed, use a two-phase approach: detect on open, migrate as a separate step
  3. Log migration progress and errors

---

## Invariants

1. **Backward compatibility**: All new options MUST have defaults that preserve existing behavior. No breaking changes to existing API signatures.
2. **Determinism**: Signal invalidation decisions MUST be deterministic for the same event stream and cached state.
3. **Ordering**: Event bus handlers MUST be invoked in subscription order. Error isolation MUST NOT change ordering.
4. **Idempotency**: `kv.getOrSeed()` MUST be idempotent — concurrent calls for the same key MUST NOT create duplicate records.
5. **Cleanup completeness**: After `client.destroy()`, no timers, event handlers, WebSocket connections, or IndexedDB connections may remain active.
6. **Debounce flush guarantee**: On `client.destroy()`, all pending debounced mutations MUST be flushed before teardown completes.
7. **Cross-tab safety**: BroadcastChannel messages MUST include a `sourceTabId` to prevent echo loops.

---

## Security

- Silent mutations (`silent: true`) MUST still append to changelog and be pushed to server. They only suppress local events.
- System mutations (`system: true`) do NOT bypass server-side authz. They only affect client-side plugin behavior.
- Export data MUST NOT include any authentication tokens or credentials.
- Import data MUST validate each record against the schema before upserting.
- Cross-tab BroadcastChannel messages MUST NOT include full record data (only event metadata: resource, ids, action, fields, mutationId).

---

## Limits / Caps

| Limit | Value | Configurable? |
|-------|-------|---------------|
| Pull batch size | 200 (default) | Yes, via `pullBatchSize` |
| Push retry max attempts | 5 (default) | Yes, via `pushMaxRetries` |
| Push backoff max delay | 60,000ms | Yes, via `pushRetryBackoff.maxDelayMs` |
| WS reconnect max delay | 60,000ms | Yes, via `wsReconnect.maxDelayMs` |
| Debounce default delay | 1,500ms | Yes, per-call via `debounceMs` |
| KV debounce default | none (immediate) | Yes, per-call via `debounceMs` |
| Export max payload | No limit | No |
| BroadcastChannel message max | Event metadata only (~1KB) | No |

---

## Observability

- Event bus errors MUST be logged via `console.error` with handler identity (if available) and error details.
- WebSocket connection state changes MUST emit events: `ws_connected`, `ws_disconnected`.
- Push retry attempts MUST be observable via `sync_retry` events with attempt number and delay.
- Signal dispose MUST NOT emit any event (it's an internal lifecycle operation).
- Health check results MUST be returned to caller, not auto-logged.

---

## Compatibility / Versioning

- All new config options have defaults matching current behavior (no breaking changes).
- `DatafnExportPayload.version: 1` establishes the export format version.
- `mergeRecord` on storage adapter is additive (existing adapters can implement it; the offline path falls back to read+write if not available).
- `close()` and `clearAll()` on storage adapter are additive.
- BroadcastChannel feature is opt-in (`crossTab: true`), default off.

---

## Undefined / Explicitly Not Addressed

1. Multi-level deep merge (beyond one level) — only one-level-deep merge for offline
2. Automatic signal auto-dispose based on subscriber count — documented as MAY, not required
3. Server-side relation-level authz — noted as partial, improvement deferred to separate spec
4. Server-side hard-coded namespace fallback — tracked in prior spec, not re-scoped here
5. Extension orchestration host/client pair — Nucleus-specific, not a datafn-core concern
