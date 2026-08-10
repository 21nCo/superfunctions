# SFN-15 Reaudit Closure: r7p6n4qw

- timestamp: 2026-06-28T12:09:06Z
- audit: `uifn/.conduct/audits/2026-06-28-r7p6n4qw-full-audit.md`
- result: all valid audit findings fixed and release-gated

## Audit Read

The audit was materially valid. It did not claim the whole project was broken; it identified three places where the previous completion claim was too broad for the evidence:

- adapter conformance covered only the original six primitives even though SFN-15 claimed the full primitive inventory.
- release validation did not inspect actual npm pack output.
- Batch B styled component semantics were still too generic for primitive-backed components.

## Fixes

### Full Adapter Primitive Inventory

`@uifn/adapter-kit` now defines and verifies the full 25-primitive inventory:

- accordion
- alert-dialog
- avatar
- checkbox
- collapsible
- combobox
- context-menu
- dialog
- dropdown-menu
- hover-card
- menu-bar
- popover
- progress
- radio-group
- scroll-area
- select
- separator
- slider
- switch
- tabs
- toast
- toggle
- toggle-group
- toolbar
- tooltip

The adapter kit now exposes generic primitive controller creation, part prop lookup, trigger dispatch, primitive inventory metadata, and required-part validation. React, Svelte, Vue, Solid, and Angular now use generic primitive attachment APIs for the full inventory instead of hard-coded six-primitive conformance.

### Pack Output Gate

The release gate now includes `scripts/verify-uifn-pack.mjs`, which runs `npm pack --dry-run --json` for all 16 public `@uifn/*` packages and verifies the real packaged file list. It checks package entrypoints, export targets, README/package metadata, unsafe paths, and banned test/fixture/story/conduct/cache/temp material.

This closes the gap where package metadata could look correct while the published tarball was still wrong.

### Primitive-Backed Styled Semantics

Batch B styled component semantics now derive from core primitive controllers via `@uifn/adapter-kit` for primitive-backed components. Dialog, alert dialog, checkbox, select, tabs, popover, menus, toggle, slider, switch, scroll area, tooltip, and related components now receive controller-backed roles, ARIA, data-state, tags, and part metadata where applicable.

The generic semantic fallback remains only for non-primitive-backed components.

Additional a11y fixes landed while wiring this:

- hidden/form mirror parts are rendered as hidden and decorative where appropriate.
- slider thumbs receive accessible labels.
- owned flat-story relationships use `aria-owns` where browser validation needs it.
- root `aria-expanded` is emitted only for components that support expanded state.
- generated Angular story roots now avoid duplicate landmark names.

## Verification

Adapter verification:

- `node scripts/verify-uifn-adapter.mjs --framework react`
- `node scripts/verify-uifn-adapter.mjs --framework svelte`
- `node scripts/verify-uifn-adapter.mjs --framework vue`
- `node scripts/verify-uifn-adapter.mjs --framework solid`
- `node scripts/verify-uifn-adapter.mjs --framework angular`

Pack and graph verification:

- `node scripts/verify-uifn-package-graph.mjs`
- `node scripts/verify-uifn-pack.mjs`

Component and browser verification:

- `npm --workspace @uifn/components run typecheck`
- `npm --workspace @uifn/components run test`
- `node scripts/verify-uifn-components.mjs`
- `node scripts/verify-uifn-a11y.mjs --scope batch-b`
- `node scripts/verify-uifn-visual.mjs --scope data-rich`

Catalog, registry, and story verification:

- `node scripts/verify-uifn-catalog.mjs`
- `node scripts/verify-uifn-registry.mjs`
- `node scripts/verify-uifn-stories.mjs`

Hook and release verification:

- `npm --workspace @uifn/svelte run test -- src/hooks.behavior.test.ts`
- `node scripts/verify-uifn-hooks.mjs`
- `node scripts/verify-uifn-release.mjs`

Final release result:

- total checks: 84
- passed: 84
- failed: 0
- planned: 0
- blocking failures: 0

## Residual Notes

No valid finding from `2026-06-28-r7p6n4qw-full-audit.md` remains open.

`npm install` still reports pre-existing dependency audit advisories. Those were not introduced by this closure and were not part of the reaudit findings.
