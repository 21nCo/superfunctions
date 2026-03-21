# Phase goal

Harmonize docs, support matrix, Vue/files boundary, and remaining public-surface truthfulness.

# In scope / Out of scope

In scope:

- Root and package README alignment
- License text consistency
- Vue README/API truthfulness
- Files package scope decision and docs
- Changelog/release-notes surfaces

Out of scope:

- Rebuilding already-green core or adapter behavior unless docs reveal missing public features

# Deliverables

- `uifn/SPEC.md`
- `uifn/README.md`
- `uifn/core/README.md`
- `uifn/react/README.md`
- `uifn/svelte/README.md`
- `uifn/vue/README.md`
- `uifn/files/README.md`
- `uifn/core/CHANGELOG.md`
- `uifn/react/CHANGELOG.md`
- `uifn/svelte/CHANGELOG.md`
- `uifn/vue/CHANGELOG.md`
- `uifn/files/CHANGELOG.md`

# Requirements covered

- `DOCS-001`
- `FILES-001`
- `SIMPLE-001`
- `REL-001`
- `REL-002`

# Implementation tasks

- [ ] Rewrite docs so install commands, package names, and component lists match reality.
- [ ] Remove false adapter claims and document GA versus experimental packages.
- [ ] Fix Vue README/API drift or explicitly label Vue experimental with truthful examples.
- [ ] Decide whether `@uifn/files` remains in `uifn`; update docs and changelog accordingly.
- [ ] Align license text across manifests and READMEs.

# Verification steps

- Manually diff README install commands against package manifests.
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm pack --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm pack --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm pack --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/files && npm pack --dry-run` if `@uifn/files` remains public

Expected outcomes:

- Docs and manifests are mutually consistent.
- Experimental or unsupported packages are labeled truthfully.
- License text no longer conflicts.

# Stop condition

Report the final GA/experimental matrix and the final disposition of `@uifn/files` before closing QA and release gating.
