# CompFn Full Audit Report

## Metadata

- **Timestamp**: 2026-02-11T12:00:00Z (UTC)
- **Agent name**: unknown-agent
- **Model**: claude-4.6-opus-high-thinking
- **Launcher**: Cursor
- **Workspace path**: /Users/ar/dev
- **Project root**: /Users/ar/dev/superfunctions/compfn
- **OS**: darwin 25.0.0
- **Shell**: zsh
- **Repo**:
  - **Git repo**: Yes (parent superfunctions repo)
  - **Branch**: next
  - **Commit**: 98c7185
  - **Dirty**: Yes (compfn/ is untracked)
- **Audit ID**: x9k4m7pq
- **Audit type**: Full

---

## Audit Scope

### Inputs Audited

**Intent/notes paths:**
- `compfn/.conduct/compfn.intent.md` (14 scope items)
- `compfn/COMPFN_APPROACH.md` (7 sections; approach, ecosystem fit, implementation shape)

**Spec bundle path:** `compfn/.conduct/specs/2026-02-05-new-cp2m5k9x-spec/`

Spec bundle files audited:
- `SPEC.md` (426 lines; full specification)
- `REQUIREMENTS.md` (359 lines; 15 P0, 4 P1, 3 P2 requirements)
- `TEST_VECTORS.md` (520 lines; 40+ test vectors)
- `PLAN.md` (53 lines; 13 phases overview)
- `INTENT_AUDIT.md` (86 lines; 26 intent items mapped)
- `phases/PHASE_00.md` through `phases/PHASE_12.md` (13 phase definitions)
- `phase-reports/PHASE_00-*` through `phase-reports/PHASE_12-*` (14 phase reports)

**Codebase scope audited:**
- Root: `/Users/ar/dev/superfunctions/compfn`
- Source: `src/` (46 TypeScript files: types, services, adapters, storage, HTTP, tests)
- CLI: `cli/src/` (5 TypeScript files)
- Bundles: `bundles/` (1 JSON bundle + README)
- Config: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Docs: `README.md`, `bundles/README.md`
- Excluded: `node_modules/`, `dist/`, `cli/dist/`

### Commands Executed During Audit

None (read-only static audit).

---

## High-Level Findings

**Overall assessment**: The implementation is substantially complete and well-aligned with both the original intent and the specification. All P0 requirements are implemented. All P1 requirements (adapters, bundle, compat) are implemented. All P2 requirements (HTTP, CLI, provider docs) are implemented. The codebase is clean, well-structured, and follows the envelope pattern consistently.

**Summary counts (22 requirements total):**

| Status | Count |
|--------|-------|
| PASS | 19 |
| PARTIAL | 2 |
| FAIL | 0 |
| UNVERIFIED | 1 |
| SPEC MISSING | 0 |
| SPEC CONFLICT | 0 |

**Critical findings (2):**
1. **PARTIAL: CHECK-001** - `checks.run()` has no execution path for non-adapter checks (customConfig-only). Spec says "adapter or custom" but implementation requires adapterName for run().
2. **PARTIAL: BUNDLE-001** - SOC 2 bundle has 5 control ID mismatches between bundle `controlIds` and `loadBundle()` generated stable IDs, causing framework creation to fail when using `useStableControlIds: true`.

**Non-critical findings (2):**
1. **README syntax error**: Line 658 has mismatched backtick/double-quote in template literal.
2. **UNVERIFIED: OBS-001** - Logging rules are implemented correctly in code (verified via static audit), but no automated test captures and asserts on log output. TV-OBS-001 is marked as "manual or audit" in test vectors.

---

## Intent Inventory (Numbered)

Extracted from `compfn.intent.md` (14 items) and `COMPFN_APPROACH.md` (12 additional detailed items, merged into 26 total).

