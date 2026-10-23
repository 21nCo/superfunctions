# TEST_VECTORS.md

These vectors are deterministic golden cases for the unresolved audit gaps. All JSON envelopes below are canonical control-plane envelopes unless the vector explicitly describes byte-streaming behavior.

## Global assumptions
1. Deterministic IDs are used in tests:
   - uploadSessionId: `upl_0001`
   - uploadSessionToken: `upls_live_0001`
   - fileId: `file_0001`
   - versionId: `ver_0001`
   - artifactId: `art_0001`
   - permissionId: `perm_0001`
   - requestId: `req_001`
2. Canonical principal in positive authenticated vectors:
   - `principalId = user_123`
   - `tenantId = org_123`
3. When a vector mentions an anonymous session, no principal is resolved and FileFn returns `uploadSessionToken`.
4. Sample policy:
```json
{
  "name": "user-avatar",
  "contentTypes": ["image/png", "image/jpeg"],
  "maxSizeBytes": 10485760,
  "visibility": "private"
}
```

## TV-BUILD-001
Description: All required FileFn packages pass their local verification gates.
Input:
```bash
cd /Users/serro/Documents/dev/n/superfunctions
( cd filefn/server && npm test -- --run && npm run typecheck && npm run build )
( cd filefn/client && npm test -- --run && npm run typecheck && npm run build )
( cd filefn/processing && npm test -- --run && npm run typecheck && npm run build )
( cd uifn/files && npm test -- --run && npm run typecheck && npm run build )
( cd packages/files && npm test -- --run && npm run typecheck && npm run build )
( cd filefn/python && python3 -m pytest )
```
Expected output:
- Every command exits `0`.
- `packages/files` reports at least one executed test.
- `pytest` collects at least one test.
Negative variant(s):
- A failing `tsc` or `pytest` run is non-compliant.

## TV-BUILD-NEG-001
Description: Server typecheck fails when stale test fixtures still do not satisfy the current adapter contract.
Input:
- Keep a mocked `Adapter` test double without the required `internal` property.
- Run `cd filefn/server && npm run typecheck`.
Expected output:
```json
{ "ok": false, "error": { "code": "BUILD_FAILED", "message": "TypeScript typecheck failed" } }
```

## TV-PKG-001
Description: Canonical package names and exports are present.
Input:
```bash
node -p "require('./filefn/client/package.json').name"
node -e "import('@superfunctions/files').then(m => console.log(typeof m))"
python3 - <<'PY'
import filefn
from filefn.server import create_file_fn, FileFnConfig
print(bool(filefn))
print(bool(create_file_fn))
print(bool(FileFnConfig))
PY
```
Expected output:
- TypeScript client package name is `@filefn/client`.
- TypeScript and Python imports succeed.
Negative variant(s):
- Missing or wrong package names/exports are non-compliant.

## TV-PKG-NEG-001
Description: Wrong client package name is rejected.
Input:
- `filefn/client/package.json` still contains `"name": "filefn"`.
Expected output:
```json
{ "ok": false, "error": { "code": "PACKAGE_NAME_MISMATCH", "message": "Expected @filefn/client" } }
```

## TV-ENVELOPE-001
Description: Canonical envelopes and request ID echoing work for control-plane routes.
Input:
```http
GET /policies
x-request-id: req_001
```
Expected output:
```json
{
  "ok": true,
  "data": { "policies": [] },
  "requestId": "req_001"
}
```
Negative variant(s):
- Any raw unwrapped object is non-compliant.

## TV-ENVELOPE-NEG-001
Description: Errors use canonical envelopes.
Input:
```http
POST /upload/init
x-request-id: req_002
content-type: application/json

{"policy":"user-avatar","fileName":"bad.gif","size":100,"mimeType":"image/gif"}
```
Expected output:
```json
{
  "ok": false,
  "error": {
    "code": "FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED",
    "message": "Content type not allowed",
    "details": { "policy": "user-avatar", "mimeType": "image/gif" }
  },
  "requestId": "req_002"
}
```

## TV-UPLOAD-AUTH-001
Description: Upload-session follow-up requests succeed only for the bound initiator context.
Input:
1. Authenticated init as `user_123` creates `upl_0001`.
2. Authenticated `GET /upload/upl_0001/status` as `user_123`.
3. Anonymous init returns `uploadSessionToken = upls_live_0001`.
4. Anonymous `GET /upload/upl_0001/status` with `x-upload-session-token: upls_live_0001`.
Expected output:
- The bound caller succeeds in both authenticated and anonymous flows.
Negative variant(s):
- The same follow-up request as `user_999` returns `403 FILEFN_FORBIDDEN`.
- Anonymous follow-up without token returns `401 FILEFN_SESSION_TOKEN_REQUIRED`.
- Anonymous follow-up with wrong token returns `403 FILEFN_SESSION_TOKEN_INVALID`.

