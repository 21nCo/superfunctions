# @uifn/vue

Experimental Vue adapter exports for `uifn` primitives.

## Status

Experimental. This package is public but not part of the GA release bar.

The canonical package matrix and compatibility matrix live in the root `uifn/README.md`.

## Installation

```bash
npm install @uifn/core @uifn/vue
```

## Usage

```ts
import { Checkbox, Dialog } from "@uifn/vue";
```

## Current Public Surface

`@uifn/vue` currently exports the component-family modules rooted at `uifn/vue/src/index.ts`, including Accordion, AlertDialog, Avatar, Badge, Checkbox, Collapsible, Combobox, ContextMenu, Dialog, DropdownMenu, HoverCard, Label, MenuBar, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Slider, Switch, Tabs, Toast, Toggle, ToggleGroup, Toolbar, and Tooltip.

The public Vue contract for this release train is the package root export only. This Experimental package does not document stable subpaths or GA-complete part-by-part parity with the React or Svelte adapters.

The Experimental Vue package does not currently claim:

- GA parity with the React or Svelte adapters,
- `VirtualizedList`, `Portal`, `Presence`, or `Slot`, or
- composable-first helpers such as `useCheckbox` or `useDialog`.

## Release Policy

See the root `uifn/README.md` for the compatibility matrix and the `verify:uifn-release` contract. This package remains in the release gate for manifest, export-map, and pack-hygiene checks even while Experimental.

## License

MIT
