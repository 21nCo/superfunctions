# Issue Completion Report — Unify Client/Svelte API Surface and Add Offline Connectivity Awareness

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-23T12:38:52Z |
| **Agent Name** | claude-sonnet-4-6 |
| **Model** | claude-sonnet-4-6 |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Issue ID** | 2026-02-23-k7x9m4vr |
| **Status** | **PASS** |

---

## Issue Summary

Three related API-surface and UX debt items:
1. **Offline unawareness** — SyncEngine had no browser connectivity detection; the UI could not observe whether the app was online or offline.
2. **Todo app mode switching** — The example app used a hand-rolled pattern (`export let client`, `clientStore = writable(client)`, `switchMode`) that reimplemented `SwitchableClient`'s capabilities, and was never migrated to use the library.
3. **Doubled API surface** — Two client factories (`createDatafnClient` / `createSwitchableClient`) and two Svelte adapters (`toSvelteStore` / `toReactiveSvelteStore`) created confusion, silent failures on mode switch, and unnecessary bridging helpers.

---

## Fix 1: Connectivity Awareness in SyncEngine

### Files changed
- `datafn/core/src/types.ts` — Added `"connectivity_changed"` and `"sync_retry"` to `DatafnEvent.type` union.
- `datafn/client/src/sync/engine.ts` — Added full connectivity awareness.

### Implementation
- Added `isOnline: boolean` property (initialized from `navigator.onLine ?? true`).
- Added `pushPausedForOffline: boolean` flag for interval management.
- Added `boundOnOnline` and `boundOnOffline` bound handlers.
- `start()` reads current `navigator.onLine` and registers `window.addEventListener("online"|"offline")` listeners.
- `stop()` removes both listeners.
- `onOnline()`: sets `isOnline = true`, emits `connectivity_changed { isOnline: true }`, resumes paused push interval, calls `pullNow()` + `processPush()` (immediate sync).
- `onOffline()`: sets `isOnline = false`, emits `connectivity_changed { isOnline: false }`, pauses regular push interval (`pushPausedForOffline = true`) to save battery.
- `processPush()`: fast-fail guard `if (!this.isOnline) return` before any network activity.

### Acceptance criteria verification
- [x] `online`/`offline` events registered in `start()`, removed in `stop()`
- [x] Push loop pauses when `offline` fires, resumes on `online`
- [x] `navigator.onLine` check skips push attempt when offline
- [x] `connectivity_changed` event emitted with `{ isOnline: boolean }`
- [x] Immediate `pullNow()` + `processPush()` on `online` event
- [x] Rapid online/offline toggling: paused flag prevents duplicate interval restarts; `processPush` in-flight guard prevents concurrent pushes

---

## Fix 3: Unified Client Factory (`createDatafnClient`)

### Files changed
- `datafn/client/src/client.ts` — Restructured to add switching capability.
- `datafn/client/src/index.ts` — Exported `SwitchContextOverride` type.
- `datafn/client/src/switchableClient.ts` — Added `@deprecated` JSDoc.

### Implementation
- Renamed existing `createDatafnClient` body to `_buildRawClient` (internal, unexported).
- Added `SwitchContextOverride` type: `{ authContext?, sync?, storage? }`.
- Extended `DatafnClient<S>` type with three new methods:
  - `switchContext(override: SwitchContextOverride): Promise<void>` — destroys current underlying client and recreates with merged config. Concurrent calls are serialized via a queue.
  - `currentContext(): AuthContext | undefined` — returns resolved auth context from current config.
  - `subscribeClient(fn: (client: DatafnClient<S>) => void): () => void` — fires immediately on subscription and again after each switch.
- New public `createDatafnClient` creates an outer Proxy that:
  - Intercepts `switchContext`, `currentContext`, `subscribeClient`, `destroy`.
  - Delegates everything else to the current `realClient` (the output of `_buildRawClient`).
  - The Proxy reference (`outer`) is stable across switches — `realClient` is swapped internally.
  - Auto-starts sync when switching into `sync` mode.
- `createSwitchableClient` retains its existing implementation (all tests pass); `@deprecated` annotation guides new users to `createDatafnClient`.

### Acceptance criteria verification
- [x] `createDatafnClient` returns object with `switchContext`, `subscribeClient`, `currentContext`
- [x] `createDatafnClient` works without `authContext` (todo app: no auth)
- [x] `createDatafnClient` accepts both `DatafnStorageAdapter` and `DatafnStorageFactory`
- [x] `subscribeClient` fires immediately with current client on subscription
- [x] `subscribeClient` fires after `switchContext` with updated client
- [x] Concurrent switches serialized via queue
- [x] `createSwitchableClient` still works (all existing tests unaffected)

---

## Fix 4: Unified Svelte Adapter (`toSvelteStore`)

### Files changed
- `datafn/svelte/src/toSvelteStore.ts` — Replaced old static `toSvelteStore(signal)` with reactive implementation.
- `datafn/svelte/src/index.ts` — Updated exports.

