# Issue Completion Report: KV `value` field schema type `"object"` rejects primitive values

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-03-01T12:59:00Z |
| **Agent** | unknown-agent |
| **Model** | claude-opus-4-6[1m] |
| **Launcher** | Claude Code (Warp) |
| **Workspace** | /Users/serro/Documents/dev/n/superfunctions |
| **OS / Shell** | darwin 25.3.0 / zsh |
| **Git branch** | `next` |
| **Git commit** | `ea87d7e` (dirty) |
| **Issue file** | `datafn/.conduct/issues/2026-03-01-k7v3m9x4-issue.md` |

## Issue Summary

The built-in KV resource defined its `value` field with schema type `"object"`, but the KV API (`kv.set<T>`) accepts any JSON-serializable value. When `kv.set("key", "string")` was called, the server validation rejected it with `DFQL_INVALID: Field 'value' expects object, got string`. This made the KV store unusable for primitives (strings, numbers, booleans, arrays).

## Status: PASS

## Requirements Summary

### Requirement 1: Add `"json"` field type to the DataFn type system
- **Status:** PASS
- **Evidence:** Added `"json"` to `DatafnFieldSchema.type` union in `datafn/core/src/types.ts:56` and to relation metadata type at line 82.

### Requirement 2: Add `"json"` validation case to `validateFieldValue`
- **Status:** PASS
- **Evidence:** Added `"json"` case in `datafn/core/src/validate.ts` that accepts strings, numbers, booleans, objects, and arrays. 7 new tests added in `datafn/core/__tests__/validate.test.ts` — all pass (34/34 total).

### Requirement 3: Change KV resource `value` field type from `"object"` to `"json"`
- **Status:** PASS
- **Evidence:** Changed `type: "object"` to `type: "json"` in `datafn/core/src/kv.ts:55`.

### Requirement 4: Add `"json"` mapping to CLI Drizzle codegen
- **Status:** PASS
- **Evidence:** Added `case "json":` alongside `"object"` and `"array"` in `getColumnType()` for all three dialects (postgres → `jsonb`, mysql → `json`, sqlite → `text`). All 39 drizzle codegen tests pass.

### Requirement 5: Add `"json"` mapping to CLI TypeScript codegen
- **Status:** PASS
- **Evidence:** Added `case "json": return "unknown"` in `mapFieldType()` in `datafn/cli/src/codegen.ts`.

### Requirement 6: No regressions in existing tests
- **Status:** PASS
- **Evidence:** All 73 tests across validate + drizzle-codegen pass. 41 sync server tests pass. One pre-existing failure in `schema.test.ts` (unrelated — empty fields array with index references, existed before this change).

## Implementation Summary

### Files changed:
- `datafn/core/src/types.ts` — Added `"json"` to `DatafnFieldSchema.type` union and relation metadata type union
- `datafn/core/src/validate.ts` — Added `"json"` case to `validateFieldValue()` accepting all JSON-serializable types
- `datafn/core/src/kv.ts` — Changed KV `value` field type from `"object"` to `"json"`
- `datafn/cli/src/drizzle-codegen.ts` — Added `"json"` to `getColumnType()` for postgres, mysql, sqlite dialects
- `datafn/cli/src/codegen.ts` — Added `"json"` to `mapFieldType()`
- `datafn/core/__tests__/validate.test.ts` — Added 7 tests for `"json"` field type validation

### Key changes:
- Introduced a new `"json"` field type to the DataFn type system that accepts any JSON-serializable value (string, number, boolean, object, array)
- Changed the built-in KV resource's `value` field from `"object"` to `"json"`, fixing the 400 rejection for primitive values
- No SQL migration needed — `"json"` maps to the same SQL column types as `"object"` (`jsonb`/`json`/`text`)

## Verification Summary

### Test execution results:
- `datafn/core/__tests__/validate.test.ts`: 34/34 passed (7 new json tests)
- `datafn/cli/__tests__/drizzle-codegen.test.ts`: 39/39 passed
- `datafn/server/__tests__/sync.test.ts`: 41/41 passed

### Verification commands:
- `npx vitest run datafn/core/__tests__/validate.test.ts` — PASS
- `npx vitest run datafn/cli/__tests__/drizzle-codegen.test.ts` — PASS
- `npx vitest run datafn/server/__tests__/sync.test.ts` — PASS

## Notes

- The `"json"` type name was chosen over `"any"` as specified in the issue — it precisely describes acceptance of any valid JSON value
- No migration needed: `"json"` maps to identical SQL column types as `"object"` (`jsonb` for postgres, `json` for mysql, `text` for sqlite)
- This is a type system extension, not just a KV fix — any user can now define `type: "json"` fields in their own resource schemas
- The pre-existing test failure in `schema.test.ts` line 125 ("normalizes indices object format") is unrelated — it uses empty `fields: []` with index references that fail field validation added in a prior commit
