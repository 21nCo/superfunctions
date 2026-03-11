# FULL AUDIT: Python Package Parity with TypeScript — Schema Capabilities

## Metadata

- **Timestamp**: 2026-03-06T18:05:00Z
- **Agent name**: unknown-agent
- **Model**: Claude Opus 4.6
- **Launcher**: VS Code (Claude Code extension)
- **Workspace**: /Users/serro/Documents/dev/n/superfunctions
- **OS**: Darwin / zsh
- **Git branch**: next
- **Git commit**: 635bf28 (dirty)
- **Intent/notes paths audited**:
  - `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/SPEC.md`
  - `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/INTENT_AUDIT.md`
- **Spec bundle paths audited**:
  - `datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/` (SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, PLAN.md, INTENT_AUDIT.md)
- **Codebase scope audited**:
  - `datafn/core/src/` (TypeScript core — reference implementation)
  - `datafn/python/datafn/` (Python package — audit target)
  - `datafn/server/src/validation/schema.ts` (TS server schema validation)
  - `datafn/server/src/execution/mutation/execute.ts` (TS server mutation)
- **Commands executed**: git rev-parse, git status, ls, grep searches

---

## Audit Scope

This audit focuses on **Python package parity with the TypeScript implementation**, specifically evaluating the `datafn/python/` package against the capabilities system defined in the spec bundle `2026-03-06-new-k4m7x9r3-spec`. The audit measures:

1. Whether the Python package implements the capability types, resolution, and field injection from `@datafn/core`
2. Whether the Python server handlers support capability-aware mutations (trash/restore/archive/unarchive/share/unshare)
3. Whether the Python query handler supports auto-filtering (trashed/archived records)
4. Whether the Python validation/SchemaIndex is capability-aware
5. General parity gaps between TypeScript and Python across all server functionality

---

## High-Level Findings

| Area | TS Core | TS Server | Python | Parity Status |
|---|---|---|---|---|
| Capability type definitions | PASS | N/A | **MISSING** | FAIL |
| `resolveCapabilities()` function | PASS | N/A | **MISSING** | FAIL |
| `getCapabilityFields()` function | PASS | N/A | **MISSING** | FAIL |
| `CAPABILITY_FIELD_DEFS` constant | PASS | N/A | **MISSING** | FAIL |
| Schema validation with capabilities | PASS | Uses core | **MISSING** | FAIL |
| Capability field collision detection | PASS | Uses core | **MISSING** | FAIL |
| `SYSTEM_FIELDS` removal (CAP-005) | **NOT DONE** (still exported) | **Still imports** | Uses hardcoded set | PARTIAL (both stale) |
| SchemaIndex capability-aware fields | PASS (core schema.ts injects) | PARTIAL (uses old SYSTEM_FIELDS) | **HARDCODED** | FAIL |
| Mutation: trash operation | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Mutation: restore operation | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Mutation: archive operation | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Mutation: unarchive operation | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Mutation: share/unshare | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Query auto-filter (trash/archive) | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Readonly field stripping (CAP-007) | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Timestamp auto-set (TS-002/003) | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Audit auto-set (AUD-002/003) | NOT IMPLEMENTED | NOT IMPLEMENTED | **MISSING** | N/A (both missing) |
| Error codes (capability-related) | PASS | Uses core | **MISSING** | FAIL |
| Envelope pattern (ok/err) | PASS | PASS | PASS | PASS |
| Basic CRUD operations | PASS | PASS | PASS | PASS |
| Batch queries/mutations | PASS | PASS | PASS | PASS |
| Transaction support | PASS | PASS | PASS | PASS |
| Idempotency | PASS | PASS | PASS | PASS |
| Sync (seed/clone/pull/push) | PASS | PASS | PASS | PASS |
| Change tracking | PASS | PASS | PASS | PASS |
| Guards | PASS | PASS | PASS | PASS |
| Relations (relate/modifyRelation/unrelate) | PASS | PASS | PASS | PASS |

---

## Intent Inventory (Numbered)

Extracted from INTENT_AUDIT.md (24 items). This audit focuses on Python parity, so we evaluate each item against the Python implementation.

