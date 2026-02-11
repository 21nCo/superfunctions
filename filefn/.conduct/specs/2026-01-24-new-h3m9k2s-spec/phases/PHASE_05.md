# Phase 05

## Phase goal
Add authorization semantics: grants, visibility, share links, delete, and secret-safe observability.

## In scope
- Permission grants CRUD.
- Visibility semantics (`private/shared/public`).
- Share links (token, expiry, requiresAuth, maxDownloads, revoke).
- Delete file endpoint and quota negative usage.
- Event emission and log redaction.

## Out of scope
- Client SDK.
- Processing.

## Deliverables
- `filefn/server/src/authz/authorizer.ts` (default authorizer)
- `filefn/server/src/authz/grants.service.ts`
- `filefn/server/src/authz/grants.routes.ts`
- `filefn/server/src/shares/service.ts`
- `filefn/server/src/shares/routes.ts`
- `filefn/server/src/files/delete.ts`
- `filefn/server/src/observability/logger.ts`
- `filefn/server/tests/permissions.test.ts`
- `filefn/server/tests/shares.test.ts`
- `filefn/server/tests/observability.test.ts`

## Requirements covered
- AUTHZ-001
- AUTHZ-002
- AUTHZ-003
- AUTHZ-004
- SHARE-001
- FILE-003
- QUOTA-001 (finalize: negative usage on delete)
- PROCESS-001 (events)
- OBS-001

## Implementation tasks
1. Implement `composeAuthorizers()` helper supporting `first-allow` and `all-must-allow`.
2. Implement default `Authorizer` enforcing:
   - owner allow-all
   - admin allow-all
   - public read(content)
   - shared read(content) within tenant
   - explicit grants (user/role/tenant) with expiry
2. Implement grant routes:
   - `POST /:fileId/permissions`
   - `GET /:fileId/permissions`
   - `DELETE /:fileId/permissions/:permissionId`
3. Implement share routes:
   - `POST /:fileId/share-links`
   - `GET /share-links/:token/download`
   - `DELETE /:fileId/share-links/:token`
   - store token hashes and enforce expiry/maxDownloads
4. Implement delete:
   - delete all versions + artifacts
   - record negative quota usage
5. Integrate LogFn:
   - log requestId, fileId, uploadSessionId
   - ensure signed URLs and share tokens are not logged
6. Emit events with requestId:
   - `file:uploaded`, `file:deleted`, `file:processing_*`
7. Add tests for vectors:
   - TV-AUTHZ-COMPOSE-001 / TV-AUTHZ-COMPOSE-NEG-001
   - TV-PERM-GRANT-001 / TV-PERM-GRANT-NEG-001
   - TV-VISIBILITY-001 / TV-VISIBILITY-NEG-001
   - TV-SHARE-CREATE-001 / TV-SHARE-DOWNLOAD-NEG-001
   - TV-FILE-DELETE-001 / TV-FILE-DELETE-NEG-001
   - TV-OBS-LOG-NEG-001

## Verification steps
1. `npm run build -- --filter=@filefn/server`
2. `npm test -- --filter=@filefn/server`
Expected: exit code 0.

## Stop condition
Report:
- The finalized default authz rules.
- Confirmation that logs/events do not leak signed URLs or share tokens.
