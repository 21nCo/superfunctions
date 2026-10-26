# @superfunctions/queue

Lease-based job queues for Superfunctions libraries. `MemoryQueueAdapter` keeps jobs in process; `DatabaseQueueAdapter` stores them in a SQL table so they survive restarts on SQLite, Cloudflare D1 and Postgres. Callers drive `claim`; there is no worker loop or scheduler.

```ts
interface QueueAdapter<T> {
  enqueue(queue: string, payload: T, options?: { delayMs?: number; dedupeKey?: string }): Promise<{ id: string; deduplicated: boolean }>;
  claim(queue: string, options: { leaseMs: number }): Promise<{ id: string; payload: T; attempt: number } | null>;
  ack(id: string, fence?: { attempt?: number }): Promise<void>;
  fail(id: string, options: { retryAt: Date | number; reason?: string; attempt?: number } | { deadLetter: true; reason: string; attempt?: number }): Promise<void>;
  extendLease(id: string, leaseMs: number, fence?: { attempt?: number }): Promise<void>;
  peek(queue: string, limit: number): Promise<QueueJob<T>[]>;
  size(queue: string): Promise<number>;
}
```

## Semantics

- A job is held by at most one claimer at a time. `claim` leases the oldest available job (by `availableAt`, then `id`) for `leaseMs` and returns it with `attempt` incremented, starting at 1.
- If the lease expires before `ack` or `fail`, the job can be claimed again with the next `attempt`. Use `extendLease` for long work.
- Pass `{ attempt: job.attempt }` to `ack`, `fail` and `extendLease`. Without it, a claimer whose lease expired and was reclaimed could act on the new claimer's lease. All three reject with `FLOWFN_QUEUE_JOB_NOT_LEASED` when the job is not leased (or the fence does not match).
- `ack` removes the job. `fail` with `retryAt` makes it pending again at that time; `fail` with `deadLetter` keeps it in the `dead` state (database adapter only) and it is never claimed again.
- `dedupeKey`: while a job with the same key is pending or leased in the same queue, `enqueue` is a no-op that returns the existing id with `deduplicated: true`. Acked or dead-lettered jobs release the key.
- `peek` and `size` cover pending and leased jobs.
- `delayMs` and `leaseMs` are integer milliseconds up to 100 years; invalid input rejects with a `QueueError` code such as `FLOWFN_QUEUE_LEASE_INVALID` before storage is touched.
- Delivery is at least once: a claimer can crash after its side effects and before `ack`. Make handlers idempotent.

## Durable adapter

```ts
import Database from 'better-sqlite3';
import { DatabaseQueueAdapter, createSqliteQueueClient } from '@superfunctions/queue';

const db = new Database('app.db');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

const queue = new DatabaseQueueAdapter<{ url: string }>({ client: createSqliteQueueClient(db) });
await queue.migrate();

await queue.enqueue('fetch', { url: 'https://example.com' }, { dedupeKey: 'https://example.com' });

const job = await queue.claim('fetch', { leaseMs: 30_000 });
if (job) {
  try {
    await handle(job.payload);
    await queue.ack(job.id, { attempt: job.attempt });
  } catch (error) {
    await queue.fail(job.id, job.attempt >= 5
      ? { deadLetter: true, reason: String(error), attempt: job.attempt }
      : { retryAt: Date.now() + 2 ** job.attempt * 1_000, reason: String(error), attempt: job.attempt });
  }
}
```

Clients:

- `createSqliteQueueClient(db)` for a better-sqlite3 database (SQLite >= 3.35 for `RETURNING`). Use WAL and a `busy_timeout` when several processes share the file.
- `createD1QueueClient(env.DB)` for a Cloudflare D1 binding.
- `createPostgresQueueClient(pool)` for a node-postgres `Pool` or `Client`, or anything with `query(text, values) => { rows }`, such as PGlite.

Any other driver can implement `QueueSqlClient` (`dialect` plus `query(sql, params)` returning rows).

`claim` is one statement, `UPDATE … WHERE id = (SELECT … ORDER BY available_at, id LIMIT 1) RETURNING …`. On Postgres the subquery uses `FOR UPDATE SKIP LOCKED`, so concurrent claimers take different rows without waiting; SQLite and D1 run the statement under their single writer lock.

Lease times come from the adapter's `now` option (default `Date.now`), not the database clock. Processes sharing a table need synchronized clocks, with leases much longer than any skew.

### Migrations

The `queue_jobs` table (`id`, `queue`, `payload` JSON, `state`, `attempt`, `available_at`, `lease_until`, `dedupe_key`, `last_error`, `created_at`, `updated_at`; times in epoch milliseconds) is created by:

- `await queue.migrate()`, which runs idempotent `CREATE … IF NOT EXISTS` statements. Run it once at deploy time, not from many processes at once.
- The shipped files `@superfunctions/queue/migrations/sqlite/0001_queue_jobs.sql` (SQLite and D1, for example with `wrangler d1 migrations`) and `@superfunctions/queue/migrations/postgres/0001_queue_jobs.sql`.
- `queueJobsMigrationSql(dialect, tableName)` for a custom table name, which must match the adapter's `tableName` option.

Dead-lettered rows stay in the table with `state = 'dead'` and `last_error`; delete them when they are no longer needed.

## Memory adapter

`new MemoryQueueAdapter({ maxSize?, now? })` has the same semantics in one process. Jobs are lost on restart, payloads are kept by reference, and dead-lettered jobs are discarded. `maxSize` caps pending and leased jobs per queue (`FLOWFN_QUEUE_FULL`).

## FlowFn client

`FlowFnQueueAdapter` calls a hosted FlowFn queue over HTTP with `enqueue(queue, payload)` and a destructive `dequeue(queue)`. The FlowFn API has no leases, so it does not implement `QueueAdapter`.

## Tests

`npm test` runs the shared contract against memory, a better-sqlite3 file, D1 under workerd (Miniflare) and Postgres via PGlite, plus 8 claimer threads against 500 jobs on SQLite. Set `SUPERFUNCTIONS_QUEUE_POSTGRES_URL` to also run the contract, an 8-connection concurrency test and concurrent dedupe against a Postgres server; each test uses its own table and drops it.
