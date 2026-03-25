# @uifn/core

Framework-agnostic runtime semantics, state helpers, accessibility utilities, and canonical errors for `uifn` primitives.

## Status

GA. This package is part of the release-blocking `uifn` surface.

The canonical package matrix and compatibility matrix live in the root `uifn/README.md`.

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

## Public Surface

- `@uifn/core`
- `@uifn/core/aria`
- `@uifn/core/aria/*`
- `@uifn/core/state`
- `@uifn/core/state/*`
- `@uifn/core/utils`
- `@uifn/core/utils/*`
- `@uifn/core/errors`
- `@uifn/core/primitives/*`

`@uifn/core` does not export adapter display helpers such as `Avatar`, `Badge`, `Label`, `Separator`, or `VirtualizedList`, and it does not define public adapter-only helper behavior such as `AvatarFallback` delay handling.

## Release Policy

See the root `uifn/README.md` for the compatibility matrix and the `verify:uifn-release` contract.

## License

MIT
