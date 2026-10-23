# Atomic namespace bot-row admission

Original LIMIT-001 and SPEC “Limits/caps” require configurable concurrent bots per
namespace, default 100. SPEC also assigns recording file-size limits to storage;
it does not specify a global operating-system scratch quota. This checkpoint
addresses admission of persisted nonterminal bot rows. It does not establish an
exact count of live provider connections/capture processes: cross-worker join
ownership and durable queue handoff remain separate required lifecycle work.

## Reproduction

On the preceding built source, a cap of one admitted two concurrent check/create
operations. One older active bot hidden behind two newer terminal rows passed the
same check. `listBots` capped results to 100 and the middleware filtered only that
page, excluding `finalizing` as well. Calendar scheduling bypassed the check:
with `RECFN_MAX_CONCURRENT_BOTS=1`, one local poll created two bots. No external
calendar or meeting provider was called for these reproductions.

## Shared transaction authority

The built-in store now performs create and status mutation through a namespace
transaction. Its **first database operation** upserts a guard row with a fresh
nonce, acquiring the namespace write lock before any count snapshot. It then counts
all namespace bots whose status is neither `done` nor `error`, and inserts only
when capacity exists. The indexed database count is independent of API pagination.
Finalizing, leaving, and left bots remain counted. The REST route, calendar
scheduler and direct built-in store creation therefore share one authority.

Status mutations acquire namespace authority before the bot aggregate's deletion
fence. Terminal-to-nonterminal direct updates require capacity; terminalization
and ongoing active transitions permit draining. A failed insert or mutation rolls
back with its transaction. Deletion retains the namespace policy row even after
all bots are gone. The existing deletion/producer fence remains in effect.

`createDbStore({ adapter, maxConcurrentBots })` and
`createMemoryStore({ maxConcurrentBots })` accept a positive safe integer, defaulting
to `RECFN_MAX_CONCURRENT_BOTS` or 100. The environment is sampled once when the
store is constructed; an explicit store option wins. Later environment changes do
not mutate an existing store or persisted namespace policy. Each namespace persists the maximum on its
policy row; processes configured differently fail closed. Quota rejection uses
HTTP 429 / `RATE_LIMIT_EXCEEDED`. The API no longer makes a separate racy precheck.
Production stores must advertise the atomic namespace-admission capability in
addition to durability. Custom callback stores do not gain that capability merely
by providing `createBot` or `listBots`.

Supported built-in integration identities are shared memory, Kysely and Drizzle,
with transaction and upsert capabilities enabled. Source inspection establishes:

- Shared memory already serializes all captured adapter operations and internal
  CRUD through its own queue, including snapshot/rollback transactions. RecFn
  reuses this implementation and adds no per-store mutex.
- Kysely emits native `INSERT ... ON CONFLICT DO UPDATE` for PostgreSQL/SQLite and
  `INSERT ... ON DUPLICATE KEY UPDATE` for MySQL before a read.
- Drizzle emits the corresponding native write for PostgreSQL/MySQL. Its SQLite
  adapter explicitly does not support async transactions and is rejected.

The nonce forces an actual guard-row update. The transaction must hold that write
lock until commit and must not perform an earlier application read snapshot.
Serialization/deadlock/busy failures propagate rather than bypassing admission;
there is no unsafe automatic fallback. Native acceptance here is Kysely with
file-backed SQLite only. Other SQL dialect/provider configurations still require
native acceptance. Integration IDs are trusted host metadata, not authentication
against a caller that deliberately spoofs an entire adapter implementation.

Prisma and unknown adapters fail closed for bot creation/status admission. Their
generic upsert capability does not prove a native first-write operation; some
Prisma/backend combinations may read before updating. Required Prisma/backend
compatibility remains open rather than being inferred from a host opt-in flag.

PostgreSQL follow-up removes the redundant namespace UNIQUE constraint: the
upsert's deterministic ID is the sole uniqueness arbiter. Existing installations
must apply the explicit [constraint migration](postgres-store-readiness.md);
editing schema metadata alone does not remove an installed constraint.

