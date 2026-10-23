# FileFn Client-Server API Mismatch Issues

**Date:** 2026-01-26  
**Status:** Investigation Complete  
**Severity:** High - Blocks file upload functionality

## Summary

The FileFn client and server have multiple API mismatches that prevent successful file uploads:

1. **Request payload field name mismatch**: Client sends `fileSize`/`contentType`, server expects `size`/`mimeType`
2. **Response structure mismatch**: Server wraps responses in `{ ok: true, data: {...} }`, client expects direct data
3. **Result**: Upload session creation fails or returns undefined `uploadSessionId`, leading to `FILEFN_SESSION_NOT_FOUND` errors

## Observed Errors

### Error 1: Content Type Not Allowed
```
{
  code: "FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED",
  message: "Content type not allowed",
  details: { policy: "public-image" }
}
```

### Error 2: Session Not Found
```
{
  code: "FILEFN_SESSION_NOT_FOUND",
  message: "Upload session not found"
}
URL: http://localhost:3000/filefn/upload/undefined/complete
```

## Root Causes

### Issue 1: Request Payload Field Name Mismatch

**Location:** `client/src/upload-manager.ts:62-70`

**Current Client Code:**
```typescript
const contentType = input.file.type || "application/octet-stream";
const fileSize = input.file.size;

const initResponse = await this.httpClient.initUpload({
  policy: input.policy,
  fileName,
  fileSize,        // ❌ Wrong field name
  contentType,     // ❌ Wrong field name
  // ...
});
```

**Server Expectation:** `server/src/upload-sessions/routes.ts:66-73`
```typescript
const body = await parseJsonBody<{
  policy: string;
  fileName: string;
  size: number;        // ✅ Server expects 'size'
  mimeType: string;    // ✅ Server expects 'mimeType'
  fileId?: string;
  metadata?: Record<string, unknown>;
}>(request);
```

**Impact:** 
- Server receives `fileSize` and `contentType` but expects `size` and `mimeType`
- This causes validation failures or the server may ignore these fields
- Results in `FILEFN_POLICY_CONTENT_TYPE_NOT_ALLOWED` error

### Issue 2: Response Structure Mismatch

**Location:** `client/src/client.ts:94-120`

**Current Client Code:**
```typescript
async function request<T>(...): Promise<T> {
  return withRetry(async () => {
    // ...
    const json = await response.json();
    // ...
    return json as T;  // ❌ Returns entire response object
  }, options, signal);
}
```

**Server Response Format:** `server/src/upload-sessions/routes.ts:21-25`
```typescript
function successResponse(data: unknown, requestId?: string, warnings: string[] = []): Response {
  return Response.json(
    { ok: true, data, warnings, requestId },  // ✅ Wrapped in { ok, data, ... }
    { status: 200 }
  );
}
```

**Actual Server Response:**
```json
{
  "ok": true,
  "data": {
    "uploadSessionId": "upl_...",
    "uploadMode": "...",
    "chunkSizeBytes": 5242880,
    "totalParts": 1,
    "expiresAt": "2026-01-26T..."
  },
  "warnings": [],
  "requestId": "req_..."
}
```

**Client Expectation:**
```typescript
interface InitUploadResponse {
  uploadSessionId: string;  // ❌ Expects direct access
  uploadMode: string;
  chunkSizeBytes: number;
  totalParts: number;
  expiresAt: string;
}
```

**Impact:**
- Client tries to access `initResponse.uploadSessionId` but gets `undefined`
- Because the actual structure is `initResponse.data.uploadSessionId`
- Results in `uploadSessionId` being `undefined` when calling `completeUpload`
- Leads to URL: `/upload/undefined/complete` and `FILEFN_SESSION_NOT_FOUND` error

## Evidence

### Client Request Payload (Current)
```json
{
  "policy": "public-image",
  "fileName": "21n-banner.png",
  "fileSize": 1059300,        // ❌ Wrong field name
  "contentType": "image/png",  // ❌ Wrong field name
  "metadata": {}
}
```

### Server Expected Payload
```json
{
  "policy": "public-image",
  "fileName": "21n-banner.png",
  "size": 1059300,            // ✅ Correct field name
  "mimeType": "image/png",     // ✅ Correct field name
  "metadata": {}
}
```

### Server Response (Actual)
```json
{
  "ok": true,
  "data": {
    "uploadSessionId": "upl_abc123",
    "uploadMode": "multipart",
    "chunkSizeBytes": 5242880,
    "totalParts": 1,
    "expiresAt": "2026-01-26T12:00:00Z"
  }
}
```

### Client Response Handling (Current)
```typescript
// Client receives: { ok: true, data: { uploadSessionId: "upl_..." } }
// Client tries: initResponse.uploadSessionId
// Result: undefined (should be initResponse.data.uploadSessionId)
```

## Proposed Fixes

### Fix 1: Update Request Payload Field Names

**File:** `client/src/upload-manager.ts`

**Change:**
```typescript
// Before
const contentType = input.file.type || "application/octet-stream";
const fileSize = input.file.size;

const initResponse = await this.httpClient.initUpload({
  fileSize,
  contentType,
  // ...
});

// After
const mimeType = input.file.type || "application/octet-stream";
const size = input.file.size;

const initResponse = await this.httpClient.initUpload({
  size,
  mimeType,
  // ...
});
```

**Also update:** `client/src/client.ts` - HttpClient interface
```typescript
// Before
initUpload(params: {
  fileSize: number;
  contentType: string;
  // ...
})

// After
initUpload(params: {
  size: number;
  mimeType: string;
  // ...
})
```

### Fix 2: Unwrap Server Response Data

**File:** `client/src/client.ts`

**Change:**
```typescript
async function request<T>(...): Promise<T> {
  return withRetry(async () => {
    // ... fetch logic ...
    
    const json = await response.json();

    if (!response.ok || (json && typeof json === 'object' && 'ok' in json && !json.ok)) {
      // Handle errors...
    }

    // Unwrap the data field from server response: { ok: true, data: {...} }
    if (json && typeof json === 'object' && 'data' in json) {
      return json.data as T;  // ✅ Extract data field
    }

    return json as T;
  }, options, signal);
}
```

## Testing Checklist

After fixes are applied:

- [ ] Upload a PNG image file
- [ ] Upload a JPEG image file  
- [ ] Upload a GIF image file
- [ ] Upload a WebP image file
- [ ] Verify `uploadSessionId` is correctly set after `initUpload`
- [ ] Verify upload completes successfully
- [ ] Verify file appears in file list
- [ ] Check browser network tab for correct request payload
- [ ] Check browser network tab for correct response parsing

## Related Files

- `client/src/upload-manager.ts` - Upload logic
- `client/src/client.ts` - HTTP client and response handling
- `client/src/types.ts` - Type definitions
- `server/src/upload-sessions/routes.ts` - Server route handlers
- `server/src/upload-sessions/service.ts` - Server business logic
- `examples/full-demo/client/src/routes/+page.svelte` - Example usage

## Notes

- The server uses a consistent response envelope format: `{ ok: boolean, data?: T, error?: E, requestId?: string }`
- All successful responses wrap data in the `data` field
- All error responses use the `error` field
- The client should handle this envelope format consistently across all API calls
