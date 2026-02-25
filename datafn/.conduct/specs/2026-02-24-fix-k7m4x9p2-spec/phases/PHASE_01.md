# PHASE 01: Query Utilities — Filter Evaluation + Sort + Select Token

## Phase Goal

Create shared filter evaluation, sort parsing/execution, and select token parsing in `@datafn/core`. Update both client and server to import from core and delete their local implementations.

## In Scope

- Create `core/src/filters.ts` with `evaluateFilter()` supporting all DFQL operators and relation resolver injection.
- Create `core/src/sort.ts` with `parseSortTerms()` and `sortRecords()`.
- Create `core/src/select.ts` with `parseSelectToken()`.
- Update `core/src/index.ts` to re-export new modules.
- Update `client/src/offline/query.ts` to import shared filter and sort utilities.
- Update `server/src/execution/query/filters.ts` to delegate to shared evaluator.
- Update `server/src/execution/query/sort.ts` to re-export from core.
- Update `server/src/execution/query/select.ts` to import shared parser.
- Update `server/src/validation/query.ts` to use shared parseSelectToken.
- Create unit tests for all new modules.

## Out of Scope

- Date codecs (Phase 2).
- Hook runner (Phase 2).
- Client SchemaIndex adoption (Phase 3).
- Adding new operators beyond what client and server currently support.

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/core/src/filters.ts` | CREATE | evaluateFilter() with full operator set and optional relation resolver |
| `datafn/core/src/sort.ts` | CREATE | parseSortTerms(), SortTerm type, sortRecords() |
| `datafn/core/src/select.ts` | CREATE | parseSelectToken(), SelectToken type |
| `datafn/core/src/index.ts` | MODIFY | Re-export filters, sort, select modules |
| `datafn/core/__tests__/filters.test.ts` | CREATE | Tests for all operators, logical combinators, dot-paths, relation resolver, error cases |
| `datafn/core/__tests__/sort.test.ts` | CREATE | Tests for parsing all sort formats, sort with tie-breaker, null handling |
| `datafn/core/__tests__/select.test.ts` | CREATE | Tests for all token formats |
| `datafn/client/src/offline/query.ts` | MODIFY | Import evaluateFilter and parseSortTerms from core; delete local implementations |
| `datafn/server/src/execution/query/filters.ts` | MODIFY | Delegate core operator evaluation to shared evaluateFilter; keep relation quantifier logic ($any/$all/$none) as server wrapper |
| `datafn/server/src/execution/query/sort.ts` | MODIFY | Import parseSortTerms and sortRecords from core; re-export; keep validateSortForCursor locally |
| `datafn/server/src/execution/query/select.ts` | MODIFY | Import parseSelectToken from core; delete local parseSelectToken |
| `datafn/server/src/validation/query.ts` | MODIFY | Use parseSelectToken from core in validateSelectTokens |

## Requirements Covered

- FLT-001: Shared evaluateFilter() in core with full operator set
- FLT-002: Relation resolver injection via callback
- FLT-003: Client offline query uses shared evaluateFilter
- FLT-004: Server query executor uses shared evaluateFilter
- SRT-001: Shared parseSortTerms() in core
- SRT-002: Shared sortRecords() in core
- SRT-003: Client and server use shared sort utilities
- SEL-001: Shared parseSelectToken() in core
- SEL-002: Server validation and execution use shared parser

## Implementation Tasks

1. **Create `core/src/filters.ts`**:
   - Define `FilterEvalOptions` interface with optional `resolveRelation` callback.
   - Implement `evaluateFilter(record, filters, opts?)` with:
     - Comparison operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`
     - Set operators: `$in`, `$nin`
     - String operators: `$contains`, `$startsWith`, `$endsWith`, `$like`, `$ilike`, `$not_like`, `$not_ilike`
     - Null/empty operators: `$is_null`, `$is_not_null`, `$is_empty`, `$is_not_empty`
     - Range operators: `$before`, `$after`, `$between`, `$not_between`
     - Logical operators: `$and`, `$or`
     - Dot-path support for nested objects.
     - When a dot-path matches a relation (detected via `resolveRelation` callback), resolve related records and evaluate filter against them.
     - When `resolveRelation` is not provided and a dot-path cannot be resolved on the record, return `false` (field not present).
   - Implement `$like` and `$ilike` using SQL-like pattern matching (`%` = any, `_` = single char).
   - Throw `DatafnError` with `DFQL_UNSUPPORTED` for unknown operators.

