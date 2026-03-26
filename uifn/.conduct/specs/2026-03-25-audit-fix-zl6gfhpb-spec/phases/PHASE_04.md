# Phase goal

Make the React adapter conform to the core determinism, error, and SSR/hydration infrastructure contracts.

# In scope / Out of scope

In scope:

- React-side adoption of core ID and error helpers
- Ref-safe, `asChild`-safe, SSR/hydration-safe infrastructure
- Multi-instance safety and shared hook cleanup rules

Out of scope:

- Full React family parity for dialog, menu, select, combobox, and helper components
- Svelte adapter changes

# Deliverables

- `uifn/react/src/hooks/use-id.ts`
- `uifn/react/src/hooks/use-composed-refs.ts`
- `uifn/react/src/hooks/use-controllable-state.ts`
- `uifn/react/src/hooks/use-focus-trap.ts`
- `uifn/react/src/hooks/use-body-scroll-lock.ts`
- `uifn/react/src/hooks/use-position.ts`
- `uifn/react/src/hooks/use-roving-focus.ts`
- `uifn/react/src/hooks/use-escape-keydown.ts`
- `uifn/react/src/hooks/use-outside-click.ts`
- `uifn/react/src/portal.tsx`
- `uifn/react/src/presence.tsx`
- `uifn/react/src/index.ts`
- `uifn/react/src/ssr-hydration.test.tsx`
- `uifn/react/src/ga-family-integration.test.tsx`

# Requirements covered

- `CORE-002`
- `CORE-003`
- `CORE-004`
- `REACT-001`
- `REACT-002`

# Implementation tasks

- [ ] Replace React-local or fixed public ID generation with bindings to the core deterministic ID contract.
- [ ] Replace ad hoc `throw new Error(...)` provider/context failures with canonical `UIFnError` assertions.
- [ ] Ensure ref composition, portal lifecycle, outside-click, and escape handling follow shared cleanup semantics.
- [ ] Prove SSR/hydration safety and multi-instance ARIA correctness with explicit regression tests.
- [ ] Validate that `asChild` usage remains typed and ref-safe only on the surfaces that actually document it.
- [ ] Expose only the verified React adapter surface from `src/index.ts`.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run build`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run lint`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run test -- --run src/ssr-hydration.test.tsx src/ga-family-integration.test.tsx`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run typecheck`

Expected outcomes:

- React infrastructure no longer emits plain `Error` for contract misuse.
- Multi-instance and SSR/hydration regressions are covered at the adapter layer.
- Shared hooks and portals follow the core determinism and cleanup rules.

# Stop condition

Report the React infrastructure invariants that are now enforced and list any remaining family-level gaps to close in Phase 05.
