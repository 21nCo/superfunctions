# Test Vectors (FileFn)

These vectors are **documentation-first golden cases**. Implementations SHOULD create automated tests that execute these vectors.

## Global test harness assumptions
1. A deterministic ID generator is used in tests so IDs are stable:
   - uploadSessionId: `upl_0001`, `upl_0002`
   - fileId: `file_0001`
   - versionId: `ver_0001`, `ver_0002`
   - permissionId: `perm_0001`
   - share token (plaintext returned once): `shr_live_0001`
   - share token hash stored in DB: `sha256(shr_live_0001)`
2. A deterministic fake storage adapter returns stable URLs:
   - multipart part upload URL: `https://storage.test/upload/{uploadId}/part/{partNumber}`
   - download URL: `https://storage.test/download/{key}`
3. Unless stated otherwise, requests include:
   - `x-request-id: req_001`
   - authenticated principal `user_123` in tenant `org_123`.
4. A sample policy exists:
```json
{
  "name": "user-avatar",
  "contentTypes": ["image/png", "image/jpeg"],
  "maxSizeBytes": 10485760,
  "visibility": "private"
}
```

## Error envelope and codes
All JSON errors use:
```json
{
  "ok": false,
  "error": { "code": "FILEFN_...", "message": "...", "details": {} },
  "requestId": "req_..."
}
```

Canonical codes used in vectors:
- `FILEFN_AUTH_REQUIRED` (401)
- `FILEFN_FORBIDDEN` (403)
- `FILEFN_NOT_FOUND` (404)
- `FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED` (400)
- `FILEFN_POLICY_MAX_SIZE_EXCEEDED` (400)
- `FILEFN_QUOTA_EXCEEDED` (402)
- `FILEFN_RATE_LIMITED` (429)
- `FILEFN_INVALID_PART_NUMBER` (400)
- `FILEFN_INVALID_ETAG` (400)
- `FILEFN_UPLOAD_INCOMPLETE` (409)
- `FILEFN_UPLOAD_EXPIRED` (410)
- `FILEFN_IDEMPOTENCY_CONFLICT` (409)
- `FILEFN_NO_SUPPORTED_UPLOAD_MODE` (500)
- `FILEFN_SHARE_EXPIRED` (410)
- `FILEFN_PROCESSING_ENQUEUE_FAILED` (503)
- `FILEFN_OFFLINE_UNSUPPORTED` (400)

---

## TV-API-BOOT-001
Description: Typecheck/build succeeds for the new packages.
Input:
```bash
npm run build -- --filter=@superfunctions/storage --filter=@superfunctions/files --filter=@superfunctions/middleware --filter=@superfunctions/db --filter=@filefn/server --filter=@filefn/client --filter=@filefn/processing
```
Expected output:
- Exit code: 0

Negative variant(s):
- If exports are missing, build must fail with a TypeScript error referencing the missing symbol.

## TV-API-BOOT-NEG-001
Description: Build fails when required exports are removed.
Input:
- Remove export of `StorageAdapter` from `@superfunctions/storage` (or remove export of `FileProvider` from `@superfunctions/files`).
- Run the build command from TV-API-BOOT-001.
Expected output:
- Exit code: non-zero
- Error contains the missing symbol name (e.g., `StorageAdapter` or `FileProvider`).

---

## TV-STORAGE-ADAPTERS-001
Description: Adapter packages instantiate and return capability declarations.
Input:
```ts
const s3 = createS3StorageAdapter({ bucket: 'b', region: 'us-east-1' });
const local = createLocalStorageAdapter({ rootDir: '/tmp/filefn' });
```
Expected output:
```json
{
  "s3": { "capabilities": { "multipart": true } },
  "local": { "capabilities": { "multipart": false } }
}
```
Negative variant(s):
- If an adapter reports `multipart: true` but does not implement multipart methods, a conformance test must fail.

## TV-STORAGE-ADAPTERS-NEG-001
Description: Conformance test fails on capability mismatch.
Input:
- Adapter returns `capabilities.multipart = true`.
- Adapter does not implement `createMultipartUpload`.
Expected output:
```json
{ "ok": false, "error": { "code": "ADAPTER_CONFORMANCE_FAILED", "message": "multipart capability requires createMultipartUpload" } }
```

