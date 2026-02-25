# PHASE 03: Cleanup — Client Internal Dedup + Alignment + Final Verification

## Phase Goal

Complete the consolidation with lower-priority client-internal dedup (storage adapter validation, event factory), adopt SchemaIndex in the client, align server's ValidationResult naming, and run full cross-package verification.

## In Scope

- Client builds SchemaIndex during initialization and uses it in offline query path.
- Extract shared storage adapter validation to `client/src/adapters/shared.ts`.
- Create `buildEvent()` factory in `client/src/events/build.ts`.
- Align server's `ValidationResult` property name from `value` to `result` (or provide adapter).
- Complete `core/src/index.ts` re-exports for all Phase 0-2 additions.
- Full regression test sweep across all 5 packages.
- Grep verification that all consolidated items have no remaining local duplicates.

## Out of Scope

- Adding new features or operators.
- Changing public APIs of client or server.
- DUP-014 (error classification) and DUP-015 (relation handling) — these are marked "Monitor" in the audit.

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/client/src/client.ts` | MODIFY | Build SchemaIndex on creation, pass to offline query |
| `datafn/client/src/offline/query.ts` | MODIFY | Accept SchemaIndex, use getResource()/getField() instead of .find() |
| `datafn/client/src/adapters/shared.ts` | CREATE | validateHydrationState(), validateTransition(), validateCursor() |
| `datafn/client/src/adapters/indexedDbStorage.ts` | MODIFY | Import from shared.ts, delete local copies |
| `datafn/client/src/adapters/memoryStorage.ts` | MODIFY | Import from shared.ts, delete local copies |
| `datafn/client/src/events/build.ts` | CREATE | buildEvent(type, overrides) factory |
| `datafn/client/src/client.ts` | MODIFY | Use buildEvent() for event construction |
| `datafn/client/src/sync/engine.ts` | MODIFY | Use buildEvent() for event construction |
| `datafn/server/src/validation/schema.ts` | MODIFY | Rename ValidationResult.value to ValidationResult.result; update vOk() |

## Requirements Covered

- IDX-003: Client uses SchemaIndex for offline query resource lookups
- VLD-001: Server ValidationResult aligned with DatafnEnvelope naming
- STR-001: Client storage adapter validation deduplicated
- EVT-001: Client event emission factory
- REG-001: (complete) All new core modules re-exported from core index
- TST-001: All existing tests pass after consolidation
- TST-002: New unit tests for each core module

## Implementation Tasks

1. **Client SchemaIndex adoption**:
   - In `client/src/client.ts`, after schema validation, call `buildSchemaIndex(schema)` from core.
   - Store the index on the client instance (internal, not public API).
   - Pass the index to `executeLocalQuery()` in `offline/query.ts`.
   - In `offline/query.ts`, replace `schema.resources.find(r => r.name === ...)` with `getResource(index, name)`.
   - Replace field lookups with `getField(index, resource, field)`.

2. **Storage adapter validation dedup**:
   - Create `client/src/adapters/shared.ts`.
   - Move `validateHydrationState()`, `validateTransition()`, and `validateCursor()` from `indexedDbStorage.ts` to `shared.ts`.
   - Export all three functions.
   - In `indexedDbStorage.ts` and `memoryStorage.ts`, import from `./shared.js` and delete local copies.
   - Ensure identical behavior (copy the function exactly, don't refactor).

3. **Event emission factory**:
   - Create `client/src/events/build.ts`.
   - Implement `buildEvent(type, overrides?)`:
     ```typescript
     export function buildEvent(type: DatafnEvent["type"], overrides?: Partial<Omit<DatafnEvent, "type" | "timestampMs">>): DatafnEvent {
       return { type, timestampMs: Date.now(), ...overrides };
     }
     ```
   - Update event construction in `client.ts`, `sync/engine.ts` to use `buildEvent()`.
   - Ensure the same event shape is produced.

4. **ValidationResult alignment**:
   - In `server/src/validation/schema.ts`, change `ValidationResult` type:
     - From: `{ ok: true; value: T }` → To: `{ ok: true; result: T }`
   - Update `vOk()`:
     - From: `return { ok: true, value }` → To: `return { ok: true, result: value }`
   - Update all server code that reads `.value` from `ValidationResult` to read `.result`.
   - This aligns with `DatafnEnvelope`'s property naming.

5. **Final re-export verification**:
   - Verify `core/src/index.ts` re-exports all new modules: system-fields, schema-index, filters, sort, date, hooks, select.
   - Run TypeScript compile check: `import { SYSTEM_FIELDS, buildSchemaIndex, evaluateFilter, parseSortTerms, toEpochMs, runBeforeHook, parseSelectToken } from "@datafn/core"` compiles.

6. **Full regression sweep**:
   - Run `npm test` in each package: core, client, server, cli, svelte.
   - All tests must pass.

7. **Grep verification** (confirm no remaining duplicates):
   - `grep -rn "function evaluateFilter" datafn/client/src/` → 0 results
   - `grep -rn "function coerceDateFields\b" datafn/server/src/` → 0 results (only import refs)
   - `grep -rn "new Set.*createdAt.*updatedAt" datafn/server/src/` → 0 results
   - `grep -rn "getClientPlugins\|shouldRunOnServer" datafn/client/src/ datafn/server/src/` → 0 results
   - `grep -rn "function parseSelectToken" datafn/server/src/execution/query/select.ts` → 0 results

## Verification Steps

1. Run `npm test` in all 5 packages — all tests pass.
2. All grep checks from task 7 return zero results.
3. TypeScript compiles without errors across all packages.
4. No `schema.resources.find()` calls remain in `client/src/offline/query.ts`.
5. Both storage adapters import from `adapters/shared.ts`.

## Stop Condition

- All 5 verification steps pass.
- IDX-003, VLD-001, STR-001, EVT-001, REG-001, TST-001, TST-002 acceptance criteria met.
- Full spec is complete — all 27 requirements satisfied.
