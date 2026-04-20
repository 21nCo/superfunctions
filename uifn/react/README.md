# @uifn/react

Unstyled, accessible React primitives built on `@uifn/core`.

## Status

GA

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

`@uifn/react` exports component families including:

- Accordion, AlertDialog, Avatar, Badge, Checkbox, Collapsible, Combobox
- ContextMenu, Dialog, DropdownMenu, HoverCard, Label, MenuBar, Popover
- Progress, RadioGroup, ScrollArea, Select, Separator, Slider, Switch
- Tabs, Toast, Toggle, ToggleGroup, Toolbar, Tooltip, VirtualizedList
- `Portal`, `Presence`, and `Slot` helper exports

## Display Helpers Contract

- `Avatar`, `Badge`, `Label`, `Separator`, and `VirtualizedList` are part of the GA React adapter surface.
- `AvatarFallback` rendering is deterministic: it renders whenever the image is not in the `loaded` state, with optional `delayMs` gating before fallback appears.
- `VirtualizedList` is adapter-only and not part of `@uifn/core`.
- `VirtualizedList` windowing is deterministic: `overscan` defaults to `3`; render contract is `renderItem(item, index)` with required `items`, `itemHeight`, and `height`.

## Compatibility

- React: `18.2+`
- Node.js: `18.x`, `20.x`, `22.x`

## Example Playground

The React playground lives in [`uifn/examples/react-playground`](../examples/react-playground) and is documented from the shared example hub at [`uifn/examples/README.md`](../examples/README.md).

Run it from the repository root with:

```bash
npm --workspace @uifn/examples run dev:react
```

## License

MIT
