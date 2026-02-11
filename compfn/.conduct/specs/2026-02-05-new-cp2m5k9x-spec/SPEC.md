# CompFn Specification

## Metadata

- **timestamp**: 2026-02-05T12:00:00Z (UTC)
- **agent_name**: unknown-agent
- **model**: unknown
- **launcher**: Cursor
- **workspace path**: /Users/ar/dev
- **project root**: /Users/ar/dev/superfunctions/compfn
- **OS**: darwin 25.0.0
- **shell**: zsh
- **repo**:
  - **git repo**: yes (parent superfunctions repo) or unknown if not available
  - **branch**: as available
  - **commit**: as available
  - **dirty**: as available
- **spec_folder**: 2026-02-05-new-cp2m5k9x-spec
- **spec_type**: new
- **spec_id**: cp2m5k9x
- **input paths**:
  - compfn/.conduct/compfn.intent.md
  - compfn/COMPFN_APPROACH.md

## Overview

CompFn is a self-hosted compliance function in the superfunctions ecosystem. It maps **controls** to **frameworks** (SOC 2, ISO 27001, HIPAA, GDPR, etc.), collects **evidence** from superfunctions (authfn, secfn, logfn, watchfn, hostfn, flowfn, filefn, plugfn) and from compfn-native sources (manual attestations, file uploads, questionnaires, custom checks), runs **continuous checks**, and produces **audit-ready reports**. Evidence stays in the deployer's database and storage; there is no requirement to send data to third-party compliance SaaS. CompFn consumes secfn and other superfunctions as evidence sources; it does not implement security controls itself.

**One-sentence goal**: Self-hosted compliance automation that maps controls to frameworks, collects evidence from superfunctions and manual inputs, runs continuous checks, and produces audit-ready reports so teams can achieve and maintain compliance without sending data to vendor SaaS.

**Target users**: Teams and developers who need to achieve or maintain compliance (SOC 2, ISO 27001, HIPAA, GDPR, etc.) and want to keep evidence on their own infrastructure, or who already use superfunctions and want a compliance layer on top.

**Target environments**: Node.js server (primary); optional browser for dashboard. Storage via @superfunctions/db adapters (e.g. Postgres, SQLite). Deployable via hostfn on VPS/cloud.

**Languages/packages**: TypeScript (primary). Optional Python SDK later. Depends on @superfunctions/db for storage. Optional HTTP server for UI and webhooks.

**Existing systems**: Integrates as consumer with authfn, secfn, logfn, watchfn, hostfn, flowfn, filefn, plugfn (read-only evidence adapters). Exposes API for productFn, userfn, flowfn to consume compliance status and attestation workflows.

**Non-goals**: Implementing security controls (RBAC, secrets, scanning)—those remain in secfn. Replacing or duplicating secfn. Mandatory use of any specific superfunction (compfn MUST work with a subset of evidence sources). Mandatory SaaS or cloud service for evidence storage.

**Hard constraints**: Evidence MUST be immutable once stored. Control and framework definitions MUST be data (or code the deployer owns), not a black box. Storage MUST use the same adapter pattern as secfn/datafn (@superfunctions/db). CompFn MUST NOT implement RBAC, secrets vault, or vulnerability scanning; it consumes secfn (or equivalent) for those. All fallible API operations MUST return a canonical envelope with error codes.

## Glossary

