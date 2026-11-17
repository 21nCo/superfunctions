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

The image has `ffmpeg`, `tesseract` with English language data, and `sharp`. It runs the `thumbnail`, `pdf-preview` and `ocr` processors (`FILEFN_PROCESSORS`); OCR calls the native `tesseract` command. Audio and video processors are not offered yet. The prebuilt libvips in `sharp` has no PDF loader, so PDF previews in this image are placeholder previews of page 1 (`metadata.renderMode: "placeholder"`).

## Routes

The container serves two routes and nothing else:

- `GET /health` returns `200 {"status":"ok"}`.
- `POST /jobs` takes `{"job": <queued message body>, "attempts": <delivery attempt>}` as `application/json`, runs the job through `createProcessingJobHandler`, and returns `200 {"outcome": …}`. Acknowledge the message unless `outcome.status` is `retry`. A 503 (too many running jobs) or 500 asks for a retry; a 400 or 413 body can never succeed.

When `FILEFN_CONTAINER_TOKEN` is set, `POST /jobs` requires `Authorization: Bearer <token>`.

```ts
async queue(batch: MessageBatch, env: Env) {
  const container = env.FILEFN_PROCESSING_CONTAINER.getByName("processing");
  for (const message of batch.messages) {
    const response = await container.fetch("http://container/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.FILEFN_CONTAINER_TOKEN}` },
      body: JSON.stringify({ job: message.body, attempts: message.attempts }),
    });
    const outcome = response.ok ? ((await response.json()) as { outcome: { status: string } }).outcome : null;
    if (response.status === 400 || response.status === 413 || (outcome && outcome.status !== "retry")) message.ack();
    else message.retry();
  }
}
```

## Storage and database

The container reaches storage through the R2 adapter: `FILEFN_R2_ACCOUNT_ID`, `FILEFN_R2_BUCKET`, `FILEFN_R2_ACCESS_KEY_ID` and `FILEFN_R2_SECRET_ACCESS_KEY` (or `FILEFN_R2_ENDPOINT` for an S3-compatible server such as MinIO).

`FILEFN_DATABASE` names the database: `memory` (tests and local runs only, since the producer cannot see it), or an ES module whose default export takes the environment and returns a `@superfunctions/db` adapter, such as a Drizzle adapter over your FileFn tables in Postgres. Add the module to an image built from this one. `FILEFN_NAMESPACE` and the processors must match the FileFn instance that enqueues the jobs.

The full list of variables, status codes and the test setup is in `filefn/processing/container/README.md`.

## What is verified

CI builds the image on Ubuntu, runs the container's suite inside it against MinIO with an in-memory database (a PNG thumbnail, a first-page PDF preview and OCR through `tesseract`), and smoke-tests the runtime image. Live Cloudflare Containers are not covered.
