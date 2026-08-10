# Core Controller And Anatomy Closure

- timestamp: 2026-06-28T08:31:17Z
- requirements: CORE-001, CORE-002, TEST-001 evidence update

## Previous State

The core controller contract was still incomplete. Only Dialog, Checkbox, Tabs, Select, Tooltip, and Popover had migrated public controller APIs, while the migration inventory still marked Accordion, AlertDialog, Avatar, Collapsible, Combobox, ContextMenu, DropdownMenu, HoverCard, MenuBar, Progress, RadioGroup, ScrollArea, Separator, Slider, Switch, Toast, Toggle, ToggleGroup, and Toolbar as remaining.

The controller tests were representative rather than inventory-level. They proved a few controller shapes and generic merge behavior, but they did not prove every stateful primitive exposed `createXController(config, env?)`, did not prove every primitive controller had `state`, `actions`, `parts`, `getState`, `subscribe`, and `destroy`, and did not sample the full part anatomy surface against hostile user props.

## Final State

The missing public controller APIs are implemented in `uifn/core/src/primitives/controller-adapters.ts` by wrapping the existing primitive behavior machines with the uniform controller contract. These controllers expose deterministic environment-backed IDs, `state`, `actions`, `parts`, `getState`, `subscribe`, and `destroy`, while preserving the underlying behavior already implemented in the primitive machines.

The public primitive export surface now includes:

- `createAccordionController`
- `createAlertDialogController`
- `createAvatarController`
- `createCollapsibleController`
- `createComboboxController`
- `createContextMenuController`
- `createDropdownMenuController`
- `createHoverCardController`
- `createMenuBarController`
- `createProgressController`
- `createRadioGroupController`
- `createScrollAreaController`
- `createSeparatorController`
- `createSliderController`
- `createSwitchController`
- `createToastController`
- `createToggleController`
- `createToggleGroupController`
- `createToolbarController`

Tooltip now also exposes canonical `root` anatomy in addition to trigger, content, and arrow parts.

The migration inventory now marks every primitive controller as migrated, and the controller contract test proves that the migration list matches the executable controller inventory. The test samples static, value-scoped, index-scoped, and axis-scoped parts across all primitive controllers and verifies that adversarial user props cannot override generated `role`, `id`, `tabIndex`, `aria`, or `data` metadata.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/core run test -- src/__tests__/controller-contract.test.ts`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/core run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/core run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/core run build`
- targeted core source scan found no React/Svelte/Vue/Solid/Angular/Tailwind imports.
- `PATH=<node22-bin>:$PATH git diff --check`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Residual Risk

CORE-001 and CORE-002 are complete. TEST-001 remains in progress because COMP-001, COMP-002, and COMP-003 are still open, even though the aggregate release gate passes 83/83.
