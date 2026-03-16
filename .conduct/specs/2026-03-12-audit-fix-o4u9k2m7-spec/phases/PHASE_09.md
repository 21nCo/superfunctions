# PHASE 09

## Phase goal
Deliver `@superfunctions/webhooks` and migrate recfn/cifn webhook signing and delivery.

## In scope / Out of scope

- **In scope:** new shared webhooks package and consumer adoption in recfn/cifn.
- **Out of scope:** plugfn provider-specific trigger routing internals.

## Deliverables

- `packages/webhooks` with sign/verify/deliver APIs and tests.
- RecFn webhook signing/delivery path using shared package.
- CIFn signature verification path using shared package.

## Requirements covered

- REUSE-001
- REUSE-002

## Implementation tasks

1. Implement shared sign/verify helpers with timing-safe verification.
2. Implement delivery helper with retry/backoff and structured attempt result.
3. Replace recfn local signing/delivery internals with shared imports.
4. Replace cifn signature verification internals with shared imports.
5. Update tests in recfn and cifn.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/webhooks run test
npm -w recfn-server run test -- webhook
npm -w cifn-control-plane run test -- webhook
```
Expected: all webhook-related tests pass.

2. Run:
```bash
rg -n "createHmac" recfn/server/src/webhooks cifn/typescript/control-plane/src/triggers
```
Expected: no duplicated direct HMAC implementations remain (except shared package).

## Stop condition
Shared webhook package is adopted in recfn/cifn and legacy duplication removed.
