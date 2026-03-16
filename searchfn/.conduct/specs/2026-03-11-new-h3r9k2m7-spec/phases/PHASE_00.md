# Phase 00

## Phase goal

Finalize the canonical migration map from legacy `@searchfn/adapters` exports/imports to new package boundaries.

## In scope / Out of scope

- **In scope**: export inventory, consumer inventory, package naming lock.
- **Out of scope**: code movement, dependency rewiring, tests.

## Deliverables

- Export mapping document in spec folder.
- Consumer import/dependency inventory snapshot.

## Requirements covered

- PKG-001
- MIG-001
- MIG-002

## Implementation tasks

1. Enumerate all exports from `searchfn/adapters/src/index.ts`.
2. Map each export to target package.
3. Enumerate all monorepo imports/dependencies for `@searchfn/adapters`.
4. Confirm package names and workspace placement under `searchfn/*`.

## Verification steps

```bash
rg -n 'export ' searchfn/adapters/src/index.ts
rg -n '@searchfn/adapters' --glob '**/*.ts' --glob '**/package.json'
```

Expected outcomes:

- Complete inventory generated.
- No unresolved mapping ambiguities.

## Stop condition

A reviewed migration table exists and is referenced by subsequent phases.
