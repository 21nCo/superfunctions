# @uifn/core

Framework-agnostic runtime semantics, state helpers, and accessibility utilities for `uifn` primitives.

## Status

GA

## Installation

```bash
npm install @uifn/core
```

## Public Imports

```ts
import { createDialog } from "@uifn/core/primitives/dialog";
import { K } from "@uifn/core/aria/keys";
import { createMachine } from "@uifn/core/state/machine";
import { generateId } from "@uifn/core/utils/id";
```

## Package Surface

- `@uifn/core/primitives/*`
- `@uifn/core/aria/*`
- `@uifn/core/state/*`
- `@uifn/core/utils/*`

`@uifn/core` does not export adapter display helpers (`Avatar`, `Badge`, `Label`, `Separator`, `VirtualizedList`) directly; those are shipped by adapter packages.

## Adapter Packages

- `@uifn/react` (GA)
- `@uifn/svelte` (GA)
- `@uifn/vue` (Experimental)

## License

MIT
