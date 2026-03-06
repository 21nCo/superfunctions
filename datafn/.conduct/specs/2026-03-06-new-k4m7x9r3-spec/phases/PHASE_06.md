# PHASE 06: Server — Query Auto-Filtering for Trash & Archive

## Phase goal
Inject automatic query filters server-side to exclude trashed and archived records by default, with metadata overrides.

## In scope
- Auto-inject `trashedAt IS NULL` filter for trash-enabled resources
- Auto-inject `isArchived != true` filter for archivable resources
- Support `metadata.includeTrashed` and `metadata.includeArchived` to suppress filters
- Filter injection in both REST query and sync pull paths
- Filter injection in pushdown (DB-level filtering)

## Out of scope
- Client metadata passing (Phase 7 handles client-side)
- Shareable query gating (Phase 11)

## Deliverables
- `datafn/server/src/execution/query/pushdown.ts` (updated — inject capability filters)
- `datafn/server/src/routes/query.ts` (updated — extract metadata, pass to execution)
- `datafn/server/src/execution/mutation/__tests__/query-autofilter.test.ts` (new)

## Requirements covered
- TR-004, TR-005, AR-004, AR-005

## Implementation tasks
1. Define query metadata type to include `includeTrashed?: boolean` and `includeArchived?: boolean`
2. In the query execution path (after validation, before pushdown), resolve capabilities for the queried resource
3. If `trash` capability enabled and `metadata.includeTrashed !== true`:
   - Inject filter condition: `{ trashedAt: null }` (only records where trashedAt is null)
   - Merge with any user-provided filters using `$and`
4. If `archivable` capability enabled and `metadata.includeArchived !== true`:
   - Inject filter condition: `{ isArchived: { $ne: true } }`
   - Merge with user filters
5. Update query route handler to extract `metadata` from query body and pass through
6. Ensure pushdown correctly handles null-check filters for `trashedAt`
7. Write tests:
   - Default query excludes trashed records
   - Default query excludes archived records
   - `includeTrashed: true` shows trashed records
   - `includeArchived: true` shows archived records
   - Both combined: shows all records
   - Non-capability resource: no filters injected
   - User filters preserved alongside auto-filters

## Verification steps
1. `cd datafn/server && npx vitest run` — all tests pass including new ones
2. Integration test: insert 3 records, trash 1, archive 1, query returns 1

## Stop condition
Auto-filtering works for both trash and archive. Metadata overrides work. No regressions.
