# Phase goal

Lock the audited `uifn` release contract, support matrix, and release-gate scaffolding before semantic fixes begin.

# In scope / Out of scope

In scope:

- Canonical GA versus Experimental package status for `@uifn/core`, `@uifn/react`, `@uifn/svelte`, `@uifn/vue`, and `@uifn/files`
- Truthful package manifests, export maps, README install/import examples, and root support-matrix claims
- Release-gate scaffolding for pack hygiene, export-map checks, and future consumer-smoke/manual-evidence enforcement

Out of scope:

- Primitive behavior changes
- React or Svelte family-level bug fixes

# Deliverables

- `uifn/README.md`
- `uifn/.conduct/SPEC.md`
- `uifn/core/README.md`
- `uifn/react/README.md`
- `uifn/svelte/README.md`
- `uifn/vue/README.md`
- `uifn/files/README.md`
- `uifn/core/package.json`
- `uifn/react/package.json`
- `uifn/svelte/package.json`
- `uifn/vue/package.json`
- `uifn/files/package.json`
- `scripts/verify-uifn-release.mjs`

# Requirements covered

- `REL-001`
- `REL-002`
- `REL-003`
- `DOCS-001`
- `FILES-001`
- `COMPAT-001`

# Implementation tasks

- [ ] Freeze the public package matrix to `@uifn/core`, `@uifn/react`, and `@uifn/svelte` as GA, with `@uifn/vue` and `@uifn/files` explicitly documented as Experimental.
- [ ] Remove any remaining root or package-level claims that imply Solid, web-components, or other unsupported adapters are available.
- [ ] Align every package manifest name, export map, `files` allowlist, and README install/import example with the actual published surface.
- [ ] Define the release-gate contract in `scripts/verify-uifn-release.mjs`, including dry-run output, required package checks, and placeholders for consumer smoke and manual evidence validation.
- [ ] Document the compatibility matrix exactly once and reference it consistently from the root README and package READMEs.
- [ ] Record the contract decisions that Phase 08 and Phase 10 must verify instead of re-deciding them later.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions && npm run verify:uifn-release -- --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm pack --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm pack --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm pack --dry-run`
- Manually compare the root/package README install snippets against the package manifest names and exports.

Expected outcomes:

- Dry-run output names the same GA packages that the docs claim are supported.
- Tarball dry runs include only intended release assets.
- No README or spec text claims unsupported adapters or unshipped package identities.

# Stop condition

Report the final public package/status matrix, the exact `verify:uifn-release` contract, and any remaining doc-surface conflicts before starting semantic runtime work.
