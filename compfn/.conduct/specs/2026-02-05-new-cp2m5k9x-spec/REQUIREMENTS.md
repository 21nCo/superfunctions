# CompFn Requirements

## Table of Contents

### P0 (Core)

- CTRL-001: Control CRUD and schema
- CTRL-002: Control–evidence link validation
- FW-001: Framework CRUD and requirement mapping
- FW-002: Framework requirement control IDs validation
- EVID-001: Evidence create and immutability
- EVID-002: Evidence types and payload size
- EVID-003: Evidence list and get
- CHECK-001: Check definition and run
- CHECK-002: Check stores result as evidence
- READY-001: Readiness for control and framework
- EXPORT-001: Auditor pack export
- API-001: compFn config and storage adapter
- API-002: Envelope and error codes
- LIMIT-001: Payload and export caps
- OBS-001: Logging rules

### P1 (Adapters and bundles)

- ADAPT-001: Evidence adapter interface
- ADAPT-002: Secfn adapter
- ADAPT-003: Authfn adapter
- BUNDLE-001: At least one framework bundle
- COMPAT-001: Schema versioning

### P2 (Server, CLI, provider)

- HTTP-001: Optional HTTP API
- CLI-001: Optional CLI (init, run-checks, export, attest)
- PROVIDER-001: Readiness/evidence-due consumable by productFn/flowfn

---

## P0 Requirements

### CTRL-001: Control CRUD and schema

**Priority**: P0  
**Statement**: The core MUST provide control create, get, list (with optional category/tags filter), update, and delete. Control schema MUST include id, name, description, category, tags (optional), createdAt, updatedAt.  
**Rationale**: Control registry is the primary entity; all evidence and frameworks reference controls.  
**Acceptance criteria**:
- create(input) returns envelope with Control (id and timestamps set).
- get(id) returns CONTROL_NOT_FOUND when id does not exist; otherwise Control.
- list() returns array; list({ category }) filters by category; list({ tags }) filters by tags (AND/OR semantics documented).
- update(id, input) updates only provided fields; returns CONTROL_NOT_FOUND when id does not exist.
- delete(id) removes control; returns CONTROL_NOT_FOUND when id does not exist.
**Test vectors**: TV-CTRL-CREATE-001, TV-CTRL-GET-001, TV-CTRL-GET-002, TV-CTRL-LIST-001, TV-CTRL-UPDATE-001, TV-CTRL-DELETE-001  
**Notes**: Evidence that referenced deleted control may retain controlId for historical export; list evidence by controlId may return evidence for deleted control.

---

### CTRL-002: Control–evidence link validation

**Priority**: P0  
**Statement**: When creating evidence, controlId MUST reference an existing control. If controlId does not exist, create MUST return VALIDATION_FAILED with details.controlId.  
**Rationale**: Evidence must attach to a valid control.  
**Acceptance criteria**:
- evidence.create({ controlId: "nonexistent", ... }) returns { ok: false, error: { code: "VALIDATION_FAILED", details: { controlId: "nonexistent" or similar } } }.
- evidence.create({ controlId: existingControl.id, ... }) succeeds when control exists.
**Test vectors**: TV-EVID-CONTROL-LINK-001, TV-EVID-CONTROL-LINK-002  
**Notes**: None.

---

### FW-001: Framework CRUD and requirement mapping

**Priority**: P0  
**Statement**: The core MUST provide framework create, get, list, update, delete. Framework schema MUST include id, name, version (optional), description (optional), requirements (array of { requirementId, controlIds, name? }), createdAt, updatedAt.  
**Rationale**: Frameworks map requirements to controls; needed for readiness and export.  
**Acceptance criteria**:
- create(input) returns Framework with id and timestamps.
- get(id), list(), update(id, input), delete(id) behave as for controls; FRAMEWORK_NOT_FOUND when id does not exist.
- requirements array is stored and returned in full.
**Test vectors**: TV-FW-CREATE-001, TV-FW-GET-001, TV-FW-GET-002, TV-FW-LIST-001  
**Notes**: None.

---

### FW-002: Framework requirement control IDs validation