---

## TV-STORAGE-STATELESS-001
Description: Adapter instance is shareable across calls.
Input:
```ts
await Promise.all([
  adapter.statObject({ key: 'k1' }),
  adapter.statObject({ key: 'k2' })
]);
```
Expected output:
- Both promises resolve (no cross-call interference).

## TV-STORAGE-STATELESS-NEG-001
Description: Adapter with request-scoped mutable state fails under concurrency.
Input:
- Adapter mutates a shared field during `statObject`.
- Run TV-STORAGE-STATELESS-001.
Expected output:
- Test fails due to non-deterministic results.

---

## TV-STORAGE-CAP-001
Description: FileFn uses adapter capabilities to select upload mode.
Input:
```json
{ "adapter": { "capabilities": { "signedUploadUrls": true, "multipart": true } } }
```
Expected output:
```json
{ "selectedUploadMode": "multipart-signed-url" }
```

## TV-STORAGE-CAP-NEG-001
Description: FileFn rejects unsupported requested mode.
Input:
```json
{ "adapter": { "capabilities": { "signedUploadUrls": false, "proxyStreamingUpload": false } } }
```
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_NO_SUPPORTED_UPLOAD_MODE", "message": "No supported upload mode for configured adapter" } }
```

---

## TV-STORAGE-STAT-001
Description: `statObject` returns deterministic size for an existing object.
Input:
```ts
await adapter.statObject({ key: 'org_123/user_123/file_0001/ver_0001.bin' });
```
Expected output:
```json
{ "key": "org_123/user_123/file_0001/ver_0001.bin", "size": 2097152 }
```

## TV-STORAGE-STAT-NEG-001
Description: `statObject` for missing key returns a not-found error.
Input:
```ts
await adapter.statObject({ key: 'missing' });
```
Expected output:
```json
{ "ok": false, "error": { "code": "STORAGE_NOT_FOUND", "message": "Object not found" } }
```

---

## TV-UPLOAD-MULTIPART-001
Description: Adapter multipart primitives can create/sign/complete.
Input:
```ts
const { uploadId } = await adapter.createMultipartUpload!({ key: 'k', contentType: 'image/png' });
const { url } = await adapter.signMultipartUploadPartUrl!({ key: 'k', uploadId, partNumber: 1, expiresInSeconds: 900 });
await adapter.completeMultipartUpload!({ key: 'k', uploadId, parts: [{ partNumber: 1, etag: 'etag1' }] });
```
Expected output:
```json
{ "uploadId": "stor_upl_0001", "part1Url": "https://storage.test/upload/stor_upl_0001/part/1", "completed": true }
```

## TV-UPLOAD-MULTIPART-NEG-001
Description: Completing multipart with missing ETags fails.
Input:
```ts
await adapter.completeMultipartUpload!({ key: 'k', uploadId: 'stor_upl_0001', parts: [] });
```
Expected output:
```json
{ "ok": false, "error": { "code": "STORAGE_MULTIPART_INVALID", "message": "No parts provided" } }
```

---

## TV-UPLOAD-INIT-001
Description: Create upload session for `user-avatar` policy.
Input:
```http
POST /upload/init
x-request-id: req_001
authorization: Bearer good
x-idempotency-key: idem_001
content-type: application/json

{"policy":"user-avatar","fileName":"avatar.png","size":2097152,"mimeType":"image/png","metadata":{"userId":"user_123"}}
```
Expected output:
```http
200

{
  "ok": true,
  "data": {
    "uploadSessionId": "upl_0001",
    "uploadMode": "multipart-signed-url",
    "chunkSizeBytes": 8388608,
    "totalParts": 1,
    "expiresAt": "2026-01-25T13:46:33Z"
  },
  "warnings": [],
  "requestId": "req_001"
}
```

## TV-UPLOAD-INIT-NEG-001
Description: Create upload session with disallowed content type.
Input:
```http
POST /upload/init
x-request-id: req_002
authorization: Bearer good
content-type: application/json

{"policy":"user-avatar","fileName":"avatar.gif","size":100,"mimeType":"image/gif"}
```
Expected output:
```http
400

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

