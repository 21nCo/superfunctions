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

Lease loss aborts the handler signal; handlers should observe it. External side
effects still require idempotency: fencing protects queue persistence, not an
external API. Handlers that ignore cancellation may continue running, and close
waits for them. Delivery remains at least once.

Custom adapters must implement atomic creation, leased dequeue, renewal,
recovery and fenced mutations to support queue processing. Existing custom
adapters fail explicitly rather than silently losing these guarantees.

Redis enqueue deduplication currently scans retained jobs atomically and
PostgreSQL serializes creation within a queue using a transaction advisory lock.
These prioritize correctness; throughput and large-retention benchmarks remain
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
