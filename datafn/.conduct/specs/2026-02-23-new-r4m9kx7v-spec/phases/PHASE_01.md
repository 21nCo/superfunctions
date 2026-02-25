# PHASE 01: Core LiveSignal + LiveSignalRegistry Implementation

## Phase Goal

Implement `LiveSignal<T>` and `LiveSignalRegistry` as standalone modules in `@datafn/client`, fully tested in isolation (not yet wired into the Proxy).

## In Scope

- `LiveSignal<T>` class implementing `DatafnSignal<T>`.
- `LiveSignalRegistry` with getOrCreate, rebindAll, disposeAll.
- Deduplication by signal key.
- Error handling during rebind.
- Full unit test coverage.

## Out of Scope

- Proxy integration (Phase 2).
- Svelte adapter (Phase 3).
- Todo app changes (Phase 4).

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/client/src/signals/liveSignal.ts` | CREATE | LiveSignal class + LiveSignalRegistry class |
| `datafn/client/__tests__/live-signal.test.ts` | CREATE | Unit tests for LiveSignal and LiveSignalRegistry |

## Requirements Covered

- SIG-LIVE-001: LiveSignal implements DatafnSignal<T>
- SIG-LIVE-002: LiveSignal survives switchContext (tested via manual rebind)
- SIG-LIVE-003: LiveSignal rebind emits to existing subscribers
- SIG-LIVE-004: LiveSignal factory captures realClient by reference
- SIG-LIVE-005: LiveSignal dispose cleans up all resources
- SIG-LIVE-006: LiveSignal dispose is idempotent
- SIG-LIVE-007: LiveSignal delivers current value on subscribe
- SIG-LIVE-008: LiveSignal error handling during rebind
- REG-001: LiveSignalRegistry deduplication
- REG-002: LiveSignalRegistry rebindAll on switch
- REG-003: LiveSignalRegistry disposeAll on destroy
- REG-004: LiveSignalRegistry re-creation after dispose

## Implementation Tasks

1. **Create `datafn/client/src/signals/liveSignal.ts`** with the following structure:

   ```typescript
   import type { DatafnSignal, DatafnError } from "@datafn/core";
   import { dfqlKey } from "@datafn/core";

   type SignalFactory<T> = () => DatafnSignal<T>;
   type UnsubscribeFn = () => void;

   export class LiveSignal<T> implements DatafnSignal<T> {
     private raw: DatafnSignal<T> | null = null;
     private rawUnsub: UnsubscribeFn | null = null;
     private disposed = false;
     private lastValue: T | undefined = undefined;
     private currentError: DatafnError | null = null;
     private subscribers = new Set<(value: T) => void>();
     private lifecycleUnsub: UnsubscribeFn | null = null;

     constructor(
       private factory: SignalFactory<T>,
       private removeFromRegistry: () => void,
     ) {
       this.bindRaw();
     }

     // ... methods: get, subscribe, loading, error, refreshing, dispose
     // ... internal: bindRaw, unbindRaw, rebind
   }

   export class LiveSignalRegistry {
     private signals = new Map<string, LiveSignal<any>>();

     getOrCreateTableSignal<T>(
       name: string,
       version: number,
       query: unknown,
       options: { disableOptimistic?: boolean } | undefined,
       factory: SignalFactory<T>,
     ): DatafnSignal<T>;

     getOrCreateKvSignal<T>(
       key: string,
       factory: SignalFactory<T>,
     ): DatafnSignal<T>;

     rebindAll(): void;
     disposeAll(): void;
   }
   ```

2. **LiveSignal implementation details**:

   a. **Constructor**: Calls `bindRaw()` to create the initial raw signal from the factory.

   b. **`bindRaw()`**:
      - Calls `this.factory()` to create a raw signal.
      - Subscribes to the raw signal: `this.rawUnsub = this.raw.subscribe(handler)`.
      - The handler updates `this.lastValue` and notifies all `this.subscribers`.
      - If factory throws, catches error, stores in `this.currentError`, sets `this.raw = null`.

   c. **`unbindRaw()`**:
      - Calls `this.rawUnsub?.()` to unsubscribe from raw signal.
      - Does NOT call `this.raw.dispose()` — the raw signal may already be disposed by `realClient.destroy()`. Instead, attempt dispose in a try/catch and silently ignore errors.
      - Sets `this.raw = null`, `this.rawUnsub = null`.

   d. **`rebind()`** (called by `LiveSignalRegistry.rebindAll()`):
      - If disposed, return immediately (no-op).
      - Call `unbindRaw()`.
      - Call `bindRaw()` to create a new raw signal from the factory.
      - If `bindRaw` succeeded and raw signal has a value, emit to all subscribers.

   e. **`get()`**: Returns `this.raw?.get() ?? this.lastValue` (fallback to cached value if raw is null after error).

   f. **`subscribe(handler)`**:
      - If disposed, return `() => {}` immediately without calling handler.
      - Add handler to `this.subscribers`.
      - If `this.lastValue !== undefined`, call `handler(this.lastValue)` synchronously.
      - Return unsubscribe function that removes handler from set.

   g. **`loading` getter**: Returns `this.raw?.loading ?? false`.

   h. **`error` getter**: Returns `this.currentError ?? this.raw?.error ?? null`.

   i. **`refreshing` getter**: Returns `this.raw?.refreshing ?? false`.

   j. **`dispose()`**:
      - If already disposed, return (idempotent).
      - Set `disposed = true`.
      - Call `unbindRaw()` and also try `this.raw?.dispose()`.
      - Call `this.lifecycleUnsub?.()` (this will be set by the Proxy layer in Phase 2; for now it may be null).
      - Call `this.removeFromRegistry()`.
      - Clear `this.subscribers`.

3. **LiveSignalRegistry implementation details**:

   a. **`getOrCreateTableSignal(name, version, query, options, factory)`**:
      - Compute key: `dfqlKey({ resource: name, version, ...query })`.
      - If `this.signals.has(key)`, return the existing LiveSignal.
      - Otherwise, create `new LiveSignal(factory, () => this.signals.delete(key))`.
      - Store in `this.signals` and return.

   b. **`getOrCreateKvSignal(key, factory)`**:
      - Compute key: `kv:${key}`.
      - Same dedup logic as above.

   c. **`rebindAll()`**:
      - Iterate `this.signals.values()` (snapshot via `Array.from` to avoid iterator issues).
      - Call `.rebind()` on each LiveSignal.
      - Wrap each call in try/catch — one failure must not prevent others from rebinding.

   d. **`disposeAll()`**:
      - Iterate `this.signals.values()` (snapshot via `Array.from`).
      - Call `.dispose()` on each.
      - Call `this.signals.clear()`.

4. **Write unit tests** at `datafn/client/__tests__/live-signal.test.ts`:

   Test plan:
   - **"LiveSignal implements DatafnSignal interface"**: Create a LiveSignal with a mock factory. Verify get, subscribe, loading, error, refreshing, dispose all work. (TV-LIVE-001)
   - **"LiveSignal delivers current value on subscribe"**: Create LiveSignal, wait for value, add new subscriber, verify it receives value synchronously. (TV-LIVE-007)
   - **"LiveSignal.rebind() switches to new raw signal"**: Create LiveSignal with factory that returns different signals based on a mutable ref. Call rebind. Verify subscribers receive new value. (TV-LIVE-002, TV-LIVE-003)
   - **"LiveSignal.rebind() preserves subscribers"**: Subscribe before rebind, verify callback fires after rebind. (TV-LIVE-003)
   - **"LiveSignal.dispose() is idempotent"**: Dispose twice, no error. (TV-LIVE-006)
   - **"LiveSignal.dispose() cleans up"**: After dispose, subscribe doesn't fire, loading/error/refreshing are defaults. (TV-LIVE-005)
   - **"LiveSignal handles factory error during rebind"**: Factory throws on second call. Verify error is captured, other signals unaffected. (TV-LIVE-008)
   - **"LiveSignalRegistry deduplication"**: Same key returns same instance. (TV-REG-001)
   - **"LiveSignalRegistry.rebindAll()"**: Create two signals, call rebindAll, verify both rebound. (TV-REG-002)
   - **"LiveSignalRegistry.disposeAll()"**: Create signals, call disposeAll, verify all disposed and registry is empty. (TV-REG-003)
   - **"LiveSignalRegistry re-creation after dispose"**: Dispose a signal, create with same key, verify new instance. (TV-REG-004)

   Mock signal factory pattern:
   ```typescript
   function createMockSignalFactory() {
     let callCount = 0;
     return {
       factory: () => {
         callCount++;
         return createMockSignal(callCount);
       },
       getCallCount: () => callCount,
     };
   }

   function createMockSignal(id: number): DatafnSignal<any> {
     const value = { id, data: [`item-${id}`] };
     const subs = new Set<(v: any) => void>();
     return {
       get: () => value,
       subscribe: (handler) => {
         subs.add(handler);
         handler(value); // immediate delivery
         return () => subs.delete(handler);
       },
       loading: false,
       error: null,
       refreshing: false,
       dispose: vi.fn(),
     };
   }
   ```

## Verification Steps

1. **Unit tests pass**:
   ```bash
   cd datafn/client && npx vitest run __tests__/live-signal.test.ts
   ```
   Expected: All tests pass.

2. **TypeScript compile**:
   ```bash
   cd datafn/client && npx tsc --noEmit
   ```
   Expected: No errors.

3. **Existing tests unaffected**:
   ```bash
   cd datafn/client && npx vitest run
   ```
   Expected: All existing tests still pass (LiveSignal is not yet wired into anything).

## Stop Condition

Report back:
- `LiveSignal` and `LiveSignalRegistry` are implemented and exported from `liveSignal.ts`.
- All unit tests pass (list count: X pass, 0 fail).
- TypeScript compiles cleanly.
- Existing test suite is unaffected.
