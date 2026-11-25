---
title: Rate limiting
description: Per-route rate limiting on upload-init, sign, complete, download, share-download, and artifact-download.
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
    // Gives each unauthenticated caller its own bucket, for example by the
    // client IP your proxy reports.
    clientKey: (request) => request.headers.get("x-client-ip"),
  },
});
```

`rateLimit.limits` accepts any subset of categories — categories you don't list aren't limited. `list` covers listing files, `processing` covers starting processing (`POST /:fileId/process`), and `grantCreate` and `shareCreate` cover creating grants and share links.

Buckets are per tenant and principal for signed-in callers. Unauthenticated callers share one bucket per category unless `rateLimit.clientKey` names them; only use a value your own proxy sets, never one the client can choose. With `mode: "local"`, each distinct client key keeps an in-memory bucket until that key is seen again, so for anonymous traffic from many clients use `"strict"` or `"best-effort"` with a store that expires entries.

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
