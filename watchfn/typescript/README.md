# @watchfn/core

A small event runtime for development telemetry. You ingest events explicitly, the runtime writes them to the storage adapter you chose, and you query them back by time range, type and attributes. Nothing starts until you call `start()`. No collector, timer or process handler runs unless you register one.

This is not a monitoring platform. There is no dashboard, APM, RUM, synthetics or alerting.

## Entry points

| Import | Formats | Contents | Runtime dependencies |
| --- | --- | --- | --- |
| `@watchfn/core` | ESM, CommonJS | `createWatch`, `createMemoryStorage`, `WatchError`, validation helpers and types | `node:crypto` only |
| `@watchfn/core/sqlite` | ESM, CommonJS | `createSqliteStorage`, a durable adapter on a `@superfunctions/db` SQLite adapter | none (it uses the adapter you pass in) |
| `@watchfn/core/http` | ESM only | `createWatchRouter`, HTTP routes on `@superfunctions/http` | `@superfunctions/http` (ESM only) |
| `@watchfn/core/collectors` | ESM, CommonJS | `processMetricsCollector`, an opt-in collector | none |

The main entry imports no HTTP framework, database driver or ORM. Framework adapters are not part of this package. To serve the routes from Express, Fastify, Hono, Next.js or SvelteKit, mount the router with the matching `@superfunctions/http-*` adapter.

## Quick start

```ts
import { createMemoryStorage, createWatch } from "@watchfn/core";

const watch = createWatch({ storage: createMemoryStorage() });
await watch.start();

const receipt = await watch.ingest({
  type: "sdk.failure",
  attributes: { operation: "tasks.get", release: "1.2.0", status: 503 },
  data: { message: "upstream unavailable" },
});
if (!receipt.ok) console.error(receipt.error.code, receipt.error.issues);

const { events, truncated } = await watch.query({
  from: "2026-10-01T00:00:00Z",
  attributes: { operation: "tasks.get", release: "1.2.0" },
});

await watch.stop();
```

### Durable SQLite storage

`createSqliteStorage` writes through the `rawSql` executor of a `@superfunctions/db` SQL adapter on SQLite. That can be Drizzle or Kysely on better-sqlite3, libSQL or D1. The SQLite build must include JSON support, which all of these do.

```ts
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import { createWatch } from "@watchfn/core";
import { createSqliteStorage } from "@watchfn/core/sqlite";

const sqlite = new Database("telemetry.db");
const watch = createWatch({
  storage: createSqliteStorage({ adapter: drizzleAdapter({ db: drizzle(sqlite), dialect: "sqlite" }) }),
});
await watch.start(); // creates the watchfn_events table and its indexes if they are missing
```

