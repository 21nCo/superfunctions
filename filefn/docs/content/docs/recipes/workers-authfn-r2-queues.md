---
title: Workers with AuthFn, R2 and Queues
description: A complete Cloudflare Worker that serves AuthFn and FileFn on one origin, stores files in a regional R2 bucket, keeps metadata in the region's Postgres, and processes uploads on the device or through Cloudflare Queues and a processing container.
---

# Workers with AuthFn, R2 and Queues

This recipe puts the pieces from [Cloudflare Workers](./cloudflare-workers) and [Processing container](./processing-container) together in one Worker:

- **AuthFn** serves `/auth/*` and authenticates every FileFn request, with CSRF checks for cookie sessions.
- **FileFn** serves `/files/*`. File objects go to the region's **R2** bucket and file metadata to the FileFn tables in the region's **Postgres**.
- **Processing** runs on the device (clients upload their own thumbnails) or remotely (a **Queue** carries each job to the processing container), chosen per environment.

Deploy one Worker per region. Each region has its own R2 bucket, Postgres database, queue and container, so a file's bytes and metadata are stored in its region. Where they are processed is a separate question: Cloudflare runs the Worker wherever the request arrives, and nothing in this recipe restricts where the processing container runs, so with `remote` processing the container may read a file's bytes outside its region. If bytes must not leave the region while processed, use `device` processing, or a placement control you have verified for your account.

```jsonc
// wrangler.jsonc
{
  "name": "files-api",
  "main": "src/worker.ts",
  "compatibility_date": "2025-11-13",
  "compatibility_flags": ["nodejs_compat"],
  "triggers": { "crons": ["*/15 * * * *"] },
  "env": {
    "eu": {
      "routes": [
        { "pattern": "app.example.eu/auth/*", "zone_name": "example.eu" },
        { "pattern": "app.example.eu/files/*", "zone_name": "example.eu" }
      ],
      "vars": { "R2_BUCKET": "files-eu", "R2_JURISDICTION": "eu", "FILEFN_PROCESSING": "remote" },
      "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<eu Hyperdrive config ID>" }],
      "queues": {
        "producers": [{ "binding": "FILEFN_PROCESSING_QUEUE", "queue": "filefn-processing-eu" }],
        "consumers": [{
          "queue": "filefn-processing-eu",
          "max_batch_size": 1,
          "max_concurrency": 2, // At most the container's FILEFN_CONTAINER_MAX_CONCURRENT_JOBS.
          "max_retries": 3, // The container's FILEFN_PROCESSING_MAX_RETRIES.
          "dead_letter_queue": "filefn-processing-eu-dlq"
        }]
      },
      "containers": [{
        "class_name": "ProcessingContainer",
        // The processing container image plus your FILEFN_DATABASE module, pushed with `wrangler containers push`.
        "image": "registry.cloudflare.com/<account ID>/filefn-processing:1",
        "max_instances": 1
      }],
      "durable_objects": {
        "bindings": [{ "name": "FILEFN_PROCESSING_CONTAINER", "class_name": "ProcessingContainer" }]
      }
    }
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ProcessingContainer"] }]
}
```

Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `FILEFN_CONTAINER_TOKEN` and `CONTAINER_DATABASE_URL` as secrets for each environment (`wrangler secret put R2_ACCESS_KEY_ID --env eu`). Leave out the queue, container and Durable Object bindings in an environment that sets `FILEFN_PROCESSING` to `device`.

