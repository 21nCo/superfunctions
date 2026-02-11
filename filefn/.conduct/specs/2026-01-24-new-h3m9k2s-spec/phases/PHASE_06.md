# Phase 06

## Phase goal
Implement `@filefn/client` online resumable uploads with progress, retries, and resume.

## In scope
- Client HTTP wrapper for FileFn server endpoints.
- Upload manager for multipart-signed-url mode.
- Progress callbacks and abort.
- Resume using `GET /upload/:id/status`.

## Out of scope
- Offline OPFS staging (separate phase).
- UI components.

## Deliverables
- `filefn/client/src/index.ts`
- `filefn/client/src/client.ts`
- `filefn/client/src/upload-manager.ts`
- `filefn/client/src/retry.ts`
- `filefn/client/tests/upload.test.ts`

## Requirements covered
- CLIENT-001
- CLIENT-003

## Implementation tasks
1. Implement `createFileFnClient({ baseUrl, getAuthHeaders })`.
2. Implement `uploadFile` flow:
   - call `POST /upload/init`
   - compute parts/chunks from file size
   - for each part: call sign → upload to signed URL → call part-complete
   - call complete
3. Implement progress reporting:
   - report bytesUploaded/bytesTotal
4. Implement retry policy for:
   - sign failures
   - transient upload failures
   - part-complete failures
5. Implement resume:
   - on restart, call status and upload only missing parts
6. Add integration tests that run against a local in-process server instance.

## Verification steps
1. `npm run build -- --filter=@filefn/client`
2. `npm test -- --filter=@filefn/client`
Expected: exit code 0.

## Stop condition
Report:
- The client’s supported upload modes.
- Known limitations (e.g., concurrency defaults).
- Confirmation that TV-CLIENT-UPLOAD-001 and TV-CLIENT-HOOKS-001 behaviors pass.
