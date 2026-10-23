# Phase 10

## Phase goal
Implement `@superfunctions/storage-azure` adapter.

## In scope
- Azure Blob adapter with block-blob multipart semantics.
- Signed URL (SAS) generation for upload/download.

## Out of scope
- Processing features.

## Deliverables
- `packages/storage-azure/src/adapter.ts`
- `packages/storage-azure/src/adapter.test.ts`

## Requirements covered
- PKG-002 (partial)
- STORAGE-001
- STORAGE-002
- STORAGE-003
- STORAGE-004 (mapped to block blob semantics)
- STORAGE-005

## Implementation tasks
1. Implement Azure adapter:
   - represent block uploads via multipart-like interface
   - map returned block IDs into the `etag` concept consistently
2. Implement SAS URL generation for:
   - block upload
   - download
3. Add conformance tests.

## Verification steps
1. `npm run build -- --filter=@superfunctions/storage-azure`
2. `npm test -- --filter=@superfunctions/storage-azure`
Expected: exit code 0.

## Stop condition
Report:
- How block IDs map to part ETags.
- Any limitations of SAS constraints.
