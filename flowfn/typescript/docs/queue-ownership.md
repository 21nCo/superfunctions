# Durable queue ownership

Built-in memory, Redis and PostgreSQL adapters implement atomic `createJob`.
`Queue.add` uses this operation, so competing queue instances cannot replace an
existing job ID or enqueue multiple active jobs with one deduplication key.
Payload deduplication compares serialized name/data; object property ordering is
significant. Explicit keys have a separate namespace. Terminal jobs release
keys, while explicit IDs remain reserved until the retained job is removed.

Claims receive a unique token and expiry. Processing queues renew the lease at
one third of its duration, including while collecting a batch. Queue options
`leaseDuration` (default 30 seconds), `stalledInterval` (default 30 seconds) and
`maxStalledCount` (default one recovery) control ownership. Worker `settings`
accept the same options. Configure before processing starts.

Redis uses its server clock and PostgreSQL its database clock for lease validity.
Expired claims are recovered atomically. Repeated stalls become failed jobs and
follow configured dead-letter and failed-retention handling. Workers emit
`stalled`; stale owners cannot save progress/results, complete, acknowledge,
negatively acknowledge or re-enqueue a claimed job. Renewals do not overwrite
concurrent progress updates. Terminal persistence clears the lease.

Transient renewal transport failures retry within the last confirmed lease
deadline. A monotonic local deadline aborts processing even if a renewal request
never settles; an explicit server rejection aborts immediately.
Lease loss aborts the handler signal; handlers should observe it. External side
effects still require idempotency: fencing protects queue persistence, not an
external API. Handlers that ignore cancellation may continue running, and close
waits for them. Delivery remains at least once.

Custom adapters must implement atomic creation, leased dequeue, renewal,
recovery and fenced mutations to support queue processing. Existing custom
adapters fail explicitly rather than silently losing these guarantees.

Redis enqueue deduplication currently scans retained jobs atomically and
PostgreSQL serializes keyed creation within a queue using a transaction advisory
lock; ordinary IDs use an atomic insert with the primary-key constraint.
Redis claims use a durable ready index with sequence ordering, bounded scans,
and automatic index reconstruction for existing queues. Producer calls can run
concurrently, and close waits for pending enqueue operations. These prioritize correctness; throughput and large-retention benchmarks remain
required before claiming performance targets. Scheduler/workflow ownership and
stream partition assignment are separate outstanding contracts.

## Performance requirements still to verify

The original specification requires queue enqueue p 99 below 5ms, dequeue p 99
below 10ms, Redis 10,000+ jobs/sec, PostgreSQL 1,000+ jobs/sec and queue-to-processing
latency below 100ms. Stream requirements are publish p 99 below 5ms, consume p 99
below 10ms, Kafka 100,000+ messages/sec, Redis 10,000+ messages/sec and lag p 99 below 1s.
Workflow targets are below 50ms overhead/step, persistence below 20ms, scheduling
below 100ms and 1,000+ concurrent workflows. System targets remain below 100MB base
memory, below 1KB/job, below 5% idle CPU, startup below 1s and shutdown below 30s.

None of these thresholds is established by functional acceptance. The native
runner allows 30-second test/hook deadlines to accommodate local container startup
and functional fixtures; that allowance does not relax product latency targets.


Run local functional provider checks with
`node flowfn/typescript/scripts/provider-acceptance.mjs`. Run a standalone queue
measurement with `FLOWFN_BENCHMARK=1 FLOWFN_BENCHMARK_PRODUCERS=32` prefixed to
that command. The runner creates disposable loopback-only Redis/PostgreSQL
containers and verifies their removal. Measurements include throughput, enqueue
and dequeue p99, queue-to-handler p99 and GC-controlled heap deltas. Heap deltas
include runtime and metrics overhead, so they are not isolated job allocations.
These local trials currently miss the original durable-provider throughput
requirements. Keep the thresholds above as release gates.

Redis operations use EVALSHA with per-adapter hashes of fixed Lua scripts. A
NOSCRIPT reply coalesces concurrent SCRIPT LOAD requests for the same script,
then retries EVALSHA. Existing ACLs that deny SCRIPT LOAD with NOPERM retain the
EVAL fallback; a second confirmed NOSCRIPT after a concurrent script flush also
falls back to EVAL once. Other errors propagate without mutation replay because a
transport failure may follow a committed mutation. This reduces repeated source transmission but does not
establish the original throughput/latency targets.

## Delays and storage clocks

Redis and PostgreSQL measure new job delays and re-enqueue delays from the storage
clock at the atomic write, and compare due times against that clock when claiming.
`timestamp` and `processedOn` use the same storage authority. A producer or worker
whose wall clock is fast or slow cannot advance a newly scheduled delay or make
it wait for that client's time. Redis samples TIME inside its existing Lua script;
PostgreSQL samples clock_timestamp inside its existing insert/claim statements.
No extra clock request is added. Claim lease tokens and expiration fencing remain
unchanged.

