# Phase goal

Deliver production Outlook/Microsoft Graph adapter with subscription and delta sync lifecycle.

## In scope / Out of scope

- **In scope**:
  - Graph adapter for message listing and delta.
  - Subscription create/renew/expire handling.
  - Throttling and retry behavior under Graph limits.
- **Out of scope**:
  - Yahoo/iCloud/generic IMAP adapters.

## Deliverables

- `plugfn/typescript/src/providers/outlook/index.ts`
- `plugfn/typescript/src/providers/outlook/outlook.delta.ts`
- `plugfn/typescript/src/providers/outlook/outlook.subscriptions.ts`
- `plugfn/typescript/src/providers/index.ts` (registration update)
- `plugfn/typescript/tests/providers/outlook.delta.test.ts`
- `plugfn/typescript/tests/providers/outlook.subscription.test.ts`

## Requirements covered

- ARCH-003
- ARCH-004
- MAIL-002
- PLUG-006

## Implementation tasks

1. Implement Graph message read and delta traversal.
2. Persist delta tokens and apply safe progression after commit.
3. Implement subscription renewal job and expiration recovery.
4. Integrate Graph 429 handling with retry/rate-limit middleware.
5. Normalize Graph message structures to canonical mail model.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/providers/outlook.delta.test.ts tests/providers/outlook.subscription.test.ts`
2. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/providers/provider-contracts.test.ts`
Expected outcome: delta/subscription tests pass and checkpoint invalidation triggers controlled rebaseline.

## Stop condition

Outlook adapter is contract-compliant, subscription-safe, and throttling-aware.
