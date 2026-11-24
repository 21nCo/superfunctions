# FileFn processing container

A Node container entry for `@filefn/processing`, built as a Cloudflare
Containers image. It runs one queued `filefn.processing` job per HTTP request
through `createProcessingJobHandler` from `@filefn/server`, reading files from
and writing artifacts to storage through the R2 adapter
(`@superfunctions/storage-r2`).

This directory is a private workspace (`@filefn/processing-container`); it is
not published to npm. The image is the deliverable.

## Image

```sh
# From the repository root. Cloudflare Containers run linux/amd64 images.
docker build --platform linux/amd64 -f filefn/processing/container/Dockerfile -t filefn-processing .
```

The image is `node:22-trixie-slim` with:

- `ffmpeg` (Debian package),
- `tesseract` with English language data (`tesseract-ocr`, `tesseract-ocr-eng`),
- `sharp` compiled against Debian's libvips (`libvips42t64`), which reads PDFs
  through poppler. sharp's prebuilt libvips has no PDF loader, so the image
  removes the prebuilt binaries and the build fails if the compiled `sharp`
  cannot read PDFs,

and runs `node dist/main.js` as the unprivileged `node` user on port 8080.

Processors it runs (`FILEFN_PROCESSORS`): `thumbnail`, `pdf-preview` and
`ocr`. OCR calls the native `tesseract` command, so recognition needs no
network access. Audio and video processors are not offered yet.

`pdf-preview` rasterizes the first page of a PDF
(`metadata.renderMode: "page-rasterized"`). A PDF libvips cannot read still
gets the processor's placeholder preview (`"placeholder"`).

## Routes

The server serves only these routes; anything else is 404, and a wrong method
is 405.

### `GET /health`

`200 {"status":"ok"}`. It needs no token. It does not check storage or the
database.

### `POST /jobs`

Runs one job. Send `Content-Type: application/json` and
`Authorization: Bearer <token>` with the `FILEFN_CONTAINER_TOKEN` value.

```json
{ "job": { "fileId": "…", "versionId": "…", "idempotencyKey": "…" }, "attempts": 1 }
```

- `job` is the queued message body exactly as FileFn enqueued it.
- `attempts` is the 1-based delivery attempt (a Cloudflare message's
  `attempts`); it defaults to 1. The delivery whose `attempts` exceeds
  `FILEFN_PROCESSING_MAX_RETRIES` records `processing.failed` instead of asking
  for a retry.

The response is `200 {"outcome": …}` with the handler's outcome:
`completed`, `duplicate`, `dropped`, `failed`, or `retry`. Acknowledge the
message for every status except `retry`, which asks for redelivery.

| Status | Meaning | Caller |
| --- | --- | --- |
| 200 | The job ran; see `outcome.status`. | Ack, or retry for `retry`. |
| 400 | The body is not JSON, has no `job`, or `attempts` is not an integer of at least 1. | Ack and drop: resending cannot succeed. |
| 401 | The bearer token is missing or wrong. | Fix configuration; retry. |
| 413 | The body is larger than `FILEFN_CONTAINER_MAX_BODY_BYTES`. | Ack and drop. |
| 415 | The content type is not `application/json`. | Fix the caller. |
| 503 | No job slot freed up within `FILEFN_CONTAINER_JOB_WAIT_MS` (`Retry-After: 30`). | Retry after `Retry-After` seconds. |
| 500 | The job threw. | Retry with a delay. |

A request that arrives while `FILEFN_CONTAINER_MAX_CONCURRENT_JOBS` jobs are
running waits for a free slot, first come first served, for up to
`FILEFN_CONTAINER_JOB_WAIT_MS`; only then does it get 503. A waiting request
whose client disconnects is not started. A started job runs to the end even if
its client disconnects.

Errors are `{"error":{"code","message"}}` with codes prefixed
`FILEFN_CONTAINER_`.

A Worker queue consumer forwards each message and acts on the outcome, for
example with a container binding. It retries with a delay, so a busy or
failing container does not use up the message's attempts within seconds:

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

Configure the consumer so it does not send more jobs than the container runs
at once, and keep the messages that run out of attempts:

```jsonc
// wrangler.jsonc
"queues": {
  "consumers": [{
    "queue": "filefn-processing",
    "max_batch_size": 1,
    "max_concurrency": 2,          // At most FILEFN_CONTAINER_MAX_CONCURRENT_JOBS.
    "max_retries": 3,              // The same as FILEFN_PROCESSING_MAX_RETRIES.
    "dead_letter_queue": "filefn-processing-dlq"
  }]
}
```

The delivery whose `attempts` exceeds `FILEFN_PROCESSING_MAX_RETRIES` records
`processing.failed` when the container runs it. If that last delivery cannot
run (503, 500 or the container is unreachable), no failure is recorded and the
message goes to the dead-letter queue, where it can be inspected or replayed.