## TV-UPLOAD-INIT-NEG-002
Description: Create upload session exceeding policy max size.
Input:
```http
POST /upload/init
x-request-id: req_003
authorization: Bearer good
content-type: application/json

{"policy":"user-avatar","fileName":"big.png","size":10485761,"mimeType":"image/png"}
```
Expected output:
```http
400

{
  "ok": false,
  "error": {
    "code": "FILEFN_POLICY_MAX_SIZE_EXCEEDED",
    "message": "File size exceeds policy max",
    "details": { "policy": "user-avatar", "maxSizeBytes": 10485760, "size": 10485761 }
  },
  "requestId": "req_003"
}
```

## TV-QUOTA-NEG-001
Description: Create upload session rejected by quota provider.
Input:
- QuotaProvider.checkQuota returns `{ allowed: false, current: 100, limit: 100 }`.
```http
POST /upload/init
x-request-id: req_004
authorization: Bearer good
content-type: application/json

{"policy":"user-avatar","fileName":"avatar.png","size":1,"mimeType":"image/png"}
```
Expected output:
```http
402

{
  "ok": false,
  "error": {
    "code": "FILEFN_QUOTA_EXCEEDED",
    "message": "Storage quota exceeded",
    "details": { "current": 100, "limit": 100, "requested": 1 }
  },
  "requestId": "req_004"
}
```

---

## TV-IDEMPOTENCY-001
Description: Upload init is idempotent with the same idempotency key.
Input:
- Execute TV-UPLOAD-INIT-001 twice with the same `x-idempotency-key: idem_001`.
Expected output:
- The second response is `200` and includes the same `uploadSessionId: upl_0001`.

## TV-IDEMPOTENCY-NEG-001
Description: Idempotency conflict when key is reused with different payload.
Input:
```http
POST /upload/init
x-idempotency-key: idem_001
content-type: application/json

{"policy":"user-avatar","fileName":"different.png","size":2,"mimeType":"image/png"}
```
Expected output:
```http
409

{
  "ok": false,
  "error": { "code": "FILEFN_IDEMPOTENCY_CONFLICT", "message": "Idempotency key reuse with different payload" },
  "requestId": "req_001"
}
```

---

## TV-UPLOAD-MODE-001
Description: Signed URL mode is used when adapter supports it.
Input:
- StorageAdapter.capabilities.signedUploadUrls = true
- StorageAdapter.capabilities.multipart = true
Expected output:
- `POST /upload/:id/parts/:n/sign` returns a URL.

## TV-UPLOAD-MODE-NEG-001
Description: No supported upload mode results in error.
Input:
- StorageAdapter.capabilities.signedUploadUrls = false
- StorageAdapter.capabilities.proxyStreamingUpload = false
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_NO_SUPPORTED_UPLOAD_MODE", "message": "No supported upload mode for configured adapter" } }
```

---

## TV-UPLOAD-PART-SIGN-001
Description: Sign part 1.
Input:
```http
POST /upload/upl_0001/parts/1/sign
x-request-id: req_005
authorization: Bearer good
content-type: application/json

{"contentLength":2097152}
```
Expected output:
```http
200

{
  "ok": true,
  "data": {
    "url": "https://storage.test/upload/stor_upl_0001/part/1",
    "headers": { "content-type": "image/png" },
    "expiresAt": "2026-01-24T14:01:33Z"
  },
  "requestId": "req_005"
}
```

## TV-UPLOAD-PART-SIGN-NEG-001
Description: Invalid part number.
Input:
```http
POST /upload/upl_0001/parts/0/sign
x-request-id: req_006
authorization: Bearer good
content-type: application/json

{"contentLength":1}
```
Expected output:
```http
400

{ "ok": false, "error": { "code": "FILEFN_INVALID_PART_NUMBER", "message": "Invalid partNumber" }, "requestId": "req_006" }
```

---

## TV-UPLOAD-PART-COMPLETE-001
Description: Record part completion.
Input:
```http
POST /upload/upl_0001/parts/1/complete
x-request-id: req_007
authorization: Bearer good
content-type: application/json

{"etag":"etag_part_1","size":2097152}
```
Expected output:
```http
200

{ "ok": true, "data": { "recorded": true }, "requestId": "req_007" }
```

## TV-UPLOAD-PART-COMPLETE-NEG-001
Description: Invalid ETag.
Input:
```http
POST /upload/upl_0001/parts/1/complete
x-request-id: req_008
authorization: Bearer good
content-type: application/json

