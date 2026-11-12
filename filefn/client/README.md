# @filefn/client

Browser client for FileFn uploads, file reads and offline (OPFS) staging.

```sh
npm install @filefn/client
```

```ts
import { createFileFnClient } from '@filefn/client';

const files = createFileFnClient({ baseUrl: 'https://api.example.com/files' });

const upload = files.uploadFile({ policy: 'avatars', file });
upload.onProgress((p) => console.log(p.bytesUploaded, '/', p.bytesTotal));
const { fileId, versionId } = await upload.done();
```

## Transport options

`createFileFnClient` takes the same transport options as `@datafn/client`:

| Option | Default | Purpose |
| --- | --- | --- |
| `fetch` | global `fetch` | Fetch implementation used for every request: upload init, part sign, part upload, part and upload complete, status, file and artifact reads, delete, and offline sync replay. |
| `credentials` | `'same-origin'` | `RequestCredentials` mode for requests sent to FileFn. |
| `getAuthHeaders` | none | Headers added to every request sent to FileFn. Called for each request and each retry attempt. |

When `fetch` and `getAuthHeaders` are both given, the headers from `getAuthHeaders` are merged onto every request passed to that fetch. Request-specific headers (the JSON `Content-Type`, signed part headers, `x-upload-session-token`) are applied after them and replace an auth header with the same name in any letter case. Leaving out every option keeps the previous behavior: the global `fetch` with `same-origin` credentials.

The injected `fetch` is called without a `this` binding, so `window.fetch` can be passed directly. If no `fetch` is given, the global `fetch` is looked up when each request is sent.

### Session cookies with a CSRF header

```ts
const files = createFileFnClient({
  baseUrl: 'https://api.example.com/files',
  credentials: 'include', // send the session cookie to a cross-origin API
  getAuthHeaders: () => ({ 'x-csrf-token': readCsrfToken() }),
});
```

A cross-origin API must answer CORS requests with `Access-Control-Allow-Credentials: true` and allow the CSRF header.

### Bearer token

```ts
const files = createFileFnClient({
  baseUrl: 'https://api.example.com/files',
  getAuthHeaders: async () => ({ Authorization: `Bearer ${await session.getAccessToken()}` }),
});
```

### Custom fetch

```ts
const files = createFileFnClient({
  baseUrl: '/api/files',
  fetch: (input, init) => appFetch(input, init), // e.g. tracing, a test double, or a platform fetch
});
```

### Part uploads

A part URL returned by the sign endpoint is sent through the same `fetch`:

- A proxy upload URL under `baseUrl` (a relative path, or an absolute URL with the same origin and path prefix) is a FileFn request. It gets the `getAuthHeaders` headers and the configured `credentials`. A `baseUrl` of `'/'` or `''` means the page origin root, so every same-origin path is under it.
- Any other URL (for example an R2 bucket presigned URL, or a protocol-relative `//host/...` URL) gets only its signed headers and the upload session token, with `credentials: 'omit'`. Your auth headers and cookies are never sent to storage.

### Offline replay

With `offline: { enabled: true }`, uploads staged while offline are replayed by the client that runs the sync, using that client's `fetch`, `credentials` and current `getAuthHeaders` result. Auth headers are never written to OPFS, so an upload staged before a page reload is sent with the fresh token of the client created after it.
