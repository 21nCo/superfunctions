# Audit Report: Delete, Soft Delete & System Fields — Intent Drift Timeline

## Metadata

- **Timestamp**: 2026-03-06T12:00:00Z
- **Scope**: `datafn/` — core, server, client, packages/db, .conduct history
- **Method**: Read-only — no edits made
- **Branch**: `next`
- **Trigger**: Manual investigation into how delete semantics and system fields evolved from original intent to current implementation

---

## Purpose

This audit traces the chronological evolution of three interrelated features — delete operations, soft delete, and system fields — from the original spec through all subsequent audits, issues, and specs. It documents where the implementation diverged from original intent and identifies residual inconsistencies.

---

## Timeline

### Phase 1: Original Spec (Jan 18, 2026)

**Source**: `datafn/.conduct/specs/2026-01-18-spec/SPEC.md` (lines 627-639)

The original spec defined **7 system fields** with a **soft-delete-first design**:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | string | Primary key |
| `createdAt` | timestamp | Audit — server-managed |
| `updatedAt` | timestamp | Audit — server-managed |
| `createdBy` | string | Audit — server-managed |
| `updatedBy` | string | Audit — server-managed |
| `isArchived` | boolean | Soft delete flag — client-writable |
| `trashInformation` | object | Rich archival metadata (who, when, why) |

**Original intent**: Delete meant soft-delete by default. Records would be marked `isArchived: true` with `trashInformation` holding context about the archival. Hard delete was not the primary path.

---

### Phase 2: First Audit Identifies Mismatch (Jan 24, 2026)

**Source**: `datafn/.conduct/audits/audit-full-2026-01-24-unknown-agent.md` (line 149)

The first full audit found the implementation did not match the spec's soft-delete design. The original 7 system fields including `trashInformation` were referenced but not fully implemented.

**Source**: `datafn/.conduct/specs/2026-01-24-audit-fix-comprehensive-spec/SPEC.md` (line 533)

The audit-fix spec attempted to align the implementation: "delete = soft by default with `isArchived` + `trashInformation`." PHASE_04 of this spec covered system field preservation during mutations.

**Outcome**: What actually got built was **hard delete**. The `trashInformation` field was never implemented. `isArchived` survived as a system field but was disconnected from any delete operation.

---

### Phase 3: Gap Analysis Confirms Missing Soft Delete (Feb 7, 2026)

**Source**: `datafn/.conduct/audits/2026-02-07-flux-datafn-comprehensive-gap-analysis.md` (lines 258-277, 670)

**GAP-13: "No Soft-Delete"** explicitly called out:
- Delete operations perform hard deletes only
- No soft-delete mechanism exists in the codebase
- `isArchived` exists as a system field but is not wired to any behavior
- Recommendation: implement soft delete as an optional plugin rather than a baked-in primitive

This was the formal acknowledgment that the original intent had not been realized.

---

### Phase 4: Authz Audit — System Fields Hardcoded (Feb 9, 2026)

**Source**: `datafn/.conduct/audits/2026-02-09-x7m3k9p2-full-audit.md` (line 290)

Found the authorization layer had a **hardcoded always-allowed field list** for system fields. This meant authz rules could not restrict writes to system fields — a security concern.

---

### Phase 5: Soft Delete Plugin Implemented (Feb 11, 2026)

**Source**: `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec/SPEC.md` (lines 59, 370-376)
**Source**: `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec/REQUIREMENTS.md` (lines 362-373, requirement SD-001)
**Source**: `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec/phases/PHASE_14.md`
**Source**: `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec/phase-reports/PHASE_14-2026-02-11-sd9m7x4p-report.md`

This was the **architectural pivot**: soft delete was formalized as an optional client-side plugin, not a core primitive. Key design choices:

- Plugin uses `isDeleted` / `deletedAt` fields (NOT the original `isArchived` / `trashInformation`)
- `beforeMutation` hook converts delete operations to merge operations setting `{ isDeleted: true, deletedAt: <timestamp> }`
- `beforeQuery` hook auto-filters soft-deleted records with `{ isDeleted: { $ne: true } }`
- `restore()` utility function merges `{ isDeleted: false, deletedAt: null }`
- Implemented in `datafn/client/src/plugins/softDelete.ts`

**Key divergence**: The plugin chose entirely new field names rather than using the existing `isArchived` system field, further orphaning it.

---

### Phase 6: Date Fix Impacts Soft Delete (Feb 17, 2026)

**Source**: `datafn/.conduct/issue-completions/2026-02-17-k8m3x7p4-completion.md` (lines 84-85)

A date handling fix impacted the soft-delete plugin's `deletedAt` timestamp field. Minor but confirms the plugin was in active use.

---

### Phase 7: System Fields Centralized (Feb 24, 2026)