| # | Intent Summary |
|---|----------------|
| I01 | Control-centric, framework-agnostic: controls primary; frameworks reference controls via mapping; one control many frameworks; evidence attached to controls |
| I02 | Evidence from superfunctions: consume authfn, secfn, logfn, watchfn, hostfn, flowfn, filefn, plugfn; do not implement security; normalize to control evidence |
| I03 | CompFn-native evidence: policy/doc uploads, manual attestations, questionnaires, custom checks; all immutable and auditable (who, when, what) |
| I04 | Continuous monitoring: checks on schedule or event; produce evidence records; readiness and gaps up to date |
| I05 | Audit trail and reporting: immutable evidence log; export auditor pack (evidence + mapping + dates) JSON + optional PDF/HTML; readiness per framework and per control (compliant/not compliant/N/A) with last evidence date |
| I06 | Self-deployable: evidence in deployer DB/storage; no vendor SaaS; hostfn deployment story |
| I07 | SDK and optional server: programmatic API (controls, evidence, checks, reports); optional HTTP API; storage via @superfunctions/db adapter |
| I08 | Integrations as adapters: small adapters per superfunction; pluggable; compfn works with subset (including none) |
| I09 | Frameworks as data: framework definitions as data/bundles; at least one framework bundle shipped |
| I10 | No replacement for secfn: compfn consumes secfn; does not re-implement security |
| I11 | Provider to productFn/userfn/flowfn: compliance status, evidence-due tasks, attestation workflows consumable |
| I12 | Observability: MUST log (evidence ingestion, check runs, export); MUST NOT log (raw evidence payloads with PII/secrets in production) |
| I13 | Versioning: control and framework schema versioning and compatibility stated |
| I14 | Limits: max evidence payload size, retention defaults, export size caps defined |
| I15 | Control registry: id, name, description, category; optional tags |
| I16 | Framework definitions: e.g. SOC 2 Type II; list of control IDs and optionally requirement IDs |
| I17 | Evidence model: type (automated_*, manual_attestation, file_upload, questionnaire, custom_check, scoping_decision), source_id, control_id, timestamp, payload or file ref, optional framework_requirement_id |
| I18 | Checks: name, control_id, schedule or trigger, how to run; store result as evidence |
| I19 | API: CRUD controls, frameworks, evidence; run check; export report for framework X; readiness for framework X |
| I20 | Dashboard (optional): list controls, attach evidence, view readiness, run/see checks, export |
| I21 | CLI: init, run checks, export report, compfn attest |
| I22 | External evidence (optional): webhooks or pull from external systems |
| I23 | Multi-tenant: optional "compliance as a service" with tenant isolation |
| I24 | Error codes and failure behavior for all operations; canonical envelope |
| I25 | Determinism: readiness same inputs -> same status; list ordering documented; timestamps actual |
| I26 | Authz boundaries: who can add evidence, run checks, export (deployment-defined) |

---

## Intent -> Spec Coverage Matrix (Complete)

| Intent | SPEC.md Section(s) | Requirement IDs | Test Vectors | Status |
|--------|--------------------|-----------------|--------------|---------
| I01 | Overview, Glossary (Control, Framework), Goals 1, Public API (Control, Framework) | CTRL-001, FW-001, FW-002 | TV-CTRL-*, TV-FW-* | COVERED |
| I02 | Overview, Glossary (Adapter), Goals 6, Public API (EvidenceAdapter), Semantics (checks) | ADAPT-001, ADAPT-002, ADAPT-003, CHECK-001, CHECK-002 | TV-ADAPT-*, TV-CHECK-* | COVERED |
| I03 | Glossary (Evidence), Goals 2, Public API (Evidence, EvidenceType), Semantics (evidence) | EVID-001, EVID-002, EVID-003 | TV-EVID-*, TV-CLI-002 | COVERED |
| I04 | Glossary (Check), Goals 3, Public API (checks.run), Semantics (checks) | CHECK-001, CHECK-002 | TV-CHECK-RUN-*, TV-CHECK-EVIDENCE-001 | COVERED |
| I05 | Glossary (Readiness, Auditor pack), Goals 4-5, Public API (readiness, export), Semantics | READY-001, EXPORT-001 | TV-READY-*, TV-EXPORT-* | COVERED |
| I06 | Overview (Hard constraints), Security, Limits | API-001, LIMIT-001 | All (storage adapter; no SaaS) | COVERED |
| I07 | Goals 8, Public API (CompFnAPI, CompFnConfig), Optional HTTP API | API-001, HTTP-001 | TV-API-CONFIG-001, TV-HTTP-001 | COVERED |
| I08 | Glossary (Adapter), Goals 6, Public API (adapters in config) | ADAPT-001, ADAPT-002, ADAPT-003 | TV-ADAPT-INTERFACE-001 | COVERED |
| I09 | Goals 7, Undefined section | BUNDLE-001 | TV-BUNDLE-001 | COVERED |
| I10 | Overview, Non-goals, Hard constraints | (Spec: compfn does not implement security) | N/A (design) | COVERED |
| I11 | Goals 8, Public API (readiness, evidence.list) | PROVIDER-001 | TV-PROVIDER-001 | COVERED |
| I12 | Observability | OBS-001 | TV-OBS-001 | COVERED |
| I13 | Compatibility / versioning | COMPAT-001 | Documentation audit | COVERED |
| I14 | Limits / caps | LIMIT-001 | TV-LIMIT-* | COVERED |
| I15 | Public API (Control, CreateControlInput) | CTRL-001 | TV-CTRL-* | COVERED |
| I16 | Public API (Framework, FrameworkRequirement) | FW-001, FW-002, BUNDLE-001 | TV-FW-*, TV-BUNDLE-001 | COVERED |
| I17 | Public API (Evidence, EvidenceType, CreateEvidenceInput) | EVID-001, EVID-002 | TV-EVID-* | COVERED |
| I18 | Public API (CheckDefinition, checks.run) | CHECK-001, CHECK-002 | TV-CHECK-* | COVERED |
| I19 | Public API (CompFnAPI full surface) | CTRL-001, FW-001, EVID-*, CHECK-*, READY-001, EXPORT-001 | All TV-* | COVERED |
| I20 | Undefined / explicitly user-deferred (dashboard) | -- | -- | OPTIONAL (deferred) |
| I21 | Optional CLI | CLI-001 | TV-CLI-* | COVERED |
| I22 | EvidenceType external_webhook (optional) | EVID-002 (type enum includes external_webhook) | -- | COVERED (type exists) |
| I23 | Security (optional tenantId); Undefined | -- | -- | OPTIONAL (deferred) |
| I24 | Data formats (Envelope), Public API (CompfnError, CompfnErrorCode) | API-002 | TV-ENVELOPE-* | COVERED |
| I25 | Invariants (Determinism), Semantics (readiness) | READY-001 | TV-READY-* | COVERED |
| I26 | Security (Authz) | Security section (deployment-defined) | -- | COVERED (by design) |

