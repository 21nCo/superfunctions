# Issue Completion Report — Query signals emit paginated envelope instead of array

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-23T22:35:00Z |
| **Agent Name** | claude-opus-4-6 |
| **Model** | claude-opus-4-6[1m] |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Issue ID** | 2026-02-23-k4m7x9v3 |
| **Status** | **PASS** |

---

## Issue Summary

Query signals (`client.table("todos").signal(...)`) emitted the raw paginated result envelope `{ data: Record[], nextCursor: string | null }` as their value type. When framework adapters like `toSvelteStore` wrapped this in `{ data: T, loading, error, refreshing }`, it created a `.data.data` double nesting to reach the record array — causing `{#each} only works with iterable values` runtime crashes in the example todo app.

---

## Changes Made

### 1. `datafn/client/src/signals/querySignal.ts` — Unwrap pagination envelope

- Added `currentCursor` state variable to track pagination cursor separately
- Modified `fetchQuery()` to unwrap `result.data` as the signal value and store `result.nextCursor` in `currentCursor`
- Added `nextCursor` getter on the returned signal object
- `extractRecordIds()` now receives the unwrapped array (via `currentValue`) instead of the envelope
- `applyOptimisticPatch()` — both `result.data` (envelope) and direct array branches are preserved for robustness; after the unwrap, the direct array branch is the primary path

### 2. `datafn/core/src/types.ts` — DatafnSignal interface

- Added `readonly nextCursor?: string | null` to the `DatafnSignal<T>` interface

### 3. `datafn/client/src/signals/liveSignal.ts` — LiveSignal passthrough

- Added `nextCursor` getter that delegates to the underlying raw signal

### 4. `datafn/svelte/src/toSvelteStore.ts` — Svelte adapter

- Added `nextCursor?: string | null` to `DatafnSvelteStore<T>` type
- Updated both `toSvelteStoreDirect` and `toSvelteStoreFactory` to surface `nextCursor` in emitted store values

### 5. `datafn/client/src/kv.ts` — KV signal simplification

- Simplified KV signal transform: since the base query signal now emits the record array directly, the KV signal only needs to extract `records[0].value` from the array (no more `queryResult.data[0].value` envelope navigation)
- Changed `loading`, `error`, `refreshing` from static property copies to live getters that delegate to `baseSignal`

### 6. Test updates

- `datafn/client/__tests__/signals.test.ts` — Updated 9 assertions to expect arrays instead of `{ data, nextCursor }` envelopes
- `datafn/svelte/__tests__/toSvelteStore.test.ts` — Updated 7 assertions to include `nextCursor: null` in expected store shapes

---

## Verification

### Test Results

- `datafn/client/__tests__/signals.test.ts` — **20/20 passed**
- `datafn/svelte/__tests__/toSvelteStore.test.ts` — **7/7 passed**
- `datafn/client/__tests__/signal-invalidation.test.ts` — **4/4 passed**
- `datafn/client/__tests__/live-signal.test.ts` — **30/30 passed**
- `datafn/client/__tests__/live-signal-proxy.test.ts` — **15/15 passed**
- `datafn/client/__tests__/storage-idb.test.ts` — **11/11 passed**
- Full client + svelte suite: **467/469 passed** (2 pre-existing failures in `types.test.ts` due to missing vitest import)

### Acceptance Criteria

- [x] `createQuerySignal` emits an array, not `{ data, nextCursor }`
- [x] `signal.get()` returns the record array directly
- [x] `signal.nextCursor` exposes the cursor value
- [x] `signal.subscribe()` delivers arrays to subscribers
- [x] `toSvelteStore` produces `{ data: Todo[], nextCursor, loading, error, refreshing }`
- [x] `$store.data` in Svelte is directly iterable (no `.data.data`)
- [x] KV signals still work correctly
- [x] Optimistic patching works with direct array values
- [x] `extractRecordIds` works with direct array values
- [x] LiveSignal passthrough correctly exposes `nextCursor`
- [x] Pagination cursor correctly propagated through all layers

---

## Design Notes

- `client.query()` continues returning `{ data, nextCursor }` — the unwrap is **only** at the signal boundary. Direct `client.query()` callers who need pagination metadata are completely unaffected.
- The KV signal in `kv.ts` previously performed its own manual unwrap of the pagination envelope (evidence that the missing unwrap in table query signals was an oversight). After this fix, both signal types follow consistent patterns.
