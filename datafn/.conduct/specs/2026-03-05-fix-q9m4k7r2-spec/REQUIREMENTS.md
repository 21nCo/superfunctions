# REQUIREMENTS

## Table of Contents

| ID | Priority | Summary |
|---|---|---|
| ADP-001 | P0 | Adapter update MUST throw not-found on zero matched rows |
| MRG-001 | P0 | Server merge MUST use schema-aware update-then-conditional-create |
| MRG-002 | P0 | Merge-create eligibility MUST enforce required-field completeness |
| MRG-003 | P1 | Merge create-race MUST resolve deterministically with single retry |
| KV-001 | P0 | KV first-write and update MUST persist via merge path |
| OBS-001 | P0 | Push/mutation success accounting MUST reflect real persistence |
| ERR-001 | P1 | Merge failure paths MUST map to deterministic error codes |
| TST-001 | P0 | SQL-backed regression tests MUST cover merge/KV persistence cases |

---

## ADP-001

- **ID**: ADP-001
- **Priority**: P0
- **Statement**: `Adapter.update()` MUST throw a not-found error when zero rows match the `where` clause.
- **Rationale**: Server merge correctness depends on reliable missing-row detection; undefined/empty return causes false success.
- **Acceptance criteria**:
  - Drizzle adapter throws `NotFoundError` (or equivalent with `name === "NotFoundError"`) on zero-row update.
  - Row-level namespace wrapper preserves the thrown not-found behavior.
  - Existing successful update behavior is unchanged.
- **Test vectors**: TV-ADP-001, TV-ADP-002
- **Notes**: This requirement is adapter-contract hardening and should be validated with SQL-backed tests.

---

## MRG-001

- **ID**: MRG-001
- **Priority**: P0
- **Statement**: Server merge execution in both `/datafn/mutation` and `/datafn/push` MUST perform update-first and conditionally create only when merge-create eligibility passes.
- **Rationale**: This restores KV first-write while preserving partial-merge safety for resources like todos.
- **Acceptance criteria**:
  - Both execution paths share the same merge decision logic (no divergent semantics).
  - Existing-row merge updates only provided fields.
  - Missing-row merge returns `NOT_FOUND` unless eligibility allows create.
- **Test vectors**: TV-MRG-001, TV-MRG-002
- **Notes**: Implement with a shared helper to avoid drift between push and mutation paths.

---

## MRG-002

- **ID**: MRG-002
- **Priority**: P0
- **Statement**: Merge-create eligibility MUST require all schema-required fields (excluding `id` and namespace column) to be satisfiable by delta/defaults before create is attempted.
- **Rationale**: Prevents reintroducing NOT NULL/required-field regressions when merge is used with partial payloads.
- **Acceptance criteria**:
  - For resources like `todos` with required `text`, merge delta lacking `text` does not create and returns `NOT_FOUND`.
  - For resource `kv` where only `id` is required, merge delta `{ value }` is eligible for create.
  - Eligibility evaluation is deterministic and unit-tested.
- **Test vectors**: TV-MRG-003, TV-MRG-004
- **Notes**: Eligibility must be based on schema metadata, not adapter-specific SQL introspection.

---

## MRG-003

- **ID**: MRG-003
- **Priority**: P1
- **Statement**: If create-after-missing-update races with a concurrent insert, merge execution MUST retry update once and then resolve deterministically.
- **Rationale**: Avoids flaky conflict errors under concurrent writes while keeping bounded behavior.
- **Acceptance criteria**:
  - Create conflict triggers exactly one update retry.
  - Retry success returns success.
  - Retry failure yields deterministic error (`NOT_FOUND` or `INTERNAL`) without loop.
- **Test vectors**: TV-MRG-005, TV-MRG-006
- **Notes**: Retry handling must not duplicate change-tracking entries.

---

## KV-001

- **ID**: KV-001
- **Priority**: P0
- **Statement**: `kv.set()` and `kv.merge()` MUST persist first-write and subsequent updates in namespaced storage when server sync is enabled.
- **Rationale**: Theme/preferences must be durable and visible to clone/pull across clients.
- **Acceptance criteria**:
  - First `kv.set("pref:theme", "light")` creates `kv:pref:theme` row for namespace.
  - Subsequent set updates value for same namespace.
  - `kv.merge()` preserves existing object-merge semantics and persists.
- **Test vectors**: TV-KV-001, TV-KV-002
- **Notes**: This requirement is route-agnostic; behavior must hold for push and mutation execution paths used by client modes.

---

## OBS-001

- **ID**: OBS-001
- **Priority**: P0
- **Statement**: Push/mutation success accounting MUST include a mutation in `applied` and change tracking only when a write is actually persisted.
- **Rationale**: False success corrupts sync consistency and hides data loss.
- **Acceptance criteria**:
  - Non-applied merges are absent from `applied` and produce an error entry.
  - No change-tracking record is written for non-applied merge.
  - Applied merges produce exactly one change-tracking record.
- **Test vectors**: TV-OBS-001, TV-OBS-002
- **Notes**: Validate both `applied` list and `__datafn_changes` side effects.

---

## ERR-001

- **ID**: ERR-001
- **Priority**: P1
- **Statement**: Merge failure outcomes MUST map deterministically to `NOT_FOUND`, `DFQL_INVALID`, or `INTERNAL` with stable `path` values.
- **Rationale**: Clients need predictable behavior for retries and UI handling.
- **Acceptance criteria**:
  - Missing-row + ineligible create returns `NOT_FOUND` at `path: "id"`.
  - Invalid merge payload shape returns `DFQL_INVALID` at field-specific path.
  - Unexpected adapter/database errors return `INTERNAL` at `path: "$"`.
- **Test vectors**: TV-ERR-001, TV-ERR-002
- **Notes**: Preserve existing security posture (generic internal message).

---

## TST-001

- **ID**: TST-001
- **Priority**: P0
- **Statement**: The fix MUST include SQL-backed regression tests that fail on old behavior and pass on new behavior for merge missing-row and KV first-write paths.
- **Rationale**: Memory adapter behavior masked this regression; SQL parity is mandatory.
- **Acceptance criteria**:
  - At least one drizzle-backed test covers zero-row update not-found behavior.
  - At least one server-level SQL-backed test covers first-time `kv.set` persistence.
  - CI/local test command includes these new files.
- **Test vectors**: TV-TST-001, TV-TST-002
- **Notes**: SQLite drizzle in-memory is acceptable for deterministic local execution.
