# CompFn Test Vectors

Golden inputs and expected outputs. Each vector is independently executable and deterministic where applicable.

## Table of Contents

- [API / Config](#api--config)
- [Controls](#controls)
- [Frameworks](#frameworks)
- [Evidence](#evidence)
- [Checks](#checks)
- [Readiness](#readiness)
- [Export](#export)
- [Envelope / errors](#envelope--errors)
- [Limits](#limits)
- [Adapters](#adapters)
- [Bundle](#bundle)
- [HTTP / CLI / Provider](#http--cli--provider)

---

## API / Config

### TV-API-CONFIG-001 (Positive: compFn returns API with all namespaces)

**Input**:
- `compFn({ database: adapter })`

**Expected output**:
- Return value has: `controls` (create, get, list, update, delete), `frameworks` (create, get, list, update, delete), `evidence` (create, get, list), `checks` (create, get, list, run, delete), `readiness` (forControl, forFramework), `export` (auditorPack).
- Each method returns Promise resolving to object with `ok` and either `result` or `error`.

---

## Controls

### TV-CTRL-CREATE-001 (Positive: create control)

**Input**:
- `controls.create({ name: "Access reviews", description: "Quarterly access reviews", category: "access", tags: ["soc2"] })`

**Expected output**:
- `{ ok: true, result: Control }` with result.id defined, result.name "Access reviews", result.createdAt and result.updatedAt numbers.

### TV-CTRL-GET-001 (Positive: get existing control)

**Input**:
- Create control c; then `controls.get(c.id)`

**Expected output**:
- `{ ok: true, result: Control }` with result.id === c.id.

### TV-CTRL-GET-002 (Negative: get nonexistent control)

**Input**:
- `controls.get("nonexistent-id")`

**Expected output**:
- `{ ok: false, error: { code: "CONTROL_NOT_FOUND", message: "...", details: { id: "nonexistent-id" or similar } } }`.

### TV-CTRL-LIST-001 (Positive: list controls with filter)

**Input**:
- Create two controls (category "access", category "backup"); `controls.list({ category: "access" })`

**Expected output**:
- `{ ok: true, result: Control[] }` with only controls where category === "access".

### TV-CTRL-UPDATE-001 (Positive: update control)

**Input**:
- Create control c; `controls.update(c.id, { name: "Updated name" })`

**Expected output**:
- `{ ok: true, result: Control }` with result.name "Updated name", result.id unchanged.

### TV-CTRL-DELETE-001 (Positive: delete control)

**Input**:
- Create control c; `controls.delete(c.id)`; then `controls.get(c.id)`

**Expected output**:
- delete returns `{ ok: true, result: undefined }` or equivalent; get returns `{ ok: false, error: { code: "CONTROL_NOT_FOUND" } }`.

---

## Frameworks

### TV-FW-CREATE-001 (Positive: create framework with requirements)

**Input**:
- Create control c1; `frameworks.create({ name: "SOC 2", version: "2022", requirements: [{ requirementId: "CC6.1", controlIds: [c1.id] }] })`

**Expected output**:
- `{ ok: true, result: Framework }` with result.requirements length 1, result.requirements[0].controlIds including c1.id.

### TV-FW-GET-001 (Positive: get framework)

**Input**:
- Create framework f; `frameworks.get(f.id)`

**Expected output**:
- `{ ok: true, result: Framework }`, result.id === f.id.

### TV-FW-GET-002 (Negative: get nonexistent framework)

**Input**:
- `frameworks.get("nonexistent-id")`

**Expected output**:
- `{ ok: false, error: { code: "FRAMEWORK_NOT_FOUND", ... } }`.

### TV-FW-LIST-001 (Positive: list frameworks)

**Input**:
- Create one framework; `frameworks.list()`

**Expected output**:
- `{ ok: true, result: Framework[] }` with at least one item.

### TV-FW-VALIDATE-CONTROLS-001 (Negative: framework with nonexistent controlId)

**Input**:
- `frameworks.create({ name: "F", requirements: [{ requirementId: "R1", controlIds: ["nonexistent-control-id"] }] })`

**Expected output**:
- `{ ok: false, error: { code: "VALIDATION_FAILED", message: "...", details: { path or controlId or requirementId } } }`.

### TV-FW-VALIDATE-CONTROLS-002 (Positive: framework with existing controlIds)

**Input**:
- Create control c; `frameworks.create({ name: "F", requirements: [{ requirementId: "R1", controlIds: [c.id] }] })`

**Expected output**:
- `{ ok: true, result: Framework }`.

---

## Evidence

### TV-EVID-CREATE-001 (Positive: create evidence)

**Input**:
- Create control c; `evidence.create({ controlId: c.id, type: "manual_attestation", actorId: "user1", outcome: "pass", payload: { note: "Done" } })`

**Expected output**:
- `{ ok: true, result: Evidence }` with result.controlId === c.id, result.type "manual_attestation", result.outcome "pass", result.id and result.createdAt set.

### TV-EVID-CONTROL-LINK-001 (Negative: evidence with nonexistent controlId)

**Input**:
- `evidence.create({ controlId: "nonexistent", type: "manual_attestation", actorId: "user1", outcome: "pass" })`

**Expected output**:
- `{ ok: false, error: { code: "VALIDATION_FAILED", details: { controlId: "nonexistent" or similar } } }`.

### TV-EVID-CONTROL-LINK-002 (Positive: evidence with existing controlId)

**Input**:
- Create control c; evidence.create({ controlId: c.id, type: "manual_attestation", actorId: "u1", outcome: "pass" })

**Expected output**:
- `{ ok: true, result: Evidence }`.

### TV-EVID-TYPE-001 (Positive: valid evidence type)

**Input**:
- Create control c; evidence.create({ controlId: c.id, type: "file_upload", actorId: "u1", outcome: "pass", artifactRef: "s3://bucket/key" })

**Expected output**:
- `{ ok: true, result: Evidence }`, result.type === "file_upload".

### TV-EVID-TYPE-002 (Negative: invalid evidence type)

**Input**:
- Create control c; evidence.create({ controlId: c.id, type: "invalid_type", actorId: "u1", outcome: "pass" })

**Expected output**:
- `{ ok: false, error: { code: "VALIDATION_FAILED", ... } }`.

### TV-EVID-SCOPING-001 (Positive: create scoping decision evidence)

**Input**:
- Create control c; evidence.create({ controlId: c.id, type: "scoping_decision", actorId: "user1", outcome: "unknown", payload: { status: "not_applicable", reason: "Out of scope for this system" } })

**Expected output**:
- `{ ok: true, result: Evidence }`, result.type === "scoping_decision", result.outcome === "unknown", result.payload.status === "not_applicable".

### TV-EVID-SCOPING-002 (Negative: invalid scoping decision evidence)

**Input**:
- Create control c; evidence.create({ controlId: c.id, type: "scoping_decision", actorId: "user1", outcome: "pass", payload: { status: "not_applicable" } })

**Expected output**:
- `{ ok: false, error: { code: "VALIDATION_FAILED", ... } }`.

### TV-EVID-PAYLOAD-SIZE-001 (Positive: payload within limit)

**Input**:
- Create control c; evidence.create({ controlId: c.id, type: "manual_attestation", actorId: "u1", outcome: "pass", payload: { small: "x" } })

**Expected output**:
- `{ ok: true, result: Evidence }`.

### TV-EVID-PAYLOAD-SIZE-002 (Negative: payload exceeds limit)

**Input**:
- Create control c; evidence.create({ controlId: c.id, type: "manual_attestation", actorId: "u1", outcome: "pass", payload: { big: "x".repeat(600_000) } }) with default 512 KiB limit

**Expected output**:
- `{ ok: false, error: { code: "PAYLOAD_TOO_LARGE", ... } }`.

### TV-EVID-IMMUTABLE-001 (Positive: no update/delete on evidence)

**Input**:
- CompFnAPI has evidence namespace.

**Expected output**:
- evidence has create, get, list only; no update or delete method.

### TV-EVID-GET-001 (Positive: get evidence by id)

**Input**:
- Create evidence e; evidence.get(e.id)

**Expected output**:
- `{ ok: true, result: Evidence }`, result.id === e.id.

### TV-EVID-GET-002 (Negative: get nonexistent evidence)

**Input**:
- `evidence.get("nonexistent-id")`

**Expected output**:
- `{ ok: false, error: { code: "EVIDENCE_NOT_FOUND", ... } }`.

### TV-EVID-LIST-001 (Positive: list by controlId)

**Input**:
- Create control c; create two evidence for c; evidence.list({ controlId: c.id })

**Expected output**:
- `{ ok: true, result: Evidence[] }` with both evidence; each result.controlId === c.id.

### TV-EVID-LIST-002 (Positive: list since timestamp)

**Input**:
- Create evidence e; evidence.list({ since: e.timestamp - 1 })

**Expected output**:
- Result array includes e (evidence.timestamp >= since).

---

## Checks

### TV-CHECK-CREATE-001 (Positive: create check)

**Input**:
- Create control c; checks.create({ name: "RBAC check", controlId: c.id, adapterName: "secfn", adapterMethod: "getRbacStatus" })

**Expected output**:
- `{ ok: true, result: CheckDefinition }` with result.controlId === c.id, result.id set.

### TV-CHECK-RUN-001 (Positive: run check)

**Input**:
- Create check ch (with mock adapter); checks.run(ch.id)

**Expected output**:
- `{ ok: true, result: RunCheckResult }` with result.checkId === ch.id, result.controlId, result.evidenceId, result.outcome, result.timestamp.

### TV-CHECK-RUN-002 (Negative: run nonexistent check)

**Input**:
- `checks.run("nonexistent-id")`

**Expected output**:
- `{ ok: false, error: { code: "CHECK_NOT_FOUND", ... } }`.

### TV-CHECK-RUN-003 (Negative: adapter throws)

**Input**:
- Create check that uses adapter which throws in runCheck(); checks.run(checkId)

**Expected output**:
- `{ ok: false, error: { code: "ADAPTER_ERROR", ... } }` (and optionally evidence stored with outcome "fail").

### TV-CHECK-RUN-004 (Negative: adapter not found)

**Input**:
- Create control c; create check ch with adapterName "missingAdapter"; checks.run(ch.id)

**Expected output**:
- `{ ok: false, error: { code: "ADAPTER_NOT_FOUND", ... } }`.

### TV-CHECK-EVIDENCE-001 (Positive: run creates evidence)

**Input**:
- Create control c and check ch for c; run ch; get result.evidenceId

**Expected output**:
- evidence.get(result.evidenceId) returns { ok: true, result: Evidence }, result.controlId === c.id.

---

## Readiness

### TV-READY-CONTROL-001 (Positive: control with pass evidence is compliant)

**Input**:
- Create control c; create evidence for c with outcome "pass"; readiness.forControl(c.id)

**Expected output**:
- `{ ok: true, result: ControlReadiness }` with result.status "compliant" (or as per policy), result.lastEvidenceAt set.

### TV-READY-CONTROL-002 (Negative: control not found)

**Input**:
- `readiness.forControl("nonexistent")`

**Expected output**:
- `{ ok: false, error: { code: "CONTROL_NOT_FOUND", ... } }`.

### TV-READY-CONTROL-003 (Positive: control marked not applicable)

**Input**:
- Create control c; create evidence for c with type "scoping_decision", outcome "unknown", payload.status "not_applicable"; readiness.forControl(c.id)

**Expected output**:
- `{ ok: true, result: ControlReadiness }` with result.status "not_applicable".

### TV-READY-FRAMEWORK-001 (Positive: framework readiness)

**Input**:
- Create framework f with one requirement mapping to control c; add pass evidence for c; readiness.forFramework(f.id)

**Expected output**:
- `{ ok: true, result: FrameworkReadiness }` with result.frameworkId === f.id, result.controlReadiness array, result.status "compliant" or per policy.

### TV-READY-FRAMEWORK-002 (Negative: framework not found)

**Input**:
- `readiness.forFramework("nonexistent")`

**Expected output**:
- `{ ok: false, error: { code: "FRAMEWORK_NOT_FOUND", ... } }`.

---

## Export

### TV-EXPORT-001 (Positive: auditor pack full)

**Input**:
- Create control, framework, evidence; export.auditorPack()

**Expected output**:
- `{ ok: true, result: AuditorPack }` with result.exportedAt, result.controls, result.frameworks, result.evidence, result.mapping.

### TV-EXPORT-002 (Positive: auditor pack scoped to framework)

**Input**:
- Create framework f and controls/evidence; export.auditorPack({ frameworkId: f.id })

**Expected output**:
- result contains only controls and evidence relevant to f (per mapping).

### TV-EXPORT-003 (Negative: export size exceeded)

**Input**:
- Configure exportMaxBytes very small; create large evidence set; export.auditorPack()

**Expected output**:
- `{ ok: false, error: { code: "EXPORT_FAILED", ... } }` when result would exceed limit.

---

## Envelope / errors

### TV-ENVELOPE-001 (Success envelope shape)

**Input**:
- Any successful create (e.g. controls.create(validInput))

**Expected output**:
- `{ ok: true, result: T }` with result matching type (Control, Framework, etc.).

### TV-ENVELOPE-002 (Failure envelope shape)

**Input**:
- controls.get("nonexistent")

**Expected output**:
- `{ ok: false, error: { code: string, message: string, details: object } }`.

### TV-ENVELOPE-003 (No throw for business failure)

**Input**:
- Any operation that fails validation or not-found (e.g. evidence.create with bad controlId)

**Expected output**:
- Promise resolves to { ok: false, error }; no uncaught exception.

---

## Limits

### TV-LIMIT-PAYLOAD-001 (Payload over limit → PAYLOAD_TOO_LARGE)

**Input**:
- evidence.create with payload size > evidencePayloadMaxBytes (see TV-EVID-PAYLOAD-SIZE-002).

**Expected output**:
- `{ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } }`.

### TV-LIMIT-EXPORT-001 (Export over limit → EXPORT_FAILED)

**Input**:
- See TV-EXPORT-003.

**Expected output**:
- `{ ok: false, error: { code: "EXPORT_FAILED" } }`.

### TV-LIMIT-FW-001 (Framework too many requirements or controlIds)

**Input**:
- frameworks.create({ name: "F", requirements: Array(1001).fill({ requirementId: "R", controlIds: ["c1"] }) }) (with valid c1)

**Expected output**:
- `{ ok: false, error: { code: "VALIDATION_FAILED", ... } }` (or requirement with > 100 controlIds).

---

## Observability

### TV-OBS-001 (Logging rules)

**Input**:
- Create evidence; run check; export auditor pack; inspect logs.

**Expected output**:
- Logs contain evidenceId/controlId/type/outcome for evidence created; checkId/outcome for check; frameworkId/size for export. No log line contains full evidence payload or PII. (Manual or automated log capture test.)

---

## Adapters

### TV-ADAPT-INTERFACE-001 (Adapter interface)

**Input**:
- compFn({ database, adapters: { mock: { name: "mock", runCheck: async () => ({ type: "custom_check", outcome: "unknown" }) } } })

**Expected output**:
- compFn returns API; no throw. Check with adapterName "mock" can be created and run (run invokes adapter.runCheck()).

### TV-ADAPT-SECFN-001 (Secfn adapter returns evidence)

**Input**:
- Create secfn adapter (with mock secfn client if needed); adapter.runCheck({ checkId, controlId, method }) or run check that uses it.

**Expected output**:
- Returns AdapterEvidence with type "automated_secfn" and outcome set (and optional payload/timestamp); stored evidence has type "automated_secfn" when run via checks.run.

### TV-ADAPT-AUTHFN-001 (Authfn adapter)

**Input**:
- Create authfn adapter; adapter.runCheck({ checkId, controlId, method }) or run check.

**Expected output**:
- Returns AdapterEvidence with type "automated_authfn" and outcome set (and optional payload/timestamp); stored evidence has type "automated_authfn" when run via checks.run.

---

## Bundle

### TV-BUNDLE-001 (Load framework bundle)

**Input**:
- Load shipped framework bundle (e.g. SOC 2 or ISO 27001); frameworks.create(bundle) or equivalent.

**Expected output**:
- Framework(s) created successfully; framework has requirements with controlIds (controls may be created from bundle or pre-existing).

---

## HTTP / CLI / Provider

### TV-HTTP-001 (HTTP envelope)

**Input**:
- POST /controls with valid body; GET /controls/:id for created id.

**Expected output**:
- POST returns 2xx and body { ok: true, result: Control }. GET returns 2xx and body { ok: true, result: Control }. GET for nonexistent returns 4xx and body { ok: false, error: { code: "CONTROL_NOT_FOUND", ... } }.

### TV-CLI-001 (CLI init and run-checks)

**Input**:
- compfn init; compfn run-checks

**Expected output**:
- init exits 0; run-checks exits 0 and outputs summary (or “no checks” etc.).

### TV-CLI-002 (CLI export and attest)

**Input**:
- compfn export --framework-id <id> --output /tmp/out.json; compfn attest --control-id <c> --actor-id u1 --outcome pass

**Expected output**:
- export writes file; attest creates one evidence record (evidence.get or list shows it).

### TV-PROVIDER-001 (Readiness consumable)

**Input**:
- readiness.forFramework(f.id); evidence.list({ controlId: c.id, since: t })

**Expected output**:
- Sufficient to compute “evidence due” (e.g. controls in framework with lastEvidenceAt before threshold). Documented usage for productFn/flowfn.
