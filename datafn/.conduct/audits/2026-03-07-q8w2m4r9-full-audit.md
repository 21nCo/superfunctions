# Metadata
- Timestamp (UTC): 2026-03-07T05:03:54Z
- Agent name: unknown-agent
- Model: gpt-5-codex
- Launcher: Codex Desktop
- Workspace/project path: /Users/serro/Documents/dev/n/superfunctions
- Primary audited package root: /Users/serro/Documents/dev/n/superfunctions/datafn
- OS/Shell: Darwin 25.3.0 (arm64) / /bin/zsh
- Git branch: heads/next
- Git commit: 635bf2853807d9d76dba07a460dd0594f57d9147
- Git dirty status: dirty (125 entries)
- Intent/notes paths audited:
  - /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec/INTENT_AUDIT.md
  - /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/audits/2026-03-06-delete-system-fields-timeline-audit.md
- Spec bundle paths audited:
  - /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-06-new-k4m7x9r3-spec
    - INTENT_AUDIT.md
    - PLAN.md
    - SPEC.md
    - REQUIREMENTS.md
    - TEST_VECTORS.md
    - phases/PHASE_00.md ... phases/PHASE_14.md
    - phase-reports/PHASE_00-2026-03-06-n9k4x7-report.md ... PHASE_14-2026-03-07-m9k4r2t-report.md
- Codebase scope audited:
  - Included: /Users/serro/Documents/dev/n/superfunctions/datafn/{core,server,client,cli,examples/todo-app/server}
  - Excluded from deep inspection: node_modules, dist artifacts, unrelated monorepo packages

# Audit scope
Full read-only implementation audit against:
1. Authoritative intent inventory and notes.
2. Full spec bundle (SPEC/REQUIREMENTS/TEST_VECTORS/PLAN/phases/reports).
3. Runtime and compile verification in current workspace state.

No implementation code changes were made during this audit.

# Inputs audited (intent + spec bundles)
- Intent extraction source: INTENT_AUDIT.md (24 intent items), plus timeline audit context doc.
- Spec source of truth: REQUIREMENTS.md (60 requirements), SPEC.md semantics/invariants/security/limits/compat, TEST_VECTORS.md vectors.
- Planning/phase context: PLAN.md + PHASE_00..14 + phase reports for claimed completion state.

# High-level findings
1. PARTIAL: `SY-002`/`SY-003` are only partially implemented for sync push path. Push validation accepts `share`/`unshare`, but `executePush` lacks execution cases and falls through to `DFQL_UNSUPPORTED`.
2. PARTIAL: `CL-009` deprecation/migration guard is implemented but conflict enforcement is mutation-hook-time only, not upfront config-time validation.
3. FAIL (global phase/DoD gate): `datafn/server` TypeScript compile currently fails with 3 implicit-any errors (`pushdown.ts`, `validation/authz.ts`, `validation/mutation.ts`), violating global DoD compile gate in plan/phases.
4. FAIL (phase deliverable drift): committed `examples/todo-app/server/src/datafn-schema.drizzle.ts` is out of sync with current CLI codegen output; PHASE_14 report says regenerated artifact is current, but diff shows stale capability column shapes and missing generated columns on `kv`.

# Intent Inventory (numbered)
1. Replace `SYSTEM_FIELDS`/`READONLY_SYSTEM_FIELDS` with opt-in capabilities.
2. Capabilities declared as list entries (not boolean map).
3. Global + resource capability resolution with additive/exclude behavior.
4. Timestamps capability auto-inject + auto-set.
5. Audit capability auto-inject + actor-based writes.
6. Trash capability (`trash`/`restore`) replacing plugin-centric soft-delete behavior.
7. Archivable capability (`archive`/`unarchive`) with auto-filter.
8. Shareable capability with per-record user ACL and methods.
9. Shareable private/shared default behavior.
10. Shareable requires audit for ownership (`createdBy`).
11. Codegen emits capability fields and permissions tables.
12. Client table methods for trash/restore/archive/unarchive/share/unshare/getPermissions.
13. Auto-query filtering for trash/archive with metadata overrides.
14. Readonly capability field enforcement server-side.
15. Capability field collision detection.
16. Deprecate `createSoftDeletePlugin` and steer to trash capability.
17. Sync paths support capability operations/injection/change tracking.
18. No automatic cascading capability behavior to relations (out of scope).
19. Permissions table shape with resource/user/level/grant metadata.
20. Creator implicit owner semantics.
21. Hard delete cascades permissions; trash preserves them.
22. Owner-only share/unshare.
23. Access-level enforcement (`viewer`/`editor`/`owner`).
24. Follow nucleus-style lifecycle patterns as design reference.

