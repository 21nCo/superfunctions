# Phase 3: datafn Server Integration Tests

## Goal
End-to-end tests proving that clone, query, mutation, and push operations are namespace-isolated when the datafn server has `authContextProvider` enabled.

## Scope
- `datafn/server/__tests__/namespace-isolation.test.ts` (NEW or extended)

## Requirements Covered
DFN-001, DFN-003, DFN-004, DFN-005, DFN-006, RLN-001, RLN-003, RLN-005

## Depends On
Phase 0, Phase 2

## Tasks

### 3.1 — Test harness setup
- Create a datafn server instance with memory adapter + `authContextProvider`.
- Define two users: `user:alice` and `user:bob`.
- Register a simple schema with a `todos` model.

### 3.2 — Clone isolation test
1. Alice pushes 3 todos.
2. Bob pushes 2 todos.
3. Alice clones → receives exactly 3 todos.
4. Bob clones → receives exactly 2 todos.
5. Neither clone response contains the other user's data.

### 3.3 — Query isolation test
1. Alice queries `todos` → 3 results.
2. Bob queries `todos` → 2 results.
3. Alice queries with filter → only Alice's matching records.

### 3.4 — Mutation isolation test
1. Alice updates one of her todos.
2. Bob's todos are unchanged.
3. Alice deletes one of her todos.
4. Bob's count is unchanged.

### 3.5 — Push isolation test
1. Alice pushes changes from a client changeset.
2. Bob pulls → does NOT receive Alice's new changes.
3. Alice pulls → receives her own changes.

### 3.6 — Cross-namespace access attempt
1. Alice attempts to query with a fabricated WHERE targeting Bob's `__ns` value.
2. The wrapper injects Alice's namespace, so the query still returns only Alice's data (the injected `__ns` overrides any user-supplied `__ns` in where).

## Verification
- All tests pass with `npm test` in datafn/server.
- No flaky behavior (deterministic with memory adapter).

## Estimate
~2 days

## Exit Criteria
- All 5 test scenarios pass.
- Tests are deterministic and run in CI.
