## Metadata

- **timestamp**: 2026-02-06T04:41:59Z
- **agent_name**: unknown-agent
- **model**: GPT-5.2
- **launcher**: Cursor
- **workspace/project absolute path**: /Users/ar/dev/superfunctions/datafn
- **OS + shell**: darwin 25.0.0, zsh
- **repo metadata (git)**:
  - **toplevel**: /Users/ar/dev/superfunctions
  - **branch**: next
  - **commit**: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - **dirty**: yes (388 paths in `git status --porcelain`)
- **intent/notes paths audited (authoritative unless noted)**:
  - /Users/ar/dev/superfunctions/datafn/.conduct/tracker.csv
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/datafn.intent.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/spec.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/implementation.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/migration-plan-from-nucleus.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/2026-01-26-fixes/client-intent-1.md
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/dfql.intent.md
  - /Users/ar/dev/superfunctions/datafn/server/README.md
  - (historical context only; **NOT** used as authoritative for pass/fail)
    - /Users/ar/dev/superfunctions/datafn/.conduct/audits/flux-to-datafn-migration-gap-analysis.md
    - /Users/ar/dev/superfunctions/datafn/.conduct/audits/sync-remote-audit-2026-01-25.md
- **spec bundle(s) audited**:
  - **bundle root**: /Users/ar/dev/superfunctions/datafn/.conduct/specs/2026-02-05-fix-9x2k7m4p-spec
  - **included files**:
    - SPEC.md
    - PLAN.md
    - REQUIREMENTS.md
    - TEST_VECTORS.md
    - INTENT_AUDIT.md
    - phases/PHASE_00.md
    - phases/PHASE_01.md
    - phases/PHASE_02.md
    - phases/PHASE_03.md
    - phases/PHASE_04.md
    - phases/PHASE_05.md
    - phase-reports/PHASE_00-2026-02-06-k7m3x9p2-report.md
    - phase-reports/PHASE_01-2026-02-06-r8n4v2m7-report.md
    - phase-reports/PHASE_02-2026-02-06-t5w8j3q6-report.md
    - phase-reports/PHASE_03-2026-02-06-q4r7w2n8-report.md
    - phase-reports/PHASE_04-2026-02-06-m3k8v5p1-report.md
    - phase-reports/PHASE_05-2026-02-06-j6n2x8w4-report.md
    - logs.csv
- **codebase scope audited**:
  - **root**: /Users/ar/dev/superfunctions/datafn
  - **focus**:
    - `datafn/client/src/sync/cloneUp.ts` + helpers (`hash.ts`, `order.ts`, `batch.ts`)
    - `datafn/client/src/sync.ts`, `datafn/client/src/client.ts`, `datafn/client/src/remote/unwrap.ts`, `datafn/client/src/transport/http.ts`
    - `datafn/client/__tests__/cloneUp.test.ts`
    - `datafn/client/src/offline/relations.ts` (join store naming convention reference)
    - `datafn/core/src/normalize.ts` (`normalizeDfql`, `dfqlKey`)
  - **excluded folders (not audited)**:
    - any `**/node_modules/**`, `**/dist/**`, `**/build/**`, `**/.turbo/**`, `**/.next/**`, `**/.pytest_cache/**`
- **commands executed during audit**:
  - `npx vitest run __tests__/cloneUp.test.ts` (cwd: `/Users/ar/dev/superfunctions/datafn/client`) → PASS (30/30)
  - git metadata checks (toplevel/branch/commit/dirty count) via `git -C /Users/ar/dev/superfunctions ...`
  - `date -u +"%Y-%m-%dT%H:%M:%SZ"`

## Audit scope

This is a **full audit for the provided spec bundle** `2026-02-05-fix-9x2k7m4p-spec` (“CloneUp”) against:

