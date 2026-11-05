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

`createSqliteStorage` writes through the `rawSql` executor of a `@superfunctions/db` SQL adapter on SQLite. It is tested with the Drizzle adapter on better-sqlite3. Other SQLite drivers (libSQL, or Kysely as the adapter) are untested. Cloudflare D1 is not supported, because D1 rejects `BEGIN`. The SQLite build must include JSON support.

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

Each write, whether one event or a batch, runs in a transaction the storage begins (`BEGIN IMMEDIATE`) and commits itself. The receipt arrives only after `COMMIT` succeeds. If the insert or the commit fails, the storage rolls back its own transaction and the receipt is `storage_failed`. How durable the commit is depends on the connection's `journal_mode` and `synchronous` settings. With the better-sqlite3 defaults, a commit is synced to disk.

The storage borrows your connection, so it guards your work:

- If the connection is already inside a transaction you started, the write fails with `storage_failed`. The storage never writes into your transaction, because you could still roll it back after the receipt. It also never commits or rolls back your transaction.
- Writes, queries and schema setup from every storage on the same adapter run one at a time, so concurrent ingests never interleave their transactions.
- A statement you run on the same connection while a storage write is open joins the storage's transaction: it commits or rolls back with that write. For example, if the write then fails, your insert is rolled back too, and a `sqlite.transaction()` you start in that window nests as a savepoint inside it. Use a dedicated connection for the storage, or do not run your own statements on its connection while ingestion is in flight.

## Behaviour

### Ingestion

- `ingest(event)` returns `{ ok: true, event, storage, durable }` only after the storage adapter confirmed the write.
- Every failure comes back as an `ok: false` receipt with a `code`. `ingest` and `ingestBatch` never throw, whatever value a getter, hook or storage adapter throws (including values that cannot be converted to a string). A receipt's `message` includes at most 500 characters of the underlying error:
  - `invalid_event`: the event failed validation, with one entry in `issues` per problem (bounded as described below). Nothing was written.
  - `not_started`: the runtime is stopped or stopping.
  - `storage_failed`: the adapter rejected the write. Treat the event as not stored.
  - `ingest_failed`: reading the input threw (for example a getter or a proxy), or a `now` or `generateId` hook threw or returned an invalid value. Nothing was written.
- `ingestBatch(events)` takes 1 to 100 events. It validates every index first, so a hole in a sparse array is an `invalid_event`. Then it writes them in one atomic write, so either every event is stored or none is.
- `durable` is `false` for the memory adapter. Its events disappear with the process, and it keeps at most `maxEvents` events (10 000 by default), dropping the oldest first. A single write larger than `maxEvents` is refused with `storage_failed`, because it would evict part of itself.

An event has these fields:

| Field | Required | Rules |
| --- | --- | --- |
| `type` | yes | Up to 200 characters: letters, digits and `_ . : / -` |
| `timestamp` | no | A valid `Date`, integer epoch milliseconds, or an ISO 8601 date-time with a time zone. Defaults to the ingestion time. |
| `attributes` | no | A flat object with up to 64 entries. Names match `[A-Za-z_][A-Za-z0-9_.:-]*` and are at most 128 characters. Values are strings (at most 1024 characters), finite numbers or booleans. |
| `data` | no | Strict JSON, at most 64 KiB serialized and 32 levels deep. Returned with the event but never filtered on. |

Unknown fields are rejected, and only the event's own fields are read: a field inherited through the prototype chain counts as absent. The `data` size is counted while it is copied, so a payload that shares references is rejected once its serialized size passes 64 KiB, before it is expanded further. Each array and object is copied from one snapshot of its length or keys, so the copy is exactly what was counted. The event is rejected if a getter changes an array's length, an object's key count, or removes a key that has not been read yet. Listing an object's keys takes time linear in the caller's own object but reads no values, so a very wide object is rejected before any value is read. At most 10 unknown fields are named in the issues; the rest are counted. Issues show a caller-supplied field name by its first 40 characters, and a receipt or `WatchError` lists at most 21 issues, each cut in the middle to 300 characters plus an ellipsis: past 21, the first 20 are listed and one more counts the rest. Stored events carry an `id`, an ISO `timestamp` and an ISO `receivedAt`. A storage adapter's `durable` must be a boolean, and both adapters refuse a direct write whose timestamps fall outside 1970-01-01 to 9999-12-31.

### Queries

`query({ from, to, type, attributes, limit, order })` returns `{ events, truncated }`.

