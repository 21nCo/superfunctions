# Phase goal

Normalize the public `uifn` package contract, support matrix, and release scaffolding before changing runtime behavior.

# In scope / Out of scope

In scope:

- Canonical package naming decision and export-path strategy
- Support-matrix definition for core, React, Svelte, Vue, files, and unsupported adapters
- Pack hygiene scaffolding, release-gate script entry point, README/license/changelog plan

Out of scope:

- Rewriting primitive behavior
- React or Svelte component-level bug fixes

# Deliverables

- `uifn/core/package.json`
- `uifn/react/package.json`
- `uifn/svelte/package.json`
- `uifn/vue/package.json`
- `uifn/files/package.json`
- `uifn/.conduct/SPEC.md`
- `uifn/README.md` (new, if absent)
- `uifn/core/README.md`
- `uifn/react/README.md`
- `uifn/svelte/README.md`
- `uifn/vue/README.md`
- `uifn/files/README.md` (new, if `@uifn/files` remains in scope)
- `uifn/core/CHANGELOG.md` (new)
- `uifn/react/CHANGELOG.md` (new)
- `uifn/svelte/CHANGELOG.md` (new)
- `uifn/vue/CHANGELOG.md` (new if package remains public)
- `uifn/files/CHANGELOG.md` (new if package remains public)
- root or package-local release verification script entry point (for example `package.json` scripts or `scripts/verify-uifn-release.mjs`)

# Requirements covered

- `REL-001`
- `REL-002`
- `REL-003`
- `DOCS-001`
- `FILES-001`
- `COMPAT-001`

# Implementation tasks

- [ ] Choose and implement the canonical core package identity (`@uifn/core`) and decide whether a deprecated `uifn` alias exists.
- [ ] Rewrite package manifests so package names, exports, peer ranges, and README install commands align.
- [ ] Remove unsupported Solid/web-components GA claims from docs unless those adapters are implemented immediately.
- [ ] Decide whether `@uifn/vue` is GA or experimental and document it truthfully.
- [ ] Decide whether `@uifn/files` remains inside `uifn`; if yes, add README/changelog scope, if no, remove `uifn`-surface claims.
- [ ] Add or wire a single documented release-gate command entry point that later phases can fill in.
- [ ] Establish tarball allowlist/denylist rules for all public packages.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm pack --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm pack --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm pack --dry-run`
- Inspect README install examples and confirm they match package manifest names exactly.
- Run the new release-gate command in dry mode if implemented and confirm it enumerates `core`, `react`, and `svelte`.

Expected outcomes:

- No public doc claims unsupported adapters as supported.
- Package manifests and README install commands align.
- Tarball dry runs reflect the intended include/exclude rules.

# Stop condition

Report the final canonical package names, the GA/experimental matrix, and the exact release-gate entry point before starting runtime changes.