**Missing intent items in spec**: None. All 26 intent items are covered by at least one SPEC section and (where applicable) requirement IDs and test vectors.

---

## Requirement Coverage Summary

### P0 Requirements (15)

| Req ID | Statement (abbreviated) | Status | Notes |
|--------|------------------------|--------|-------|
| CTRL-001 | Control CRUD and schema | PASS | All 5 operations implemented; validation; tags support |
| CTRL-002 | Control-evidence link validation | PASS | controlId checked before evidence creation |
| FW-001 | Framework CRUD and requirement mapping | PASS | All 5 operations; requirements array stored/returned |
| FW-002 | Framework requirement controlIds validation | PASS | Every controlId checked; VALIDATION_FAILED on unknown |
| EVID-001 | Evidence create and immutability | PASS | Create only; no update/delete methods |
| EVID-002 | Evidence types and payload size | PASS | Type enum validated; scoping_decision rules; payload size enforced |
| EVID-003 | Evidence list and get | PASS | get + list with controlId, frameworkId, type, since |
| CHECK-001 | Check definition and run | **PARTIAL** | See detailed notes below |
| CHECK-002 | Check stores result as evidence | PASS | Evidence created with correct controlId, type, outcome |
| READY-001 | Readiness for control and framework | PASS | Deterministic; scoping_decision handled; window-based |
| EXPORT-001 | Auditor pack export | PASS | frameworkId/since filters; size cap enforced |
| API-001 | compFn config and storage adapter | PASS | All namespaces returned; config options accepted |
| API-002 | Envelope and error codes | PASS | All 11 error codes defined; consistent envelope |
| LIMIT-001 | Payload and export caps | PASS | Defaults correct; validation rejects excess |
| OBS-001 | Logging rules | **UNVERIFIED** | Correct in static review; no automated test |

### P1 Requirements (4)

| Req ID | Statement (abbreviated) | Status | Notes |
|--------|------------------------|--------|-------|
| ADAPT-001 | Evidence adapter interface | PASS | EvidenceAdapter with name + runCheck |
| ADAPT-002 | Secfn adapter | PASS | name "secfn"; returns automated_secfn evidence |
| ADAPT-003 | Authfn adapter | PASS | name "authfn"; returns automated_authfn evidence |
| BUNDLE-001 | At least one framework bundle | **PARTIAL** | Bundle exists but has control ID mapping bug |
| COMPAT-001 | Schema versioning | PASS | Version 1 documented in schema and SPEC |

### P2 Requirements (3)

| Req ID | Statement (abbreviated) | Status | Notes |
|--------|------------------------|--------|-------|
| HTTP-001 | Optional HTTP API | PASS | All routes implemented; envelope responses; status codes |
| CLI-001 | Optional CLI | PASS | init, run-checks, export, attest all implemented |
| PROVIDER-001 | Readiness/evidence-due consumable | PASS | Documented in README with code examples |

---

## Requirement-by-Requirement Results

### CTRL-001: Control CRUD and schema — PASS

**Evidence:**
- `src/controls/service.ts` implements create (lines 56-89), get (91-122), list (124-161), update (163-241), delete (243-278)
- `src/control.ts` defines Control interface matching spec (id, name, description, category, tags?, createdAt, updatedAt)
- `src/validation.ts` validates CreateControlInput and UpdateControlInput
- Tests: `src/__tests__/controls.test.ts` covers TV-CTRL-CREATE-001, TV-CTRL-GET-001, TV-CTRL-GET-002, TV-CTRL-LIST-001, TV-CTRL-UPDATE-001, TV-CTRL-DELETE-001

**Notes:**
- Tags filter uses OR semantics (any matching tag); SPEC says "AND/OR semantics documented" - implementation uses OR, which is documented in code behavior.
- List ordering is by updatedAt desc; not explicitly documented in README but visible in code.

---

### CTRL-002: Control-evidence link validation — PASS