{"etag":"","size":2097152}
```
Expected output:
```http
400

{ "ok": false, "error": { "code": "FILEFN_INVALID_ETAG", "message": "Invalid etag" }, "requestId": "req_008" }
```

---

## TV-UPLOAD-STATUS-001
Description: Resume status returns recorded parts.
Input:
```http
GET /upload/upl_0001/status
x-request-id: req_009
authorization: Bearer good
```
Expected output:
```http
200

{
  "ok": true,
  "data": {
    "uploadSessionId": "upl_0001",
    "status": "in_progress",
    "totalParts": 1,
    "uploadedParts": [1]
  },
  "requestId": "req_009"
}
```

## TV-UPLOAD-COMPLETE-001
Description: Complete upload session after all parts recorded.
Input:
```http
POST /upload/upl_0001/complete
x-request-id: req_010
authorization: Bearer good
```
Expected output:
```http
200

{
  "ok": true,
  "data": { "fileId": "file_0001", "versionId": "ver_0001" },
  "requestId": "req_010"
}
```

## TV-UPLOAD-COMPLETE-NEG-001
Description: Complete upload session with missing parts.
Input:
- Session `upl_0002` has `totalParts = 2` and only part 1 recorded.
```http
POST /upload/upl_0002/complete
x-request-id: req_011
authorization: Bearer good
```
Expected output:
```http
409

{ "ok": false, "error": { "code": "FILEFN_UPLOAD_INCOMPLETE", "message": "Upload incomplete" }, "requestId": "req_011" }
```

---

## TV-UPLOAD-EXPIRE-001
Description: Expired upload session cannot be completed.
Input:
- Session expiresAt is in the past.
```http
POST /upload/upl_expired/complete
x-request-id: req_012
authorization: Bearer good
```
Expected output:
```http
410

{ "ok": false, "error": { "code": "FILEFN_UPLOAD_EXPIRED", "message": "Upload session expired" }, "requestId": "req_012" }
```

## TV-UPLOAD-EXPIRE-NEG-001
Description: Non-expired session completes.
Input:
- Use TV-UPLOAD-COMPLETE-001.
Expected output:
- `200 ok: true`.

---

## TV-FILE-GET-001
Description: Read file metadata.
Input:
```http
GET /file_0001
x-request-id: req_013
authorization: Bearer good
```
Expected output:
```http
200

{
  "ok": true,
  "data": {
    "fileId": "file_0001",
    "currentVersionId": "ver_0001",
    "ownerId": "user_123",
    "tenantId": "org_123",
    "visibility": "private",
    "mimeType": "image/png",
    "size": 2097152
  },
  "requestId": "req_013"
}
```

## TV-FILE-GET-NEG-001
Description: Read metadata forbidden for non-authorized principal.
Input:
```http
GET /file_0001
x-request-id: req_014
authorization: Bearer other-user
```
Expected output:
```http
403

{ "ok": false, "error": { "code": "FILEFN_FORBIDDEN", "message": "Access denied" }, "requestId": "req_014" }
```

---

## TV-FILE-DOWNLOAD-001
Description: Download URL for authorized principal.
Input:
```http
GET /file_0001/download
x-request-id: req_015
authorization: Bearer good
```
Expected output:
```http
200

{ "ok": true, "data": { "url": "https://storage.test/download/org_123/user_123/file_0001/ver_0001.bin" }, "requestId": "req_015" }
```

## TV-FILE-DOWNLOAD-NEG-001
Description: Download forbidden.
Input:
```http
GET /file_0001/download
x-request-id: req_016
authorization: Bearer other-user
```
Expected output:
```http
403

{ "ok": false, "error": { "code": "FILEFN_FORBIDDEN", "message": "Access denied" }, "requestId": "req_016" }
```

---

## TV-FILE-DELETE-001
Description: Delete file.
Input:
```http
DELETE /file_0001
x-request-id: req_017
authorization: Bearer good
```
Expected output:
```http
200

{ "ok": true, "data": { "deleted": true }, "requestId": "req_017" }
```

## TV-FILE-DELETE-NEG-001
Description: Delete forbidden.
Input:
```http
DELETE /file_0001
x-request-id: req_018
authorization: Bearer other-user
```
Expected output:
```http
403

