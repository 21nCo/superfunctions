# PHASE 15

## Phase goal
Canonicalize SearchFn adapter source ownership and remove dual-maintained duplicates.

## In scope / Out of scope

- **In scope:** searchfn/adapters vs searchfn/adapter-* source strategy, test strategy alignment.
- **Out of scope:** SearchFn functional behavior changes.

## Deliverables

- Canonical source policy document and implementation.
- Re-export/generated compatibility path for non-canonical side.
- Consolidated conformance test location.

## Requirements covered

- DUPL-003
- OPS-001

## Implementation tasks

1. Choose canonical source path (split packages or monolith) and document rationale.
2. Convert non-canonical path into generated or re-export layer.
3. Remove duplicated manual tests from non-canonical path.
4. Ensure adapter package imports remain stable.

## Verification steps

1. Run:
```bash
npm -w @searchfn/adapter-memory run test
npm -w @searchfn/adapter-indexeddb run test
npm -w @searchfn/adapter-postgres run test
```
Expected: adapter suites pass.

2. Run:
```bash
npm run check:duplication
```
Expected: searchfn adapter duplication pair thresholds pass.

## Stop condition
SearchFn adapter implementations have a single source of truth and pass tests.