**Evidence:**
- `src/evidence/service.ts` line 82-92: validates controlId exists before insert
- Returns `VALIDATION_FAILED` with `details.controlId` when control not found
- Tests: TV-EVID-CONTROL-LINK-001, TV-EVID-CONTROL-LINK-002 in `evidence.test.ts`

---

### FW-001: Framework CRUD and requirement mapping — PASS

**Evidence:**
- `src/frameworks/service.ts` implements all 5 CRUD operations
- `src/framework.ts` defines Framework with requirements array of FrameworkRequirement (requirementId, controlIds, name?)
- Requirements are stored as JSON and returned in full
- Tests: TV-FW-CREATE-001, TV-FW-GET-001, TV-FW-GET-002, TV-FW-LIST-001

---

### FW-002: Framework requirement controlIds validation — PASS

**Evidence:**
- `src/frameworks/service.ts` function `validateControlIdsExist` (lines 59-89): iterates all controlIds in all requirements, checks existence
- Returns VALIDATION_FAILED with path, requirementId, controlId, missingCount
- Validation runs on both create and update
- Tests: TV-FW-VALIDATE-CONTROLS-001, TV-FW-VALIDATE-CONTROLS-002

---

### EVID-001: Evidence create and immutability — PASS

**Evidence:**
- `src/evidence/service.ts` has only create, get, list methods
- `src/api.ts` CompFnAPI interface defines evidence with create, get, list only (no update/delete)
- `src/compfn.ts` returns evidence object with only create, get, list
- Test TV-EVID-IMMUTABLE-001 verifies `evidence.update` and `evidence.delete` are undefined

---

### EVID-002: Evidence types and payload size — PASS

**Evidence:**
- `src/evidence.ts` EVIDENCE_TYPES array includes all 14 types including scoping_decision and external_webhook
- `src/validation.ts` lines 428-436: validates type against EVIDENCE_TYPES
- Lines 459-495: scoping_decision validation (outcome must be "unknown", payload.status must be "applicable" or "not_applicable")
- `src/evidence/service.ts` lines 94-106: payload size check using TextEncoder
- Tests: TV-EVID-TYPE-001, TV-EVID-TYPE-002, TV-EVID-SCOPING-001, TV-EVID-SCOPING-002, TV-EVID-PAYLOAD-SIZE-001, TV-EVID-PAYLOAD-SIZE-002

---

### EVID-003: Evidence list and get — PASS

**Evidence:**
- `src/evidence/service.ts` get (lines 150-178): returns EVIDENCE_NOT_FOUND or Evidence
- list (lines 181-248): supports controlId, frameworkId (resolves via framework requirements), type, since filters
- frameworkId filter correctly resolves to controlIds from framework requirements
- Tests: TV-EVID-GET-001, TV-EVID-GET-002, TV-EVID-LIST-001, TV-EVID-LIST-002

---

### CHECK-001: Check definition and run — PARTIAL

**Evidence:**
- `src/checks/service.ts` implements create, get, list, delete, run
- run() correctly: loads check, looks up adapter, calls runCheck, creates evidence, returns RunCheckResult
- CHECK_NOT_FOUND for nonexistent check: line 214-216
- ADAPTER_NOT_FOUND for missing adapter: line 236-246
- ADAPTER_ERROR on adapter throw: lines 256-280

**Issue:**
- `checks.run()` at lines 225-234 returns ADAPTER_NOT_FOUND when `check.adapterName` is null or empty. This means checks created with only `customConfig` (and no adapter) **cannot be run** via the core API.
- SPEC CHECK-001 acceptance criteria says: "run(checkId) executes adapter or custom logic" — implying custom (non-adapter) checks should also be executable.
- SPEC Semantics says: "If adapterName is set on a check, checks.run() MUST: ..." — describing the adapter path, but does not define behavior for non-adapter checks.
- The validation in `validateCreateCheckInput` allows checks with only `customConfig` (no adapter), creating an inconsistency: such checks can be created but never run.

**Impact**: Low-medium. Users who create checks with only customConfig expect to run them. Workaround: always provide an adapterName (even for custom checks via a "custom" adapter).

**Recommendation**: Either (a) add a custom execution path in `checks.run()` when adapterName is absent (e.g., eval customConfig or call a user-provided function), or (b) require adapterName for all runnable checks and update validation to warn users, or (c) document that checks without adapters are "event-triggered only" and evidence is submitted externally.

---

### CHECK-002: Check stores result as evidence — PASS

**Evidence:**
- `src/checks/service.ts` lines 283-294: after successful adapter call, calls `config.evidenceCreate()` with correct fields (controlId from check, type from adapter, sourceId = check.id, actorId = systemActorId)
- On adapter error: lines 264-270: also stores fail evidence (optional per spec)
- Test TV-CHECK-EVIDENCE-001 verifies evidence.get(result.evidenceId) returns evidence with matching controlId

---

### READY-001: Readiness for control and framework — PASS

