# Issue Completion Report

## Metadata

| Field | Value |
|---|---|
| **Issue ID** | 2026-02-23-m6bx9tkf |
| **Timestamp** | 2026-02-23T15:00:00Z |
| **Agent Name** | claude-sonnet-4-6 |
| **Model** | claude-sonnet-4-6[1m] |
| **Launcher** | Claude Code (Zed) |
| **Status** | PASS |

---

## Issue Summary

Signals created via `client.table("...").signal({...})` capture client internals in a closure at creation time. When `switchMode()` or `switchContext()` calls `client.destroy()`, every signal is permanently disposed. All Svelte stores wrapping those signals go silent. Every consumer app had to manually implement a `rebindSignals()` function, duplicating the full signal declaration set after each mode switch.

---

## Implementation Summary

### 1. `SwitchableClient` — `subscribeClient` lifecycle API
**File:** `superfunctions/datafn/client/src/switchableClient.ts`

- Added `subscribeClient(fn)` to the `SwitchableClient<S>` interface.
- Added a `clientSubscribers` `Set` inside `createSwitchableClient`.
- `notifyClientSubscribers()` helper fires the set after each `performSwitch`.
- `subscribeClient(fn)` registers `fn`, immediately calls `fn(realClient)` to emit the current client, and returns an unsubscribe closure.
- `destroy()` now calls `clientSubscribers.clear()` before tearing down.

### 2. `@datafn/svelte` — `toReactiveSvelteStore` + `wrapSubscribeClient`
**File:** `superfunctions/datafn/svelte/src/toSvelteStore.ts`

- Added `ClientRef<C>` type: anything with `subscribe(fn: (c: C) => void): () => void`.
- Added `toReactiveSvelteStore<T, C>(clientRef, signalFactory)`:
  - Returns a Svelte `readable` store.
  - On each client emission: disposes old signal, creates new signal via factory, emits initial value, subscribes to future updates.
  - Full cleanup (old signal disposed, client subscription removed) when the Svelte store has no more subscribers.
- Added `wrapSubscribeClient(subscribeClient)` helper to adapt `SwitchableClient.subscribeClient` into a `ClientRef`.

**File:** `superfunctions/datafn/svelte/src/index.ts`

- Exported `toReactiveSvelteStore`, `wrapSubscribeClient`, `DatafnSvelteStore`, `ClientRef`.

### 3. Todo app — `clientStore` writable + removed `rebindSignals`
**File:** `superfunctions/datafn/examples/todo-app/client/src/lib/datafn.ts`

- Added `import { writable } from "svelte/store"`.
- Added `export const clientStore = writable(client)`.
- Updated `switchMode()` to call `clientStore.set(client)` after creating the new client, so the store always tracks the live instance.

**File:** `superfunctions/datafn/examples/todo-app/client/src/App.svelte`

- Removed `rebindSignals()` function entirely (~33 lines of boilerplate).
- Removed manual `toSvelteStore(client.xxx.signal(...))` calls in `onMount`.
- Replaced with six `toReactiveSvelteStore(clientStore, (c) => c.xxx.signal(...))` declarations at module initialisation — these auto-recreate on every client switch.
- Event bus subscription likewise moved to a `clientStore.subscribe(...)` call so it reattaches after each switch.
- `handleModeSwitch` now just calls `switchMode(next)` and optionally `newClient.sync.start()`; no `rebindSignals()`.
- `$: client = $clientStore` keeps the `client` variable used in mutations always current.

---

## Requirement-by-Requirement Evidence

| Requirement | Evidence |
|---|---|
| `toReactiveSvelteStore`: signal auto-recreates when client store updates | `clientRef.subscribe` callback disposes old signal and calls `signalFactory(client)` on every emission |
| `toReactiveSvelteStore`: old signal disposed on switch (no memory leak) | `currentUnsubSignal?.()` + `currentSignal?.dispose()` called before creating new signal; also in store cleanup |
| `toReactiveSvelteStore`: Svelte store emits new values after client switch | `set({data: currentSignal.get(), ...})` immediately after creation; `currentSignal.subscribe(...)` for future updates |
| `toReactiveSvelteStore`: works with `SwitchableClient.subscribeClient` | `wrapSubscribeClient` adapts the function into `ClientRef`; both have identical `subscribe(fn)` shape |
| `toReactiveSvelteStore`: works with Svelte `writable` store | `clientStore` (a Svelte `writable`) is passed directly as `ClientRef` in todo app |
| `SwitchableClient`: `subscribeClient` fires on `switchContext()` | `notifyClientSubscribers()` called in `performSwitch` after new `realClient` is assigned |
| `SwitchableClient`: fires with current client on initial subscription | `fn(realClient)` called synchronously inside `subscribeClient` |
| `SwitchableClient`: multiple subscribers all receive the new client | Iterates `clientSubscribers` Set in `notifyClientSubscribers` |
| Todo app: remove `rebindSignals()` | `rebindSignals` function deleted; no call sites remain |
| Todo app: signals survive mode switch | All six signal stores declared with `toReactiveSvelteStore(clientStore, ...)` |
| Memory: old signals disposed properly | Dispose + unsub on every client change and on store cleanup |
| Backward compatibility: `toSvelteStore` unchanged | Existing function untouched; new API is additive |

---

## Files Modified

| File | Change |
|---|---|
| `superfunctions/datafn/client/src/switchableClient.ts` | Added `subscribeClient` to interface + implementation; `notifyClientSubscribers` in `performSwitch`; cleanup in `destroy` |
| `superfunctions/datafn/svelte/src/toSvelteStore.ts` | Added `ClientRef` type, `toReactiveSvelteStore`, `wrapSubscribeClient` |
| `superfunctions/datafn/svelte/src/index.ts` | Export all new public API |
| `superfunctions/datafn/examples/todo-app/client/src/lib/datafn.ts` | Added `clientStore` writable; updated `switchMode` to update it |
| `superfunctions/datafn/examples/todo-app/client/src/App.svelte` | Removed `rebindSignals`; replaced with `toReactiveSvelteStore` stores; reactive event bus subscription |

---

## Notes

- The existing `toSvelteStore` is kept unchanged for backward compatibility.
- `wrapSubscribeClient` is a thin adapter (~3 lines) for `SwitchableClient` users who don't use a Svelte writable store.
- Edge case (rapid toggling): each call to `clientStore.subscribe` callback immediately disposes the previous signal synchronously before creating the new one, so no double subscriptions can accumulate.
- React equivalent (`useDatafnSignal`) is out of scope for this issue but `SwitchableClient.subscribeClient` provides the foundation.
