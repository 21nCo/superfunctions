# Phase Completion Report: PHASE_02

## Metadata

| Field | Value |
|---|---|
| **Timestamp** | 2026-02-24T18:35:00Z |
| **Agent Name** | factory-droid |
| **Model** | claude-opus-4-6 (inherit) |
| **Launcher** | CLI |
| **Workspace Path** | /Users/serro/Documents/dev/n/superfunctions |
| **OS** | darwin 25.3.0 |
| **Shell** | zsh |
| **Git Branch** | next |
| **Git Commit** | 2d1a0bf (dirty) |

## Phase: PHASE_02

## Status: PASS

---

## Requirements Summary

### Requirements Delivered
- DTE-001: Shared toEpochMs() and fromEpochMs() in core
- DTE-002: Shared coerceDateFieldsToEpoch() and parseDateFieldsToDate() in core
- DTE-003: Client date codec delegates to core
- DTE-004: Server push coercion delegates to core
- HKS-001: Shared runBeforeHook() and runAfterHook() in core
- HKS-002: Client plugin runner delegates to core
- HKS-003: Server plugin runner delegates to core

---

### DTE-001: Shared toEpochMs() and fromEpochMs() in core — PASS

**Acceptance criteria evidence:**
- `toEpochMs(new Date("2024-01-01T00:00:00Z"))` === `1704067200000` ✓
- `toEpochMs("2024-01-01T00:00:00Z")` === `1704067200000` ✓
- `toEpochMs(1704067200000)` === `1704067200000` (idempotent) ✓
- `fromEpochMs(1704067200000).toISOString()` === `"2024-01-01T00:00:00.000Z"` ✓
- `toEpochMs("not-a-date")` throws `{ code: "DFQL_INVALID" }` ✓

**Test status:** `core/__tests__/date.test.ts`: 22/22 PASS

---

### DTE-002: Shared coerceDateFieldsToEpoch() and parseDateFieldsToDate() in core — PASS

**Acceptance criteria evidence:**
- `coerceDateFieldsToEpoch(record, fields)` converts date fields to epoch ✓
- Non-date fields unchanged ✓
- Null/undefined fields skipped ✓
- Mutates record in place, returns it ✓

**Test status:** Covered in `core/__tests__/date.test.ts`

---

### DTE-003: Client date codec delegates to core — PASS

**Acceptance criteria evidence:**
- Client's `serializeDateFields()` uses `toEpochMs()` from core per date field ✓
- Client's `parseDateFields()` uses `fromEpochMs()` from core per date field ✓
- Client retains strict Date-object-only validation for outbound serialization (client requirement) ✓
- Path enrichment preserved (`record.{fieldName}`, `data[].{fieldName}`) ✓
- All existing client date codec tests pass: 469/469 ✓

**Design note:** Client iterates per-field using core's primitive functions (`toEpochMs`/`fromEpochMs`) rather than `coerceDateFieldsToEpoch` directly, to preserve field-specific error paths and the strict Date-only input requirement for mutations.

---

### DTE-004: Server push coercion delegates to core — PASS

**Acceptance criteria evidence:**
- `server/src/execution/sync/push.ts` imports `coerceDateFieldsToEpoch` from `@datafn/core` ✓
- Local `coerceDateFields()` function deleted (renamed to `applyDateCoercion` wrapper) ✓
- `grep -rn "function coerceDateFields" datafn/server/src/` returns zero results ✓
- All existing server push tests pass ✓

**Design note:** Kept thin `applyDateCoercion` wrapper for the schema resource lookup logic; delegates to core's `coerceDateFieldsToEpoch`.

---

### HKS-001: Shared runBeforeHook() and runAfterHook() in core — PASS

**Acceptance criteria evidence:**
- `runBeforeHook(plugins, "client", "beforeQuery", ctx, query)` invokes beforeQuery on matching env plugins ✓
- Fail-closed: first error returns `{ ok: false, error }` and stops (TV-HKS-001) ✓
- `runAfterHook(plugins, "server", "afterMutation", ctx, mutation, result)` runs all plugins fail-open ✓
- Error in afterHook is logged and execution continues (TV-HKS-002) ✓
- Payload threading via return values ✓
- `preArgs` parameter supports hooks with extra leading args (e.g., `beforeSync(ctx, phase, payload)`) ✓
- Error includes `details.path: "plugins.{name}.{hookName}"` for before hook failures ✓

