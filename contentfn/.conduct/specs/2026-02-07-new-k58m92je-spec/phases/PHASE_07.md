# PHASE_07: Reference expansion (bounded, cycle-safe)

## Phase goal

Implement bounded reference expansion in CFQL projections with deterministic cycle handling.

## In scope

- Projection `expand` execution:
  - expand a reference field into a projected referenced document
  - support arrays of references when the field contains an array of reference objects
- Enforce `maxExpandDepth` and cycle safety
- Deterministic behavior when expansion is truncated or rejected

## Out of scope

- GraphQL-like recursive querying beyond the bounded expansion feature
- Permission-based field masking (handled by AUTH-001 in PHASE_12)

## Deliverables

- `contentfn/server/src/query/expand.ts`
- Updates to `executeCfql.ts` to apply expansion after base query and projection
- Tests implementing:
  - TV-REF-ENCODE-001
  - TV-REF-EXPAND-001
  - TV-REF-EXPAND-002
  - TV-REF-CYCLE-001

## Requirements covered

- REF-001

## Implementation tasks

1. Implement reference canonical validation on writes (ensure `_type="reference"` + `_ref` string).
2. Implement expansion traversal:
   - track visited doc IDs per expansion tree to detect cycles
   - enforce depth limit
3. Define deterministic truncation behavior:
   - preferred: return `QUERY_TOO_COMPLEX` when expansion exceeds limits (matches TEST_VECTORS)
   - if truncation is chosen instead, update SPEC/REQ/TV accordingly (must remain deterministic)
4. Implement expansion in server query execution and ensure it does not mutate base stored docs.
5. Add tests for:
   - single reference expansion
   - depth exceeded failure
   - A↔B cycle does not loop and yields deterministic result/error

## Verification steps

- Run reference expansion tests.
- Confirm expansion does not cause unbounded DB queries (enforce per-request max ref fetch count if needed).

## Stop condition

- Expansion passes referenced TVs and is deterministic and cycle-safe.

