# PHASE 10

## Phase goal
Deliver shared envelope and errors packages and adopt them in recfn/cifn/cmsfn via compatibility adapters.

## In scope / Out of scope

- **In scope:** new packages, consumer integration, compatibility helpers.
- **Out of scope:** immediate one-shot forced envelope shape rewrite for every endpoint.

## Deliverables

- `packages/envelope` and `packages/errors` packages.
- RecFn/CIFn/CmsFn envelope/error adoption or wrapper delegation.
- Contract tests for canonical envelope shapes and legacy conversions.

## Requirements covered

- REUSE-003
- REUSE-004
- REUSE-005

## Implementation tasks

1. Implement envelope constructors and compatibility transformers.
2. Implement error registry and typed error constructor.
3. Migrate recfn/cifn/cmsfn local envelope/error utilities to shared helpers.
4. Add tests for canonical + compatibility envelope behavior.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/envelope run test
npm -w @superfunctions/errors run test
npm -w recfn-server run test
npm -w cifn-control-plane run test
npm -w @cmsfn/core run test
```
Expected: package and consumer tests pass.

2. Run:
```bash
rg -n "export function ok\(|export function err\(" recfn/server/src/middleware/envelope.ts cifn/typescript/control-plane/src/api/envelope.ts cmsfn/core/src/envelope.ts
```
Expected: local helpers are wrappers/delegates, not independent schema owners.

## Stop condition
Envelope/error drift is reduced with shared package adoption and passing contract tests.
