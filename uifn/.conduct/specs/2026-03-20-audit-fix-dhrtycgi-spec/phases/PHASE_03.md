# Phase goal

Bring the core popup, menu, select, combobox, and scroll families to the published production contract.

# In scope / Out of scope

In scope:

- `Dialog`, `AlertDialog`
- `Popover`, `Tooltip`, `HoverCard`
- `DropdownMenu`, `ContextMenu`, `MenuBar`, `Toolbar`
- `Select`, `Combobox`
- `ScrollArea`

Out of scope:

- React-specific `asChild` and ref wiring
- Svelte-specific reactive binding behavior

# Deliverables

- `uifn/core/src/primitives/dialog.ts`
- `uifn/core/src/primitives/alert-dialog.ts`
- `uifn/core/src/primitives/popover.ts`
- `uifn/core/src/primitives/tooltip.ts`
- `uifn/core/src/primitives/hover-card.ts`
- `uifn/core/src/primitives/dropdown-menu.ts`
- `uifn/core/src/primitives/context-menu.ts`
- `uifn/core/src/primitives/menu-bar.ts`
- `uifn/core/src/primitives/toolbar.ts`
- `uifn/core/src/primitives/select.ts`
- `uifn/core/src/primitives/combobox.ts`
- `uifn/core/src/primitives/scroll-area.ts`
- `uifn/core/src/utils/position.ts`
- `uifn/core/src/utils/focus-trap.ts`
- `uifn/core/src/utils/presence.ts`
- `uifn/core/src/primitives/**/*.test.ts`

# Requirements covered

- `CORE-001`
- `CORE-004`
- `DLG-001`
- `POP-001`
- `MENU-001`
- `SEL-001`
- `CMB-001`
- `SCROLL-001`

# Implementation tasks

- [ ] Implement shared popup open/close reasons, focus trap/return, outside-interaction, and scroll-lock semantics.
- [ ] Implement collision-aware positioning in core and wire popup families to it.
- [ ] Implement menu-family navigation, submenu state, and disabled-item handling in core.
- [ ] Implement select typeahead/grouping and combobox filter/highlight/empty-state contracts.
- [ ] Implement scroll-area synchronization primitives.
- [ ] Add deterministic unit tests for popup geometry, navigation, and selection vectors.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm test -- --run dialog alert-dialog popover tooltip hover-card dropdown-menu context-menu menu-bar toolbar select combobox scroll-area`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run build`
- Run manual smoke fixtures for nested menu, combobox filter, and dialog escape/outside-click behavior

Expected outcomes:

- Popup/menu/select/combobox/scroll core tests pass.
- Shared positioning and dismissal helpers are now used by the in-scope families.

# Stop condition

Report the final shared popup/menu/select utility set and confirm that adapters can now bind to core rather than owning divergent behavior.