- **Control**: A single compliance requirement or practice (e.g. "Access reviews performed quarterly", "Secrets stored in vault"). Primary entity; has id, name, description, category, optional tags. Evidence is attached to controls.
- **Framework**: A compliance standard or certification (e.g. SOC 2 Type II, ISO 27001:2022). Defined as data; contains a mapping from framework requirement IDs to control IDs. One control can satisfy multiple framework requirements.
- **Evidence**: An immutable record that supports a control. Types: `automated_*` (from an integration adapter, e.g. secfn, authfn), `manual_attestation`, `file_upload`, `questionnaire`, `custom_check`, `scoping_decision`. Each evidence has source_id, control_id, timestamp, who (actor), and payload or reference to stored artifact.
- **Evidence type**: Enumeration distinguishing origin: `automated_secfn`, `automated_authfn`, `automated_logfn`, `automated_watchfn`, `automated_hostfn`, `automated_flowfn`, `automated_filefn`, `automated_plugfn`, `manual_attestation`, `file_upload`, `questionnaire`, `custom_check`, `scoping_decision`, `external_webhook` (optional).
- **Check**: A defined runnable that produces evidence for a control. Has name, control_id, schedule (cron or interval) or trigger (event), and execution spec (e.g. adapter name + method, or script/API). Result is stored as evidence (pass/fail, snippet, timestamp).
- **Adapter (evidence adapter)**: A small integration that translates an external system's output (e.g. secfn RBAC status) into one or more evidence records. Pluggable; compfn works with zero or more adapters.
- **Readiness**: Per-framework or per-control status: `compliant` (sufficient evidence within policy), `not_compliant` (insufficient or failed check), `not_applicable`. Includes last evidence date.
- **Auditor pack**: Export artifact containing evidence, control–framework mapping, and dates in a structured format (JSON plus optional PDF/HTML summary) for external auditors.
- **Envelope**: Canonical result type for fallible operations: `{ ok: true, result: T } | { ok: false, error: CompfnError }`.
- **CompfnError**: Error object with code (CompfnErrorCode), message (string), details (object with path, id, etc. as applicable).

## Goals

1. Provide a control registry (CRUD) and framework definitions with control–requirement mapping.
2. Support evidence ingestion from multiple types (automated adapters, manual attestation, file upload, questionnaire, custom check); all evidence immutable and auditable (who, when, what).
3. Support continuous checks: run on schedule or event, store result as evidence, so readiness and gaps are up to date.
4. Provide readiness views per framework and per control (compliant / not compliant / not applicable) with last evidence date.
5. Provide export of auditor pack (evidence + mapping + dates) in structured format (JSON; optional PDF/HTML summary).
6. Support pluggable evidence adapters for authfn, secfn, logfn, watchfn, hostfn, flowfn, filefn, plugfn; compfn MUST work when only a subset (including none) of adapters are configured.
7. Ship at least one framework bundle (e.g. SOC 2 Type II or ISO 27001) as data so early adopters get value without building mappings from scratch.
8. Expose programmatic API (SDK) and optional HTTP API for UI, webhooks, and cross-service evidence collection.
9. Use @superfunctions/db storage adapter; no mandatory external SaaS; evidence stays in deployer's DB and optional object storage for files.
10. Define error codes and failure behavior for all fallible operations; use canonical envelope for I/O.
11. Define observability: what MUST be logged (evidence ingestion, check runs, export) and what MUST NOT be logged (raw evidence payloads that may contain PII/secrets in production).
12. Define versioning and compatibility for control/framework schema and evidence model so evidence and mappings remain valid across upgrades.
13. Define limits: max evidence payload size, retention defaults, export size caps.
14. Optional: CLI (init, run checks, export report, attest); optional dashboard; optional provider API for productFn/userfn/flowfn (compliance status, evidence-due tasks).

## Non-goals

- Implementing security controls (RBAC, secrets, scanning)—secfn owns those.
- Mandatory integration with all eight superfunctions; subset is valid.
- MVP or "manual evidence only" subset; full scope is in scope; priorities indicate sequencing only.
- Native mobile app; real-time collaborative editing of evidence; ML-based control suggestions.

## Public API

### Core SDK (compfn or @compfn/core)

