# Phase 01: Control plane core and API

## Phase goal
Implement in-memory store for runs/jobs/steps and HTTP API: POST /runs (create run with pipeline from body only for this phase), GET /runs, GET /runs/:runId, POST /runs/:runId/cancel, with canonical envelope and error codes.

## In scope
- In-memory store: create run, get run, list runs (with limit/cursor/status), update run/job/step status, cancel run.
- HTTP server (e.g. Express or Hono): routes under /api/v1; response envelope; error codes RUN_NOT_FOUND, RUN_ALREADY_FINISHED, BAD_REQUEST, PIPELINE_INVALID, RUN_CREATE_FAILED.
- POST /runs: body { pipelineRef?, trigger }; for Phase 01 pipeline MAY be inline in body (pipelineSpec) or pipelineRef; if inline, validate and create run with status queued; return runId, status, createdAt.
- GET /runs: query limit (default 20, max 100), cursor, status; return { runs, nextCursor }.
- GET /runs/:runId: return full run or 404 RUN_NOT_FOUND.
- POST /runs/:runId/cancel: set status cancelled or 409 RUN_ALREADY_FINISHED.

## Out of scope
- flowfn queue (run create does not enqueue jobs yet), runners, auth (optional stub: accept any token or no auth for local dev), logs/artifacts endpoints, triggers.

## Deliverables
- `cifn/typescript/control-plane/src/store/memory-store.ts` (Run, Job, Step CRUD).
- `cifn/typescript/control-plane/src/api/routes.ts` (runs create, list, get, cancel).
- `cifn/typescript/control-plane/src/api/envelope.ts` (success/error helpers).
- `cifn/typescript/control-plane/src/index.ts` (server bootstrap).
- Tests: API integration tests for TV-API-001 to TV-API-011 (where applicable without runners).

## Requirements covered
- API-001, API-002, API-003, API-004, API-005, API-009, RUN-001, RUN-004.

## Implementation tasks
1. Add memory store: createRun(spec, trigger) → runId; getRun(runId); listRuns(limit, cursor, status); updateRunStatus(runId, status); cancelRun(runId) with 409 if already finished.
2. Implement response helpers: success(data), error(code, message, details).
3. Implement POST /api/v1/runs: parse body; if pipelineSpec in body validate and create run (jobs from spec, no queue yet); return 201 with runId, status queued, createdAt.
4. Implement GET /api/v1/runs: read limit (cap 100), cursor, status; call store.listRuns; return { runs, nextCursor }.
5. Implement GET /api/v1/runs/:runId: call store.getRun; 404 if missing.
6. Implement POST /api/v1/runs/:runId/cancel: get run; if status in [success, failure, cancelled] return 409 RUN_ALREADY_FINISHED; else set cancelled, return 200.
7. Add integration tests for create, list, get, cancel (positive and negative).

## Verification steps
- Start server: `cd cifn/typescript/control-plane && npm run dev` (or start then run tests).
- `curl -X POST http://localhost:3000/api/v1/runs -H "Content-Type: application/json" -d '{"trigger":{"type":"workflow_dispatch"},"pipelineSpec":{...}}'` → 201 and runId.
- `curl http://localhost:3000/api/v1/runs?limit=2` → 200 and envelope with runs array.
- `curl http://localhost:3000/api/v1/runs/<runId>` → 200 with run or 404.
- `curl -X POST http://localhost:3000/api/v1/runs/<runId>/cancel` → 200 then 409 on second cancel.
- Run test suite: `npm test`; all API tests pass.

## Stop condition
- All Phase 01 API endpoints implemented; envelope and error codes correct; tests pass. Report: "Phase 01 complete; control plane API ready for Phase 02 (flowfn queue)."
