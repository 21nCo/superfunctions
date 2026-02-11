# PHASE_02

## Phase goal
Bring `@filefn/server` router coverage and response envelopes into alignment with the audited spec by implementing missing routes and ensuring canonical `{ ok, data|error }` responses.

## In scope
- Implement missing HTTP routes: `/policies`, `/quota/storage`, `/:fileId/versions/:versionId`.
- Ensure route handlers use canonical envelopes and stable error codes.

## Out of scope
- Proxy upload/download streaming.
- Full authz refactor (handled in Phase 03).

## Deliverables
- Modify:
  - `/Users/ar/dev/superfunctions/filefn/server/src/router.ts` (route wiring)
  - `/Users/ar/dev/superfunctions/filefn/server/src/policies.ts` (export/list policy constraints if needed)
  - `/Users/ar/dev/superfunctions/filefn/server/src/files/routes.ts` (add `getVersion` route handler)
  - `/Users/ar/dev/superfunctions/filefn/server/src/files/service.ts` (add `getVersion` service method + binding checks)
- Add new route module(s) as needed:
  - `/Users/ar/dev/superfunctions/filefn/server/src/policies.routes.ts` (new)
  - `/Users/ar/dev/superfunctions/filefn/server/src/quota.routes.ts` (new)
- Update/add server tests:
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/policies.test.ts` (new or extend)
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/quota-storage.test.ts` (new)
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/versions-metadata.test.ts` (from Phase 00)

## Requirements covered
- SERVER-002
- POLICY-001
- VERSION-001 (metadata route portion)

## Implementation tasks
1. Implement `GET /policies`:
   - return `[{ name, maxSizeBytes, contentTypes }]` per TV-POLICY-LIST-001.
2. Implement `GET /quota/storage`:
   - if `quota.getUsage` exists, return `{ current, limit }`.
   - if not configured, return `404 FILEFN_NOT_FOUND`.
3. Implement `GET /:fileId/versions/:versionId`:
   - verify the version belongs to fileId
   - enforce authorization (read)
   - return deterministic metadata per TV-VERSION-GET-001.
4. Wire the routes into `router.ts`.
5. Ensure errors use `filefn/server/src/errors.ts` codes and canonical envelopes.

## Verification steps
1. Run server tests:
   - `npm test -- --filter=@filefn/server`
2. Confirm vectors pass:
   - TV-POLICY-LIST-001
   - TV-QUOTA-GET-001
   - TV-VERSION-GET-001

## Stop condition
Report:
- the new routes added and their exact response shapes,
- confirmation that the router returns `null` only for truly-unhandled routes.
