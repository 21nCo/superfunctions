# Signals Require Manual Rebinding on Client Switch — Library Should Auto-Recreate

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-23T14:35:00Z |
| **Agent Name** | unknown-agent |
| **Model** | claude-4.6-opus-high-thinking |
| **Launcher** | Cursor |
| **Workspace Path** | /Users/serro/Documents/dev/n |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Repo Metadata** | Not a git repository |

### User-Reported Issue Description (verbatim)

> Isn't switching between sync and local-only mode already handled in Svelte library or client library itself? Remove the need for `rebindSignals` — auto re-create signals on client switch.

### Investigation Commands Executed

- Read `superfunctions/datafn/client/src/signals/querySignal.ts` (SignalRegistry, createQuerySignal)
- Read `superfunctions/datafn/client/src/switchableClient.ts` (SwitchableClient Proxy, performSwitch)
- Read `superfunctions/datafn/client/src/client.ts` (destroy lifecycle, signalRegistry.disposeAll)
- Read `superfunctions/datafn/svelte/src/toSvelteStore.ts` (toSvelteStore wrapper)
- Read `superfunctions/datafn/core/src/types.ts` (DatafnSignal interface)
- Read `superfunctions/datafn/examples/todo-app/client/src/App.svelte` (rebindSignals usage)
- Read `superfunctions/datafn/examples/todo-app/client/src/lib/datafn.ts` (switchMode, makeClient)

---

## Summary

When switching between DataFn client instances (e.g., toggling sync/local-only mode or switching tenant contexts), all reactive query signals become dead because `client.destroy()` disposes them via `signalRegistry.disposeAll()`. The framework-level adapters (`toSvelteStore`, `SwitchableClient`) do not automatically recreate signals after a switch, forcing every consumer app to manually implement a `rebindSignals()` function that recreates all signals and rebinds all Svelte stores. This is error-prone boilerplate that should be handled by the library. Neither the `SwitchableClient` Proxy nor `toSvelteStore` is aware of client lifecycle transitions. **Severity: Medium** — DX/maintainability issue that affects every app using mode switching or tenant switching.

---

## Observed Errors/Symptoms

- After calling `switchMode()` (which creates a new client), all `$allTodosStore`, `$activeTodosStore`, etc. stop receiving updates
- The app must explicitly call `rebindSignals()` to recreate all signal → Svelte store bindings
- If the developer forgets to rebind any signal, that part of the UI silently goes stale
- The `SwitchableClient` Proxy keeps method calls working, but signals created before the switch are permanently disposed
- Every consumer app must duplicate the same boilerplate pattern of signal recreation

---

## Root Causes

### Root Cause 1: Signals capture client internals in closure at creation time

**Location:** `superfunctions/datafn/client/src/signals/querySignal.ts`, lines 225-242 and 272-273

**Current code:**

```typescript
// Lines 225-232: Signal captures client, eventBus, schema in closure
function createQuerySignal<T>(
  client: any,
  eventBus: EventBus,
  schema: DatafnSchema,
  fullQuery: any,
  signalKey: string,
  removeFromRegistry: () => void,
  options?: { disableOptimistic?: boolean },
): DatafnSignal<T> {

// Line 273: Query execution uses captured client reference
const result = await client.query(fullQuery);
```

When a signal is created via `client.table("todos").signal({...})`, the `createQuerySignal` function captures `client` (the actual client instance), `eventBus`, and `schema` in its closure. These references are permanent — they point to the old client even after a switch.

### Root Cause 2: `client.destroy()` disposes all signals with no recovery path

**Location:** `superfunctions/datafn/client/src/client.ts`, lines 801-830

**Current code:**

