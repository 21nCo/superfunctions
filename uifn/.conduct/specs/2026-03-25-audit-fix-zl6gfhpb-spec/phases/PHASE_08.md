# Phase goal

Make the published docs, support matrix, helper claims, and package boundaries fully truthful to the verified shipped API.

# In scope / Out of scope

In scope:

- Root and package README/spec cleanup
- Removal of overclaimed component parts or unsupported behaviors from public docs
- Final helper-contract proof for `AvatarFallback`, `VirtualizedList`, and `@uifn/files`/`@uifn/vue` boundaries

Out of scope:

- New runtime behavior except where documentation changes expose a required export correction
- Final manual accessibility and consumer-smoke evidence execution

# Deliverables

- `uifn/README.md`
- `uifn/SPEC.md`
- `uifn/core/README.md`
- `uifn/react/README.md`
- `uifn/svelte/README.md`
- `uifn/vue/README.md`
- `uifn/files/README.md`
- `uifn/react/src/avatar.tsx`
- `uifn/react/src/virtualized-list.tsx`
- `uifn/react/src/ga-helper-coverage.test.tsx`
- `uifn/svelte/src/AvatarFallback.svelte`
- `uifn/svelte/src/VirtualizedList.svelte`
- `uifn/svelte/src/ga-coverage.test.ts`

# Requirements covered

- `REL-001`
- `DOCS-001`
- `FILES-001`
- `SIMPLE-001`
- `COMPAT-001`

# Implementation tasks

- [ ] Remove or clearly mark every root-spec surface that the React and Svelte adapters do not actually export, including combobox extras, context-menu extras, and tooltip extras found by the audit.
- [ ] Align root/package docs on GA versus Experimental status and the supported environment matrix.
- [ ] Ensure helper docs and tests agree on `AvatarFallback` delay behavior and `VirtualizedList` default `overscan=3`.
- [ ] Clarify the scope and status of `@uifn/files` and `@uifn/vue` so they are never mistaken for GA React/Svelte primitives.
- [ ] Verify all install/import examples use the actual package names and supported subpaths only.
- [ ] Remove any lingering language that treats passing `verify:uifn-release` alone as proof of production readiness.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions && npm run verify:uifn-release -- --dry-run`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/react && npm run test -- --run src/ga-helper-coverage.test.tsx`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/svelte && npm run test -- --run src/ga-coverage.test.ts`
- Manual docs review: compare `uifn/SPEC.md`, root README, and adapter `src/index.*` exports line by line.

Expected outcomes:

- Public docs only claim shipped surfaces and verified support levels.
- Helper behavior and scale claims are backed by adapter tests.
- `@uifn/files` and `@uifn/vue` boundaries are explicit and non-misleading.

# Stop condition

Report the final public API/support-matrix language and list any remaining evidence-only items before Phase 09 starts.
