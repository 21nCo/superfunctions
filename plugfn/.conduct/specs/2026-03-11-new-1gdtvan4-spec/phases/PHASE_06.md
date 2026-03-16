# Phase goal

Complete `plugfn` operational hardening: deterministic connection selection, distributed throttling/retries, workflow idempotency, and CLI diagnostics.

## In scope / Out of scope

- **In scope**:
  - Deterministic connection selection and ambiguity errors.
  - Retry/rate-limit behavior with provider headers.
  - Durable workflow execution idempotency and crash recovery.
  - Replace CLI test placeholder with real checks.
- **Out of scope**:
  - Email provider adapter implementation.

## Deliverables

- `plugfn/typescript/src/core/action-executor.ts`
- `plugfn/typescript/src/core/connection-manager.ts`
- `plugfn/typescript/src/middleware/rate-limiter.ts`
- `plugfn/typescript/src/middleware/retry.ts`
- `plugfn/typescript/src/core/workflow-engine.ts`
- `plugfn/cli/src/commands/test.ts`
- `plugfn/typescript/tests/connection-selection.test.ts`
- `plugfn/typescript/tests/retry-ratelimit.test.ts`
- `plugfn/typescript/tests/workflow-idempotency.test.ts`
- `plugfn/cli/tests/test-command.test.ts`

## Requirements covered

- PLUG-004
- PLUG-006
- PLUG-007
- PLUG-008
- OPS-001

## Implementation tasks

1. Implement deterministic default connection selection with explicit tie-breakers.
2. Add `Retry-After` support and bounded retry behavior.
3. Make workflow execution records crash-safe with re-entry idempotency keys.
4. Implement real CLI diagnostics with machine-readable output.
5. Add regression coverage for previous encryption and workflow failure classes.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run`
2. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/cli && npm test -- --run`
3. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/cli && node dist/index.js test --provider github --json`
Expected outcome: tests pass and CLI returns structured diagnostic output.

## Stop condition

`plugfn` core runtime and CLI diagnostics satisfy deterministic and operational requirements with green regression suites.