Build the image as the [processing container](./processing-container) recipe shows, add a `db.mjs` (the `FILEFN_DATABASE` module from the container's README, which connects with `DATABASE_URL`) to an image derived from it, and push that image. Hyperdrive serves only Workers, so the container connects to the region's Postgres directly with `CONTAINER_DATABASE_URL`.

The browser uploads parts straight to R2 with signed URLs, so the bucket needs a CORS rule for the app's origin. The client reads each part's `ETag` and sends `x-upload-session-token` with the part:

```json
{
  "rules": [{
    "allowed": {
      "origins": ["https://app.example.eu"],
      "methods": ["PUT", "GET"],
      "headers": ["content-type", "x-upload-session-token"]
    },
    "exposeHeaders": ["ETag"],
    "maxAgeSeconds": 3600
  }]
}
```

Apply it with `wrangler r2 bucket cors set files-eu --file r2-cors.json --jurisdiction eu`. `GET` lets the page `fetch` signed download URLs; an `<img>` without `crossorigin` does not need it.

In a `remote` environment, `ProcessingContainer` (below) starts the region's processing container with these variables, which must agree with this Worker and its queue consumer:

| Container variable | Must be |
| --- | --- |
| `FILEFN_R2_BUCKET`, `FILEFN_R2_ACCOUNT_ID` | The Worker's `R2_BUCKET` and `R2_ACCOUNT_ID`. |
| `FILEFN_R2_JURISDICTION` | The Worker's `R2_JURISDICTION` (`eu` here). Without it the container addresses the bucket outside its jurisdiction and cannot read the uploads. |
| `FILEFN_R2_ACCESS_KEY_ID`, `FILEFN_R2_SECRET_ACCESS_KEY` | A token that can read and write this bucket. |
| `FILEFN_DATABASE`, `DATABASE_URL` | `./db.mjs` in the image, and the Worker's `CONTAINER_DATABASE_URL`: the same regional Postgres. |
| `FILEFN_NAMESPACE` | The FileFn namespace of `createFiles` below (FileFn's default here, so leave both unset). |
| `FILEFN_PROCESSORS` | The names in `containerProcessors` below (`thumbnail,pdf-preview,ocr`). |
| `FILEFN_PROCESSING_MAX_RETRIES` | The consumer's `max_retries` (3). |
| `FILEFN_CONTAINER_MAX_CONCURRENT_JOBS` | At least the consumer's `max_concurrency` (2); otherwise extra deliveries wait, get 503 and use up their attempts. |
| `FILEFN_CONTAINER_TOKEN` | The Worker's `FILEFN_CONTAINER_TOKEN` secret. |

## Environment

```ts
// src/env.ts
export interface Env {
  /** This region's Postgres, which holds the AuthFn and FileFn tables. */
  HYPERDRIVE: Hyperdrive;
  R2_ACCOUNT_ID: string;
  /** This region's bucket. */
  R2_BUCKET: string;
  R2_JURISDICTION?: "eu" | "fedramp";
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** `device`: clients upload their own artifacts. `remote`: the queue and the container process uploads. */
  FILEFN_PROCESSING: "device" | "remote";
  FILEFN_PROCESSING_QUEUE?: Queue;
  FILEFN_PROCESSING_CONTAINER?: DurableObjectNamespace;
  FILEFN_CONTAINER_TOKEN?: string;
  /** The region's Postgres for the container, which cannot use Hyperdrive. */
  CONTAINER_DATABASE_URL?: string;
}
```

`createDatabase(env)` in `src/database.ts` is your `@superfunctions/db` adapter over the region's Postgres, for example the [PostgreSQL adapter](../adapters/db-postgres) with `pg` connecting through `env.HYPERDRIVE.connectionString`. AuthFn and FileFn share it, so its table registry must include both libraries' tables, and their migrations must have run (see [DB adapters](../adapters/db)).

## AuthFn

```ts
// src/auth.ts
import {
  authfn,
  authFnPlugins,
  AuthFnCsrfInvalidError,
  AuthFnError,
  defineAuthFnScopes,
  hasScopes,
  type AuthFnServer,
  type AuthFnSession,
} from "authfn";
import { authFnApiKeyPlugin } from "@authfn/api-keys";
import { authFnPasswordPlugin } from "@authfn/password";
import { forbidden, type FileFnPrincipal } from "@filefn/server";
import type { Adapter } from "@superfunctions/db";

/** The scopes an AuthFn API key can be granted for FileFn. */
export const scopes = defineAuthFnScopes({ files: ["read", "write"] });

export const authApp = authfn({
  basePath: "/auth",
  scopes,
  plugins: authFnPlugins(authFnPasswordPlugin(), authFnApiKeyPlugin()),
});

export function createAuth(database: Adapter): AuthFnServer {
  return authApp.createServer({ database });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** FileFn's `auth.resolveSession`: the AuthFn session as a FileFn principal. */
export async function resolveFileFnPrincipal(auth: AuthFnServer, request: Request): Promise<FileFnPrincipal | null> {
  let session: AuthFnSession | null;
  try {
    session = SAFE_METHODS.has(request.method)
      ? await auth.provider.authenticate(request)
      : await auth.authorizeMutation(request);
  } catch (error) {
    if (error instanceof AuthFnCsrfInvalidError) throw forbidden({ reason: "csrf" });
    if (error instanceof AuthFnError && error.status === 401) return null;
    throw error;
  }
  if (!session) return null;
  // User sessions carry ["*"]; an API-key session carries only its key's scopes.
  const needed = SAFE_METHODS.has(request.method) ? "files:read" : "files:write";
  if (!hasScopes(session, needed, { registry: scopes })) throw forbidden({ reason: "scope", missingScopes: [needed] });
  return { principalId: session.actorId, tenantId: session.tenantId };
}
```

- Reads (`GET`, `HEAD`) accept a cookie session, a bearer session token or an API key.
- Every other method goes through `authorizeMutation`, which requires the `x-authfn-csrf` header to match the `authfn.csrf` cookie when the request carries a session cookie. A request without a valid credential resolves to no principal, so FileFn answers `401 FILEFN_AUTH_REQUIRED`. A CSRF mismatch answers `403 FILEFN_FORBIDDEN`. Any other error, such as a database failure, is not turned into a 401.
- AuthFn accepts an API key in any `Authorization` header, so the scope check applies to every session. Cookie and bearer user sessions carry the `*` scope and pass. An API-key session passes only with `files:read` (or `files:*`) for reads and `files:write` (or `files:*`) for everything else; a key without the needed scope, including a key created without scopes, gets `403 FILEFN_FORBIDDEN` and never the owner's access. The `@authfn/api-keys` plugin adds the `api_keys` table to AuthFn's schema and lets a signed-in user create keys with `POST /auth/api-keys` and a body such as `{"name":"sync","scopes":["files:read"]}`; scopes outside `scopes` are rejected.
- A user's session or a user-owned API key that passes the scope check acts as the user (`actorId` is the user ID). An unowned service key acts as itself (`actorId` is the key ID). Set up FileFn [policies](../core-concepts/policies) and [grants](../features/grants) for those principals.

## FileFn

```ts
// src/filefn.ts
import { createFileFn, type FileFn, type FileFnConfig, type Processor } from "@filefn/server";
import { createCloudflareFlowFnProvider } from "@filefn/processing/queues/cloudflare";
import { createR2StorageAdapter } from "@superfunctions/storage-r2";
import type { Adapter } from "@superfunctions/db";
import type { AuthFnServer } from "authfn";
import { resolveFileFnPrincipal } from "./auth";
import type { Env } from "./env";

// The processors the container runs (its FILEFN_PROCESSORS). The Worker only enqueues jobs
// for them; the container decides which apply to a file and runs them.
const containerProcessors: Processor[] = ["thumbnail", "pdf-preview", "ocr"].map((name) => ({
  name,
  supportedMimeTypes: ["*/*"],
  async process() {
    throw new Error(`${name} runs in the processing container, not in the Worker`);
  },
}));

function processingFor(env: Env): FileFnConfig["processing"] {
  if (env.FILEFN_PROCESSING === "device") return { enabled: false };
  if (!env.FILEFN_PROCESSING_QUEUE) throw new Error("FILEFN_PROCESSING=remote needs the FILEFN_PROCESSING_QUEUE binding");
  return {
    enabled: true,
    processors: containerProcessors,
    flowFn: createCloudflareFlowFnProvider({ "filefn.processing": env.FILEFN_PROCESSING_QUEUE }),
  };
}

export function createFiles(env: Env, ctx: ExecutionContext, database: Adapter, auth: AuthFnServer): FileFn {
  return createFileFn({
    database,
    storage: createR2StorageAdapter({
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_BUCKET,
      jurisdiction: env.R2_JURISDICTION,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    }),
    basePath: "/files",
    runtime: { defer: (work) => ctx.waitUntil(work) },
    auth: {
      required: true,
      resolveSession: (request) => resolveFileFnPrincipal(auth, request),
    },
    policies: [{ name: "photos", contentTypes: ["image/*"], maxSizeBytes: 25 * 1024 * 1024, visibility: "private" }],
    processing: processingFor(env),
  });
}
```

FileFn is created per request so that `runtime.defer` uses that request's `ctx.waitUntil`; see [Cloudflare Workers](./cloudflare-workers) for the base path, background work and rate-limit rules that come with that.

With `FILEFN_PROCESSING: "remote"`, every completed upload enqueues one `filefn.processing` job. Keep the processor names equal to the container's `FILEFN_PROCESSORS` and its `FILEFN_NAMESPACE` equal to this FileFn's namespace (the table above lists every container variable that must match). With `device`, server processing is off and clients upload thumbnails and converted images with `uploadArtifact` (below).

## Processing container

```ts
// src/processing-container.ts
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

const PORT = 8080;

/** Starts the region's processing container and forwards the queue consumer's requests to it. */
export class ProcessingContainer extends DurableObject<Env> {
  private ready: Promise<void> | undefined;

  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) throw new Error("ProcessingContainer needs a containers entry in wrangler.jsonc");
    if (!container.running) {
      container.start({ enableInternet: true, env: containerEnv(this.env) });
      this.ready = undefined;
    }
    this.ready ??= waitUntilHealthy(container);
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
    return container.getTcpPort(PORT).fetch(request);
  }
}

function containerEnv(env: Env): Record<string, string> {
  if (!env.FILEFN_CONTAINER_TOKEN || !env.CONTAINER_DATABASE_URL) {
    throw new Error("the processing container needs FILEFN_CONTAINER_TOKEN and CONTAINER_DATABASE_URL");
  }
  return {
    FILEFN_R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    FILEFN_R2_BUCKET: env.R2_BUCKET,
    ...(env.R2_JURISDICTION ? { FILEFN_R2_JURISDICTION: env.R2_JURISDICTION } : {}),
    FILEFN_R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    FILEFN_R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
    FILEFN_DATABASE: "./db.mjs",
    DATABASE_URL: env.CONTAINER_DATABASE_URL,
    FILEFN_PROCESSORS: "thumbnail,pdf-preview,ocr",
    FILEFN_PROCESSING_MAX_RETRIES: "3",
    FILEFN_CONTAINER_MAX_CONCURRENT_JOBS: "2",
    FILEFN_CONTAINER_TOKEN: env.FILEFN_CONTAINER_TOKEN,
  };
}

/** Waits up to 30 seconds for the container's `GET /health`. */
async function waitUntilHealthy(container: Container): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await container.getTcpPort(PORT).fetch("http://container/health")).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("the processing container did not become healthy within 30 seconds");
}
```

The Durable Object runs one container instance (`getByName("processing")` in the consumer below) and starts it again after it stops.

## Worker

```ts
// src/worker.ts
import { createAuth } from "./auth";
import { createDatabase } from "./database";
import type { Env } from "./env";
import { createFiles } from "./filefn";

export { ProcessingContainer } from "./processing-container";

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export default {
  async fetch(request, env, ctx) {
    const database = createDatabase(env);
    const auth = createAuth(database);
    const { pathname } = new URL(request.url);
    if (isUnder(pathname, "/auth")) return auth.router.handle(request);
    const response = await createFiles(env, ctx, database, auth).router.handle(request);
    return response ?? new Response("Not found", { status: 404 });
  },

  // Forwards each processing job to the container (see the processing container recipe).
  async queue(batch, env) {
    const token = env.FILEFN_CONTAINER_TOKEN;
    if (!env.FILEFN_PROCESSING_CONTAINER || !token) {
      throw new Error("the queue consumer needs FILEFN_PROCESSING_CONTAINER and FILEFN_CONTAINER_TOKEN");
    }
    const container = env.FILEFN_PROCESSING_CONTAINER.getByName("processing");
    for (const message of batch.messages) {
      let response: Response;
      try {
        response = await container.fetch("http://container/jobs", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
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
  },

  async scheduled(_controller, env, ctx) {
    const database = createDatabase(env);
    await createFiles(env, ctx, database, createAuth(database)).cleanupExpiredSessions();
  },
} satisfies ExportedHandler<Env>;
```

The consumer retries a job whose request failed, after 30 seconds. The container finishes a job it has started even if the request is cut off, so a redelivery can run the same job while the first run is still going. FileFn allows this: artifact rows have IDs derived from the file, version and kind, so overlapping runs record one artifact set (the `@filefn/server` suite runs two deliveries of a job at once), and a delivery after a completed run returns `duplicate`. The cost is repeated processor work, and `processing.completed` can be emitted once per run, so make its listeners idempotent.

AuthFn's router already includes its `/auth` base path. Because both mounts share the app's origin, the browser sends the AuthFn session cookie to `/files` without CORS.

## Browser client

```ts
// src/files-client.ts (browser)
import { createFileFnClient } from "@filefn/client";

function cookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return entry === undefined ? undefined : decodeURIComponent(entry.slice(prefix.length));
}

export const files = createFileFnClient({
  baseUrl: `${location.origin}/files`,
  // Sent with every request, including proxy part uploads, so cookie sessions pass AuthFn's CSRF check.
  getAuthHeaders: (): Record<string, string> => {
    const csrf = cookie("authfn.csrf");
    return csrf ? { "x-authfn-csrf": csrf } : {};
  },
});

const THUMBNAIL_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Uploads a photo and, with FILEFN_PROCESSING=device, the thumbnail the device made. Returns the file ID. */
export async function uploadPhoto(photo: File, thumbnail?: Blob): Promise<string> {
  // Checked before the photo is uploaded: a Blob from canvas.toBlob or fetch can have an empty type.
  if (thumbnail && !THUMBNAIL_TYPES.has(thumbnail.type)) {
    throw new TypeError(`thumbnail type must be one of ${[...THUMBNAIL_TYPES].join(", ")}, not "${thumbnail.type}"`);
  }
  const upload = files.uploadFile({ policy: "photos", file: photo });
  const { fileId, versionId } = await upload.done();
  if (thumbnail) {
    try {
      await files.uploadArtifact({ fileId, versionId, kind: "thumbnail-medium", data: thumbnail, mimeType: thumbnail.type });
    } catch (error) {
      // The photo is stored; viewers fall back to the original until a thumbnail exists.
      console.warn(`thumbnail for ${fileId} not uploaded`, error);
    }
  }
  return fileId;
}
```

A native app or another service can send `Authorization: Bearer <AuthFn session token or API key>` from `getAuthHeaders` instead; bearer requests need no CSRF header.

## What is verified

`npm test --workspace @filefn/docs` typechecks every TypeScript block on this page against the current `@filefn/*`, `authfn`, `@authfn/password`, `@authfn/api-keys`, `@superfunctions/storage-r2` and `@cloudflare/workers-types` declarations, with `src/database.ts` stubbed. It also runs the `src/auth.ts` block with keys created in an in-memory AuthFn database (a key without the needed scope gets 403), and `uploadPhoto` against a stubbed client (an untyped thumbnail uploads nothing). The Worker flow itself (base path, `ctx.waitUntil`, cron cleanup) is exercised in workerd by the `@filefn/server` suite described in [Cloudflare Workers](./cloudflare-workers). Live R2 (including its CORS rule), Queues, Containers and cron on a Cloudflare account are not covered.
