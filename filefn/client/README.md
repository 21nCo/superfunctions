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

When `fetch` and `getAuthHeaders` are both given, the headers from `getAuthHeaders` are merged onto every request that fetch sends to FileFn (storage part uploads never get them; see [Part uploads](#part-uploads)). Request-specific headers (the JSON `Content-Type`, signed part headers, `x-upload-session-token`) are applied after them and replace an auth header with the same name in any letter case. Leaving out every option keeps the previous behavior: the global `fetch` with `same-origin` credentials.

The injected `fetch` is called without a `this` binding, so `window.fetch` can be passed directly. If no `fetch` is given, the global `fetch` is looked up when each request is sent.

### Session cookies with a CSRF header

```ts
const files = createFileFnClient({
  baseUrl: 'https://api.example.com/files',
  credentials: 'include', // send the session cookie to a cross-origin API
  getAuthHeaders: () => ({ 'x-csrf-token': readCsrfToken() }),
});
```

A cross-origin API must answer CORS requests with `Access-Control-Allow-Credentials: true`, set `Access-Control-Allow-Origin` to your app's explicit origin (browsers reject `*` for credentialed requests), and allow the CSRF header.

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

- A proxy upload URL under `baseUrl` (a root-relative path, which is appended to `baseUrl`, or an absolute URL with the same origin and path prefix) is a FileFn request. Dot segments (`..`, including `%2e%2e`) are resolved before this check, so a path that climbs out of `baseUrl` is not a FileFn request. It gets the `getAuthHeaders` headers and the configured `credentials`. A `baseUrl` of `'/'` or `''` means the page origin root, so every same-origin path is under it.
- Any other URL (for example an R2 bucket presigned URL, or a protocol-relative `//host/...` URL, which is sent to that host) gets only its signed headers and the upload session token, with `credentials: 'omit'`. Your auth headers and cookies are never sent to storage.

In a browser, `baseUrl` and the part URL are resolved against the document base URL (which follows `<base href>`), or the location in a worker, the same way `fetch` resolves them. The part request is sent to that resolved absolute URL, so the URL that is checked is the URL that is requested. Outside a browser the part URL is sent as given.

### Offline replay

With `offline: { enabled: true, partition, currentPrincipal, getAuthHeaders }`, uploads staged while offline are replayed by the client that runs the sync, using the `baseUrl`, `fetch` and retry options the client had when its queue was made, and only the headers `offline.getAuthHeaders(principal)` returns for the partition's own principal (required for the built-in transport: the client's `getAuthHeaders` acts for whoever is signed in now and is never used for replays). Replays run only while `currentPrincipal` reports the partition's principal (checked before and after resolving the headers of every request, retry and part, and again before sending); it must answer from local state without a network request. Replays send no cookies (`credentials: 'omit'`) unless `offline.replayAmbientCredentials` is true, because another tab can switch a cookie after the last check: return a bearer or session token issued for the principal. Auth headers are never written to OPFS, so an upload staged before a page reload is sent with the fresh token of the client created after it.

### Offline queue

Offline uploads go to a durable OPFS queue bound to `offline.partition` (a service and a user or guest namespace you trust). Each staged generation of an entry can be held, verified and published through your hooks, and stays provisional until publication is confirmed; tabs coordinate through `navigator.locks` (or `offline.queue.coordinator`), and without either the queue refuses durable work. Supply `offline.currentPrincipal` so queued work runs only while your credentials act for the partition's principal, and call `client.dispose()` on logout or account switch. Unscoped uploads staged by 0.4 and earlier are never replayed automatically; see `OfflineQueue.migrateLegacyUpload`. The full contract is in the FileFn docs under Features › Offline.

`upload/init` sends the idempotency key in the `x-idempotency-key` header. A replay of a completed session is reconciled from the stored file without uploading parts again; an expired or aborted one starts again under a fresh key.