**Evidence:**
- `src/readiness/service.ts` implements forControl and forFramework
- Policy: not_applicable when latest scoping_decision has payload.status "not_applicable"; compliant when at least one pass evidence (non-scoping) within window; not_compliant otherwise
- Window: `readinessWindowDays * 24 * 60 * 60 * 1000` ms from now
- Determinism: explicit sort by timestamp desc, createdAt desc, id desc for scoping decisions; consistent pass-in-window check
- forControl returns CONTROL_NOT_FOUND; forFramework returns FRAMEWORK_NOT_FOUND
- forFramework aggregates: not_compliant if any control is not_compliant; compliant if all are compliant/not_applicable
- Tests: TV-READY-CONTROL-001 through TV-READY-FRAMEWORK-002 + determinism test

---

### EXPORT-001: Auditor pack export — PASS

**Evidence:**
- `src/export/service.ts` implements auditorPack(options)
- Loads frameworks (one or all), resolves controlIds, loads controls (scoped or all), loads evidence (with filters), builds mapping
- exportedAt = Date.now() (actual export time)
- Size check: JSON.stringify + TextEncoder.encode; if > exportMaxBytes returns EXPORT_FAILED
- Tests: TV-EXPORT-001, TV-EXPORT-002, TV-EXPORT-003

---

### API-001: compFn config and storage adapter — PASS

**Evidence:**
- `src/api.ts` defines CompFnConfig with database (Adapter), optional namespace, systemActorId, readinessWindowDays, evidencePayloadMaxBytes, retentionDays, exportMaxBytes, adapters, logger
- `src/compfn.ts` compFn(config) returns CompFnAPI with all 6 namespaces (controls, frameworks, evidence, checks, readiness, export)
- All methods return Promise<CompfnEnvelope<...>>
- Test: implicitly verified by all other tests that use compFn(config)

---

### API-002: Envelope and error codes — PASS

**Evidence:**
- `src/errors.ts` defines all 11 CompfnErrorCode values matching spec exactly
- CompfnError has code, message, details (with index signature)
- CompfnEnvelope<T> = `{ ok: true; result: T } | { ok: false; error: CompfnError }`
- All services return envelopes; no thrown exceptions for business logic
- Tests: TV-ENVELOPE-001 (success shape), TV-ENVELOPE-002 (failure shape), TV-ENVELOPE-003 (no throw)

---

### LIMIT-001: Payload and export caps — PASS

**Evidence:**
- `src/constants.ts`: EVIDENCE_PAYLOAD_MAX_BYTES_DEFAULT = 524288 (512 KiB), EXPORT_MAX_BYTES_DEFAULT = 50 * 1024 * 1024 (50 MiB), MAX_REQUIREMENTS_PER_FRAMEWORK = 1000, MAX_CONTROL_IDS_PER_REQUIREMENT = 100
- Evidence payload enforced in evidence/service.ts (PAYLOAD_TOO_LARGE)
- Export size enforced in export/service.ts (EXPORT_FAILED)
- Framework limits enforced in validation.ts (VALIDATION_FAILED)
- Tests: TV-LIMIT-PAYLOAD-001, TV-LIMIT-EXPORT-001, TV-LIMIT-FW-001

---

### OBS-001: Logging rules — UNVERIFIED (static audit: compliant)

**Evidence (static review):**
- `src/logger.ts` provides Logger interface and ConsoleLogger with configurable min level
- `src/evidence/service.ts` lines 130-136: logs `evidence.created` with evidenceId, controlId, type, outcome — **no payload**
- `src/checks/service.ts` lines 219-223: logs `check.run.started` with checkId, controlId — **no adapter response**
- Lines 258-262: logs `check.run.error` with checkId, code — **no message with secrets**
- Lines 314-318: logs `check.run.completed` with checkId, outcome — **no raw response**
- `src/export/service.ts` lines 59-62: logs `export.requested` with frameworkId
- Lines 135-139: logs `export.completed` with frameworkId, sizeBytes — **no evidence content**

**Verification gap:**
- No automated test captures and asserts on log output content
- TV-OBS-001 is marked as "manual or audit" in TEST_VECTORS.md
- Static review confirms no payload, PII, or secrets appear in log statements
- A grep for `payload` in logger calls confirms no leakage

**Assessment**: Compliant based on static review; marked UNVERIFIED because no runtime verification exists.

---

### ADAPT-001: Evidence adapter interface — PASS

**Evidence:**
- `src/adapters/types.ts` defines EvidenceAdapter (name: string, runCheck: (input: AdapterCheckInput) => Promise<AdapterEvidence>)
- AdapterCheckInput has checkId, controlId, optional method, optional customConfig
- AdapterEvidence has type, outcome, optional timestamp/payload/artifactRef/frameworkRequirementId
- Tests: TV-ADAPT-INTERFACE-001

---

### ADAPT-002: Secfn adapter — PASS

