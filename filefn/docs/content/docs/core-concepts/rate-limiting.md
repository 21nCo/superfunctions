---
title: Rate limiting
description: Opt-in per-route rate limits. Categories you omit are not limited. Public uploads need a proxy-derived client key.
---

# Rate limiting

filefn integrates with `@superfunctions/middleware`'s `RateLimiter` to throttle the routes that actually matter.

## Configuration

```ts
const fileFn = createFileFn({
  database: db, storage,
  stores: { atomicKv: redisAtomicStore },
  rateLimit: {
    mode: "strict",
    algorithm: "sliding-window",          // or "fixed-window" | "token-bucket"
    limits: {
      uploadInit:        { windowSeconds: 60, maxRequests: 10 },
      uploadSign:        { windowSeconds: 60, maxRequests: 600 },
      uploadComplete:    { windowSeconds: 60, maxRequests: 30 },
      download:          { windowSeconds: 60, maxRequests: 120 },
      shareDownload:     { windowSeconds: 60, maxRequests: 60 },
      artifactDownload:  { windowSeconds: 60, maxRequests: 600 },
    },
  },
});
```

Every key under `limits` is opt-in. The full set is `uploadInit`, `uploadSign`, `uploadComplete`, `download`, `shareDownload`, `shareCreate`, `artifactDownload`, `list`, `processing`, and `grantCreate`. A category you leave out is not limited.

For `auth.required: false`, set `clientKey` from a header your proxy overwrites (for example `cf-connecting-ip` once the proxy has stripped any client-supplied copy). Otherwise every guest shares one bucket per category. The operator page has the public-upload sample: [Features › Rate limiting](../features/rate-limiting).

Or pass a pre-built `rateLimiter` directly:

```ts
import { createRateLimiter } from "@superfunctions/middleware";

const limiter = createRateLimiter({ /* ... */ });

const fileFn = createFileFn({
  db, storage,
  rateLimiter: limiter,
});
```

The standalone `rateLimiter` applies to upload init, signing, part uploads, completion, and file downloads. Use `rateLimit.limits` for per-category caps.

## Categories

| Category | Routes |
| --- | --- |
| `uploadInit` | `POST /upload/init` |
| `uploadSign` | `POST /upload/:id/parts/:n/sign` |
| `uploadComplete` | `PUT /upload/:id/parts/:n`, `POST /upload/:id/parts/:n/complete`, `POST /upload/:id/complete` |
| `download` | `GET /:fileId/download`, `GET /:fileId/versions/:versionId/download`, `GET /proxy/files/:fileId/download` |
| `shareDownload` | `GET /share-links/:token/download`, `GET /proxy/share-links/:token/download` |
| `shareCreate` | `POST /:fileId/share-links` |
| `artifactDownload` | List artifacts, get an artifact download URL, and download through the artifact proxy |
| `list` | `GET /` |
| `processing` | `POST /:fileId/process` |
| `grantCreate` | `POST /:fileId/permissions` |

Apply your framework's middleware to cap routes such as file metadata, render descriptors, and upload aborts.

## Algorithms

- **`fixed-window`** — counts requests inside a fixed time window. Simplest, but bursty at boundaries.
- **`sliding-window`** — smooths out the boundary effect. Default for the production examples.
- **`token-bucket`** — burst-friendly, refill over time. Best when you have legitimate bursty traffic (e.g. mass uploads from a script).

## Shared stores and modes

FileFn 0.2.0 uses `stores` and `rateLimit.mode`, not `rateLimit.persistence`.

- **`strict`** — shared `stores.atomicKv` with `compareAndSet`; missing atomic
  storage is rejected instead of silently using process-local counters.
- **`best-effort`** — `stores.kv` for deployments that accept approximate
  cross-replica limits.
- **`local`** — in-process counters for development or a single instance.

Without an explicit mode, FileFn selects strict for `stores.atomicKv`,
best-effort for `stores.kv`, otherwise local. Supply adapters implementing
the `@superfunctions/db` runtime-store contracts.

The separate pre-built `rateLimiter` still accepts the middleware's own
`atomicStore` / `persistence` options.


## What clients see

When a request is throttled:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
{
  "ok": false,
  "error": {
    "code": "FILEFN_RATE_LIMITED",
    "message": "Rate limit exceeded",
    "details": { "resetAt": "2025-01-01T00:00:30.000Z" }
  }
}
```

`details.resetAt` is the timestamp when the next request is expected to succeed. Bundled clients respect this and back off automatically.

## Picking limits

Defaults aren't shipped — operators know their traffic. A reasonable starting point:

| Category | Per-IP limit (per minute) |
| --- | --- |
| `uploadInit` | 60 (1/sec) |
| `uploadSign` | 1200 |
| `uploadComplete` | 120 |
| `download` | 120 |
| `shareDownload` | 60 |
| `artifactDownload` | 600 |

Tune up if you have legitimate burst patterns (image-heavy galleries, CI artifact downloads). Tune down if you're seeing scraping.