**Source**: `datafn/.conduct/audits/2026-02-24-code-duplication-reusability-audit.md` (DUP-004, lines 84-92)
**Source**: `datafn/.conduct/specs/2026-02-24-fix-k7m4x9p2-spec/SPEC.md`
**Source**: `datafn/.conduct/specs/2026-02-24-fix-k7m4x9p2-spec/REQUIREMENTS.md` (SYS-001, SYS-002)
**Source**: `datafn/.conduct/specs/2026-02-24-fix-k7m4x9p2-spec/phase-reports/PHASE_00-2026-02-24-m4r7k9x2-report.md`

DUP-004 flagged system field definitions duplicated across server validation, client, codegen, and other modules. The fix created `datafn/core/src/system-fields.ts` as a single source of truth.

Requirements:
- **SYS-001**: Single canonical set of system field names
- **SYS-002**: Separate `READONLY_SYSTEM_FIELDS` subset

Result — **6 system fields** (down from original 7, `trashInformation` dropped):

| Set | Fields |
|-----|--------|
| `SYSTEM_FIELDS` (6) | `id`, `createdAt`, `updatedAt`, `createdBy`, `updatedBy`, `isArchived` |
| `READONLY_SYSTEM_FIELDS` (4) | `createdAt`, `updatedAt`, `createdBy`, `updatedBy` |

`isArchived` was intentionally kept writable (not in the readonly set), preserving the possibility of client-side soft-delete via this field — even though the official soft-delete plugin uses `isDeleted` instead.

---

### Phase 8: Authz Bypass Fix (Feb 26, 2026)

**Source**: `datafn/.conduct/audits/2026-02-26-289dbdab-full-audit.md` (NEW-6, lines 195-210)
**Source**: `datafn/.conduct/issue-completions/2026-02-26-k7m9x4r2-completion.md` (line 60)

The hardcoded system fields in authz (identified in Phase 4) could be exploited to bypass field-level authorization. Fixed.

---

### Phase 9: Python SDK System Fields Deduplication (Feb 25-26, 2026)

**Source**: `datafn/.conduct/audits/2026-02-25-u1cbc83f-duplication-audit.md` (line 161)
**Source**: `datafn/.conduct/audits/2026-02-26-9eab36d4-duplication-audit.md` (DUP-14, lines 273-282)
**Source**: `datafn/.conduct/issue-completions/2026-02-26-9eab36d4-completion.md` (line 46)

Python SDK had its own copy of system field definitions. Fixed to import from the centralized `core/src/system-fields.ts`.

---

### Phase 10: Low-Priority System Field Cleanup (Feb 27-28, 2026)

**Source**: `datafn/.conduct/audits/2026-02-26-x3cjj10g-full-audit.md`
**Source**: `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/phases/PHASE_12.md`
**Source**: `datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/phase-reports/PHASE_12-2026-02-28-w7k4m9x2-report.md`

LOW items identified:
- **L-E09**: `isArchived` filter pushdown to SQL not implemented (queries filtering on `isArchived` go through app-level filtering, not SQL WHERE)
- **L-C04**: `isArchived` undocumented in client docs
- **L-C08**: `getTimestamp` helper not centralized

PHASE_12 addressed some of these items.

---

### Phase 11: Documentation Restructuring (Mar 2, 2026)

**Source**: `datafn/.conduct/specs/2026-03-02-change-k9m4x7r3-spec/SPEC.md` (lines 40, 369-400)

The standalone `concepts/system-fields` documentation page was deleted. Content was absorbed into the DFQL schema docs section. `isArchived` documentation was moved into the DFQL sidebar.

---

## Current State (Mar 6, 2026)

### Delete Operations

| Aspect | Status |
|--------|--------|
| Default delete | Hard delete — physical row removal |
| Idempotency | Yes — deleting non-existent records succeeds silently |
| Change tracking | Records `op: "delete"` with `record: null` |
| Sync propagation | Both legacy and canonical pull protocols transmit deletes |
| Offline support | Deletes queued in changelog, synced on reconnect |
| Guard conditions | Supported via `if` clause |

### Soft Delete Plugin

| Aspect | Status |
|--------|--------|
| Location | `datafn/client/src/plugins/softDelete.ts` |
| Architecture | Client-side plugin (not a core primitive) |
| Fields used | `isDeleted` (boolean), `deletedAt` (timestamp) |
| Mechanism | Converts delete mutations to merge operations |
| Query filtering | Auto-injects `{ isDeleted: { $ne: true } }` |
| Restore | `restore()` utility sets `{ isDeleted: false, deletedAt: null }` |

### System Fields

| Field | In `SYSTEM_FIELDS` | In `READONLY_SYSTEM_FIELDS` | Has Built-in Behavior |
|-------|:---:|:---:|:---:|
| `id` | Yes | No | Yes — primary key |
| `createdAt` | Yes | Yes | Yes — server auto-sets on insert |
| `updatedAt` | Yes | Yes | Yes — server auto-sets on mutation |
| `createdBy` | Yes | Yes | Yes — server auto-sets from auth context |
| `updatedBy` | Yes | Yes | Yes — server auto-sets from auth context |
| `isArchived` | Yes | No | **No** — writable but not wired to any behavior |

