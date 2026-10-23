# Phase 13: Breaking Change Detection

## Phase Goal
Implement `diffOpenAPI()` with comprehensive breaking/non-breaking change classification.

## In Scope
- `diffOpenAPI(before, after)` — full diff engine
- Breaking change rules: endpoint removal, required param addition, type narrowing, response field removal, security changes
- Non-breaking change rules: endpoint addition, optional param addition, response field addition, description changes
- `DiffResult` with summary counts
- Deterministic results

## Out of Scope
- CLI diff command (next phase)
- CI/CD workflow

## Deliverables
- `apifn/core/src/diff/diff.ts`
- `apifn/core/src/diff/rules.ts`
- `apifn/core/src/diff/format.ts`
- `apifn/core/__tests__/diff.test.ts`

## Requirements Covered
- DIFF-001, DIFF-002, DIFF-003, DIFF-004, DIFF-005, DIFF-006, DIFF-007, DIFF-008, DIFF-009

## Implementation Tasks
1. [ ] Implement path-level diff: detect added/removed paths
2. [ ] Implement operation-level diff: detect added/removed methods on existing paths
3. [ ] Implement parameter diff: detect added/removed/modified parameters, classify required additions as breaking
4. [ ] Implement request body diff: detect schema changes, classify type narrowing as breaking
5. [ ] Implement response diff: detect removed fields as breaking, added fields as non-breaking
6. [ ] Implement security diff: added requirements = breaking, removed = non-breaking
7. [ ] Implement `DiffResult` construction with summary counts
8. [ ] Implement deterministic ordering of diff entries
9. [ ] Implement human-readable and JSON formatters
10. [ ] Write tests for TV-DIFF-001 through TV-DIFF-009
11. [ ] Export from core index

## Verification Steps
1. `npm run test` → all diff tests pass
2. TV-DIFF-001: Removed endpoint → breaking
3. TV-DIFF-002: Required param added → breaking
4. TV-DIFF-006: New endpoint → non-breaking
5. TV-DIFF-008: Same inputs → identical results

## Stop Condition
All diff rules tested and passing. Report counts of tested breaking/non-breaking scenarios.