## TV-UPLOAD-AUTH-NEG-001
Description: Session ID alone is insufficient to continue another caller's upload.
Input:
- Use `uploadSessionId = upl_0001` created by `user_123`.
- Call `POST /upload/upl_0001/complete` as `user_999`.
Expected output:
```json
{
  "ok": false,
  "error": { "code": "FILEFN_FORBIDDEN", "message": "Forbidden", "details": {} }
}
```

## TV-ACCESS-001
Description: Version, replace, share, and artifact access enforce binding/authz semantics.
Input:
1. File `file_0001` has version `ver_0001` and artifact `art_0001`.
2. `GET /file_0001/versions/ver_0001` as a reader.
3. `GET /file_0001/artifacts` and `GET /file_0001/artifacts/art_0001/download` as the same reader.
4. Replace upload on `file_0001` initiated and completed by an authorized writer.
Expected output:
- All bound and authorized operations succeed.
Negative variant(s):
- `GET /file_0001/versions/ver_other_file` returns `404 FILEFN_NOT_FOUND`.
- `GET /file_0001/artifacts/art_other_file/download` returns `404 FILEFN_NOT_FOUND`.
- Replace completion by an unauthorized caller returns `403 FILEFN_FORBIDDEN`.

## TV-ACCESS-NEG-001
Description: Cross-file version or artifact references do not leak existence.
Input:
```http
GET /file_0001/versions/ver_9999
x-request-id: req_003
```
Expected output:
```json
{
  "ok": false,
  "error": { "code": "FILEFN_NOT_FOUND", "message": "Version not found", "details": {} },
  "requestId": "req_003"
}
```

## TV-UPLOAD-STATUS-001
Description: Upload status returns the canonical resume shape.
Input:
```http
GET /upload/upl_0001/status
x-request-id: req_004
```
Expected output:
```json
{
  "ok": true,
  "data": {
    "uploadSessionId": "upl_0001",
    "status": "in_progress",
    "totalParts": 3,
    "recordedParts": [1, 2],
    "chunkSizeBytes": 8388608,
    "fileSize": 16777217,
    "expiresAt": "2026-03-21T12:56:10Z"
  },
  "requestId": "req_004"
}
```
Negative variant(s):
- Missing `recordedParts`, `chunkSizeBytes`, or `fileSize` is non-compliant.

## TV-UPLOAD-STATUS-NEG-001
Description: Legacy-only `uploadedParts` output is insufficient.
Input:
- Server returns only `{ uploadedParts: [1,2], totalParts: 3 }`.
Expected output:
```json
{ "ok": false, "error": { "code": "UPLOAD_STATUS_SHAPE_INVALID", "message": "Missing canonical resume fields" } }
```

## TV-UPLOAD-MODE-001
Description: Upload mode selection chooses only canonical modes.
Input:
- Storage capabilities set A: `{ signedUploadUrls: true, multipart: true, proxyStreamingUpload: false }`
- Storage capabilities set B: `{ signedUploadUrls: false, multipart: false, proxyStreamingUpload: true }`
Expected output:
- Set A returns `multipart-signed-url`.
- Set B returns `proxy`.
Negative variant(s):
- No case returns bare `signed-url`.

## TV-UPLOAD-MODE-NEG-001
Description: No supported upload mode fails deterministically.
Input:
- Storage capabilities: `{ signedUploadUrls: false, multipart: false, proxyStreamingUpload: false }`
Expected output:
```json
{
  "ok": false,
  "error": { "code": "FILEFN_NO_SUPPORTED_UPLOAD_MODE", "message": "No supported upload mode", "details": {} }
}
```

## TV-UPLOAD-PROXY-001
Description: Proxy upload records parts durably and completes successfully.
Input:
1. Init returns `uploadMode = proxy` and `uploadSessionId = upl_0001`.
2. `PUT /upload/upl_0001/parts/1` with bytes `abc`.
3. `GET /upload/upl_0001/status`.
4. `POST /upload/upl_0001/complete`.
Expected output:
- Proxy `PUT` returns `{ etag, size: 3, recorded: true }`.
- Status shows `recordedParts: [1]`.
- Complete returns `{ fileId, versionId }`.
Negative variant(s):
- Retrying with conflicting bytes for the same recorded part returns `FILEFN_PART_CONFLICT`.

