# @uifn/vue

Experimental Vue adapter exports for `uifn` primitives.

## Status

Experimental

This package is public but not GA. API and behavior may change in minor releases while the adapter is hardened.

## Installation

```bash
npm install @uifn/core @uifn/vue
```

## API Shape

`@uifn/vue` currently exports component modules (for example `Checkbox`, `Dialog`, `Popover`, `Select`) from `src/index.ts`.

Current exported families include Accordion, AlertDialog, Avatar, Badge, Checkbox, Collapsible, Combobox, ContextMenu, Dialog, DropdownMenu, HoverCard, Label, MenuBar, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Slider, Switch, Tabs, Toast, Toggle, ToggleGroup, Toolbar, and Tooltip.

`VirtualizedList` is not currently exported by the Vue adapter.

It does **not** currently ship a stable composable-first surface such as `useCheckbox` / `useDialog`.

## Compatibility

- Vue: `3.5+`
- Node.js: `18.x`, `20.x`, `22.x`

## License

MIT
