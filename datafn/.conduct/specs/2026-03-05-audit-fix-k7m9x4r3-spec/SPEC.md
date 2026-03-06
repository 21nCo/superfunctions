# SPEC: Fix Error Handling — Silent Swallowing, Missing Logger Propagation, Generic Client Messages

## Metadata

- **Timestamp**: 2026-03-05T14:00:00Z
- **Agent**: claude-opus-4-6
- **Model**: claude-opus-4-6
- **Launcher**: VS Code (Claude Code Extension)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin 25.3.0, zsh
- **Git branch**: `next`
- **Git commit**: `664f92c` (dirty)
- **spec_folder**: `2026-03-05-audit-fix-k7m9x4r3-spec`
- **spec_folder path**: `datafn/.conduct/specs/2026-03-05-audit-fix-k7m9x4r3-spec`
- **spec_type**: `audit-fix`
- **spec_id**: `k7m9x4r3`
- **Input paths**:
  - `datafn/.conduct/audit-2026-03-05-error-handling.md` (source audit)
  - `datafn/.conduct/issues/2026-03-03-r4k7m9x3-issue.md` (trigger issue)
- **Audit reference**: `audit-2026-03-05-error-handling.md` — triggered by issue `2026-03-03-r4k7m9x3`

---

## Overview

The datafn server has 24 error handling defects identified by audit `audit-2026-03-05-error-handling.md`. These fall into five categories:

1. **SWALLOW** — catch blocks discard errors with no logging (12 sites)
2. **NO-LOGGER** — functions lack a `logger` parameter entirely (4 functions)
3. **LOGGER-NOT-PASSED** — callers have `logger` in scope but do not pass it to child functions (3 call sites)
4. **GENERIC-MSG** — errors are logged server-side but the client receives only `"Internal error"` (8 routes — intentional for security, but no correlation ID)
5. **RETURN-ZERO** — errors are caught and the function returns `0` instead of propagating, masking DB failures as "no data" (2 sites)

This spec defines the exact changes to fix all 24 findings.

---

## Glossary

| Term | Definition |
|------|-----------|
| **DatafnLogger** | The `DatafnLogger` interface (imported from `../../logger.js` or `../logger.js`), providing `.error()`, `.warn()`, `.info()` methods |
| **Silent swallow** | A `catch` block that discards the error object without logging or re-throwing |
| **Logger propagation** | Passing a `logger` instance from a route handler through to execution functions |
| **Generic error message** | Returning `{ code: "INTERNAL", message: "Internal error" }` to the client instead of the actual error details |
| **RETURN-ZERO** | A catch block that returns a numeric `0` to the caller, making DB errors indistinguishable from "no data" |
| **CAS retry** | Compare-and-swap retry loop used by sequence stores and change tracking |

---

## Goals

1. **Every catch block in the datafn server MUST either log the error or have an explicit, documented reason for not logging** (e.g., expected duplicate key on idempotency replay).
2. **Every execution function that performs database operations MUST accept a `logger` parameter.**
3. **Every route handler MUST pass its `logger` to all child execution functions.**
4. **Functions that return sentinel values (0) on error MUST propagate errors instead**, so callers can distinguish "no data" from "database failure."
5. **No behavioral changes to the happy path.** All fixes are limited to error/logging paths.

## Non-goals

- Changing the generic `"Internal error"` client response to include actual error details (intentional security design — out of scope).
- Adding error correlation IDs to client responses (desirable but separate effort).
- Refactoring the logger interface itself.
- Adding new error codes or changing existing error code semantics.
- Modifying test infrastructure or test harnesses.

---

## Public API

No public API changes. All changes are internal:
- Function signatures gain an optional `logger?: DatafnLogger` parameter where missing.
- Existing callers pass through their `logger` reference.
- No new exports, no changed return types, no new error codes.

---

## Semantics

### Logging Rules

1. Every `catch` block that handles a database or I/O error MUST call `logger?.error(...)` with:
   - A human-readable message describing what failed
   - An object containing `{ error: String(error), operation: "<operation-name>", resource?: "<resource>" }`
2. For "best-effort" operations (idempotency store, heartbeat pings), `logger?.warn(...)` MAY be used instead of `logger?.error(...)`.
3. For expected errors (duplicate key on idempotency replay), the catch block SHOULD distinguish the expected error from unexpected ones by checking `error.code` or `error.message` before deciding to log.
4. CAS retry loops SHOULD log intermediate failures at `warn` level, not just the final failure at `error` level.

### Error Propagation Rules

1. Functions that return numeric values (e.g., sequence numbers) MUST NOT return `0` as a fallback on DB error. They MUST throw the error so callers can handle it.
2. Functions that return data arrays (e.g., `DbDataStore`) MAY continue returning empty arrays on error (fail-soft), but MUST log the error at `warn` level.

### Backward Compatibility

1. All new `logger` parameters MUST be optional (`logger?: DatafnLogger`).
2. All existing function signatures MUST remain backward-compatible — new parameters are appended and optional.
3. No existing tests should break. The only test changes should be new tests validating logging behavior.

---

## Invariants

- **INV-01**: No catch block in `datafn/server/src/` shall discard an error without logging, unless the caught error is an explicitly expected condition (documented in a comment).
- **INV-02**: Every execution function that performs DB operations accepts `logger?: DatafnLogger`.
- **INV-03**: Every route handler passes `logger` to all execution function calls.
- **INV-04**: Functions returning numeric sentinel values on error propagate the error instead.

---

## Security

- Error messages logged server-side MAY include the full error string via `String(error)`.
- Error messages returned to clients MUST NOT include internal error details (existing behavior, unchanged).
- The `logger?.error(...)` calls MUST NOT log mutation record data (PII/privacy concern per SRV-004).

---

## Observability

After these fixes:
- All database operation failures will be visible in server logs.
- All route handler errors will be logged before returning generic responses.
- CAS retry loops will log intermediate failures at warn level.
- Idempotency store will distinguish and log unexpected errors.

---

## Compatibility / Versioning

- No version bump required. All changes are internal.
- No breaking changes to any public API.

---

## Undefined / Explicitly Deferred

- Error correlation IDs for client responses — separate effort, not in scope.
- Structured error objects (replacing `String(error)` with proper error serialization) — desirable but not required by this spec.
