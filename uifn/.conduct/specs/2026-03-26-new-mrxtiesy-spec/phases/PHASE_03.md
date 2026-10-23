# Phase Goal

Implement the Svelte playground as the second canonical example app.

# In Scope / Out Of Scope

In scope:

- Svelte Vite workspace creation
- Common shell rendering in Svelte
- All four scenarios using `@uifn/svelte`
- Svelte `VirtualizedList` integration

Out of scope:

- Vue implementation
- Final docs cross-link updates
- Final multi-workspace verification script

# Deliverables

- Create `uifn/examples/svelte-playground/package.json`
- Create `uifn/examples/svelte-playground/tsconfig.json`
- Create `uifn/examples/svelte-playground/vite.config.ts`
- Create `uifn/examples/svelte-playground/index.html`
- Create `uifn/examples/svelte-playground/src/main.ts`
- Create `uifn/examples/svelte-playground/src/App.svelte`
- Create `uifn/examples/svelte-playground/src/app.css`
- Create any required scenario components under `uifn/examples/svelte-playground/src/`

# Requirements Covered

- `UI-004`
- `SVE-006`
- `CAP-008`
- `A11Y-012`

# Implementation Tasks

1. Create `@uifn/example-svelte-playground` as a private Vite workspace package using the fixed dev port `6112`.
2. Wire the playground to consume `@uifn/examples-shared`, `@uifn/core`, and `@uifn/svelte` from local workspaces.
3. Implement the common shell with adapter badge `Svelte`, canonical scenario navigation, and capability matrix.
4. Implement route normalization from missing/unknown hashes to `#/settings-console`.
5. Implement `settings-console`, `team-directory`, and `command-center` using the shared scenario fixtures and Svelte adapter primitives.
6. Implement `virtualized-results` with `VirtualizedList` using the supported Svelte render contract.
7. Confirm keyboard reachability and accessible names for navigation and major interactive controls.

# Verification Steps

1. Run:

```bash
npm --workspace @uifn/example-svelte-playground run build
```

Expected outcome: exits `0`.

2. Run:

```bash
npm --workspace @uifn/example-svelte-playground run dev
```

Expected outcome: Vite starts on port `6112`.

3. Manual smoke:

- Open `http://localhost:6112/#/settings-console`
- Open `http://localhost:6112/#/team-directory`
- Open `http://localhost:6112/#/command-center`
- Open `http://localhost:6112/#/virtualized-results`

Expected outcome: each route renders, and the virtualized route uses the Svelte adapter’s supported `VirtualizedList` contract.

# Stop Condition

Report the Svelte build result, the confirmed dev port, whether all four routes render, and the accessibility smoke results for navigation and key interactive controls before starting Phase 04.
