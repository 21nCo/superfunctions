# REQUIREMENTS: Lifecycle-Aware Signals

## Table of Contents

| ID | Priority | Summary |
|---|---|---|
| SIG-LIVE-001 | P0 | LiveSignal implements DatafnSignal<T> |
| SIG-LIVE-002 | P0 | LiveSignal survives switchContext |
| SIG-LIVE-003 | P0 | LiveSignal rebind emits to existing subscribers |
| SIG-LIVE-004 | P0 | LiveSignal factory captures realClient by reference |
| SIG-LIVE-005 | P0 | LiveSignal dispose cleans up all resources |
| SIG-LIVE-006 | P1 | LiveSignal dispose is idempotent |
| SIG-LIVE-007 | P0 | LiveSignal delivers current value on subscribe |
| SIG-LIVE-008 | P1 | LiveSignal error handling during rebind |
| REG-001 | P0 | LiveSignalRegistry deduplication |
| REG-002 | P0 | LiveSignalRegistry rebindAll on switch |
| REG-003 | P0 | LiveSignalRegistry disposeAll on destroy |
| REG-004 | P1 | LiveSignalRegistry re-creation after dispose |
| PROXY-001 | P0 | Proxy wraps table().signal() to create LiveSignals |
| PROXY-002 | P0 | Proxy wraps dynamic table accessors |
| PROXY-003 | P0 | Proxy wraps kv.signal() |
| PROXY-004 | P0 | Proxy does not cause infinite recursion |
| PROXY-005 | P0 | Proxy preserves non-signal table methods |
| PROXY-006 | P0 | performSwitch calls rebindAll before notifying subscribers |
| PROXY-007 | P0 | destroyFn calls disposeAll |
| TYPE-001 | P0 | defineSchema returns T & DatafnSchema |
| TYPE-002 | P0 | ResourceNames resolves to literal union |
| TYPE-003 | P1 | Existing DatafnSchema annotation still compiles |
| SVELTE-001 | P0 | toSvelteStore accepts DatafnSignal directly |
| SVELTE-002 | P1 | toSvelteStore factory overload deprecated |
| SVELTE-003 | P1 | ClientRef type deprecated |
| DEPR-001 | P1 | createSwitchableClient has JSDoc @deprecated |
| DEPR-002 | P1 | SwitchableClient/SwitchableClientConfig have JSDoc @deprecated |
| APP-001 | P0 | Todo app uses defineSchema with literal types |
| APP-002 | P0 | Todo app uses LiveSignals directly (no factory pattern) |
| APP-003 | P0 | Todo app has zero (c as any) casts for signal creation |
| APP-004 | P1 | Todo app removes clientRef boilerplate |

---

## Requirements

### SIG-LIVE-001: LiveSignal implements DatafnSignal<T>

- **ID**: SIG-LIVE-001
- **Priority**: P0
- **Statement**: A LiveSignal MUST implement the full `DatafnSignal<T>` interface: `get()`, `subscribe(handler)`, `loading`, `error`, `refreshing`, `dispose()`.
- **Rationale**: LiveSignal must be a drop-in replacement for raw signals. Any code that accepts `DatafnSignal<T>` must work with LiveSignals.
- **Acceptance criteria**:
  - LiveSignal's `get()` returns the current raw signal's `get()` value.
  - LiveSignal's `subscribe()` adds a handler that receives values from the current raw signal.
  - LiveSignal's `loading` returns the current raw signal's `loading`.
  - LiveSignal's `error` returns the current raw signal's `error`.
  - LiveSignal's `refreshing` returns the current raw signal's `refreshing`.
  - LiveSignal's `dispose()` tears down the lifecycle subscription and the current raw signal.
- **Test vectors**: TV-LIVE-001, TV-LIVE-002
- **Notes**: LiveSignal is not exported as a class/type. Users see `DatafnSignal<T>`.

### SIG-LIVE-002: LiveSignal survives switchContext

- **ID**: SIG-LIVE-002
- **Priority**: P0
- **Statement**: A LiveSignal MUST remain functional after `switchContext()` completes, automatically rebinding to the new raw client's signal.
- **Rationale**: This is the core value proposition — signals survive context switches without manual re-creation.
- **Acceptance criteria**:
  - After `switchContext()`, the LiveSignal's `get()` returns data from the new raw client.
  - After `switchContext()`, mutations on the new client trigger signal refresh.
  - After `switchContext()`, the old raw signal is disposed (no lingering EventBus subscriptions).
  - The LiveSignal instance identity does not change (same object reference before and after switch).
