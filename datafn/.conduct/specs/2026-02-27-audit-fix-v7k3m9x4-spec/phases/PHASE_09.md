# PHASE 09: Validation MEDIUM — All Caps + Config Defaults

## Phase goal
Add all validation limits, deny-by-default authz, error disclosure control, default payload size.

## In scope
- VAL-001: Authz deny-by-default
- VAL-002: Select token limit (50)
- VAL-003: Filter key limit (20)
- VAL-004: Sort field limit (10)
- VAL-005: Aggregation count limit (20)
- VAL-006: ID length limit (255)
- VAL-007: clientId/mutationId validation
- VAL-008: Version field validation
- VAL-009: Error disclosure control (debug mode)
- VAL-010: Default payload size (5MB)

## Out of scope
- CRITICAL security already wired (Phase 01)
- Logging (Phase 13)

## Deliverables
- `datafn/server/src/validation/authz.ts` — Deny-by-default for unknown resources
- `datafn/server/src/validation/query.ts` — All query validation caps
- `datafn/server/src/validation/mutation.ts` — ID length, clientId/mutationId, version validation
- `datafn/server/src/server.ts` — Config defaults for all limits, debug mode
- `datafn/server/src/validation/index.ts` — Debug flag threading

## Requirements covered
VAL-001 through VAL-010

## Implementation tasks
1. **Deny-by-default** (`authz.ts`):
   - When resource has no policy: return `{ ok: false, error: { code: "FORBIDDEN", message: "No authorization policy found for resource '...'. Define a policy or use allowUnknownResources: true to allow." } }`
   - Add `allowUnknownResources` option check

2. **Query validation caps** (`query.ts`):
   - Check `select.length > maxSelectTokens` → DFQL_INVALID
   - Check `Object.keys(filter).length > maxFilterKeysPerLevel` at each nesting level → DFQL_INVALID
   - Check `sort.length > maxSortFields` → DFQL_INVALID
   - Check `Object.keys(aggregations).length > maxAggregations` → DFQL_INVALID

3. **Mutation validation** (`mutation.ts`):
   - Check `id.length > maxIdLength` → DFQL_INVALID
   - Validate `clientId` and `mutationId`: non-empty string, max 255 chars
   - Validate `version`: positive integer if provided

4. **Debug mode** (`validation/*.ts`):
   - Thread `debug` flag through validation functions
   - When `debug: false`: strip field names and schema details from error messages
   - When `debug: true`: current detailed behavior

5. **Config defaults** (`server.ts`):
   - Set all new `limits.*` defaults
   - Set `debug` default: `process.env.NODE_ENV !== "production"`
   - Ensure `maxPayloadBytes` defaults to 5,242,880

## Verification steps
- `cd datafn/server && bun test` — all tests pass
- Tests:
  - Unknown resource → FORBIDDEN (deny-by-default)
  - Unknown resource + allowUnknownResources → ok
  - Select with 51 tokens → DFQL_INVALID
  - Filter with 21 keys → DFQL_INVALID
  - Sort with 11 fields → DFQL_INVALID
  - 21 aggregations → DFQL_INVALID
  - 300-char ID → DFQL_INVALID
  - Empty clientId → DFQL_INVALID
  - version: -1 → DFQL_INVALID
  - debug: false → generic error message
  - debug: true → detailed error message

## Stop condition
All validation caps enforced. Config defaults applied. Report results.
