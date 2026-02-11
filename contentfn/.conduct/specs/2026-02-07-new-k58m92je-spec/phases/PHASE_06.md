# PHASE_06: CFQL query engine (filter/order/projection/pagination)

## Phase goal

Implement the deterministic CFQL query execution engine and `/contentfn/query` endpoint with filtering, ordering, projection, and cursor pagination.

## In scope

- HTTP endpoint:
  - `POST /contentfn/query`
- CFQL validation and execution:
  - filter operators
  - orderBy with deterministic `_id asc` tie-breaker
  - default ordering when omitted (`_updatedAt desc, _id asc`)
  - limit + cursor pagination (opaque cursor)
  - projection fields selection

## Out of scope

- Reference expansion (PHASE_07)
- Search-backed `match` behavior (PHASE_14 unless DB-native match exists)

## Deliverables

- `contentfn/server/src/http/endpoints/query.ts`
- `contentfn/server/src/query/executeCfql.ts`
- `contentfn/server/src/query/cursor.ts` (opaque cursor encode/decode)
- `contentfn/server/src/query/order.ts` (deterministic ordering rules)
- Tests implementing:
  - TV-QRY-001
  - TV-QRY-PROJECTION-001
  - TV-QRY-INVALID-001
  - TV-QRY-ORDER-DEFAULT-001
  - TV-QRY-ORDER-TIEBREAK-001
  - TV-QRY-CURSOR-001

## Requirements covered

- QRY-001
- QRY-002

## Implementation tasks

1. Validate CFQL inputs deterministically:
   - dataset exists
   - types list is valid
   - operator allowlist and filter shape
2. Build adapter query using `@superfunctions/db` where operators map cleanly; otherwise fallback to in-memory filtering with clear performance limits.
3. Implement deterministic ordering:
   - normalize `orderBy` to include `_id asc` if absent
   - default ordering when `orderBy` missing
4. Implement cursor pagination:
   - encode last tuple into opaque cursor
   - decode and apply as "seek" condition deterministically
5. Implement projection:
   - include system fields always unless documented otherwise
   - select only requested user fields
6. Add tests that assert deterministic ordering and cursor stability.

## Verification steps

- Execute query tests repeatedly (same dataset state) and confirm identical ordering and cursor behavior.
- Confirm invalid operators return `QUERY_INVALID` with `details.path`.

## Stop condition

- Query endpoint passes all referenced TVs and determinism invariants hold.

