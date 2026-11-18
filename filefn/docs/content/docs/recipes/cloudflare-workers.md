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

For a complete Worker that authenticates FileFn with AuthFn, stores files in a regional R2 bucket and processes uploads through a queue and the processing container, see [Workers with AuthFn, R2 and Queues](./workers-authfn-r2-queues).

```jsonc
// wrangler.jsonc
{
  "name": "files-api",
  "main": "src/worker.ts",
  "compatibility_date": "2025-11-13",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": { "crons": ["*/15 * * * *"] },
  // Only for queued processing (see below). Keep max_retries equal to the handler's maxRetries.
  "queues": {
    "producers": [{ "binding": "FILEFN_PROCESSING_QUEUE", "queue": "filefn-processing" }],
    "consumers": [{ "queue": "filefn-processing", "max_retries": 3 }]
  }
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
  // Only for queued processing (see below).
  FILEFN_PROCESSING_QUEUE: Queue;
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

## Queued processing

To run processing outside the request, bind a Cloudflare Queue as a producer and a consumer (the `queues` entry in `wrangler.jsonc` above) and pass a producer as `processing.flowFn`. FileFn then enqueues a `filefn.processing` job when an upload completes. Import the producer from `@filefn/processing/queues/cloudflare`; that entry point has no dependencies, so the Worker does not bundle the image and OCR processors.

```ts
import { createCloudflareFlowFnProvider } from "@filefn/processing/queues/cloudflare";
import { createProcessingJobHandler } from "@filefn/server";

// In fileFnFor's config:
processing: {
  enabled: true,
  processors,
  flowFn: createCloudflareFlowFnProvider({ "filefn.processing": env.FILEFN_PROCESSING_QUEUE }),
},

// In the Worker's default export, next to fetch and scheduled:
async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext) {
  await createProcessingJobHandler(fileFnFor(env, ctx), { maxRetries: 3 }).queue(batch);
},
```

`createProcessingJobHandler(fileFn)` runs the configured processors for each message and records artifacts through that FileFn instance. Artifacts and run rows are written once per job idempotency key. Each processor that finishes writes a run row (kind `filefn.processing-run`) after its artifacts, and a redelivered job skips processors that have one. `processing.completed` is at least once: once every processor has a run row, the job emits it and then records that it did in another run row. A delivery that fails or is evicted before that record emits it again on the next delivery, with `artifactsCreated` counting the job's artifacts across its deliveries. Overlapping deliveries of one job can each emit it, and a delivery that finds the completion recorded emits nothing. Processors that share a name are told apart by their position among the processors with that name. Run rows have no stored object, and the artifact list, lookup and download operations never return them. A `processing.started`, `processing.completed` or `processing.failed` listener that throws, or whose promise rejects, is logged: the job's outcome does not change and the other listeners still receive the event.

- A job whose file version is gone, before or after its writes, is acknowledged and dropped once it has removed the rows left for that version and the objects they name. The rows are removed last, so a cleanup that fails (a reference scan or object delete error) keeps them and is retried, and the next delivery resumes it. A job dropped this way emits `processing.completed` only when the delete lands after the job emitted it and before the job's re-check of the version once the completion is recorded; otherwise it emits neither `processing.completed` nor `processing.failed`. A cleanup that fails on the last delivery is not retried: the job is still dropped without `processing.failed`, the handler logs an error naming the kept rows, and those rows and their objects stay. An object this delivery uploaded before it wrote the object's row is removed best effort. A delete removes the file's version objects and releases their quota before it lists the file's artifacts, so a delete that fails later can be retried, and artifacts a job finished writing earlier are removed by the delete, even if the job already reported `processing.completed`. Neither removes an object that another file's version or artifact references with the same key in the same storage target.
- A processor failure calls `message.retry()`. A processor that throws, returns `success: false`, returns something other than an object, returns a `success` that is not a boolean, returns `success: true` without an `artifacts` array, or returns an artifact that lacks a non-empty `kind` and `storageKey`, a string `mimeType` or `Uint8Array` `data`, or that has the reserved kind `filefn.processing-run`, has failed, and nothing it returned is stored; `artifacts: []` is a successful run with no output. Set `maxRetries` to the consumer's `max_retries` (Cloudflare's default is 3): on the delivery whose `attempts` exceeds it, the handler emits `processing.failed` and acknowledges the message.
- `retryDelaySeconds` (handler) and `delaySeconds` (producer) accept at most 86400, the 24-hour limit Cloudflare Queues sets on message delays; a larger value throws when the handler or producer is created.
- A message body that is not a processing job is acknowledged and dropped. Optional fields over 512 characters (`requestId`, `jobId`, `idempotencyKey`) are ignored rather than rejected.
- Each artifact's `metadata.processing` holds `{ processor, durationMs, idempotencyKey, storageTarget }`. FileFn reserves that key and overwrites a processor's own `processing` metadata.

Processors that need native tools (sharp, ffmpeg, tesseract) do not run in a Worker. To run them, forward each message to the [processing container](./processing-container) and acknowledge or retry it by the outcome the container returns.

## Expired upload sessions

`fileFn.cleanupExpiredSessions()` deletes upload sessions that expired before completing. It also aborts their multipart uploads and removes proxy part objects. It returns `{ deletedSessions, abortedMultipart }`. Completed sessions are kept, and so are sessions a running completion holds; an expired `publishing` session is finished, and part rows a completed session's cleanup left are deleted.

## IDs

filefn generates upload, file and version IDs as `<prefix>_<random>`. The random part is 20 base32 characters (100 bits) from the `node:crypto` CSPRNG (`randomFillSync`), which does not need a global Web Crypto object, for example `file_8h3k2m9q4x7c1v5t0bnr`. Processing derives each artifact ID from the file, version and artifact kind instead (`art_` and 20 base32 characters of a SHA-256 digest), so a redelivered job writes the same row. IDs are opaque. IDs from earlier versions (`file_<time>_<random>`) remain valid.

## What is verified

The `@filefn/server` test suite bundles a Hono Worker like the one above with Wrangler's deploy bundler. It runs the bundle in workerd through Miniflare, with in-memory database and storage adapters. The test drives init, part upload, complete and download under `/files`. It checks that processing is registered with `ctx.waitUntil` and finishes, and it fires the cron trigger to delete an expired session. Live R2, Queues, Containers and cron on a Cloudflare account are not covered by that test.
