# SPEC: Lifecycle-Aware Signals — Eliminate Framework Adapter Boilerplate

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-23T18:30:00Z |
| **Agent Name** | unknown-agent |
| **Model** | claude-4.6-opus-high-thinking |
| **Launcher** | Cursor |
| **Workspace Path** | /Users/serro/Documents/dev/n/superfunctions |
| **OS** | darwin 25.3.0 |
| **Shell** | zsh |
| **Git Branch** | next |
| **Git Commit** | 2d1a0bf |
| **Git Dirty** | Yes (94 files changed) |
| **Spec Folder** | 2026-02-23-new-r4m9kx7v-spec |
| **Spec Type** | new |
| **Spec ID** | r4m9kx7v |
| **Input Paths** | datafn/.conduct/issues/2026-02-23-m3k7xv9p-issue.md, datafn/.conduct/issues/2026-02-23-k7x9m4vr-issue.md, datafn/.conduct/issue-completions/2026-02-23-k7x9m4vr-completion.md, datafn/client/src/client.ts, datafn/client/src/signals/querySignal.ts, datafn/client/src/tables/table.ts, datafn/client/src/kv.ts, datafn/core/src/types.ts, datafn/svelte/src/toSvelteStore.ts, datafn/examples/todo-app/client/src/App.svelte, datafn/examples/todo-app/client/src/lib/datafn.ts |
| **Related Issues** | 2026-02-23-m3k7xv9p-issue (superseded by this spec — Fixes 1+2 replaced, Fixes 3+4+5+6 absorbed) |

---

## Overview

Signals created through `createDatafnClient` are currently bound to the underlying raw client at creation time. When `switchContext()` replaces the raw client, existing signals die — they stop receiving events, stop refreshing, and return stale data. This forces framework adapters like `@datafn/svelte` to use a factory-pattern wrapper (`toSvelteStore(clientRef, (c) => c.table(...).signal(...))`) that disposes and recreates signals on each switch. The factory pattern introduces boilerplate (manual `clientRef` construction, generic type erasure requiring `as any` casts, and ceremony for every signal declaration).

This spec introduces **LiveSignal** — a lifecycle-aware signal wrapper that lives at the Proxy level inside `createDatafnClient`. LiveSignals automatically recreate their underlying raw signal when `switchContext()` completes, forwarding events and values from the new signal to existing subscribers. This eliminates the need for factory wrappers in all framework adapters.

Additionally, this spec includes prerequisite type-system fixes (`defineSchema` return type preservation) and cleanup (`@deprecated` JSDoc tags) that were identified in issue `2026-02-23-m3k7xv9p` and are required for the full developer experience improvement.

### Before (current state)

```typescript
// datafn.ts — boilerplate setup
export const client = createDatafnClient({ schema, ... });

// App.svelte — ceremony for every signal
const clientRef = { subscribe: client.subscribeClient.bind(client) };
const allTodosStore = toSvelteStore(clientRef, (c) =>
  (c as any).todos.signal({ sort: ["-createdAt"], select: ["*", "tags.*"] })
);
const openTodosStore = toSvelteStore(clientRef, (c) =>
  (c as any).todos.signal({ filters: { status: { ne: "done" } } })
);
```

### After (target state)

```typescript
// datafn.ts — no change needed
export const client = createDatafnClient({ schema: defineSchema({...}), ... });

// App.svelte — signals used directly
const allTodos = client.todos.signal({ sort: ["-createdAt"], select: ["*", "tags.*"] });
// Template: {#each $allTodos as todo} ... (Svelte store contract)

// Or with metadata wrapper (optional):
const allTodosStore = toSvelteStore(
  client.todos.signal({ sort: ["-createdAt"], select: ["*", "tags.*"] })
);
// Template: {#if $allTodosStore.loading} ... {:else} {#each $allTodosStore.data as todo}
```

---

## Glossary