**Priority**: P0  
**Statement**: On framework create and update, every controlId in requirements[].controlIds MUST reference an existing control. If any controlId does not exist, create/update MUST return VALIDATION_FAILED with path/details indicating the requirement and controlId.  
**Rationale**: Prevents broken mappings.  
**Acceptance criteria**:
- frameworks.create({ name: "F", requirements: [{ requirementId: "R1", controlIds: ["nonexistent"] }] }) returns VALIDATION_FAILED.
- When all controlIds exist, create/update succeeds.
**Test vectors**: TV-FW-VALIDATE-CONTROLS-001, TV-FW-VALIDATE-CONTROLS-002  
**Notes**: None.

---

### EVID-001: Evidence create and immutability

**Priority**: P0  
**Statement**: Evidence MUST be created via evidence.create(input). Evidence MUST NOT have update or delete in the public API; once created, records are immutable.  
**Rationale**: Audit trail integrity.  
**Acceptance criteria**:
- evidence.create(validInput) returns { ok: true, result: Evidence } with id, controlId, type, timestamp, actorId, outcome, createdAt.
- No evidence.update or evidence.delete methods on CompFnAPI.
- Re-reading evidence by id returns same record (immutable).
**Test vectors**: TV-EVID-CREATE-001, TV-EVID-IMMUTABLE-001  
**Notes**: Internal purge/archive by retention policy is implementation-defined; not exposed as delete.

---

### EVID-002: Evidence types and payload size

**Priority**: P0  
**Statement**: Evidence type MUST be one of the defined EvidenceType enum values (including `scoping_decision`). Payload size (JSON-serialized payload) MUST NOT exceed evidencePayloadMaxBytes (default 512 KiB). If exceeded, create MUST return PAYLOAD_TOO_LARGE. For `scoping_decision`, outcome MUST be `unknown` and payload MUST include a scoping status.  
**Rationale**: Type safety and resource limits.  
**Acceptance criteria**:
- evidence.create({ ..., type: "manual_attestation", payload: {...} }) with payload size ≤ limit succeeds.
- evidence.create({ ..., type: "invalid_type" }) returns VALIDATION_FAILED.
- evidence.create({ controlId: c.id, type: "scoping_decision", actorId: "user1", outcome: "unknown", payload: { status: "not_applicable", reason: "Out of scope for this system" } }) succeeds.
- evidence.create({ controlId: c.id, type: "scoping_decision", actorId: "user1", outcome: "pass", payload: { status: "not_applicable" } }) returns VALIDATION_FAILED.
- evidence.create with payload size > evidencePayloadMaxBytes returns { ok: false, error: { code: "PAYLOAD_TOO_LARGE" } }.
**Test vectors**: TV-EVID-TYPE-001, TV-EVID-TYPE-002, TV-EVID-SCOPING-001, TV-EVID-SCOPING-002, TV-EVID-PAYLOAD-SIZE-001, TV-EVID-PAYLOAD-SIZE-002  
**Notes**: artifactRef for large content is optional; when used, payload may be summary only.

---

### EVID-003: Evidence list and get

