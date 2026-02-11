# PHASE_05

## Phase goal
Make upload operations retry-safe and deterministic by completing the idempotency contract, adding completion-time byte validation, and providing a GC cleanup entrypoint.

## In scope
- Init payload hashing completeness.
- Stable completion result storage for repeat completes.
- Part completion idempotency with deterministic conflict behavior.
- Completion-time size validation and new error code(s) if required.
- Cleanup entrypoint for expired sessions.

## Out of scope
- KVStore/RateLimiter API work.
- Observability/event renames.

## Deliverables
- Modify:
  - `/Users/ar/dev/superfunctions/filefn/server/src/upload-sessions/service.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/upload-sessions/routes.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/errors.ts` (add `FILEFN_PART_CONFLICT`, `FILEFN_UPLOAD_SIZE_MISMATCH` as needed)
  - `/Users/ar/dev/superfunctions/filefn/server/src/schema.ts` (if new persisted fields are required)
- Tests:
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/idempotency-complete.test.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/upload-size-validate.test.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/upload-gc.test.ts`

## Requirements covered
- UPLOAD-004
- STORAGE-005
- UPLOAD-006

## Implementation tasks
1. Update idempotency payload hashing for init:
   - include `policy`, `fileName`, `size`, `mimeType`, `fileId` (when present), and `metadata`.
   - include principal/tenant scope in the idempotency key uniqueness model.
2. Implement part completion idempotency:
   - if the same partNumber is completed with the same etag, return success
   - if completed with a different etag, return `409 FILEFN_PART_CONFLICT`.
3. Implement stable completion results:
   - persist the `(fileId, versionId)` produced by completion on the upload session record
   - repeated completes return the persisted pair, not a derived `currentVersionId`.
4. Implement completion-time size validation:
   - after bytes are finalized (multipart complete or proxy assembled), call `storage.statObject`
   - compare `stat.size` to expected `session.size`
   - on mismatch, fail with `409 FILEFN_UPLOAD_SIZE_MISMATCH` and include `{ expected, actual }`.
5. Implement cleanup entrypoint:
   - list sessions with `expiresAt < now` and status not terminal
   - mark/delete sessions
   - attempt storage abort when multipart uploadId exists and adapter supports abort
6. Ensure new error codes are added to `errors.ts` and error envelopes remain canonical.

## Verification steps
1. Run server tests:
   - `npm test -- --filter=@filefn/server`
2. Confirm vectors pass:
   - TV-IDEMPOTENCY-001 / TV-IDEMPOTENCY-NEG-001
   - TV-UPLOAD-PART-COMPLETE-IDEMP-001 / TV-UPLOAD-PART-COMPLETE-IDEMP-NEG-001
   - TV-UPLOAD-COMPLETE-IDEMP-001 / TV-UPLOAD-COMPLETE-IDEMP-NEG-001
   - TV-UPLOAD-COMPLETE-VALIDATE-SIZE-NEG-001
   - TV-UPLOAD-GC-001 / TV-UPLOAD-GC-NEG-001

## Stop condition
Report:
- the exact persisted fields used to store completion results,
- the exact error codes emitted for part conflicts and size mismatches,
- confirmation that repeated completion returns a stable versionId.
