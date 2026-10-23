# Phase goal

Complete React family-level parity with the audited GA contract.

# In scope / Out of scope

In scope:

- React dialog, popup, menu, select, combobox, range, scroll-area, and helper-family conformance
- Removal of fixed content IDs and any remaining duplicated family semantics
- Helper contract proof for `AvatarFallback` and `VirtualizedList`

Out of scope:

- Svelte changes
- Root/package documentation cleanup except where an export must change immediately

# Deliverables

- `uifn/react/src/dialog.tsx`
- `uifn/react/src/alert-dialog.tsx`
- `uifn/react/src/popover.tsx`
- `uifn/react/src/dropdown-menu.tsx`
- `uifn/react/src/context-menu.tsx`
- `uifn/react/src/menu-bar.tsx`
- `uifn/react/src/select.tsx`
- `uifn/react/src/combobox.tsx`
- `uifn/react/src/tabs.tsx`
- `uifn/react/src/scroll-area.tsx`
- `uifn/react/src/slider.tsx`
- `uifn/react/src/progress.tsx`
- `uifn/react/src/avatar.tsx`
- `uifn/react/src/virtualized-list.tsx`
- `uifn/react/src/dialog.test.tsx`
- `uifn/react/src/alert-dialog.test.tsx`
- `uifn/react/src/popover.test.tsx`
- `uifn/react/src/dropdown-menu.test.tsx`
- `uifn/react/src/context-menu.test.tsx`
- `uifn/react/src/select.test.tsx`
- `uifn/react/src/combobox.test.tsx`
- `uifn/react/src/scroll-area.test.tsx`
- `uifn/react/src/slider.test.tsx`
- `uifn/react/src/ga-helper-coverage.test.tsx`

# Requirements covered

- `DLG-001`
- `POP-001`
- `MENU-001`
- `SEL-001`
- `CMB-001`
- `RANGE-001`
- `SCROLL-001`
- `SIMPLE-001`
- `REACT-001`
- `REACT-002`

# Implementation tasks

- [ ] Rebind React dialog, alert-dialog, popover, dropdown-menu, context-menu, menu-bar, select, and combobox surfaces to the finalized core contracts.
- [ ] Remove remaining fixed content IDs and prove duplicate-instance safety for every popup/select/combobox family.
- [ ] Ensure modal dialog/alert-dialog behavior includes scroll lock, focus restoration, and controlled open-state synchronization.
- [ ] Close React family keyboard and dismissal gaps, including menu navigation and tabs activation behavior.
- [ ] Validate `AvatarFallback` delayed rendering deterministically and prove `VirtualizedList` default `overscan=3` plus high-item-count behavior.
- [ ] Expand family tests until the known audit failures and partials have dedicated regression coverage.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run test -- --run src/dialog.test.tsx src/alert-dialog.test.tsx src/popover.test.tsx src/dropdown-menu.test.tsx src/context-menu.test.tsx src/select.test.tsx src/combobox.test.tsx src/scroll-area.test.tsx src/slider.test.tsx src/tabs.test.tsx src/ga-helper-coverage.test.tsx`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run build && npm run lint && npm run typecheck`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm pack --dry-run`

Expected outcomes:

- React family behavior matches the core contract without fixed-ID collisions.
- Helper surfaces meet their deterministic contract and scale expectations.
- The React package is independently releasable against the audited GA bar.

# Stop condition

Report the exact React families closed, the remaining evidence needed for GA signoff, and any export-surface changes that must be reflected in docs.
