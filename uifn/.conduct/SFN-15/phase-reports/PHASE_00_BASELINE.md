# PHASE_00 Baseline Report

## Summary

Phase 00 completed the current-state inventory for `uifn`, locked the Coss UI capability snapshot, and identified the code surfaces that should be kept, rewritten, folded, removed, or created for SFN-15.

No runtime code was changed in this phase.

## Deliverables

- `uifn/.conduct/SFN-15/data/current-package-inventory.json`
- `uifn/.conduct/SFN-15/data/coss-catalog-snapshot.json`
- `uifn/.conduct/SFN-15/data/delete-or-rewrite-inventory.json`
- `uifn/.conduct/SFN-15/phase-reports/CLEAN_ROOM_POLICY.md`

## Current Package Inventory

Current public `uifn` packages:

| Package | Current status | Phase 00 disposition |
| --- | --- | --- |
| `@uifn/core` | GA in current docs | rewrite in place |
| `@uifn/react` | GA in current docs | rewrite in place |
| `@uifn/svelte` | GA in current docs | rewrite in place |
| `@uifn/vue` | Experimental in current docs | rewrite in place and promote after conformance |
| `@uifn/files` | Experimental in current docs | fold into patterns/sf or remove |

Current private example packages:

| Package | Phase 00 disposition |
| --- | --- |
| `@uifn/examples` | keep only as private fixture input or replace with Storybook |
| `@uifn/examples-shared` | keep useful fixtures as registry/story input |
| `@uifn/example-react-playground` | replace with Storybook coverage |
| `@uifn/example-svelte-playground` | replace with Storybook coverage |
| `@uifn/example-vue-playground` | replace with Storybook coverage |

## Current Primitive and Adapter Coverage

Current core primitive files: Accordion, Alert Dialog, Avatar, Checkbox, Collapsible, Combobox, Context Menu, Dialog, Dropdown Menu, Hover Card, Menu Bar, Popover, Progress, Radio Group, Scroll Area, Select, Separator, Slider, Switch, Tabs, Toast, Toggle, Toggle Group, Toolbar, Tooltip.

Current React adapter files include the core family plus adapter-only helpers such as Badge, Label, Portal, Presence, and VirtualizedList.

Current Svelte adapter has broad part-level component coverage with 108 top-level `.svelte` files.

Current Vue adapter covers many family roots but is documented as experimental and lacks SFN-15 first-class conformance status.

## Current Test Inventory

Current test file counts:

| Area | Count |
| --- | ---: |
| `@uifn/core` | 29 |
| `@uifn/react` | 26 |
| `@uifn/svelte` | 24 |
| `@uifn/vue` | 17 |
| `@uifn/files` | 1 |

The existing test inventory is useful but insufficient for SFN-15 because it does not prove shared controller conformance across React, Svelte, Vue, Solid, and Angular.

## Coss Capability Snapshot

The locked capability target is stored in `uifn/.conduct/SFN-15/data/coss-catalog-snapshot.json`.

Counts:

- 45 base components.
- 2 hook equivalents.

This snapshot is a capability target only. SFN-15 remains clean-room.

## Missing Target Packages

The following target packages do not exist yet:

- `@uifn/adapter-kit`
- `@uifn/solid`
- `@uifn/angular`
- `@uifn/tokens`
- `@uifn/theme`
- `@uifn/theme-tailwind`
- `@uifn/recipes`
- `@uifn/components`
- `@uifn/patterns`
- `@uifn/sf`
- `@uifn/registry`
- `@uifn/storybook`

## Conflicts With SFN-15

1. Current primitive factories do not yet implement the required `createXController(config, env?)` model with `state`, `actions`, `parts`, `getState`, `subscribe`, and `destroy`.
2. Current adapters do not yet share `@uifn/adapter-kit` conformance vectors.
3. Solid and Angular are absent.
4. Current Vue package is experimental, but SFN-15 requires first-class Vue support.
5. Current `@uifn/files` is not in the target public package architecture and should be folded into `@uifn/patterns` and `@uifn/sf`.
6. No semantic token/theme/Tailwind/recipe package split exists.
7. No full Coss-target component catalog or hook catalog exists.
8. No registry CLI, source install, lockfile, diff, or update workflow exists.
9. No Storybook package, decorators, compatibility panel, or story test gate exists.
10. The current release gate is too narrow for production readiness.

## Verification Commands Run

```bash
find uifn -maxdepth 3 -name package.json | sort
rg -n "export \\*" uifn/core/src uifn/react/src uifn/svelte/src uifn/vue/src
find uifn -type f \\( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.spec.ts' -o -name '*.spec.tsx' \\) | sort
```

The command outputs were used to produce the JSON inventories in this phase.

## Stop Condition Result

Phase 00 is complete. The next phase is PHASE_01: create/reset the target package scaffolds and public metadata.

