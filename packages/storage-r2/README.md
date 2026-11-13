# @superfunctions/storage-r2

Cloudflare R2 storage adapter for `@superfunctions/storage`. It talks to R2's
S3-compatible API with `fetch` and Web Crypto only (no AWS SDK), so the same
adapter runs on Cloudflare Workers (no `nodejs_compat` flag needed), Node.js 20+
and other standards-based runtimes.

```ts
import { createR2StorageAdapter } from '@superfunctions/storage-r2';

const storage = createR2StorageAdapter({
  accountId: env.R2_ACCOUNT_ID,
  bucket: env.R2_BUCKET,
  accessKeyId: env.R2_ACCESS_KEY_ID, // R2 S3-API token
  secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  // jurisdiction: 'eu',
});
```

The adapter takes R2 S3-API credentials rather than a Workers R2 binding,
because direct-to-storage uploads need presigned URLs, which a binding cannot
produce.

## Behaviour

- Requests use path-style addressing:
  `https://<accountId>[.<jurisdiction>].r2.cloudflarestorage.com/<bucket>/<key>`,
  signed with SigV4 for region `auto`.
- Presigned PUT, GET and multipart-part URLs are signed in-process. Upload
  constraints (`contentType`, `contentLength`) become signed headers: the
  uploader must send the returned `headers`, and a body of a different length
  is rejected by R2.
- A missing object (`statObject`, `openDownloadStream`) throws
  `STORAGE_NOT_FOUND`; other API failures throw `R2RequestError`, whose `name`
  is the S3 error code and whose `statusCode` is the HTTP status.
- Keys must be non-empty and must not contain `.` or `..` path segments
  (`STORAGE_KEY_INVALID`), because `fetch` would resolve them to another key.

## Options

| Option | Purpose |
| --- | --- |
| `endpoint` | Override the API endpoint, e.g. a local S3-compatible server for tests. |
| `region` | SigV4 region; defaults to `auto`. |
| `fetch` | Custom `fetch` implementation. |

## Tests

`npm test` runs the Node suite and a workerd suite. The workerd suite bundles a
Worker with wrangler, asserts from the esbuild metafile that no `@aws-sdk`
module is included, and serves it with Miniflare. Set `STORAGE_R2_S3_ENDPOINT`,
`STORAGE_R2_S3_BUCKET`, `STORAGE_R2_S3_ACCESS_KEY_ID` and
`STORAGE_R2_S3_SECRET_ACCESS_KEY` to also run the conformance and round-trip
suites against an S3-compatible server such as MinIO (see
`.github/workflows/storage-r2-minio.yml`).