- **Original intent/notes** relevant to offline-first sync + signup conversion (see “Inputs audited”).
- The **entire spec bundle**: `SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, `phases/*`, and `INTENT_AUDIT.md`.
- The **current implementation** in `@datafn/client` (and minimal shared core normalization helpers used by CloneUp).

This audit does **not** re-audit unrelated parts of datafn beyond what is required to validate CloneUp’s deterministic/idempotent behavior and protocol compatibility.

## Inputs audited (intent + spec bundles)

### Intent / notes (authoritative)

- `.conduct/tracker.csv` (entry: “Add `sync.cloneUp()` to upload existing local dataset to cloud on signup”)
- `.conduct/intent/*` docs listed in Metadata (sync invariants, determinism, schema-bounded DFQL, default sync config)
- `server/README.md` (canonical `/datafn/*` envelopes and sync endpoint expectations)

### Historical context (non-authoritative; read-only background)

- `.conduct/audits/flux-to-datafn-migration-gap-analysis.md` (documents the migration gap motivating CloneUp; **not** used as authoritative for compliance per audit rules)
- `.conduct/audits/sync-remote-audit-2026-01-25.md` (sync/remote architecture drift; **not** used as authoritative for compliance per audit rules)

### Spec bundle

Full contents listed in Metadata under “spec bundle(s) audited”.

## High-level findings

- **Implementation exists and is exercised by tests**: `client.sync.cloneUp()` is implemented in `datafn/client/src/sync/cloneUp.ts` and a dedicated test suite (`datafn/client/__tests__/cloneUp.test.ts`) passes (`npx vitest run __tests__/cloneUp.test.ts` → **30/30 PASS**).
- **Requirements coverage (REQUIREMENTS.md)**: **12/13 PASS**, **1/13 PARTIAL** (see `CLONEUP-COMPAT-001` / TV-CLONEUP-014 mismatch) with strong unit-test coverage mapped to the provided test vectors.
- **Test vectors coverage (TEST_VECTORS.md)**:
  - **13/14 vectors are implemented and passing** (TV-CLONEUP-001..013).
  - **TV-CLONEUP-014 is not implemented as specified** (see “Spec conflicts / spec gaps”).
- **Primary risk**: CloneUp’s remote response handling **does not unwrap/validate canonical envelopes** (`ok:false` error envelopes can be silently treated as success). This is not explicitly captured as a requirement, but it is a material correctness/safety risk given the documented envelope contract and the existence of `unwrapRemoteSuccess()` elsewhere in the client.

## Intent Inventory (numbered)

Intent items extracted from the authoritative intent/notes inputs for this spec (plus the explicit spec non-goals). These are the “what was intended” items used for intent→spec and intent→implementation checks.

1. **Offline user → cloud conversion on signup**: A user who accumulated local-first/offline data must be able to sign up/login and upload their existing local dataset to their authenticated cloud namespace without data loss.
2. **Idempotency**: Upload must be safely retryable and re-runnable; server-side dedupe relies on `(clientId, mutationId)` for retries.
3. **Determinism**: Given the same local dataset + schema + options, CloneUp produces the same mutation set (including mutationIds) and deterministic batching/order.
4. **Schema-bounded behavior**: Upload is limited to schema-declared resources/fields/relations; unknown local fields are not uploaded; relation metadata must be schema-declared.
5. **Remote-only resource safety**: Remote-only resources must not be uploaded as part of CloneUp by default; explicit scope selection must validate resource existence and remote-only exclusion rules.
6. **No new server endpoints required**: CloneUp should operate using existing `/datafn/push` semantics; compatibility is required with existing TypeScript and Python servers.
7. **Many-many preservation**: Many-many edges represented in local join stores must be uploaded as DFQL `relate` mutations, preserving metadata where declared.
8. **Failure safety**: Server-side mutation errors must not be acknowledged as success; local cursors and changelog must not be advanced/cleared on failure.
9. **Limits/caps**: CloneUp must support batching for large datasets and provide safe defaults aligned with existing client sync defaults (`pushBatchSize` default 100, `pushMaxRetries` default 3).
10. **Transport retry policy**: Retries should occur only for transport errors (network/timeouts) and must be bounded.
11. **Post-conversion sync consistency**: On success, local sync state should advance safely (monotonic cursor, optional pull catch-up) and avoid re-pushing obsolete history (changelog drain).
12. **Observability without payload leakage**: CloneUp should emit sync events for success/failure with `phase="cloneup"` and must not leak record payloads in emitted events by default.
13. **Explicit non-goals**: No multi-device conflict UX specification; no automatic signup detection (host triggers); no guest→user local DB renaming/migration.

## Intent → Spec coverage matrix (complete; no sampling)

| Intent # | Intent | Spec references (SPEC.md / other) | Requirements | Test vectors | Coverage status |
|---:|---|---|---|---|---|
| 1 | Offline→cloud upload on signup | SPEC.md: Overview, Goals, Semantics (High-level workflow) | CLONEUP-API-001 | TV-CLONEUP-001 | Covered |
| 2 | Idempotency via deterministic mutationId | SPEC.md: Deterministic mutationId generation; Invariants | CLONEUP-MUT-001, CLONEUP-MUT-002 | TV-CLONEUP-001, TV-CLONEUP-010 | Covered |
| 3 | Deterministic ordering/batching | SPEC.md: Stage A/B sorting; Retry policy; Invariants | CLONEUP-ORDER-001, CLONEUP-PUSH-001 | TV-CLONEUP-010 | Covered |
| 4 | Schema-bounded fields + relation metadata constraints | SPEC.md: Stage A field filtering; Stage B metadata validation; Error codes | CLONEUP-MUT-001, CLONEUP-MUT-002 | TV-CLONEUP-008, TV-CLONEUP-009 | Covered |
| 5 | Remote-only exclusion + deterministic scope | SPEC.md: Resolve upload scope; Error codes | CLONEUP-SCOPE-001 | TV-CLONEUP-002, TV-CLONEUP-005 | Covered |
| 6 | No new endpoints; use /push | SPEC.md: Server API; Wire protocol | CLONEUP-COMPAT-001 | TV-CLONEUP-001 | Covered |
| 7 | Many-many join-store upload | SPEC.md: Stage B; Glossary | CLONEUP-JOIN-001, CLONEUP-MUT-002 | TV-CLONEUP-001, TV-CLONEUP-007 | Covered |
| 8 | Failure safety (no cursor/changelog changes) | SPEC.md: Failure policy; State finalization | CLONEUP-PUSH-002, CLONEUP-STATE-002 | TV-CLONEUP-012 | Covered |
| 9 | Batching defaults/caps | SPEC.md: Limits/caps; options defaults | CLONEUP-PUSH-001 | TV-CLONEUP-013 | Covered |
| 10 | Transport-only retries | SPEC.md: Retry policy | CLONEUP-PUSH-001 | TV-CLONEUP-011 | Covered |
| 11 | Post-success finalization: cursor + pullAfter + changelog drain | SPEC.md: Finalize local sync state | CLONEUP-STATE-001 | TV-CLONEUP-001, TV-CLONEUP-006 | Covered |
| 12 | Observability events + no payload leakage | SPEC.md: Observability; Security | CLONEUP-EVT-001 | TV-CLONEUP-006, TV-CLONEUP-012 | Covered |
| 13 | Non-goals (scope constraints) | SPEC.md: Non-goals | N/A | N/A | Covered (documented constraints) |

## Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)

Spec bundle: `2026-02-05-fix-9x2k7m4p-spec`

- **PASS**: 12
- **PARTIAL**: 1
- **FAIL**: 0
- **UNVERIFIED**: 0

## Requirement-by-requirement results (tables + per-requirement notes)

### Summary table

| Requirement ID | Priority | Status | Primary evidence (code/tests) |
|---|---:|---|---|
| CLONEUP-API-001 | P0 | PASS | `client/src/sync.ts`; `client/src/index.ts`; `client/__tests__/cloneUp.test.ts` (Phase 00) |
| CLONEUP-API-002 | P0 | PASS | `client/src/sync/cloneUp.ts` prereq checks; tests TV-CLONEUP-003/004 |
| CLONEUP-SCOPE-001 | P0 | PASS | `resolveResourceScope()`; tests TV-CLONEUP-002/005 |
| CLONEUP-JOIN-001 | P0 | PASS | `enumerateJoinStores()`; tests TV-CLONEUP-001/007 |
| CLONEUP-ORDER-001 | P0 | PASS | `sortRecordsById`, `sortJoinRows`, stage ordering; tests TV-CLONEUP-010/001 |
| CLONEUP-MUT-001 | P0 | PASS | record mutation generation + hash; tests TV-CLONEUP-010/008 |
| CLONEUP-MUT-002 | P0 | PASS | relate mutation generation + metadata enforcement; tests TV-CLONEUP-001/009 |
| CLONEUP-PUSH-001 | P0 | PASS | batching + retry (`pushBatchWithRetry`); tests TV-CLONEUP-011/013 |
| CLONEUP-PUSH-002 | P0 | PASS | server errors → `ok=false` + no local finalization; tests TV-CLONEUP-012 |
| CLONEUP-STATE-001 | P0 | PASS | pullAfter + monotonic cursor + changelog drain; tests TV-CLONEUP-001/006 |
| CLONEUP-STATE-002 | P0 | PASS | early-return failure path; tests TV-CLONEUP-012 (state) |
| CLONEUP-EVT-001 | P1 | PASS | emits `sync_applied`/`sync_failed` without payload leakage; tests Phase 05 |
| CLONEUP-COMPAT-001 | P0 | PARTIAL | uses `/datafn/push` via `remote.push({clientId, mutations})`; **TV-CLONEUP-014 mismatch** (see spec gaps) |

### Spec inventory (from `REQUIREMENTS.md` — IDs, statements, acceptance criteria, test vectors)

#### CLONEUP-API-001 (P0)

- **Statement**: `@datafn/client` MUST expose `client.sync.cloneUp(options?: CloneUpOptions): Promise<CloneUpResult>` with the option defaults and return shape defined in `SPEC.md` (“Public API”).
- **Acceptance criteria**:
  - `createDatafnClient(...)` returns an object whose `sync` member has a callable `cloneUp` function.
  - Calling `cloneUp()` without options uses the documented defaults.
  - The resolved `CloneUpResult` contains: `ok`, `cursor`, `stats`, and `errors` fields.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-002, TV-CLONEUP-006

#### CLONEUP-API-002 (P0)

- **Statement**: `cloneUp()` MUST validate prerequisites (storage configured, remote configured, schema available) and MUST fail with `DFQL_INVALID` when prerequisites are not met.
- **Acceptance criteria**:
  - If `storage` is missing, `cloneUp()` throws a `DatafnClientError` with `code="DFQL_INVALID"` and `details.path="storage"`.
  - If `sync.remote` is missing, `cloneUp()` throws a `DatafnClientError` with `code="DFQL_INVALID"` and `details.path="sync.remote"`.
  - If schema is missing/invalid at runtime, `cloneUp()` throws a `DatafnClientError` with `code="INTERNAL"` and a stable error message.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-003, TV-CLONEUP-004

#### CLONEUP-SCOPE-001 (P0)

- **Statement**: `cloneUp()` MUST compute the upload resource set deterministically from `options.resources` and schema, and MUST exclude `isRemoteOnly` resources by default.
- **Acceptance criteria**:
  - With `options.resources` undefined, resources uploaded are exactly `schema.resources.filter(r => !r.isRemoteOnly).map(r => r.name)` in schema order.
  - With `options.resources` provided, any unknown resource name causes `DFQL_UNKNOWN_RESOURCE` with `details.path="resources[i]"`.
  - If `options.resources` includes a remote-only resource, `cloneUp()` fails with `DFQL_INVALID` and `details.path="resources[i]"`.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-002, TV-CLONEUP-005

#### CLONEUP-JOIN-001 (P0)

- **Statement**: When `includeManyMany !== false`, `cloneUp()` MUST enumerate many-many join stores using the canonical client naming convention `join_${from}_${relation}_${to}` for each many-many relation combination implied by schema.
- **Acceptance criteria**:
  - For each schema relation with `type="many-many"` whose `from` resource is included in the resolved upload scope, `cloneUp()` computes join store names using:
    - `fromResources = Array.isArray(from) ? from : [from]`
    - `toResources = Array.isArray(to) ? to : [to]`
    - `relName = relation.relation ?? "rel"`
    - store names are all `join_${f}_${relName}_${t}` combinations.
  - Non-existent join stores MUST be ignored safely (treated as empty) and MUST NOT fail cloneUp.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-007, TV-CLONEUP-009

#### CLONEUP-ORDER-001 (P0)

- **Statement**: `cloneUp()` MUST generate and push mutations in a deterministic order so that retries/re-runs produce the same batch plan.
- **Acceptance criteria**:
  - Resource iteration order is deterministic:
    - when `options.resources` is omitted: schema resource order (already defined by `CLONEUP-SCOPE-001`)
    - when `options.resources` is provided: the provided order after validation
  - Within a resource, record mutations are generated in ascending lexicographic order by `id`.
  - Stage ordering is enforced: all record upsert push batches (Stage A) complete successfully before any many-many `relate` push batches (Stage B) are attempted.
  - Join store enumeration order (when enabled) is ascending lexicographic by join store name.
  - Within a join store, join-row mutations are generated in ascending lexicographic order by `(from, to, dfqlKey(metaFiltered))`.
  - Batch segmentation is a pure partition of the deterministic mutation order (no reordering during batching).
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-010, TV-CLONEUP-012

#### CLONEUP-MUT-001 (P0)

- **Statement**: `cloneUp()` MUST transform each local record into a schema-bounded DFQL mutation using `recordOperation` (default `"merge"`), and MUST generate deterministic `mutationId`s for idempotency.
- **Acceptance criteria**:
  - For each local record `{ id, ...fields }`, cloneUp creates a mutation:
    - `resource = <resource>`
    - `version = schema.resources[resource].version`
    - `operation = recordOperation`
    - `id = record.id`
    - `record = record without id, including only schema-declared fields (unknown fields are omitted)`
    - `clientId = client.config.clientId`
    - `mutationId` follows the canonical format `{prefix}:rec:{resource}:{id}:{hash}`
  - Hash input is produced from normalized payload (stable key ordering, no undefined), and hash output is stable across runs using the FNV-1a 32-bit algorithm specified in `SPEC.md`.
  - If any local record is missing a string `id`, cloneUp fails with `DFQL_INVALID` and `details.path="records[i].id"`.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-008

#### CLONEUP-MUT-002 (P0)

- **Statement**: `cloneUp()` MUST transform each many-many join row into a DFQL `relate` mutation on the `from` resource, and MUST enforce schema metadata constraints for relation payloads.
- **Acceptance criteria**:
  - For each join row `{ from, to, ...meta }` in a join store derived from schema relation `(fromResource, relationName, toResource)`:
    - mutation fields are:
      - `resource = fromResource`
      - `version = fromResource.version`
      - `operation = "relate"`
      - `id = <row.from>`
      - `relations = { [relationName]: { "$ref": <row.to>, ...metaFiltered } }`
      - `mutationId` follows `{prefix}:rel:{joinStore}:{from}:{to}:{hash}`
  - The `{hash}` component MUST be computed using the FNV-1a 32-bit algorithm specified in `SPEC.md`.
  - If join row metadata contains keys not declared in schema relation `metadata`, cloneUp fails with `DFQL_UNKNOWN_FIELD` and a stable path referencing that key.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-009

#### CLONEUP-PUSH-001 (P0)

- **Statement**: `cloneUp()` MUST push generated mutations to the server using `/datafn/push` in deterministic batches, and MUST retry batches only on transport errors up to `maxRetries`.
- **Acceptance criteria**:
  - Batch size defaults to `config.sync.pushBatchSize ?? 100` and MUST be overridable via `options.batchSize`.
  - Invalid `batchSize` or `maxRetries` values cause `DFQL_INVALID` at `details.path="batchSize"` / `"maxRetries"`.
  - A batch is retried only when `isTransportError(err) === true`.
  - After successful push, cloneUp tracks the highest `cursor` returned (base-10 integer string).
- **Test vectors**: TV-CLONEUP-010, TV-CLONEUP-011, TV-CLONEUP-013

#### CLONEUP-PUSH-002 (P0)

- **Statement**: `cloneUp()` MUST treat any non-empty server `errors` array from a push result as a CloneUp failure (unless `failFast=false`), and MUST NOT clear changelog nor advance local cursor when any errors occurred.
- **Acceptance criteria**:
  - If any push batch result contains `errors.length > 0`, cloneUp returns `ok=false` with aggregated `errors`.
  - In this case, local cursors are unchanged and local changelog is not cleared.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-009, TV-CLONEUP-012

#### CLONEUP-STATE-001 (P0)

- **Statement**: On full success, `cloneUp()` MUST (a) set the local global cursor `__global_cursor__` monotonically to the highest server cursor observed, (b) clear the local changelog when configured, and (c) optionally trigger a pull.
- **Acceptance criteria**:
  - If `setGlobalCursorOnSuccess !== false`, `storage.setCursor("__global_cursor__", cursor)` is performed monotonically.
  - If `clearChangelogOnSuccess !== false`, the changelog is fully cleared/acked.
  - If `pullAfter !== false`, cloneUp triggers a `pullNow()` (or equivalent) after upload to pick up server-only seed/default data.
- **Test vectors**: TV-CLONEUP-006, TV-CLONEUP-011, TV-CLONEUP-012

#### CLONEUP-STATE-002 (P0)

- **Statement**: On any failure, `cloneUp()` MUST leave local storage unchanged with respect to changelog contents and cursors.
- **Acceptance criteria**:
  - On failure, `__global_cursor__` is unchanged.
  - On failure, changelog entries remain intact.
- **Test vectors**: TV-CLONEUP-009, TV-CLONEUP-012

#### CLONEUP-EVT-001 (P1)

- **Statement**: `cloneUp()` MUST emit `DatafnEvent` events: `sync_applied` on success and `sync_failed` on failure, with `context.phase="cloneup"`.
- **Acceptance criteria**:
  - On success, exactly one `sync_applied` is emitted with cursor + stats in context.
  - On failure, exactly one `sync_failed` is emitted with error details in context.
- **Test vectors**: TV-CLONEUP-006, TV-CLONEUP-012

#### CLONEUP-COMPAT-001 (P0)

- **Statement**: CloneUp MUST be compatible with both TypeScript and Python server implementations by using only the canonical `/datafn/push` envelope and schema-bounded DFQL mutations.
- **Acceptance criteria**:
  - CloneUp uses only `remote.push({ clientId, mutations })` with mutations shaped as server validators expect.
  - No new server routes are required for correctness.
- **Test vectors**: TV-CLONEUP-001, TV-CLONEUP-010, TV-CLONEUP-014

### Per-requirement notes / evidence

#### CLONEUP-API-001 — PASS

- **Implementation evidence**:
  - `datafn/client/src/sync.ts` wires `cloneUp()` into `SyncFacade` and delegates to `sync/cloneUp.ts`.
  - `datafn/client/src/index.ts` exports `CloneUpOptions`, `CloneUpResult`.
- **Test evidence**: `datafn/client/__tests__/cloneUp.test.ts` Phase 00 tests confirm the callable surface and importable types.

#### CLONEUP-API-002 — PASS

- **Implementation evidence**: `datafn/client/src/sync/cloneUp.ts` validates missing storage/remote and throws `DFQL_INVALID` with stable paths/messages; schema missing throws `INTERNAL`.
- **Test evidence**: TV-CLONEUP-003 and TV-CLONEUP-004 in `cloneUp.test.ts`.

#### CLONEUP-SCOPE-001 — PASS

- **Implementation evidence**: `resolveResourceScope()` validates `options.resources`, rejects unknown resources and remote-only resources; default scope filters out `isRemoteOnly`.
- **Test evidence**: TV-CLONEUP-002 (scope limiting + unknown resource) and TV-CLONEUP-005.

#### CLONEUP-JOIN-001 — PASS

- **Implementation evidence**: `enumerateJoinStores()` derives join store names as `join_${from}_${relationName}_${to}` with `relationName = relation.relation ?? "rel"` and supports array `from/to`.
- **Cross-check**: aligns with many-many join-store naming in `datafn/client/src/offline/relations.ts`.
- **Test evidence**: TV-CLONEUP-001 (join portion) and TV-CLONEUP-007.

#### CLONEUP-ORDER-001 — PASS (with determinism caveat; see cross-cutting section)

- **Implementation evidence**:
  - `sortRecordsById()` sorts records by `id` before mutation generation.
  - `sortJoinRows()` sorts by `(from,to,dfqlKey(meta))`.
  - Stage ordering is enforced: record pushes occur before join-store pushes.
- **Test evidence**: TV-CLONEUP-010 (record sorting + batching), TV-CLONEUP-001 (records before relate).

#### CLONEUP-MUT-001 — PASS

- **Implementation evidence**: Stage A generates schema-bounded record mutations and deterministic mutationIds using:
  - `normalizeDfql()` / `dfqlKey()` in `@datafn/core`
  - FNV-1a 32-bit hash over UTF-8 bytes in `datafn/client/src/sync/cloneUp/hash.ts`
- **Test evidence**: TV-CLONEUP-010 asserts mutation ordering + deterministic IDs; TV-CLONEUP-008 validates id type error.

#### CLONEUP-MUT-002 — PASS

- **Implementation evidence**: Stage B generates DFQL `relate` mutations for join rows; enforces schema-declared metadata keys; deterministic mutationIds.
- **Test evidence**: TV-CLONEUP-001 (relate payload shape + mutationId), TV-CLONEUP-009 (+ negative).

#### CLONEUP-PUSH-001 — PASS

- **Implementation evidence**:
  - deterministic batching (`batchMutations`)
  - retry on `isTransportError(err)` only (`pushBatchWithRetry`)
  - defaults from sync config (`pushBatchSize`, `pushMaxRetries`) or explicit options
- **Test evidence**: TV-CLONEUP-011, TV-CLONEUP-013.

#### CLONEUP-PUSH-002 — PASS

- **Implementation evidence**: non-empty server `errors[]` are aggregated; `cloneUp` returns `ok=false` and skips finalization.
- **Test evidence**: TV-CLONEUP-012 asserts `ok=false` and no cursor/changelog mutation.

#### CLONEUP-STATE-001 — PASS

- **Implementation evidence**:
  - pullAfter loop uses `{ clientId, cursor, limit: 100 }` pages and applies `upsert`/`delete`
  - monotonic cursor updates via `setCursorMonotonically`
  - changelog drain via `changelogList` + `changelogAck`
- **Test evidence**: TV-CLONEUP-001 (full), TV-CLONEUP-006, plus additional Phase 04 tests.

#### CLONEUP-STATE-002 — PASS (with unverified edge cases; see cross-cutting section)

- **Implementation evidence**: all failure paths (`ok=false` or failFast early return) return before finalization and avoid cursor/changelog changes.
- **Test evidence**: TV-CLONEUP-012 (state).

#### CLONEUP-EVT-001 — PASS (thrown-error emission is unverified; see cross-cutting section)

- **Implementation evidence**:
  - on success: emits `sync_applied` with `context.phase="cloneup"`, cursor, stats
  - on server-error failure: emits `sync_failed` with `context.phase="cloneup"`
  - tests assert no `record`/`records`/`mutations` keys in emitted event context
- **Test evidence**: Phase 05 tests in `cloneUp.test.ts`.

#### CLONEUP-COMPAT-001 — PARTIAL (TV-CLONEUP-014 mismatch; see spec gaps)

- **Implementation evidence**: CloneUp uses `remote.push({ clientId, mutations })` and `remote.pull(...)` only; no server changes were introduced by this spec bundle.

## Spec conflicts / spec gaps (explicit)

1. **TEST_VECTORS.md — TV-CLONEUP-014 is not implemented as specified**
   - The vector specifies “missing remote method” behavior that assumes a directly injectable `remote` object with `push: null`.
   - The current `createDatafnClient` public surface takes `sync.remote` as a URL string and always constructs `DefaultHttpTransport` (which has `push`), so the vector is not directly representable via the public API.
   - The implemented test labeled “TV-CLONEUP-014” instead covers “missing `sync.remote` configuration” (throws `DFQL_INVALID` at `sync.remote`), which matches `CLONEUP-API-002` rather than the vector’s stated scenario.
   - **Status**: SPEC GAP / SPEC-TEST MISMATCH.
   - **Recommendation**: either (a) update TV-CLONEUP-014 to match the actual public API surface, or (b) update CloneUp to validate `typeof remote.push === "function"` and throw `TRANSPORT_ERROR` with `details.path="sync.push"` when missing, plus add a test that can simulate it (e.g., by calling the lower-level `cloneUp(deps, ...)` with a fake remote).

2. **Canonical envelope handling is weaker in CloneUp than in the rest of the SyncFacade**
   - Other sync methods use `unwrapRemoteSuccess()` which throws on `{ ok: false, error: ... }`.
   - CloneUp instead uses `response?.result ?? response` and does not validate `ok` / `error` envelopes for `push` or `pull`.
   - This is a correctness and safety risk: a server error envelope can be treated as success with empty `errors[]`, leading to silent partial uploads and incorrect finalization decisions.
   - **Status**: SPEC GAP (not explicitly listed as a requirement, but conflicts with “canonical envelopes” expectations in intent/docs and with existing client patterns).

## Cross-cutting audits (security/determinism/limits/errors/compat)

### Security / authz / validation boundaries

- **Server-side authz**: CloneUp relies on the server’s existing `/datafn/push` authorization model (consistent with intent; no new client-side authz is introduced).
- **Schema-bounded uploads**:
  - Records: CloneUp filters record payload fields to schema-declared fields (unknown fields are omitted).
  - Relations: CloneUp rejects unknown join-row metadata keys (fail-closed).
- **Payload leakage**: CloneUp emits only counts/stats and error summaries in events; tests assert event contexts don’t contain record payload keys and don’t serialize sensitive record content.

### Determinism invariants

- **Hash determinism**: `computeMutationHash()` uses `normalizeDfql()` + UTF-8 encoding + FNV-1a 32-bit → base36; matches the algorithm described in `SPEC.md`.
- **Ordering determinism**:
  - records are sorted by `id`
  - join stores are sorted by name
  - join rows are sorted by `(from,to,dfqlKey(meta))`
- **Caveat**: `sortRecordsById` uses `String(a.id).localeCompare(String(b.id))`. Locale-sensitive collation can theoretically vary across environments; strict determinism would be better served by a locale-independent comparator (e.g., direct `<`/`>` string comparison or `localeCompare` with an explicit locale/options).

### Limits / caps

- `batchSize` defaulting and validation is implemented and tested.
- Batching partitions deterministic mutation order without reordering.

### Error handling + canonical envelopes

- **Server mutation errors** (`errors[]` inside a successful push result): handled safely by returning `ok=false` and skipping cursor/changelog finalization.
- **Transport errors**: retried only when `isTransportError(err)===true`, bounded by `maxRetries`.
- **Envelope validation risk** (important): CloneUp does not call `unwrapRemoteSuccess()` and does not validate top-level `{ ok: false, error }` envelopes, creating a risk of silent failure/partial success.
- **Unverified edge case**: if `pullAfter` succeeds for N pages (advancing cursor) and then fails with a transport error mid-loop, the spec’s “failure leaves cursors unchanged” invariant may be violated. This scenario is not covered by the provided test vectors.

### Compatibility / versioning / migrations

- **Additive change**: Adds `sync.cloneUp()`; existing sync methods remain intact.
- **Protocol compatibility**: Uses the canonical `/datafn/push` and `/datafn/pull` request shapes as exercised in tests; no server endpoint changes are required by the spec.

## Recommendations (ranked)

1. **Fix remote envelope unwrapping in CloneUp (highest risk)**
   - Use `unwrapRemoteSuccess()` (or equivalent explicit checks) for `push` and `pull` responses so `{ ok: false, error }` never silently passes as success.
2. **Resolve the TV-CLONEUP-014 mismatch**
   - Update the vector to match the public API, or implement missing-remote-method validation and add a test that can simulate it.
3. **Strengthen determinism of sorting**
   - Replace `localeCompare()` with a locale-independent comparator (or specify locale/options) to guarantee cross-environment determinism.
4. **Narrow join-store “missing store” handling**
   - Treat “store not found” as empty, but avoid swallowing unexpected adapter errors that could hide data loss.
5. **Add a test for pullAfter mid-loop transport failure**
   - Ensure cursor/changelog invariants are preserved or explicitly define acceptable partial-apply semantics.

## Appendix: commands run + environment details

### Commands run

- `date -u +"%Y-%m-%dT%H:%M:%SZ"` → `2026-02-06T04:41:59Z`
- `npx vitest run __tests__/cloneUp.test.ts` (from `datafn/client`) → PASS (30 tests)
- git metadata:
  - `git -C /Users/ar/dev/superfunctions rev-parse --show-toplevel`
  - `git -C /Users/ar/dev/superfunctions branch --show-current`
  - `git -C /Users/ar/dev/superfunctions rev-parse HEAD`
  - `git -C /Users/ar/dev/superfunctions status --porcelain | wc -l`

### Environment

- OS: darwin 25.0.0
- Shell: zsh
- Workspace root: /Users/ar/dev
- Project audited: /Users/ar/dev/superfunctions/datafn
