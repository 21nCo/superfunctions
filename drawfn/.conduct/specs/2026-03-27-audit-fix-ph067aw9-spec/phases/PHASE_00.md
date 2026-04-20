# Phase goal

Establish the canonical drawfn package surface, fix manifest/doc inconsistencies, and freeze node/Nucleus scope boundaries before touching runtime behavior.

# In scope / Out of scope

## In scope

- canonical package names
- manifest script/exports alignment
- README/example/license/package-surface corrections
- explicit no-Nucleus-change guardrails in docs/spec artifacts

## Out of scope

- scene validation logic
- gesture/history/runtime behavior changes
- node/Nucleus behavior changes

# Deliverables

- `drawfn/core/package.json`
- `drawfn/drawfn-react/package.json`
- `drawfn/drawfn-svelte/package.json`
- `drawfn/core/README.md`
- `drawfn/drawfn-react/README.md`
- `drawfn/drawfn-svelte/README.md`
- `drawfn/core/example.html`
- `drawfn/drawfn-react/src/index.ts`
- `drawfn/drawfn-svelte/src/index.ts`

# Requirements covered

- `BOUNDARY-001`
- `SURFACE-001`
- `SURFACE-002`

# Implementation tasks

- [ ] Confirm canonical package identifiers and license metadata in all three manifests.
- [ ] Add missing `test` scripts for React and Svelte packages.
- [ ] Update drawfn README install/import examples to use the canonical package identifiers.
- [ ] Update adapter README install/import examples to use the canonical package identifiers.
- [ ] Reconcile documented export options with the intended public export surface.
- [ ] Ensure adapter barrel files re-export from the canonical core package identifier.
- [ ] Preserve node-related documentation wording unless package-name/license corrections require mechanical edits.

# Verification steps

- `npm -w drawfn run lint`
  - Expected: manifest/docs changes do not break core typecheck.
- `npm -w @drawfn/react run lint`
  - Expected: canonical import changes typecheck.
- `npm -w @drawfn/svelte run lint`
  - Expected: canonical import changes typecheck.
- `rg -n "@21n/drawfn|Apache-2.0" drawfn/core drawfn/drawfn-react drawfn/drawfn-svelte`
  - Expected: no matches in package docs/manifests that are part of the published surface.

# Stop condition

Report the final canonical package identifiers, license value, and the exact package scripts added before starting Phase 01.