**Priority**: P0  
**Statement**: evidence.get(id) MUST return EVIDENCE_NOT_FOUND when id does not exist; otherwise the Evidence record. evidence.list(filters) MUST support controlId, frameworkId (via framework's requirements), type, since (timestamp); return array of matching evidence.  
**Rationale**: Read and query evidence for readiness and export.  
**Acceptance criteria**:
- get("nonexistent") returns { ok: false, error: { code: "EVIDENCE_NOT_FOUND" } }.
- list({ controlId: c.id }) returns only evidence for that control.
- list({ since: t }) returns evidence with timestamp >= t.
**Test vectors**: TV-EVID-GET-001, TV-EVID-GET-002, TV-EVID-LIST-001, TV-EVID-LIST-002  
**Notes**: frameworkId filter implies “evidence for controls that are in this framework's requirements”.

---

### CHECK-001: Check definition and run

**Priority**: P0  
**Statement**: checks.create(definition) MUST store CheckDefinition with id, controlId, name, and either schedule/trigger and adapterName/adapterMethod or customConfig. checks.run(id) MUST execute the check and return RunCheckResult (checkId, controlId, evidenceId, outcome, timestamp). If check id does not exist, run MUST return CHECK_NOT_FOUND.  
**Rationale**: Continuous monitoring; checks produce evidence.  
**Acceptance criteria**:
- create(definition) returns CheckDefinition with id.
- run(checkId) executes adapter or custom logic; creates one evidence; returns RunCheckResult with evidenceId.
- run("nonexistent") returns { ok: false, error: { code: "CHECK_NOT_FOUND" } }.
- If check has adapterName but config has no adapter for that name, run returns { ok: false, error: { code: "ADAPTER_NOT_FOUND" } }.
- If execution throws, run returns ADAPTER_ERROR (and may store evidence with outcome "fail").
**Test vectors**: TV-CHECK-CREATE-001, TV-CHECK-RUN-001, TV-CHECK-RUN-002, TV-CHECK-RUN-003, TV-CHECK-RUN-004  
**Notes**: Schedule/trigger execution (cron/event) is implementation-defined; run() is explicit execution.

---

### CHECK-002: Check stores result as evidence

**Priority**: P0  
**Statement**: When a check runs successfully (or fails with stored result), the result MUST be stored as an evidence record with controlId equal to the check's controlId, type appropriate to adapter (e.g. automated_secfn) or custom_check, outcome pass/fail/unknown, and timestamp.  
**Rationale**: Evidence is the record of compliance check.  
**Acceptance criteria**:
- After run(checkId) returns { ok: true, result }, evidence.get(result.evidenceId) returns the new evidence; evidence.controlId === check.controlId.
**Test vectors**: TV-CHECK-EVIDENCE-001  
**Notes**: None.

---

### READY-001: Readiness for control and framework

**Priority**: P0  
**Statement**: readiness.forControl(controlId, frameworkId?) MUST return ControlReadiness (controlId, status, lastEvidenceAt?, lastEvidenceId?, requirementIds?). readiness.forFramework(frameworkId) MUST return FrameworkReadiness (frameworkId, status, controlReadiness[], lastUpdated). Status MUST be compliant | not_compliant | not_applicable. Logic MUST be deterministic for same evidence set.  
**Rationale**: Readiness views are core value.  
**Acceptance criteria**:
- For control with at least one pass evidence in policy window, status is compliant (or as defined by policy).
- For control with no evidence or only fail, status is not_compliant (when applicable).
- For control with latest scoping decision evidence marking not applicable, status is not_applicable.
- forControl("nonexistent") returns CONTROL_NOT_FOUND; forFramework("nonexistent") returns FRAMEWORK_NOT_FOUND.
- Same evidence set and policy yields same status on repeated calls.
**Test vectors**: TV-READY-CONTROL-001, TV-READY-CONTROL-002, TV-READY-CONTROL-003, TV-READY-FRAMEWORK-001, TV-READY-FRAMEWORK-002  
**Notes**: Exact policy (e.g. “last 90 days”, “at least one pass”) is implementation-defined but MUST be documented.

---

### EXPORT-001: Auditor pack export

**Priority**: P0  
**Statement**: export.auditorPack({ frameworkId?, since? }) MUST return AuditorPack (exportedAt, frameworkId?, controls, frameworks, evidence, mapping). If frameworkId provided, scope controls and evidence to that framework. If since provided, evidence filtered by timestamp >= since. Result size MUST NOT exceed exportMaxBytes; otherwise return EXPORT_FAILED.  
**Rationale**: Audit-ready artifact for auditors.  
**Acceptance criteria**:
- auditorPack() returns object with exportedAt, controls, frameworks, evidence, mapping.
- auditorPack({ frameworkId: f.id }) returns only controls/evidence relevant to that framework.
- When result would exceed exportMaxBytes, return { ok: false, error: { code: "EXPORT_FAILED" } }.
**Test vectors**: TV-EXPORT-001, TV-EXPORT-002, TV-EXPORT-003  
**Notes**: PDF/HTML summary is optional and not required by this requirement.

---

### API-001: compFn config and storage adapter

**Priority**: P0  
**Statement**: compFn(config) MUST accept CompFnConfig with database (adapter from @superfunctions/db), optional namespace, optional evidencePayloadMaxBytes, retentionDays, exportMaxBytes, and optional adapters. It MUST return CompFnAPI with controls, frameworks, evidence, checks, readiness, export namespaces as specified in Public API.  
**Rationale**: Entry point and storage contract.  
**Acceptance criteria**:
- compFn({ database: adapter }) returns object with controls.*, frameworks.*, evidence.*, checks.*, readiness.*, export.*.
- All methods exist and return Promise<CompfnEnvelope<...>> where specified.
**Test vectors**: TV-API-CONFIG-001  
**Notes**: Adapter type is implementation-defined to match @superfunctions/db adapter interface.

---

### API-002: Envelope and error codes

**Priority**: P0  
**Statement**: All fallible public methods MUST return CompfnEnvelope<T>. Error branch MUST use CompfnError with code (CompfnErrorCode), message (string), details (object). Codes MUST include CONTROL_NOT_FOUND, FRAMEWORK_NOT_FOUND, EVIDENCE_NOT_FOUND, CHECK_NOT_FOUND, VALIDATION_FAILED, ADAPTER_NOT_FOUND, ADAPTER_ERROR, STORAGE_ERROR, EXPORT_FAILED, PAYLOAD_TOO_LARGE, RATE_LIMITED.  
**Rationale**: Consistent, machine-readable error handling.  
**Acceptance criteria**:
- Success: { ok: true, result }.
- Failure: { ok: false, error: { code, message, details } }.
- No thrown exceptions for business logic failures (only for programming errors).
**Test vectors**: TV-ENVELOPE-001, TV-ENVELOPE-002, TV-ENVELOPE-003  
**Notes**: None.

---

### LIMIT-001: Payload and export caps

**Priority**: P0  
**Statement**: evidencePayloadMaxBytes default MUST be 524288 (512 KiB). exportMaxBytes default MUST be 50 MiB. Max requirements per framework 1000; max controlIds per requirement 100. Validation MUST reject excess with VALIDATION_FAILED.  
**Rationale**: Prevent abuse and OOM.  
**Acceptance criteria**:
- Payload over evidencePayloadMaxBytes → PAYLOAD_TOO_LARGE.
- Export over exportMaxBytes → EXPORT_FAILED.
- Framework with > 1000 requirements or requirement with > 100 controlIds → VALIDATION_FAILED.
**Test vectors**: TV-LIMIT-PAYLOAD-001, TV-LIMIT-EXPORT-001, TV-LIMIT-FW-001  
**Notes**: None.

---

### OBS-001: Logging rules

**Priority**: P0  
**Statement**: Implementation MUST log evidence created (evidenceId, controlId, type, outcome; no payload). MUST log check run started/completed (checkId, controlId, outcome). MUST log export requested/completed (frameworkId, size). Implementation MUST NOT log full evidence payload or artifact content, or PII/secrets, in production.  
**Rationale**: Observability without leaking sensitive data.  
**Acceptance criteria**:
- When evidence is created, at least one log line contains evidenceId and controlId and type and outcome; no line contains full payload.
- When check runs, log contains checkId and outcome; no raw adapter response with secrets.
- When export runs, log contains frameworkId and size or success; no full evidence dump in log.
**Test vectors**: TV-OBS-001 (manual or audit)  
**Notes**: Log level and format are implementation-defined.

---

## P1 Requirements

### ADAPT-001: Evidence adapter interface

**Priority**: P1  
**Statement**: EvidenceAdapter MUST have name (string) and runCheck(input): Promise<AdapterEvidence> where input includes checkId, controlId, and optional method/customConfig. Config MAY pass adapters in CompFnConfig.adapters. When checks run with adapterName, the corresponding adapter's runCheck MUST be invoked. Adapter results are persisted via evidence.create (adapter does not mint Evidence IDs).  
**Rationale**: Pluggable integrations with superfunctions.  
**Acceptance criteria**:
- Object with name and runCheck returning Promise<{ type, outcome, ... }> is a valid EvidenceAdapter.
- compFn({ database, adapters: { secfn: secfnAdapter } }) accepts and stores adapters; check run with adapterName "secfn" uses that adapter.
**Test vectors**: TV-ADAPT-INTERFACE-001  
**Notes**: runCheck may use input.method (from CheckDefinition.adapterMethod) to select an operation (e.g. "getRbacStatus").

---

### ADAPT-002: Secfn adapter

**Priority**: P1  
**Statement**: A secfn evidence adapter MUST be provided (in core or separate package) that implements EvidenceAdapter, calls secfn (or configured secfn client) for RBAC status, secret-scan summary, or security events, and returns AdapterEvidence that can be persisted as evidence with type automated_secfn.  
**Rationale**: Secfn is primary evidence source per intent.  
**Acceptance criteria**:
- Adapter.name is "secfn" or equivalent; runCheck() returns { type: "automated_secfn", outcome, ... }.
- At least one control (e.g. "RBAC enabled") can be evidenced by this adapter.
**Test vectors**: TV-ADAPT-SECFN-001  
**Notes**: Adapter may require secfn client to be passed in; exact API is implementation-defined.

---

### ADAPT-003: Authfn adapter

**Priority**: P1  
**Statement**: An authfn evidence adapter MUST be provided that implements EvidenceAdapter, calls authfn for user/MFA/session policy info, and returns AdapterEvidence that can be persisted as evidence with type automated_authfn.  
**Rationale**: Identity and access evidence.  
**Acceptance criteria**:
- Adapter implements EvidenceAdapter; runCheck() returns { type: "automated_authfn", outcome, ... }; at least one control (e.g. "MFA enforced") can be evidenced.
**Test vectors**: TV-ADAPT-AUTHFN-001  
**Notes**: None.

---

### BUNDLE-001: At least one framework bundle

**Priority**: P1  
**Statement**: At least one framework definition (e.g. SOC 2 Type II or ISO 27001) MUST be shipped as data/bundle so that early adopters can load it without building mappings from scratch. Bundle MUST include framework metadata and requirements with controlIds (controls may be shipped in same bundle or created by user).  
**Rationale**: Intent requires “at least one framework bundle shipped”.  
**Acceptance criteria**:
- Loading the bundle (e.g. import or file) yields a valid Framework object (or array) that can be created via frameworks.create.
- Bundle is documented (name, version, how to load).
**Test vectors**: TV-BUNDLE-001  
**Notes**: Which framework (SOC 2 vs ISO 27001) is implementation or product choice.

---

### COMPAT-001: Schema versioning

**Priority**: P1  
**Statement**: Control and framework schema MUST have a documented stability policy: v1 is stable; breaking changes require a new version and deprecation period. Evidence schema MAY have optional version field; existing evidence without version is treated as v1.  
**Rationale**: Evidence and mappings must remain valid across upgrades.  
**Acceptance criteria**:
- SPEC or README documents control/framework/evidence schema version and compatibility.
- New optional fields are additive; removing required fields or changing semantics is breaking and documented.
**Test vectors**: Documentation audit.  
**Notes**: None.

---

## P2 Requirements

### HTTP-001: Optional HTTP API

**Priority**: P2  
**Statement**: When server is enabled, HTTP endpoints MUST be provided for controls (POST, GET, PATCH, DELETE), frameworks (same), evidence (POST, GET list, GET by id), checks (POST, GET, POST run, DELETE), readiness (GET control, GET framework), export (POST auditor-pack). Responses MUST be JSON envelope.  
**Rationale**: UI and cross-service integration.  
**Acceptance criteria**:
- Documented routes and methods; each fallible route returns { ok, result } or { ok, error: { code, message, details } }.
- At least one integration test or manual test that calls HTTP endpoints and verifies envelope.
**Test vectors**: TV-HTTP-001  
**Notes**: Auth middleware is deployment-defined.

---

### CLI-001: Optional CLI

**Priority**: P2  
**Statement**: CLI MUST support init, run-checks (optional --check-id), export (--framework-id, --output), attest (--control-id, --actor-id, --outcome). init MUST create or migrate DB schema.  
**Rationale**: Operator and scripted workflows.  
**Acceptance criteria**:
- compfn init runs without error when config and DB are valid.
- compfn run-checks runs all checks (or one when --check-id given) and outputs summary.
- compfn export --framework-id <id> --output <path> writes auditor pack to path.
- compfn attest creates one manual attestation evidence record.
**Test vectors**: TV-CLI-001, TV-CLI-002  
**Notes**: None.

---

### PROVIDER-001: Readiness/evidence-due consumable

**Priority**: P2  
**Statement**: Readiness and list of evidence-due (e.g. controls with no recent evidence or failed checks) MUST be obtainable via CompFnAPI so that productFn, userfn, or flowfn can consume (e.g. “Compliance status” widget, “Attestation due” tasks). Exact API surface MAY be readiness.forFramework plus evidence.list with filters.  
**Rationale**: Intent: “Provider to productFn/userfn/flowfn”.  
**Acceptance criteria**:
- readiness.forFramework(frameworkId) and evidence.list({ controlId, since }) are sufficient for a consumer to build “evidence due” list (controls with lastEvidenceAt before threshold or missing).
- Documented how productFn/flowfn would call compfn for status and due tasks.
**Test vectors**: TV-PROVIDER-001  
**Notes**: Optional dedicated “evidenceDue” method is implementation-defined.