- **Test vectors**: TV-LIVE-003, TV-LIVE-004
- **Notes**: The switch may cause a brief `loading: true` state as the new signal fetches data.

### SIG-LIVE-003: LiveSignal rebind emits to existing subscribers

- **ID**: SIG-LIVE-003
- **Priority**: P0
- **Statement**: After rebinding to a new raw signal (post-switch), the LiveSignal MUST emit the new signal's value to all existing subscribers.
- **Rationale**: Svelte stores and other subscribers must receive updated data after a switch without explicit re-subscription.
- **Acceptance criteria**:
  - A subscriber registered before `switchContext()` receives at least one callback with data from the new raw signal.
  - If the new raw signal's `get()` returns `undefined` (pending fetch), the subscriber receives a callback once the fetch completes.
  - Subscriber receives the new value, not the old stale value.
- **Test vectors**: TV-LIVE-003
- **Notes**: None.

### SIG-LIVE-004: LiveSignal factory captures realClient by reference

- **ID**: SIG-LIVE-004
- **Priority**: P0
- **Statement**: The signal factory closure MUST capture the `realClient` variable by reference (not by value), so that re-calling the factory after `performSwitch` reassigns `realClient` produces a signal bound to the new raw client.
- **Rationale**: This is the mechanism that enables rebinding. If the factory captured a copy, it would keep creating signals on the old (destroyed) client.
- **Acceptance criteria**:
  - Factory defined inside `createDatafnClient` scope references the `let realClient` variable.
  - After `realClient = _buildRawClient(newConfig)`, calling `factory()` creates a signal on the new client.
  - The factory does NOT retain a reference to any previous raw client.
- **Test vectors**: TV-LIVE-004
- **Notes**: This is enforced by JavaScript's closure semantics over `let` variables. The implementation must not accidentally capture `realClient` by destructuring or assignment to a local const.

### SIG-LIVE-005: LiveSignal dispose cleans up all resources

- **ID**: SIG-LIVE-005
- **Priority**: P0
- **Statement**: `liveSignal.dispose()` MUST (a) unsubscribe from `subscribeClient` lifecycle, (b) dispose the current raw signal, (c) remove the LiveSignal from the `LiveSignalRegistry`, (d) clear all subscriber callbacks, (e) set a disposed flag.
- **Rationale**: Prevents memory leaks. A disposed signal must not hold references to the client lifecycle or accumulate stale subscribers.
- **Acceptance criteria**:
  - After dispose, `switchContext()` does NOT attempt to rebind this LiveSignal.
  - After dispose, the LiveSignal is not in `LiveSignalRegistry.signals`.
  - After dispose, the subscriber set is empty.
  - After dispose, the raw signal's dispose has been called.
- **Test vectors**: TV-LIVE-005
- **Notes**: None.

### SIG-LIVE-006: LiveSignal dispose is idempotent

- **ID**: SIG-LIVE-006
- **Priority**: P1
- **Statement**: Calling `dispose()` multiple times on a LiveSignal MUST be safe and produce no errors.
- **Rationale**: Defensive programming. Framework teardown code may call dispose multiple times.
- **Acceptance criteria**:
  - Second `dispose()` call does not throw.
  - Second `dispose()` call does not attempt to dispose the raw signal again.
  - Second `dispose()` call does not remove from registry again.
- **Test vectors**: TV-LIVE-006
- **Notes**: Raw signal's `dispose()` already guards against double-dispose; LiveSignal must do the same.

### SIG-LIVE-007: LiveSignal delivers current value on subscribe

- **ID**: SIG-LIVE-007
- **Priority**: P0
- **Statement**: When a new subscriber is added to a LiveSignal, it MUST immediately receive the current value if one is available (i.e., `get()` returns non-undefined).
- **Rationale**: Svelte's store contract requires synchronous delivery of the current value on subscribe.
- **Acceptance criteria**:
  - If the LiveSignal has a cached value, the handler is called synchronously during `subscribe()`.
  - If the LiveSignal has no cached value (initial load pending), the handler is called once the first value arrives.
- **Test vectors**: TV-LIVE-001
- **Notes**: This mirrors the raw signal's subscribe behavior.

### SIG-LIVE-008: LiveSignal error handling during rebind

