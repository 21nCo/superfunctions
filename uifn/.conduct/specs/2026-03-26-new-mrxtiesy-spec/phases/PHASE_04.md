# Phase Goal

Implement the Vue playground with truthful experimental labeling and unsupported-capability handling.

# In Scope / Out Of Scope

In scope:

- Vue Vite workspace creation
- Common shell rendering in Vue
- Supported scenario implementations in Vue
- Unsupported view for `virtualized-results`

Out of scope:

- React or Svelte changes except shared contract adjustments needed for parity
- Final docs cross-link updates
- Final multi-workspace verification script

# Deliverables

- Create `uifn/examples/vue-playground/package.json`
- Create `uifn/examples/vue-playground/tsconfig.json`
- Create `uifn/examples/vue-playground/vite.config.ts`
- Create `uifn/examples/vue-playground/index.html`
- Create `uifn/examples/vue-playground/src/main.ts`
- Create `uifn/examples/vue-playground/src/App.vue`
- Create `uifn/examples/vue-playground/src/styles.css`
- Create any required scenario components under `uifn/examples/vue-playground/src/`

# Requirements Covered

- `UI-004`
- `VUE-007`
- `CAP-008`
- `A11Y-012`

# Implementation Tasks

1. Create `@uifn/example-vue-playground` as a private Vite workspace package using the fixed dev port `6113`.
2. Wire the playground to consume `@uifn/examples-shared`, `@uifn/core`, and `@uifn/vue` from local workspaces.
3. Implement the common shell with adapter badge `Vue Experimental`, canonical scenario navigation, and capability matrix.
4. Implement route normalization from missing/unknown hashes to `#/settings-console`.
5. Implement `settings-console`, `team-directory`, and `command-center` with Vue adapter primitives.
6. Implement an unsupported view for `#/virtualized-results` using the shared support note `VirtualizedList is not exported by @uifn/vue`.
7. Confirm the unsupported view is keyboard reachable, clearly labeled, and does not throw runtime exceptions.

# Verification Steps

1. Run:

```bash
npm --workspace @uifn/example-vue-playground run build
```

Expected outcome: exits `0`.

2. Run:

```bash
npm --workspace @uifn/example-vue-playground run dev
```

Expected outcome: Vite starts on port `6113`.

3. Manual smoke:

- Open `http://localhost:6113/#/settings-console`
- Open `http://localhost:6113/#/team-directory`
- Open `http://localhost:6113/#/command-center`
- Open `http://localhost:6113/#/virtualized-results`

Expected outcome: the first three routes render normally and `virtualized-results` renders a labeled unsupported view with the canonical note.

# Stop Condition

Report the Vue build result, the confirmed experimental badge text, and the unsupported-route behavior before starting Phase 05.
