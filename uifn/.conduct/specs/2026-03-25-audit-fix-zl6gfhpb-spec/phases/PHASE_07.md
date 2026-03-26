# Phase goal

Bring Svelte family behavior up to the same GA semantics required of the React adapter and the shared core.

# In scope / Out of scope

In scope:

- Svelte dialog, alert-dialog, tabs, popup, menu, select, combobox, range, scroll-area, and helper-family parity
- Body-scroll lock, keyboard navigation, controlled-state synchronization, and duplicate-instance ID safety
- Helper contract proof for `AvatarFallback` and `VirtualizedList`

Out of scope:

- Root/package documentation cleanup except where a shipped export must change immediately
- Final release-gate signoff

# Deliverables

- `uifn/svelte/src/DialogContent.svelte`
- `uifn/svelte/src/AlertDialogContent.svelte`
- `uifn/svelte/src/TabsList.svelte`
- `uifn/svelte/src/TabsTrigger.svelte`
- `uifn/svelte/src/Popover.svelte`
- `uifn/svelte/src/PopoverContent.svelte`
- `uifn/svelte/src/DropdownMenu.svelte`
- `uifn/svelte/src/DropdownMenuContent.svelte`
- `uifn/svelte/src/ContextMenu.svelte`
- `uifn/svelte/src/ContextMenuContent.svelte`
- `uifn/svelte/src/MenuBar.svelte`
- `uifn/svelte/src/MenuBarContent.svelte`
- `uifn/svelte/src/Select.svelte`
- `uifn/svelte/src/SelectTrigger.svelte`
- `uifn/svelte/src/SelectContent.svelte`
- `uifn/svelte/src/Combobox.svelte`
- `uifn/svelte/src/ComboboxTrigger.svelte`
- `uifn/svelte/src/ComboboxContent.svelte`
- `uifn/svelte/src/ScrollArea.svelte`
- `uifn/svelte/src/ScrollAreaScrollbar.svelte`
- `uifn/svelte/src/Slider.svelte`
- `uifn/svelte/src/AvatarFallback.svelte`
- `uifn/svelte/src/VirtualizedList.svelte`
- `uifn/svelte/src/dialog.test.ts`
- `uifn/svelte/src/alert-dialog.test.ts`
- `uifn/svelte/src/tabs.test.ts`
- `uifn/svelte/src/select.test.ts`
- `uifn/svelte/src/combobox.test.ts`
- `uifn/svelte/src/popover.test.ts`
- `uifn/svelte/src/dropdown-menu.test.ts`
- `uifn/svelte/src/context-menu.test.ts`
- `uifn/svelte/src/scroll-area.test.ts`
- `uifn/svelte/src/slider.test.ts`
- `uifn/svelte/src/ga-coverage.test.ts`

# Requirements covered

- `DISC-001`
- `DLG-001`
- `POP-001`
- `MENU-001`
- `SEL-001`
- `CMB-001`
- `RANGE-001`
- `SCROLL-001`
- `SIMPLE-001`
- `SVELTE-001`
- `SVELTE-002`

# Implementation tasks

- [ ] Implement modal body-scroll locking and controlled open-state synchronization for `Dialog` and `AlertDialog`.
- [ ] Rework Svelte tabs to use the core keyboard and activation contract, including Arrow, Home, End, and disabled-item behavior.
- [ ] Remove remaining fixed content IDs from popup/select/combobox families and validate multi-instance ARIA safety.
- [ ] Align menu-family navigation, submenu behavior, and dismissal cleanup with the core contract.
- [ ] Close select, combobox, scroll-area, and slider parity gaps, including hidden input, highlighted state, and geometry synchronization.
- [ ] Prove `AvatarFallback` timing behavior and `VirtualizedList` scale behavior with dedicated Svelte tests.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run test -- --run src/dialog.test.ts src/alert-dialog.test.ts src/tabs.test.ts src/select.test.ts src/combobox.test.ts src/popover.test.ts src/dropdown-menu.test.ts src/context-menu.test.ts src/scroll-area.test.ts src/slider.test.ts src/ga-coverage.test.ts`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run build && npm run lint && npm run typecheck`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm pack --dry-run`

Expected outcomes:

- Svelte modal and keyboard behavior reaches the same contract level as the shared core and React adapter.
- Duplicate-instance ARIA collisions are eliminated across GA Svelte families.
- Svelte helper and scale contracts are backed by explicit regression tests.

# Stop condition

Report the Svelte family behaviors closed, especially dialog scroll lock and tabs navigation, and identify any remaining doc/evidence updates required for release signoff.