```typescript
// Lines 801-830: destroy() disposes all signals
async destroy() {
  if (destroyed) return;
  
  // 1. Flush all pending debounced mutations
  await debouncerMap.flushAll();
  
  // 2. Stop sync engine
  if (syncEngine) {
    syncEngine.stop();
  }
  
  // 3. Dispose all signals
  signalRegistry.disposeAll();
  
  // 4. Close cross-tab relay
  if (crossTabRelay) {
    crossTabRelay.close();
  }
  
  // 5. Clear event bus
  eventBus.clear();
  
  // 6. Close storage
  if (resolvedStorage) {
    await resolvedStorage.close();
  }
  
  // 7. Set destroyed flag
  destroyed = true;
},
```

When `switchMode()` or `switchContext()` calls `destroy()` on the old client, `signalRegistry.disposeAll()` marks every signal as disposed (line 61 of querySignal.ts) and unsubscribes them from the event bus. Once disposed, a signal cannot be revived — the only option is to create a new one from the new client.

### Root Cause 3: `SwitchableClient` Proxy doesn't track or recreate signals

**Location:** `superfunctions/datafn/client/src/switchableClient.ts`, lines 113-152 and 158-186

**Current code:**

```typescript
// Lines 113-125: Proxy delegates property access to current realClient
const proxy = new Proxy(() => {}, {
  get(_target, prop, receiver) {
    const value = (realClient as any)[prop];
    if (typeof value === "function") {
      return value.bind(realClient);
    }
    return value;
  },
});

// Lines 158-186: performSwitch destroys old client, creates new one
async function performSwitch(auth: AuthContext): Promise<void> {
  // 1. Destroy old client (flushes, stops sync, closes storage)
  await realClient.destroy();

  // 2. Create new client for the new context
  realClient = createDatafnClient({ ... });

  // 3. Notify callback
  if (config.onSwitch) {
    await config.onSwitch(auth, oldAuth);
  }

  // 4. Start sync if applicable
  if (config.sync?.mode === "sync") {
    await realClient.sync.start();
  }
}
```

The Proxy ensures that `proxy.table("todos").mutate(...)` always reaches the current `realClient`. However, when you call `proxy.table("todos").signal({...})`, the returned `DatafnSignal` object is bound to the old `realClient`'s internals. After `performSwitch()`, the old client is destroyed, the old signal is disposed, and the Svelte store wrapping it goes dead. The Proxy has no mechanism to track which signals were created or to recreate them with the new client.

### Root Cause 4: `toSvelteStore` is a static one-shot binding with no lifecycle awareness

**Location:** `superfunctions/datafn/svelte/src/toSvelteStore.ts`, lines 22-45

**Current code:**

```typescript
export function toSvelteStore<T>(signal: DatafnSignal<T>): DatafnSvelteStore<T> {
  return readable(
    {
      data: signal.get(),
      loading: signal.loading,
      error: signal.error,
      refreshing: signal.refreshing,
    },
    (set) => {
      const unsubscribe = signal.subscribe((value: T) => {
        set({
          data: value,
          loading: signal.loading,
          error: signal.error,
          refreshing: signal.refreshing,
        });
      });
      return unsubscribe;
    }
  );
}
```

`toSvelteStore` takes a concrete `DatafnSignal` instance and returns a Svelte `readable` store. It has no concept of the client or signal factory. When the signal is disposed, the `unsubscribe` callback runs and the store stops updating. There is no reconnection or recreation logic.

### Evidence: The boilerplate this creates in consumer apps

**Location:** `superfunctions/datafn/examples/todo-app/client/src/App.svelte`, lines 18-99

```typescript
// Lines 18-26: Every mode switch requires manual rebind
function handleModeSwitch() {
  const next: AppMode = currentMode === "sync" ? "local-only" : "sync";
  currentMode = next;
  client = switchMode(next);
  rebindSignals();  // <-- Manual boilerplate
  if (next === "sync") {
    client.sync.start().catch(console.error);
  }
}

// Lines 67-99: 30+ lines of signal recreation boilerplate
function rebindSignals() {
  allTodosStore = toSvelteStore(
    client.todos.signal({ sort: ["-createdAt"], select: ["*", "tags.*"] })
  );
  activeTodosStore = toSvelteStore(
    client.table("todos").signal({ ... })
  );
  completedTodosStore = toSvelteStore(
    client.table("todos").signal({ ... })
  );
  categoriesStore = toSvelteStore(
    client.table("categories").signal({ sort: ["name"] })
  );
  themeSignalStore = toSvelteStore(
    client.kv.signal<string>("pref:theme", { defaultValue: "dark" })
  );
  sortSignalStore = toSvelteStore(
    client.kv.signal<string>("pref:sort", { defaultValue: "createdAt:desc" })
  );
  subscribeEvents();
}
```

