# Phase 02

## Phase goal
Implement baseline `@superfunctions/storage-*` adapters needed to unblock FileFn server work (Local + S3).

## In scope
- `@superfunctions/storage-local` adapter (dev/testing).
- `@superfunctions/storage-s3` adapter (AWS S3 multipart + signed URLs).
- Adapter conformance tests.

## Out of scope
- R2/GCS/Azure/MinIO adapters.
- FileFn server/client logic.

## Deliverables
- `packages/storage-local/src/index.ts`
- `packages/storage-local/src/adapter.ts`
- `packages/storage-local/src/adapter.test.ts`
- `packages/storage-s3/src/index.ts`
- `packages/storage-s3/src/adapter.ts`
- `packages/storage-s3/src/adapter.test.ts`

## Requirements covered
- PKG-002 (partial)
- STORAGE-001
- STORAGE-002
- STORAGE-003
- STORAGE-004

## Implementation tasks
1. Implement storage-local adapter:
   - `capabilities.proxyStreamingUpload = true`
   - `capabilities.proxyStreamingDownload = true`
   - optional signed URL methods may be false.
2. Implement storage-s3 adapter:
   - `capabilities.multipart = true`
   - `capabilities.signedUploadUrls = true`
   - `capabilities.signedDownloadUrls = true`
   - implement create/sign-part/complete/abort using AWS SDK.
3. Implement conformance tests by importing `@superfunctions/storage` conformance runner.

## Verification steps
1. `npm run build -- --filter=@superfunctions/storage-local --filter=@superfunctions/storage-s3`
2. `npm test -- --filter=@superfunctions/storage-local --filter=@superfunctions/storage-s3`
Expected: exit code 0.

## Stop condition
Report:
- The declared capabilities for both adapters.
- Confirmation that both pass conformance tests.
- Any provider limitations encountered (e.g., URL constraint support).
