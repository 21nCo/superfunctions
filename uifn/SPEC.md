# UIFn Release Contract

## Purpose

This document is the public release-contract baseline for `uifn`. It is intentionally narrower than the full implementation bundle and only records package identity, shipped surface, compatibility ownership, and release-verification rules that must remain truthful during the current release train.

## Canonical Package Matrix

| Package | Status | Release role | Contract summary |
| --- | --- | --- | --- |
| `@uifn/core` | GA | Release-blocking | Shared primitive/state/ARIA utilities plus canonical errors |
| `@uifn/react` | GA | Release-blocking | Typed React adapter for the shipped GA family catalog |
| `@uifn/svelte` | GA | Release-blocking | Typed Svelte adapter for the shipped GA family catalog |
| `@uifn/vue` | Experimental | Public but non-GA | Current Vue component-family root exports only |
| `@uifn/files` | Experimental | Public but non-GA | Narrow typed file UX helper/state surface only |

Unsupported adapters such as Solid and web-components are outside the current public contract.

## Shipped Surface Rules

- Public docs, manifests, and export maps MUST only claim the canonical package names and status labels listed above.
- `@uifn/core` currently owns the stable root entry plus `./aria`, `./aria/*`, `./state`, `./state/*`, `./utils`, `./utils/*`, `./errors`, and `./primitives/*`.
- `@uifn/react` and `@uifn/svelte` currently ship the family names Accordion, AlertDialog, Avatar, Badge, Checkbox, Collapsible, Combobox, ContextMenu, Dialog, DropdownMenu, HoverCard, Label, MenuBar, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Slider, Switch, Tabs, Toast, Toggle, ToggleGroup, Toolbar, Tooltip, and VirtualizedList.
- `@uifn/react` additionally ships the helper exports `Portal`, `Presence`, and `Slot`.
- `Avatar`, `Badge`, `Label`, and `Separator` are adapter surfaces, not `@uifn/core` exports.
- `AvatarFallback` remains an adapter-owned helper surface with deterministic optional `delayMs` behavior while the avatar image is not `loaded`.
- `VirtualizedList` is adapter-only, is not part of the `@uifn/core` public surface, and defaults `overscan` to `3`.
- `@uifn/vue` remains Experimental and MUST NOT claim GA parity or composable-first helper APIs that are not currently exported.
- `@uifn/files` remains Experimental and MUST NOT claim primitive-family parity or framework component exports.
- Unsupported or unshipped surfaces such as `TooltipProvider`, `TooltipArrow`, `ComboboxEmpty`, combobox multiple selection, and unshipped ContextMenu checkbox/radio/submenu parts are outside this public contract until they are exported and documented together.

This root spec intentionally avoids part-by-part claims for adapter families. Package entry points and package READMEs are authoritative for the currently shipped symbol set.

## Compatibility Ownership

The authoritative compatibility matrix lives in `uifn/README.md#compatibility-matrix`.

- Package READMEs MUST reference that matrix instead of restating version ranges independently.
- Package manifests MUST match that matrix through `engines` and `peerDependencies`.
- Experimental packages MAY advertise narrower support, but they MUST do so truthfully and without implying GA status.

## Release Gate Contract

The canonical local release gate is:

```bash
npm run verify:uifn-release
```

The dry-run contract view is:

```bash
npm run verify:uifn-release -- --dry-run
```

The gate contract is fixed to the following baseline:

- Required package checks for every public package: `build`, `lint`, `test`, `typecheck`, `export-map`, `pack`.
- Required manifest checks: canonical package name, license, Node engine range, peer range, and declared package status.
- Required export-map checks: every package must expose the public entry points declared by this contract and MUST NOT drift in package identity.
- Required pack checks: tarballs must contain the intended typed entry assets and MUST NOT leak tests, fixtures, or unintended internal-only artifacts.
- Required evidence inputs for the GA release track:
  - `uifn/.conduct/release-evidence/consumer-smoke.json` for `@uifn/core`, `@uifn/react`, and `@uifn/svelte`
  - `uifn/.conduct/release-evidence/manual-a11y.json` for `@uifn/react` and `@uifn/svelte`
- Required warning policy: GA packages MUST NOT suppress framework/compiler warnings in the release path.

The gate emits a machine-readable JSON manifest to stdout. A passing full gate means the package contract, pack hygiene, smoke evidence, accessibility evidence, and warning policy all agree.

- A passing dry run alone is not proof of production readiness; only the full gate plus the required evidence files satisfies the GA release contract.

## License

MIT