Every signal declaration is duplicated (once in `rebindSignals`, effectively replacing what would be a one-time declaration). If a new signal is added, the developer must remember to add it to `rebindSignals` too, or the UI silently breaks on mode switch.

---

## Proposed Fix

### Approach: Lazy signal factory in `toSvelteStore` (Svelte adapter level)

The cleanest fix is a new `toSvelteStore` variant that takes a **signal factory function** instead of a concrete signal instance. It subscribes to a client lifecycle event (or an observable client reference) and automatically recreates the signal when the client changes.

**New API in `@datafn/svelte`:**

```typescript
import type { Writable, Readable } from "svelte/store";
import type { DatafnSignal } from "@datafn/core";

type ClientRef = { subscribe: (fn: (client: any) => void) => () => void };

export function toReactiveSvelteStore<T>(
  clientRef: ClientRef,
  signalFactory: (client: any) => DatafnSignal<T>,
): DatafnSvelteStore<T> {
  let currentSignal: DatafnSignal<T> | null = null;
  let currentUnsubSignal: (() => void) | null = null;

  return readable(
    { data: undefined as unknown as T, loading: true, error: null, refreshing: false },
    (set) => {
      const unsubClient = clientRef.subscribe((client) => {
        // Dispose old signal subscription
        currentUnsubSignal?.();
        currentSignal?.dispose();

        // Create new signal from new client
        currentSignal = signalFactory(client);

        // Set initial value
        set({
          data: currentSignal.get(),
          loading: currentSignal.loading,
          error: currentSignal.error,
          refreshing: currentSignal.refreshing,
        });

        // Subscribe to new signal
        currentUnsubSignal = currentSignal.subscribe((value: T) => {
          set({
            data: value,
            loading: currentSignal!.loading,
            error: currentSignal!.error,
            refreshing: currentSignal!.refreshing,
          });
        });
      });

      return () => {
        unsubClient();
        currentUnsubSignal?.();
      };
    },
  );
}
```

**Usage in the todo app (replaces `rebindSignals` entirely):**

```typescript
import { writable } from "svelte/store";
import { toReactiveSvelteStore } from "@datafn/svelte";

// Writable store holding the current client
const clientStore = writable(initialClient);

// Signals auto-recreate when clientStore changes
const allTodosStore = toReactiveSvelteStore(clientStore, (c) =>
  c.table("todos").signal({ sort: ["-createdAt"], select: ["*", "tags.*"] })
);

const activeTodosStore = toReactiveSvelteStore(clientStore, (c) =>
  c.table("todos").signal({ filters: { completed: false }, sort: ["createdAt:desc"] })
);

// On mode switch — just update the client store, signals auto-rebind
function handleModeSwitch() {
  const next = currentMode === "sync" ? "local-only" : "sync";
  currentMode = next;
  clientStore.set(switchMode(next));
  if (next === "sync") {
    get(clientStore).sync.start().catch(console.error);
  }
}
```

### Alternative: `SwitchableClient` emits lifecycle events

If the fix should live at the client library level (framework-agnostic), `SwitchableClient` could emit a `"client_switched"` event or maintain an observable `clientRef`. Framework adapters would then subscribe to this event and recreate signals automatically. This would also benefit React, Vue, and other framework adapters.

