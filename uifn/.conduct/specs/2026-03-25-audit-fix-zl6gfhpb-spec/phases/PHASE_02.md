# Phase goal

Move disclosure, tabs, and form-control semantics fully under shared core ownership.

# In scope / Out of scope

In scope:

- Core state and interaction semantics for accordion, collapsible, tabs, checkbox, switch, and radio-group
- Controlled versus uncontrolled behavior, keyboard navigation, hidden-input semantics, and reduced-motion-aware state transitions where applicable

Out of scope:

- Popup, menu, dialog, select, combobox, range, and scroll-area families
- Framework adapter integration work beyond the core contract

# Deliverables

- `uifn/core/src/primitives/accordion.ts`
- `uifn/core/src/primitives/accordion.test.ts`
- `uifn/core/src/primitives/collapsible.ts`
- `uifn/core/src/primitives/collapsible.test.ts`
- `uifn/core/src/primitives/tabs.ts`
- `uifn/core/src/primitives/tabs.test.ts`
- `uifn/core/src/primitives/checkbox.ts`
- `uifn/core/src/primitives/checkbox.test.ts`
- `uifn/core/src/primitives/switch.ts`
- `uifn/core/src/primitives/switch.test.ts`
- `uifn/core/src/primitives/radio-group.ts`
- `uifn/core/src/primitives/radio-group.test.ts`
- `uifn/core/src/utils/roving-focus.ts`
- `uifn/core/src/utils/roving-focus.test.ts`
- `uifn/core/src/state/machine.ts`

# Requirements covered

- `CORE-001`
- `CORE-004`
- `DISC-001`
- `FORM-001`

# Implementation tasks

- [ ] Refactor disclosure and tabs primitives so the authoritative open/value/activation semantics live in `@uifn/core`.
- [ ] Define roving-focus behavior for tabs, including Arrow, Home, End, manual activation, and disabled-item handling.
- [ ] Normalize checkbox, switch, and radio-group hidden-input and form-submission behavior in the core layer.
- [ ] Encode controlled/uncontrolled transition rules that adapters can bind to without duplicating decision logic.
- [ ] Add or expand unit coverage for keyboard navigation, disabled states, and serialization into form fields.
- [ ] Document any core machine outputs that React and Svelte must consume in later phases.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run test -- --run src/primitives/accordion.test.ts src/primitives/collapsible.test.ts src/primitives/tabs.test.ts src/primitives/checkbox.test.ts src/primitives/switch.test.ts src/primitives/radio-group.test.ts`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run lint`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run typecheck`

Expected outcomes:

- Tabs keyboard behavior is fully specified and enforced in core tests.
- Controlled and uncontrolled form/disclosure behavior no longer varies by adapter.
- Later adapter work can bind to core outputs instead of reimplementing state decisions.

# Stop condition

Report the finalized disclosure/form machine contracts, especially tabs keyboard rules and controlled-state invariants, before starting popup and modal families.
