# Phase goal

Make the Svelte adapter warning-free, deterministic, and aligned with the core infrastructure contract.

# In scope / Out of scope

In scope:

- Elimination of random IDs and fixed shared IDs in Svelte infrastructure
- Canonical context/error assertions for Svelte provider lookups
- Warning-free build/tooling behavior and stable declaration output
- Controlled-reactivity infrastructure for the GA Svelte surface

Out of scope:

- Full family-level Svelte parity for dialog, tabs, menu, select, combobox, range, and scroll-area
- Root/package docs and release evidence work

# Deliverables

- `uifn/svelte/src/Dialog.svelte`
- `uifn/svelte/src/AlertDialog.svelte`
- `uifn/svelte/src/Tabs.svelte`
- `uifn/svelte/src/index.ts`
- `uifn/svelte/src/index.d.mts`
- `uifn/svelte/src/internal/focus-trap.ts`
- `uifn/svelte/src/internal/portal.ts`
- `uifn/svelte/src/internal/position.ts`
- `uifn/svelte/src/controlled-reactivity.test.ts`
- `uifn/svelte/tsup.config.ts`
- `uifn/svelte/package.json`

# Requirements covered

- `CORE-002`
- `CORE-003`
- `CORE-004`
- `SVELTE-001`
- `SVELTE-002`

# Implementation tasks

- [ ] Replace all `Math.random()`-derived or fixed public IDs with core-backed deterministic ID derivation.
- [ ] Introduce Svelte-safe assertion helpers around `getContext` so missing providers fail with canonical `UIFnError` instead of raw `TypeError`.
- [ ] Remove the `state_referenced_locally` warning filter and fix the underlying component patterns until the build is warning-free without suppression.
- [ ] Ensure the build emits or references stable type declarations that match the actual public component surface.
- [ ] Normalize controlled prop update semantics for Svelte root components that own open/value/activation state.
- [ ] Add infrastructure-focused regression coverage for deterministic IDs, context misuse, and warning-free builds.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run build`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run lint`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run test -- --run src/controlled-reactivity.test.ts`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run typecheck`

Expected outcomes:

- The Svelte build completes without suppressed GA warnings.
- Root Svelte components stop producing nondeterministic IDs.
- Missing-provider failures become typed and predictable.

# Stop condition

Report the Svelte ID/context infrastructure changes, confirm that warning suppression is gone, and list any remaining family-level parity work for Phase 07.
