# Provenance, Source Install, And Versioning Closure

- timestamp: 2026-06-28T08:11:12Z
- requirements: ARCH-002, REG-002, VER-001, TEST-001 evidence update

## Previous State

Clean-room provenance was still mostly metadata assertion. Source install had framework-native files and lock metadata, but drift detection did not prove every required status from the registry subspec. Registry lock entries also used a hard-coded artifact version, so update availability could not be computed from the manifest source of truth. The breaking-change row still needed source-level evidence that legacy public-surface scaffolding was gone.

## Final State

`verify-uifn-provenance` now scans shipped source, docs, examples, registry, and Storybook surfaces; validates package metadata and catalog provenance; and rejects external source/package/prose/private-product/legacy markers.

All public registry manifests now carry semver artifact versions. Source install writes those versions into `.uifn/registry.lock`, and the CLI, generated docs, and Storybook compatibility panel expose the same version.

`uifn diff` now reports all required drift states:

- unchanged
- locally modified
- registry update available
- checksum mismatch
- unsupported local-edit conflict
- missing file

`uifn update` updates clean version drift and refuses local conflicts. Root docs document pre-GA breaking changes and post-GA semantic versioning, and the registry README documents manifest versions plus drift states.

## Verification

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/storybook run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/storybook run test -- src/__tests__/storybook.test.ts`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-catalog.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-registry.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-docs.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-provenance.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-secrets.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`
- `PATH=<node22-bin>:$PATH git diff --check`

## Residual Risk

ARCH-002, REG-002, and VER-001 are complete. TEST-001 remains in progress until the still-open package architecture, core controller/anatomy, component catalog, styled contract, and data-rich behavior rows are proven complete.