| Term | Definition |
|---|---|
| **Raw signal** | A `DatafnSignal<T>` created by `createQuerySignal()` inside a raw client's `SignalRegistry`. Bound to a specific raw client's `EventBus` and storage. Dies when that raw client is destroyed. |
| **LiveSignal** | A `DatafnSignal<T>` wrapper that holds a signal factory and recreates the underlying raw signal when the client switches context. Survives `switchContext()`. |
| **Signal factory** | A closure `() => DatafnSignal<T>` that captures the signal creation parameters (resource name, query, options) and references the current `realClient` variable. Re-executing the factory after a switch produces a signal bound to the new raw client. |
| **LiveSignalRegistry** | A registry of all LiveSignals created through the outer Proxy. Managed at the `createDatafnClient` scope. Responsible for rebinding all signals on switch and disposing all on destroy. |
| **Outer Proxy** | The `Proxy` object returned by `createDatafnClient()`. Intercepts property access and delegates to the current `realClient`. This spec extends it to also intercept `.table()` and `.kv` to produce LiveSignals. |
| **Raw client** | The client object created by `_buildRawClient()`. Contains the actual `SignalRegistry`, `EventBus`, storage adapters, and sync engine. Replaced on each `switchContext()`. |
| **Svelte store contract** | An object with a `subscribe(handler: (value: T) => void): () => void` method. Svelte's `$` prefix syntax auto-subscribes to any object implementing this contract. `DatafnSignal<T>` already satisfies this contract. |
| **defineSchema** | Helper function in `@datafn/core` that validates a schema literal at the type level. Currently erases literal types by returning `DatafnSchema`. This spec fixes it to return the intersection `T & DatafnSchema`, preserving literal resource names. |

---

## Goals

1. **Eliminate factory-pattern boilerplate**: Signals created via `client.table(name).signal(query)` or `client[name].signal(query)` MUST survive `switchContext()` without any wrapper.
2. **Preserve Svelte store contract**: LiveSignals MUST implement the same `subscribe(handler): unsubscribe` contract as raw signals, enabling direct `$signal` usage in Svelte templates.
3. **Preserve `DatafnSignal<T>` interface**: LiveSignals MUST implement the full `DatafnSignal<T>` interface (get, subscribe, loading, error, refreshing, dispose).
4. **Fix type erasure**: `defineSchema()` MUST return a type that preserves literal resource names so `client.todos` is typed (not `client["string"]`).
5. **Simplify `@datafn/svelte`**: `toSvelteStore` MUST accept a `DatafnSignal<T>` directly (not just a factory), enabling one-liner signal-to-store conversion.
6. **Backward compatibility**: Existing code using `toSvelteStore(clientRef, factory)` MUST continue to work (deprecated but functional).
7. **Clean deprecation surface**: `createSwitchableClient` and factory-based `toSvelteStore` MUST have proper JSDoc `@deprecated` tags.

## Non-Goals

- **Query result typing**: Making `signal()` return `DatafnSignal<ConcreteRecordType>` instead of `DatafnSignal<unknown>` is out of scope. That requires schema-to-type inference which is a separate effort.
- **Event type narrowing**: Fixing `(event as any)` casts in event handlers is out of scope.
- **React/Vue adapters**: While LiveSignals benefit all frameworks, this spec only updates `@datafn/svelte`. React/Vue adapters are future work.
- **Signal metadata reactivity**: Making `loading`/`error`/`refreshing` independently reactive (as separate Svelte stores) is out of scope. These are accessible via the `toSvelteStore` metadata wrapper or direct property access.

---

## Public API

### New: `LiveSignal<T>` (internal — not directly exported)

LiveSignal is an internal implementation detail. Users never construct one directly. They receive one when calling `.signal()` through the Proxy client. The returned object satisfies `DatafnSignal<T>`.

```typescript
interface DatafnSignal<T> {
  get(): T;
  subscribe(handler: (value: T) => void): () => void;
  readonly loading: boolean;
  readonly error: DatafnError | null;
  readonly refreshing: boolean;
  dispose(): void;
}
```

### Changed: `defineSchema()` return type

**Before:**

```typescript
function defineSchema<const T extends ...>(schema: T & ...): DatafnSchema;
```

**After:**

```typescript
function defineSchema<const T extends ...>(schema: T & ...): T & DatafnSchema;
```

The return type preserves `T`'s literal structure while satisfying `extends DatafnSchema`.

