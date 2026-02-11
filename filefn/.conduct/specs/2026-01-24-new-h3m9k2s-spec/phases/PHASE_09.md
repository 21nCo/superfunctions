# Phase 09

## Phase goal
Implement `@superfunctions/storage-gcs` adapter.

## In scope
- Signed upload URL and signed download URL support for GCS.
- Multipart strategy if supported (or document capability as false and rely on proxy/chunk strategy).

## Out of scope
- Azure adapter.

## Deliverables
- `packages/storage-gcs/src/adapter.ts`
- `packages/storage-gcs/src/adapter.test.ts`

## Requirements covered
- PKG-002 (partial)
- STORAGE-001
- STORAGE-002
- STORAGE-003
- STORAGE-005

## Implementation tasks
1. Implement GCS adapter with correct capabilities.
2. Implement `statObject` and `deleteObject`.
3. Implement signed URL generation.
4. Add conformance tests validating capability correctness.

## Verification steps
1. `npm run build -- --filter=@superfunctions/storage-gcs`
2. `npm test -- --filter=@superfunctions/storage-gcs`
Expected: exit code 0.

## Stop condition
Report:
- Whether multipart is supported and how (if at all).
- Any constraints GCS supports for signed uploads.
