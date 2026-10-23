# Fix Log: Registry And Release Honesty

- timestamp: 2026-06-28T03:27:54Z
- requirements: REG-001, REG-002, TEST-001, VER-001
- trigger: Audits found registry/catalog/release gates accepted planned manifests, placeholder evidence, wrong lock filenames, and overwrite-prone updates.
- previous state: `verify:uifn-release --dry-run` reported `ok: true` with no executed checks; registry validators accepted `planned` and `placeholder`; source install wrote `.uifn/lock.json`; `uifn update` overwrote local modifications.
- final state: production validation rejects placeholders and missing referenced files; release dry-run is nonzero without execution evidence; source install writes `.uifn/registry.lock` and `.uifn/selected-components.json`; drift detection uses SFN-15 status names and update refuses conflicts.
- verification:
  - `npm --workspace @uifn/registry run typecheck`
  - `npm --workspace @uifn/registry run test`
  - `npm --workspace @uifn/registry run build`
  - `node scripts/verify-uifn-catalog.mjs` fails on placeholder/missing-file evidence.
  - `node scripts/verify-uifn-registry.mjs` fails on `UIFN_REGISTRY_MANIFEST_NOT_RELEASED`.
  - `node scripts/verify-uifn-release.mjs --dry-run` fails with 80 planned checks counted as blocking failures.
- honest limitation: this makes the gates honest; it does not complete the missing component, story, fixture, visual, a11y, adapter, or Superfunction-backed implementations.
