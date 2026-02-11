# PHASE_00

## Phase goal
Encode the audit-fix gaps as failing, deterministic tests corresponding to the new/updated test vectors.

## In scope
- Add/adjust tests for the new vectors introduced by this spec (proxy upload/download, list accessible, version metadata, idempotent complete/part-complete conflicts, size validation, GC entrypoint, KVStoreAdapter shape, correlation-id redaction).

## Out of scope
- Implementing the fixes themselves (those begin in Phase 01+).

## Deliverables
- Create/modify tests:
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/upload-proxy.test.ts` (new)
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/files-list-accessible.test.ts` (new)
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/versions-metadata.test.ts` (new)
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/idempotency-complete.test.ts` (new)
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/upload-size-validate.test.ts` (new)
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/upload-gc.test.ts` (new)
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/observability-redaction.test.ts` (new or extend existing)
  - `/Users/ar/dev/superfunctions/filefn/client/tests/envelope-unwrapping.test.ts` (new)
- Add any required test fakes/helpers under existing test utilities directories (server/client).

## Requirements covered
- CLIENT-001 (partial: envelope unwrapping assertions)
- SERVER-002 (partial: missing routes test scaffolding)
- FILE-001
- FILE-002
- VERSION-001
- UPLOAD-004
- UPLOAD-005
- UPLOAD-006
- STORAGE-005
- OBS-001
- PKG-007 (type-level test)
- PKG-006 (type-level + unit)

## Implementation tasks
1. Add a deterministic fake StorageAdapter capable of:
   - signed URL mode (existing patterns)
   - proxy streaming upload/download mode (new), using in-memory buffers for tests.
2. Add new server router tests for:
   - `GET /policies`
   - `GET /quota/storage`
   - `GET /:fileId/versions/:versionId`
3. Add tests for list accessibility semantics:
   - owned/private
   - other/public
   - other/shared in same tenant
   - granted read
4. Add idempotency tests:
   - complete returns stable versionId on second call
   - part completion conflict returns `FILEFN_PART_CONFLICT`
5. Add completion-time size validation test expecting `FILEFN_UPLOAD_SIZE_MISMATCH`.
6. Add GC entrypoint test asserting:
   - expired sessions deleted
   - non-expired preserved
7. Add client test asserting envelope unwrapping via a public method (`getFile` or `uploadFile`).
8. Add a redaction test asserting `req_001` is preserved, and signed URLs are not logged.
9. Ensure the tests compile and run (expected to fail until later phases).

## Verification steps
1. Run server+client tests (expected to FAIL in this phase):
   - `npm test -- --filter=@filefn/server --filter=@filefn/client`
2. Confirm failures correspond to the new vectors and missing functionality, not unrelated flakes.

## Stop condition
Report:
- list of newly-added tests and which requirement/vector each encodes,
- the exact failing assertions that correspond to remaining missing implementations.