{ "ok": false, "error": { "code": "FILEFN_FORBIDDEN", "message": "Access denied" }, "requestId": "req_018" }
```

---

## TV-VERSION-REPLACE-001
Description: Replace file by uploading a new version.
Input:
- Create upload session targeting existing `fileId`.
```http
POST /upload/init
x-request-id: req_019
authorization: Bearer good
content-type: application/json

{"policy":"user-avatar","fileId":"file_0001","fileName":"avatar.png","size":1,"mimeType":"image/png"}
```
Expected output:
```http
200

{ "ok": true, "data": { "uploadSessionId": "upl_0002" }, "requestId": "req_019" }
```
Negative variant(s):
- If principal lacks write permission, server returns `403 FILEFN_FORBIDDEN`.

## TV-VERSION-REPLACE-NEG-001
Description: Replace forbidden.
Input:
```http
POST /upload/init
x-request-id: req_020
authorization: Bearer other-user
content-type: application/json

{"policy":"user-avatar","fileId":"file_0001","fileName":"avatar.png","size":1,"mimeType":"image/png"}
```
Expected output:
```http
403

{ "ok": false, "error": { "code": "FILEFN_FORBIDDEN", "message": "Access denied" }, "requestId": "req_020" }
```

---

## TV-VERSION-LIST-001
Description: List versions.
Input:
```http
GET /file_0001/versions
x-request-id: req_021
authorization: Bearer good
```
Expected output:
```http
200

{ "ok": true, "data": { "versions": [{"versionId":"ver_0002"},{"versionId":"ver_0001"}] }, "requestId": "req_021" }
```

## TV-VERSION-LIST-NEG-001
Description: List versions forbidden.
Input:
```http
GET /file_0001/versions
x-request-id: req_022
authorization: Bearer other-user
```
Expected output:
```http
403

{ "ok": false, "error": { "code": "FILEFN_FORBIDDEN", "message": "Access denied" }, "requestId": "req_022" }
```

---

## TV-DEDUP-001
Description: Deduplicate identical content within tenant.
Input:
- Dedup enabled.
- Upload the same bytes twice as two versions.
Expected output:
```json
{ "secondUpload": { "deduplicated": true } }
```
Negative variant(s):
- Uploading identical bytes in a different tenant must not deduplicate.

## TV-DEDUP-NEG-001
Description: Cross-tenant dedupe is forbidden.
Input:
- Tenant A uploads bytes X.
- Tenant B uploads bytes X.
Expected output:
```json
{ "tenantB": { "deduplicated": false } }
```

---

## TV-AUTH-001
Description: Auth required route rejects missing auth.
Input:
```http
GET /file_0001
x-request-id: req_023
```
Expected output:
```http
401

{ "ok": false, "error": { "code": "FILEFN_AUTH_REQUIRED", "message": "Authentication required" }, "requestId": "req_023" }
```

## TV-AUTH-NEG-001
Description: Auth present succeeds.
Input:
- Use TV-FILE-GET-001.
Expected output:
- `200 ok: true`.

## TV-AUTH-SESSION-CACHE-001
Description: FileFn consults `auth.provider.getSession()` before calling `auth.provider.authenticate()`.
Input:
- Configure FileFn with an `AuthProvider` where:
  - `getSession(req)` returns a non-null session for the request.
  - `authenticate(req)` throws `"authenticate should not be called"`.
- Execute an auth-required route (e.g., TV-FILE-GET-001) using that request.
Expected output:
- Route succeeds with `200`.
- No call to `authenticate(req)` occurs.

## TV-AUTH-SESSION-CACHE-NEG-001
Description: Ignoring `getSession()` (calling `authenticate()` even when a session is already cached) fails this test.
Input:
- Same setup as TV-AUTH-SESSION-CACHE-001.
- Execute the same route.
Expected output:
- Test fails with the thrown error `"authenticate should not be called"`.

## TV-AUTHZ-COMPOSE-001
Description: `composeAuthorizers` with `first-allow` returns allow if any authorizer allows.
Input:
```ts
const deny: Authorizer = { authorize: async () => ({ allowed: false, reason: 'deny' }) };
const allow: Authorizer = { authorize: async () => ({ allowed: true }) };
const composed = composeAuthorizers([deny, allow], { strategy: 'first-allow' });
const result = await composed.authorize(null, { type: 'file', id: 'file_0001' }, { operation: 'read', scope: 'metadata' });
```
Expected output:
```json
{ "allowed": true }
```

## TV-AUTHZ-COMPOSE-NEG-001
Description: `composeAuthorizers` with `all-must-allow` denies if any authorizer denies.
Input:
```ts
const allow: Authorizer = { authorize: async () => ({ allowed: true }) };
const deny: Authorizer = { authorize: async () => ({ allowed: false, reason: 'policy-deny' }) };
const composed = composeAuthorizers([allow, deny], { strategy: 'all-must-allow' });
const result = await composed.authorize(null, { type: 'file', id: 'file_0001' }, { operation: 'read', scope: 'metadata' });
```
Expected output:
```json
{ "allowed": false, "reason": "policy-deny" }
```

---

## TV-PERM-GRANT-001
Description: Owner grants read to another user.
Input:
```http
POST /file_0001/permissions
x-request-id: req_024
authorization: Bearer good
content-type: application/json

