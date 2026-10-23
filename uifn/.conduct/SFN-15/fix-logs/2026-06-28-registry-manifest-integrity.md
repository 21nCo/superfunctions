# Registry Manifest Integrity

- timestamp: 2026-06-28T05:47:03Z
- requirements: REG-001, TEST-001, SEC-001 partial
- changed files:
  - `uifn/registry/src/schema.ts`
  - `uifn/registry/src/validate-catalog.ts`
  - `scripts/verify-uifn-catalog.mjs`
  - `scripts/verify-uifn-registry.mjs`
  - `uifn/registry/catalog/components/*.json`
  - `uifn/registry/catalog/hooks/*.json`
  - `uifn/registry/catalog/patterns/*.json`
  - `uifn/registry/catalog/sf/*.json`

## Previous State

Registry manifests had implemented refs pointing to real files, but the refs did not prove integrity. A changed story, fixture, or test file could still pass registry validation because validators checked only status and file existence.

## Final State

Production registry validation now requires:

- each story, fixture, and test ref to carry a 64-character SHA-256 checksum;
- the checksum to match the current referenced file contents;
- each ref to carry clean-room provenance with `sourcePolicy: "clean-room"` and `generatedBy`;
- registry metadata to carry clean-room provenance;
- component `implementationManifestFile` refs to carry matching SHA-256 checksums.

All 75 public catalog manifests were updated from the current repo files:

- components: 553 story/fixture/test refs, 553 checksums, 553 provenance entries, 45 implementation manifest checksums;
- hooks: 12 refs, 12 checksums, 12 provenance entries;
- patterns: 70 refs, 70 checksums, 70 provenance entries;
- Superfunction-backed patterns: 42 refs, 42 checksums, 42 provenance entries.

## Verification

- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-catalog.mjs`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-registry.mjs`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run typecheck`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run test`
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run build`
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`

## Residual Risk

REG-001 is complete. This does not complete REG-002 source-install parity, live Storybook browser tests, pixel snapshots, axe checks, or the broader SEC/DOCS rows.
