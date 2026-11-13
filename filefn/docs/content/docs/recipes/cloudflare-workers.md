---
title: Cloudflare Workers
description: Mount filefn under a path prefix in a Worker, keep background processing alive with ctx.waitUntil, and clean up expired upload sessions from a cron trigger.
---

# Cloudflare Workers

filefn's router takes a standard `Request` and returns a `Response`, so it runs inside a Worker. On Workers you need to handle three things:

1. **Path prefix.** The host app usually mounts filefn under a prefix such as `/files`. Pass `basePath` so the router matches its routes under that prefix.
2. **Background work.** A Worker cancels work that is still pending after the response unless it is passed to `ctx.waitUntil`. filefn sends its background work through the `runtime.defer` hook: processing when no queue is configured, and event delivery to observability sinks.
3. **Expired upload sessions.** filefn does not run a timer. Call `cleanupExpiredSessions()` from a cron trigger.

filefn's server imports Node built-ins (`crypto`, `events`, `Buffer`), so enable the `nodejs_compat` compatibility flag.

```jsonc
// wrangler.jsonc
{
  "name": "files-api",
  "main": "src/worker.ts",
  "compatibility_date": "2025-11-13",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": { "crons": ["*/15 * * * *"] }
}
```

## Worker

```ts
import { Hono } from "hono";
import { createFileFn, type FileFnConfig } from "@filefn/server";
import { createR2StorageAdapter } from "@superfunctions/storage-r2";
import { createDatabase } from "./database"; // Your @superfunctions/db adapter; its driver must run on Workers.

interface Env {
  R2_ACCOUNT_ID: string;
  R2_BUCKET: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

function fileFnFor(env: Env, ctx: ExecutionContext) {
  const config: FileFnConfig = {
    database: createDatabase(env),
    storage: createR2StorageAdapter({
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    }),
    basePath: "/files",
    runtime: { defer: (work) => ctx.waitUntil(work) },
    auth: {
      required: true,
      resolveSession: async (request) => {
        // Resolve the caller from your session or token.
        return null;
      },
    },
  };
  return createFileFn(config);
}

const app = new Hono<{ Bindings: Env }>();

app.all("/files/*", async (c) => {
  const fileFn = fileFnFor(c.env, c.executionCtx);
  const response = await fileFn.router.handle(c.req.raw);
  return response ?? c.notFound();
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    await fileFnFor(env, ctx).cleanupExpiredSessions();
  },
};
```

The Worker creates filefn per request so that `runtime.defer` uses that request's `ctx.waitUntil`. Creating it is cheap. Keep state that must outlive a request in your database and storage, not in filefn. If you rate-limit, configure `rateLimit` with `stores.atomicKv` (strict mode). The `local` mode counts in memory, so a per-request instance starts every count at zero.

## Base path

- `basePath: "/files"` serves `GET /files` (list), `POST /files/upload/init`, `GET /files/:fileId/download`, `GET /files/proxy/files/:fileId/download` and the rest. For requests outside the prefix, `router.handle` returns `null`. Without `basePath`, routes stay at the root, as before.
- The value must be an absolute, already-encoded path (`/files`, `/api/v1/files`). A trailing slash is ignored. Matching is case-sensitive and stops at a segment boundary, so `/filesx` does not match. An invalid value makes `createFileFn` throw `FILEFN_BASE_PATH_INVALID`.
- Proxy upload, proxy download and artifact URLs in responses stay relative to the mount, for example `/upload/:id/parts/1` and `/proxy/files/:fileId/download`. Configure clients with the mount as their base URL, for example `createFileFnClient({ baseUrl: "https://api.example.com/files" })`. The client puts its base URL in front of root-relative part-upload URLs only. It returns the download and artifact URLs from `downloadUrl` and `downloadArtifact` unchanged, so resolve a root-relative `/proxy/...` URL against the mount yourself, for example `new URL("/files" + url, origin)`.

## Background work and `runtime.defer`

`runtime.defer(work)` receives each piece of background work as a promise that has already started and never rejects. filefn calls it as a method, `runtime.defer(work)`, so a hook can read its context through `this`. It is called while the request that triggered the work is still being handled. It is also called from deferred work after the response: processing emits events, and their delivery is deferred while the processing is still pending. `ctx.waitUntil` accepts both. Failures are logged through filefn's logger, and a logger that throws does not break the request or the work. If the hook itself throws, filefn logs the error and the work still runs, but Workers may cancel it.

Without `runtime`, filefn behaves as on Node: processing starts on a `setImmediate` turn after the request and runs detached. On Workers, configure the hook, or configure a processing queue through `processing.flowFn` so processing does not run in the request at all.

## Expired upload sessions

`fileFn.cleanupExpiredSessions()` deletes upload sessions that expired before completing. It also aborts their multipart uploads and removes proxy part objects. It returns `{ deletedSessions, abortedMultipart }`. Completed sessions are kept.

## IDs

filefn generates upload, file, version and artifact IDs as `<prefix>_<random>`. The random part is 20 base32 characters (100 bits) from the `node:crypto` CSPRNG (`randomFillSync`), which does not need a global Web Crypto object, for example `file_8h3k2m9q4x7c1v5t0bnr`. IDs are opaque. IDs from earlier versions (`file_<time>_<random>`) remain valid.

## What is verified

The `@filefn/server` test suite bundles a Hono Worker like the one above with Wrangler's deploy bundler. It runs the bundle in workerd through Miniflare, with in-memory database and storage adapters. The test drives init, part upload, complete and download under `/files`. It checks that processing is registered with `ctx.waitUntil` and finishes, and it fires the cron trigger to delete an expired session. Live R2, Queues, Containers and cron on a Cloudflare account are not covered by that test.