### Implementation
- `toSvelteStore(clientRef, signalFactory)` is now the only exported function — it IS the former `toReactiveSvelteStore`.
- Accepts a `ClientRef<C>` (anything with `.subscribe(fn): () => void`) and a `signalFactory` that returns a `DatafnSignal<T>`.
- Automatically disposes the old signal and creates a new one whenever the client changes.
- Removed `toReactiveSvelteStore` (body promoted to `toSvelteStore`).
- Removed `wrapSubscribeClient` — consumers use `{ subscribe: client.subscribeClient.bind(client) }` directly.

### Acceptance criteria verification
- [x] `toSvelteStore(clientRef, factory)` replaces old static `toSvelteStore(signal)` signature
- [x] Signal auto-recreates when client changes (reactive, not static)
- [x] Old signal disposed properly (no memory leaks — `dispose()` called before creating new)
- [x] Works with unified client's `subscribeClient`
- [x] Works when client never changes (factory runs once on initial subscription)

---

## Fix 2: Todo App Migration

### Files changed
- `datafn/examples/todo-app/client/src/lib/datafn.ts` — Replaced manual pattern with unified client.
- `datafn/examples/todo-app/client/src/App.svelte` — Updated to use new API.

### `datafn.ts` changes
- Removed: `export let client`, `clientStore = writable(client)`, `export function switchMode` (old mutable pattern).
- Added: `makeSyncConfig(mode)` helper that returns the full sync config for a given mode.
- `export const client = createDatafnClient({...})` — stable Proxy reference exported as a `const`.
- `export async function switchMode(mode)` — thin wrapper around `client.switchContext({ sync, storage })`. Creates a fresh `IndexedDbStorageAdapter` on each switch (same as previous behavior).

### `App.svelte` changes
- Removed: `client as initialClient`, `clientStore`, `$: client = $clientStore`.
- Added: `clientRef = { subscribe: client.subscribeClient.bind(client) }` as the stable `ClientRef` for `toSvelteStore`.
- Updated import: `toSvelteStore` (was `toReactiveSvelteStore`).
- Updated all signal stores: `toSvelteStore(clientRef, ...)` (was `toReactiveSvelteStore(clientStore, ...)`).
- Updated event bus re-subscription: `client.subscribeClient(c => { ... c.subscribe(...) ... })` (was `clientStore.subscribe(...)`).
- `onMount` uses the stable `client` Proxy directly (was `initialClient`) — no stale reference risk.
- `handleModeSwitch` is now `async`; calls `await switchMode(next)` — sync auto-starts inside `switchContext`.
- Added `isSwitching` guard to prevent double-click race conditions.

### Acceptance criteria verification
- [x] Todo app builds with no `clientStore`, no manual `switchMode` export let pattern
- [x] Mode toggle (sync ↔ local-only) works via `client.switchContext`
- [x] All signals auto-recreate on mode switch (via `toSvelteStore` + `subscribeClient`)
- [x] Event bus subscription reattaches on switch (via `subscribeClient`)
- [x] `onMount` sync start uses stable Proxy client (no stale `initialClient` reference)
- [x] Mode toggling protected by `isSwitching` guard

---

## Files Changed Summary

| File | Change |
|---|---|
| `datafn/core/src/types.ts` | Added `connectivity_changed`, `sync_retry` to `DatafnEvent.type` |
| `datafn/client/src/sync/engine.ts` | Connectivity awareness: online/offline listeners, `isOnline` flag, `connectivity_changed` events |
| `datafn/client/src/client.ts` | `_buildRawClient` + unified `createDatafnClient` wrapper with Proxy switching |
| `datafn/client/src/index.ts` | Export `SwitchContextOverride` |
| `datafn/client/src/switchableClient.ts` | Added `@deprecated` JSDoc |
| `datafn/svelte/src/toSvelteStore.ts` | Unified reactive `toSvelteStore`, removed `toReactiveSvelteStore` + `wrapSubscribeClient` |
| `datafn/svelte/src/index.ts` | Updated exports |
| `datafn/examples/todo-app/client/src/lib/datafn.ts` | Migrated to unified `createDatafnClient` + `switchContext` |
| `datafn/examples/todo-app/client/src/App.svelte` | Updated to `toSvelteStore` + `client.subscribeClient` |

---

## Regressions Checked

- `createSwitchableClient` implementation is unchanged — all existing switchable-client tests pass.
- `_buildRawClient` is the exact existing `createDatafnClient` body — all existing client tests pass.
- The outer Proxy in `createDatafnClient` delegates to `realClient` for all methods not explicitly intercepted — no behavior change for non-switching consumers.
- `connectivity_changed` and `sync_retry` added to `DatafnEvent.type` — event bus type is now correct (previously `sync_retry` was being emitted without being in the type union).

---

## Notes

- `navigator.onLine` is not 100% reliable (captive portals may report `true` while effectively offline). The implementation treats it as a hint: the existing retry-with-backoff remains the authoritative reliability mechanism. Connectivity events are additive — they improve UX without replacing error handling.
- The outer Proxy in `createDatafnClient` uses a `function(){}` as the Proxy target to avoid callable-proxy restrictions, same as `createSwitchableClient`.
- `subscribeClient` always fires with the stable outer Proxy reference (not the raw inner client), so framework adapters (Svelte, React, Vue) can capture the reference safely.
