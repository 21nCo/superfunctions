# @uifn/react

Unstyled, accessible React primitives built on `@uifn/core`.

## Status

GA. This package is release-blocking together with `@uifn/core` and `@uifn/svelte`.

The canonical package matrix and compatibility matrix live in the root `uifn/README.md`.

## Installation

```bash
npm install @uifn/core @uifn/react
```

## Usage

```tsx
import { Checkbox, CheckboxIndicator } from "@uifn/react";

export function Example() {
  return (
    <Checkbox defaultChecked={false}>
      <CheckboxIndicator>✓</CheckboxIndicator>
    </Checkbox>
  );
}
```

## Public Surface

`@uifn/react` currently ships the family names Accordion, AlertDialog, Avatar, Badge, Checkbox, Collapsible, Combobox, ContextMenu, Dialog, DropdownMenu, HoverCard, Label, MenuBar, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Slider, Switch, Tabs, Toast, Toggle, ToggleGroup, Toolbar, Tooltip, and VirtualizedList.

The root React entry point is the authoritative source for the exact currently shipped symbols. This README intentionally names family roots and helper exports only; it does not imply unsupported extras such as `TooltipProvider`, `TooltipArrow`, `ComboboxEmpty`, or combobox multiple selection.

Helper exports:

- `Portal`
- `Presence`
- `Slot`

Display-helper contract:

- `Avatar`, `Badge`, `Label`, `Separator`, and `VirtualizedList` are part of the GA React adapter surface.
- `AvatarFallback` rendering is deterministic: it renders when the avatar image is not in the `loaded` state and optional `delayMs` postpones fallback visibility until that delay elapses.
- `VirtualizedList` is adapter-only and not part of `@uifn/core`.
- `VirtualizedList` defaults `overscan` to `3`.

## Release Policy

See the root `uifn/README.md` for the compatibility matrix, the release-blocking package matrix, and the `verify:uifn-release` contract.

## Example Playground

The React playground lives in [`uifn/examples/react-playground`](../examples/react-playground) and is documented from the shared example hub at [`uifn/examples/README.md`](../examples/README.md).

Run it from the repository root with:

```bash
npm --workspace @uifn/examples run dev:react
```

## License

MIT