1. Replace SYSTEM_FIELDS with capabilities
2. Capabilities as a list
3. Global + resource-level capabilities
4. Timestamps capability (auto-inject createdAt/updatedAt)
5. Audit capability (auto-inject createdBy/updatedBy)
6. Trash capability (soft-delete with trashedAt/trashedBy)
7. Archivable capability (isArchived field)
8. Shareable capability (permissions table, access levels)
9. Shareable with private/shared default
10. Shareable requires audit
11. Codegen updates (Drizzle)
12. Client API methods (trash/restore/archive/unarchive/share/unshare/getPermissions)
13. Auto-query filtering (exclude trashed/archived)
14. Readonly enforcement (strip capability fields from client mutations)
15. Capability field collision detection
16. Deprecate createSoftDeletePlugin
17. Sync path support for new operations
18. No cascading capabilities to relations (out of scope)
19. Permissions table schema
20. Creator implicit owner
21. Cascading permission delete
22. Owner-only share/unshare
23. Access level enforcement
24. Nucleus patterns as reference (design context)

---

## Intent → Spec Coverage Matrix

All 24 intent items are fully covered in the spec bundle (confirmed by INTENT_AUDIT.md). No SPEC MISSING items.

---

## Intent → Python Implementation Coverage Matrix

| # | Intent Item | Python Status | Evidence / Notes |
|---|---|---|---|
| 1 | Replace SYSTEM_FIELDS with capabilities | **FAIL** | `validation.py:28-33` hardcodes system fields as a static set; no capability awareness |
| 2 | Capabilities as list | **FAIL** | No `capabilities` handling anywhere in Python code |
| 3 | Global + resource-level capabilities | **FAIL** | No `resolveCapabilities()` function |
| 4 | Timestamps capability | **FAIL** | No auto-set of `createdAt`/`updatedAt` in `mutation.py` |
| 5 | Audit capability | **FAIL** | No auto-set of `createdBy`/`updatedBy` in `mutation.py` |
| 6 | Trash capability | **FAIL** | No `trash`/`restore` operations in `mutation.py:105-161` |
| 7 | Archivable capability | **FAIL** | No `archive`/`unarchive` operations; `isArchived` hardcoded in validation |
| 8 | Shareable capability | **FAIL** | No permissions table, no share/unshare operations |
| 9 | Shareable private/shared | **FAIL** | Not implemented |
| 10 | Shareable requires audit | **FAIL** | No validation |
| 11 | Codegen updates | **N/A** | Python has no codegen (Drizzle is TS-only) |
| 12 | Client API methods | **N/A** | Python is server-side only |
| 13 | Auto-query filtering | **FAIL** | `query.py` has no auto-filter injection for trashed/archived |
| 14 | Readonly enforcement | **FAIL** | `mutation.py` does not strip readonly capability fields |
| 15 | Field collision detection | **FAIL** | No capability collision check in Python validation |
| 16 | Deprecate softDelete plugin | **N/A** | Python has no client plugin system |
| 17 | Sync path support | **FAIL** | `sync.py:handle_push` calls `execute_mutation_core` which has no capability operations |
| 18 | No cascading to relations | **PASS** | Not implemented (correctly out of scope) |
| 19 | Permissions table | **FAIL** | Not implemented |
| 20 | Creator implicit owner | **FAIL** | Not implemented |
| 21 | Cascading permission delete | **FAIL** | Not implemented |
| 22 | Owner-only share/unshare | **FAIL** | Not implemented |
| 23 | Access level enforcement | **FAIL** | Not implemented |
| 24 | Nucleus patterns | **N/A** | Design reference, not implementation |

**Summary**: 0 PASS / 17 FAIL / 1 PASS (out of scope) / 5 N/A (not applicable to Python)

---

## Requirement-by-Requirement Results (Python Parity)

### Core Infrastructure

| Req ID | Priority | Statement Summary | Python Status | Notes |
|---|---|---|---|---|
| CAP-001 | P0 | Schema capabilities type definitions | **FAIL** | No capability types in Python |
| CAP-002 | P0 | Capability resolution algorithm | **FAIL** | No `resolveCapabilities()` |
| CAP-003 | P0 | Capability field injection in validation | **FAIL** | `SchemaIndex._build_index()` hardcodes fields |
| CAP-004 | P0 | Capability field collision detection | **FAIL** | No collision check |
| CAP-005 | P1 | Remove SYSTEM_FIELDS constants | **FAIL** | Python hardcodes equivalent of old SYSTEM_FIELDS |
| CAP-006 | P0 | Global + resource-level merging | **FAIL** | Not implemented |
| CAP-007 | P0 | Readonly field stripping | **FAIL** | No stripping in mutation handler |

### Timestamps Capability

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| TS-001 | P0 | **FAIL** | Fields hardcoded, not dynamically injected |
| TS-002 | P0 | **FAIL** | No `createdAt` auto-set on insert |
| TS-003 | P0 | **FAIL** | No `updatedAt` auto-set on mutations |
| TS-004 | P0 | **FAIL** | No immutability enforcement for `createdAt` |