### Changed: `toSvelteStore` in `@datafn/svelte`

**New overload (primary):**

```typescript
function toSvelteStore<T>(signal: DatafnSignal<T>): DatafnSvelteStore<T>;
```

Accepts a LiveSignal directly. Subscribes to the signal and wraps values with `{ data, loading, error, refreshing }` metadata.

**Existing overload (deprecated):**

```typescript
/** @deprecated Use `toSvelteStore(signal)` with a lifecycle-aware signal from `createDatafnClient`. */
function toSvelteStore<T, C>(
  clientRef: ClientRef<C>,
  signalFactory: (client: C) => DatafnSignal<T>,
): DatafnSvelteStore<T>;
```

### Changed: `createDatafnClient` behavior

Signals created through the returned Proxy (via `.table(name).signal()`, `client[name].signal()`, or `.kv.signal()`) are now LiveSignals that survive `switchContext()`.

**No API signature change.** The return type is still `DatafnClient<S>`, which has `DatafnTable.signal()` returning `DatafnSignal<T>`. LiveSignal implements `DatafnSignal<T>`.

### Deprecated: `createSwitchableClient`

```typescript
/**
 * @deprecated Use `createDatafnClient` which includes `switchContext()`, `subscribeClient()`,
 * and lifecycle-aware signals. `createSwitchableClient` will be removed in the next major version.
 */
export function createSwitchableClient<S extends DatafnSchema>(
  config: SwitchableClientConfig<S>,
): SwitchableClient<S>;
```

### Deprecated: `ClientRef` type

```typescript
/**
 * @deprecated No longer needed. Signals from `createDatafnClient` are lifecycle-aware
 * and can be passed directly to `toSvelteStore(signal)`.
 */
export type ClientRef<C> = { subscribe(fn: (client: C) => void): () => void };
```

---

## Architecture

### LiveSignal lifecycle

```
User code                     Proxy layer                    Raw client
─────────                     ───────────                    ──────────
client.todos.signal(q)  ──►  Proxy intercepts .signal()
                              │
                              ├─ Creates signal factory:
                              │    () => realClient.table("todos").signal(q)
                              │
                              ├─ Calls factory() to get initial raw signal
                              │                                 ──►  SignalRegistry.getSignal(q)
                              │                                       │
                              │                                       └─► createQuerySignal()
                              │                                            ├─ subscribes to EventBus
                              │                                            └─ returns DatafnSignal<T>
                              │
                              ├─ Wraps raw signal in LiveSignal
                              │    ├─ Subscribes to subscribeClient lifecycle
                              │    ├─ Forwards get/subscribe/loading/error/refreshing to raw
                              │    └─ Returns LiveSignal to user
                              │
                         ◄──  └─ LiveSignal (implements DatafnSignal<T>)

─── switchContext() ───────────────────────────────────────────────────────

switchContext(overrides) ──►  performSwitch()
                              │
                              ├─ Destroys old realClient (disposes all raw signals)
                              ├─ Creates new realClient via _buildRawClient()
                              ├─ Calls liveRegistry.rebindAll()
                              │    │
                              │    ├─ For each LiveSignal:
                              │    │    ├─ factory() → new raw signal from new realClient
                              │    │    ├─ Wire subscription to new raw signal
                              │    │    └─ Emit initial value from new raw signal
                              │    │
                              │    └─ (old raw signals already disposed by realClient.destroy())
                              │
                              ├─ Notifies subscribeClient subscribers
                              └─ Auto-starts sync if needed
```

### Proxy table/KV wrapping

The outer Proxy's `get` trap is extended to wrap table handles and the KV API:

```
Proxy get(prop):
  ├─ "switchContext" → switchContextFn
  ├─ "currentContext" → currentContextFn
  ├─ "subscribeClient" → subscribeClientFn
  ├─ "destroy" → destroyFn (calls liveRegistry.disposeAll())
  ├─ "table" → wrapped table factory
  │    └─ (name) → wrapTableHandle(name, realClient.table(name))
  ├─ "kv" → wrapKvHandle(realClient.kv)
  ├─ dynamic table name → wrapTableHandle(prop, realClient[prop])
  └─ default → delegate to realClient
```