## Configuration

Configuration is read from the environment at start; an invalid value stops
the process with `FILEFN_CONTAINER_CONFIG_INVALID: …`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FILEFN_R2_ACCOUNT_ID` | required without `FILEFN_R2_ENDPOINT` | R2 account. |
| `FILEFN_R2_BUCKET` | required | Bucket of the region's files. |
| `FILEFN_R2_ACCESS_KEY_ID`, `FILEFN_R2_SECRET_ACCESS_KEY` | required | R2 S3-API token. |
| `FILEFN_R2_JURISDICTION` | none | `eu` or `fedramp`. |
| `FILEFN_R2_ENDPOINT` | none | An S3-compatible endpoint instead of R2, such as MinIO. |
| `FILEFN_R2_REGION` | `auto` | SigV4 signing region. |
| `FILEFN_DATABASE` | required | `memory`, or the ES module that creates the database adapter (below). |
| `FILEFN_NAMESPACE` | FileFn's default | FileFn table namespace; must match the producer. |
| `FILEFN_PROCESSORS` | `thumbnail,pdf-preview,ocr` | Comma-separated processors to run. |
| `FILEFN_OCR_LANGUAGE` | `eng` | Tesseract languages, e.g. `eng+deu`; each needs its language data in the image. |
| `FILEFN_PROCESSING_MAX_RETRIES` | `3` | The queue consumer's `max_retries`. |
| `FILEFN_CONTAINER_TOKEN` | required | Bearer token `POST /jobs` requires. The container refuses to start without it. |
| `FILEFN_CONTAINER_ALLOW_UNAUTHENTICATED` | `false` | `true` lets the container start without a token, so `POST /jobs` is open to anything that reaches the port. Use it only when nothing but a trusted caller can. |
| `FILEFN_CONTAINER_MAX_CONCURRENT_JOBS` | `2` | Jobs run at once (1 to 64). |
| `FILEFN_CONTAINER_JOB_WAIT_MS` | `60000` | How long a job request waits for a free slot before 503 (0 to 600000). |
| `FILEFN_CONTAINER_MAX_BODY_BYTES` | `262144` | Largest `POST /jobs` body. |
| `PORT` | `8080` | Listening port. |

### Database

`FILEFN_DATABASE=memory` uses an in-memory database inside the container. It
is for tests and local runs: the producer cannot see it.

For a real database, set `FILEFN_DATABASE` to an ES module (an absolute path,
a path relative to the working directory, or a package name) whose default
export takes the environment and returns a `@superfunctions/db` adapter, for
example a Drizzle adapter over the host's FileFn tables in Postgres. Build it
into an image derived from this one:

```js
// db.mjs
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import * as schema from "./schema.mjs"; // Generated FileFn table definitions.

export default function createDatabase(env) {
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
  return drizzleAdapter({ db: drizzle(pool, { schema }), dialect: "postgres" });
}
```

The adapter's `close()` is called when the container shuts down.

### Processor configuration must match the producer

The producer (`@filefn/server` with `processing.flowFn`) and this container
must agree on the processors and the namespace: the job's idempotency key
names the producer's processors, and the container runs its own.

## Shutdown

On `SIGTERM` or `SIGINT` the server stops accepting connections, waits for
every accepted job to finish (including jobs whose client disconnected and
requests waiting for a slot), closes the database and exits 0.

## Tests

`npm test --workspace @filefn/processing-container` runs the unit suites and,
when `STORAGE_R2_S3_ENDPOINT`, `STORAGE_R2_S3_BUCKET`,
`STORAGE_R2_S3_ACCESS_KEY_ID` and `STORAGE_R2_S3_SECRET_ACCESS_KEY` point at an
S3-compatible server, an integration test: a FileFn producer imports a PNG and
a PDF, enqueues their jobs, and the test posts each job to a running
container, which must store a thumbnail and a first-page PDF preview in the
bucket and record them in the shared in-memory database. Set
`FILEFN_CONTAINER_IT_REQUIRED=1` to fail instead of skipping without an
endpoint, and `FILEFN_CONTAINER_IT_OCR=1` to also run OCR through `tesseract`.
With `FILEFN_CONTAINER_IT_PDF_RENDER=1`, or when the host's `sharp` can read
PDFs, the PDF preview must be the rasterized page: `renderMode`
`page-rasterized`, the page's aspect ratio, and the page's fill colour at its
centre.

`.github/workflows/filefn-processing-container.yml` builds the image on
Ubuntu, runs that suite inside the image's build stage against MinIO with OCR
and PDF rendering required, then starts the runtime image and checks its tools
(including `sharp`'s PDF loader), `/health`, a job,
token enforcement, an unknown route and a clean `SIGTERM` exit. Live
Cloudflare Containers are not covered.