```typescript
// --- Errors ---
export type CompfnErrorCode =
  | "CONTROL_NOT_FOUND"
  | "FRAMEWORK_NOT_FOUND"
  | "EVIDENCE_NOT_FOUND"
  | "CHECK_NOT_FOUND"
  | "VALIDATION_FAILED"    // payload/schema validation
  | "ADAPTER_NOT_FOUND"
  | "ADAPTER_ERROR"        // evidence adapter threw or failed
  | "STORAGE_ERROR"
  | "EXPORT_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED";

export interface CompfnError {
  code: CompfnErrorCode;
  message: string;
  details: { path?: string; id?: string; controlId?: string; frameworkId?: string; [key: string]: unknown };
}

export type CompfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: CompfnError };

// --- Control ---
export interface Control {
  id: string;
  name: string;
  description: string;
  category: string;
  tags?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateControlInput {
  name: string;
  description: string;
  category: string;
  tags?: string[];
}

export interface UpdateControlInput {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
}

// --- Framework ---
export interface FrameworkRequirement {
  requirementId: string;  // e.g. "CC6.1"
  controlIds: string[];
  name?: string;
}

export interface Framework {
  id: string;
  name: string;
  version?: string;       // e.g. "2022"
  description?: string;
  requirements: FrameworkRequirement[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateFrameworkInput {
  name: string;
  version?: string;
  description?: string;
  requirements: FrameworkRequirement[];
}

// --- Evidence ---
export type EvidenceType =
  | "automated_secfn" | "automated_authfn" | "automated_logfn" | "automated_watchfn"
  | "automated_hostfn" | "automated_flowfn" | "automated_filefn" | "automated_plugfn"
  | "manual_attestation" | "file_upload" | "questionnaire" | "custom_check"
  | "scoping_decision"
  | "external_webhook";

export interface Evidence {
  id: string;
  controlId: string;
  type: EvidenceType;
  sourceId?: string;      // adapter or check id
  frameworkRequirementId?: string;
  timestamp: number;
  actorId: string;        // who created/triggered (user or system)
  outcome: "pass" | "fail" | "unknown";
  payload?: Record<string, unknown>;  // or summary; raw stored separately if large
  artifactRef?: string;  // reference to file/store for file_upload or large payload
  createdAt: number;
}

export interface CreateEvidenceInput {
  controlId: string;
  type: EvidenceType;
  sourceId?: string;
  frameworkRequirementId?: string;
  timestamp?: number;      // event time; defaults to now when omitted
  actorId: string;
  outcome: "pass" | "fail" | "unknown";
  payload?: Record<string, unknown>;
  artifactRef?: string;
}

// --- Check ---
export interface CheckDefinition {
  id: string;
  name: string;
  controlId: string;
  schedule?: string;      // cron or interval description
  trigger?: string;       // event name
  adapterName?: string;   // e.g. "secfn"
  adapterMethod?: string; // e.g. "getRbacStatus"
  customConfig?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface RunCheckResult {
  checkId: string;
  controlId: string;
  evidenceId: string;
  outcome: "pass" | "fail" | "unknown";
  timestamp: number;
}

// --- Readiness ---
export type ReadinessStatus = "compliant" | "not_compliant" | "not_applicable";

export interface ControlReadiness {
  controlId: string;
  status: ReadinessStatus;
  lastEvidenceAt?: number;
  lastEvidenceId?: string;
  requirementIds?: string[];
}

export interface FrameworkReadiness {
  frameworkId: string;
  status: ReadinessStatus;
  controlReadiness: ControlReadiness[];
  lastUpdated: number;
}

// --- Export ---
export interface AuditorPack {
  exportedAt: number;
  frameworkId?: string;   // if scoped to one framework
  controls: Control[];
  frameworks: Framework[];
  evidence: Evidence[];
  mapping: Array<{ requirementId: string; controlIds: string[] }>;
}

// --- CompFn config and API ---
export interface CompFnConfig {
  database: Adapter;      // @superfunctions/db adapter
  namespace?: string;      // table prefix, e.g. "compfn"
  systemActorId?: string;  // default "system" (used for automated evidence/check runs)
  readinessWindowDays?: number; // default 90 (freshness window for readiness)
  evidencePayloadMaxBytes?: number;
  retentionDays?: number;
  exportMaxBytes?: number;
  adapters?: Record<string, EvidenceAdapter>;
}

export interface AdapterCheckInput {
  checkId: string;
  controlId: string;
  method?: string;        // from CheckDefinition.adapterMethod
  customConfig?: Record<string, unknown>;
}

export interface AdapterEvidence {
  // Evidence fields the adapter can supply; CompFn persists via evidence.create().
  // controlId/actorId/sourceId are set/overridden by CompFn for check runs.
  type: EvidenceType;
  outcome: "pass" | "fail" | "unknown";
  timestamp?: number;
  payload?: Record<string, unknown>;
  artifactRef?: string;
  frameworkRequirementId?: string;
}

export interface EvidenceAdapter {
  name: string;
  runCheck(input: AdapterCheckInput): Promise<AdapterEvidence>;
}

export interface CompFnAPI {
  // Controls
  controls: {
    create(input: CreateControlInput): Promise<CompfnEnvelope<Control>>;
    get(id: string): Promise<CompfnEnvelope<Control>>;
    list(filters?: { category?: string; tags?: string[] }): Promise<CompfnEnvelope<Control[]>>;
    update(id: string, input: UpdateControlInput): Promise<CompfnEnvelope<Control>>;
    delete(id: string): Promise<CompfnEnvelope<void>>;
  };
  // Frameworks
  frameworks: {
    create(input: CreateFrameworkInput): Promise<CompfnEnvelope<Framework>>;
    get(id: string): Promise<CompfnEnvelope<Framework>>;
    list(): Promise<CompfnEnvelope<Framework[]>>;
    update(id: string, input: Partial<CreateFrameworkInput>): Promise<CompfnEnvelope<Framework>>;
    delete(id: string): Promise<CompfnEnvelope<void>>;
  };
  // Evidence
  evidence: {
    create(input: CreateEvidenceInput): Promise<CompfnEnvelope<Evidence>>;
    get(id: string): Promise<CompfnEnvelope<Evidence>>;
    list(filters: {
      controlId?: string;
      frameworkId?: string;
      type?: EvidenceType;
      since?: number; // evidence.timestamp >= since
    }): Promise<CompfnEnvelope<Evidence[]>>;
    // No update/delete: evidence is immutable
  };
  // Checks
  checks: {
    create(definition: Omit<CheckDefinition, "id" | "createdAt" | "updatedAt">): Promise<CompfnEnvelope<CheckDefinition>>;
    get(id: string): Promise<CompfnEnvelope<CheckDefinition>>;
    list(): Promise<CompfnEnvelope<CheckDefinition[]>>;
    run(id: string): Promise<CompfnEnvelope<RunCheckResult>>;
    delete(id: string): Promise<CompfnEnvelope<void>>;
  };
  // Readiness
  readiness: {
    forControl(controlId: string, frameworkId?: string): Promise<CompfnEnvelope<ControlReadiness>>;
    forFramework(frameworkId: string): Promise<CompfnEnvelope<FrameworkReadiness>>;
  };
  // Export
  export: {
    auditorPack(options: { frameworkId?: string; since?: number /* evidence.timestamp >= since */ }): Promise<CompfnEnvelope<AuditorPack>>;
  };
}

export function compFn(config: CompFnConfig): CompFnAPI;
```

