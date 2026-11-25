---
title: Rate limiting
description: Opt-in per-route rate limits, including a trusted client key for public uploads.
---

# Rate limiting

See [Core Concepts › Rate limiting](../core-concepts/rate-limiting) for the conceptual overview and recommended starting limits. This page is the operator-facing reference.

## Wiring

```ts
import { createFileFn } from "@filefn/server";

const fileFn = createFileFn({
  database: db, storage,
  stores: { atomicKv: redisAtomicStore },
  rateLimit: {
    mode: "strict",
    algorithm: "sliding-window",
    limits: {
      uploadInit:        { windowSeconds: 60, maxRequests: 10 },
      uploadSign:        { windowSeconds: 60, maxRequests: 600 },
      uploadComplete:    { windowSeconds: 60, maxRequests: 30 },
      download:          { windowSeconds: 60, maxRequests: 120 },
      shareDownload:     { windowSeconds: 60, maxRequests: 60 },
      artifactDownload:  { windowSeconds: 60, maxRequests: 600 },
      list:              { windowSeconds: 60, maxRequests: 120 },
      processing:        { windowSeconds: 60, maxRequests: 30 },
      grantCreate:       { windowSeconds: 60, maxRequests: 30 },
      shareCreate:       { windowSeconds: 60, maxRequests: 30 },
    },
    // See "Public uploads" below. This header is only safe when the edge proxy
    // overwrites it and drops any value the client sent.
    clientKey: (request) => request.headers.get("cf-connecting-ip"),
  },
});
```

## Categories are opt-in

With `rateLimit.limits`, each category is limited only when you configure it. The categories are:

| Category | What it limits |
| --- | --- |
| `uploadInit` | `POST /upload/init` |
| `uploadSign` | `POST /upload/:id/parts/:n/sign` |
| `uploadComplete` | Uploading or recording a part and `POST /upload/:id/complete` |
| `download` | file download |
| `shareDownload` | downloading through a share link |
| `shareCreate` | creating a share link |
| `artifactDownload` | Listing artifacts, requesting an artifact URL, or downloading an artifact |
| `list` | listing files |
| `processing` | `POST /:fileId/process` |
| `grantCreate` | creating a grant |

## Public uploads

With `auth.required: false`, unauthenticated callers share one bucket per category and tenant unless `clientKey` names them. Derive that key from an address your proxy sets, and ignore a header the browser can choose. On an edge that overwrites `cf-connecting-ip` (and strips a client-supplied copy), a public drop-off looks like this. Only the categories in `limits` are capped:

```ts
const fileFn = createFileFn({
  database: db,
  storage,
  auth: { required: false },
  policies: [{ name: "drop-off", contentTypes: ["text/plain"], visibility: "public" }],
  stores: { atomicKv: redisAtomicStore },
  rateLimit: {
    mode: "strict",
    algorithm: "fixed-window",
    limits: {
      uploadInit: { windowSeconds: 60, maxRequests: 10 },
      uploadComplete: { windowSeconds: 60, maxRequests: 30 },
      list: { windowSeconds: 60, maxRequests: 120 },
    },
    clientKey: (request) => request.headers.get("cf-connecting-ip"),
  },
});
```

Send a JSON body like this to `POST /upload/init`:

```json
{ "policy": "drop-off", "fileName": "example.txt", "mimeType": "text/plain", "size": 4 }
```

Two guests then have independent buckets. After one guest makes 10 `uploadInit` requests in the window, the next is limited without spending that guest's `list` budget. Guests for whom `clientKey` returns no value share the unnamed anonymous bucket.

Buckets for signed-in callers are per tenant and principal. With `mode: "local"`, each distinct client key keeps an in-memory bucket until that key is seen again, so for anonymous traffic from many clients use `"strict"` or `"best-effort"` with a store that expires entries.

`rateLimit.algorithm` is one of `"fixed-window" | "sliding-window" | "token-bucket"`.

`rateLimit.mode: "strict"` uses CAS-capable `stores.atomicKv` for shared counters.
Use `"best-effort"` with `stores.kv` when approximate cross-replica limits are
acceptable, or `"local"` for in-process counters. Without an explicit mode,
FileFn selects strict for `atomicKv`, best-effort for `kv`, otherwise local.
The former `rateLimit.persistence` option was removed in 0.2.0.

## Pre-built rate limiter

```ts
import { createRateLimiter } from "@superfunctions/middleware";

const limiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 100,
  persistence: redisPersistence,
});

const fileFn = createFileFn({
  db, storage,
  rateLimiter: limiter, // applied to every route
});
```

Use this when you want a single bucket for all routes. Combine with `rateLimit.limits` if you want per-category limits on top of a global cap.

## Errors

`FILEFN_RATE_LIMITED` (HTTP 429) with `details.resetAt` (ISO timestamp). The bundled clients handle the retry-after themselves.

## See also

- [Core Concepts › Rate limiting](../core-concepts/rate-limiting) — picking limits, persistence options.
