# Component Descriptor-Only Gate

- timestamp: 2026-06-28T04:01:28Z
- requirements: COMP-001, COMP-002, COMP-003, TEST-001
- reference audits:
  - `uifn/.conduct/audits/2026-06-28-k8p4s2nq-full-audit.md`
  - `uifn/.conduct/audits/2026-06-28-m3v7q9xk-full-audit.md`

## Previous State

`@uifn/components` could pass package tests even though the framework exports were descriptor factories. Batch A and Batch B tests asserted metadata and function exports, data-rich tests exercised controllers only, and implementation manifests used `implemented-contract` rather than proving renderable component implementations.

## Implemented Change

- Added `scripts/verify-uifn-components.mjs`.
- The verifier fails when:
  - shared component files expose descriptor factories,
  - framework entries use descriptor factories instead of renderable framework-native exports,
  - tests validate metadata/controllers without render harnesses,
  - component implementation manifests are not marked `implemented`,
  - framework entry metadata points at missing files.
- Added the component verifier to `scripts/verify-uifn-release.mjs` as a blocking `interaction` check.

## Verification

- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-components.mjs`
  - Expected failure: 71 component-layer failures.
- `export PATH=<node22-bin>:$PATH; node scripts/verify-uifn-release.mjs --dry-run ><tmp>/uifn-release-dry.json; rc=$?; node -e "...";`
  - Expected failure: exit code 1, release dry-run includes a planned blocking `components` check.

## Residual Risk

This makes the component failure executable and honest. It does not implement the 45 renderable components, source-install files, stories, or render-level behavior tests.
