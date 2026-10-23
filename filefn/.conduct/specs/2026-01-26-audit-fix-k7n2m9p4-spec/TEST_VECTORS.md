# Test Vectors (FileFn audit-fix: k7n2m9p4)

These vectors are **golden, deterministic cases** used to verify the audit-fix requirements in `REQUIREMENTS.md`.

## Global test harness assumptions
1. Tests use deterministic IDs:
   - uploadSessionId: `upl_0001`, `upl_0002`
   - fileId: `file_0001`
   - versionId: `ver_0001`, `ver_0002`
   - requestId: `req_001`, `req_010`, etc.
2. Unless stated otherwise, requests include `x-request-id`.
3. Canonical principal used in positive vectors:
   - principalId: `user_123`
   - tenantId: `org_123`
4. A sample policy exists:
```json
{
  "name": "user-avatar",
  "contentTypes": ["image/png", "image/jpeg"],
  "maxSizeBytes": 10485760,
  "visibility": "private"
}
```

## Canonical envelopes
### Success
```json
{ "ok": true, "data": {}, "warnings": [], "requestId": "req_..." }
```

### Error
```json
{ "ok": false, "error": { "code": "FILEFN_...", "message": "...", "details": {} }, "requestId": "req_..." }
```

## Canonical error codes (minimum set for this bundle)
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
- `FILEFN_PART_CONFLICT` (409) *(new in this audit-fix)*
- `FILEFN_UPLOAD_SIZE_MISMATCH` (409) *(new in this audit-fix)*
- `FILEFN_NO_SUPPORTED_UPLOAD_MODE` (500)
- `FILEFN_PROCESSING_ENQUEUE_FAILED` (503)
- `FILEFN_OFFLINE_UNSUPPORTED` (400)

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

Negative variant(s):
- See TV-UPLOAD-INIT-NEG-001 and TV-UPLOAD-INIT-NEG-002.

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

## TV-UPLOAD-PART-COMPLETE-IDEMP-001
Description: Part completion is idempotent for the tuple `(uploadSessionId, partNumber, etag)`.
Input:
- Execute TV-UPLOAD-PART-COMPLETE-001 twice with the same body `{ "etag": "etag_part_1", "size": 2097152 }`.
Expected output:
- Both calls return `200 ok: true` and `{ "recorded": true }`.

## TV-UPLOAD-PART-COMPLETE-IDEMP-NEG-001
Description: Completing the same part number with a different ETag fails deterministically.
Input:
```http
POST /upload/upl_0001/parts/1/complete
x-request-id: req_008b
authorization: Bearer good
content-type: application/json

{"etag":"etag_part_1_DIFFERENT","size":2097152}
```
Expected output:
```http
409

{
  "ok": false,
  "error": {
    "code": "FILEFN_PART_CONFLICT",
    "message": "Part already completed with a different etag",
    "details": { "uploadSessionId": "upl_0001", "partNumber": 1 }
  },
  "requestId": "req_008b"
}
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

---

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

## TV-UPLOAD-COMPLETE-IDEMP-001
Description: Upload completion is idempotent and returns a stable `(fileId, versionId)` on repeat calls.
Input:
- Execute TV-UPLOAD-COMPLETE-001 twice.
Expected output:
- The second call returns `200` with the same `{ "fileId": "file_0001", "versionId": "ver_0001" }`.

## TV-UPLOAD-COMPLETE-IDEMP-NEG-001
Description: Reusing the same `x-idempotency-key` for a different completion payload is a conflict.
Input:
1) Complete `upl_0001` with `x-idempotency-key: idem_complete_001`.
2) Attempt to complete a different session with the same idempotency key:
```http
POST /upload/upl_0002/complete
x-request-id: req_010b
authorization: Bearer good
x-idempotency-key: idem_complete_001
```
Expected output:
```http
409

{ "ok": false, "error": { "code": "FILEFN_IDEMPOTENCY_CONFLICT", "message": "Idempotency key reuse with different payload" }, "requestId": "req_010b" }
```

## TV-UPLOAD-COMPLETE-VALIDATE-SIZE-NEG-001
Description: Completion rejects when recorded size does not match actual stored bytes.
Input:
- Session expects `size=10` but storage reports `statObject.size=9` for the final object.
```http
POST /upload/upl_0001/complete
x-request-id: req_010c
authorization: Bearer good
```
Expected output:
```http
409