# Intent → Spec coverage matrix (complete; no sampling)
| Intent # | Intent summary | Spec/Req coverage | Implementation status |
|---|---|---|---|
| 1 | Remove system field constants | CAP-005 | PASS |
| 2 | Capabilities as list entries | CAP-001 | PASS |
| 3 | Global/resource merge/exclude | CAP-002, CAP-006 | PASS |
| 4 | Timestamps semantics | TS-001..TS-004 | PASS |
| 5 | Audit semantics | AUD-001..AUD-005 | PASS |
| 6 | Trash lifecycle | TR-001..TR-008 | PASS |
| 7 | Archive lifecycle | AR-001..AR-007 | PASS |
| 8 | Shareable ACL + ops | SH-001..SH-011 | PASS |
| 9 | Private/shared default | SH-006 (+ SPEC shareable semantics) | PASS |
| 10 | Shareable requires audit | SH-011 | PASS |
| 11 | Codegen capability support | CG-001..CG-003 | PASS (generator), artifact drift in example |
| 12 | Client methods | CL-001..CL-008 | PASS |
| 13 | Auto-query filtering | TR-004/005, AR-004/005 | PASS |
| 14 | Readonly stripping | CAP-007 | PASS |
| 15 | Collision detection | CAP-004 | PASS |
| 16 | Deprecate softDelete plugin | CL-009 | PARTIAL |
| 17 | Sync support | SY-001..SY-003 | PARTIAL |
| 18 | No relation cascading | SPEC explicit non-goal | PASS |
| 19 | Permissions table schema | SH-002 | PASS |
| 20 | Creator implicit owner | SH-008 | PASS |
| 21 | Permission cascade on delete | SH-009 | PASS |
| 22 | Owner-only share/unshare | SH-010 | PASS |
| 23 | Access-level enforcement | SH-007 | PASS |
| 24 | Nucleus-inspired lifecycle behavior | SPEC overview/reference | PASS |

# Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)
| Spec bundle | Total reqs | PASS | PARTIAL | FAIL | UNVERIFIED |
|---|---:|---:|---:|---:|---:|
| 2026-03-06-new-k4m7x9r3-spec (REQUIREMENTS.md) | 60 | 57 | 3 | 0 | 0 |

# Requirement-by-requirement results (tables + per-requirement notes)
## Core Infrastructure
| ID | Status | Evidence | Notes |
|---|---|---|---|
| CAP-001 | PASS | core `types.ts`, `capabilities.ts`, tests `core/src/__tests__/capabilities.test.ts` | Type surfaces match required schema/resource capability shapes. |
| CAP-002 | PASS | `core/src/capabilities.ts` `resolveCapabilities`, tests | Deterministic merge/exclude and dedupe behavior implemented. |
| CAP-003 | PASS | `core/src/schema.ts` injection + server/cli usage, tests | Effective fields include capability fields for validation/codegen/execution. |
| CAP-004 | PASS | `core/src/schema.ts` collision logic + tests | Returns `CAPABILITY_FIELD_COLLISION` with field/capability naming. |
| CAP-005 | PASS | `core/src/index.ts`, grep for legacy symbols returns none | Legacy constants removed from exports/import usage in audited TS packages. |
| CAP-006 | PASS | `resolveCapabilities` + tests | Global applies by default; additive and exclusion behavior present. |
| CAP-007 | PASS | mutation route pre-validation strip + execution strip, tests | Readonly capability fields stripped; `isArchived` preserved. |

## Timestamps
| ID | Status | Evidence | Notes |
|---|---|---|---|
| TS-001 | PASS | capability field defs + schema validation tests | `createdAt`/`updatedAt` injected only when enabled. |
| TS-002 | PASS | `execute.ts` insert injection + tests | Insert sets epoch-ms `createdAt`. |
| TS-003 | PASS | update injection used by merge/replace/trash/restore/archive/unarchive | `updatedAt` advanced on mutations. |
| TS-004 | PASS | replace/merge preservation logic + tests | `createdAt` preserved after initial insert. |

## Audit
| ID | Status | Evidence | Notes |
|---|---|---|---|
| AUD-001 | PASS | capability defs + schema tests | `createdBy`/`updatedBy` injected when enabled. |
| AUD-002 | PASS | insert injection from actorId + tests | Client values are stripped and server values win. |
| AUD-003 | PASS | update injection path + tests | `updatedBy` tracks current actor on mutations. |
| AUD-004 | PASS | replace/merge preservation + tests | `createdBy` immutable post-insert. |
| AUD-005 | PASS | actor fallback logic + tests | Null fallback implemented when actor unavailable. |