```typescript
// In switchableClient.ts — add observable client reference
const clientSubscribers = new Set<(client: DatafnClient<S>) => void>();

function notifyClientSubscribers() {
  for (const fn of clientSubscribers) {
    fn(realClient);
  }
}

// In performSwitch, after creating the new client:
notifyClientSubscribers();

// Expose subscription
return {
  client: proxy,
  subscribeClient(fn: (client: DatafnClient<S>) => void): () => void {
    clientSubscribers.add(fn);
    fn(realClient); // Emit current immediately
    return () => clientSubscribers.delete(fn);
  },
  // ... rest of API
};
```

### Which approach to choose

Both approaches are complementary:

1. **`toReactiveSvelteStore`** (Svelte adapter) — solves the immediate DX problem for Svelte apps. Works with any client management pattern (SwitchableClient, manual switchMode, etc.)
2. **`SwitchableClient` lifecycle events** (client library) — provides a framework-agnostic foundation. Framework adapters (Svelte, React, etc.) can build on top of it.

For maximum coverage, implement both: the `SwitchableClient` emits lifecycle events, and `toReactiveSvelteStore` can consume either a Svelte writable store or a `SwitchableClient` subscription.

---

## Testing Checklist

- [ ] `toReactiveSvelteStore`: signal auto-recreates when client store updates
- [ ] `toReactiveSvelteStore`: old signal is disposed when client switches (no memory leak)
- [ ] `toReactiveSvelteStore`: Svelte store emits new values after client switch
- [ ] `toReactiveSvelteStore`: works with `SwitchableClient.subscribeClient` as input
- [ ] `toReactiveSvelteStore`: works with Svelte `writable` store as input
- [ ] `SwitchableClient`: `subscribeClient` fires on `switchContext()`
- [ ] `SwitchableClient`: `subscribeClient` fires with current client on initial subscription
- [ ] `SwitchableClient`: multiple subscribers all receive the new client
- [ ] Todo app: remove `rebindSignals()`, verify signals survive mode switch
- [ ] Todo app: verify no stale data shown after switching sync → local-only → sync
- [ ] Memory: verify old signals don't accumulate (disposed properly on each switch)
- [ ] Edge case: rapid mode toggling doesn't cause race conditions or double subscriptions

---

## Related Files

| File | Relevance |
|---|---|
| `superfunctions/datafn/client/src/signals/querySignal.ts` | `SignalRegistry`, `createQuerySignal` — signal lifecycle and closure capture |
| `superfunctions/datafn/client/src/switchableClient.ts` | `SwitchableClient` — Proxy, `performSwitch`, missing lifecycle events |
| `superfunctions/datafn/client/src/client.ts` | `createDatafnClient`, `destroy()` → `signalRegistry.disposeAll()` |
| `superfunctions/datafn/svelte/src/toSvelteStore.ts` | `toSvelteStore` — static signal binding, no lifecycle awareness |
| `superfunctions/datafn/core/src/types.ts` | `DatafnSignal<T>` interface (get, subscribe, dispose) |
| `superfunctions/datafn/examples/todo-app/client/src/App.svelte` | `rebindSignals()` boilerplate, `handleModeSwitch()` |
| `superfunctions/datafn/examples/todo-app/client/src/lib/datafn.ts` | `switchMode()`, `makeClient()` |

---

## Notes

- The existing `toSvelteStore` should be kept as-is for backward compatibility. The new `toReactiveSvelteStore` is an additive API.
- The `SwitchableClient` Proxy is still useful for imperative operations (mutations, queries). The gap is specifically with signals, which are stateful subscriptions.
- React would need an equivalent hook (e.g., `useDatafnSignal(clientRef, factory)`) that subscribes to client changes via `useEffect`. The `SwitchableClient` lifecycle event approach enables this.
- The `onSwitch` callback in `SwitchableClientConfig` (line 43 of switchableClient.ts) could theoretically be used for manual rebinding, but it fires before sync starts and doesn't provide a clean signal-factory API. The proposed approach is more ergonomic.