Existing Redis job JSON/delayed scores and PostgreSQL columns retain their layout
and existing absolute due times. Jobs admitted by an older client with an already
skewed due time are not silently rescheduled: explicitly re-enqueue them to start
a new relative delay. This change does not make every timestamp in the library
storage-authoritative; completion/retention and client telemetry are separate
contracts. Native functional tests use both one-hour producer skews, fast and
slow workers, deduplicated creation, and leased retries. They do not establish
throughput targets or resilience to jumps in the storage server's own clock.


PostgreSQL queue claims now use one atomic SQL statement: a candidate CTE acquires
`FOR UPDATE SKIP LOCKED`, then an update persists the active state and unique lease
before returning the job. The lease timestamp is sampled after candidate locking.
Priority, LIFO, dependencies, queue scoping and storage-clock delay checks remain
in that statement. This removes the separate BEGIN/SELECT/UPDATE/COMMIT request
sequence. Native contention tests use independent pools and verify one persisted
lease per claimed job.

For opt-in CPU profiling of the unchanged benchmark, set
`FLOWFN_BENCHMARK_CPU_PROFILE=/absolute/path/queue.cpuprofile` alongside
`FLOWFN_BENCHMARK=1 FLOWFN_BENCHMARK_PRODUCERS=32`. Profiling has overhead; compare
unprofiled results when assessing thresholds. Local repeated measurements after
the atomic claim exceeded PostgreSQL's 1,000 jobs/sec throughput target, but its
latency targets and Redis's 10,000 jobs/sec/enqueue latency targets remain unmet.
See `flowfn/.conduct/queue-claim-performance-readiness.md` for bounded evidence.


Redis create, claim and write calls submitted together are coalesced separately
per queue/script at the next microtask, up to 32 requests / 64 KiB of encoded
arguments. Oversized single inputs retain compatibility by running alone. This is
not prefetch: claims correspond only to submitted calls, with individual tokens,
results and errors. Each operation samples storage TIME. Lua request errors do not
roll back earlier writes or discard successful neighbors. Unknown transport
outcomes reject the affected callers without replay; claims may remain active
until lease recovery. Await operations when cross-operation order is required.

Queue drain now observes local idle notifications while retaining authoritative
stats checks and a 20ms fallback for remote progress. A claim reply that arrives
after its conservative monotonic lease deadline cannot start a handler. Native
fixtures exercise expired replies, lost batch replies, shutdown and recovery.
October 23 paired measurements improve enqueue latency but still fail Redis's
original throughput and enqueue p99 gates; full records and unchanged limits are
in `flowfn/.conduct/queue-claim-performance-readiness.md`. To run only native Redis
contracts locally, use `node flowfn/typescript/scripts/provider-acceptance.mjs --redis-only`.


The TypeScript memory queue orders equal-priority jobs by insertion, not wall-clock
timestamps: LIFO jobs precede FIFO jobs; LIFO selects the newest insertion and FIFO
selects the oldest. Explicit enqueue/retry creates a new insertion position, while
saving progress or renewing a lease preserves it. Delays still use the adapter clock.
This matches Redis mixed FIFO/LIFO grouping. PostgreSQL uses a durable SQL bigint
`enqueue_order` for the same semantics; it never converts that value to a JavaScript
number. Independent producers receive sequence allocation order, with gaps allowed;
this is not a claim of commit-order serialization. Only committed, eligible rows can
be claimed. Priority still wins before mode and insertion order, and delayed/dependency
eligibility is unchanged. Duplicate create and save/renew preserve a job's position;
explicit enqueue/retry allocates a new position. No Python LIFO option is added.

#### PostgreSQL ordering schema upgrade

Fresh `initialize()` creates the ordering column and owned sequence. Existing tables
without `enqueue_order` fail initialization; startup never guesses an upgrade. Stop
**all** producers, queue workers, schedulers and subscribers using this schema, including
old binaries, then call `await adapter.migrateQueueOrderingSchema()` and initialize the
new version before restarting. The existing `migrateLegacySchema()` entry point also
upgrades the intermediate schema; original v0 tables retain their backup behavior.

The migration takes a schema-specific advisory lock and an exclusive jobs-table lock.
Column population, sequence state, default, ownership and uniqueness are transactional;
concurrent migration calls are idempotent. Existing job JSON, states and leases remain
unchanged. Historical jobs receive deterministic timestamp/queue/ID ordering (text IDs
use PostgreSQL C collation). Their original equal-timestamp insertion order was never
stored and cannot be reconstructed. Future enqueues use the new database sequence.
This upgrade can scan and lock the whole jobs table; schedule a maintenance window for
its size. Quiescing old writers is an operator prerequisite, not a distributed fence:
old enqueue-upsert code does not refresh the new ordering column on an existing job.
Do not run mixed old/new writers or drop the column to roll back while new writers run.