{
  "ok": false,
  "error": {
    "code": "FILEFN_UPLOAD_SIZE_MISMATCH",
    "message": "Uploaded size does not match expected size",
    "details": { "expected": 10, "actual": 9 }
  },
  "requestId": "req_010c"
}
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

## TV-UPLOAD-GC-001
Description: Cleanup routine deletes expired sessions and aborts multipart uploads when supported.
Input:
- There exist expired sessions in DB: `upl_expired_1`, `upl_expired_2`.
- Run the server cleanup entrypoint (implementation-defined), e.g. `fileFn.cleanupExpiredSessions()`.
Expected output:
```json
{ "deletedSessions": 2, "abortedMultipart": 2 }
```

## TV-UPLOAD-GC-NEG-001
Description: Cleanup routine MUST NOT delete non-expired sessions.
Input:
- There exists a session `upl_0001` with expiresAt in the future.
- Run cleanup entrypoint.
Expected output:
```json
{ "deletedSessions": 0, "stillPresent": ["upl_0001"] }
```

---

## TV-UPLOAD-MODE-NEG-001
Description: No supported upload mode results in error.
Input:
- StorageAdapter.capabilities.signedUploadUrls = false
- StorageAdapter.capabilities.proxyStreamingUpload = false
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_NO_SUPPORTED_UPLOAD_MODE", "message": "No supported upload mode for configured adapter" } }
```

## TV-UPLOAD-PROXY-001
Description: Proxy upload mode uploads bytes to FileFn server and completes successfully.
Input:
1) Init upload (adapter has `signedUploadUrls=false` and `proxyStreamingUpload=true`):
```http
POST /upload/init
x-request-id: req_040
authorization: Bearer good
content-type: application/json

{"policy":"user-avatar","fileName":"avatar.png","size":3,"mimeType":"image/png"}
```
Expected output (init):
```json
{ "ok": true, "data": { "uploadSessionId": "upl_0001", "uploadMode": "proxy", "totalParts": 1 }, "requestId": "req_040" }
```

2) Sign part (returns proxy URL):
```http
POST /upload/upl_0001/parts/1/sign
x-request-id: req_041
authorization: Bearer good
content-type: application/json

{"contentLength":3}
```
Expected output (sign):
```json
{ "ok": true, "data": { "url": "https://api.test/files/upload/upl_0001/parts/1", "headers": { "content-type": "image/png" } }, "requestId": "req_041" }
```

3) Upload bytes to proxy URL:
```http
PUT /upload/upl_0001/parts/1
x-request-id: req_042
authorization: Bearer good
content-type: image/png
content-length: 3

<bytes: 0x01 0x02 0x03>
```
Expected output (upload bytes):
```json
{ "ok": true, "data": { "etag": "sha256:...", "size": 3, "recorded": true }, "requestId": "req_042" }
```

4) Complete upload session:
```http
POST /upload/upl_0001/complete
x-request-id: req_043
authorization: Bearer good
```
Expected output:
```json
{ "ok": true, "data": { "fileId": "file_0001", "versionId": "ver_0001" }, "requestId": "req_043" }
```

Negative variant(s):
- If proxy is unsupported, init must fail per TV-UPLOAD-MODE-NEG-001.

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

## TV-FILE-LIST-001
Description: List returns only accessible files (owned + granted + shared + public).
Input:
- Dataset:
  - `file_owned_private` owned by `user_123`, visibility `private`
  - `file_other_public` owned by `user_999`, visibility `public`
  - `file_other_shared` owned by `user_999`, visibility `shared`, tenantId `org_123`
  - `file_other_private_granted` owned by `user_999`, visibility `private`, with a permission grant `canRead=true` for `user_123`
```http
GET /
x-request-id: req_050
authorization: Bearer good
```
Expected output:
```http
200

{
  "ok": true,
  "data": {
    "files": [
      { "fileId": "file_owned_private" },
      { "fileId": "file_other_public" },
      { "fileId": "file_other_shared" },
      { "fileId": "file_other_private_granted" }
    ]
  },
  "requestId": "req_050"
}
```

## TV-FILE-LIST-NEG-001
Description: List does not leak inaccessible private files.
Input:
- Dataset includes `file_user_123_private` owned by `user_123`, visibility `private`.
```http
GET /
x-request-id: req_051
authorization: Bearer other-user
```
Expected output:
```http
200