By default, `open()` runs `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for the `watchfn_events` table. To manage the schema yourself, pass `ensureSchema: false` and apply the statements exported as `SQLITE_SCHEMA`.

Each write, whether one event or a batch, is a single `INSERT` statement, so it commits atomically. The receipt arrives after SQLite reports the commit. How durable the commit is depends on the connection's `journal_mode` and `synchronous` settings. With the better-sqlite3 defaults, a commit is synced to disk.

## Behaviour

### Ingestion

- `ingest(event)` returns `{ ok: true, event, storage, durable }` only after the storage adapter confirmed the write.
- Every failure comes back as an `ok: false` receipt with a `code`. `ingest` never throws:
  - `invalid_event`: the event failed validation, with one entry in `issues` per problem. Nothing was written.
  - `not_started`: the runtime is stopped or stopping.
  - `storage_failed`: the adapter rejected the write. Treat the event as not stored.
- `ingestBatch(events)` takes 1 to 100 events. It validates all of them first and then writes them in one atomic write, so either every event is stored or none is.
- `durable` is `false` for the memory adapter. Its events disappear with the process, and it keeps at most `maxEvents` events (10 000 by default), dropping the oldest first.

An event has these fields:

| Field | Required | Rules |
| --- | --- | --- |
| `type` | yes | Up to 200 characters: letters, digits and `_ . : / -` |
| `timestamp` | no | A valid `Date`, integer epoch milliseconds, or an ISO 8601 date-time with a time zone. Defaults to the ingestion time. |
| `attributes` | no | A flat object with up to 64 entries. Names match `[A-Za-z_][A-Za-z0-9_.:-]*` and are at most 128 characters. Values are strings (at most 1024 characters), finite numbers or booleans. |
| `data` | no | Strict JSON, at most 64 KiB serialized and 32 levels deep. Returned with the event but never filtered on. |

Unknown fields are rejected. Stored events carry an `id`, an ISO `timestamp` and an ISO `receivedAt`.

### Queries

`query({ from, to, type, attributes, limit, order })` returns `{ events, truncated }`.

- `from` is inclusive and `to` is exclusive.
- `type` is one type or a list of up to 20 types.
- Every attribute filter must match by value and type. For example, `{ status: 503 }` does not match `"503"`.
- `limit` defaults to 100, with a maximum of 1000. `truncated` is `true` when more events matched than the limit allowed.
- `order` defaults to `desc`, so the newest events come first. Events with the same timestamp keep their ingestion order.

`query` rejects with a `WatchError`. Its `code` is `invalid_query` (with `issues`), `not_started` or `storage_failed`.

### Lifecycle and ownership

- `start()` opens the storage session and then starts the registered collectors in order. It is idempotent, and concurrent calls share one start. If a collector fails to start, `start()` rolls back: it stops the collectors it already started, closes the storage session and rejects with `start_failed`.
- `stop()` stops the collectors in reverse order, waits for in-flight writes and queries, and then closes the storage session. It is idempotent. Once stopping begins, new ingestion gets `not_started`. You can call `start()` again later.
- `stop()` releases only what the runtime created: the collector run and the storage session. The SQLite storage never closes the adapter or the connection you passed in. Your own process listeners and timers are untouched. Listeners added with `subscribe()` stay subscribed until you call the returned unsubscribe function.
- `subscribe(listener)` calls the listener with each stored event after its write succeeded. If a listener throws, the error goes to `onError`, which defaults to `console.warn`. It never affects the receipt.
- Collectors are only the ones you pass in `collectors` or add with `registerCollector()`, and you can only register them while the runtime is stopped. `processMetricsCollector({ intervalMs })` samples memory and CPU usage of the current process. Its interval is at least one second and its timer is unref'd, so it never keeps the process alive.

### HTTP routes

```ts
import { createWatchRouter } from "@watchfn/core/http";

const router = createWatchRouter(watch, {
  authorize: (request) => request.headers.get("authorization") === `Bearer ${process.env.WATCH_TOKEN}`,
  basePath: "/watch",
});
// router.handle(request) takes a Web Request and returns a Response.
```

| Route | Purpose | Responses |
| --- | --- | --- |
| `GET /health` | Runtime health | 200 when started, 503 otherwise |
| `POST /ingest` | Ingest one event, or a JSON array as a batch | 201 with the stored event(s); 400 invalid; 415 not JSON; 413 too large; 503 stopped or storage failure |
| `POST /query` | Run a query | 200 with `{ events, truncated }` (persisted events); 400 invalid; 503 stopped or storage failure |

`authorize` is required. If it returns anything other than `true`, or throws, the request gets 401. Responses never include storage error details. Request bodies are limited to 1 MiB by default (`maxBodyBytes`).

## Provenance and versions

Ported from `watchfn/typescript` in `21nCo/super-functions.next` at `523c66ae8cf981ff8331d56386cec1f81c704182`. The port keeps the event runtime, storage, query, HTTP and process-metrics concepts and reimplements them against the contract above. In particular, the `next` query handler always returned an empty result. This version's `/query` returns persisted events.

The package version stays at `0.0.3`, the `next` version, because `@memoryfn/core` in this workspace declares an optional peer on `@watchfn/core@0.0.3`. Version `0.0.3` on the npm registry is the old `next` build with a different API. Before publishing this package, bump its version and update that peer range together.

`@superfunctions/db` is an optional peer at `^0.3.2`, the first version whose SQL adapters expose `rawSql`. You need it only for `@watchfn/core/sqlite`.
