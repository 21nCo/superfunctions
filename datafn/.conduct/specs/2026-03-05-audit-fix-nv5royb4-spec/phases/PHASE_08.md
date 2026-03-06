# PHASE 08

## Phase goal
Complete route modularity by splitting query route into focused files with unchanged behavior.

## In scope / Out of scope
In scope:
- Query route refactor split.

Out of scope:
- New protocol or semantic changes.

## Deliverables
- `datafn/server/src/routes/query.ts`
- `datafn/server/src/routes/query/validate.ts`
- `datafn/server/src/routes/query/batch-executor.ts`
- `datafn/server/src/routes/query/execute.ts`

## Requirements covered
- FIX-SRV-005

## Implementation tasks
- [ ] Extract validation logic module.
- [ ] Extract batch orchestration/concurrency module.
- [ ] Extract execution bridge module.
- [ ] Keep route entry as thin composition layer.

## Verification steps
- `wc -l datafn/server/src/routes/query.ts`
- `cd datafn/server && npm test -- query*.test.ts`
- Expected: thin entry file and no behavior regressions.

## Stop condition
Module split is complete and golden behavior checks are unchanged.
