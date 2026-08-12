# PHASE_05 Completion Report

## Metadata

- timestamp: 2026-06-27T16:07:36Z
- agent_name: Codex
- model: GPT-5 Codex
- launcher: Codex Desktop
- repo root: repo root
- OS: Darwin arm64
- shell: zsh
- git branch: SFN-15
- git commit: 9cf381238d1d8a11c899d6808ffb0bb73dfe839a
- git dirty status: dirty, continuing the same SFN-15 multi-phase implementation worktree

## Phase

PHASE_05: React Adapter

## Status

PASS

## Requirements Summary

### CORE-001

Status: PASS

Acceptance criteria evidence:

- Every stateful primitive in the React migration surface now consumes a framework-agnostic core controller through hooks: `useDialog`, `useCheckbox`, `useTabs`, `useSelect`, `usePopover`, and `useTooltip`.
- Core controller shape remains covered by `uifn/core/src/__tests__/controller-contract.test.ts`, including `state`, `actions`, `parts`, `getState`, `subscribe`, and `destroy`.
- Deterministic controller environment coverage passed in `npm --workspace @uifn/core run test`.
- Core typecheck passed, and React hook code imports controller APIs from `@uifn/core` instead of duplicating primitive behavior.

Test status:

- PASS: `npm --workspace @uifn/core run typecheck`
- PASS: `npm --workspace @uifn/core run test` - 32 files, 104 tests
- PASS: `npm --workspace @uifn/react run test` - 26 files, 66 tests

### CORE-002

Status: PASS

Acceptance criteria evidence:

- React prop getters are derived through `uifn/react/src/core-props.ts`, which translates core DOM-ish part metadata into React props while preserving generated ARIA, data attributes, ids, roles, tab indexes, and handlers.
- Controller-backed React components use canonical part getters for root, trigger, content, item, value, listbox, indicator, portal-adjacent surfaces, and popup content where applicable.
- Required accessibility override behavior remains covered by `uifn/core/src/__tests__/primitive-vectors.test.ts` and `uifn/core/src/__tests__/controller-contract.test.ts`.
- A closed Select regression was fixed in `uifn/core/src/primitives/select.ts`: closed triggers no longer emit `aria-activedescendant` for unmounted options. `uifn/core/src/__tests__/controller-contract.test.ts` now asserts the closed and open states.

Test status:

- PASS: `npm --workspace @uifn/core run test` - 32 files, 104 tests
- PASS: `npm --workspace @uifn/react run test` - 26 files, 66 tests
- PASS: focused Select a11y rerun during debugging: `vitest run src/accordion.a11y.test.tsx -t "select family"`

### ADAPT-001

Status: PASS

Acceptance criteria evidence:

- `uifn/react/src/conformance/react-conformance.ts` imports `runAdapterConformance`, `assertAdapterConformance`, and `ADAPTER_KIT_MINIMAL_VECTORS` from `@uifn/adapter-kit`.
- `uifn/react/src/__tests__/react-core-adapter.test.tsx` runs `runReactAdapterConformance()` and asserts React passes the shared conformance vectors.
- `scripts/verify-uifn-adapter.mjs` checks the React adapter files, required conformance source contract, and `@uifn/core` / `@uifn/adapter-kit` package dependencies.
- `node scripts/verify-uifn-package-graph.mjs` passed with no cycles and no upward layer imports.

Test status:

- PASS: `npm run verify:uifn-adapter -- --framework react`
- PASS: `node scripts/verify-uifn-package-graph.mjs`

### ADAPT-002

Status: PASS

Acceptance criteria evidence:

- Hook APIs were added for controller-backed primitives under `uifn/react/src/hooks/`.
- Compound component APIs were rebuilt on the hook/controller layer for Dialog, Checkbox, Tabs, Select, Popover, and Tooltip.
- Headless prop getters are exposed from hooks and covered by `uifn/react/src/__tests__/react-core-adapter.test.tsx`.
- Slot composition is supported where semantically valid through `asChild` on Dialog, Checkbox, Popover, and Tooltip trigger/root surfaces.
- SSR/hydration is covered by `uifn/react/src/__tests__/react-core-adapter.test.tsx` and the existing `uifn/react/src/ssr-hydration.test.tsx`.

