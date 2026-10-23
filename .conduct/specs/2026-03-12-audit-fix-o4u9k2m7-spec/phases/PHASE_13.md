# PHASE 13

## Phase goal
Align PlugFn platform contracts with shared DB/HTTP patterns and deterministic connection selection.

## In scope / Out of scope

- **In scope:** plugfn type contracts, deterministic selection logic, compatibility shims.
- **Out of scope:** provider feature expansion.

## Deliverables

- PlugFn config/type updates using `@superfunctions/db` Adapter types.
- Deterministic connection selection tie-breaker update.
- Legacy path compatibility shims with deprecation notices.

## Requirements covered

- PLAT-001
- PLAT-002
- PLAT-003
- PLAT-004

## Implementation tasks

1. Replace local Adapter interface in plugfn config types with imported db adapter types.
2. Update connection selection comparator to include stable ID tie-breaker.
3. Add deprecation shims for moved OAuth flow paths.
4. Update plugfn docs with adapter usage via `@superfunctions/http-*` and `@superfunctions/db`.

## Verification steps

1. Run:
```bash
npm -w plugfn run type-check
npm -w plugfn run test -- connection-selection.test.ts router-auth.test.ts
```
Expected: typecheck and deterministic selection tests pass.

2. Run:
```bash
rg -n "export interface Adapter" plugfn/typescript/src/types/config.ts
```
Expected: no standalone adapter interface remains.

## Stop condition
PlugFn contracts align with shared platform abstractions and deterministic behavior is validated.
