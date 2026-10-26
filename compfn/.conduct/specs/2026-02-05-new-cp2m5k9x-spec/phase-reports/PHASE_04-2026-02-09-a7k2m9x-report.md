# Phase Completion Report: PHASE_04

## Metadata

- **Timestamp**: 2026-02-09T13:02:00Z (UTC)
- **Agent name**: unknown-agent
- **Model**: unknown
- **Launcher**: Cursor
- **Workspace/project path**: /Users/ar/dev/superfunctions/compfn
- **OS**: darwin 25.0.0
- **Shell**: zsh
- **Repo**: git branch `next`, commit `98c7185`, dirty

## Phase

**PHASE_04**: Checks create and run

## Status

**PASS**

## Requirements summary

| Requirement | Status |
|-------------|--------|
| CHECK-001 (Check definition and run) | PASS |
| CHECK-002 (Check stores result as evidence) | PASS |
| ADAPT-001 (Evidence adapter interface usage) | PASS |

### Acceptance criteria evidence

- **CHECK-001**: checks.create(definition) returns CheckDefinition with id. checks.run(checkId) executes adapter, creates one evidence, returns RunCheckResult with evidenceId. run("nonexistent") → CHECK_NOT_FOUND. If adapterName set but adapter missing from config → ADAPTER_NOT_FOUND. If execution throws → ADAPTER_ERROR. (TV-CHECK-CREATE-001, TV-CHECK-RUN-001, TV-CHECK-RUN-002, TV-CHECK-RUN-003, TV-CHECK-RUN-004.)
- **CHECK-002**: After run(checkId) returns { ok: true, result }, evidence.get(result.evidenceId) returns the new evidence; evidence.controlId === check.controlId. (TV-CHECK-EVIDENCE-001.)
- **ADAPT-001**: compFn({ database, adapters: { mock: mockAdapter } }) accepts adapters; check with adapterName "mock" can be created and run; run invokes adapter.runCheck(). (TV-CHECK-RUN-001, TV-CHECK-EVIDENCE-001, mock adapter used in tests.)

### Test status

- All TV-CHECK-* tests implemented and passing in `src/__tests__/checks.test.ts`.
- Check tests: 9 passed (TV-CHECK-CREATE-001, TV-CHECK-RUN-001/002/003/004, TV-CHECK-EVIDENCE-001, get/delete CHECK_NOT_FOUND, list and delete flow).
- Full suite: 53 tests passed.

## Deliverables summary

### Files added

- `src/checks/service.ts` – check CRUD (create, get, list, delete); create validates controlId exists, name, at least one of (schedule, trigger, adapterName+adapterMethod, customConfig); run(id) loads check, resolves adapter from config.adapters[adapterName], calls adapter.runCheck({ checkId, controlId, method, customConfig }), persists one evidence via evidenceCreate, returns RunCheckResult; CHECK_NOT_FOUND, ADAPTER_NOT_FOUND, ADAPTER_ERROR as specified.
- `src/__tests__/checks.test.ts` – TV-CHECK-CREATE-001, TV-CHECK-RUN-001, TV-CHECK-RUN-002, TV-CHECK-RUN-003, TV-CHECK-RUN-004, TV-CHECK-EVIDENCE-001, plus get/delete CHECK_NOT_FOUND and list/delete flow.

### Files changed

- `src/validation.ts` – added CreateCheckInput type and validateCreateCheckInput (name, controlId required; at least one of schedule, trigger, adapterName+adapterMethod, customConfig).
- `src/compfn.ts` – created createChecksService with database, namespace, existsControl, getAdapter from config.adapters, systemActorId, evidenceCreate; wired checks.create, get, list, run, delete.

### Files deleted

- None.

## Verification summary

### Phase verification steps

1. **Run check tests; TV-CHECK-* pass.**  
   - `npm test -- --run src/__tests__/checks.test.ts` → 9 tests passed.

2. **run(nonexistent) → CHECK_NOT_FOUND.**  
   - TV-CHECK-RUN-002: checks.run("nonexistent-id") returns { ok: false, error: { code: "CHECK_NOT_FOUND" } }. Passed.

3. **run with adapter that throws → ADAPTER_ERROR.**  
   - TV-CHECK-RUN-003: check with throwing adapter; checks.run(ch.id) returns ADAPTER_ERROR. Passed.

4. **After run, evidence.get(result.evidenceId) returns the new evidence with correct controlId.**  
   - TV-CHECK-EVIDENCE-001: run check, then evidence.get(runRes.result.evidenceId); result.controlId === c.id. Passed.

### Test execution results

- `npm test -- --run src/__tests__/checks.test.ts`: 9 tests passed.
- `npm test -- --run` (full suite): 5 test files, 53 tests, all passed.

## Notes

- Mock adapter defined inline in checks.test.ts as { name: "mock", runCheck: async () => ({ type: "custom_check", outcome: "pass" }) }; throwing adapter for TV-CHECK-RUN-003 throws in runCheck().
- When adapter throws, service returns ADAPTER_ERROR; optional fail evidence is not persisted in current implementation to keep envelope response consistent (phase allows “optionally store evidence with outcome fail”).
- checks.list() uses findMany with no where clause (same pattern as frameworks.list()).
- Check without adapterName on run returns ADAPTER_NOT_FOUND (check has no adapter configured).

## Ready for next phase?

**Yes.** Checks CRUD and run are implemented; run produces evidence; all test vectors pass. No blockers.

## Blockers

None.