Where `wrapTableHandle` returns a Proxy over the raw table that intercepts `.signal()`:

```
wrapTableHandle(name, rawTable):
  └─ Proxy get(prop):
       ├─ "signal" → (query, opts) => liveRegistry.getOrCreate(name, query, opts)
       └─ default → delegate to rawTable
```

### LiveSignalRegistry

```typescript
class LiveSignalRegistry {
  private signals: Map<string, { live: LiveSignal<any>, factoryKey: string }>;

  getOrCreateTableSignal<T>(name: string, query: unknown, options?: SignalOptions): DatafnSignal<T>;
  getOrCreateKvSignal<T>(key: string, options?: KvSignalOptions): DatafnSignal<T>;
  rebindAll(): void;
  disposeAll(): void;
}
```

- **Keying**: Table signals keyed by `dfqlKey({ resource: name, ...query })`. KV signals keyed by `kv:${key}`.
- **Deduplication**: Same key returns the same LiveSignal instance.
- **rebindAll()**: Called by `performSwitch` after new `realClient` is created. Each LiveSignal's factory captures `realClient` by closure reference — re-calling the factory after reassignment produces a signal bound to the new client.
- **disposeAll()**: Called by `destroyFn`. Disposes all LiveSignals (which in turn dispose their raw signals and unsubscribe from lifecycle).

---

## Semantics

### Signal creation through Proxy

- Calling `.signal()` on a table handle obtained through the Proxy (via `.table()` or dynamic accessor) MUST return a LiveSignal.
- Calling `.signal()` on a table handle obtained through `_buildRawClient()` directly (internal use) returns a raw signal as before.
- The distinction is invisible to the user — both implement `DatafnSignal<T>`.

### Signal survival across switchContext

- After `switchContext()` completes, all extant LiveSignals MUST be bound to the new raw client.
- Each LiveSignal MUST emit the initial value from its new raw signal to all active subscribers.
- If the new raw signal's initial `get()` returns `undefined` (not yet fetched), the LiveSignal MUST wait for the first subscriber notification from the raw signal before emitting.
- The LiveSignal's `loading`, `error`, and `refreshing` properties MUST reflect the current raw signal's state after the switch.

### Signal deduplication

- Two calls to `client.todos.signal(q)` with the same `q` (where `dfqlKey(q1) === dfqlKey(q2)`) MUST return the same LiveSignal instance.
- Two calls to `client.kv.signal(k)` with the same `k` MUST return the same LiveSignal instance.
- If a LiveSignal has been `dispose()`d, subsequent calls with the same key MUST create a fresh LiveSignal.

### Signal disposal

- `liveSignal.dispose()` MUST:
  1. Unsubscribe the LiveSignal from the `subscribeClient` lifecycle.
  2. Dispose the current underlying raw signal.
  3. Remove the LiveSignal from the `LiveSignalRegistry`.
  4. Clear all subscriber callbacks.
  5. Set a `disposed` flag to prevent further operations.
- After disposal, `get()` MUST return the last cached value (same as raw signal behavior).
- After disposal, `subscribe()` MUST be a no-op (return an immediate unsubscribe function, do not call the handler).
- After disposal, `loading` MUST return `false`, `error` MUST return `null`, `refreshing` MUST return `false`.

### Client destruction

- `client.destroy()` MUST call `liveRegistry.disposeAll()` which disposes all LiveSignals.
- `liveRegistry.disposeAll()` MUST be called BEFORE `realClient.destroy()` to ensure LiveSignals can cleanly unsubscribe from `subscribeClient` before the subscriber set is cleared.

### Svelte store contract compatibility

- `DatafnSignal<T>.subscribe(handler)` returns `() => void` (unsubscribe).
- This matches Svelte's store contract: `{ subscribe(fn: (value: T) => void): () => void }`.
- LiveSignals MUST deliver the current value to new subscribers immediately (if available), matching Svelte's expectation that stores synchronously emit on subscribe.
- The raw signal's `subscribe()` already does this. LiveSignal MUST preserve this behavior.

### defineSchema type preservation

