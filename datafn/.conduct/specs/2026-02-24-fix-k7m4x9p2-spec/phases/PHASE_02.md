# PHASE 02: Mutation/Sync Utilities — Date Codecs + Plugin Hook Runner

## Phase Goal

Create shared date conversion utilities and a generic plugin hook runner in `@datafn/core`. Update both client and server to delegate to core implementations, deleting local duplicates.

## In Scope

- Create `core/src/date.ts` with `toEpochMs()`, `fromEpochMs()`, `coerceDateFieldsToEpoch()`, `parseDateFieldsToDate()`.
- Create `core/src/hooks.ts` with `runBeforeHook()` and `runAfterHook()`.
- Update `core/src/index.ts` to re-export new modules.
- Update `client/src/codecs/date.ts` to delegate to core.
- Update `server/src/execution/sync/push.ts` to delegate to core.
- Update `client/src/plugins/run-hooks.ts` to delegate to core.
- Update `server/src/plugins/run-hooks.ts` to delegate to core.
- Create unit tests for both new modules.

## Out of Scope

- Client-internal dedup (Phase 3).
- Schema index usage in client (Phase 3).
- Adding new date formats or hook types.

## Deliverables

| File | Action | Description |
|---|---|---|
| `datafn/core/src/date.ts` | CREATE | toEpochMs(), fromEpochMs(), coerceDateFieldsToEpoch(), parseDateFieldsToDate() |
| `datafn/core/src/hooks.ts` | CREATE | runBeforeHook(), runAfterHook() |
| `datafn/core/src/index.ts` | MODIFY | Re-export date and hooks modules |
| `datafn/core/__tests__/date.test.ts` | CREATE | Conversion, idempotency, schema-driven, and error tests |
| `datafn/core/__tests__/hooks.test.ts` | CREATE | Fail-closed, fail-open, env filtering, payload threading tests |
| `datafn/client/src/codecs/date.ts` | MODIFY | Delegate to core date utilities |
| `datafn/server/src/execution/sync/push.ts` | MODIFY | Import coerceDateFieldsToEpoch from core; delete local coerceDateFields |
| `datafn/client/src/plugins/run-hooks.ts` | MODIFY | Delegate to core hook runner |
| `datafn/server/src/plugins/run-hooks.ts` | MODIFY | Delegate to core hook runner; keep hasSearchPlugin locally |

## Requirements Covered

- DTE-001: Shared toEpochMs() and fromEpochMs() in core
- DTE-002: Shared coerceDateFieldsToEpoch() and parseDateFieldsToDate() in core
- DTE-003: Client date codec delegates to core
- DTE-004: Server push coercion delegates to core
- HKS-001: Shared runBeforeHook() and runAfterHook() in core
- HKS-002: Client plugin runner delegates to core
- HKS-003: Server plugin runner delegates to core

## Implementation Tasks

1. **Create `core/src/date.ts`**:
   - Implement `toEpochMs(value: unknown): number`:
     - If `value` is a `number`, return it directly (idempotent).
     - If `value` is a `Date`, return `value.getTime()`. If `NaN`, throw.
     - If `value` is a `string`, parse with `new Date(value)`. If `NaN`, throw.
     - Throw `DatafnError` with code `DFQL_INVALID` and message including the value for all other types.
   - Implement `fromEpochMs(value: unknown): Date`:
     - If `value` is a `Date`, return it directly (idempotent).
     - If `value` is a `number`, return `new Date(value)`.
     - If `value` is a `string`, return `new Date(value)`. If invalid, throw.
     - Throw `DatafnError` for unsupported types.
   - Implement `coerceDateFieldsToEpoch(record, fields)`:
     - Iterate `fields`. For each field where `field.type === "date"`:
       - If `record[field.name]` is `null` or `undefined`, skip.
       - Otherwise, `record[field.name] = toEpochMs(record[field.name])`.
     - Return the record (mutated in place).
   - Implement `parseDateFieldsToDate(record, fields)`:
     - Same iteration but uses `fromEpochMs()`.
     - Return the record (mutated in place).