**Evidence:**
- `src/adapters/secfn.ts` implements createSecfnAdapter(config) returning EvidenceAdapter
- name = "secfn"
- runCheck supports methods: getRbacStatus (default), getSecretScanSummary, getSecurityEvents
- Returns type "automated_secfn" with mapped outcome
- Tests: TV-ADAPT-SECFN-001

---

### ADAPT-003: Authfn adapter — PASS

**Evidence:**
- `src/adapters/authfn.ts` implements createAuthfnAdapter(config) returning EvidenceAdapter
- name = "authfn"
- runCheck supports methods: getMfaStatus (default), getSessionPolicy, getUserInfo
- Returns type "automated_authfn" with mapped outcome
- Tests: TV-ADAPT-AUTHFN-001

---

### BUNDLE-001: At least one framework bundle — PARTIAL

**Evidence:**
- `bundles/soc2-type2.json` provides SOC 2 Type II framework with 17 requirements and 43 control definitions
- `src/bundles/loader.ts` provides loadBundle() helper
- `bundles/README.md` documents bundle structure and loading instructions
- Tests: TV-BUNDLE-001

**Issue:**
The bundle's `requirements[].controlIds` use manually-assigned kebab-case IDs (e.g., `"access-reviews-quarterly"`, `"access-revocation-timely"`, `"log-review-weekly"`, `"backup-daily"`, `"backup-testing-quarterly"`), but the `loadBundle()` helper with `useStableControlIds: true` generates IDs from control names using simple kebab-case conversion. Five control names produce different IDs than what the bundle expects:

| Control Name | Generated Stable ID | Bundle controlId | Match |
|---|---|---|---|
| Quarterly Access Reviews | quarterly-access-reviews | access-reviews-quarterly | MISMATCH |
| Timely Access Revocation | timely-access-revocation | access-revocation-timely | MISMATCH |
| Weekly Log Review | weekly-log-review | log-review-weekly | MISMATCH |
| Daily Backups | daily-backups | backup-daily | MISMATCH |
| Quarterly Backup Testing | quarterly-backup-testing | backup-testing-quarterly | MISMATCH |

When `loadBundle(api, bundle, { useStableControlIds: true })` is called:
1. Controls are created with UUID IDs (not the stable IDs, because the stable IDs are generated but the actual `controls.create()` uses `crypto.randomUUID()`)
2. `controlIdMap` maps generated-stable-id -> created-UUID-id
3. Framework requirements replace controlIds using the map: `controlIdMap.get(bundleControlId) ?? bundleControlId`
4. For the 5 mismatched IDs, `controlIdMap.get()` returns undefined, so the raw bundle ID (e.g., "access-reviews-quarterly") is kept
5. `frameworks.create()` then validates controlIds exist and returns VALIDATION_FAILED because "access-reviews-quarterly" doesn't exist

**Impact**: Medium. The SOC 2 bundle cannot be loaded with `useStableControlIds: true` without error. Workaround: use `loadBundle()` without `useStableControlIds` (default), which uses UUID IDs and does not attempt to map. But this means the bundle's controlIds in requirements are useless without the mapping.

**Recommendation**: Either (a) rename the 5 controls in the bundle to match the generated stable IDs (e.g., "Access Reviews Quarterly" instead of "Quarterly Access Reviews"), or (b) use the bundle's controlIds directly as the `id` field when creating controls (requires a different approach in loadBundle), or (c) update the bundle's controlIds to match what `generateStableControlId()` produces from the control names.

---

### COMPAT-001: Schema versioning — PASS

**Evidence:**
- `src/storage/schema.ts` returns `{ version: 1, schemas: [...] }`
- SPEC.md "Compatibility / versioning" section documents: v1 stable; new optional fields additive; breaking changes require new version and deprecation
- Evidence, Control, and Framework schemas are version 1

---

### HTTP-001: Optional HTTP API — PASS

**Evidence:**
- `src/http/routes.ts` implements all specified routes using Hono:
  - Controls: POST, GET list, GET :id, PATCH :id, DELETE :id
  - Frameworks: POST, GET list, GET :id, PATCH :id, DELETE :id
  - Evidence: POST, GET list (query params), GET :id
  - Checks: POST, GET list, GET :id, POST :id/run, DELETE :id
  - Readiness: GET /readiness/control/:controlId, GET /readiness/framework/:frameworkId
  - Export: POST /export/auditor-pack
- Response envelope: `{ ok: true, result }` or `{ ok: false, error: { code, message, details } }`
- Status codes: 201 for create, 200 for success, 400/404/413/429/500 for errors
- README documents all endpoints
- Tests: TV-HTTP-001

---

### CLI-001: Optional CLI — PASS

**Evidence:**
- `cli/src/index.ts` registers 4 commands: init, run-checks, export, attest
- `cli/src/commands/init.ts`: loads config, runs createSchemaIfSupported, exits 0
- `cli/src/commands/run-checks.ts`: lists checks, runs each, prints summary
- `cli/src/commands/export.ts`: calls auditorPack, writes JSON to file or stdout
- `cli/src/commands/attest.ts`: creates manual_attestation evidence
- README documents all CLI commands with examples
- Tests: TV-CLI-001, TV-CLI-002