### HTTP API (optional)

When server is enabled, the following MUST be available (exact paths and methods are implementation-defined but MUST be documented):

- `POST /controls`, `GET /controls`, `GET /controls/:id`, `PATCH /controls/:id`, `DELETE /controls/:id`
- `POST /frameworks`, `GET /frameworks`, `GET /frameworks/:id`, `PATCH /frameworks/:id`, `DELETE /frameworks/:id`
- `POST /evidence`, `GET /evidence`, `GET /evidence/:id` (list supports query params: controlId, frameworkId, type, since)
- `POST /checks`, `GET /checks`, `GET /checks/:id`, `POST /checks/:id/run`, `DELETE /checks/:id`
- `GET /readiness/control/:controlId`, `GET /readiness/framework/:frameworkId`
- `POST /export/auditor-pack` (body: { frameworkId?, since? })

All fallible endpoints MUST return JSON envelope: `{ ok: true, result }` or `{ ok: false, error: { code, message, details } }`. HTTP status: 2xx for success, 4xx/5xx for failure; code in body is authoritative.

### CLI (optional)

- `compfn init` — Initialize config and DB schema.
- `compfn run-checks [--check-id id]` — Run checks (all or one).
- `compfn export --framework-id <id> [--output path]` — Export auditor pack.
- `compfn attest --control-id <id> --actor-id <id> [--outcome pass|fail]` — Submit manual attestation (prompt or args).

## Data formats / protocol

