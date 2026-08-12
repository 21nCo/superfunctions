# PHASE_01 — Three-framework package graph and removal cleanup

## Objective

Make React, Svelte, and Solid the only stable frameworks, delete Vue/Angular, and isolate experimental products before architecture replacement begins.

## Entry

- Phase 00 governance/evidence contracts pass.
- Vue/Angular removal impact is inventoried from workspace, lockfile, generated outputs, docs, workbenches, tests, and scripts.

## Requirements

- `SCOPE-001`, `CLEAN-001`, `EXP-001`.

## Work

1. Add the authoritative package DAG and dependency verifier for the stable packages in `SPEC.md`, private workspaces, and experimental packages.
2. Delete `uifn/vue`, `uifn/angular`, their workbenches, dependencies, peers, workspace entries, exports, catalog matrices, registry choices, Storybook/docs routes, scripts, tests, evidence expectations, and release rows.
3. Remove all all-framework assumptions from root and uifn tooling; retain React/Svelte/Solid equality.
4. Move `uifn/patterns` and `uifn/sf` to separately versioned experimental release/gate lanes and prove stable gates run without them installed.
5. Create migration documentation for removed frameworks and update support statements without compatibility shims.
6. Reserve/create `uifn/dom` as the package path for `@uifn/dom`, but do not implement DOM behavior yet.

## Required evidence

- `TV-SCOPE-001-P/N`, `TV-CLEAN-001-P/N`, and `TV-EXP-001-P/N`.
- Clean lockfile install, workspace graph, all stable packs, and three minimal consumer resolutions.
- Repository scan uses semantic allowlists for historical `.conduct` records; history may mention removed frameworks, current product surfaces may not.

## Exit gate

The stable DAG is acyclic/enforced, Vue/Angular have no current product surface, experimental failures cannot affect stable release status, and migration impact is documented.

## Do not

- Do not retain deprecated proxy packages or runtime warnings as shims.
- Do not delete immutable historical reports/specs that mention Vue/Angular.
- Do not implement primitive behavior.

## Handoff

Phase report lists every deleted/changed current surface and supplies the exact DAG/catalog targets Phase 02 must generate.
