# PHASE 03: @datafn/svelte Simplification — Direct Signal Overload

## Phase Goal

Add a new `toSvelteStore(signal)` overload that accepts a `DatafnSignal<T>` directly (no factory pattern). Deprecate the factory-based overload and `ClientRef` type.

## In Scope

- New overload: `toSvelteStore<T>(signal: DatafnSignal<T>): DatafnSvelteStore<T>`.
- Deprecation JSDoc on factory overload and `ClientRef` type.
- Maintain backward compatibility (factory overload still works).
- Unit tests for the new overload.

## Out of Scope

- Todo app migration (Phase 4).
- React/Vue adapters.

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/svelte/src/toSvelteStore.ts` | MODIFY | Add direct signal overload, deprecate factory overload and ClientRef |
| `datafn/svelte/src/index.ts` | MODIFY | Update exports if needed |
| `datafn/svelte/__tests__/toSvelteStore.test.ts` | CREATE or MODIFY | Tests for new overload |

## Requirements Covered

- SVELTE-001: toSvelteStore accepts DatafnSignal directly
- SVELTE-002: toSvelteStore factory overload deprecated
- SVELTE-003: ClientRef type deprecated

## Implementation Tasks

1. **Modify `datafn/svelte/src/toSvelteStore.ts`** to add overloads:

   The function must use TypeScript overload signatures to support both APIs:

   ```typescript
   import type { DatafnSignal, DatafnError } from "@datafn/core";
   import type { Readable } from "svelte/store";
   import { readable } from "svelte/store";

   /**
    * @deprecated No longer needed. Signals from `createDatafnClient` are lifecycle-aware.
    * Use `toSvelteStore(signal)` instead.
    */
   export type ClientRef<C> = {
     subscribe(fn: (client: C) => void): () => void;
   };

   export type DatafnSvelteStore<T> = Readable<{
     data: T;
     loading: boolean;
     error: DatafnError | null;
     refreshing: boolean;
   }>;

   /**
    * Convert a lifecycle-aware DataFn signal to a Svelte readable store
    * with `{ data, loading, error, refreshing }` metadata.
    *
    * ```typescript
    * const todosStore = toSvelteStore(
    *   client.todos.signal({ sort: ["-createdAt"] })
    * );
    * // $todosStore.data, $todosStore.loading, etc.
    * ```
    */
   export function toSvelteStore<T>(signal: DatafnSignal<T>): DatafnSvelteStore<T>;

   /**
    * @deprecated Use the single-argument form `toSvelteStore(signal)` with
    * lifecycle-aware signals from `createDatafnClient`. This factory-based
    * overload will be removed in the next major version.
    */
   export function toSvelteStore<T, C>(
     clientRef: ClientRef<C>,
     signalFactory: (client: C) => DatafnSignal<T>,
   ): DatafnSvelteStore<T>;

   export function toSvelteStore<T, C = any>(
     signalOrClientRef: DatafnSignal<T> | ClientRef<C>,
     signalFactory?: (client: C) => DatafnSignal<T>,
   ): DatafnSvelteStore<T> {
     // Detect which overload: if signalFactory is provided, it's the factory pattern.
     // Otherwise, signalOrClientRef is a DatafnSignal.
     if (signalFactory !== undefined) {
       return toSvelteStoreFactory(signalOrClientRef as ClientRef<C>, signalFactory);
     }
     return toSvelteStoreDirect(signalOrClientRef as DatafnSignal<T>);
   }
   ```

2. **Implement `toSvelteStoreDirect`** (new direct overload):

   ```typescript
   function toSvelteStoreDirect<T>(signal: DatafnSignal<T>): DatafnSvelteStore<T> {
     return readable(
       {
         data: signal.get(),
         loading: signal.loading,
         error: signal.error,
         refreshing: signal.refreshing,
       },
       (set) => {
         const unsub = signal.subscribe((value: T) => {
           set({
             data: value,
             loading: signal.loading,
             error: signal.error,
             refreshing: signal.refreshing,
           });
         });

         return () => {
           unsub();
         };
       },
     );
   }
   ```

   **Key difference from factory overload**: No `clientRef` subscription, no signal dispose/recreate. The signal is assumed to be lifecycle-aware (a LiveSignal) — it handles its own rebinding internally. The `readable` store simply subscribes to value changes.

   **Note**: This does NOT call `signal.dispose()` on teardown. The LiveSignal's lifecycle is managed by the Proxy/registry, not by the Svelte store. Multiple Svelte stores could reference the same LiveSignal (via deduplication), and one store unsubscribing must not dispose the signal.

3. **Rename existing implementation** to `toSvelteStoreFactory`:

   Move the existing function body into:
   ```typescript
   function toSvelteStoreFactory<T, C>(
     clientRef: ClientRef<C>,
     signalFactory: (client: C) => DatafnSignal<T>,
   ): DatafnSvelteStore<T> {
     // ... existing implementation (lines 58-99 of current toSvelteStore.ts)
   }
   ```

4. **Overload discrimination logic**:

   The key question: how to distinguish `DatafnSignal<T>` from `ClientRef<C>` at runtime? Both have a `subscribe` method.

   Discrimination approach: Check for the `get` method. `DatafnSignal<T>` has `get()`, `ClientRef<C>` does not. Also check for `dispose`.

   ```typescript
   function isDatafnSignal<T>(val: unknown): val is DatafnSignal<T> {
     return (
       val !== null &&
       typeof val === "object" &&
       typeof (val as any).get === "function" &&
       typeof (val as any).subscribe === "function" &&
       typeof (val as any).dispose === "function"
     );
   }
   ```

   Update the implementation function:
   ```typescript
   export function toSvelteStore<T, C = any>(
     signalOrClientRef: DatafnSignal<T> | ClientRef<C>,
     signalFactory?: (client: C) => DatafnSignal<T>,
   ): DatafnSvelteStore<T> {
     if (signalFactory !== undefined) {
       return toSvelteStoreFactory(signalOrClientRef as ClientRef<C>, signalFactory);
     }
     return toSvelteStoreDirect(signalOrClientRef as DatafnSignal<T>);
   }
   ```

   Since the overloads are discriminated by arity (1 arg vs 2 args), runtime discrimination by `signalFactory !== undefined` is sufficient. No need for `isDatafnSignal` at runtime.

5. **Write/update tests**:

   If `datafn/svelte/__tests__/toSvelteStore.test.ts` exists, add tests. Otherwise create it.

   Test plan:
   - **"toSvelteStore(signal) creates a readable store with metadata"** (TV-SVELTE-001):
     - Create a mock DatafnSignal.
     - Call `toSvelteStore(signal)`.
     - Subscribe to the store, verify `{ data, loading, error, refreshing }` shape.
     - Trigger signal value change, verify store updates.

   - **"toSvelteStore(signal) updates after LiveSignal rebind"** (TV-SVELTE-001):
     - Create a mock LiveSignal that calls its subscriber with a new value (simulating rebind).
     - Verify the Svelte store receives the new value.

   - **"toSvelteStore(clientRef, factory) still works"** (TV-SVELTE-002):
     - Use existing test pattern (if available) or create one.
     - Verify factory overload behavior is preserved.

   - **"toSvelteStore cleanup does not dispose the signal"**:
     - Create store, subscribe, unsubscribe all.
     - Verify `signal.dispose()` was NOT called.
     - (This ensures multiple stores can share a deduplicated LiveSignal.)

## Verification Steps

1. **Svelte tests pass**:
   ```bash
   cd datafn/svelte && npx vitest run
   ```
   Expected: All tests pass.

2. **TypeScript compile**:
   ```bash
   cd datafn/svelte && npx tsc --noEmit
   ```
   Expected: No errors.

3. **Overload resolution check** (manual or via type test):
   ```typescript
   // This should use the direct overload (no type error):
   const store1 = toSvelteStore(someSignal);

   // This should use the factory overload (no type error, but deprecated warning):
   const store2 = toSvelteStore(clientRef, (c) => c.table("x").signal({}));
   ```

## Stop Condition

Report back:
- Direct overload `toSvelteStore(signal)` is implemented.
- Factory overload has `@deprecated` JSDoc.
- `ClientRef` type has `@deprecated` JSDoc.
- All tests pass.
- TypeScript compiles cleanly.
