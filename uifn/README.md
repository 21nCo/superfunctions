# uifn

`uifn` is an unstyled primitives package family built around a shared core plus framework adapters.

## Canonical Package Matrix

| Package | Status | Release role | Current public contract |
| --- | --- | --- | --- |
| `@uifn/core` | GA | Release-blocking | Shared primitive/state/ARIA utilities plus canonical errors |
| `@uifn/react` | GA | Release-blocking | React adapter for the shipped GA family catalog |
| `@uifn/svelte` | GA | Release-blocking | Svelte adapter for the shipped GA family catalog |
| `@uifn/vue` | Experimental | Public but non-GA | Current Vue component-family root exports only |
| `@uifn/files` | Experimental | Public but non-GA | Typed file UX helper/state factories only |

GA packages are release-blocking for the current release train. Experimental packages are public, but they do not carry the GA support bar.

Unsupported adapters such as Solid and web-components are not part of the public `uifn` contract.

## Shipped Surface Summary

- `@uifn/core` ships the stable root entry plus `./aria`, `./aria/*`, `./state`, `./state/*`, `./utils`, `./utils/*`, `./errors`, and `./primitives/*`.
- `@uifn/react` ships the current GA family catalog: Accordion, AlertDialog, Avatar, Badge, Checkbox, Collapsible, Combobox, ContextMenu, Dialog, DropdownMenu, HoverCard, Label, MenuBar, Popover, Progress, RadioGroup, ScrollArea, Select, Separator, Slider, Switch, Tabs, Toast, Toggle, ToggleGroup, Toolbar, Tooltip, and VirtualizedList, plus `Portal`, `Presence`, and `Slot`.
- `@uifn/svelte` ships the same GA family catalog as the current Svelte package entry point, including the display-helper surfaces `Avatar`, `Badge`, `Label`, `Separator`, and `VirtualizedList`.
- `@uifn/vue` remains public but Experimental. It ships the component-family root exports in `uifn/vue/src/index.ts` and does not claim GA parity or composable-first helper APIs.
- `@uifn/files` remains public but Experimental. It ships typed helper factories for file dropzone, upload progress, file list, quota usage, pricing plans, and usage analytics state.

Package entry points are the authoritative source for the exact currently exported symbols. Public docs name shipped roots and helper surfaces only; they do not imply unexported extras such as `TooltipProvider`, `TooltipArrow`, `ComboboxEmpty`, combobox multiple selection, or unshipped ContextMenu checkbox/radio/submenu parts.

Display-helper contract:

- `Avatar`, `Badge`, `Label`, and `Separator` are GA only in `@uifn/react` and `@uifn/svelte`.
- `AvatarFallback` remains adapter-owned and deterministic: when `delayMs` is provided, fallback rendering waits for that delay before appearing while the avatar is still not `loaded`.
- `VirtualizedList` is adapter-only and is not exported by `@uifn/core`.
- `VirtualizedList` defaults `overscan` to `3`, and helper scale claims are verified in the adapter test suites.

## Install

GA packages:

```bash
npm install @uifn/core @uifn/react @uifn/svelte
```

Experimental packages are opt-in:

```bash
npm install @uifn/vue @uifn/files
```

## Compatibility Matrix

This table is the authoritative compatibility matrix for the current `uifn` release train. Package READMEs reference this table instead of restating it.

| Surface | Supported range |
| --- | --- |
| Node.js | `18.x`, `20.x`, `22.x` |
| React adapter | `react` and `react-dom` `18.2+` |
| Svelte adapter | `svelte` `5.x` |
| Vue adapter (Experimental) | `vue` `3.5+` |
| Browsers | current evergreen Chrome, Edge, Firefox, Safari |

## Release Gate Contract

Dry-run contract output:

```bash
npm run verify:uifn-release -- --dry-run
```

Full gate:

```bash
npm run verify:uifn-release
```

`scripts/verify-uifn-release.mjs` is the canonical local release gate. The dry run emits a machine-readable contract manifest that names:

- the release-blocking GA packages,
- the public Experimental packages,
- the required package checks,
- the export-map and pack-hygiene rules,
- the evidence paths that the full release contract must satisfy, and
- the warning policy that GA packages must not bypass.

The full gate validates build, lint, test, typecheck, export-map, pack output, manifest metadata, and support-matrix metadata for every public `uifn` package. For the GA release track it also requires:

- consumer smoke evidence at `uifn/.conduct/release-evidence/consumer-smoke.json` for `@uifn/core`, `@uifn/react`, and `@uifn/svelte`,
- manual accessibility evidence at `uifn/.conduct/release-evidence/manual-a11y.json` for `@uifn/react` and `@uifn/svelte`, and
- no suppressed GA framework/compiler warnings in release-blocking packages.

Passing `npm run verify:uifn-release -- --dry-run` is only a contract preview. Production-readiness claims for the GA track require the full gate plus the required consumer-smoke and manual accessibility evidence files.

`@uifn/vue` and `@uifn/files` remain in the gate for manifest, export-map, and pack-hygiene checks, but they are not release-blocking for the GA adapter evidence requirements.

See `uifn/SPEC.md` for the public release-contract baseline.

## License

MIT
