# PHASE 01

## Phase goal
Remove oauth-testing duplication by re-exporting memory stores from oauth-storage.

## In scope / Out of scope

- **In scope:** oauth-testing source and tests.
- **Out of scope:** oauth-flow package creation.

## Deliverables

- `packages/oauth-testing/src/index.ts` rewritten to import/re-export shared memory adapters.
- `packages/oauth-testing/src/__tests__/exports.test.ts` updated if needed for behavior parity.

## Requirements covered

- OAUTH-001

## Implementation tasks

1. Replace local in-memory store class definitions with re-exports from `@superfunctions/oauth-storage`.
2. Keep existing export names (`InMemoryOAuthStateStore`, `InMemoryTokenVault`) for compatibility.
3. Ensure createMockOAuthProviderDescriptor helper remains in oauth-testing.
4. Update tests to assert shared adapter semantics.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/oauth-testing run typecheck
npm -w @superfunctions/oauth-testing run test
```
Expected: tests and typecheck pass.

2. Run:
```bash
rg -n "class InMemoryOAuthStateStore|class InMemoryTokenVault" packages/oauth-testing/src
```
Expected: no class definitions found.

## Stop condition
oauth-testing contains zero duplicated memory store implementations and package tests pass.