- **Envelope**: Every fallible public method returns `CompfnEnvelope<T>`. Success: `{ ok: true, result: T }`. Failure: `{ ok: false, error: CompfnError }`.
- **IDs**: Control, Framework, Evidence, Check use opaque string IDs (UUID or nanoid). Returned in get/create/list.
- **Timestamps**: Unix milliseconds (number).
  - Evidence has both `timestamp` (event time) and `createdAt` (ingestion time). `timestamp` SHOULD represent when the control-relevant event happened; `createdAt` is when CompFn stored it.
  - `evidence.create()` MUST set `createdAt = now`. If `CreateEvidenceInput.timestamp` is provided it MUST be used; otherwise it MUST default to `now`.
  - `exportedAt` in auditor packs MUST be the actual export time.
- **Evidence payload**: JSON-serializable object. Size MUST NOT exceed `evidencePayloadMaxBytes` (default 512 KiB). Larger content MUST use artifactRef (store separately, reference by key).
- **Auditor pack**: JSON object with exportedAt, frameworkId?, controls, frameworks, evidence, mapping. Optional PDF/HTML summary is implementation-defined format.

## Semantics

- **Controls**: Create assigns id and timestamps. Update does not change id; updatedAt changes. Delete is hard-delete (or soft-delete if specified in config); evidence that referenced the control MAY retain controlId for historical export.
- **Frameworks**: Same as controls. Requirements array is full replacement on update unless partial update is specified.
- **Evidence**: Create only; no update or delete. Immutable. actorId and timestamp and outcome MUST be stored. payload size enforced at create; excess MUST return PAYLOAD_TOO_LARGE.
- **Scoping decisions**: Evidence of type `scoping_decision` is used to mark a control as `not_applicable` (or back to `applicable`) in an auditable, immutable way. For `scoping_decision`:
  - `outcome` MUST be `"unknown"`.
  - `payload.status` MUST be `"applicable"` or `"not_applicable"`.
  - `payload.reason` SHOULD be a human-readable string explaining the scoping decision.
- **Checks**: run(id) executes the check (adapter or custom), creates one evidence record linked to check's controlId, returns RunCheckResult with evidenceId. If check execution throws, return ADAPTER_ERROR envelope; evidence MAY still be stored with outcome "fail" and error snippet.
- **Checks** (adapters): If `adapterName` is set on a check, `checks.run()` MUST:
  - Look up `config.adapters[adapterName]`; if missing return `ADAPTER_NOT_FOUND` with details.adapterName.
  - Call `adapter.runCheck({ checkId, controlId, method: adapterMethod, customConfig })`.
  - Persist one evidence record via `evidence.create()` using the check's `controlId`, `sourceId = checkId`, `actorId = config.systemActorId ?? "system"`, and adapter-provided fields (`type`, `outcome`, `payload`, `artifactRef`, `frameworkRequirementId`, `timestamp`).
  - If adapter throws, return `ADAPTER_ERROR` (and MAY also store a fail evidence with a redacted error summary).
- **Readiness**: forControl(controlId) aggregates evidence for that control.
  - If the latest `scoping_decision` evidence for the control has `payload.status === "not_applicable"`, readiness MUST be `not_applicable`.
  - Otherwise, readiness is `compliant` if there is at least one `"pass"` evidence (excluding `scoping_decision`) with `timestamp` within the policy window (`config.readinessWindowDays ?? 90`); otherwise `not_compliant`.
  - forFramework(frameworkId) aggregates all controls mapped to that framework and computes overall and per-control readiness. Overall status MUST be `not_compliant` if any control is `not_compliant`; otherwise `compliant` if all are `compliant` or `not_applicable`.
- **Export**: auditorPack() returns all controls, frameworks, evidence (optionally filtered by frameworkId and since), and mapping. Size of result MAY be capped; exportMaxBytes overflow MUST return EXPORT_FAILED with details.

## Invariants