## Required migration and configuration changes

Stop new API/calendar submissions and worker dequeuing, drain or explicitly
reconcile existing operations, then stop every old-code writer before migration.
Old writers do not acquire the new guard and must not overlap new admitted writers. Apply the
new `botAdmission` model from `getRecFnSchema()` with primary/unique `id`, required
`namespace`, numeric `maximum`, and string `nonce`. Existing bot rows and indexes
remain unchanged. Seed each existing namespace with its explicitly chosen policy:
`id` is lowercase SHA-256 of UTF-8 namespace, `maximum` is the configured positive
integer, and `nonce` is a fresh UUID. New namespaces initialize their policy within
the admission transaction. Seeding existing namespaces makes the policy explicit
before any first-operation failure/rollback.

To change a persisted policy, stop all writers, update that namespace's `maximum`
and nonce transactionally, change every producer/worker configuration to match,
and restart. A lower cap can be below current occupancy: new admission and
reactivation reject while terminal transitions drain existing bots. Do not clear
policy rows to bypass a mismatch. The store never silently raises a persisted
limit. Deployment operators retain responsibility for applying schema migration
and validating their actual SQL adapter/isolation configuration.

## Queue and process ownership boundary

Bot creation commits before queue enqueue. A queue may accept a job and then lose
its acknowledgement; its interface cannot prove that an exception means no send.
The bot therefore remains `creating` and continues consuming capacity on enqueue
failure. Retrying a fresh creation at capacity returns 429. No uncertain queued
operation is erased or released automatically. Inspect namespace bot state and
queue/worker evidence; retry the existing bot's job or mark terminal only after
establishing that its original worker/provider operation has stopped. There is no
new idempotency/outbox guarantee in this checkpoint.

The worker's current read/check of `creating` is not an atomic cross-worker claim.
Multiple workers could still race to join the same bot, and database-only direct
aggregate deletion does not prove external provider cleanup. Thus row admission
must not be described as exact running-capture admission. Durable outbox/idempotent
join ownership is the next required slice. Existing ambiguous storage producer
intents, scratch byte limits/cleanup, and adapter encryption-attestation gaps are
preserved. Aggregate physical disk quota is still a deployment concern.

## Validation

On Node 20.20.0, final commands passed:

- `npm run build --workspace=@recfn/server`.
- `npm test --workspace=@recfn/server`: **276 tests, 49 files passed**, including
  eight new admission cases across memory/API/calendar and native SQLite.
- `npm run typecheck --workspace=@recfn/server`.
- `git diff --check`.

The independent-process fixture opens two separate Node/Kysely/SQLite writers,
releases both through a stdin barrier, and holds the first native guard write for
100 ms. Exactly one bot is admitted at cap one; the other receives the quota
error. Captured SQL proves the guard INSERT/ON CONFLICT is the first database
operation in each transaction. Reopen, insert-trigger rollback, policy mismatch,
offline cap increase/decrease and draining also pass. Other cases cover two
stores sharing the real memory adapter, 105 newer terminal rows, finalizing and
reactivation, concurrent HTTP requests, calendar retries, construction-time env
sampling, unsupported adapters, and queue acceptance followed by lost ACK.

The final server suite also reran existing deletion fences, scratch lifecycle,
encoding and upload cleanup cases. Both native writer children exited, their
SQLite connection and owned temporary directory were removed in fixture cleanup,
and process readback found no remaining owned test/encoder processes. Logs are
local receipts `/tmp/rec-admission-{build-final,full,types}.log`.

This changes the TypeScript server store/schema, not core/client wire types or
Python runtime. Inspection of both SDK HTTP clients confirms they preserve the
existing error envelope (including quota code/details) for non-success responses.
No new Python/client runtime claim or separate SDK test rerun is inferred from
server tests. No live provider or deployment was used.
