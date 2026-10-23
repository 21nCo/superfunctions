# PHASE 02: Proxy Integration — Wire LiveSignals into createDatafnClient

## Phase Goal

Modify the outer Proxy in `createDatafnClient` to intercept `.table().signal()`, dynamic table accessor `.signal()`, and `.kv.signal()` calls, creating LiveSignals via the `LiveSignalRegistry` instead of returning raw signals.

## In Scope

- Extend Proxy `get` trap to wrap table handles and KV handle.
- Add `LiveSignalRegistry` instance to `createDatafnClient` scope.
- Call `liveRegistry.rebindAll()` in `performSwitch` (after new client, before subscriber notification).
- Call `liveRegistry.disposeAll()` in `destroyFn`.
- Integration tests with real `switchContext`.

## Out of Scope

- Svelte adapter changes (Phase 3).
- Todo app migration (Phase 4).

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/client/src/client.ts` | MODIFY | Add LiveSignalRegistry, wrap table/kv in Proxy, rebindAll in performSwitch, disposeAll in destroyFn |
| `datafn/client/__tests__/live-signal-proxy.test.ts` | CREATE | Integration tests for LiveSignals through the Proxy |

## Requirements Covered

- PROXY-001: Proxy wraps table().signal() to create LiveSignals
- PROXY-002: Proxy wraps dynamic table accessors
- PROXY-003: Proxy wraps kv.signal()
- PROXY-004: Proxy does not cause infinite recursion
- PROXY-005: Proxy preserves non-signal table methods
- PROXY-006: performSwitch calls rebindAll before notifying subscribers
- PROXY-007: destroyFn calls disposeAll

## Implementation Tasks

1. **Import LiveSignalRegistry** at the top of `datafn/client/src/client.ts`:
   ```typescript
   import { LiveSignalRegistry } from "./signals/liveSignal.js";
   ```

2. **Create LiveSignalRegistry instance** inside `createDatafnClient`, after `let realClient = _buildRawClient(config)`:
   ```typescript
   const liveRegistry = new LiveSignalRegistry();
   ```

3. **Create table wrapping helpers** inside `createDatafnClient` scope:

   ```typescript
   function wrapTableHandle(tableName: string, rawTable: DatafnTable<S, any>): DatafnTable<S, any> {
     return new Proxy(rawTable, {
       get(target, prop) {
         if (prop === "signal") {
           return (query: unknown, options?: { disableOptimistic?: boolean }) => {
             const version = target.version;
             const factory = () => realClient.table(tableName).signal(query, options);
             return liveRegistry.getOrCreateTableSignal(
               tableName, version, query, options, factory,
             );
           };
         }
         const val = (target as any)[prop];
         if (typeof val === "function") return val.bind(target);
         return val;
       },
     }) as DatafnTable<S, any>;
   }

   function wrapKvHandle(rawKv: DatafnKvApi): DatafnKvApi {
     return new Proxy(rawKv, {
       get(target, prop) {
         if (prop === "signal") {
           return (key: string, options?: { defaultValue?: unknown }) => {
             const factory = () => realClient.kv.signal(key, options);
             return liveRegistry.getOrCreateKvSignal(key, factory);
           };
         }
         const val = (target as any)[prop];
         if (typeof val === "function") return val.bind(target);
         return val;
       },
     }) as DatafnKvApi;
   }

   function isTableLike(val: unknown): val is DatafnTable<S, any> {
     return (
       val !== null &&
       typeof val === "object" &&
       typeof (val as any).signal === "function" &&
       typeof (val as any).query === "function" &&
       typeof (val as any).name === "string" &&
       typeof (val as any).version === "number"
     );
   }
   ```

   **CRITICAL**: The `factory` closures capture `realClient` by reference (the `let` variable). After `performSwitch` reassigns `realClient`, re-calling `factory()` uses the new client. This is enforced by JavaScript closure semantics — do NOT destructure or snapshot `realClient` into a local const.

4. **Modify the Proxy `get` trap** (currently lines 1126-1136):

   Replace the current implementation:
   ```typescript
   get(_target, prop) {
     if (prop === "switchContext") return switchContextFn;
     if (prop === "currentContext") return currentContextFn;
     if (prop === "subscribeClient") return subscribeClientFn;
     if (prop === "destroy") return destroyFn;

     const val = (realClient as any)[prop];
     if (typeof val === "function") return val.bind(realClient);
     return val;
   },
   ```

   With:
   ```typescript
   get(_target, prop) {
     if (prop === "switchContext") return switchContextFn;
     if (prop === "currentContext") return currentContextFn;
     if (prop === "subscribeClient") return subscribeClientFn;
     if (prop === "destroy") return destroyFn;

     if (prop === "table") {
       return (name: string) => wrapTableHandle(name, realClient.table(name));
     }

     if (prop === "kv") {
       return wrapKvHandle(realClient.kv);
     }

     const val = (realClient as any)[prop];

     if (isTableLike(val)) {
       return wrapTableHandle((val as any).name, val as DatafnTable<S, any>);
     }

     if (typeof val === "function") return val.bind(realClient);
     return val;
   },
   ```

5. **Modify `performSwitch`** to call `liveRegistry.rebindAll()`:

   Current code (after `realClient = _buildRawClient(newConfig)`, before subscriber notification):
   ```typescript
   realClient = _buildRawClient(newConfig);

   // ADD THIS LINE:
   liveRegistry.rebindAll();

   // Existing: Notify subscribers with the stable outer proxy
   for (const fn of subscribers) {
     fn(outer);
   }
   ```

   The ordering is critical: rebindAll MUST happen after `realClient` is reassigned (so factories use the new client) and BEFORE subscriber notification (so subscribers see rebound signals).

6. **Modify `destroyFn`** to call `liveRegistry.disposeAll()`:

   Add before `realClient.destroy()`:
   ```typescript
   async function destroyFn(): Promise<void> {
     while (switchInProgress) {
       await new Promise<void>(r => setTimeout(r, 10));
     }
     switchQueue = [];
     isDestroyed = true;
     subscribers.clear();
     liveRegistry.disposeAll(); // ADD THIS LINE
     return realClient.destroy();
   }
   ```

7. **Write integration tests** at `datafn/client/__tests__/live-signal-proxy.test.ts`:

   Use the same test infrastructure as `switchable-client.test.ts` (stub remote, test schema, MemoryStorageAdapter).

   Test plan:
   - **"table().signal() returns a LiveSignal that survives switchContext"** (TV-PROXY-001, TV-LIVE-003):
     - Create client with stub remote A.
     - Create signal via `client.table("task").signal(q)`.
     - Subscribe, wait for value.
     - Call `switchContext({ storage: new MemoryStorageAdapter(...) })`.
     - Wait for new value from subscriber.
     - Verify subscriber received data from new client.
     - Verify signal instance is unchanged.

   - **"dynamic table accessor signal() returns same LiveSignal"** (TV-PROXY-001, TV-PROXY-002):
     - `const s1 = client.table("task").signal(q)`
     - `const s2 = client.task.signal(q)`
     - Verify `s1 === s2`.

   - **"kv.signal() returns LiveSignal that survives switchContext"** (TV-PROXY-002):
     - Create KV signal.
     - Subscribe, verify initial value.
     - Switch context.
     - Verify signal still works.

   - **"non-signal table methods pass through"** (TV-PROXY-004):
     - `client.task.query(q)` works.
     - `client.task.mutate(m)` works.
     - `client.task.name` returns `"task"`.
     - `client.task.version` returns `1`.

   - **"no infinite recursion on signal creation"** (TV-PROXY-003):
     - `const signal = client.task.signal(q)` — no stack overflow.

   - **"client.destroy() disposes all LiveSignals"** (TV-LIVE-008):
     - Create signals.
     - Call `client.destroy()`.
     - Verify signals are inert.

   - **"signal deduplication across calls"** (TV-REG-001):
     - Same query → same object.
     - Different query → different object.

   - **"disposed signal re-created on next call"** (TV-REG-002):
     - Create signal, dispose it, create with same query.
     - Verify different object.

## Verification Steps

1. **Integration tests pass**:
   ```bash
   cd datafn/client && npx vitest run __tests__/live-signal-proxy.test.ts
   ```
   Expected: All tests pass.

2. **Unit tests from Phase 1 still pass**:
   ```bash
   cd datafn/client && npx vitest run __tests__/live-signal.test.ts
   ```
   Expected: All pass.

3. **All existing tests pass**:
   ```bash
   cd datafn/client && npx vitest run
   ```
   Expected: All pass (including switchable-client, signals, signal-invalidation tests).

4. **TypeScript compile**:
   ```bash
   cd datafn/client && npx tsc --noEmit
   ```
   Expected: No errors.

## Stop Condition

Report back:
- Proxy wrapping is implemented for table, dynamic table, and KV.
- `performSwitch` calls `rebindAll()` in correct order.
- `destroyFn` calls `disposeAll()`.
- All integration tests pass (list count).
- All existing tests still pass.
- No TypeScript errors.
