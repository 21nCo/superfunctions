# Phase goal

Make `@uifn/react` a GA adapter on top of the repaired core semantics.

# In scope / Out of scope

In scope:

- React export parity
- `asChild`/Slot semantics where documented
- Ref forwarding, SSR-safe hooks, hydration stability
- Adapter integration tests and accessibility smoke repair

Out of scope:

- Svelte implementation work
- Vue API redesign

# Deliverables

- `uifn/react/src/index.ts`
- `uifn/react/src/utils/slot.tsx`
- `uifn/react/src/portal.tsx`
- `uifn/react/src/presence.tsx`
- `uifn/react/src/hooks/use-id.ts`
- `uifn/react/src/hooks/use-roving-focus.ts`
- `uifn/react/src/hooks/use-focus-trap.ts`
- `uifn/react/src/hooks/use-position.ts`
- `uifn/react/src/**/*.tsx`
- `uifn/react/src/**/*.test.tsx`
- `uifn/react/vitest.config.mts`
- `uifn/react/package.json`

# Requirements covered

- `REACT-001`
- `REACT-002`
- `QA-001`
- `QA-002`
- `COMPAT-001`

# Implementation tasks

- [ ] Update React components to consume repaired core semantics instead of carrying divergent local logic.
- [ ] Implement or finish `asChild` support for documented polymorphic host components.
- [ ] Fix ref forwarding for interactive primitives.
- [ ] Remove broken import paths and update tests to use public exports.
- [ ] Replace skipped/broken accessibility smoke tests with runnable ones.
- [ ] Add SSR render/hydrate smoke tests for generated IDs and popup families.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm test -- --run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run build`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run lint`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm pack --dry-run`
- Run a local SSR + hydrate smoke fixture for `Dialog`, `Tabs`, and `Checkbox`

Expected outcomes:

- React package-local verification is green.
- No broken/skipped release-blocking a11y smoke test remains.
- `asChild` and ref forwarding behave correctly where documented.

# Stop condition

Report the React export list, the list of components supporting `asChild`, and the outcome of the SSR/hydration smoke tests.