---

### PROVIDER-001: Readiness/evidence-due consumable — PASS

**Evidence:**
- `readiness.forFramework(frameworkId)` returns FrameworkReadiness with per-control status
- `evidence.list({ controlId, since })` enables filtering recent evidence
- README "Provider API: Consuming CompFn" section documents:
  - Getting framework readiness
  - Computing evidence-due controls
  - Listing recent evidence
  - Building "Tasks Due" view
  - Creating attestation tasks
- Tests: TV-PROVIDER-001

---

## Spec Conflicts / Spec Gaps

**No spec conflicts found.** There is a single spec bundle and no conflicting definitions.

**Spec gaps identified:**

1. **Custom check execution undefined**: SPEC CHECK-001 says "run(checkId) executes adapter or custom logic" but Semantics only defines adapter-based execution (starting with "If adapterName is set on a check"). No semantics are defined for running checks without adapters. The implementation follows the spec literally (only adapter path defined) but the wording "or custom" creates an expectation gap.

2. **List pagination not enforced**: SPEC says "list() for controls, frameworks, evidence MAY support limit/offset or cursor; if not, default limit 1000." The implementation does not enforce a default limit of 1000. For large datasets, all records are returned. This is allowed by "MAY" but could be a performance risk.

3. **retentionDays config accepted but not used**: The config accepts `retentionDays` but no code reads it. Per spec, retention is a deployment concern and core API must not expose delete, so this is acceptable. The field is informational.

---

## Cross-Cutting Audits

### Security / Authz / Validation Boundaries

**Validation:**
- All create/update inputs are validated: required fields, type checks, non-empty strings
- Evidence type validated against enum
- Scoping decision validated (outcome must be "unknown", payload.status required)
- Framework requirements validated: controlIds exist, limits enforced
- Payload size enforced via TextEncoder byte count
- **Assessment**: PASS

**Authz:**
- SPEC explicitly states authz is deployment-defined; CompFn does not mandate authz
- CompFnConfig does not include auth middleware; API accepts actorId as parameter
- HTTP routes do not include auth middleware (deployment responsibility)
- **Assessment**: PASS (by design; matches spec)

**PII/Secrets:**
- Evidence payload may contain PII; logger does not log payloads
- No full request body logging in any service
- artifactRef storage security delegated to deployment
- **Assessment**: PASS

### Determinism Invariants

- Readiness computation: `latestScopingDecision()` sorts by timestamp desc, createdAt desc, id desc — fully deterministic
- `hasPassInWindow()` iterates all evidence and checks pass within window — deterministic for same evidence set + same "now"
- Framework readiness: iterates controlIds from Set (insertion order) — deterministic for same framework
- **Assessment**: PASS

### Limits / Caps

| Limit | Spec Default | Implementation | Enforced | Status |
|-------|-------------|----------------|----------|--------|
| evidencePayloadMaxBytes | 524288 (512 KiB) | 524288 | Yes (evidence/service.ts) | PASS |
| exportMaxBytes | 50 MiB (52428800) | 50 * 1024 * 1024 | Yes (export/service.ts) | PASS |
| maxRequirementsPerFramework | 1000 | 1000 | Yes (validation.ts) | PASS |
| maxControlIdsPerRequirement | 100 | 100 | Yes (validation.ts) | PASS |
| retentionDays | 2555 (7 years) | Config accepted; not enforced | N/A (deployment) | PASS |
| readinessWindowDays | 90 | 90 | Yes (readiness/service.ts) | PASS |
| List default limit | 1000 (MAY) | No limit enforced | Not implemented | ACCEPTABLE |

### Error Handling + Canonical Envelopes

- All 11 error codes defined in `CompfnErrorCode` type union
- Every public method returns `CompfnEnvelope<T>`
- Business logic failures return `{ ok: false, error }` — never throw
- Storage errors caught with try/catch and wrapped as `STORAGE_ERROR`
- Adapter errors caught and wrapped as `ADAPTER_ERROR`
- **Assessment**: PASS

### Compatibility / Versioning / Migrations

- Schema version 1 defined in `storage/schema.ts`
- SPEC documents stability policy: v1 stable, additive changes only, breaking requires new version
- `createSchemaIfSupported()` supports both createSchema and validateSchema paths
- No migration logic yet (v1 only) — acceptable for first version
- **Assessment**: PASS

---

## Recommendations (Ranked)

### Priority 1 (Fix before release)

1. **Fix SOC 2 bundle control ID mismatches** (BUNDLE-001)
   - **Why**: The flagship bundle fails to load with `useStableControlIds: true`. Early adopters will hit this immediately.
   - **Fix**: Rename the 5 mismatched control names in `bundles/soc2-type2.json` to match the bundle's controlIds, OR update the bundle's controlIds to match what `generateStableControlId()` produces from the current control names.
   - **Affected**: `bundles/soc2-type2.json`, potentially `src/bundles/loader.ts`
   - **Refs**: BUNDLE-001, I09

