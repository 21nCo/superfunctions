# PHASE_04

## Phase goal
Implement the missing proxy upload and proxy download data-plane endpoints so FileFn works with adapters that cannot sign URLs (e.g., `storage-local`).

## In scope
- Proxy upload endpoint: `PUT /upload/:uploadSessionId/parts/:partNumber`.
- Proxy download endpoints:
  - `GET /proxy/files/:fileId/download`
  - `GET /proxy/files/:fileId/versions/:versionId/download`
- Capability-gated behavior in sign-part and download URL generation.
- Client SDK handling of `uploadMode=proxy`.

## Out of scope
- Idempotency and size validation improvements (Phase 05).

## Deliverables
- Server:
  - `/Users/ar/dev/superfunctions/filefn/server/src/router.ts` (add proxy routes + PUT upload part)
  - `/Users/ar/dev/superfunctions/filefn/server/src/upload-sessions/routes.ts` (handle PUT part upload)
  - `/Users/ar/dev/superfunctions/filefn/server/src/upload-sessions/service.ts` (proxy mode sign + persistence for part bytes)
  - `/Users/ar/dev/superfunctions/filefn/server/src/files/routes.ts` (proxy streaming handlers)
  - `/Users/ar/dev/superfunctions/filefn/server/src/files/service.ts` (return proxy URLs; use `openDownloadStream`)
- Client:
  - `/Users/ar/dev/superfunctions/filefn/client/src/upload-manager.ts` (branch on `uploadMode`)
  - `/Users/ar/dev/superfunctions/filefn/client/src/client.ts` (support non-JSON byte upload for proxy PUT)
- Tests:
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/upload-proxy.test.ts`
  - `/Users/ar/dev/superfunctions/filefn/server/src/__tests__/file-download-proxy.test.ts` (new)
  - extend `/Users/ar/dev/superfunctions/filefn/client/tests/*` for proxy upload path

## Requirements covered
- UPLOAD-005
- FILE-002
- STORAGE-002

## Implementation tasks
1. Define proxy upload storage strategy (implementation-defined but must support completion):
   - recommended for `storage-local`: store part bytes under a temp directory keyed by `uploadSessionId` and `partNumber`.
2. Implement `PUT /upload/:id/parts/:partNumber`:
   - validate session exists and is in a writable state
   - validate partNumber bounds
   - stream request bytes to temp storage
   - return `{ etag, size, recorded: true }` in success envelope
3. Update `POST /upload/:id/parts/:partNumber/sign`:
   - when `uploadMode=proxy`, return `data.url` pointing to the PUT endpoint.
4. Implement proxy download endpoints:
   - enforce authorization
   - open stream via `storage.openDownloadStream`
   - set `content-type` and `content-length` when known
5. Update `GET /:fileId/download` and version download control-plane to:
   - return proxy URL when signed URLs are unsupported and proxy is supported.
6. Update client upload manager:
   - if `uploadMode=proxy`, upload bytes via `PUT` to the returned URL and proceed to completion.

## Verification steps
1. Run server+client tests:
   - `npm test -- --filter=@filefn/server --filter=@filefn/client`
2. Confirm vectors pass:
   - TV-UPLOAD-PROXY-001
   - TV-FILE-DOWNLOAD-PROXY-001

## Stop condition
Report:
- the exact proxy routes added,
- how proxy-uploaded bytes are persisted until completion,
- confirmation that proxy download streams real bytes (not `proxy://...`).