- `defineSchema()` MUST return `T & DatafnSchema` where `T` is the const-generic input type.
- `T & DatafnSchema` MUST satisfy `extends DatafnSchema` for use with `DatafnClient<S>`.
- `ResourceNames<T & DatafnSchema>` MUST resolve to the literal union of resource names (e.g., `"todos" | "tags"`), not `string`.
- Existing code that explicitly annotates `const schema: DatafnSchema = defineSchema(...)` MUST continue to compile (the annotation widens the type — this is the user's choice).

---

## Invariants

1. **Proxy transparency**: Code that does not call `switchContext()` MUST observe identical behavior whether signals are LiveSignals or raw signals. LiveSignal is a transparent wrapper.
2. **Single-source-of-truth**: At any point in time, a LiveSignal delegates to exactly one raw signal. There is never a window where it delegates to zero or two.
3. **No subscriber loss**: Subscribers registered before a switch MUST receive values from the new raw signal after the switch. No explicit re-subscription needed.
4. **Factory closure correctness**: Signal factories MUST capture `realClient` by reference (not by value). After `realClient` is reassigned in `performSwitch`, re-calling the factory MUST use the new `realClient`.
5. **Lifecycle ordering**: During `performSwitch`, the sequence MUST be: (a) destroy old `realClient`, (b) create new `realClient`, (c) rebind all LiveSignals, (d) notify `subscribeClient` subscribers, (e) auto-start sync.
6. **Deduplication consistency**: The deduplication key for a LiveSignal MUST be identical to the key the underlying `SignalRegistry` uses for raw signals (i.e., `dfqlKey(fullQuery)`).
7. **Idempotent dispose**: Calling `dispose()` multiple times on a LiveSignal MUST be safe (no-op after first call).
8. **No infinite recursion**: The Proxy's table wrapping MUST NOT cause `.signal()` to create a LiveSignal that internally calls `.signal()` through the Proxy. The factory MUST call `.signal()` on the raw client's table handle, not the wrapped one.

---

## Security

No new security implications. LiveSignals are an internal lifecycle management mechanism. They do not:
- Cross tenant boundaries (each raw client is tenant-scoped)
- Expose data from a previous tenant after switch (old raw signal is disposed; new one fetches fresh data)
- Change authentication or authorization semantics

---

## Limits / Caps

| Limit | Value | Rationale |
|---|---|---|
| Max LiveSignals per client | Unbounded (practical limit ~1000) | Same as raw signals; bounded by application design |
| Rebind time per signal | < 1ms per signal (factory call + subscribe) | Factory creates a new raw signal; data fetch is async |
| Switch latency overhead | O(n) where n = number of LiveSignals | Linear scan to rebind; acceptable for typical apps (< 50 signals) |

---

## Observability

- `switchContext` already emits to `subscribeClient` subscribers. No additional events needed.
- LiveSignal creation/disposal does not emit events (matches raw signal behavior).
- If a LiveSignal's factory throws during rebind (e.g., resource name doesn't exist in new schema), the error MUST be caught and stored in the LiveSignal's `error` property. The LiveSignal MUST NOT throw synchronously during `rebindAll()`.

---

## Compatibility / Versioning Strategy

- **Backward compatible**: This is an additive change. Existing code using `toSvelteStore(clientRef, factory)` continues to work.
- **Deprecation timeline**: `createSwitchableClient`, `ClientRef`, and the factory overload of `toSvelteStore` are deprecated in this release and scheduled for removal in the next major version.
- **Semver**: This change is a **minor** version bump for `@datafn/client`, `@datafn/core`, and `@datafn/svelte`.

---

## Undefined / Explicitly User-Deferred

- **React adapter (`@datafn/react`)**: Not created in this spec. LiveSignals are framework-agnostic; a React adapter using `useSyncExternalStore` is straightforward future work.
- **Vue adapter (`@datafn/vue`)**: Same as React.
- **Query result typing**: `signal()` returns `DatafnSignal<unknown>`. Typed query results require schema-to-type inference, which is a separate effort.
- **Signal metadata reactivity**: `loading`/`error`/`refreshing` are not independently subscribable. Use `toSvelteStore` for reactive metadata in Svelte.
