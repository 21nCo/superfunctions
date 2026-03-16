# Phase 01

## Phase goal

Create workspace scaffolds for contracts and all leaf adapter packages.

## In scope / Out of scope

- **In scope**: package directories, package.json, tsconfig/tsup/vitest scaffolding, initial entrypoints.
- **Out of scope**: moving full implementation logic.

## Deliverables

- `searchfn/adapter-contracts/*`
- `searchfn/adapter-memory/*`
- `searchfn/adapter-indexeddb/*`
- `searchfn/adapter-postgres/*`
- `searchfn/adapter-elasticsearch/*`
- `searchfn/adapter-opensearch/*`
- `searchfn/adapter-meilisearch/*`

## Requirements covered

- PKG-001
- PKG-002

## Implementation tasks

1. Create each package with metadata (`name`, exports, scripts).
2. Configure TypeScript + build pipeline for each package.
3. Wire inter-package local dependencies (`file:../adapter-contracts` etc.) where needed.
4. Ensure root workspace pattern (`searchfn/*`) discovers packages.

## Verification steps

```bash
npm run build --workspace @searchfn/adapter-contracts
npm run build --workspace @searchfn/adapter-memory
npm run build --workspace @searchfn/adapter-indexeddb
npm run build --workspace @searchfn/adapter-postgres
npm run build --workspace @searchfn/adapter-elasticsearch
npm run build --workspace @searchfn/adapter-opensearch
npm run build --workspace @searchfn/adapter-meilisearch
```

Expected outcomes:

- All package builds succeed from scaffold state.

## Stop condition

All new packages build with no dependency on legacy aggregate package.
