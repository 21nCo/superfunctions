# Phase Goal

Implement the React playground as the first canonical example app.

# In Scope / Out Of Scope

In scope:

- React Vite workspace creation
- Common shell rendering in React
- All four scenarios using `@uifn/react`
- React `VirtualizedList` integration

Out of scope:

- Svelte or Vue implementations
- Final docs cross-link updates
- Final multi-workspace verification script

# Deliverables

- Create `uifn/examples/react-playground/package.json`
- Create `uifn/examples/react-playground/tsconfig.json`
- Create `uifn/examples/react-playground/vite.config.ts`
- Create `uifn/examples/react-playground/index.html`
- Create `uifn/examples/react-playground/src/main.tsx`
- Create `uifn/examples/react-playground/src/App.tsx`
- Create `uifn/examples/react-playground/src/styles.css`
- Create any required route/scenario component files under `uifn/examples/react-playground/src/`

# Requirements Covered

- `UI-004`
- `RCT-005`
- `CAP-008`
- `A11Y-012`

# Implementation Tasks

1. Create `@uifn/example-react-playground` as a private Vite workspace package using the fixed dev port `6111`.
2. Wire the playground to consume `@uifn/examples-shared`, `@uifn/core`, and `@uifn/react` from local workspaces.
3. Implement the common shell with adapter badge `React`, canonical scenario navigation, and capability matrix.
4. Implement route normalization from missing/unknown hashes to `#/settings-console`.
5. Implement `settings-console` using dialog, tabs, switch, checkbox, and toast primitives.
6. Implement `team-directory` using avatar, badge, dropdown-menu, popover, and hover-card primitives.
7. Implement `command-center` using combobox, select, scroll-area, and context-menu primitives.
8. Implement `virtualized-results` using `VirtualizedList` and deterministic shared result fixtures.
9. Confirm labels and keyboard reachability for navigation and key controls.

# Verification Steps

1. Run:

```bash
npm --workspace @uifn/example-react-playground run build
```

Expected outcome: exits `0`.

2. Run:

```bash
npm --workspace @uifn/example-react-playground run dev
```

Expected outcome: Vite starts on port `6111`.

3. Manual smoke:

- Open `http://localhost:6111/#/settings-console`
- Open `http://localhost:6111/#/team-directory`
- Open `http://localhost:6111/#/command-center`
- Open `http://localhost:6111/#/virtualized-results`

Expected outcome: each route renders, and `virtualized-results` uses a virtualized list view rather than a fully expanded logical list.

# Stop Condition

Report the React build result, the confirmed dev port, and whether all four routes render before starting Phase 03.
