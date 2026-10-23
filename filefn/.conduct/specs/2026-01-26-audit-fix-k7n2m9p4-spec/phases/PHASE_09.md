# PHASE_09

## Phase goal
Make the Azure storage adapter stateless and safe to share across requests/instances while preserving multipart functionality.

## In scope
- Remove per-instance mutable multipart state (e.g., `activeUploads` maps).
- Ensure multipart sign/complete operations work with a different adapter instance than the one that created the upload.

## Out of scope
- Adding new Azure features.

## Deliverables
- Modify:
  - `/Users/ar/dev/superfunctions/packages/storage-azure/src/adapter.ts`
  - `/Users/ar/dev/superfunctions/packages/storage-azure/src/adapter.test.ts`

## Requirements covered
- STORAGE-001

## Implementation tasks
1. Remove any per-instance mutable upload tracking.
2. Ensure the adapter can derive any required per-part identifiers from `(key, uploadId, partNumber)` deterministically.
3. Ensure `completeMultipartUpload({ key, uploadId, parts })` succeeds without prior calls on the same instance.
4. Add/adjust tests to implement TV-STORAGE-AZURE-STATELESS-001.

## Verification steps
1. Run storage-azure tests:
   - `npm test -- --filter=@superfunctions/storage-azure`
2. Confirm vector passes:
   - TV-STORAGE-AZURE-STATELESS-001

## Stop condition
Report:
- how `uploadId` is interpreted/constructed,
- confirmation that multipart can be completed across instances.