2. **Create `core/src/sort.ts`**:
   - Define `SortTerm` interface with `field` and `direction`.
   - Implement `parseSortTerms(sort)`:
     - `"field"` → `{ field, direction: "asc" }`
     - `"field:asc"` → `{ field, direction: "asc" }`
     - `"field:desc"` → `{ field, direction: "desc" }`
     - `"-field"` → `{ field (without -), direction: "desc" }`
     - `undefined` → `[]`
   - Implement `sortRecords(records, terms)`:
     - Stable sort using `Array.sort()`.
     - Compare by each term in order.
     - Null values sort after non-null in ascending, before in descending.
     - Tie-breaker: sort by `id` ascending when all terms are equal.

3. **Create `core/src/select.ts`**:
   - Define `SelectToken` interface.
   - Implement `parseSelectToken(token)`:
     - Split on `.`.
     - `baseName` = first segment.
     - `directive` = remaining segments joined by `.` or `undefined` if only one segment.
     - `path` = all segments.

4. **Update `core/src/index.ts`**: Add re-exports for filters, sort, select.

5. **Create tests**:
   - `core/__tests__/filters.test.ts`: Test every operator individually, logical combinations, dot-paths, relation resolver, and error cases.
   - `core/__tests__/sort.test.ts`: Test all parse formats, sort execution, null handling, tie-breaker.
   - `core/__tests__/select.test.ts`: Test all token formats.

6. **Modify `client/src/offline/query.ts`**:
   - Replace local `evaluateFilter()` with import from `@datafn/core`.
   - Replace inline sort parsing with `parseSortTerms()` from `@datafn/core`.
   - Replace inline sort execution with `sortRecords()` from `@datafn/core`.
   - Delete the local filter function (~100 lines).
   - Delete the local sort parsing code.
   - Ensure operator names match (client currently uses `$eq`; core uses `$eq`).

7. **Modify `server/src/execution/query/filters.ts`**:
   - Import `evaluateFilter` from `@datafn/core`.
   - Server's `evaluateFilter()` becomes a thin wrapper that:
     - Maps server's non-prefixed operator names (if any) to `$`-prefixed.
     - Provides a `resolveRelation` callback using the `DataStore`.
     - Handles relation quantifiers (`$any`, `$all`, `$none`) that may remain server-specific.
   - Delete the duplicated operator evaluation logic (~150 lines).

8. **Modify `server/src/execution/query/sort.ts`**:
   - Import `parseSortTerms` and `sortRecords` from `@datafn/core`.
   - Re-export `parseSortTerms` and `sortRecords`.
   - Keep `validateSortForCursor()` and any other server-specific functions locally.
   - Delete duplicated parse/sort logic.

9. **Modify `server/src/execution/query/select.ts`**:
   - Import `parseSelectToken` from `@datafn/core`.
   - Delete local `parseSelectToken()` function.
   - Update all call sites within the file.

10. **Modify `server/src/validation/query.ts`**:
    - Import `parseSelectToken` from `@datafn/core`.
    - Use it in `validateSelectTokens()` instead of inline splitting.

## Verification Steps

1. Run `npm test` in `datafn/core` — all tests pass including new filter/sort/select tests.
2. Run `npm test` in `datafn/client` — all existing tests pass (especially `local-dfql.test.ts`).
3. Run `npm test` in `datafn/server` — all existing tests pass (especially `dfql-select.test.ts`, `query-validation.test.ts`).
4. `grep -rn "function evaluateFilter" datafn/client/src/` returns zero results (local function deleted).
5. `grep -rn "function parseSelectToken" datafn/server/src/execution/query/select.ts` returns zero results.

## Stop Condition

- All 5 verification steps pass.
- FLT-001 through FLT-004, SRT-001 through SRT-003, SEL-001, SEL-002 acceptance criteria met.
- No TypeScript compilation errors in core, client, or server.