{"userId":"user_999","canRead":true,"canWrite":false,"canDelete":false,"canShare":false}
```
Expected output:
```http
201

{ "ok": true, "data": { "permissionId": "perm_0001" }, "requestId": "req_024" }
```

## TV-PERM-GRANT-NEG-001
Description: Non-owner cannot grant permissions.
Input:
```http
POST /file_0001/permissions
x-request-id: req_025
authorization: Bearer other-user
content-type: application/json

{"userId":"user_999","canRead":true,"canWrite":false,"canDelete":false,"canShare":false}
```
Expected output:
```http
403

{ "ok": false, "error": { "code": "FILEFN_FORBIDDEN", "message": "Access denied" }, "requestId": "req_025" }
```

---

## TV-VISIBILITY-001
Description: Public visibility allows read.
Input:
- File `file_pub_0001` visibility = public.
```http
GET /file_pub_0001
x-request-id: req_026
```
Expected output:
```http
200

{ "ok": true, "data": { "fileId": "file_pub_0001", "visibility": "public" }, "requestId": "req_026" }
```

## TV-VISIBILITY-NEG-001
Description: Private visibility blocks anonymous read.
Input:
- File `file_0001` visibility = private.
```http
GET /file_0001
x-request-id: req_027
```
Expected output:
```http
401

{ "ok": false, "error": { "code": "FILEFN_AUTH_REQUIRED", "message": "Authentication required" }, "requestId": "req_027" }
```

---

## TV-SHARE-CREATE-001
Description: Create share link.
Input:
```http
POST /file_0001/share-links
x-request-id: req_028
authorization: Bearer good
content-type: application/json

{"expiresAt":"2026-01-24T14:46:33Z","requiresAuth":false,"maxDownloads":2}
```
Expected output:
```http
201

{ "ok": true, "data": { "token": "shr_live_0001" }, "requestId": "req_028" }
```

## TV-SHARE-DOWNLOAD-NEG-001
Description: Share link expired.
Input:
- Token `shr_live_0001` is expired.
```http
GET /share-links/shr_live_0001/download
x-request-id: req_029
```
Expected output:
```http
410

{ "ok": false, "error": { "code": "FILEFN_SHARE_EXPIRED", "message": "Share link expired" }, "requestId": "req_029" }
```

---

## TV-POLICY-LIST-001
Description: List policies.
Input:
```http
GET /policies
x-request-id: req_030
authorization: Bearer good
```
Expected output:
```http
200

{ "ok": true, "data": { "policies": [{"name":"user-avatar","maxSizeBytes":10485760,"contentTypes":["image/png","image/jpeg"]}] }, "requestId": "req_030" }
```

---

## TV-RATE-001
Description: `@superfunctions/middleware` rate limiter allows under the limit.
Input:
- Create a rate limiter using `createRateLimiter({ persistence })` where `persistence` is backed by an in-memory `KVStoreAdapter`.
- Call `limiter.check({ key: 'filefn:uploadInit:user_123', windowSeconds: 60, limit: 2 })` once.
Expected output:
```json
{ "allowed": true, "remaining": 1, "resetAt": "2026-01-24T13:47:33Z" }
```

## TV-RATE-NEG-001
Description: FileFn blocks over-the-limit requests with `429 FILEFN_RATE_LIMITED`.

Input (upload init example):
```http
POST /upload/init
x-request-id: req_031
authorization: Bearer good
content-type: application/json

