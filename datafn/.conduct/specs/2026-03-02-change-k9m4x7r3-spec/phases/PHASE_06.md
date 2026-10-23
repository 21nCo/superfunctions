# PHASE_06: Add `@datafn/svelte` and Framework Ecosystem Docs

## Phase Goal

Create documentation for the `@datafn/svelte` package and the framework adapter ecosystem. Add Svelte usage examples to existing docs. Document how future framework packages (React, Vue, Solid, Angular) follow the same pattern.

## In Scope

- SVL-001: Create framework adapters overview doc page
- SVL-002: Add Svelte usage examples to signals doc
- SVL-003: Add `@datafn/svelte` mention to client setup doc
- SVL-004: Create `@datafn/svelte` API reference page
- SVL-005: Document framework adapter ecosystem pattern
- SVL-006: Add Svelte store examples to relevant docs

## Out of Scope

- Creating React, Vue, or other framework packages (only documenting the vision)
- Modifying `@datafn/svelte` source code

## Deliverables

| File | Action |
|---|---|
| `datafn/docs/content/docs/documentation/client/frameworks.mdx` | CREATE — Framework adapters overview + Svelte usage + ecosystem vision |
| `datafn/docs/content/docs/reference/client/svelte.mdx` | CREATE — `@datafn/svelte` API reference |
| `datafn/docs/content/docs/documentation/client/signals.mdx` | UPDATE — Add Svelte integration section |
| `datafn/docs/content/docs/documentation/client/setup.mdx` | UPDATE — Add framework integration mention |

## Requirements Covered

SVL-001 through SVL-006

## Implementation Tasks

### SVL-001 + SVL-005: Create framework adapters doc page

1. [ ] Create `datafn/docs/content/docs/documentation/client/frameworks.mdx`
2. [ ] Content structure:
   - **Title**: "Framework Adapters"
   - **Description**: "Connect DataFn to your UI framework with thin adapter packages."
   - **Overview**: Explain that `DatafnSignal<T>` is the framework-agnostic reactive primitive. Framework adapters convert signals to framework-native reactivity (Svelte stores, React hooks, Vue composables, etc.).
   - **Why adapter packages?**: DataFn's core client is framework-agnostic. Rather than bundling all framework integrations, each is a separate lightweight package. This keeps bundle sizes small and avoids framework dependency conflicts.
   - **Available Adapters**: Table listing `@datafn/svelte` as available, `@datafn/react`, `@datafn/vue`, `@datafn/solid`, `@datafn/angular` as planned.
   - **`@datafn/svelte`** section:
     - Installation: `npm install @datafn/svelte`
     - Basic usage:
       ```typescript
       import { toSvelteStore } from "@datafn/svelte";

       const todosStore = toSvelteStore(
         client.todos.signal({ sort: ["-createdAt"] })
       );
       ```
     - Template usage:
       ```svelte
       {#if $todosStore.loading}
         <p>Loading...</p>
       {:else if $todosStore.error}
         <p>Error: {$todosStore.error.message}</p>
       {:else}
         {#each $todosStore.data ?? [] as todo}
           <p>{todo.title}</p>
         {/each}
       {/if}
       ```
     - State properties: `data`, `loading`, `error`, `refreshing`, `nextCursor`
     - Lifecycle: Signals from `createDatafnClient` are lifecycle-aware via LiveSignals — they survive `switchContext()` and rebind automatically. No factory pattern or `clientRef` needed.
     - Composing with Svelte `derived`:
       ```typescript
       import { derived } from "svelte/store";

       const completedCount = derived(todosStore, ($s) =>
         ($s.data ?? []).filter((t) => t.completed).length
       );
       ```
   - **The Adapter Pattern** section:
     - Each adapter converts `DatafnSignal<T>` → framework reactive primitive.
     - The pattern is simple: subscribe to the signal, emit to the framework's reactivity system, clean up on unmount.
     - Community can create adapters for any framework.
   - **Future Framework Packages** section:
     - `@datafn/react` (planned): `useDatafnSignal(signal)` hook returning `{ data, loading, error, refreshing }`.
       ```typescript
       // Planned API (not yet available)
       import { useDatafnSignal } from "@datafn/react";

       function TodoList() {
         const { data: todos, loading } = useDatafnSignal(
           client.todos.signal({ sort: ["-createdAt"] })
         );
         if (loading) return <p>Loading...</p>;
         return todos.map(t => <p key={t.id}>{t.title}</p>);
       }
       ```
     - `@datafn/vue` (planned): `useDatafnSignal(signal)` composable returning reactive refs.
       ```typescript
       // Planned API (not yet available)
       import { useDatafnSignal } from "@datafn/vue";

       const { data: todos, loading } = useDatafnSignal(
         client.todos.signal({ sort: ["-createdAt"] })
       );
       ```
     - `@datafn/solid` (planned): Wraps signal into Solid's reactive system.
     - `@datafn/angular` (planned): Wraps signal into an Observable/Signal.