## TV-UPLOAD-PROXY-NEG-001
Description: Proxy upload rejects conflicting second writes.
Input:
- `PUT /upload/upl_0001/parts/1` once with bytes `abc`, then again with bytes `xyz`.
Expected output:
```json
{
  "ok": false,
  "error": { "code": "FILEFN_PART_CONFLICT", "message": "Part conflict", "details": { "uploadSessionId": "upl_0001", "partNumber": 1 } }
}
```

## TV-IDEMPOTENCY-001
Description: Init and complete are idempotent, and part completion is tuple-idempotent.
Input:
- Repeat identical init with `x-idempotency-key: idem_001`.
- Repeat identical part-complete with same etag/size.
- Repeat complete after a successful complete.
Expected output:
- Each repeat returns the original semantic success result.
Negative variant(s):
- Same init idempotency key with different payload returns `FILEFN_IDEMPOTENCY_CONFLICT`.
- Same part number with different etag returns `FILEFN_PART_CONFLICT`.

## TV-IDEMPOTENCY-NEG-001
Description: Conflicting idempotency input is rejected.
Input:
- `POST /upload/init` twice with `x-idempotency-key: idem_001` but different `size`.
Expected output:
```json
{
  "ok": false,
  "error": { "code": "FILEFN_IDEMPOTENCY_CONFLICT", "message": "Idempotency conflict", "details": {} }
}
```

## TV-UPLOAD-GC-001
Description: GC cleans expired incomplete sessions and temp data.
Input:
- Create expired proxy and multipart sessions with recorded temp parts.
- Run the cleanup entrypoint.
Expected output:
- Expired incomplete sessions are deleted.
- Multipart uploads are aborted when supported.
- Proxy temp objects and upload part rows are removed.
Negative variant(s):
- Completed sessions remain intact.

## TV-UPLOAD-GC-NEG-001
Description: GC does not delete completed sessions.
Input:
- Run cleanup when `upl_0001` is completed.
Expected output:
```json
{ "ok": true, "data": { "deletedSessions": 0, "preservedCompletedSessions": 1 } }
```

## TV-FILE-LIST-001
Description: List returns the readable file set in deterministic order.
Input:
- Files visible to `user_123`: `file_003` updated later than `file_001`; `file_002` is private to another user.
- Request: `GET /?limit=2`.
Expected output:
```json
{
  "ok": true,
  "data": {
    "files": [
      { "fileId": "file_003" },
      { "fileId": "file_001" }
    ]
  }
}
```
Negative variant(s):
- `file_002` is never included.
- Re-running the same query with the same dataset preserves order.

## TV-FILE-LIST-NEG-001
Description: Unsorted prefetch behavior is non-compliant.
Input:
- Implementation fetches first 1000 unsorted files then filters in memory.
Expected output:
```json
{ "ok": false, "error": { "code": "LIST_NOT_DETERMINISTIC", "message": "Readable set is incomplete or unstable" } }
```

## TV-VERSION-001
Description: Version-aware reads and downloads honor `versionId`.
Input:
- `GET /file_0001/versions/ver_0001`
- `GET /file_0001/versions/ver_0001/download`
- `FileProvider.getFile({ fileId: 'file_0001', versionId: 'ver_0001' })`
Expected output:
- All responses refer to `ver_0001`, not merely the current version.
Negative variant(s):
- A `versionId` from another file returns `404 FILEFN_NOT_FOUND`.

## TV-VERSION-NEG-001
Description: Provider `getFile({ versionId })` ignoring `versionId` is non-compliant.
Input:
- Call provider `getFile({ fileId: 'file_0001', versionId: 'ver_old' })` when current version is `ver_new`.
Expected output:
```json
{ "ok": false, "error": { "code": "VERSION_BINDING_BROKEN", "message": "Provider ignored requested versionId" } }
```

## TV-DOWNLOAD-FALLBACK-001
Description: File, share, and artifact control-plane downloads return real URLs and proxy routes work.
Input:
- Signed-download unsupported; proxy streaming supported.
- Requests:
  - `GET /file_0001/download`
  - `GET /share-links/shr_live_0001/download`
  - `GET /file_0001/artifacts/art_0001/download`
Expected output:
- File download descriptor returns `/proxy/files/file_0001/download`.
- Share descriptor returns `/proxy/share-links/shr_live_0001/download`.
- Artifact descriptor returns `/proxy/files/file_0001/artifacts/art_0001/download`.
- The corresponding proxy routes stream bytes successfully.
Negative variant(s):
- No descriptor returns `proxy://...`.

