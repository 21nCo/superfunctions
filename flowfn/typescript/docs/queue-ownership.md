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
NOSCRIPT reply falls back to EVAL, recovering after script flush/restart. Other
errors propagate without source replay because a transport failure may follow a
committed mutation. This reduces repeated source transmission but does not
establish the original throughput/latency targets.
