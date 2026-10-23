# PHASE_03

## Phase goal
Eliminate authorization gaps by implementing the audited `Authorizer` interface end-to-end, fixing replace-by-fileId enforcement, list accessibility semantics, and version binding protections.

## In scope
- Replace the legacy `{ canRead/canWrite/... }` authorizer usage with the audited `Authorizer` interface (resource + action).
- Enforce authz on upload init/complete for replace.
- Implement `GET /` accessible listing semantics.
- Fix version download binding bug.
- Fix `composeAuthorizers` signature.

## Out of scope
- Proxy upload/download streaming endpoints.
- KVStore/RateLimiter API alignment.

## Deliverables
- Modify/replace authz modules:
  - `/Users/ar/dev/superfunctions/filefn/server/src/authz/authorizer.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/authz/grants.service.ts` (if needed for filters)
  - `/Users/ar/dev/superfunctions/filefn/server/src/authz/grants.routes.ts` (if needed)
  - `/Users/ar/dev/superfunctions/filefn/server/src/index.ts` (config accepts `authorization.authorizer`)
- Modify upload + file services/routes to enforce authz:
  - `/Users/ar/dev/superfunctions/filefn/server/src/upload-sessions/service.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/upload-sessions/routes.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/files/service.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/files/routes.ts`
- Tests:
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/files-list-accessible.test.ts` (from Phase 00)
  - extend existing upload-sessions + files tests to include replace negative and list semantics

## Requirements covered
- AUTHZ-001
- AUTHZ-003
- AUTHZ-004
- FILE-001
- FILE-004
- VERSION-001 (binding portion)

## Implementation tasks
1. Implement `Authorizer` types per audited spec (resource + action).
2. Implement `composeAuthorizers(authorizers, options?)` with the required signature and strategies.
3. Enforce authorization in upload init:
   - create vs replace resource selection
   - deny replace when `write` is not allowed.
4. Enforce authorization in upload completion:
   - ensure replace path re-checks write authorization for the target file.
5. Implement accessible list semantics:
   - owned
   - public
   - shared within tenant
   - explicit grants
   - apply authorizer filters when provided
6. Fix version download binding:
   - in download/version handlers, verify `version.fileId === fileId` before issuing URL/stream
   - return `404 FILEFN_NOT_FOUND` on mismatch.

## Verification steps
1. Run server tests:
   - `npm test -- --filter=@filefn/server`
2. Confirm vectors pass:
   - TV-VERSION-REPLACE-NEG-001
   - TV-FILE-LIST-001
   - TV-VERSION-DOWNLOAD-BINDING-NEG-001
   - TV-AUTHZ-COMPOSE-001 / TV-AUTHZ-COMPOSE-NEG-001

## Stop condition
Report:
- which routes now call the authorizer (list them explicitly),
- confirmation that replace-by-fileId is blocked without write permission.
