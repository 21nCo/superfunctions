# PHASE_00 — Contract Type Additions

## Phase Goal

Add `prefix`, `SearchDefaults`, and related type additions to `@searchfn/adapter-contracts`.

## In Scope

- Add `prefix?: boolean` to `SearchParams`
- Add `prefix?: boolean` to `SearchAllParams`
- Add `prefix?: boolean` to `SearchAdapterCapabilities`
- Add `SearchDefaults` interface
- Add `defaults?: SearchDefaults` to `SearchAdapterConfig`
- Export `SearchDefaults` from package

## Out of Scope

- Any runtime/behavioral changes in adapters
- Any changes outside `adapter-contracts`

## Deliverables

- `searchfn/adapter-contracts/src/index.ts` — modified

## Requirements Covered

CTR-001, CTR-002, CTR-003, CTR-004, CTR-005

## Implementation Tasks

1. [ ] Add `prefix?: boolean` to `SearchParams` interface
2. [ ] Add `prefix?: boolean` to `SearchAllParams` interface
3. [ ] Add `prefix?: boolean` to `SearchAdapterCapabilities` interface
4. [ ] Add `SearchDefaults` interface with `fuzzy`, `prefix`, `fieldBoosts`
5. [ ] Add `defaults?: SearchDefaults` to `SearchAdapterConfig` interface
6. [ ] Build the package to verify compilation

## Verification Steps

```bash
cd searchfn/adapter-contracts && npm run build
# Expected: clean build, no errors

cd searchfn/adapter-contracts && npm run typecheck
# Expected: no type errors

# Verify all dependent packages still compile:
cd searchfn/adapter-memory && npm run typecheck
cd searchfn/adapter-elasticsearch && npm run typecheck
cd searchfn/client && npm run typecheck
cd searchfn/server && npm run typecheck
cd searchfn/datafn-provider && npm run typecheck
```

## Stop Condition

All packages compile cleanly with the new types. No existing tests broken.
