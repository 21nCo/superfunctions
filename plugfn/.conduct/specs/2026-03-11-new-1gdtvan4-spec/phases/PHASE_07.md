# Phase goal

Deliver production Gmail adapter with baseline/incremental sync and watch lifecycle support.

## In scope / Out of scope

- **In scope**:
  - Gmail provider descriptor + adapter implementation.
  - Baseline + incremental sync checkpointing.
  - Watch create/renew scheduler and sync trigger handling.
- **Out of scope**:
  - Other provider adapters.

## Deliverables

- `plugfn/typescript/src/providers/gmail/index.ts`
- `plugfn/typescript/src/providers/gmail/gmail.sync.ts`
- `plugfn/typescript/src/providers/gmail/gmail.watch.ts`
- `plugfn/typescript/src/providers/index.ts` (registration update)
- `plugfn/typescript/src/mail/normalization.ts`
- `plugfn/typescript/tests/providers/gmail.sync.test.ts`
- `plugfn/typescript/tests/providers/gmail.watch.test.ts`

## Requirements covered

- ARCH-003
- ARCH-004
- MAIL-001
- MAIL-010

## Implementation tasks

1. Implement Gmail auth scopes per policy map and feature map.
2. Implement full baseline sync and checkpoint persistence.
3. Implement incremental sync from checkpoint with rebaseline on invalid checkpoint.
4. Implement watch creation/renewal and webhook trigger integration.
5. Normalize Gmail messages into canonical mail model.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/providers/gmail.sync.test.ts tests/providers/gmail.watch.test.ts`
2. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm run type-check`
3. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/providers/provider-contracts.test.ts`
Expected outcome: gmail-specific and contract tests pass; invalid checkpoint path returns canonical error.

## Stop condition

Gmail adapter passes conformance and sync lifecycle tests, including watch renewal behavior.
