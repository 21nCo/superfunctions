# Phase 04

## Phase goal
Implement server-side file CRUD and versioning endpoints with authorization hooks.

## In scope
- File metadata endpoints (`GET /`, `GET /:fileId`).
- Download endpoint (`GET /:fileId/download` and version download).
- Download rate limiting (when configured).
- Version listing endpoints.
- Replace workflow wiring (upload-init with `fileId` → new version).

## Out of scope
- Permission grants and share links.
- Processing.
- Client SDK.

## Deliverables
- `filefn/server/src/files/service.ts`
- `filefn/server/src/files/routes.ts`
- `filefn/server/src/versions/routes.ts`
- `filefn/server/tests/files.test.ts`
- `filefn/server/tests/versions.test.ts`

## Requirements covered
- FILE-001
- FILE-002
- FILE-004
- VERSION-001
- RATE-001 (finalize: download limiting; upload init/sign handled in Phase 03)
- AUTHZ-001 (hook points; final semantics in next phase)

## Implementation tasks
1. Implement file read model:
   - `getFile(fileId)` returns file + current version metadata.
2. Implement list:
   - `GET /` returns accessible files (owner-only for now; later expanded by grants).
3. Implement download:
   - generate signed download URL via adapter or proxy stream if configured.
   - if `rateLimit` is configured, enforce `limits.download` using `@superfunctions/middleware`.
4. Implement versions:
   - list versions newest-first
   - download for a specific version
5. Add tests covering:
   - TV-FILE-GET-001
   - TV-FILE-DOWNLOAD-001
   - TV-VERSION-LIST-001
   - TV-RATE-NEG-001 (download variant)
   - Negative cases for forbidden access.

## Verification steps
1. `npm run build -- --filter=@filefn/server`
2. `npm test -- --filter=@filefn/server`
Expected: exit code 0.

## Stop condition
Report:
- Implemented endpoints and which authz checks are enforced.
- Any changes required to error codes/envelopes.