- **Evidence immutability**: Once evidence is created, it MUST NOT be updated or deleted by the core API. (Audit trail integrity.)
- **Control–evidence link**: Every evidence record has controlId; control MUST exist at create time; if control is later deleted, evidence MAY still reference controlId for historical export.
- **Framework–control mapping**: Framework.requirements[].controlIds MUST reference existing control IDs at framework create/update time; validation MUST reject unknown control IDs with VALIDATION_FAILED.
- **Envelope consistency**: All public methods that can fail MUST return CompfnEnvelope; no thrown exceptions for business logic failures (only for programming errors or OOM).
- **Determinism**: Readiness computation MUST be deterministic for the same evidence set, policy, and evaluation time (same inputs + same `now` → same status). List ordering MAY be deterministic (e.g. by createdAt desc) and MUST be documented. Timestamps in evidence and export are actual wall-clock time, not deterministic.

## Security

- **Authz**: This spec does not mandate a specific authn/authz model. Implementations MAY delegate to authfn or application middleware. When authz is used: who can create/update controls and frameworks, who can create evidence (including attestations), who can run checks and export MUST be defined by the deployment. CompFn API MAY accept an optional actorId/tenantId context for multi-tenant isolation.
- **Validation**: All create/update inputs MUST be validated (required fields, id format, payload size). Invalid input MUST return VALIDATION_FAILED with path/details.
- **PII/secrets**: Evidence payload may contain PII or secrets. Implementations MUST NOT log raw payloads in production (see Observability). Artifact storage (file_upload) MUST use same security as application (e.g. signed URLs, access control).

## Limits / caps

- **evidencePayloadMaxBytes**: Default 512 KiB (524288). Payloads larger MUST use artifactRef. Configurable in CompFnConfig.
- **retentionDays**: Default 2555 (7 years). Retention is a deployment concern:
  - Core APIs MUST NOT expose evidence update/delete (immutability).
  - Implementations MAY archive older evidence payloads/artifacts (e.g. move files to cold storage, or remove payload while keeping immutable metadata) but SHOULD preserve enough metadata for audit exports and traceability.
  - Full deletion of evidence metadata is outside the core API surface and MUST be explicitly documented by the deployment if performed.
- **exportMaxBytes**: Default 50 MiB for single auditor pack response. Larger exports MAY be streamed or split; overflow MUST return EXPORT_FAILED.
- **Max controls per framework**: 1000 requirements per framework. Max control IDs per requirement: 100. Validation MUST reject excess with VALIDATION_FAILED.
- **List pagination**: list() for controls, frameworks, evidence MAY support limit/offset or cursor; if not, default limit 1000. Oversized list MAY be truncated or return error; MUST be documented.

## Observability

- **MUST log** (at configurable level, e.g. info): Evidence created (evidenceId, controlId, type, outcome; no payload). Check run started and completed (checkId, controlId, outcome). Export requested and completed (frameworkId, size). Adapter errors (adapter name, error code; no payload).
- **MUST NOT log**: Full evidence payload or artifact content. PII or secrets in evidence. Raw request bodies that contain evidence payloads in production.
- **MAY emit**: Metrics (count of evidence by type, check run duration, export size). Events for productFn/flowfn (e.g. "evidence.created", "readiness.changed"). Optional and implementation-defined.

## Compatibility / versioning

- **Control schema**: Version 1. New fields MAY be added with optional semantics. Breaking changes (removing required fields, changing semantics) require a new schema version and MUST be documented; evidence and controls from v1 remain readable.
- **Framework schema**: Same as control. requirements shape is stable; new optional fields allowed.
- **Evidence schema**: version field MAY be added. Existing evidence without version is treated as v1. New evidence types (e.g. external_webhook) are additive.
- **API**: Semver for package. Major bump for breaking CompFnAPI or envelope changes. New optional methods or optional parameters are minor.

## Undefined / explicitly user-deferred only

- Python SDK (optional; not required for this spec).
- Exact HTTP paths and auth middleware (implementation-defined; MUST be documented).
- Dashboard UI layout and components (optional feature).
- Multi-tenant isolation implementation (optional; data model may support tenantId; authz is deployment-defined).
- PDF/HTML export format (optional; structure of JSON auditor pack is specified).
- Specific framework bundle content (SOC 2 vs ISO 27001); at least one bundle is required; which one is implementation or bundle choice.