{
  "ok": true,
  "data": {
    "files": [
      { "fileId": "file_other_user_visible_to_other-user" }
    ]
  },
  "requestId": "req_051"
}
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

## TV-FILE-DOWNLOAD-PROXY-001
Description: When signed download URLs are unsupported, server returns a proxy URL that streams bytes.
Input:
1) Control-plane: get download URL:
```http
GET /file_0001/download
x-request-id: req_060
authorization: Bearer good
```
Expected output:
```http
200

{ "ok": true, "data": { "url": "https://api.test/files/proxy/files/file_0001/download" }, "requestId": "req_060" }
```

2) Data-plane: fetch proxy URL:
```http
GET /proxy/files/file_0001/download
x-request-id: req_061
authorization: Bearer good
```
Expected output:
```http
200
content-type: image/png
content-length: 3

<bytes: 0x01 0x02 0x03>
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

## TV-VERSION-REPLACE-001
Description: Replace file by uploading a new version.
Input:
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

## TV-VERSION-GET-001
Description: Get version metadata.
Input:
```http
GET /file_0001/versions/ver_0001
x-request-id: req_070
authorization: Bearer good
```
Expected output:
```http
200

{
  "ok": true,
  "data": {
    "versionId": "ver_0001",
    "fileId": "file_0001",
    "size": 2097152,
    "mimeType": "image/png",
    "createdAt": "2026-01-24T13:46:33Z"
  },
  "requestId": "req_070"
}
```

Negative variant(s):
- If `ver_0001` does not belong to `file_0001`, server returns `404 FILEFN_NOT_FOUND`.

## TV-VERSION-DOWNLOAD-BINDING-NEG-001
Description: Version download rejects when versionId does not belong to fileId.
Input:
```http
GET /file_0001/versions/ver_other_file/download
x-request-id: req_071
authorization: Bearer good
```
Expected output:
```http
404

{ "ok": false, "error": { "code": "FILEFN_NOT_FOUND", "message": "Version not found" }, "requestId": "req_071" }
```

---

## TV-DEDUP-001
Description: Deduplicate identical content within tenant when enabled.
Input:
- Deduplication enabled (`scope='tenant'`, `algorithm='sha256'`).
- Upload the same bytes twice as two versions under the same tenant.
Expected output:
```json
{ "secondUpload": { "deduplicated": true } }
```

Negative variant(s):
- See TV-DEDUP-NEG-001.

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

## TV-QUOTA-GET-001
Description: Get storage quota usage when `quota.getUsage` exists.
Input:
- QuotaProvider.getUsage returns `{ current: 5, limit: 10 }` for principal.
```http
GET /quota/storage
x-request-id: req_080
authorization: Bearer good
```
Expected output:
```http
200

{ "ok": true, "data": { "current": 5, "limit": 10 }, "requestId": "req_080" }
```

Negative variant(s):
- If `quota.getUsage` is not configured, server may return `404 FILEFN_NOT_FOUND`.

---

## TV-RATE-001
Description: `@superfunctions/middleware` rate limiter allows under the limit.
Input:
- Create a rate limiter using `createRateLimiter({ persistence })` backed by an in-memory KV.
- Call `limiter.check({ key: 'filefn:uploadInit:user_123', windowSeconds: 60, limit: 2 })` once.
Expected output:
```json
{ "allowed": true, "remaining": 1, "resetAt": "2026-01-24T13:47:33Z" }
```

## TV-RATE-NEG-001
Description: FileFn blocks over-the-limit requests with `429 FILEFN_RATE_LIMITED` and ISO8601 resetAt.
Input:
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

---

## TV-KVSTORE-001
Description: KVStoreAdapter supports canonical `set({ ttlSeconds })` and optional `incr`.
Input:
```ts
await kv.set({ key: 'k', value: 'v', ttlSeconds: 60 });
const v = await kv.get('k');
const n = await kv.incr?.({ key: 'ctr', by: 1, ttlSeconds: 60 });
```
Expected output:
```json
{ "get": "v", "incr": { "value": 1 } }
```

## TV-KVSTORE-NEG-001
Description: KVStoreAdapter using `ttlMs` or non-object `set` signature fails typecheck.
Input:
- Attempt to compile code calling `kv.set('k','v',1000)`.
Expected output:
- TypeScript compile failure referencing the invalid signature.

---

## TV-AUTHZ-COMPOSE-001
Description: `composeAuthorizers` with `first-allow` returns allow if any authorizer allows.
Input:
```ts
const deny = { authorize: async () => ({ allowed: false, reason: 'deny' }) };
const allow = { authorize: async () => ({ allowed: true }) };
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
const allow = { authorize: async () => ({ allowed: true }) };
const deny = { authorize: async () => ({ allowed: false, reason: 'policy-deny' }) };
const composed = composeAuthorizers([allow, deny], { strategy: 'all-must-allow' });
const result = await composed.authorize(null, { type: 'file', id: 'file_0001' }, { operation: 'read', scope: 'metadata' });
```
Expected output:
```json
{ "allowed": false, "reason": "policy-deny" }
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
- Emitted events do not include fields containing full signed URLs.

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

