# PHASE 05: Security HIGH — Server Fixes

## Phase goal
Fix all 8 HIGH security issues: relation authz, REST path traversal, seed namespace, cross-tab validation, having/groupBy deep validation, LIKE/search caps.

## In scope
- SEC-H1: Relation authz enforcement
- SEC-H2: REST path traversal protection
- SEC-H3: Seed handler namespace isolation
- SEC-H4: Cross-tab message validation
- SEC-H5: Having clause deep validation
- SEC-H6: GroupBy field schema validation
- SEC-H7: LIKE pattern length cap
- SEC-H8: Search query length cap

## Out of scope
- CRITICAL security (done in Phase 01)
- MEDIUM validation caps (Phase 09)

## Deliverables
- `datafn/server/src/validation/authz.ts` — Add relation authz check
- `datafn/server/src/routes/rest.ts` — Path sanitization
- `datafn/server/src/routes/seed.ts` — Namespace from auth
- `datafn/client/src/crossTab.ts` — Message validation
- `datafn/server/src/validation/query.ts` — Deep having validation, groupBy schema check, LIKE/search caps

## Requirements covered
SEC-009, SEC-010, SEC-011, SEC-012, SEC-013, SEC-014, SEC-015, SEC-016

## Implementation tasks
1. **Relation authz** (`authz.ts`):
   - Add `validateRelationAuthz(operation, resource, relation, policy)` function
   - For `relate`/`modifyRelation`/`unrelate`: check relation/FK field against `write.fields`
   - Wire into mutation validation and push validation paths

2. **REST path sanitization** (`rest.ts`):
   - After `pathname.split("/")`, run `decodeURIComponent()` on each segment
   - Reject if segment contains `..`, null bytes (`\0`), or decoded `/`
   - Return 400 with clear error

3. **Seed namespace** (`seed.ts`):
   - Replace hardcoded `"datafn"` with namespace from auth context
   - Use same `extractNamespace` pattern as other routes

4. **Cross-tab validation** (`crossTab.ts`):
   - Before casting `messageEvent.data` to `RelayEvent`:
     - Check `typeof data === "object" && data !== null`
     - Check `data.type` is one of known relay event types
     - Silently discard invalid messages

5. **Having validation** (`query.ts`):
   - Reuse filter validation logic for `having` clause
   - Validate field names against schema fields + aggregation aliases
   - Validate operators against allowed filter operators

6. **GroupBy validation** (`query.ts`):
   - Validate each `groupBy` field exists in resource schema
   - Unknown field → `DFQL_UNKNOWN_FIELD`

7. **LIKE pattern cap** (`query.ts`):
   - In filter validation, check `$like`/`$ilike` value length against `limits.maxLikePatternLength`
   - Default: 200

8. **Search query cap** (`query.ts`):
   - Check `search.query.length` against `limits.maxSearchQueryLength`
   - Default: 1000

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- `cd datafn/client && bun test` — all tests pass
- Tests for each fix (in existing or new test files):
  - Relation operation blocked when field not in write policy
  - REST `%2F` and `..` return 400
  - Seed stores records with auth-derived namespace
  - Cross-tab: invalid message → no crash, no processing
  - Having with unknown field → DFQL_UNKNOWN_FIELD
  - GroupBy with unknown field → DFQL_UNKNOWN_FIELD
  - LIKE pattern >200 chars → DFQL_INVALID
  - Search query >1000 chars → DFQL_INVALID

## Stop condition
All 8 HIGH security issues fixed. Report results.