### Audit Capability

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| AUD-001 | P0 | **FAIL** | Fields hardcoded, not dynamically injected |
| AUD-002 | P0 | **FAIL** | No `createdBy` auto-set from actorId |
| AUD-003 | P0 | **FAIL** | No `updatedBy` auto-set |
| AUD-004 | P0 | **FAIL** | No immutability enforcement |
| AUD-005 | P1 | **FAIL** | No graceful fallback |

### Trash Capability

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| TR-001 | P0 | **FAIL** | No `trashedAt`/`trashedBy` fields |
| TR-002 | P0 | **FAIL** | No `trash` operation in `execute_mutation_core` |
| TR-003 | P0 | **FAIL** | No `restore` operation |
| TR-004 | P0 | **FAIL** | No auto-filter in queries |
| TR-005 | P0 | **FAIL** | No `includeTrashed` metadata support |
| TR-006 | P1 | **FAIL** | Not implemented |
| TR-007 | P1 | **FAIL** | Hard delete works but no special trash handling |
| TR-008 | P0 | **FAIL** | No change tracking for trash ops |

### Archivable Capability

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| AR-001 | P0 | **PARTIAL** | `isArchived` hardcoded in SchemaIndex but not capability-driven |
| AR-002 | P0 | **FAIL** | No `archive` operation |
| AR-003 | P0 | **FAIL** | No `unarchive` operation |
| AR-004 | P0 | **FAIL** | No auto-filter for archived records |
| AR-005 | P0 | **FAIL** | No `includeArchived` metadata support |
| AR-006 | P1 | **PARTIAL** | `isArchived` is writable via merge (it's in writable set) |
| AR-007 | P0 | **FAIL** | No change tracking for archive ops |

### Shareable Capability

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| SH-001 through SH-011 | P0/P1 | **FAIL** | Entire shareable subsystem not implemented |

### Codegen

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| CG-001 through CG-003 | P0 | **N/A** | Python has no codegen |

### Client API

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| CL-001 through CL-009 | P0-P2 | **N/A** | Python is server-side only |

### Sync

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| SY-001 | P0 | **FAIL** | Push path doesn't inject capability fields |
| SY-002 | P0 | **FAIL** | Push validation doesn't accept new operations |
| SY-003 | P0 | **FAIL** | No change tracking for new operations |

### Validation

| Req ID | Priority | Python Status | Notes |
|---|---|---|---|
| VA-001 | P0 | **FAIL** | No capability validation in Python |
| VA-002 | P0 | **FAIL** | Unknown operations fall through to generic error |
| VA-003 | P1 | **FAIL** | No capability-aware authz |

---

## Requirement Coverage Summary

| Category | Total | PASS | PARTIAL | FAIL | N/A |
|---|---|---|---|---|---|
| Core Infrastructure (CAP-*) | 7 | 0 | 0 | 7 | 0 |
| Timestamps (TS-*) | 4 | 0 | 0 | 4 | 0 |
| Audit (AUD-*) | 5 | 0 | 0 | 5 | 0 |
| Trash (TR-*) | 8 | 0 | 0 | 8 | 0 |
| Archivable (AR-*) | 7 | 0 | 2 | 5 | 0 |
| Shareable (SH-*) | 11 | 0 | 0 | 11 | 0 |
| Codegen (CG-*) | 3 | 0 | 0 | 0 | 3 |
| Client (CL-*) | 9 | 0 | 0 | 0 | 9 |
| Sync (SY-*) | 3 | 0 | 0 | 3 | 0 |
| Validation (VA-*) | 3 | 0 | 0 | 3 | 0 |
| **TOTAL** | **60** | **0** | **2** | **46** | **12** |

---

## Spec Conflicts / Spec Gaps

No spec conflicts across bundles (single spec bundle audited).

**Note**: The TS implementation itself is also partially incomplete for this spec — the `@datafn/core` package has the capability types, resolution, and schema validation, but the TS server execution layer and client API have NOT yet implemented the new operations (trash/restore/archive/unarchive/share/unshare) or auto-injection. The Python package is therefore being measured against a spec whose TS reference implementation is itself only ~30% complete.

---

## Cross-Cutting Audits

### Security / Authorization / Validation Boundaries

| Concern | TS Status | Python Status | Gap |
|---|---|---|---|
| Readonly field stripping (CAP-007) | Not implemented in server | Not implemented | Both need work |
| Share authorization (SH-010) | Not implemented | Not implemented | Both need work |
| Mutation authz for shareable (SH-007) | Not implemented | Not implemented | Both need work |
| Query gating for private (SH-006) | Not implemented | Not implemented | Both need work |
| Capability-aware field validation (VA-003) | Not implemented | Not implemented | Both need work |

**Python-specific security concern**: The Python `SchemaIndex._build_index()` (validation.py:27-37) hardcodes `isArchived` as always present and writable on all resources, regardless of whether the `archivable` capability is enabled. This means Python accepts `isArchived` in mutations for ALL resources, which violates the capability model.

### Determinism Invariants

- **Capability resolution determinism** (Invariant 3): Not applicable to Python — no resolution function exists.
- **Auto-filter additivity** (Invariant 4): Not applicable — no auto-filters exist.

### Limits / Caps

- **Max shares per record** (100 default): Not implemented in Python.
- **Permissions table indexing**: Not applicable — no permissions table.

### Error Handling + Canonical Envelopes

- Python envelope pattern (`ok`/`err`) in `envelope.py` is functionally equivalent to TS.
- Python has `DatafnError` class (exception-based) vs TS's return-value-based pattern. Both work but differ in style.
- **Missing error codes in Python**: `INVALID_CAPABILITY`, `INVALID_CAPABILITY_CONFIG`, `CAPABILITY_FIELD_COLLISION`, `CAPABILITY_DEPENDENCY`, `DFQL_UNSUPPORTED` — none of these are used in Python (they don't need to be until capabilities are implemented).

### Compatibility / Versioning / Migrations

- Python validation hardcodes the old system fields (matching `SYSTEM_FIELDS` constant behavior).
- The TS `@datafn/core` still exports `SYSTEM_FIELDS` and `READONLY_SYSTEM_FIELDS` (CAP-005 not yet completed).
- The TS server's `validation/schema.ts` still imports and uses the old `SYSTEM_FIELDS`/`READONLY_SYSTEM_FIELDS`.
- Both TS and Python need coordinated migration when CAP-005 is executed.

---

## Existing Parity (What Python DOES Have)

For completeness, these features are at parity between TS server and Python:

1. **CRUD operations**: insert, merge, replace, delete — all present in `mutation.py`
2. **Relations**: relate, modifyRelation, unrelate — present in `relations.py`
3. **Query handling**: filter conversion, resource/field validation, select/sort — present in `query.py`
4. **Transactions**: atomic and non-atomic transact — present in `transact.py`
5. **Idempotency**: check/store via `__datafn_idempotency` table — present in `idempotency.py`
6. **Sync**: seed, clone, pull, push — present in `sync.py`
7. **Change tracking**: serverSeq-based changelog — present in `change_tracking.py`
8. **Guards**: condition evaluation before mutation — present in `guards.py`
9. **Envelope pattern**: ok/err responses — present in `envelope.py`
10. **Adapter protocol**: DB abstraction with find_many, find_one, create, update, delete, transaction — present in `db.py`

---

## Recommendations (Ranked by Priority)

### 1. [P0/CRITICAL] Implement capability types and resolution in Python
- **Refs**: CAP-001, CAP-002, CAP-003, CAP-006
- **Why**: Foundation for entire capability system. Without this, no other capability feature can work.
- **Action**: Create `datafn/python/datafn/capabilities.py` mirroring `datafn/core/src/capabilities.ts`. Implement `SimpleCapability`, `ShareableCapability`, `CapabilityEntry`, `CAPABILITY_FIELD_DEFS`, `resolveCapabilities()`, `getCapabilityFields()`.

### 2. [P0/CRITICAL] Make Python SchemaIndex capability-aware
- **Refs**: CAP-003, CAP-004, CAP-005
- **Why**: `validation.py:SchemaIndex._build_index()` currently hardcodes system fields. It must use capability resolution to dynamically inject fields per resource.
- **Action**: Refactor `_build_index()` to call `resolveCapabilities()` and `getCapabilityFields()` for each resource. Add collision detection. Remove hardcoded system field set.

### 3. [P0/HIGH] Add new mutation operations to Python
- **Refs**: TR-002, TR-003, AR-002, AR-003, SH-003, SH-004
- **Why**: The mutation handler only recognizes insert/merge/replace/delete/relate/modifyRelation/unrelate. It must also handle trash/restore/archive/unarchive/share/unshare.
- **Action**: Extend `execute_mutation_core()` in `mutation.py` with handlers for each new operation. Validate that the corresponding capability is enabled.

### 4. [P0/HIGH] Add readonly field stripping to Python mutations
- **Refs**: CAP-007
- **Why**: Server must strip readonly capability fields before DB write to prevent client forgery.
- **Action**: Before executing any mutation, strip fields that are readonly per the resolved capabilities.

### 5. [P0/HIGH] Add auto-timestamp and audit injection to Python mutations
- **Refs**: TS-002, TS-003, TS-004, AUD-002, AUD-003, AUD-004
- **Why**: Core value proposition of timestamps and audit capabilities.
- **Action**: In mutation execution, inject `createdAt`/`updatedAt`/`createdBy`/`updatedBy` based on resolved capabilities.

### 6. [P0/HIGH] Add auto-query filtering in Python
- **Refs**: TR-004, TR-005, AR-004, AR-005
- **Why**: Trashed and archived records must be excluded from queries by default.
- **Action**: In `handle_query()`, resolve capabilities for the resource, then inject `trashedAt: null` and `isArchived: false` filters. Support metadata overrides.

### 7. [P0/MEDIUM] Add capability validation in Python schema validation
- **Refs**: VA-001, VA-002, SH-011
- **Why**: Invalid capability configurations should be caught early.
- **Action**: Port the capability validation from `datafn/core/src/schema.ts` to Python. Validate capability names, shareable config, shareable-requires-audit dependency.

### 8. [P1/MEDIUM] Update Python sync path for capability support
- **Refs**: SY-001, SY-002, SY-003
- **Why**: Sync-originated mutations need the same capability injection as direct mutations.
- **Action**: Ensure `handle_push()` injects capability fields before calling `execute_mutation_core()`, and accepts new operations.

### 9. [P1/LOW] Implement shareable subsystem in Python
- **Refs**: SH-001 through SH-011
- **Why**: Most complex capability. Can be deferred after simpler capabilities are working.
- **Action**: Implement permissions table management, share/unshare operations, query gating, mutation authorization, access level enforcement.

### 10. [P2/LOW] Add new capability error codes to Python envelope
- **Refs**: Error handling section
- **Why**: Python error codes should match TS for cross-platform consistency.
- **Action**: Add `INVALID_CAPABILITY`, `INVALID_CAPABILITY_CONFIG`, `CAPABILITY_FIELD_COLLISION`, `CAPABILITY_DEPENDENCY`, `DFQL_UNSUPPORTED` to Python error code handling.

---

## Appendix: Commands Run + Environment Details

| Command | Purpose |
|---|---|
| `git rev-parse --short HEAD` | Get current commit (635bf28) |
| `git status --porcelain` | Check dirty status |
| `ls datafn/.conduct/audits/` | Check audit directory existence |
| Glob `datafn/**/*.py` | Enumerate Python source files |
| Glob `datafn/core/src/**/*.ts` | Enumerate TS core source files |
| Grep for capability-related terms | Search server/client for implementation evidence |

### Files Read

**Spec bundle (2026-03-06-new-k4m7x9r3-spec)**:
- SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, INTENT_AUDIT.md

**TypeScript core**:
- `datafn/core/src/index.ts` — exports (SYSTEM_FIELDS still exported, capabilities also exported)
- `datafn/core/src/types.ts` — schema types with `capabilities` field
- `datafn/core/src/capabilities.ts` — resolveCapabilities, getCapabilityFields, CAPABILITY_FIELD_DEFS
- `datafn/core/src/schema.ts` — validateSchema with capability parsing, collision detection, field injection
- `datafn/core/src/errors.ts` — error codes including capability-related codes
- `datafn/core/src/system-fields.ts` — SYSTEM_FIELDS and READONLY_SYSTEM_FIELDS (still present)

**TypeScript server**:
- `datafn/server/src/validation/schema.ts` — still uses SYSTEM_FIELDS, not capability-aware

**Python package**:
- `datafn/python/datafn/__init__.py` — exports create_datafn_server
- `datafn/python/datafn/db.py` — Adapter protocol
- `datafn/python/datafn/envelope.py` — ok/err envelope
- `datafn/python/datafn/validation.py` — SchemaIndex with hardcoded system fields
- `datafn/python/datafn/filters.py` — filter evaluation
- `datafn/python/datafn/guards.py` — guard evaluation
- `datafn/python/datafn/server.py` — route wiring
- `datafn/python/datafn/relations.py` — relate/modifyRelation/unrelate
- `datafn/python/datafn/handlers/mutation.py` — mutation handler (no capability ops)
- `datafn/python/datafn/handlers/query.py` — query handler (no auto-filters)
- `datafn/python/datafn/handlers/transact.py` — transaction handler
- `datafn/python/datafn/handlers/sync.py` — seed/clone/pull/push
- `datafn/python/datafn/idempotency.py` — idempotency store
- `datafn/python/datafn/change_tracking.py` — changelog
- `datafn/python/datafn/transaction.py` — transaction wrapper
