# Phase 02: flowfn queue and run creation

## Phase goal
On run creation, resolve job DAG from pipeline spec and enqueue root jobs (no needs or all needs satisfied) to flowfn; run creation fetches pipeline from pipelineRef (repo + ref + configPath) when not inline, and persists jobs in store with status pending; GET /runs/:runId shows jobs.

## In scope
- flowfn client: enqueue job payload { runId, jobKey, spec }; dequeue (for runner, Phase 03).
- On create run: fetch pipeline (from repo/ref via git or stub) or use inline pipelineSpec; validate; create run and job records; enqueue root jobs to flowfn.
- DAG resolution: compute job order; root jobs = jobs with empty needs or needs already satisfied (none in v1 for root).
- Store: persist jobs per run with jobKey, status pending; link run to pipeline spec.

## Out of scope
- Runner dequeue and execution (Phase 03), checkout step implementation, secrets.

## Deliverables
- `cifn/typescript/control-plane/src/queue/flowfn-client.ts` (enqueue, dequeue stubs or real flowfn client).
- `cifn/typescript/control-plane/src/pipeline/dag.ts` (resolve root jobs and dependency order).
- Update run creation in API: after validate, create run + jobs in store; enqueue root jobs to flowfn.
- Tests: create run with pipeline that has two jobs (build, test with needs: [build]); verify build enqueued, test not enqueued until build completes (Phase 03 will consume).

## Requirements covered
- INT-001, PIPE-007, RUN-002, API-002.

## Implementation tasks
1. Add flowfn client wrapper: enqueue(queueName, payload), dequeue(queueName) or subscribe. Use flowfn SDK or HTTP; if flowfn not available use in-memory queue for tests.
2. Implement DAG: given PipelineSpec, return ordered job keys and for each job the list of needs; root jobs = needs length 0.
3. On POST /runs: if pipelineRef provided, fetch pipeline (stub: read from local path or fixture); validate; create run with status queued; create job records for each job with status pending; enqueue root jobs (payload: runId, jobKey, jobSpec, steps).
4. Ensure GET /runs/:runId returns run with jobs array (jobKey, status).
5. Add test: create run with jobs A and B (B needs A); assert A enqueued, B not enqueued.

## Verification steps
- Create run with pipelineRef or inline spec with two jobs (second needs first). Verify response has runId; GET run shows two jobs.
- Assert flowfn queue (or stub) has one message (root job). Run tests: `npm test` for queue and run creation.

## Stop condition
- Run creation enqueues root jobs to flowfn; run and jobs persisted; GET run shows jobs. Report: "Phase 02 complete; queue integration ready for Phase 03 (runner)."
