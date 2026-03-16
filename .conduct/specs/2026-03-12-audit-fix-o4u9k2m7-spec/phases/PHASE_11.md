# PHASE 11

## Phase goal
Deliver shared queue package and migrate recfn/cifn queue adapters.

## In scope / Out of scope

- **In scope:** queue interfaces, memory adapter, flowfn http adapter, consumer adoption.
- **Out of scope:** flowfn internal queue engine redesign.

## Deliverables

- `packages/queue` package with interface + adapters + tests.
- RecFn and CIFn queue integration modules using shared queue package.

## Requirements covered

- REUSE-006
- REUSE-007
- DUPL-004

## Implementation tasks

1. Implement queue package interfaces and adapters.
2. Replace recfn and cifn memory queue classes with shared adapter usage.
3. Keep queue naming constants stable via wrappers or exported constants.
4. Update queue tests in recfn/cifn.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/queue run test
npm -w recfn-server run test -- flowfn
npm -w cifn-control-plane run test -- queue
```
Expected: queue behavior tests pass.

2. Run:
```bash
rg -n "class MemoryQueueAdapter" recfn/server/src cifn/typescript/control-plane/src
```
Expected: no duplicate in-memory queue class implementations remain.

## Stop condition
Queue dedupe migration is complete and consumer queue tests are green.