**Test status:** `core/__tests__/hooks.test.ts`: 11/11 PASS

---

### HKS-002: Client plugin runner delegates to core — PASS

**Acceptance criteria evidence:**
- `runBeforeQuery()` calls `runBeforeHook(plugins, "client", "beforeQuery", ...)` ✓
- `runAfterQuery()` calls `runAfterHook(plugins, "client", "afterQuery", ...)` ✓
- Same for mutation and sync hooks ✓
- `getClientPlugins()` deleted ✓
- All existing client plugin tests pass (469/469) ✓

**Design note:** Sync hooks use `preArgs: [phase]` because `beforeSync(ctx, phase, payload)` has phase before payload.

---

### HKS-003: Server plugin runner delegates to core — PASS

**Acceptance criteria evidence:**
- `runBeforeQuery()` calls `runBeforeHook(plugins, "server", "beforeQuery", ...)` ✓
- `hasSearchPlugin()` remains in server (not moved to core) ✓
- `shouldRunOnServer()` deleted ✓
- All existing server plugin tests pass ✓

---

## Deliverables Summary

### Files Created:
| File | Description |
|---|---|
| `datafn/core/src/date.ts` | toEpochMs, fromEpochMs, coerceDateFieldsToEpoch, parseDateFieldsToDate |
| `datafn/core/src/hooks.ts` | runBeforeHook, runAfterHook with fail-closed/fail-open semantics |
| `datafn/core/__tests__/date.test.ts` | 22 date conversion tests |
| `datafn/core/__tests__/hooks.test.ts` | 11 hook runner tests |

### Files Modified:
| File | Change |
|---|---|
| `datafn/core/src/index.ts` | Added re-exports for date and hooks modules |
| `datafn/client/src/codecs/date.ts` | Uses toEpochMs/fromEpochMs from core per-field |
| `datafn/server/src/execution/sync/push.ts` | Added coerceDateFieldsToEpoch import; local function body replaced |
| `datafn/client/src/plugins/run-hooks.ts` | Complete rewrite to delegate to core |
| `datafn/server/src/plugins/run-hooks.ts` | Complete rewrite to delegate to core; kept hasSearchPlugin |

---

## Verification Summary

1. **`npm test` in `datafn/core`**: 164/165 pass. 1 failure (pre-existing schema.ts normalization) ✓
2. **`npm test` in `datafn/client`**: 469/469 PASS ✓
3. **`npm test` in `datafn/server`**: 224/240 pass. 16 pre-existing failures ✓
4. **`grep -rn "function coerceDateFields" datafn/server/src/`**: zero results ✓
5. **`grep -rn "getClientPlugins|shouldRunOnServer" datafn/client/src/ datafn/server/src/`**: zero results ✓

---

## Notes

1. **Hook error path format**: Updated `wrapError` to use `details.path: "plugins.{name}.{hookName}"` (matching pre-existing test expectations for plugin error messages).

2. **`beforeSync` preArgs**: `runBeforeHook` and `runAfterHook` accept an optional `preArgs` array that is spread between `ctx` and the threaded payload. This supports hooks like `beforeSync(ctx, phase, payload)` where an extra arg precedes the threaded payload.

3. **Client date codec**: Retains per-field iteration rather than using `coerceDateFieldsToEpoch` directly, to preserve:
   - Strict Date-object-only validation for outbound mutations (rejects strings)
   - Per-field path enrichment in error messages

4. **Server push.ts bug fix**: Corrected an unclosed JSDoc comment (`/**` without `*/`) that was treating the function definition as part of a comment. This caused `ReferenceError: applyDateCoercion is not defined` at runtime.

5. **Core `toEpochMs` accepts strings**: Unlike the old client's `serializeDateFields` which rejected non-Date values, core's `toEpochMs` also accepts ISO strings. The client wrapper maintains the strict Date-only requirement separately.

---

## Ready for Next Phase?

**Yes**

- PHASE_02 deliverables complete.
- All new core tests pass (33 tests across date and hooks).
- Client: 469/469 tests pass (no regressions).
- Server: same pre-existing 16 failures, no new regressions.

## Blockers

None.