- `from` is inclusive and `to` is exclusive.
- `type` is one type or a list of up to 20 types.
- Every attribute filter must match by value and type. For example, `{ status: 503 }` does not match `"503"`. A filter matches when the stored value is the same JavaScript value (`===`), on both adapters: numbers include integers beyond `Number.MAX_SAFE_INTEGER`, and strings include any UTF-16 content, such as lone surrogates, NUL, quotes and backslashes. The SQLite adapter compares the stored JSON text of the value, not SQLite's decoded value.
- `limit` defaults to 100, with a maximum of 1000. `truncated` is `true` when more events matched than the limit allowed.
- `order` defaults to `desc`, so the newest events come first. `asc` returns events with the same timestamp in ingestion order, and `desc` is the exact reverse of `asc`, so its ties come newest-ingested first.

`query` rejects with a `WatchError`. Its `code` is `invalid_query` (with `issues`), `not_started` or `storage_failed`.

### Lifecycle and ownership

- `start()` opens the storage session and then starts the registered collectors in order. It is idempotent. Concurrent calls share one start and its outcome: if it fails, every waiting caller gets the same rejection, and the next call tries again. If a collector fails to start, `start()` rolls back: it stops the collectors it already started, closes the storage session and rejects with `start_failed`.
- `stop()` stops the collectors in reverse order, waits for in-flight writes and queries, and then closes the storage session. It is idempotent. Once stopping begins, new ingestion gets `not_started`. You can call `start()` again later.
- `stop()` releases only what the runtime created: the collector run and the storage session. The SQLite storage never closes the adapter or the connection you passed in. Your own process listeners and timers are untouched. Listeners added with `subscribe()` stay subscribed until you call the returned unsubscribe function.
- `subscribe(listener)` calls the listener with each stored event after its write succeeded. If a listener throws or returns a promise that rejects, the error goes to `onError` (source `listener`), which defaults to `console.warn`. It never affects the receipt, and the runtime does not wait for async listeners. A throw or rejection from `onError` itself is swallowed, so neither causes an unhandled rejection.
- Collectors are only the ones you pass in `collectors` or add with `registerCollector()`, and you can only register them while the runtime is stopped. If an event a collector ingests gets a failed receipt (for example a storage failure), the collector still gets that receipt, and `onError` also receives a `WatchError` with the receipt's `code` (source `collector`, with the collector's name). `processMetricsCollector({ intervalMs, type })` samples memory and CPU usage of the current process. Its interval is from one second up to 2147483647 ms, the largest delay a timer accepts. An invalid interval or event type throws when the collector is created. Its timer is unref'd, so it never keeps the process alive.

### HTTP routes

```ts
import { timingSafeEqual } from "node:crypto";
import { createWatchRouter } from "@watchfn/core/http";

// Fail closed: never serve with a missing or empty secret ("Bearer undefined" must not authorize).
const token = process.env.WATCH_TOKEN;
if (!token) throw new Error("WATCH_TOKEN must be set to a non-empty secret");
const expected = Buffer.from(`Bearer ${token}`);

const router = createWatchRouter(watch, {
  authorize: (request) => {
    const given = Buffer.from(request.headers.get("authorization") ?? "");
    // timingSafeEqual needs equal lengths; the comparison itself takes constant time.
    return given.length === expected.length && timingSafeEqual(given, expected);
  },
  basePath: "/watch",
});
// router.handle(request) takes a Web Request and returns a Response.
```

| Route | Purpose | Responses |
| --- | --- | --- |
| `GET /health` | Runtime health | 200 when started, 503 otherwise |
| `POST /ingest` | Ingest one event, or a JSON array as a batch | 201 with the stored event(s); 400 invalid; 415 not JSON; 413 too large; 500 runtime hook failure; 503 stopped or storage failure |
| `POST /query` | Run a query | 200 with `{ events, truncated }` (persisted events); 400 invalid; 503 stopped or storage failure |

`authorize` is required. If it returns anything other than `true`, or throws, the request gets 401. Responses never include storage or hook error details. Request bodies are limited to 1 MiB by default (`maxBodyBytes`).

## Provenance and versions

Ported from `watchfn/typescript` in `21nCo/super-functions.next` at `523c66ae8cf981ff8331d56386cec1f81c704182`. The port keeps the event runtime, storage, query, HTTP and process-metrics concepts and reimplements them against the contract above. In particular, the `next` query handler always returned an empty result. This version's `/query` returns persisted events.

The package version stays at `0.0.3`, the `next` version, because `@memoryfn/core` in this workspace declares an optional peer on `@watchfn/core@0.0.3`. Version `0.0.3` on the npm registry is the old `next` build with a different API. Before publishing this package, bump its version and update that peer range together.

`@superfunctions/db` is an optional peer at `^0.3.2`, the first version whose SQL adapters expose `rawSql`. You need it only for `@watchfn/core/sqlite`.