## TV-OBS-REDACTION-001
Description: Correlation IDs are preserved (not redacted).
Input:
- Execute TV-UPLOAD-INIT-001 with `x-request-id: req_001` and inspect logs.
Expected output:
```json
{ "log": { "ctx": { "requestId": "req_001" }, "redacted": false } }
```

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
const handle = await client.uploadFile({
  policy: 'user-avatar',
  file: new File([new Uint8Array([1])], 'avatar.png', { type: 'image/png' })
});
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

## TV-CLIENT-ENVELOPE-UNWRAP-001
Description: Client unwraps server success envelopes and returns `data` from public methods.
Input:
```ts
const client = createFileFnClient({ baseUrl: 'https://api.test/files' });
// Mock server response for GET /file_0001:
// { ok: true, data: { fileId: 'file_0001' }, requestId: 'req_013' }
const file = await client.getFile('file_0001');
```
Expected output:
```json
{ "fileId": "file_0001" }
```

## TV-CLIENT-OFFLINE-001
Description: Client stages upload in OPFS and later syncs.
Input:
- `offline.enabled = true`
- network offline during upload start
Expected output:
```json
{ "offline": { "staged": true, "syncedLater": true } }
```

## TV-CLIENT-OFFLINE-NEG-001
Description: Offline enabled but OPFS unavailable.
Input:
- `offline.enabled = true`
- OPFS not supported
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_OFFLINE_UNSUPPORTED", "message": "OPFS unavailable" } }
```

---

## TV-FILEPROVIDER-001
Description: FileProvider method succeeds for authorized principal.
Input:
```ts
await fileFn.createUploadSession(
  { policy: 'user-avatar', fileName: 'a.png', size: 1, mimeType: 'image/png' },
  { principalId: 'user_123', tenantId: 'org_123', requestId: 'req_001' }
);
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

## TV-STORAGE-STATELESS-NEG-001
Description: Adapter with request-scoped mutable state fails under concurrency.
Input:
- Adapter mutates a shared field during a method.
- Run concurrent calls.
Expected output:
- Test fails due to non-deterministic results.

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
Description: Capability mismatch causes a conformance failure.
Input:
```json
{ "adapter": { "capabilities": { "signedUploadUrls": false, "proxyStreamingUpload": false } } }
```
Expected output:
```json
{ "ok": false, "error": { "code": "FILEFN_NO_SUPPORTED_UPLOAD_MODE", "message": "No supported upload mode for configured adapter" } }
```

## TV-STORAGE-AZURE-STATELESS-001
Description: Azure adapter multipart flow does not require per-instance mutable state.
Input:
```ts
const adapterA = createAzureStorageAdapter({ /* config */ });
const adapterB = createAzureStorageAdapter({ /* same config */ });

// Create upload with adapterA
const { uploadId } = await adapterA.createMultipartUpload!({ key: 'k', contentType: 'image/png' });

// Sign part with adapterB (different instance)
const { url } = await adapterB.signMultipartUploadPartUrl!({ key: 'k', uploadId, partNumber: 1, expiresInSeconds: 900 });

// Complete with adapterB
await adapterB.completeMultipartUpload!({ key: 'k', uploadId, parts: [{ partNumber: 1, etag: 'etag1' }] });
```
Expected output:
```json
{ "signedWithDifferentInstance": true, "completed": true }
```
