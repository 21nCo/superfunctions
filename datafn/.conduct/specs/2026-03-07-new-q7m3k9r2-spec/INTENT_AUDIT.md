# INTENT AUDIT

## Intent Inventory
1. Join-table capability fields are currently not injected (observed in example app) and require an explicit design response.
2. Ideal behavior should be intentional and explicit, not implicit magic on all join tables.
3. Existing resource-level capability model must remain valid and predictable.
4. Capability support for join tables must be tied to many-many relations (the only join-table relation type).
5. Capability-managed join fields should be server-owned (timestamps/audit) with client writes stripped.
6. Relation mutation operations (`relate`, `modifyRelation`) must inject/update capability fields correctly.
7. Existing `modifyRelation` `NOT_FOUND` semantics must not regress.
8. Sync and direct mutation paths must behave consistently for relation capabilities.
9. Persisted schema (Drizzle) and generated TypeScript types must reflect relation capability fields.
10. Validation must provide deterministic failure behavior for unsupported configs.
11. Security boundaries (actor source of audit fields + namespace isolation) must stay intact.
12. Non-opt-in schemas must remain backward compatible.
13. Observability should make stripping/injection decisions diagnosable without leaking sensitive data.
14. Scope should align with prior capability and relation specs without conflicting with shareable-permissions-table behavior.

## Coverage Mapping

### 1) Join-table capability injection gap needs explicit design
- **SPEC.md coverage**: Overview; Goals / Non-goals; Semantics
- **Requirements**: RCAP-001, JRT-002, JRT-003
- **Test vectors**: TV-RCAP-001, TV-JRT-002, TV-JRT-003

### 2) Explicit opt-in behavior (no implicit magic)
- **SPEC.md coverage**: Overview; Public API; Semantics (Opt-in only)
- **Requirements**: RCAP-001, COMP-001
- **Test vectors**: TV-RCAP-001, TV-COMP-001

### 3) Preserve resource capability model
- **SPEC.md coverage**: Non-goals; Compatibility / versioning strategy
- **Requirements**: COMP-001
- **Test vectors**: TV-COMP-001

### 4) many-many-only scope for relation capabilities
- **SPEC.md coverage**: Goals / Non-goals; Semantics; Undefined section
- **Requirements**: RCAP-002
- **Test vectors**: TV-RCAP-002

### 5) Server-owned readonly relation capability fields
- **SPEC.md coverage**: Data formats / protocol; Semantics; Security; Invariants
- **Requirements**: JRT-001, SEC-001
- **Test vectors**: TV-JRT-001, TV-SEC-001

### 6) Correct relate/modifyRelation injection behavior
- **SPEC.md coverage**: Semantics
- **Requirements**: JRT-002, JRT-003, JRT-004
- **Test vectors**: TV-JRT-002, TV-JRT-003, TV-JRT-004

### 7) Preserve modifyRelation NOT_FOUND semantics
- **SPEC.md coverage**: Semantics
- **Requirements**: JRT-004
- **Test vectors**: TV-JRT-004

### 8) Sync/direct mutation parity
- **SPEC.md coverage**: Semantics (push parity, change-tracking parity)
- **Requirements**: JSY-001, JSY-002
- **Test vectors**: TV-JSY-001, TV-JSY-002

### 9) Codegen/typegen parity with persisted shape
- **SPEC.md coverage**: Public API; Compatibility / versioning strategy
- **Requirements**: JCG-001, JCG-002
- **Test vectors**: TV-JCG-001, TV-JCG-002

### 10) Deterministic validation and failure behavior
- **SPEC.md coverage**: Data formats / protocol (error codes); Invariants
- **Requirements**: RCAP-002, RCAP-003, RCAP-004
- **Test vectors**: TV-RCAP-002, TV-RCAP-003, TV-RCAP-004

### 11) Security boundaries remain intact
- **SPEC.md coverage**: Security; Invariants
- **Requirements**: SEC-001
- **Test vectors**: TV-SEC-001

### 12) Backward compatibility for non-opt-in schemas
- **SPEC.md coverage**: Compatibility / versioning strategy; Invariants
- **Requirements**: COMP-001
- **Test vectors**: TV-COMP-001

### 13) Observability without sensitive leakage
- **SPEC.md coverage**: Observability; Security
- **Requirements**: OBS-001
- **Test vectors**: TV-OBS-001

### 14) No conflict with prior shareable permissions-table model
- **SPEC.md coverage**: Non-goals; Undefined section
- **Requirements**: RCAP-002, COMP-001
- **Test vectors**: TV-RCAP-002, TV-COMP-001

## Audit Result
No missing intent items.
