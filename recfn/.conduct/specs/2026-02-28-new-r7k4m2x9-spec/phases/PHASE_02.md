# Phase 02: Bot lifecycle state machine and flowfn integration

## Phase goal
Implement the bot lifecycle state machine with flowfn job queue integration, so that creating a bot enqueues a join job and the bot worker processes it through the state machine.

## In scope
- Bot worker: picks up flowfn jobs, manages bot lifecycle transitions.
- flowfn integration: enqueue bot-join job on POST /bots, enqueue recording-upload and transcription jobs.
- State machine enforcement on server side (using core state machine validator).
- Auto-leave on empty logic (timer-based).
- Status transition logging via logfn.

## Out of scope
- Actual platform adapter execution (use mock platform adapter). Recording storage. ASR. WebSocket.

## Deliverables
- `recfn/server/src/worker/bot-worker.ts` — bot job processor
- `recfn/server/src/worker/lifecycle.ts` — state machine enforcement + transition logic
- `recfn/server/src/worker/auto-leave.ts` — auto-leave on empty timer
- `recfn/server/src/integrations/flowfn.ts` — flowfn queue client wrapper
- `recfn/server/src/integrations/logfn.ts` — logfn client wrapper
- `recfn/server/__tests__/bot-lifecycle.test.ts`
- `recfn/server/__tests__/bot-autoleave.test.ts`
- `recfn/server/__tests__/flowfn-integration.test.ts`

## Requirements covered
- BOT-002, BOT-004, BOT-009, INT-001, INT-006, OBS-001, OBS-003

## Implementation tasks
1. Create flowfn client wrapper: enqueue(jobType, payload), dequeue(jobType), with flowfn memory adapter for tests.
2. Create logfn client wrapper: info, warn, error with structured context.
3. Update POST /bots route to enqueue "bot.join" job after creating bot record.
4. Implement bot-worker: listen for "bot.join" jobs, invoke platform adapter (mock), manage transitions.
5. Implement lifecycle.ts: transition(bot, newStatus) — validates transition, updates store, logs event, returns updated bot.
6. Implement auto-leave timer: on participant leave, check if room empty (no non-bot participants), start timer, on timeout transition to "leaving".
7. Implement join timeout: if bot doesn't reach "joined" within joinTimeout, transition to "error".
8. Log bot join latency (creation → joined timestamp delta).
9. Write tests: full lifecycle with mock platform, auto-leave on empty, join timeout → error, flowfn job enqueue/dequeue.

## Verification steps
- `cd recfn/server && npx vitest run` — all tests pass including lifecycle and auto-leave.
- Tests cover: TV-BOT-003, TV-BOT-006, TV-BOT-011, TV-INT-001, TV-OBS-001, TV-OBS-003.

## Stop condition
- Bot lifecycle state machine fully enforced. flowfn jobs enqueued and processed. Auto-leave works with timer. Join timeout produces error state. All tests pass. Report: "Phase 02 complete; bot lifecycle and flowfn integration ready for Phase 03."
