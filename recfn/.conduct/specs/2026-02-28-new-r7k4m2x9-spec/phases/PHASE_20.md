# Phase 20: Observability, metrics, and polish

## Phase goal
Complete logfn integration, add metrics emission, track bot join latency, and perform final end-to-end testing across all components.

## In scope
- Comprehensive logfn integration: structured logs for all lifecycle events, API errors, recording events, transcription events.
- Metrics emission (watchfn or equivalent): active bot count, recording count, ASR latency, webhook delivery rate, API request rate.
- Bot join latency tracking and logging (<10s target).
- End-to-end integration test: create bot → join (mock) → record → transcribe → analytics → search → webhook delivery.
- Documentation README.md for recfn.
- Final verification of all prior phases' test vectors.

## Out of scope
- New features.

## Deliverables
- `recfn/server/src/integrations/watchfn.ts` — metrics emission wrapper
- `recfn/server/src/observability/metrics.ts` — metric definitions and emission points
- `recfn/server/src/observability/latency.ts` — join latency tracker
- `recfn/server/__tests__/observability.test.ts`
- `recfn/server/__tests__/e2e.test.ts` — end-to-end integration test

## Requirements covered
- OBS-001, OBS-002, OBS-003, INT-005, INT-006

## Implementation tasks
1. Audit all lifecycle transition points: ensure logfn.info called with structured context (botId, from/to status, timestamps).
2. Implement metrics module: define metric names (recfn.bots.active, recfn.recordings.count, recfn.asr.latency_ms, etc.).
3. Implement metric emission: hook into lifecycle events, recording completion, ASR completion, webhook delivery, API request handler.
4. Implement join latency tracker: record creation timestamp and joined timestamp, compute delta, log and emit metric.
5. Verify <10s join latency target is measurable (log warning if exceeded).
6. Write end-to-end integration test: full lifecycle with mock platform adapter, verify all entities created, all webhooks fired, analytics computed, search working.
7. Run all test vectors from all phases to verify no regressions.
8. Write tests: metric emission, latency logging, structured log format.

## Verification steps
- `cd recfn/server && npx vitest run` — all tests pass including e2e and observability.
- Tests cover: TV-OBS-001, TV-OBS-002, TV-OBS-003, TV-INT-005.
- Full test suite across all packages: `cd recfn && npm test` (or turbo run test).

## Stop condition
- Comprehensive logging in place. Metrics emitted. Join latency tracked. End-to-end test passes. All prior phase tests still pass. Report: "Phase 20 complete; recfn implementation complete."
