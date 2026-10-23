# Phase 2: datafn Server Auto-Wrapping

## Goal
When `authContextProvider` is configured in `createDatafnServer`, automatically wrap the adapter with `wrapWithRowLevelNamespace` so that all data operations are namespace-isolated without manual setup.

## Scope
- `datafn/server/src/server.ts`

## Requirements Covered
DFN-001, DFN-002, DFN-003, DFN-004, DFN-005, DFN-006, DFN-007

## Depends On
Phase 0

## Tasks

### 2.1 — Auto-wrap logic in `createDatafnServer`
In `datafn/server/src/server.ts`, after adapter creation and before passing to handlers:
1. Check if `authContextProvider` is defined in config.
2. If yes, call `wrapWithRowLevelNamespace(adapter, { enabled: true, columnName: '__ns', mandatory: true })`.
3. Use the wrapped adapter for all subsequent handler calls.
4. `db.internal` remains unwrapped (the wrapper already passes it through).

### 2.2 — Opt-out escape hatch
Add optional `rowLevelNamespace?: false | RowLevelNamespaceConfig` to `DatafnServerConfig`:
- If explicitly set to `false`, skip auto-wrapping even when `authContextProvider` is present.
- If set to a config object, use that config for wrapping.
- If omitted and `authContextProvider` is present, auto-enable with defaults.

### 2.3 — Namespace extraction consistency
Verify that `extractNamespace(ctx)` output is used as the `namespace` param in all db calls. Current code already does this — no changes expected, just verification.

## Verification
- Unit test: `createDatafnServer` with `authContextProvider` → adapter is wrapped (mock adapter spy).
- Unit test: `createDatafnServer` with `rowLevelNamespace: false` → adapter is NOT wrapped.
- Unit test: `createDatafnServer` without `authContextProvider` → adapter is NOT wrapped.

## Estimate
~1 day

## Exit Criteria
- Auto-wrapping logic is in place and conditionally applied.
- All existing datafn server tests still pass.
- New unit tests verify wrapping/non-wrapping conditions.