- **ID**: SIG-LIVE-008
- **Priority**: P1
- **Statement**: If the signal factory throws during `rebindAll()` (e.g., resource name doesn't exist on new client), the LiveSignal MUST catch the error, store it in its `error` property, and continue. `rebindAll()` MUST NOT throw.
- **Rationale**: One broken signal should not prevent other signals from rebinding.
- **Acceptance criteria**:
  - If factory throws, `liveSignal.error` is set to a `DatafnError` wrapping the thrown error.
  - If factory throws, `liveSignal.loading` is `false`.
  - Other LiveSignals in the registry are still rebound successfully.
  - `rebindAll()` does not throw even if one or more factories fail.
- **Test vectors**: TV-LIVE-007
- **Notes**: This is an edge case for schema changes between tenants.

---

### REG-001: LiveSignalRegistry deduplication

- **ID**: REG-001
- **Priority**: P0
- **Statement**: The `LiveSignalRegistry` MUST return the same LiveSignal instance for identical signal keys. Table signal keys are computed via `dfqlKey({ resource: name, version, ...query })`. KV signal keys are `kv:${key}`.
- **Rationale**: Prevents duplicate signals for the same query, matching raw `SignalRegistry` behavior.
- **Acceptance criteria**:
  - `client.todos.signal(q)` called twice returns `===` the same object.
  - `client.kv.signal("theme")` called twice returns `===` the same object.
  - Two different queries return different instances.
- **Test vectors**: TV-REG-001
- **Notes**: Version number must be included in the key computation for table signals.

### REG-002: LiveSignalRegistry rebindAll on switch

- **ID**: REG-002
- **Priority**: P0
- **Statement**: `LiveSignalRegistry.rebindAll()` MUST iterate all registered LiveSignals and recreate their raw signals from the new `realClient`.
- **Rationale**: This is the mechanism that makes all signals survive a switch.
- **Acceptance criteria**:
  - After `rebindAll()`, every LiveSignal's internal raw signal is bound to the new raw client's EventBus.
  - After `rebindAll()`, every LiveSignal's `get()` returns data from the new client (after fetch completes).
  - `rebindAll()` disposes old raw signals before creating new ones (or they are already disposed by `realClient.destroy()`).
- **Test vectors**: TV-LIVE-003, TV-LIVE-004
- **Notes**: Old raw signals may already be disposed by `realClient.destroy()` (which calls `signalRegistry.disposeAll()` internally). `rebindAll()` should handle this gracefully (double-dispose is safe per SIG-LIVE-006 / raw signal behavior).

### REG-003: LiveSignalRegistry disposeAll on destroy

- **ID**: REG-003
- **Priority**: P0
- **Statement**: `LiveSignalRegistry.disposeAll()` MUST dispose all LiveSignals and clear the registry.
- **Rationale**: Clean shutdown when the client is destroyed.
- **Acceptance criteria**:
  - After `disposeAll()`, the registry's signal map is empty.
  - Each LiveSignal's `dispose()` was called.
  - No lingering subscriptions to `subscribeClient`.
- **Test vectors**: TV-LIVE-008
- **Notes**: Called by `destroyFn` in `createDatafnClient`.

### REG-004: LiveSignalRegistry re-creation after dispose

- **ID**: REG-004
- **Priority**: P1
- **Statement**: If a LiveSignal has been disposed and subsequently `client.todos.signal(q)` is called with the same key, the registry MUST create a fresh LiveSignal.
- **Rationale**: Allows re-use of signal queries after explicit disposal.
- **Acceptance criteria**:
  - Disposed signal is removed from registry.
  - New call with same key creates a new LiveSignal instance (different object identity).
  - New LiveSignal is fully functional.
- **Test vectors**: TV-REG-002
- **Notes**: None.

---

### PROXY-001: Proxy wraps table().signal() to create LiveSignals

- **ID**: PROXY-001
- **Priority**: P0
- **Statement**: The outer Proxy's `get` trap MUST intercept the `"table"` property and return a function that produces wrapped table handles where `.signal()` creates LiveSignals via the `LiveSignalRegistry`.
- **Rationale**: This is the entry point for table signal lifecycle management.
- **Acceptance criteria**:
  - `client.table("todos").signal(q)` returns a LiveSignal (not a raw signal).
  - `client.table("todos").query(q)` still delegates to the raw table (not wrapped).
  - `client.table("todos").mutate(m)` still delegates to the raw table.
- **Test vectors**: TV-PROXY-001
- **Notes**: Only `.signal()` is intercepted; all other table methods pass through unchanged.

### PROXY-002: Proxy wraps dynamic table accessors

- **ID**: PROXY-002
- **Priority**: P0
- **Statement**: The outer Proxy's `get` trap MUST detect when a dynamic property access returns a table-like object (has `signal` and `query` methods) and wrap it the same way as `table()`.
- **Rationale**: `client.todos.signal(q)` is the primary DX path and must produce LiveSignals.
- **Acceptance criteria**:
  - `client.todos.signal(q)` returns a LiveSignal.
  - `client.todos.query(q)` still delegates to the raw table.
  - Non-table properties (e.g., `client.sync`) are NOT wrapped.
- **Test vectors**: TV-PROXY-001
- **Notes**: Detection heuristic: value is an object with `signal` and `query` methods, and `name` and `version` properties.

### PROXY-003: Proxy wraps kv.signal()

- **ID**: PROXY-003
- **Priority**: P0
- **Statement**: The outer Proxy's `get` trap MUST intercept the `"kv"` property and return a wrapped KV handle where `.signal()` creates LiveSignals.
- **Rationale**: KV signals must also survive switches.
- **Acceptance criteria**:
  - `client.kv.signal("theme")` returns a LiveSignal.
  - `client.kv.get("theme")`, `client.kv.set(...)`, etc. still delegate to the raw KV API.
- **Test vectors**: TV-PROXY-002
- **Notes**: Only `.signal()` is intercepted on the KV handle.

### PROXY-004: Proxy does not cause infinite recursion

- **ID**: PROXY-004
- **Priority**: P0
- **Statement**: The signal factory inside a LiveSignal MUST call `.signal()` on the raw client's table/KV handle (via `realClient`), NOT through the outer Proxy, to avoid creating a LiveSignal that internally tries to create another LiveSignal.
- **Rationale**: If the factory called through the Proxy, `.signal()` would be intercepted again, creating infinite recursion.
- **Acceptance criteria**:
  - Factory calls `realClient.table(name).signal(query, options)` or `realClient.kv.signal(key, options)`.
  - No stack overflow occurs when creating a signal.
  - No stack overflow occurs during `rebindAll()`.
- **Test vectors**: TV-PROXY-003
- **Notes**: This is enforced by the factory capturing `realClient` (the raw client variable) rather than `outer` (the Proxy).

### PROXY-005: Proxy preserves non-signal table methods

- **ID**: PROXY-005
- **Priority**: P0
- **Statement**: Wrapped table handles MUST delegate all non-`signal` method calls to the raw table handle without modification.
- **Rationale**: Table methods like `query()`, `mutate()`, `transact()`, `subscribe()` must work as before.
- **Acceptance criteria**:
  - `client.table("todos").query(q)` calls `realClient.table("todos").query(q)`.
  - `client.table("todos").mutate(m)` calls `realClient.table("todos").mutate(m)`.
  - `client.table("todos").name` returns the correct name.
  - `client.table("todos").version` returns the correct version.
- **Test vectors**: TV-PROXY-004
- **Notes**: The wrapping Proxy's `get` trap falls through to the raw table for anything except `"signal"`.

### PROXY-006: performSwitch calls rebindAll before notifying subscribers

- **ID**: PROXY-006
- **Priority**: P0
- **Statement**: In `performSwitch()`, `liveRegistry.rebindAll()` MUST be called AFTER the new `realClient` is created and BEFORE `subscribeClient` subscribers are notified.
- **Rationale**: Ensures signals are already rebound when subscribers access them. If subscribers read signals in their callbacks, they must see the new data.
- **Acceptance criteria**:
  - Ordering: `realClient = _buildRawClient(...)` → `liveRegistry.rebindAll()` → subscriber notification loop.
  - Subscriber callbacks that call `liveSignal.get()` receive data from the new client.
- **Test vectors**: TV-LIVE-004
- **Notes**: This is a correctness-critical ordering constraint.

### PROXY-007: destroyFn calls disposeAll

- **ID**: PROXY-007
- **Priority**: P0
- **Statement**: The `destroyFn` in `createDatafnClient` MUST call `liveRegistry.disposeAll()` as part of the destroy sequence.
- **Rationale**: Ensures all lifecycle subscriptions are cleaned up on client destruction.
- **Acceptance criteria**:
  - After `client.destroy()`, all LiveSignals are disposed.
  - No lingering `subscribeClient` subscriptions from LiveSignals.
- **Test vectors**: TV-LIVE-008
- **Notes**: `disposeAll()` should be called before `realClient.destroy()` to allow clean unsubscription.

---

### TYPE-001: defineSchema returns T & DatafnSchema

- **ID**: TYPE-001
- **Priority**: P0
- **Statement**: `defineSchema()` MUST return `T & DatafnSchema` where `T` is the const-generic input type, preserving literal resource names in the return type.
- **Rationale**: Currently returns `DatafnSchema` which erases literal resource names to `string`, making `ResourceNames<S>` useless and forcing `as any` casts.
- **Acceptance criteria**:
  - `const s = defineSchema({ resources: [{ name: "todos", ... }] })` → `typeof s` includes `{ resources: [{ name: "todos", ... }] }`.
  - `ResourceNames<typeof s>` resolves to `"todos"`, not `string`.
  - `s` satisfies `extends DatafnSchema` (can be passed to `createDatafnClient<typeof s>`).
- **Test vectors**: TV-TYPE-001, TV-TYPE-002
- **Notes**: The `as unknown as` cast in the implementation changes from `as unknown as DatafnSchema` to `as unknown as T & DatafnSchema`.

### TYPE-002: ResourceNames resolves to literal union

- **ID**: TYPE-002
- **Priority**: P0
- **Statement**: `ResourceNames<S>` where `S` is the return type of `defineSchema()` MUST resolve to the union of literal resource name strings.
- **Rationale**: Enables type-safe dynamic table access (`client.todos` typed, not `client[string]`).
- **Acceptance criteria**:
  - Given schema with resources `"todos"` and `"tags"`, `ResourceNames<typeof schema>` is `"todos" | "tags"`.
  - `DatafnClient<typeof schema>` has properties `todos` and `tags` (typed as `DatafnTable`).
  - TypeScript autocomplete suggests `"todos"` and `"tags"` for `client.table(...)` argument.
- **Test vectors**: TV-TYPE-001, TV-TYPE-002
- **Notes**: Depends on TYPE-001.

### TYPE-003: Existing DatafnSchema annotation still compiles

- **ID**: TYPE-003
- **Priority**: P1
- **Statement**: Code that explicitly annotates `const schema: DatafnSchema = defineSchema(...)` MUST continue to compile without errors.
- **Rationale**: Backward compatibility for existing codebases that use explicit type annotations.
- **Acceptance criteria**:
  - `const schema: DatafnSchema = defineSchema({ ... })` compiles.
  - The annotation intentionally widens the type (user's choice).
  - No TypeScript errors at the assignment.
- **Test vectors**: TV-TYPE-003
- **Notes**: The returned `T & DatafnSchema` is assignable to `DatafnSchema` because `T & DatafnSchema extends DatafnSchema`.

---

### SVELTE-001: toSvelteStore accepts DatafnSignal directly

- **ID**: SVELTE-001
- **Priority**: P0
- **Statement**: `toSvelteStore()` MUST accept a `DatafnSignal<T>` as its only argument and return a `DatafnSvelteStore<T>` (a Svelte `Readable<{ data: T, loading: boolean, error: DatafnError | null, refreshing: boolean }>`).
- **Rationale**: With lifecycle-aware signals, no factory pattern is needed. Users pass a signal directly.
- **Acceptance criteria**:
  - `toSvelteStore(client.todos.signal(q))` compiles and returns `DatafnSvelteStore<unknown>`.
  - The returned store emits `{ data, loading, error, refreshing }` objects.
  - The store updates when the signal's value changes (including after switchContext).
  - The store cleans up (calls signal subscription unsubscribe) when all Svelte subscribers leave.
- **Test vectors**: TV-SVELTE-001
- **Notes**: The direct overload should be the primary API going forward.

### SVELTE-002: toSvelteStore factory overload deprecated

- **ID**: SVELTE-002
- **Priority**: P1
- **Statement**: The existing `toSvelteStore(clientRef, signalFactory)` overload MUST continue to work but MUST have a JSDoc `@deprecated` tag.
- **Rationale**: Backward compatibility for codebases that haven't migrated to lifecycle-aware signals.
- **Acceptance criteria**:
  - Existing code `toSvelteStore(clientRef, factory)` still compiles and works.
  - JSDoc `@deprecated` tag is present on the overload.
  - IDE shows deprecation warning (strikethrough) when using the factory overload.
- **Test vectors**: TV-SVELTE-002
- **Notes**: None.

### SVELTE-003: ClientRef type deprecated

- **ID**: SVELTE-003
- **Priority**: P1
- **Statement**: The `ClientRef<C>` type export from `@datafn/svelte` MUST have a JSDoc `@deprecated` tag.
- **Rationale**: No longer needed with lifecycle-aware signals.
- **Acceptance criteria**:
  - `ClientRef` is still exported (not removed).
  - JSDoc `@deprecated` tag is present.
- **Test vectors**: N/A (type-level only)
- **Notes**: Removal in next major version.

---

### DEPR-001: createSwitchableClient has JSDoc @deprecated

- **ID**: DEPR-001
- **Priority**: P1
- **Statement**: The `createSwitchableClient` export from `@datafn/client` MUST have a JSDoc `@deprecated` tag on both the function and its type exports.
- **Rationale**: `createDatafnClient` now fully supersedes `createSwitchableClient` with `switchContext()`, `subscribeClient()`, and lifecycle-aware signals.
- **Acceptance criteria**:
  - `createSwitchableClient` function has `@deprecated` JSDoc.
  - IDE shows deprecation warning when importing or calling it.
  - The function still works (not removed).
- **Test vectors**: N/A (documentation-level)
- **Notes**: Current code has a code comment but not a JSDoc tag.

### DEPR-002: SwitchableClient/SwitchableClientConfig have JSDoc @deprecated

- **ID**: DEPR-002
- **Priority**: P1
- **Statement**: The `SwitchableClient<S>` and `SwitchableClientConfig<S>` type exports from `@datafn/client` MUST have JSDoc `@deprecated` tags.
- **Rationale**: Associated types for the deprecated `createSwitchableClient`.
- **Acceptance criteria**:
  - Both types have `@deprecated` JSDoc tags.
  - IDE shows deprecation warning when using them.
- **Test vectors**: N/A (type-level only)
- **Notes**: None.

---

### APP-001: Todo app uses defineSchema with literal types

- **ID**: APP-001
- **Priority**: P0
- **Statement**: The todo app's client-side schema MUST use `defineSchema()` and MUST NOT explicitly annotate the result as `: DatafnSchema`, so that literal resource names are preserved.
- **Rationale**: Enables type-safe `client.todos` access without `as any` casts.
- **Acceptance criteria**:
  - `datafn.ts` uses `const schema = defineSchema({...})` (no `: DatafnSchema` annotation).
  - `typeof schema` preserves literal resource names (`"todos"`, `"tags"`, etc.).
  - `createDatafnClient({ schema })` infers `S` with literal names.
- **Test vectors**: TV-APP-001
- **Notes**: The server-side schema may separately use `defineSchema` — this requirement is for the client-side `datafn.ts`.

### APP-002: Todo app uses LiveSignals directly

- **ID**: APP-002
- **Priority**: P0
- **Statement**: The todo app's `App.svelte` MUST create signals via `client.todos.signal(q)` or `toSvelteStore(client.todos.signal(q))`, NOT via the factory pattern `toSvelteStore(clientRef, factory)`.
- **Rationale**: Demonstrates the zero-boilerplate DX that this spec delivers.
- **Acceptance criteria**:
  - No `toSvelteStore(clientRef, ...)` calls remain in `App.svelte`.
  - No `clientRef` variable construction remains.
  - Signals are created as one-liners.
- **Test vectors**: TV-APP-001
- **Notes**: Choose direct `$signal` or `toSvelteStore(signal)` based on whether metadata (loading/error) is needed.

### APP-003: Todo app has zero (c as any) casts for signal creation

- **ID**: APP-003
- **Priority**: P0
- **Statement**: `App.svelte` MUST have zero `(c as any)` or similar casts related to signal creation or table access.
- **Rationale**: The entire motivation for this spec is eliminating these casts.
- **Acceptance criteria**:
  - No `as any` casts on client or table references in signal creation code.
  - TypeScript compiles without errors for signal creation expressions.
- **Test vectors**: TV-APP-001
- **Notes**: `(event as any)` casts for event handling and `as any[]` for query results are out of scope.

### APP-004: Todo app removes clientRef boilerplate

- **ID**: APP-004
- **Priority**: P1
- **Statement**: The todo app MUST NOT contain a `clientRef` variable or `{ subscribe: client.subscribeClient.bind(client) }` construction.
- **Rationale**: This boilerplate was required by the factory pattern. With LiveSignals, it's unnecessary.
- **Acceptance criteria**:
  - No `clientRef` declaration in `App.svelte`.
  - No `.bind(client)` call related to client subscription.
- **Test vectors**: TV-APP-001
- **Notes**: None.