Test status:

- PASS: `npm --workspace @uifn/react run test` - 26 files, 66 tests
- PASS: `npm --workspace @uifn/react run typecheck`
- PASS: `npm --workspace @uifn/react run build`

## Deliverables Summary

Files added for this phase:

- `scripts/verify-uifn-adapter.mjs`
- `uifn/react/src/core-props.ts`
- `uifn/react/src/hooks/index.ts`
- `uifn/react/src/hooks/use-controller.ts`
- `uifn/react/src/hooks/use-dialog.ts`
- `uifn/react/src/hooks/use-checkbox.ts`
- `uifn/react/src/hooks/use-tabs.ts`
- `uifn/react/src/hooks/use-select.ts`
- `uifn/react/src/hooks/use-popover.ts`
- `uifn/react/src/hooks/use-tooltip.ts`
- `uifn/react/src/conformance.ts`
- `uifn/react/src/conformance/index.ts`
- `uifn/react/src/conformance/react-conformance.ts`
- `uifn/react/src/__tests__/react-core-adapter.test.tsx`

Files modified for this phase:

- `package.json`
- `package-lock.json`
- `uifn/react/package.json`
- `uifn/react/tsup.config.ts`
- `uifn/react/src/index.ts`
- `uifn/react/src/dialog.tsx`
- `uifn/react/src/checkbox.tsx`
- `uifn/react/src/tabs.tsx`
- `uifn/react/src/select.tsx`
- `uifn/react/src/popover.tsx`
- `uifn/react/src/tooltip.tsx`
- `uifn/react/src/accordion.a11y.test.tsx`
- `uifn/core/src/primitives/select.ts`
- `uifn/core/src/primitives/popover.ts`
- `uifn/core/src/__tests__/controller-contract.test.ts`

Files deleted:

- None.

## Verification Summary

Phase verification steps executed:

- PASS: `npm --workspace @uifn/react run test`
- PASS: `npm --workspace @uifn/react run typecheck`
- PASS: `npm run verify:uifn-adapter -- --framework react`

Additional verification executed:

- PASS: `npm --workspace @uifn/core run build`
- PASS: `npm --workspace @uifn/core run typecheck`
- PASS: `npm --workspace @uifn/core run test`
- PASS: `node scripts/verify-uifn-package-graph.mjs`
- PASS: `npm --workspace @uifn/react run build`
- PASS: `rg -n "TODO|FIXME|\\bdefer|deferred|Nucleus|[REDACTED_LOCAL_PATH]" uifn/react/src uifn/core/src scripts/verify-uifn-adapter.mjs` returned no matches

Test execution results:

- `@uifn/core`: 32 test files passed, 104 tests passed.
- `@uifn/react`: 26 test files passed, 66 tests passed.
- Expected jsdom stderr appeared during React tests for unsupported canvas, pseudo-element computed styles, navigation, and an intentional Avatar context throw assertion; all related tests passed.
- React adapter verifier returned `{ "ok": true, "command": "verify:uifn-adapter", "framework": "react" }`.
- Package graph verifier returned `{ "ok": true }` with no cycles and no upward layer imports.

## Notes

- React now follows the shared behavior contract: same core state, same part names, same data attributes, and React-native hooks/components as the public adapter ergonomics.
- `asChild` is implemented only where the current primitive semantics can safely preserve the host element.
- The Select a11y fix intentionally lives in core because closed-state `aria-activedescendant` would be invalid for every adapter when options are not mounted.
- `@uifn/core` was rebuilt before React verification because React resolves the workspace package through its built exports.
- Build outputs under `uifn/core/dist` and `uifn/react/dist` did not appear as tracked worktree changes.
- PHASE_05 did not modify the project tracker because it is not the final phase.

## Ready For Next Phase?

Yes. PHASE_05 requirements are implemented and verified, and no React primitive is currently known to diverge from the core vectors covered by this phase.

## Blockers

None.
