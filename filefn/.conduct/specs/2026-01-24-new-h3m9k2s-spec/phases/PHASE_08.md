# Phase 08

## Phase goal
Add S3-compatible storage adapters (R2 + MinIO) and harden Local adapter.

## In scope
- `@superfunctions/storage-r2` (Cloudflare R2 via S3-compatible API)
- `@superfunctions/storage-minio` (S3-compatible)
- Local adapter hardening (range reads, safe paths)

## Out of scope
- GCS and Azure.

## Deliverables
- `packages/storage-r2/src/adapter.ts`
- `packages/storage-r2/src/adapter.test.ts`
- `packages/storage-minio/src/adapter.ts`
- `packages/storage-minio/src/adapter.test.ts`
- `packages/storage-local/src/adapter.ts` (updates)

## Requirements covered
- PKG-002 (partial)
- STORAGE-001
- STORAGE-002
- STORAGE-003
- STORAGE-004

## Implementation tasks
1. Implement R2 adapter with accurate capabilities.
2. Implement MinIO adapter with accurate capabilities.
3. Add conformance tests for both.
4. Harden local adapter:
   - prevent path traversal
   - support optional range reads for proxy download

## Verification steps
1. `npm run build -- --filter=@superfunctions/storage-r2 --filter=@superfunctions/storage-minio --filter=@superfunctions/storage-local`
2. `npm test -- --filter=@superfunctions/storage-r2 --filter=@superfunctions/storage-minio --filter=@superfunctions/storage-local`
Expected: exit code 0.

## Stop condition
Report:
- Any provider limitations for signed URL constraints.
- Confirmation that conformance tests pass.