2. **Create `core/src/hooks.ts`**:
   - Implement `runBeforeHook(plugins, env, hookName, ctx, payload, ...extra)`:
     - Filter plugins by `plugin.runsOn.includes(env)`.
     - For each matching plugin that has `plugin[hookName]`:
       - Call `plugin[hookName](ctx, payload, ...extra)`.
       - If the hook returns a value, use it as the new payload (threading).
       - If the hook throws, return `{ ok: false, error: wrapError(err) }` and stop.
     - Return `{ ok: true, value: finalPayload }`.
   - Implement `runAfterHook(plugins, env, hookName, ctx, payload, result, ...extra)`:
     - Filter plugins by `plugin.runsOn.includes(env)`.
     - For each matching plugin that has `plugin[hookName]`:
       - Call `plugin[hookName](ctx, payload, result, ...extra)`.
       - If it throws, `console.error` the error and continue.
     - Return void.
   - Error wrapping: Create `DatafnError` with code `INTERNAL`, message from the thrown error, details including plugin name.

3. **Update `core/src/index.ts`**: Add re-exports for date and hooks.

4. **Create `core/__tests__/date.test.ts`**:
   - Test `toEpochMs` with Date, ISO string, epoch number.
   - Test idempotency: `toEpochMs(toEpochMs(value))`.
   - Test `fromEpochMs` with number, string, Date.
   - Test idempotency: `fromEpochMs(fromEpochMs(value))`.
   - Test `coerceDateFieldsToEpoch` with mixed field types.
   - Test null/undefined date fields are skipped.
   - Test invalid date throws DFQL_INVALID.

5. **Create `core/__tests__/hooks.test.ts`**:
   - Test `runBeforeHook` with successful plugins — payload threaded.
   - Test `runBeforeHook` fail-closed: error stops chain, returns error result.
   - Test `runAfterHook` fail-open: error logged, all plugins called.
   - Test env filtering: "client" plugins not called when env is "server".
   - Test plugins without the hook method are skipped.
   - Test empty plugins array returns ok.

6. **Modify `client/src/codecs/date.ts`**:
   - Import `toEpochMs`, `fromEpochMs`, `coerceDateFieldsToEpoch`, `parseDateFieldsToDate` from `@datafn/core`.
   - `serializeDateFields()` becomes a thin wrapper calling `coerceDateFieldsToEpoch()`.
   - `parseDateFields()` becomes a thin wrapper calling `parseDateFieldsToDate()`.
   - Delete duplicated conversion logic.
   - Retain client-specific error path enrichment if needed.

7. **Modify `server/src/execution/sync/push.ts`**:
   - Import `coerceDateFieldsToEpoch` from `@datafn/core`.
   - Replace local `coerceDateFields()` with a call to `coerceDateFieldsToEpoch()`.
   - Delete local function.
   - Adjust the resource-lookup logic: the function needs to find the resource's fields from the schema. Use `getResource()` from core if SchemaIndex is available, or `schema.resources.find()`.

8. **Modify `client/src/plugins/run-hooks.ts`**:
   - Import `runBeforeHook`, `runAfterHook` from `@datafn/core`.
   - Each exported function (`runBeforeQuery`, `runAfterQuery`, etc.) becomes a thin wrapper:
     ```typescript
     export async function runBeforeQuery(plugins, ctx, query) {
       return runBeforeHook(plugins, "client", "beforeQuery", ctx, query);
     }
     ```
   - Delete the local `getClientPlugins()` helper and iteration logic.
   - Adapt the return value: if the existing client code throws on error, the wrapper converts `{ ok: false, error }` to a throw.

9. **Modify `server/src/plugins/run-hooks.ts`**:
   - Import `runBeforeHook`, `runAfterHook` from `@datafn/core`.
   - Each exported function becomes a thin wrapper with `env: "server"`.
   - Keep `hasSearchPlugin()` locally (not moved to core).
   - Delete the local `shouldRunOnServer()` helper and iteration logic.

## Verification Steps

1. Run `npm test` in `datafn/core` — all tests pass including new date/hooks tests.
2. Run `npm test` in `datafn/client` — all existing tests pass (especially date codec tests, plugin tests).
3. Run `npm test` in `datafn/server` — all existing tests pass (especially sync tests, plugin tests).
4. `grep -rn "function coerceDateFields" datafn/server/src/` returns zero results for local function (only import reference).
5. `grep -rn "getClientPlugins\|shouldRunOnServer" datafn/client/src/ datafn/server/src/` returns zero results.

## Stop Condition

- All 5 verification steps pass.
- DTE-001 through DTE-004, HKS-001 through HKS-003 acceptance criteria met.
- No TypeScript compilation errors in core, client, or server.
