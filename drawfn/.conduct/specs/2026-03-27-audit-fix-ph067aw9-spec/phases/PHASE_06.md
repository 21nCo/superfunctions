# Phase goal

Finalize the drawfn release gate with aligned docs/examples and a repo-root verification pass.

# In scope / Out of scope

## In scope

- README/example alignment
- repo-root verification commands
- release checklist for core and adapters

## Out of scope

- new product features
- node/Nucleus behavior changes

# Deliverables

- `drawfn/core/README.md`
- `drawfn/drawfn-react/README.md`
- `drawfn/drawfn-svelte/README.md`
- `drawfn/core/example.html`
- any package test/config files required by prior phases
- updated spec-related release notes in `.conduct` only if needed by implementation prompts

# Requirements covered

- `SURFACE-001`
- `QA-001`

# Implementation tasks

- [ ] Ensure README install/import examples use canonical package names.
- [ ] Document the finalized export option surface consistently.
- [ ] Ensure examples do not claim behaviors outside this spec.
- [ ] Verify all package-local scripts exist and are runnable from `repo root`.
- [ ] Run the full repo-root drawfn verification gate.
- [ ] Record any remaining non-scope observations separately without altering this spec’s scope.

# Verification steps

- `npm -w drawfn run lint`
- `npm -w drawfn run test -- --run`
- `npm -w drawfn run build`
- `npm -w @drawfn/react run lint`
- `npm -w @drawfn/react run test -- --run`
- `npm -w @drawfn/react run build`
- `npm -w @drawfn/svelte run lint`
- `npm -w @drawfn/svelte run test -- --run`
- `npm -w @drawfn/svelte run build`
  - Expected: all commands exit `0`.
- `rg -n "@21n/drawfn|Apache-2.0" drawfn/core drawfn/drawfn-react drawfn/drawfn-svelte`
  - Expected: no published-surface matches remain.

# Stop condition

Report the full verification results and any remaining out-of-scope observations before marking the spec executable.

