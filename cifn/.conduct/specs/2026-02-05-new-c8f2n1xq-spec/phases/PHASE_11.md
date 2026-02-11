# Phase 11: Limits, performance, optional sendfn

## Phase goal
Enforce all documented limits (pipeline size, jobs/steps/needs, GET limit); add optional sendfn notification on run completion (success/failure).

## In scope
- Limits: reject pipeline document > 500 KB at parse or validation; reject jobs > 100, steps per job > 100, needs depth > 10 with PIPELINE_INVALID; GET /runs limit max 100 (return 400 or cap); artifact name length 256; cache key 1 KB; expression 2 KB (if implemented).
- Performance: document or assert parse+validate < 500ms for 100 KB pipeline; job dispatch < 5s when runner available; GET /runs < 2s for 1000 runs (best effort).
- Optional sendfn: config (per pipeline or global) to send notification on run success/failure; call sendfn (email or webhook) with run summary; when not configured, no notification.

## Out of scope
- Auto-scaling; Kubernetes; strict SLA enforcement.

## Deliverables
- Validation and API enforcement for all LIMIT-001 limits.
- Optional sendfn client and hook on run status change to success/failure; config key for enable and sendfn endpoint or template.
- Tests: TV-LIMIT-001, TV-LIMIT-002, TV-LIMIT-003, TV-LIMIT-004 (benchmark), TV-DASH-002.
- Documentation: limits and performance expectations in README or SPEC.

## Requirements covered
- LIMIT-001, LIMIT-002, LIMIT-003, DASH-002.

## Implementation tasks
1. In pipeline validator: check document size (string or buffer length) ≤ 500 KB; check jobs length ≤ 100; for each job steps length ≤ 100; needs depth ≤ 10. Return PIPELINE_INVALID with details when exceeded.
2. In GET /runs handler: if limit > 100 return 400 BAD_REQUEST or cap to 100 (document choice).
3. In artifact upload: validate artifact name length ≤ 256; cache key ≤ 1 KB if applicable.
4. Add benchmark or test: parse 100 KB pipeline; assert duration < 500ms (or log warning). Optional: GET /runs with 1000 runs < 2s.
5. sendfn: add optional config notifyOnRunComplete: true and sendfn webhook URL or sendfn client config; on run transition to success or failure, call sendfn (e.g. POST to webhook with runId, status, summary). When config absent, no call.
6. Tests: TV-LIMIT-001 (doc > 500 KB), TV-LIMIT-002 (101 jobs, 101 steps, depth 11), TV-LIMIT-003 (limit 101), TV-DASH-002 (notification when configured).

## Verification steps
- Submit pipeline > 500 KB → validation fails. TV-LIMIT-001.
- Submit pipeline with 101 jobs → PIPELINE_INVALID. TV-LIMIT-002.
- GET /runs?limit=101 → 400 or response with at most 100. TV-LIMIT-003.
- With sendfn configured, complete run (success and failure); assert notification sent. TV-DASH-002.
- Run full test suite; all phases' tests pass.

## Stop condition
- All limits enforced; optional sendfn integrated; test vectors for limits and notification pass. Definition of Done: no phase incomplete; all verification steps across phases pass. Report: "Phase 11 complete; CiFn spec implementation complete."
