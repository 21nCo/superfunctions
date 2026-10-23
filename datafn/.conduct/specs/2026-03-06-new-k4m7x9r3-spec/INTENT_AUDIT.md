# INTENT AUDIT

## Intent Inventory

The following intent items are extracted from the conversation and user requirements:

1. **Replace SYSTEM_FIELDS with capabilities**: Remove the static `SYSTEM_FIELDS` / `READONLY_SYSTEM_FIELDS` constants and replace with a dynamic, opt-in capability system
2. **Capabilities as a list**: Capabilities should be declared as a simple list (`["timestamps", "audit", "trash"]`), not a boolean map
3. **Global + resource-level capabilities**: Capabilities declared at schema level apply to all resources; resource-level declarations merge additively or exclude
4. **Timestamps capability**: Auto-inject `createdAt`/`updatedAt`, auto-set on insert/update server-side
5. **Audit capability**: Auto-inject `createdBy`/`updatedBy`, auto-set from auth context server-side
6. **Trash capability (renamed from softDelete)**: First-class trash with `.trash()`, `.restore()`, auto-filter queries, server-managed `trashedAt`/`trashedBy` fields
7. **Archivable capability**: Archive records with `.archive()`, `.unarchive()`, auto-filter queries, `isArchived` field
8. **Shareable capability**: Per-record user-level access control with permissions table, `.share()`, `.unshare()`, access levels (viewer/editor/owner), query gating, mutation authorization
9. **Shareable with private/shared default**: Shareable resources can be private (only visible to creator + shared users) or shared (tenant-wide, permissions for write control)
10. **Shareable requires audit**: Shareable depends on `createdBy` for ownership, so requires audit capability
11. **Codegen updates**: Drizzle codegen must generate columns for capability fields and permissions tables
12. **Client API methods**: `.trash()`, `.restore()`, `.archive()`, `.unarchive()`, `.share()`, `.unshare()`, `.getPermissions()`
13. **Auto-query filtering**: Queries auto-exclude trashed and archived records, with metadata overrides
14. **Readonly enforcement**: Server strips client-provided values for readonly capability fields
15. **Capability field collision detection**: Error if user-defined field name conflicts with capability-injected field
16. **Deprecate createSoftDeletePlugin**: Replace with trash capability
17. **Sync path support**: Push/pull paths handle new operations with capability injection
18. **No cascading capabilities to relations**: Explicitly not in scope (user responsibility)
19. **Permissions table schema**: Auto-generated with resourceId, userId, level, grantedBy, grantedAt
20. **Creator implicit owner**: Record creator always has owner access, no permissions entry needed
21. **Cascading permission delete**: Hard delete cascades permissions; trash preserves them
22. **Owner-only share/unshare**: Only owners can grant/revoke access
23. **Access level enforcement**: Viewer=read-only, Editor=read+write, Owner=all+share
24. **Nucleus patterns as reference**: Follow the three-tier removal pattern (trash vs archive vs hard delete) and auto-injection patterns from nucleus resource stores

## Coverage Mapping

| # | Intent Item | SPEC.md Section | Requirements | Test Vectors |
|---|---|---|---|---|
| 1 | Replace SYSTEM_FIELDS | Compatibility / versioning | CAP-005 | TV-CAP-005N |
| 2 | Capabilities as list | Public API → Schema Definition | CAP-001 | TV-CAP-001 |
| 3 | Global + resource-level | Public API → Schema Definition, Data Formats → Capability Resolution | CAP-001, CAP-002, CAP-006 | TV-CAP-002, TV-CAP-006 |
| 4 | Timestamps capability | Semantics → Timestamps | TS-001, TS-002, TS-003, TS-004 | TV-TS-001..004 |
| 5 | Audit capability | Semantics → Audit | AUD-001..005 | TV-AUD-001..005 |
| 6 | Trash capability | Semantics → Trash | TR-001..008 | TV-TR-001..008 |
| 7 | Archivable capability | Semantics → Archivable | AR-001..007 | TV-AR-001..007 |
| 8 | Shareable capability | Semantics → Shareable | SH-001..011 | TV-SH-001..011 |
| 9 | Private/shared default | Semantics → Shareable, Public API → Type Definitions | SH-001, SH-006 | TV-SH-001, TV-SH-006 |
| 10 | Shareable requires audit | Semantics → Shareable, Security | SH-011 | TV-SH-011N |
| 11 | Codegen updates | Public API → Resolved Capability Fields | CG-001, CG-002, CG-003 | TV-CG-001..003 |
| 12 | Client API methods | Public API → Client API | CL-001..009 | TV-CL-001..009 |
| 13 | Auto-query filtering | Semantics → Trash, Semantics → Archivable | TR-004, TR-005, AR-004, AR-005 | TV-TR-004..005, TV-AR-004..005 |
| 14 | Readonly enforcement | Invariants, Security | CAP-007 | TV-CAP-007 |
| 15 | Field collision detection | Data Formats → Capability Field Collision Rule | CAP-004 | TV-CAP-004N |
| 16 | Deprecate softDelete plugin | Compatibility → Migration from createSoftDeletePlugin | CL-009 | TV-CL-009 |
| 17 | Sync path support | — (cross-cutting) | SY-001, SY-002, SY-003 | TV-SY-001..003 |
| 18 | No cascading to relations | Undefined / Explicitly Not Specified | — | — |
| 19 | Permissions table schema | Public API → Permissions Table Schema | SH-002 | TV-SH-002 |
| 20 | Creator implicit owner | Semantics → Shareable, Invariants | SH-008 | TV-SH-008 |
| 21 | Cascading permission delete | Semantics → Shareable | SH-009 | TV-SH-009 |
| 22 | Owner-only share/unshare | Security, Semantics → Shareable | SH-010 | TV-SH-010, TV-SH-007N |
| 23 | Access level enforcement | Semantics → Shareable | SH-007 | TV-SH-007 |
| 24 | Nucleus patterns as reference | Overview (referenced as design inspiration) | — | — |

## Missing Intent Items

**No missing intent items.** All 24 intent items are covered by SPEC.md sections, REQUIREMENTS.md requirement IDs, and TEST_VECTORS.md test vectors. Items 18 and 24 are design context items that don't require requirements or test vectors (one is explicitly out of scope, the other is a design reference).
