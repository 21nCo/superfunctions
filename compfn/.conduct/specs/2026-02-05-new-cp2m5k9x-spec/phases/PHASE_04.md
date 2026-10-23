# PHASE_04: Checks create and run

## Phase goal

Implement checks.create, get, list, run, delete. run(checkId) executes the check: if adapterName is set, look up adapter from config and call runCheck({ checkId, controlId, method, customConfig }); persist one evidence record linked to check's controlId with type/outcome from adapter; return RunCheckResult with evidenceId. If check does not exist return CHECK_NOT_FOUND. If adapter is missing return ADAPTER_NOT_FOUND. If adapter throws return ADAPTER_ERROR.

## In scope

- checks.create(definition) – validate controlId exists, name, schedule or adapter or customConfig; store CheckDefinition with id
- checks.get(id), list(), delete(id) – CHECK_NOT_FOUND when id missing
- checks.run(id) – load check; resolve adapter; execute; create evidence; return RunCheckResult
- Mock adapter for tests so run() can be tested without real secfn/authfn

## Out of scope

- Real secfn/authfn adapters (Phase 07); readiness; export

## Deliverables

- `src/checks/service.ts` – check CRUD and run
- Run logic: call adapter.runCheck({ checkId, controlId, method, customConfig }); persist evidence via evidence.create(...); return RunCheckResult
- Mock adapter (returns fixed AdapterEvidence or throws for negative test)
- Tests: TV-CHECK-CREATE-001, TV-CHECK-RUN-001, TV-CHECK-RUN-002, TV-CHECK-RUN-003, TV-CHECK-RUN-004, TV-CHECK-EVIDENCE-001

## Requirements covered

- CHECK-001, CHECK-002, ADAPT-001 (interface usage)

## Implementation tasks

1. Implement checks.create(definition): validate controlId exists; validate name; validate at least one of (schedule, trigger, adapterName+adapterMethod, customConfig); generate id and timestamps; insert; return { ok: true, result: CheckDefinition }.
2. Implement checks.get(id), list(), delete(id). get/delete return CHECK_NOT_FOUND when id not found.
3. Implement checks.run(id): get check; if not found return CHECK_NOT_FOUND. If adapterName present, get adapter from config.adapters[adapterName]; if missing return ADAPTER_NOT_FOUND. Call adapter.runCheck({ checkId: check.id, controlId: check.controlId, method: check.adapterMethod, customConfig: check.customConfig }); on throw catch and return { ok: false, error: { code: "ADAPTER_ERROR", message, details } }; optionally store evidence with outcome "fail". On success: evidence.create({ controlId: check.controlId, type: adapterEvidence.type, sourceId: check.id, actorId: config.systemActorId ?? "system", outcome: adapterEvidence.outcome, timestamp: adapterEvidence.timestamp, payload: adapterEvidence.payload, artifactRef: adapterEvidence.artifactRef, frameworkRequirementId: adapterEvidence.frameworkRequirementId }); return { ok: true, result: { checkId, controlId, evidenceId, outcome, timestamp } }.
4. Create mock adapter: { name: "mock", runCheck: async () => ({ type: "custom_check", outcome: "pass" }) } (with required AdapterEvidence fields). Use in tests.
5. Write tests TV-CHECK-*.

## Verification steps

- Run check tests; TV-CHECK-* pass.
- run(nonexistent) → CHECK_NOT_FOUND.
- run with adapter that throws → ADAPTER_ERROR.
- After run, evidence.get(result.evidenceId) returns the new evidence with correct controlId.

## Stop condition

- Checks create/run/delete complete; run produces evidence; all test vectors pass.
