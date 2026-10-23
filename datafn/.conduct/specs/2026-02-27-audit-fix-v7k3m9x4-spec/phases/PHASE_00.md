# PHASE 00: Shared Validation Primitives

## Phase goal
Create shared validation utilities used across all subsequent phases: prototype pollution check, field value type validator, config type definitions.

## In scope
- Prototype pollution key checker (recursive)
- Field value type validator function
- Config type additions to `DatafnServerConfig` (limits, ws, logger, shutdown, debug)
- `DatafnLogger` interface definition

## Out of scope
- Wiring into routes/handlers (Phase 01+)
- Logger default implementation (Phase 13)
- Actual enforcement in endpoints (Phase 01)

## Deliverables
- `datafn/core/src/validate.ts` — NEW file with `checkPrototypePollution(obj)` and `validateFieldValue(type, value, nullable)`
- `datafn/core/src/types.ts` — Add config type extensions
- `datafn/core/src/index.ts` — Export new utilities

## Requirements covered
- SEC-008 (prototype pollution utility)
- SEC-005 (type validation utility)
- LOG-001 (DatafnLogger interface)
- All new `limits.*` and `ws.*` config fields

## Implementation tasks
1. Create `datafn/core/src/validate.ts`:
   - `DISALLOWED_KEYS = new Set(["__proto__", "constructor", "prototype"])`
   - `checkPrototypePollution(obj: unknown): { ok: boolean; key?: string }` — recursive check on plain objects
   - `validateFieldValue(schemaType: string, value: unknown, nullable: boolean): { ok: boolean; error?: string }` — strict type checking per schema type
2. Add `DatafnLogger` interface to `datafn/core/src/types.ts`
3. Extend `DatafnServerConfig` limits type with new fields (maxBatchSize, maxCloneRecords, idempotencyTtlMs, etc.)
4. Add `ws` config section type
5. Add `shutdownTimeoutMs`, `debug`, `logger` to config type
6. Export `checkPrototypePollution`, `validateFieldValue` from `datafn/core/src/index.ts`
7. Write unit tests for both utilities

## Verification steps
- `cd datafn/core && bun test` — all tests pass
- New tests verify:
  - `checkPrototypePollution({ __proto__: {} })` → `{ ok: false, key: "__proto__" }`
  - `checkPrototypePollution({ nested: { constructor: {} } })` → `{ ok: false, key: "constructor" }`
  - `checkPrototypePollution({ safe: "value" })` → `{ ok: true }`
  - `validateFieldValue("number", "hello", false)` → `{ ok: false, error: "..." }`
  - `validateFieldValue("number", 42, false)` → `{ ok: true }`
  - `validateFieldValue("string", null, true)` → `{ ok: true }`
  - `validateFieldValue("string", null, false)` → `{ ok: false }`
  - `validateFieldValue("date", "2026-01-01T00:00:00Z", false)` → `{ ok: true }`
  - `validateFieldValue("date", 1767225600000, false)` → `{ ok: true }`
  - `validateFieldValue("object", [1,2], false)` → `{ ok: false }`

## Stop condition
All new tests pass. Types compile. Core package builds successfully. Report back with test results.
