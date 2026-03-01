# PHASE 10: Server + Execution MEDIUM

## Phase goal
Fix all 22 execution-layer MEDIUM issues and 16 server-layer MEDIUM issues.

## In scope
- EXE-001 through EXE-022 (all execution MEDIUM)
- SRV-001 through SRV-016 (all server MEDIUM)

## Out of scope
- Client/core MEDIUM (Phase 11)
- LOW issues (Phase 12)

## Deliverables
- `datafn/server/src/execution/db-store.ts` — Deduplicate traverse*, lazy loading, join row filter, forQuery fix
- `datafn/server/src/execution/memory-store.ts` — setJoinRow Map, sort cache
- `datafn/server/src/execution/transact.ts` — Error context, query caching
- `datafn/server/src/execution/errors.ts` — Error code matching (not string includes)
- `datafn/server/src/execution/idempotency.ts` — CAS lock for concurrent race
- `datafn/server/src/execution/idempotency-db.ts` — Throw on DB errors
- `datafn/server/src/execution/mutation/execute.ts` — UUID IDs, error preservation, delete existence check
- `datafn/server/src/execution/mutation/guard-store.ts` — Cross-resource relations
- `datafn/server/src/execution/query/aggregate.ts` — Schema cache for resolveValue
- `datafn/server/src/execution/query/filters.ts` — findRelation ambiguity fix
- `datafn/server/src/execution/query/select.ts` — FK omit cache, one-many optimization
- `datafn/server/src/execution/query/pushdown.ts` — Cursor limit fix
- `datafn/server/src/execution/query/search.ts` — IN clause cap
- `datafn/server/src/execution/sync/change-tracking.ts` — Batch insert, getCurrentServerSeq error
- `datafn/server/src/execution/sync/push.ts` — Transaction wrapping
- `datafn/server/src/execution/sync/pull.ts` — Parallel per-resource fetch
- `datafn/server/src/routes/query.ts` — Split or reduce size, timer accuracy, batch limit
- `datafn/server/src/routes/rest.ts` — (path sanitization done in Phase 05)
- `datafn/server/src/routes/seed.ts` — Error propagation
- `datafn/server/src/routes/transact.ts` — Remove duplicate validation
- `datafn/server/src/routes/status.ts` — Remove exact time
- `datafn/server/src/http/json.ts` — Body caching
- `datafn/server/src/middleware/rate-limit.ts` — Retry-After header, unref timer
- `datafn/server/src/logging.ts` — Extended redaction
- `datafn/server/src/server.ts` — extractNamespace safety, $or fix
- `datafn/core/src/filters.ts` — $or rejection or implementation

## Requirements covered
EXE-001 through EXE-022, SRV-001 through SRV-016

## Implementation tasks
1. **EXE-001**: Extract shared `traverseFilterFields(filter)` function; use in both `traverseFilter` and `traverseHaving`
2. **EXE-002**: Replace `setJoinRow` linear scan with `Map<compositeKey, JoinRow>` index
3. **EXE-003**: Add `{ stepIndex, operation, resource }` to transaction step error log calls
4. **EXE-004**: Add `Map<string, Records>` cache within transaction scope; cache per-resource query results
5. **EXE-005**: Replace `error.message.includes("...")` with `error.code === "..."` where possible; fallback to message matching with documented patterns
6. **EXE-006**: Use `Map.has()` + early return (or simple locking) in `MemoryIdempotencyStore.set()` to prevent double execution
7. **EXE-007**: In `DbIdempotencyStore.get()`, propagate DB errors instead of returning null
8. **EXE-008**: In delete mutations, check record existence before recording change; if not found, skip change record (don't error)
9. **EXE-009**: Replace `Date.now() + Math.random()` with `crypto.randomUUID()` for anonymous mutation IDs
10. **EXE-010**: In mutation catch blocks, wrap original error: `new DfqlError(code, message, { cause: originalError })`
11. **EXE-011**: Fix `GuardDataStore` to follow relation paths and load cross-resource records
12. **EXE-012**: Fix `findRelation` third matching condition — add specificity check to disambiguate
13. **EXE-013**: Cache schema lookup result at query init, pass to `resolveValue` instead of per-record lookup
14. **EXE-014**: Compute FK omit set once per query execution, pass to per-record select logic
15. **EXE-015**: Replace per-record full table scan in one-many with batched `findMany({ where: { fk: { $in: sourceIds } } })`
16. **EXE-016**: Pass `limit` from cursor pagination to DB query via pushdown
17. **EXE-017**: Cap `search.ts` IN clause to 1000 IDs; if more, split into multiple queries
18. **EXE-018**: Collect change entries in array, batch insert via `db.insertMany` on `__datafn_changes`
19. **EXE-019**: In `getCurrentServerSeq`, throw on DB error instead of returning 0
20. **EXE-020**: Wrap push mutations in DB transaction (if adapter supports it) for atomic semantics
21. **EXE-021**: Use `Promise.all` for per-resource change fetching in pull
22. **EXE-022**: Fix `forQuery` to throw error instead of falling back to full table scan when relation path not found
23. **SRV-001**: Pass parsed params directly to REST handlers instead of creating synthetic Request
24. **SRV-002**: Extend `redactSensitiveFields` with `["password", "token", "secret", "authorization", "cookie"]`
25. **SRV-003**: Add `maxBatchQueries: 20` limit; chunk `Promise.all` batches
26. **SRV-004**: Remove record data from mutation handler logs; log only metadata
27. **SRV-005**: (Optional) Split query.ts into validation, conversion, execution files
28. **SRV-006**: Measure per-query timing within batch, not just batch-level
29. **SRV-007**: Cache body in context after first read; return cached on subsequent calls
30. **SRV-008**: Remove or round server time in status endpoint
31. **SRV-009**: Add `Retry-After` header to 429 responses based on rate limit window
32. **SRV-010**: Return error on auth failure in `extractNamespace`; don't fall back to `"datafn"`
33. **SRV-011**: Add `.unref()` to rate limiter sweep timer
34. **SRV-012**: Remove duplicate step limit check (keep one)
35. **SRV-013**: Seed handler: propagate persistence errors as 500
36. **SRV-014**: Cache sorted keys in MemoryStore, invalidate on write
37. **SRV-015**: In `core/src/filters.ts`, reject `$or` with `DFQL_INVALID` if not implemented, or implement `$or` evaluation
38. **SRV-016**: (Done with SEC-011 in Phase 05)

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- `cd datafn/core && bun test` — all tests pass
- Spot-check key fixes:
  - $or filter → explicit error (not silent drop)
  - Transaction step errors include context
  - Pull fetches per-resource in parallel
  - Seed persistence failure → 500 error
  - 429 response has Retry-After header

## Stop condition
All MEDIUM server and execution issues addressed. Report results with list of changes per issue.
