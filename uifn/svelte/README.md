# @uifn/svelte

Unstyled, accessible Svelte primitives built on `@uifn/core`.

## Status

GA

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

`@uifn/svelte` exports the same primitive family names documented in the `uifn` support matrix, including Accordion, Dialog, DropdownMenu, Select, Tabs, Toast, Tooltip, and supporting display helpers such as Avatar, Badge, Label, and VirtualizedList.

## Display Helpers Contract

- `Avatar`, `Badge`, `Label`, `Separator`, and `VirtualizedList` are part of the GA Svelte adapter surface.
- `AvatarFallback` rendering is deterministic: fallback remains visible until avatar status becomes `loaded`, with optional `delayMs` before fallback appears.
- `VirtualizedList` is adapter-only and not part of `@uifn/core`.
- `VirtualizedList` windowing is deterministic: `overscan` defaults to `3`; render contract uses snippet children `children(item, index)` with required `items`, `itemHeight`, and `height`.

## Compatibility

- Svelte: `5.x`
- Node.js: `18.x`, `20.x`, `22.x`

## Example Playground

The Svelte playground lives in [`uifn/examples/svelte-playground`](../examples/svelte-playground) and is documented from the shared example hub at [`uifn/examples/README.md`](../examples/README.md).

Run it from the repository root with:

```bash
npm --workspace @uifn/examples run dev:svelte
```

## License

MIT
