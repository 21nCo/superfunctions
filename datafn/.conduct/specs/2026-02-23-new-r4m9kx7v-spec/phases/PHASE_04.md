# PHASE 04: Todo App Migration + Final Verification

## Phase Goal

Migrate the todo example app to use lifecycle-aware signals with `defineSchema`, eliminating all factory-pattern boilerplate, `clientRef` construction, and `(c as any)` casts for signal creation. Verify the complete end-to-end flow.

## In Scope

- Update `datafn.ts` to use `defineSchema` without explicit `: DatafnSchema` annotation.
- Replace all `toSvelteStore(clientRef, factory)` calls with `toSvelteStore(signal)` or direct `$signal` usage.
- Remove `clientRef` boilerplate.
- Remove all `(c as any)` casts related to signal/table access.
- Verify the app compiles and runs.

## Out of Scope

- Fixing `(event as any)` casts (event type narrowing — out of spec scope).
- Fixing `as any[]` casts on query results (query result typing — out of spec scope).
- Server-side schema changes.

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/examples/todo-app/client/src/lib/datafn.ts` | MODIFY | Use `defineSchema` with inferred types, remove `: DatafnSchema` annotation |
| `datafn/examples/todo-app/client/src/App.svelte` | MODIFY | Replace factory-pattern signals with direct signal usage |

## Requirements Covered

- APP-001: Todo app uses defineSchema with literal types
- APP-002: Todo app uses LiveSignals directly (no factory pattern)
- APP-003: Todo app has zero (c as any) casts for signal creation
- APP-004: Todo app removes clientRef boilerplate

## Implementation Tasks

1. **Update `datafn/examples/todo-app/client/src/lib/datafn.ts`**:

   a. Find the schema declaration. Currently it likely has either:
      - `const schema: DatafnSchema = defineSchema({...})` (explicit annotation erases types), OR
      - `const schema = defineSchema({...})` but with `DatafnSchema` import that's used elsewhere.

   b. Change to:
      ```typescript
      const schema = defineSchema({
        resources: [
          // ... existing resource definitions (todos, tags, etc.)
        ],
        relations: [
          // ... existing relations
        ],
      });
      ```
      Remove any explicit `: DatafnSchema` type annotation on the `schema` variable.

   c. Ensure the `createDatafnClient` call passes `schema` directly:
      ```typescript
      export const client = createDatafnClient({
        schema,
        clientId: "...",
        // ... rest of config
      });
      ```

   d. Ensure `switchMode` (if it exists) uses `client.switchContext(...)`.

   e. Verify that `typeof client` now has typed table accessors (`client.todos`, `client.tags`, etc.).

2. **Update `datafn/examples/todo-app/client/src/App.svelte`**:

   a. **Remove `clientRef` boilerplate**:
      Find and delete:
      ```typescript
      const clientRef = { subscribe: client.subscribeClient.bind(client) };
      ```

   b. **Replace factory-pattern signal declarations** with direct signals.

      **Before** (current pattern):
      ```typescript
      const allTodosStore = toSvelteStore(clientRef, (c) =>
        (c as any).todos.signal({ sort: ["-createdAt"], select: ["*", "tags.*"] })
      );
      ```

      **After** (one of two options per signal):

      *Option A — with metadata wrapper (for signals where loading/error state is used):*
      ```typescript
      const allTodosStore = toSvelteStore(
        client.todos.signal({ sort: ["-createdAt"], select: ["*", "tags.*"] })
      );
      ```

      *Option B — direct signal (for simpler usage where `$signal` gives the value):*
      ```typescript
      const allTodos = client.todos.signal({ sort: ["-createdAt"], select: ["*", "tags.*"] });
      // Template: {#each $allTodos?.data ?? [] as todo}
      ```

      Choose Option A (toSvelteStore) for consistency with the existing app pattern, since the app likely uses `$store.loading`, `$store.error`, etc.

   c. **Remove all `(c as any)` casts** in signal creation code.
      - Search for `(c as any).todos.signal`, `(c as any).tags.signal`, etc.
      - These are eliminated because we're no longer using a factory function that receives an untyped `c`.

   d. **Update event bus re-subscription** (if any):
      If the app subscribes to the event bus for live updates and re-subscribes on client switch, verify it uses `client.subscribe(...)` or `client.subscribeClient(...)`. This should already be correct from the previous issue's implementation.

   e. **Remove stale imports**:
      - Remove `ClientRef` import if present.
      - Remove any unused `writable`/`get` imports from `svelte/store` that were needed for `clientStore`.

3. **Verify the full set of signal declarations** in `App.svelte`:

   Do a manual audit: search for ALL `toSvelteStore` calls and `signal(` calls in the file. Each one must:
   - Use the direct `toSvelteStore(client.X.signal(...))` pattern, OR
   - Use `client.X.signal(...)` directly with `$` syntax.
   - Have zero `as any` casts on the client or table reference.

4. **Verify `switchMode` / mode switching**:

   The app has a mode switch UI (online/offline/sync). After the migration:
   - Mode switch should call `client.switchContext(...)` or the wrapper `switchMode(...)` from `datafn.ts`.
   - After switching, signals should automatically show data from the new context.
   - No manual signal re-creation needed.

## Verification Steps

1. **TypeScript compile**:
   ```bash
   cd datafn/examples/todo-app/client && npx tsc --noEmit
   ```
   (Or equivalent — check if the example app has a tsconfig. If not, use `npx svelte-check`.)
   Expected: No errors related to signal creation or table access.

2. **Search for remaining casts**:
   ```bash
   grep -n "(c as any)" datafn/examples/todo-app/client/src/App.svelte
   grep -n "clientRef" datafn/examples/todo-app/client/src/App.svelte
   ```
   Expected: Zero matches for `(c as any)` in signal creation context. Zero matches for `clientRef`.

3. **App build** (if build script exists):
   ```bash
   cd datafn/examples/todo-app/client && npm run build
   ```
   Expected: Build succeeds.

4. **All package tests pass**:
   ```bash
   cd datafn/client && npx vitest run
   cd datafn/svelte && npx vitest run
   cd datafn/core && npx vitest run
   ```
   Expected: All pass.

5. **Manual smoke test** (optional but recommended):
   - Start the todo app dev server.
   - Create a todo.
   - Switch mode (online → offline or vice versa).
   - Verify the todo list updates correctly after mode switch.
   - Verify no console errors.

## Stop Condition

Report back:
- `datafn.ts` uses `defineSchema` without explicit type annotation.
- All signal declarations in `App.svelte` use direct pattern (no factory, no clientRef, no `as any`).
- App compiles successfully.
- Count of removed `(c as any)` casts.
- Count of removed boilerplate lines.
- All package test suites pass.