{"policy":"user-avatar","fileName":"avatar.png","size":1,"mimeType":"image/png"}
```
Expected output:
```http
429

{ "ok": false, "error": { "code": "FILEFN_RATE_LIMITED", "message": "Rate limit exceeded", "details": { "resetAt": "2026-01-24T13:47:33Z" } }, "requestId": "req_031" }
```

Variant (download example):
```http
GET /file_0001/download
x-request-id: req_032
authorization: Bearer good
```
Expected output:
```http
429

{ "ok": false, "error": { "code": "FILEFN_RATE_LIMITED", "message": "Rate limit exceeded" }, "requestId": "req_032" }
```

---

## TV-OBS-001
Description: Upload completion emits `file:uploaded` with requestId.
Input:
- Execute TV-UPLOAD-COMPLETE-001.
Expected output:
```json
{ "event": { "name": "file:uploaded", "payload": { "fileId": "file_0001", "versionId": "ver_0001", "requestId": "req_010" } } }
```

## TV-OBS-NEG-001
Description: Event payload MUST NOT contain signed URLs.
Input:
- Execute TV-UPLOAD-PART-SIGN-001 and complete upload.
Expected output:
- Emitted events do not include fields named `url` containing signed URLs.

---

## TV-OBS-LOG-001
Description: Logs contain correlation IDs and do not leak secrets.
Input:
- Execute TV-UPLOAD-INIT-001 and TV-UPLOAD-PART-SIGN-001.
Expected output:
```json
{ "log": { "ctx": { "requestId": "req_001", "uploadSessionId": "upl_0001" } } }
```

## TV-OBS-LOG-NEG-001
Description: Signed URL is not logged.
Input:
- Execute TV-UPLOAD-PART-SIGN-001.
Expected output:
- No log event contains the full signed URL string `https://storage.test/upload/stor_upl_0001/part/1`.

---

## TV-PROCESS-001
Description: Processing is triggered after upload.
Input:
- Processing enabled.
- Execute TV-UPLOAD-COMPLETE-001.
Expected output:
```json
{ "processing": { "started": true, "fileId": "file_0001", "versionId": "ver_0001" } }
```

## TV-PROCESS-NEG-001
Description: Processing disabled results in no processing jobs.
Input:
- Processing disabled.
- Execute TV-UPLOAD-COMPLETE-001.
Expected output:
```json
{ "processing": { "started": false } }
```

## TV-PROCESS-FLOW-001
Description: When FlowFn provided, processing is enqueued.
Input:
- FlowFn queue is available.
- Execute TV-UPLOAD-COMPLETE-001.
Expected output:
```json
{ "flow": { "queue": "filefn.processing", "enqueued": true, "job": { "fileId": "file_0001", "versionId": "ver_0001" } } }
```

## TV-PROCESS-FLOW-NEG-001
Description: Flow enqueue failure is retried or reported.
Input:
- FlowFn queue add throws.
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_PROCESSING_ENQUEUE_FAILED", "message": "Failed to enqueue processing" } }
```

---

## TV-CLIENT-UPLOAD-001
Description: Client SDK runs the canonical upload flow.
Input:
```ts
const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
const handle = await client.uploadFile({ policy: 'user-avatar', file: new File([new Uint8Array([1])], 'avatar.png', { type: 'image/png' }) });
const result = await handle.done();
```
Expected output:
```json
{ "fileId": "file_0001", "versionId": "ver_0001" }
```

## TV-CLIENT-UPLOAD-NEG-001
Description: Client surfaces server policy error.
Input:
- Client uploads a file with mimeType `image/gif` under policy `user-avatar`.
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED" } }
```

## TV-CLIENT-OFFLINE-001
Description: Client stages upload in OPFS and later syncs.
Input:
- offline.enabled = true
- network offline during upload start
Expected output:
```json
{ "offline": { "staged": true, "syncedLater": true } }
```