---

## Findings

### F-01: `isArchived` Is a Vestigial System Field (MEDIUM)

`isArchived` is a relic of the original soft-delete-by-default design (Jan 18 spec) that was never fully implemented. It occupies a system field slot, is reserved across all resources, but has no built-in behavior. The soft-delete plugin (Feb 11) chose different field names (`isDeleted` / `deletedAt`), leaving `isArchived` orphaned.

**Impact**: Every resource has an `isArchived` field reserved whether or not it's used. Users may be confused by its presence in schemas generated via codegen. It cannot be used as a user-defined field name due to the system field reservation.

**Options**:
1. **Remove** `isArchived` from `SYSTEM_FIELDS` — breaking change, frees the name
2. **Wire it up** — give `isArchived` built-in behavior (e.g., server-side query filtering) and deprecate the plugin's `isDeleted`
3. **Document as convention** — keep it as an optional client-writable flag with no server behavior, document clearly

---

### F-02: `trashInformation` Was Silently Dropped (LOW)

The original spec defined `trashInformation` as a system field to hold rich archival metadata (who archived, when, why). It was never implemented and was silently dropped from the system fields list during centralization (Feb 24). No explicit decision or deprecation notice exists in `.conduct`.

**Impact**: None functional — the field never existed in code. This is a documentation gap: the decision to drop it was implicit.

---

### F-03: Soft Delete Plugin Fields Are Not System Fields (LOW)

The soft-delete plugin uses `isDeleted` and `deletedAt` as field names, but these are **not** reserved as system fields. This means:
- Users could define their own `isDeleted` / `deletedAt` fields that collide with the plugin
- Schema validation does not prevent this collision
- The plugin silently assumes these fields exist and are writable

**Impact**: Potential field name collision if a user defines `isDeleted` in their schema and also uses the soft-delete plugin.

---

### F-04: Two Competing Soft-Delete Field Conventions (LOW)

The codebase has two unrelated soft-delete conventions:
1. System field `isArchived` — reserved, writable, no behavior
2. Plugin fields `isDeleted` / `deletedAt` — not reserved, with behavior

This creates confusion about which to use. A user could reasonably set `isArchived: true` expecting soft-delete behavior and find none.

---

## Intent Drift Summary

| Aspect | Original Intent (Jan 18) | Current Reality (Mar 6) |
|--------|--------------------------|-------------------------|
| Delete semantics | Soft delete by default | Hard delete by default |
| `trashInformation` | Rich archival metadata field | Never implemented, silently dropped |
| `isArchived` | Core soft-delete flag wired to delete ops | Vestigial system field — writable but no behavior |
| Soft delete mechanism | Built-in core primitive | Optional client-side plugin |
| Soft delete fields | `isArchived` + `trashInformation` | `isDeleted` + `deletedAt` (different names) |
| System fields count | 7 | 6 |
| System fields location | Duplicated across files | Centralized in `core/src/system-fields.ts` |
| Readonly distinction | Not distinguished | Split into `SYSTEM_FIELDS` (6) and `READONLY_SYSTEM_FIELDS` (4) |

---

## Source Files Referenced

| File | Relevance |
|------|-----------|
| `datafn/.conduct/specs/2026-01-18-spec/SPEC.md` | Original system fields + delete design |
| `datafn/.conduct/audits/audit-full-2026-01-24-unknown-agent.md` | First audit finding mismatch |
| `datafn/.conduct/specs/2026-01-24-audit-fix-comprehensive-spec/SPEC.md` | Attempted realignment |
| `datafn/.conduct/audits/2026-02-07-flux-datafn-comprehensive-gap-analysis.md` | GAP-13 confirming no soft delete |
| `datafn/.conduct/audits/2026-02-09-x7m3k9p2-full-audit.md` | System fields authz hardcoding |
| `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec/SPEC.md` | Soft delete plugin spec |
| `datafn/.conduct/specs/2026-02-11-audit-fix-r9k4m7x2-spec/phases/PHASE_14.md` | Plugin implementation plan |
| `datafn/.conduct/issue-completions/2026-02-17-k8m3x7p4-completion.md` | Date fix impacting deletedAt |
| `datafn/.conduct/audits/2026-02-24-code-duplication-reusability-audit.md` | DUP-004 system fields duplication |
| `datafn/.conduct/specs/2026-02-24-fix-k7m4x9p2-spec/SPEC.md` | System fields centralization |
| `datafn/.conduct/audits/2026-02-26-289dbdab-full-audit.md` | Authz bypass via system fields |
| `datafn/.conduct/audits/2026-02-26-x3cjj10g-full-audit.md` | isArchived pushdown + docs gaps |
| `datafn/.conduct/specs/2026-03-02-change-k9m4x7r3-spec/SPEC.md` | Docs restructuring |
| `datafn/core/src/system-fields.ts` | Current system fields source of truth |
| `datafn/client/src/plugins/softDelete.ts` | Current soft delete implementation |