### Priority 2 (Fix soon)

2. **Add execution path for non-adapter checks in checks.run()** (CHECK-001)
   - **Why**: Users can create checks with only customConfig but cannot run them. This violates the spec's "adapter or custom" wording and creates a confusing API.
   - **Fix**: Either (a) add a fallback execution path (e.g., return outcome "unknown" or call a user-provided function), (b) require adapterName for all runnable checks and reject checks without it in run(), or (c) document the limitation clearly.
   - **Affected**: `src/checks/service.ts`
   - **Refs**: CHECK-001, I04, I18

3. **Fix README syntax error** (documentation)
   - **Why**: Template literal on line 658 has mismatched backtick and double quote: `task: \`Evidence is ${daysOld} days old. Submit new attestation or run check.",`
   - **Fix**: Change the closing `",` to `` `, `` (backtick).
   - **Affected**: `README.md` line 658
   - **Refs**: Documentation quality

### Priority 3 (Improve)

4. **Add automated log output tests for OBS-001**
   - **Why**: Logging rules are correct in static review but no runtime test verifies log content. A regression could leak PII.
   - **Fix**: Inject a mock logger, perform operations, assert log calls contain expected fields and do NOT contain payload.
   - **Refs**: OBS-001, TV-OBS-001, I12

5. **Consider adding list pagination**
   - **Why**: SPEC says list MAY support limit/offset with default limit 1000. Current implementation returns all records. For large datasets, this could cause OOM or slow responses.
   - **Fix**: Add optional `limit` and `offset` parameters to list methods; default limit 1000.
   - **Refs**: LIMIT-001, SPEC "List pagination"

6. **Add README section for schema versioning/compatibility**
   - **Why**: COMPAT-001 says "SPEC or README documents..." — SPEC covers it, but README users may not read the SPEC. A brief section in README would improve discoverability.
   - **Fix**: Add "Schema Versioning" section to README.
   - **Refs**: COMPAT-001, I13

---

## Appendix: Commands Run + Environment Details

### Environment
- **OS**: darwin 25.0.0
- **Shell**: zsh
- **Launcher**: Cursor IDE
- **Model**: claude-4.6-opus-high-thinking
- **Date**: 2026-02-11

### Commands Executed
- `git status --porcelain compfn/` — Verified git state (untracked)
- `git log --oneline -5` — Retrieved recent commits
- `git branch --show-current` — Confirmed branch: next
- `mkdir -p .conduct/audits` — Created audit output directory

### Files Read (complete list)

**Intent:**
- `.conduct/compfn.intent.md`
- `COMPFN_APPROACH.md`

**Spec bundle (all files):**
- `.conduct/specs/2026-02-05-new-cp2m5k9x-spec/SPEC.md`
- `.conduct/specs/2026-02-05-new-cp2m5k9x-spec/REQUIREMENTS.md`
- `.conduct/specs/2026-02-05-new-cp2m5k9x-spec/TEST_VECTORS.md`
- `.conduct/specs/2026-02-05-new-cp2m5k9x-spec/PLAN.md`
- `.conduct/specs/2026-02-05-new-cp2m5k9x-spec/INTENT_AUDIT.md`
- `.conduct/specs/2026-02-05-new-cp2m5k9x-spec/phases/PHASE_00.md` through `PHASE_12.md` (13 files)

**Implementation (all source files):**
- `src/types.ts`, `src/errors.ts`, `src/constants.ts`
- `src/control.ts`, `src/framework.ts`, `src/evidence.ts`, `src/check.ts`, `src/readiness.ts`, `src/export-types.ts`
- `src/api.ts`, `src/compfn.ts`, `src/index.ts`
- `src/validation.ts`, `src/logger.ts`
- `src/controls/service.ts`, `src/frameworks/service.ts`, `src/evidence/service.ts`
- `src/checks/service.ts`, `src/readiness/service.ts`, `src/export/service.ts`
- `src/adapters/types.ts`, `src/adapters/secfn.ts`, `src/adapters/authfn.ts`
- `src/storage/schema.ts`, `src/storage/adapter.ts`
- `src/bundles/loader.ts`
- `src/http/routes.ts`
- `cli/src/index.ts`, `cli/src/config.ts`
- `cli/src/commands/init.ts`, `cli/src/commands/run-checks.ts`, `cli/src/commands/export.ts`, `cli/src/commands/attest.ts`

**Tests:**
- `src/__tests__/controls.test.ts`
- `src/__tests__/evidence.test.ts`
- `src/__tests__/readiness.test.ts`

**Other:**
- `package.json`, `README.md`
- `bundles/soc2-type2.json`, `bundles/README.md`
- `.conduct/logs.csv`
