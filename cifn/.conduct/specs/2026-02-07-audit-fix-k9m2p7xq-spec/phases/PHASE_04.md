# Phase 04 — Runner-scoped authentication (register → runnerSecret → heartbeat)

## Phase goal (1 sentence)

Fix runner authentication by issuing a per-runner secret at registration and requiring it for all heartbeat/job-claim requests.

## In scope

- `POST /api/v1/runners/register` returns `{runnerId, runnerSecret}`.
- Control plane stores only a hash of runnerSecret (no plaintext at rest).
- `POST /api/v1/runners/heartbeat` requires `Authorization: Bearer <runnerSecret>` and validates binding to runnerId.

## Out of scope

- Secrets injection for jobs (Phase 05).
- Real queue/file integrations (Phase 06).

## Deliverables (explicit list of files/modules)

- Modify:
  - `cifn/typescript/control-plane/src/runners/register.ts`
  - `cifn/typescript/control-plane/src/api/routes.ts`
  - `cifn/typescript/control-plane/src/store/memory-store.ts`
  - `cifn/typescript/control-plane/src/api/api.test.ts`
  - `cifn/typescript/control-plane/src/queue/queue.test.ts` (if impacted)

## Requirements covered

- API-010
- API-011
- RUNNER-003
- SEC-004

## Implementation tasks (ordered checklist)

- [ ] Update runner registration flow:
  - [ ] Generate `runnerSecret` (cryptographically random).
  - [ ] Store only `hash(runnerSecret)` plus runner metadata.
  - [ ] Return plaintext `runnerSecret` only in the registration response.
- [ ] Update heartbeat auth:
  - [ ] Require Authorization Bearer runnerSecret.
  - [ ] Validate runnerId exists and secret hash matches.
  - [ ] Reject registration token usage for heartbeat.
- [ ] Update tests:
  - [ ] TV-RUNNER-003 (register returns secret once)
  - [ ] TV-RUNNER-004 (registration token rejected for heartbeat)
  - [ ] TV-RUNNER-005 (wrong runnerSecret rejected)
  - [ ] TV-RUNNER-006 (no-job heartbeat returns job:null envelope)
  - [ ] TV-SEC-006 (hash storage unit-level)

## Verification steps (exact commands or manual steps) and expected outcomes

- Run:
  - `npm -w cifn/typescript/control-plane test`
- Expected:
  - All tests pass.
  - Heartbeat is no longer authenticated by registration token.

## Stop condition (what to report back before starting the next phase)

Report:

- The runnerSecret hashing approach and where it is stored.
- The exact heartbeat auth validation logic (runnerId binding rules).
- Evidence that control-plane tests are green.