### SVL-004: Create API reference page

3. [ ] Create `datafn/docs/content/docs/reference/client/svelte.mdx`
4. [ ] Content:
   - **Title**: "@datafn/svelte"
   - **`toSvelteStore<T>(signal)`**: Primary API. Converts a `DatafnSignal<T>` to a Svelte `Readable` store.
     ```typescript
     function toSvelteStore<T>(signal: DatafnSignal<T>): DatafnSvelteStore<T>;
     ```
   - **`DatafnSvelteStore<T>`**: Return type.
     ```typescript
     type DatafnSvelteStore<T> = Readable<{
       data: T;
       loading: boolean;
       error: DatafnError | null;
       refreshing: boolean;
       nextCursor?: string | null;
     }>;
     ```
   - **Deprecated: Factory overload**
     ```typescript
     function toSvelteStore<T, C>(
       clientRef: ClientRef<C>,
       signalFactory: (client: C) => DatafnSignal<T>,
     ): DatafnSvelteStore<T>;
     ```
     Note: No longer needed. Use the direct signal form. The factory overload exists for backward compatibility and will be removed.
   - **`ClientRef<C>`** (deprecated): Type for the factory overload.
   - **Peer dependencies**: `svelte ^3.0.0 || ^4.0.0`
   - **Package**: `@datafn/svelte` — `npm install @datafn/svelte`

### SVL-002: Add Svelte to signals doc

5. [ ] Open `datafn/docs/content/docs/documentation/client/signals.mdx`
6. [ ] Add a "Framework Integration" section after the existing content (or near the end):
   ```markdown
   ## Framework Integration

   Signals integrate with UI frameworks through thin adapter packages. Each adapter converts a `DatafnSignal<T>` into the framework's native reactive primitive.

   ### Svelte

   Use `@datafn/svelte` to convert signals to Svelte readable stores:

   ```typescript
   import { toSvelteStore } from "@datafn/svelte";

   const todosStore = toSvelteStore(
     client.todos.signal({ sort: ["-createdAt"] })
   );
   ```

   The store provides `data`, `loading`, `error`, and `refreshing` properties:

   ```svelte
   {#if $todosStore.loading}
     <p>Loading...</p>
   {:else}
     {#each $todosStore.data ?? [] as todo}
       <p>{todo.title}</p>
     {/each}
   {/if}
   ```

   See [Framework Adapters](/docs/documentation/client/frameworks) for full documentation and other framework options.
   ```

### SVL-003: Add mention to client setup doc

7. [ ] Open `datafn/docs/content/docs/documentation/client/setup.mdx`
8. [ ] Add a brief "Framework Integration" section at the end (before "Destroying the Client"):
   ```markdown
   ## Framework Integration

   DataFn provides framework-specific adapter packages that convert signals into native reactive primitives:

   - **Svelte**: `@datafn/svelte` — converts signals to Svelte readable stores via `toSvelteStore()`
   - **React, Vue, Solid, Angular**: Coming soon

   See [Framework Adapters](/docs/documentation/client/frameworks) for setup and usage.
   ```

### SVL-006: Svelte examples in other docs

9. [ ] Review `datafn/docs/content/docs/documentation/client/queries.mdx` — if it has vanilla JS examples of signal usage, add a brief Svelte note or link to framework adapters doc
10. [ ] Keep additions minimal — a link to the framework adapters page is sufficient in most cases

## Verification Steps

1. Manual review: all new doc files are well-structured and accurate.
2. Code examples in docs match the actual `@datafn/svelte` API (verified against `datafn/svelte/src/toSvelteStore.ts`).
3. Doc site builds:
   ```bash
   cd datafn/docs && npm run build
   ```
4. No broken links between doc pages.

## Stop Condition

- `frameworks.mdx` created with full Svelte documentation and framework ecosystem vision.
- `reference/client/svelte.mdx` created with complete API reference.
- `signals.mdx` updated with framework integration section.
- `client/setup.mdx` updated with framework integration mention.
- All links between docs are valid.
- Doc site builds successfully.
