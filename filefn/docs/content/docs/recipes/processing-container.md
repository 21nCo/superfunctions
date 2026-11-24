---
title: Processing container
description: Run FileFn processing jobs in a container image with sharp, ffmpeg and tesseract, for example on Cloudflare Containers behind a queue consumer Worker.
---

# Processing container

`filefn/processing/container` builds a Node container image that runs queued `filefn.processing` jobs. A Worker that consumes the processing queue forwards each message to the container, which runs the FileFn processors that need native tools and records their artifacts.

```sh
# From the repository root. Cloudflare Containers run linux/amd64 images.
docker build --platform linux/amd64 -f filefn/processing/container/Dockerfile -t filefn-processing .
```

The image (`node:22-trixie-slim`) has `ffmpeg`, `tesseract` with English language data, and `sharp` compiled against Debian's libvips, which reads PDFs through poppler. It runs the `thumbnail`, `pdf-preview` and `ocr` processors (`FILEFN_PROCESSORS`); OCR calls the native `tesseract` command, and PDF previews are the rasterized first page (`metadata.renderMode: "page-rasterized"`). Audio and video processors are not offered yet.

## Routes

The container serves two routes and nothing else:

- `GET /health` returns `200 {"status":"ok"}`.
- `POST /jobs` takes `{"job": <queued message body>, "attempts": <delivery attempt>}` as `application/json`, runs the job through `createProcessingJobHandler`, and returns `200 {"outcome": …}`. Acknowledge the message unless `outcome.status` is `retry`. A request that arrives while `FILEFN_CONTAINER_MAX_CONCURRENT_JOBS` jobs are running waits up to `FILEFN_CONTAINER_JOB_WAIT_MS` (default 60 s) for a slot; after that it gets 503 with `Retry-After: 30`. A 503 or 500 asks for a delayed retry; a 400 or 413 body can never succeed.

`POST /jobs` requires `Authorization: Bearer <token>` with the `FILEFN_CONTAINER_TOKEN` value. The container refuses to start without a token unless `FILEFN_CONTAINER_ALLOW_UNAUTHENTICATED=true` is set, which leaves `POST /jobs` open to anything that can reach the port.

The consumer retries with a delay, so a busy or failing container does not use up a message's attempts within seconds:

```ts
async queue(batch: MessageBatch, env: Env) {
  const container = env.FILEFN_PROCESSING_CONTAINER.getByName("processing");
  for (const message of batch.messages) {
    let response: Response;
    try {
      response = await container.fetch("http://container/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.FILEFN_CONTAINER_TOKEN}` },
        body: JSON.stringify({ job: message.body, attempts: message.attempts }),
      });
    } catch {
      message.retry({ delaySeconds: 30 });
      continue;
    }
    const outcome = response.ok ? ((await response.json()) as { outcome: { status: string } }).outcome : null;
    if (response.status === 400 || response.status === 413 || (outcome && outcome.status !== "retry")) message.ack();
    else message.retry({ delaySeconds: Number(response.headers.get("retry-after")) || 30 });
  }
}
```

Give the consumer `max_batch_size: 1`, a `max_concurrency` no higher than `FILEFN_CONTAINER_MAX_CONCURRENT_JOBS`, the same `max_retries` as `FILEFN_PROCESSING_MAX_RETRIES`, and a `dead_letter_queue`. The last delivery records `processing.failed` when it runs; if it cannot run (503, 500 or an unreachable container), the message lands in the dead-letter queue instead of disappearing.

## Storage and database

The container reaches storage through the R2 adapter: `FILEFN_R2_ACCOUNT_ID`, `FILEFN_R2_BUCKET`, `FILEFN_R2_ACCESS_KEY_ID` and `FILEFN_R2_SECRET_ACCESS_KEY` (or `FILEFN_R2_ENDPOINT` for an S3-compatible server such as MinIO).

`FILEFN_DATABASE` names the database: `memory` (tests and local runs only, since the producer cannot see it), or an ES module whose default export takes the environment and returns a `@superfunctions/db` adapter, such as a Drizzle adapter over your FileFn tables in Postgres. Add the module to an image built from this one. `FILEFN_NAMESPACE` and the processors must match the FileFn instance that enqueues the jobs.

The full list of variables, status codes and the test setup is in `filefn/processing/container/README.md`.

## What is verified

CI builds the image on Ubuntu, runs the container's suite inside it against MinIO with an in-memory database (a PNG thumbnail, the rasterized first page of a PDF and OCR through `tesseract`), and smoke-tests the runtime image. Live Cloudflare Containers are not covered.
