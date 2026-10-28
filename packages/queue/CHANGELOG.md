# Changelog

## 0.2.0

Breaking: `QueueAdapter` is now a lease-based, fully async interface, and a durable SQL adapter is added.

- `QueueAdapter<T>` methods are `enqueue(queue, payload, { delayMs?, dedupeKey? })`, `claim(queue, { leaseMs })`, `ack(id)`, `fail(id, { retryAt } | { deadLetter: true, reason })`, `extendLease(id, leaseMs)`, `peek(queue, limit)` and `size(queue)`. All return Promises.
- `ack`, `fail` and `extendLease` accept an optional `{ attempt }` fence (the `attempt` returned by `claim`), so a claimer whose lease expired and was reclaimed cannot act on the new lease.
- New `DatabaseQueueAdapter` stores jobs in a `queue_jobs` table on SQLite (SQLite >= 3.35), Cloudflare D1 and Postgres. Construct it with `{ db }`, a `@superfunctions/db` 0.3.1 `drizzleAdapter` or `kyselyAdapter`, whose new `rawSql` executor runs the statements; or with `{ client }` from `createSqliteQueueClient`, `createD1QueueClient` or `createPostgresQueueClient`. `@superfunctions/db` is an optional peer dependency; the `db` option is typed structurally (`QueueRawSqlSource`), so the published declarations do not import it. `claim` is one atomic `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING` statement (`FOR UPDATE SKIP LOCKED` on Postgres). Migrations ship in `migrations/sqlite` and `migrations/postgres`, and `adapter.migrate()` applies the same DDL.
- `MemoryQueueAdapter` implements the new interface. `maxSize` now counts pending and leased jobs.
- Errors are `QueueError` instances whose `message` and `code` are the error code, for example `FLOWFN_QUEUE_JOB_NOT_LEASED`.
- `FlowFnQueueAdapter` no longer implements `QueueAdapter`, because the FlowFn HTTP API has no leases. It keeps `enqueue(queue, payload)` and `dequeue(queue)`; `dequeueMatching`, `peek` and `size`, which always threw, are removed.

### Migrating from 0.1

| 0.1 | 0.2 |
| --- | --- |
| `await queue.enqueue(name, payload)` | Unchanged; now resolves `{ id, deduplicated }` |
| `const payload = await queue.dequeue(name)` | `const job = await queue.claim(name, { leaseMs })`, use `job.payload`, then `await queue.ack(job.id, { attempt: job.attempt })` |
| Retrying by enqueueing again | `await queue.fail(job.id, { retryAt, attempt: job.attempt })` |
| Dropping a poison message | `await queue.fail(job.id, { deadLetter: true, reason, attempt: job.attempt })` |
| `queue.dequeueMatching(name, matcher)` | Removed; use separate queue names or filter after `claim` and `fail` with an immediate `retryAt` |
| `queue.peek(name)` returning payloads | `await queue.peek(name, limit)` returning `QueueJob` records; use `.map((job) => job.payload)` |
| `queue.size(name)` | `await queue.size(name)` |

A job that is claimed but never acked or failed becomes claimable again when its lease expires, with `attempt` incremented. Callers that do not want redelivery should dead-letter when `attempt` exceeds their limit.

## 0.1.0

- Initial `MemoryQueueAdapter` and `FlowFnQueueAdapter`.
