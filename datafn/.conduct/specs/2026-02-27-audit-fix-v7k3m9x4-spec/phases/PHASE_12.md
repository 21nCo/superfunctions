# PHASE 12: LOW Issues + Dead Code Cleanup

## Phase goal
Address all 34 LOW severity issues: remove dead code, fix type issues, add documentation, minor optimizations.

## In scope
- LOW-001 through LOW-034

## Out of scope
- Any behavior changes (these are all minor quality fixes)

## Deliverables
- Multiple files across server, client, and core packages (minor edits each)
- `datafn/server/src/execution/mutation/records.ts` — Delete if confirmed dead
- `datafn/server/src/execution/cursors.ts` — Remove unused exports

## Requirements covered
LOW-001 through LOW-034

## Implementation tasks
1. **LOW-001**: Replace `as any` casts in route registration with proper types
2. **LOW-002**: Remove deprecated `enforcePayloadLimit` export
3. **LOW-003**: Remove deprecated `parseJsonBodyOrThrow` export
4. **LOW-004**: (Covered by LOG-001/002/003 in Phase 13)
5. **LOW-005**: Add `.unref()` to pruneInterval timer in server.ts
6. **LOW-006**: Change `afterQuery` hook to use return value if provided
7. **LOW-007**: Fix aggregate `count` to use `field` parameter when specified (count non-null values of that field)
8. **LOW-008**: Validate error shape in REST error handler before sending response
9. **LOW-009**: Lazy-evaluate `JSON.stringify` in `logRequest` (only when logger is debug-enabled)
10. **LOW-010**: Cache sorted keys in MemoryStore (if not done in SRV-014)
11. **LOW-011**: Use selective cloning instead of `structuredClone` on entire dataset in MemoryStore snapshot
12. **LOW-012**: Add comment documenting internal table index specifications
13. **LOW-013**: Add comment clarifying `updatedBy` handling in `buildReplaceRecord`
14. **LOW-014**: Distinguish "record not found" from "DB error" in guard error messages
15. **LOW-015**: Verify `mutation/records.ts` is dead code; if so, delete file
16. **LOW-016**: Replace O(n) `applyCursorAfter` with binary search on sorted results
17. **LOW-017**: Add comments documenting null handling semantics in cursor comparison
18. **LOW-018**: Extract system fields list from pushdown hardcode to shared constant (use `SYSTEM_FIELDS` from core)
19. **LOW-019**: Don't mutate input in `orderGroupedResults`; use `.slice().sort()` or `toSorted()`
20. **LOW-020**: Replace `any` types in aggregate.ts with proper generics
21. **LOW-021**: Remove unused `generateCursor`/`generateCursors` exports
22. **LOW-022**: Use a unique separator (e.g., `\x00`) for offline aggregate group key to prevent data collision
23. **LOW-023**: Add comment documenting `undefined` vs `null` semantics in normalize.ts
24. **LOW-024**: Align date.ts mutation handling with codec copy pattern
25. **LOW-025**: Add comment explaining `isArchived` in SYSTEM_FIELDS but not READONLY_SYSTEM_FIELDS
26. **LOW-026**: Add `"TRANSPORT_ERROR"` to core DatafnErrorCode type
27. **LOW-027**: Remove unused `_schemaIndex` parameter from offline/query.ts
28. **LOW-028**: Add resource count limit (100) and field count per resource (200) to `validateSchema`
29. **LOW-029**: Replace `new Date()` in softDelete plugin with configurable `getTimestamp()` from config
30. **LOW-030**: Delete dead `validateDotPath` function
31. **LOW-031**: Add type validation for filter operator values (e.g., `$gt` requires number/date)
32. **LOW-032**: Normalize operators to always use `$` prefix internally
33. **LOW-033**: Use logger (or redact) in error handlers instead of raw console
34. **LOW-034**: Add JSDoc documenting `MemoryRateLimiter.destroy()` requirement

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- `cd datafn/client && bun test` — all tests pass
- `cd datafn/core && bun test` — all tests pass
- TypeScript compiles without errors
- Verify deleted files are not imported anywhere

## Stop condition
All 34 LOW issues addressed. No regressions. Report list of changes per issue.