## TV-DOWNLOAD-FALLBACK-NEG-001
Description: Placeholder proxy schemes are rejected.
Input:
- Share or artifact download returns `proxy://bucket/key`.
Expected output:
```json
{ "ok": false, "error": { "code": "INVALID_PROXY_DESCRIPTOR", "message": "Download descriptor must be an HTTP URL" } }
```

## TV-DELETE-CASCADE-001
Description: Delete cascades metadata cleanup and preserves reference-safe storage semantics.
Input:
- `file_0001` has versions, permissions, shares, artifacts, and one dedupe-shared storage key also referenced by `file_0002`.
- Delete `file_0001`.
Expected output:
- `file_0001` metadata, grants, shares, artifacts, and pending upload metadata are removed.
- Shared storage key is not physically deleted while `file_0002` still references it.
- Quota change reflects only bytes whose last live reference was removed.
Negative variant(s):
- Orphaned grants/share/artifact rows are non-compliant.

## TV-DELETE-CASCADE-NEG-001
Description: Delete must not physically remove a still-referenced storage key.
Input:
- Delete one of two files referencing the same deduped storage key.
Expected output:
```json
{ "ok": true, "data": { "deleted": true, "physicallyDeletedStorageKeys": [] } }
```

## TV-DEDUP-001
Description: Tenant-scoped dedupe reuses storage within a tenant when enabled.
Input:
- Tenant `org_123` uploads the same bytes twice with dedupe enabled.
Expected output:
- The second upload reuses the existing storage key.
- Both logical records remain independently readable/deletable.
Negative variant(s):
- Cross-tenant uploads of the same bytes do not dedupe.

## TV-DEDUP-NEG-001
Description: Cross-tenant dedupe is forbidden.
Input:
- `org_123` and `org_999` upload the same bytes with dedupe enabled.
Expected output:
```json
{ "ok": true, "data": { "sharedStorageKey": false } }
```

## TV-RATE-001
Description: Per-route-category rate limits return ISO resetAt.
Input:
- Configure `uploadInit` limit `1 request / 60 seconds`.
- Call `POST /upload/init` twice.
Expected output:
- First request succeeds.
- Second request returns `429 FILEFN_RATE_LIMITED` with ISO8601 `resetAt`.
Negative variant(s):
- Numeric-only `resetAt` is non-compliant.

## TV-RATE-NEG-001
Description: Missing route-category support is non-compliant.
Input:
- Configure only a single shared `maxRequests` value with no route categories.
Expected output:
```json
{ "ok": false, "error": { "code": "RATE_LIMIT_CONFIG_INVALID", "message": "Missing route-category limits" } }
```

## TV-PROCESS-001
Description: Upload completion triggers idempotent processing and artifact access is authorized.
Input:
- Processing enabled with FlowFn queue.
- Complete upload for `file_0001/ver_0001` twice.
- Read artifacts as an authorized reader.
Expected output:
- Only one queue job is enqueued for the same `(fileId, versionId, processor config)` key.
- Artifact list/download succeeds for an authorized reader.
Negative variant(s):
- Unauthorized artifact download returns `403 FILEFN_FORBIDDEN`.
- Queue failure returns `503 FILEFN_PROCESSING_ENQUEUE_FAILED`.

