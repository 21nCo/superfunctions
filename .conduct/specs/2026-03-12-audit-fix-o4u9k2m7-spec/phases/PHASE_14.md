# PHASE 14

## Phase goal
Refactor storage adapters to eliminate S3-compatible duplication clusters.

## In scope / Out of scope

- **In scope:** packages/storage-s3/r2/minio primary dedupe, optional helper reuse for azure/gcs/local.
- **Out of scope:** API-breaking changes to provider adapter factory signatures.

## Deliverables

- Shared S3-compatible internal core under `packages/storage`.
- Adapter updates in `packages/storage-s3`, `packages/storage-r2`, `packages/storage-minio`.
- Reduced duplication metrics and passing adapter tests.

## Requirements covered

- DUPL-001
- DUPL-002

## Implementation tasks

1. Create shared internal module for common S3-compatible operations.
2. Update provider adapters to delegate to shared core.
3. Keep provider-specific endpoint/credential/capability differences isolated.
4. Add/adjust tests for shared-core behavior.
5. Run duplication checks for storage package cluster.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/storage run test
npm -w @superfunctions/storage-s3 run test
npm -w @superfunctions/storage-r2 run test
npm -w @superfunctions/storage-minio run test
```
Expected: all storage package tests pass.

2. Run:
```bash
npm run check:duplication
```
Expected: targeted storage duplication metrics improve and pass threshold.

## Stop condition
Storage duplication cluster is reduced to acceptable threshold with no regressions.
