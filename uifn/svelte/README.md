# @uifn/svelte

Unstyled, accessible Svelte primitives built on `@uifn/core`.

## Status

GA. This package is release-blocking together with `@uifn/core` and `@uifn/react`.

The canonical package matrix and compatibility matrix live in the root `uifn/README.md`.

## Installation

```bash
npm install @uifn/core @uifn/svelte
```

## Usage

```svelte
<script lang="ts">
  import { Checkbox, CheckboxIndicator } from "@uifn/svelte";
</script>

<Checkbox>
  <CheckboxIndicator>✓</CheckboxIndicator>
</Checkbox>
```

## Public Surface

`@uifn/svelte` currently ships the family names Accordion, AlertDialog, Avatar, Badge, Checkbox, Collapsible, Combobox, ContextMenu, Dialog, DropdownMenu, HoverCard, Label, MenuBar, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Slider, Switch, Tabs, Toast, Toggle, ToggleGroup, Toolbar, Tooltip, and VirtualizedList.

The root Svelte entry point is the authoritative source for the exact currently shipped symbols. This README intentionally names family roots only; it does not imply unsupported extras such as `TooltipProvider`, `TooltipArrow`, `ComboboxEmpty`, combobox multiple selection, or unshipped ContextMenu checkbox/radio/submenu parts.

Display-helper contract:

- `Avatar`, `Badge`, `Label`, `Separator`, and `VirtualizedList` are part of the GA Svelte adapter surface.
- `AvatarFallback` rendering is deterministic: fallback remains visible until avatar status becomes `loaded`, and optional `delayMs` postpones fallback visibility until that delay elapses.
- `VirtualizedList` is adapter-only and not part of `@uifn/core`.
- `VirtualizedList` defaults `overscan` to `3`.

Packaging note:

- `@uifn/svelte` intentionally ships `src/index.ts`, `src/*.svelte`, and supporting `src/internal/*.ts` implementation files because the public Svelte entry point compiles from source.
- Those supporting files are not stable public subpath APIs.

## Release Policy

See the root `uifn/README.md` for the compatibility matrix, the release-blocking package matrix, and the `verify:uifn-release` contract.

## Example Playground

The Svelte playground lives in [`uifn/examples/svelte-playground`](../examples/svelte-playground) and is documented from the shared example hub at [`uifn/examples/README.md`](../examples/README.md).

Run it from the repository root with:

```bash
npm --workspace @uifn/examples run dev:svelte
```

## License

MIT