## Trash
| ID | Status | Evidence | Notes |
|---|---|---|---|
| TR-001 | PASS | capability defs + schema tests | `trashedAt`/`trashedBy` injected as nullable readonly fields. |
| TR-002 | PASS | mutation validation + `execute.ts` trash case + tests | Capability-gated; sets fields and returns mutation envelope. |
| TR-003 | PASS | restore case + tests | Clears trash fields; capability-gated. |
| TR-004 | PASS | `injectCapabilityAutoFilters` + query autofilter tests | Default query excludes trashed. |
| TR-005 | PASS | metadata suppression + tests | `includeTrashed` bypasses injected trash filter. |
| TR-006 | PASS | trash/restore idempotency tests | Duplicate trash and restore-on-active are idempotent. |
| TR-007 | PASS | delete path + tests | Hard delete removes trashed record. |
| TR-008 | PASS | change tracking in mutation/sync tests | Trash/restore produce pull-visible merge changes. |

## Archivable
| ID | Status | Evidence | Notes |
|---|---|---|---|
| AR-001 | PASS | capability defs + codegen/tests | `isArchived` injected and writable. |
| AR-002 | PASS | archive case + tests | Capability-gated archive operation implemented. |
| AR-003 | PASS | unarchive case + tests | Capability-gated unarchive operation implemented. |
| AR-004 | PASS | pushdown auto-filter + tests | Default query excludes archived. |
| AR-005 | PASS | metadata suppression + tests | `includeArchived` bypass works. |
| AR-006 | PASS | merge path + tests | Direct merge can set `isArchived`. |
| AR-007 | PASS | change tracking tests | Archive/unarchive persisted to sync changes. |

## Shareable
| ID | Status | Evidence | Notes |
|---|---|---|---|
| SH-001 | PASS | schema parse/validation + tests | Shareable string form rejected; config validated. |
| SH-002 | PASS | CLI codegen permissions table generation + tests | Required columns and indexes emitted. |
| SH-003 | PASS | `share.ts` + mutation tests | Upsert behavior, grant metadata, capability checks implemented. |
| SH-004 | PASS | `share.ts` + tests | Unshare delete/idempotency + creator-protection implemented. |
| SH-005 | PASS | query route `getPermissions` branch + authz tests | Owner-only permissions retrieval implemented. |
| SH-006 | PASS | query route access-id resolution + pushdown auto-filter + tests | Private shareable query gating enforced server-side. |
| SH-007 | PASS | `execute.ts` shareable access-level authorization + tests | Viewer/editor/owner mutation constraints enforced. |
| SH-008 | PASS | `resolveAccessLevel` + tests | Creator implicit owner without explicit permission row. |
| SH-009 | PASS | delete cascade logic + tests | Hard delete removes permission rows; trash preserves them. |
| SH-010 | PASS | owner checks in `share.ts` + authz tests | Share/unshare restricted to owners. |
| SH-011 | PASS | `validateSchema` dependency check + tests | Shareable without audit is rejected. |

## Codegen
| ID | Status | Evidence | Notes |
|---|---|---|---|
| CG-001 | PASS | `cli/src/drizzle-codegen.ts` + codegen tests | Capability columns generated from resolved capabilities. |
| CG-002 | PASS | codegen permissions table section + tests | `__datafn_permissions_{resource}` generated as required. |
| CG-003 | PASS | shared import/use of `resolveCapabilities` in server + cli | Resolution function reused across runtime and codegen. |

## Client API
| ID | Status | Evidence | Notes |
|---|---|---|---|
| CL-001 | PASS | `tables/table.ts` + capability method tests | `.trash(id)` exposed only on trash-enabled resources. |
| CL-002 | PASS | same + tests | `.restore(id)` implemented and payload verified. |
| CL-003 | PASS | same + tests | `.archive(id)` implemented and payload verified. |
| CL-004 | PASS | same + tests | `.unarchive(id)` implemented and payload verified. |
| CL-005 | PASS | share builder + table method + tests | `.share(id,userId,level)` payload correct. |
| CL-006 | PASS | unshare builder + table method + tests | `.unshare(id,userId)` payload correct. |
| CL-007 | PASS | getPermissions query builder + tests | `.getPermissions(id)` implemented for shareable resources. |
| CL-008 | PASS | delete method + tests | Hard delete behavior retained. |
| CL-009 | PARTIAL | `plugins/softDelete.ts`, deprecation tests | Warning + conflict error exist, but conflict check occurs at mutation-hook-time (not upfront validation lifecycle). |

## Sync
| ID | Status | Evidence | Notes |
|---|---|---|---|
| SY-001 | PASS | `execution/sync/push.ts` injection logic + push tests | Push insert/updates inject timestamps/audit fields. |
| SY-002 | PARTIAL | push validation accepts ops; `push.ts` lacks share/unshare execution cases | `share`/`unshare` are accepted by validation but unsupported in push execution switch. |
| SY-003 | PARTIAL | mutation route records share/unshare changes; push route does not execute share/unshare | Change tracking complete for supported new ops; incomplete for push share/unshare path. |