## TV-PROCESS-NEG-001
Description: Artifact download without parent-file access is rejected.
Input:
- `GET /file_0001/artifacts/art_0001/download` as `user_999` without read access.
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_FORBIDDEN", "message": "Forbidden", "details": {} } }
```

## TV-OBS-001
Description: Logs/events preserve request IDs and redact secrets.
Input:
- Trigger upload + share + download flows with `x-request-id: req_001`.
Expected output:
- Emitted events include `requestId: req_001`.
- Logged signed URLs, share tokens, and upload session tokens are redacted.
- Safe IDs remain visible.
Negative variant(s):
- Plaintext signed URLs or tokens in logs are non-compliant.

## TV-OBS-NEG-001
Description: Over-redacting safe IDs is non-compliant.
Input:
- Log context `{ requestId: 'req_001', fileId: 'file_001' }`.
Expected output:
```json
{ "ok": false, "error": { "code": "OVER_REDACTION", "message": "Safe identifiers were redacted" } }
```

## TV-CLIENT-001
Description: Browser client resumes canonical uploads and handles anonymous session tokens.
Input:
- Start a proxy upload anonymously.
- Persist `uploadSessionId` and `uploadSessionToken`.
- Resume after one recorded part.
Expected output:
- Client uses the canonical status payload.
- Resume succeeds and returns `{ fileId, versionId }`.
Negative variant(s):
- Missing token on anonymous resume fails with session-token errors.

## TV-CLIENT-NEG-001
Description: Client relying only on `uploadedParts` is non-compliant.
Input:
- Client resume logic ignores `recordedParts`, `chunkSizeBytes`, or `fileSize`.
Expected output:
```json
{ "ok": false, "error": { "code": "CLIENT_RESUME_CONTRACT_BROKEN", "message": "Client did not use canonical status fields" } }
```

## TV-CLIENT-OFFLINE-001
Description: Offline mode stages, reports progress, aborts, and syncs deterministically.
Input:
- Enable offline mode in an OPFS-capable browser.
- Stage an upload offline, register a progress callback, abort once, retry, then sync online.
Expected output:
- Progress callbacks fire for staging/sync.
- Abort cancels the staged upload.
- Retrying and syncing produces a canonical completed upload.
Negative variant(s):
- Unsupported environments return `FILEFN_OFFLINE_UNSUPPORTED`.

## TV-CLIENT-OFFLINE-NEG-001
Description: Offline mode requested where OPFS is unavailable is rejected.
Input:
- `createFileFnClient({ offline: { enabled: true } })` in a non-OPFS environment.
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_OFFLINE_UNSUPPORTED", "message": "Offline mode is not supported" } }
```

## TV-PY-CORE-001
Description: Python exports and config surfaces are real and usable.
Input:
```bash
python3 - <<'PY'
from filefn import create_file_fn
from filefn.server import FileFnConfig
print(bool(create_file_fn))
print(bool(FileFnConfig))
PY
```
Expected output:
- Imports succeed.
- `FileFnConfig` includes functional `auth`, `rate_limit`, and `dedup` fields.
Negative variant(s):
- Placeholder config fields or missing exports are non-compliant.

## TV-PY-CORE-NEG-001
Description: Placeholder Python auth/rate-limit config is rejected.
Input:
- `AuthConfig` remains `pass` or `rate_limit` remains documented as unimplemented.
Expected output:
```json
{ "ok": false, "error": { "code": "PY_CORE_PLACEHOLDER", "message": "Python core configuration is incomplete" } }
```

## TV-PY-FLOWS-001
Description: Python canonical flows match TypeScript semantics.
Input:
- Run Python tests that cover:
  - canonical upload init/status/complete
  - proxy/signed download descriptors
  - version-aware reads
  - share download behavior
  - processing protocol correctness
Expected output:
- Python results match the canonical semantics of this spec.
Negative variant(s):
- Returning bare `signed-url`, wrong status shape, or using undeclared storage methods is non-compliant.

## TV-PY-FLOWS-NEG-001
Description: Python storage protocol mismatch is rejected.
Input:
- Python processing service calls `upload_object` while the protocol defines only `put_object`.
Expected output:
```json
{ "ok": false, "error": { "code": "PY_PROTOCOL_MISMATCH", "message": "Python implementation uses undeclared storage protocol methods" } }
```

## TV-PY-TESTS-001
Description: Python test suite exists and passes.
Input:
```bash
cd /Users/serro/Documents/dev/n/superfunctions/filefn/python && python3 -m pytest
```
Expected output:
- `pytest` collects core tests and exits `0`.
Negative variant(s):
- `0 tests collected` is non-compliant.

## TV-PY-TESTS-NEG-001
Description: No collected Python tests is rejected.
Input:
- `pytest` reports `collected 0 items`.
Expected output:
```json
{ "ok": false, "error": { "code": "PY_TESTS_MISSING", "message": "Python test suite collected no tests" } }
```

## TV-DEMO-001
Description: Full demo smoke test succeeds.
Input:
- Start `filefn/examples/full-demo/server`.
- Start `filefn/examples/full-demo/client`.
- Upload an image, confirm it appears in the list, download it, then delete it.
Expected output:
- All four actions succeed against canonical packages/routes.
Negative variant(s):
- A broken upload/list/download/delete path is non-compliant.

## TV-DEMO-NEG-001
Description: Demo using wrong package boundary or broken route semantics fails smoke verification.
Input:
- Demo still depends on non-canonical package names or stale response shapes.
Expected output:
```json
{ "ok": false, "error": { "code": "DEMO_SMOKE_FAILED", "message": "Demo does not exercise canonical FileFn behavior" } }
```
