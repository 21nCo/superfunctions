# Phase goal

Bring popup, modal, menu, select, combobox, range, and scroll-area semantics under authoritative core control.

# In scope / Out of scope

In scope:

- Dialog and alert-dialog close reasons, modal-state rules, and scroll-lock contract
- Popup positioning, outside-click, escape-key, and cleanup semantics
- Menu-family navigation and submenu depth rules
- Select, combobox, slider, progress, and scroll-area shared semantics

Out of scope:

- React and Svelte adapter wiring
- Docs and release evidence work

# Deliverables

- `uifn/core/src/primitives/dialog.ts`
- `uifn/core/src/primitives/dialog.test.ts`
- `uifn/core/src/primitives/alert-dialog.ts`
- `uifn/core/src/primitives/alert-dialog.test.ts`
- `uifn/core/src/primitives/popover.ts`
- `uifn/core/src/primitives/popover.test.ts`
- `uifn/core/src/primitives/hover-card.ts`
- `uifn/core/src/primitives/hover-card.test.ts`
- `uifn/core/src/primitives/dropdown-menu.ts`
- `uifn/core/src/primitives/dropdown-menu.test.ts`
- `uifn/core/src/primitives/context-menu.ts`
- `uifn/core/src/primitives/context-menu.test.ts`
- `uifn/core/src/primitives/menu-bar.ts`
- `uifn/core/src/primitives/menu-bar.test.ts`
- `uifn/core/src/primitives/select.ts`
- `uifn/core/src/primitives/select.test.ts`
- `uifn/core/src/primitives/combobox.ts`
- `uifn/core/src/primitives/combobox.test.ts`
- `uifn/core/src/primitives/slider.ts`
- `uifn/core/src/primitives/slider.test.ts`
- `uifn/core/src/primitives/progress.ts`
- `uifn/core/src/primitives/progress.test.ts`
- `uifn/core/src/primitives/scroll-area.ts`
- `uifn/core/src/primitives/scroll-area.test.ts`
- `uifn/core/src/utils/focus-trap.ts`
- `uifn/core/src/utils/outside-click.ts`
- `uifn/core/src/utils/position.ts`
- `uifn/core/src/utils/position.test.ts`

# Requirements covered

- `CORE-001`
- `CORE-004`
- `DLG-001`
- `POP-001`
- `MENU-001`
- `SEL-001`
- `CMB-001`
- `RANGE-001`
- `SCROLL-001`

# Implementation tasks

- [ ] Define modal dialog semantics that require body-scroll locking, close-reason reporting, focus restoration, and unique content/title/description ID relationships.
- [ ] Encode popup and hover-card positioning behavior, dismissal reasons, and cleanup guarantees in reusable core contracts.
- [ ] Finalize menu-family keyboard semantics, submenu behavior, and any enforced submenu-depth limit.
- [ ] Normalize select and combobox item registration, highlighted state, hidden-input serialization, and content ID derivation.
- [ ] Define slider/progress value invariants and scroll-area axis/thumb synchronization rules with explicit error conditions.
- [ ] Add focused tests for duplicate-instance ID safety, keyboard navigation, geometry cleanup, and range bounds.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run test -- --run src/primitives/dialog.test.ts src/primitives/alert-dialog.test.ts src/primitives/popover.test.ts src/primitives/dropdown-menu.test.ts src/primitives/context-menu.test.ts src/primitives/menu-bar.test.ts src/primitives/select.test.ts src/primitives/combobox.test.ts src/primitives/slider.test.ts src/primitives/progress.test.ts src/primitives/scroll-area.test.ts`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run test -- --run src/utils/position.test.ts src/utils/roving-focus.test.ts`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run lint && npm run typecheck`

Expected outcomes:

- Core tests enforce the semantic rules that the adapters must implement for dialogs, popup families, select/combobox, range, and scroll surfaces.
- Duplicate-instance ARIA relationships are specified and covered.
- Scroll-lock and dismissal behavior become contractual rather than adapter folklore.

# Stop condition

Report the finalized core contracts for dialog/popup/select families, including close reasons and ID-derivation rules, before adapter conformance work begins.
