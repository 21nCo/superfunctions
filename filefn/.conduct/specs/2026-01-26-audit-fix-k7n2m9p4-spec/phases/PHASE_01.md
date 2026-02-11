# PHASE_01

## Phase goal
Unblock uploads by aligning `@filefn/client` with the server’s canonical `{ ok, data }` envelope and the `upload/init` request schema (`size`/`mimeType`).

## In scope
- Client upload init request field names.
- Client envelope unwrapping and error surfacing.

## Out of scope
- Proxy upload/download implementation.
- Authz interface refactor.

## Deliverables
- Modify:
  - `/Users/ar/dev/superfunctions/filefn/client/src/upload-manager.ts` (send `size` + `mimeType`)
  - `/Users/ar/dev/superfunctions/filefn/client/src/client.ts` (unwrap `{ ok: true, data }`)
  - `/Users/ar/dev/superfunctions/filefn/client/src/types.ts` (align request/response types)
  - `/Users/ar/dev/superfunctions/filefn/client/src/index.ts` (public API shape conformance, if needed for this change)
- Update/add tests:
  - `/Users/ar/dev/superfunctions/filefn/client/tests/envelope-unwrapping.test.ts`

## Requirements covered
- CLIENT-001

## Implementation tasks
1. Update init upload input shape used by the upload manager:
   - rename `fileSize` → `size`
   - rename `contentType` → `mimeType`
2. Update the HTTP request helper to:
   - parse JSON
   - if `ok === false`, throw a structured error
   - if `ok === true` and `data` exists, return `data`
3. Ensure request helper preserves `requestId` on thrown errors.
4. Update any client-side types and tests to match.
5. Confirm `UploadHandle.uploadSessionId` is set from the unwrapped `data.uploadSessionId`.

## Verification steps
1. Run client tests:
   - `npm test -- --filter=@filefn/client`
2. Confirm the envelope unwrapping test passes:
   - TV-CLIENT-ENVELOPE-UNWRAP-001

## Stop condition
Report:
- the exact client files changed,
- confirmation that init upload returns a non-undefined `uploadSessionId` and errors include `error.code`.