## TV-CLIENT-OFFLINE-NEG-001
Description: Offline enabled but OPFS unavailable.
Input:
- offline.enabled = true
- OPFS not supported
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_OFFLINE_UNSUPPORTED", "message": "OPFS unavailable" } }
```

## TV-CLIENT-HOOKS-001
Description: Client progress callbacks fire.
Input:
- Upload a multi-part file.
Expected output:
```json
{ "progressEvents": [{"bytesUploaded":1,"bytesTotal":2}] }
```

## TV-CLIENT-HOOKS-NEG-001
Description: Progress callbacks stop after abort.
Input:
- Start upload, call `abort()`.
Expected output:
```json
{ "aborted": true, "noFurtherProgressEvents": true }
```

---

## TV-UI-001
Description: UI dropzone passes selected files to callback.
Input:
- Render `FileDropzone` with `onFiles(files)`.
- User drops a file `avatar.png`.
Expected output:
```json
{ "onFilesCalled": true, "files": [{"name":"avatar.png"}] }
```

## TV-UI-NEG-001
Description: UI shows policy error state.
Input:
- Upload fails with `FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED`.
Expected output:
```json
{ "ui": { "errorCode": "FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED", "shown": true } }
```

## TV-UI-PLANS-001
Description: UI pricing/plans component allows selecting a plan.
Input:
- Render `PricingPlans` with plans: `["free","pro"]` and `onSelect(planId)`.
- User selects `"pro"`.
Expected output:
```json
{ "onSelectCalled": true, "selected": "pro" }
```

## TV-UI-PLANS-NEG-001
Description: UI pricing/plans component handles invalid plan selection.
Input:
- Render `PricingPlans` with plans: `["free"]`.
- Attempt to select `"pro"`.
Expected output:
```json
{ "onSelectCalled": false, "ui": { "error": "invalid_plan" } }
```

---

## TV-FILEPROVIDER-001
Description: FileProvider method succeeds for authorized principal.
Input:
```ts
await fileFn.createUploadSession({ policy: 'user-avatar', fileName: 'a.png', size: 1, mimeType: 'image/png' }, { principalId: 'user_123', tenantId: 'org_123', requestId: 'req_001' });
```
Expected output:
```json
{ "uploadSessionId": "upl_0001" }
```

## TV-FILEPROVIDER-NEG-001
Description: FileProvider method fails for unauthorized principal.
Input:
- Principal is `user_999` without access.
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_FORBIDDEN" } }
```

---

## TV-DB-SCHEMA-001
Description: Schema includes required models.
Input:
```ts
const schema = getSchema({ namespace: 'filefn' });
```
Expected output:
- `schema.schemas[].modelName` contains the required model names (fields/indexes omitted below).
```json
{
  "version": 1,
  "schemas": [
    { "modelName": "files" },
    { "modelName": "fileVersions" },
    { "modelName": "uploadSessions" },
    { "modelName": "uploadParts" },
    { "modelName": "filePermissions" },
    { "modelName": "fileShares" },
    { "modelName": "fileArtifacts" }
  ]
}
```

## TV-DB-SCHEMA-NEG-001
Description: Missing required model fails a schema assertion test.
Input:
- Remove `uploadSessions` schema.
Expected output:
```json
{ "ok": false, "error": { "code": "SCHEMA_INCOMPLETE", "message": "uploadSessions missing" } }
```

## TV-DB-NAMESPACE-001
Description: Namespace prefixes are applied.
Input:
- Configure namespace `acme`.
Expected output:
```json
{ "tablePrefix": "acme_" }
```

## TV-DB-NAMESPACE-NEG-001
Description: Missing namespace usage causes test failure.
Input:
- Implementation writes without namespace.
Expected output:
```json
{ "ok": false, "error": { "code": "NAMESPACE_VIOLATION" } }
```

---

## TV-ERROR-001
Description: Error response includes stable error.code.
Input:
- Trigger TV-UPLOAD-INIT-NEG-001.
Expected output:
- JSON contains `error.code = FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED`.

## TV-ERROR-NEG-001
Description: Error response missing code fails tests.
Input:
- Force an error response without `error.code`.
Expected output:
```json
{ "ok": false, "error": { "code": "(missing)" } }
```

