# Phase goal

Repair `@uifn/core` public exports and shared utilities so adapters can build on deterministic, stable primitives.

# In scope / Out of scope

In scope:

- Core export map and root index repair
- Deterministic ID generation
- Shared utility creation or normalization for focus, roving focus, outside click, escape, presence, portal, and positioning
- Canonical `UIFnError` creation and removal of production debug logging

Out of scope:

- Full family-specific behavior for menus, select, combobox, dialogs

# Deliverables

- `uifn/core/src/index.ts`
- `uifn/core/package.json`
- `uifn/core/src/utils/id.ts`
- `uifn/core/src/utils/index.ts`
- `uifn/core/src/utils/focus-trap.ts` (new if needed)
- `uifn/core/src/utils/roving-focus.ts` (new if needed)
- `uifn/core/src/utils/outside-click.ts` (new if needed)
- `uifn/core/src/utils/escape-key.ts` (new if needed)
- `uifn/core/src/utils/presence.ts` (new if needed)
- `uifn/core/src/utils/portal.ts` (new if needed)
- `uifn/core/src/utils/position.ts` (new if needed)
- `uifn/core/src/errors.ts` (new)
- `uifn/core/src/aria/index.ts` (new if needed)
- `uifn/core/src/state/index.ts` (new if needed)
- `uifn/core/src/**/*.test.ts`

# Requirements covered

- `CORE-001`
- `CORE-002`
- `CORE-003`
- `COMPAT-001`

# Implementation tasks

- [ ] Export `aria/*`, `state/*`, and `utils/*` through stable public paths.
- [ ] Replace non-deterministic or hydration-unsafe ID strategies with deterministic IDs.
- [ ] Centralize canonical error creation helpers and update invariant call sites to use them.
- [ ] Remove or gate all production debug logging.
- [ ] Introduce shared utility modules or move existing adapter logic into core where the behavior is cross-framework.
- [ ] Add core unit tests for utility determinism, export resolution, and canonical error behavior.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm test -- --run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run build`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run lint`
- Create a temporary consumer import smoke test for `@uifn/core/aria/keys`, `@uifn/core/state/*`, and `@uifn/core/utils/*`

Expected outcomes:

- Core tests exist and pass.
- Public core utility imports resolve without workspace alias magic.
- No production debug logging remains in built output.

# Stop condition

Report the final core export surface, deterministic ID strategy, and canonical error code list before moving to primitive family behavior.
