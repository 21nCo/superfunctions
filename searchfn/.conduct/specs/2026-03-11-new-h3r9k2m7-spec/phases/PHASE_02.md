# Phase 02

## Phase goal

Move concrete adapter implementations/tests to their leaf packages and migrate to contracts imports.

## In scope / Out of scope

- **In scope**: source file relocation, local internal helpers, test relocation, script updates.
- **Out of scope**: consumer package migration.

## Deliverables

- Fully functional leaf adapter package implementations.
- Package-local tests passing per adapter.

## Requirements covered

- PKG-002
- API-001
- TEST-001

## Implementation tasks

1. Move `types.ts` and shared errors to `adapter-contracts`.
2. Update each adapter source import to consume contracts package.
3. Relocate integration/conformance tests to corresponding packages.
4. Update docker-compose/scripts references as needed per package.

## Verification steps

```bash
npm test --workspace @searchfn/adapter-memory
npm test --workspace @searchfn/adapter-indexeddb
npm test --workspace @searchfn/adapter-postgres
npm test --workspace @searchfn/adapter-elasticsearch
npm test --workspace @searchfn/adapter-opensearch
npm test --workspace @searchfn/adapter-meilisearch
```

Expected outcomes:

- Adapter-specific tests pass and do not import legacy package.

## Stop condition

All adapter implementations and tests are package-local and green.
