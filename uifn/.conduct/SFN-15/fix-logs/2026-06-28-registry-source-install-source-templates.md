# Registry Source-Install Source Templates

- timestamp: 2026-06-28T05:13:43Z
- requirements: REG-002, TEST-001, DOCS-001
- scope: `@uifn/registry`

## Previous State

`uifn add` wrote placeholder install artifacts. Component files imported package APIs or exported `uifnRegistryEntry`, stories used `uifn-generated`, fixtures were single status objects, and tests only checked that the registry lock key contained the slug. The registry README also documented stale `.uifn/lock.json` output.

## Final State

Source installation now writes deterministic clean-room source templates:

- React/Svelte/Vue/Solid/Angular component files expose framework-native component source with `uifn-*` classes, root data attributes, state attributes, a11y attributes, and loading/label parts.
- Hook installs expose browser-safe helpers for media query and clipboard flows.
- Pattern and Superfunction-pattern installs expose controlled model helpers without global clients or secrets.
- Fixtures include default props plus state, a11y, and visual metadata.
- Stories use `autodocs` and registry metadata instead of generated-placeholder tags.
- Tests exercise the installed public surface instead of checking only a slug string.
- Manifest files include the registry lock key and clean-room metadata.
- README now documents `.uifn/registry.lock`, `.uifn/selected-components.json`, checksums, and conflict-safe updates.

## Verification

Passed:

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run build`

Expected current failures:

- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-registry.mjs`
- result: fails on `UIFN_REGISTRY_MANIFEST_NOT_RELEASED` for `components/accordion.json`.
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-catalog.mjs`
- result: fails with 1395 component catalog placeholder/missing-file failures.

Regression scan:

- `rg -n "uifn-generated|uifnRegistryEntry|generated source install artifact|\\.uifn/lock\\.json" uifn/registry/src uifn/registry/README.md uifn/registry/docs`
- result: old markers appear only inside tests that reject them.

## Remaining Work

This removes the source-install placeholder writer. It does not complete REG-001 or the full REG-002 requirement. The catalog still needs real referenced component stories, fixtures, render/a11y/interaction/visual tests, and production-safe manifest status updates backed by executable evidence.
