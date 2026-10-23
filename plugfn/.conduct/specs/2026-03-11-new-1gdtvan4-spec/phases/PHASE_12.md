# Phase goal

Implement Fellotron outbound send governance, abuse prevention, and idempotent send execution.

## In scope / Out of scope

- **In scope**:
  - Policy checks for sends (provider/tenant/domain thresholds).
  - Idempotent send queue execution.
  - Throttle and abuse denial paths.
- **Out of scope**:
  - Full end-user compose UX.

## Deliverables

- `plugfn/typescript/src/fellotron/send/governor.ts`
- `plugfn/typescript/src/fellotron/send/queue.ts`
- `plugfn/typescript/src/fellotron/send/policies.ts`
- `plugfn/typescript/src/fellotron/send/types.ts`
- `plugfn/typescript/tests/fellotron/send-governor.test.ts`
- `plugfn/typescript/tests/fellotron/send-idempotency.test.ts`

## Requirements covered

- MAIL-009
- PLUG-006
- SEC-003

## Implementation tasks

1. Define send policy model and preflight checks.
2. Implement idempotency-key enforcement in send queue.
3. Integrate provider `Retry-After` behavior.
4. Persist blocked-send decisions with canonical error codes.
5. Add abuse simulation test fixtures.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/fellotron/send-governor.test.ts tests/fellotron/send-idempotency.test.ts`
2. Manual dry-run send checks for below-threshold and over-threshold scenarios.
Expected outcome: compliant sends queue; over-limit sends fail with `MAIL_SEND_BLOCKED`.

## Stop condition

Send governance is enforceable, idempotent, and validated against abuse and throttling scenarios.