## Validation
| ID | Status | Evidence | Notes |
|---|---|---|---|
| VA-001 | PASS | schema capability parse/validation + tests | Invalid names/config rejected; duplicates deduped. |
| VA-002 | PASS | `validation/mutation.ts` + tests | New ops accepted and capability-gated with `DFQL_UNSUPPORTED` on mismatch. |
| VA-003 | PASS | `validation/authz.ts` + authz-capability tests | Capability field read/write authz rules implemented. |

# Spec conflicts / spec gaps (explicit)
1. SPEC CONFLICT: `phases/PHASE_08.md` marks share/unshare push execution as out-of-scope, while `REQUIREMENTS.md` `SY-002` explicitly lists `share`/`unshare` in push validation scope and `SY-003` requires change tracking for new operations.
2. SPEC GAP: SPEC limits mention default max shares per record (100), but no corresponding requirement/test and no enforcement found in runtime share path.
3. SPEC GAP: SPEC security states shareable should not be used without actorId provider; requirementization only enforces `shareable` depends on `audit`, not actorId-provider presence.
4. SPEC GAP: SPEC observability requirements (specific debug/info logs for capability resolution/share/query gating) are not fully requirementized or comprehensively tested.

# Cross-cutting audits (security/determinism/limits/errors/compat)
## Security/authz/validation boundaries
- Readonly capability field forgery prevention is implemented (strip + server injection).
- Share operations enforce owner-level checks; private resource query gating is server-side.
- Permissions table is not part of schema resources, so direct DFQL resource access is blocked by unknown-resource validation.
- Residual gap: actorId-provider hard requirement for shareable is not strongly validated at schema/server bootstrap.

## Determinism invariants
- `resolveCapabilities` is deterministic and deduplicated.
- Trash/archive idempotency behavior is implemented and tested.
- Push idempotency remains in place with `clientId`/`mutationId` semantics.

## Limits/caps
- Query/mutation limits from existing framework are enforced.
- Share-specific cap from SPEC (`default 100`) is not enforced in share execution path (spec gap).

## Error handling + canonical envelopes
- Mutation/query errors generally use canonical envelope codes (`DFQL_INVALID`, `DFQL_UNSUPPORTED`, `FORBIDDEN`, etc.).
- Push path returns 200 with per-mutation `errors` for operation-level failures; this is consistent with existing push semantics but should be explicitly documented for share/unshare unsupported cases.

## Compatibility/versioning/migrations
- `SYSTEM_FIELDS` migration is implemented in TS packages.
- Soft-delete plugin remains functional with deprecation warning (compat), but migration guard scope is partial.
- Example generated artifacts currently drift from generator output, weakening migration/documentation reliability.

# Recommendations (ranked)
1. Implement push execution for `share`/`unshare` and add push tests for these operations (`SY-002`, `SY-003`, intent #17).
2. Fix `datafn/server` TS7006 errors and re-run compile gate to restore global DoD compliance (PLAN global DoD).
3. Regenerate and commit example generated artifacts (`datafn-schema.drizzle.ts`, `datafn-types.ts`) from current CLI output; add a drift check test in CI (PHASE_14 deliverables, intent #11).
4. Harden `createSoftDeletePlugin` conflict enforcement at plugin setup (or shared validation hook) and cover query-only path behavior (`CL-009`, intent #16).
5. Resolve spec ambiguity by codifying shareable actorId-provider requirement and share-cap limits as explicit requirements/tests.

# Appendix: commands run + environment details
Environment:
- Workspace: `/Users/serro/Documents/dev/n/superfunctions`
- Date checked (UTC): `2026-03-07T05:03:54Z`
- OS: `Darwin 25.3.0 arm64`
- Shell: `/bin/zsh`

Key commands executed:
- `npx vitest run src/__tests__/capabilities.test.ts src/__tests__/schema-capabilities.test.ts` (core) -> PASS
- `npx tsc --noEmit` (core) -> PASS
- `npx vitest run src/__tests__/drizzle-codegen-capabilities.test.ts` (cli) -> PASS
- `npx tsc --noEmit` (cli) -> PASS
- `npx vitest run <capability-focused server tests>` -> PASS
- `npx vitest run` (server, full) -> PASS (65 files / 712 tests)
- `npx tsc --noEmit` (server) -> FAIL with TS7006 at:
  - `src/execution/query/pushdown.ts(85,6)`
  - `src/validation/authz.ts(399,6)`
  - `src/validation/mutation.ts(159,6)`
- `npx vitest run` (client, full) -> PASS (52 files / 509 tests)
- `npx tsc --noEmit` (client) -> PASS
- `npm run build` (examples/todo-app/server) -> PASS
- `npx tsx ../../../cli/src/cli.ts generate --adapter drizzle --database postgres --schema ./src/schema.datafn.ts --output <tmp>` + `diff` -> shows committed example drizzle schema drift versus current generator output.
