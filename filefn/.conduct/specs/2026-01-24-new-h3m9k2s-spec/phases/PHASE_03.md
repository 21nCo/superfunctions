# Phase 03

## Phase goal
Implement `@filefn/server` core: schema, policy engine, auth plumbing, and upload sessions.

## In scope
- DB schema (`getSchema`) for upload sessions + parts + files + versions.
- Policy registry (`definePolicy`) and policy enforcement at upload init.
- Authentication plumbing (provider and/or resolveSession; getSession caching; principal mapping).
- Upload-session endpoints:
  - `POST /upload/init`
  - `GET /upload/:id/status`
  - `POST /upload/:id/parts/:n/sign`
  - `POST /upload/:id/parts/:n/complete`
  - `POST /upload/:id/complete`
  - `POST /upload/:id/abort`

## Out of scope
- Permissions/shares/visibility.
- Client SDK.
- Processing.

## Deliverables
- `filefn/server/src/index.ts`
- `filefn/server/src/schema.ts`
- `filefn/server/src/router.ts`
- `filefn/server/src/policies.ts`
- `filefn/server/src/auth.ts`
- `filefn/server/src/upload-sessions/service.ts`
- `filefn/server/src/upload-sessions/routes.ts`
- `filefn/server/src/errors.ts`
- `filefn/server/src/events.ts`
- `filefn/server/tests/upload-sessions.test.ts`

## Requirements covered
- SERVER-001
- SERVER-002
- SERVER-003
- SERVER-004
- UPLOAD-001
- UPLOAD-002
- UPLOAD-003
- UPLOAD-004
- UPLOAD-005
- UPLOAD-006
- AUTH-001
- POLICY-001
- QUOTA-001 (partial: upload init/complete; delete accounting finalized in Phase 05)
- RATE-001 (partial: upload init/sign; download limiting finalized in Phase 04)
- OBS-002

## Implementation tasks
1. Implement DB schema models:
   - `files`, `fileVersions`, `uploadSessions`, `uploadParts`.
2. Implement a policy registry with:
   - initial policies from config
   - `definePolicy(name, policy)`
3. Implement authentication resolution:
   - resolve session from `resolveSession(req)` or `auth.provider.getSession?.(req)` or `auth.provider.authenticate(req)`
   - map to `FileFnPrincipal` (or null)
4. Implement upload session service:
   - create session (idempotency support)
   - compute totalParts from size + chunkSize
   - compute `expiresAt` from configured TTL
   - create multipart upload via adapter when supported
   - sign parts (capability gated; reject if session is expired)
   - record part completion (etag + size)
   - complete session (re-check quota, complete multipart, create file+version; reject if expired)
   - abort (abort multipart + mark aborted)
   - garbage-collect expired sessions (delete rows; abort multipart when supported)
5. Implement router handlers using `@superfunctions/http` and canonical envelopes.
   - If `rateLimit` is configured, enforce limits using `@superfunctions/middleware` on upload init + part sign routes.
6. Add unit/integration tests for:
   - TV-UPLOAD-INIT-001
   - TV-UPLOAD-INIT-NEG-001
   - TV-RATE-NEG-001 (upload init example)
   - TV-UPLOAD-PART-SIGN-NEG-001
   - TV-UPLOAD-COMPLETE-NEG-001
   - TV-UPLOAD-EXPIRE-001
   - TV-UPLOAD-EXPIRE-NEG-001
   - TV-IDEMPOTENCY-001

## Verification steps
1. `npm run build -- --filter=@filefn/server`
2. `npm test -- --filter=@filefn/server`
Expected: exit code 0.

## Stop condition
Report:
- Implemented endpoints and their request/response shapes.
- Which storage adapter(s) were used in tests (local or fake).
- Any deviations from SPEC.md (must be corrected before next phase).
