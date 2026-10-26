# FlowFn TypeScript runtime checkpoint — 2026-10-16

This is local runtime evidence, not a production-readiness declaration. Python is
validated separately. No cloud account, publication or deployment was performed.

## Reproducible checks

- Node20.20.0; npm10.8.2; Vitest4.1.12.
- `npm run lint --workspace @flowfn/core`: strict source typecheck passes.
- `npm run build --workspace @flowfn/core`: CJS, ESM and declarations pass.
- `npm run typecheck --workspace @flowfn/admin`: passes.
- `npm run test --workspace @flowfn/core`:108 pass,13 explicitly skipped native
  provider tests,121 total in22 files. Tests include both src and tests directories;
  the imported configuration previously omitted tests outside src.
- `npm run test --workspace @flowfn/admin`:12 pass using real shared dispatcher.
- `node flowfn/typescript/scripts/provider-acceptance.mjs`:13 native tests pass
  against Redis7 and PostgreSQL16 Docker containers. Covers atomic competing queue
  claims, identical IDs in distinct queues, delayed/prioritized jobs, actual
  retry/failure/results, stream history beyond a polling page, consumer groups,
  manual ack/nack/backpressure, leased stale-owner rejection, measured group lag,
  workflow checkpoint recovery, and explicit legacy SQL migration preserving
  backup tables. Containers are loopback bound and removed with absence verified.
- An earlier rerun against a reused host PostgreSQL port failed EADDRNOTAVAIL;
  the fresh-container script subsequently passed twice. This is not hidden as a
  successful run. Both earlier manually started containers were also removed.
- npm11 lock-only regeneration from HEAD plus final manifests reduced npm10
  metadata churn from52k to17,359 diff lines. npm10 scoped ci --dry-run passes.
  Version changes at common lock paths are19 upgrades (rolldown/platform bindings,
  OXC types, postcss and source-map-js), no downgrades. Placement/de-duplication
  remains larger than the product-only dependency delta.

## Implemented boundaries

Workflow waits/approval/sleep/cancellation and reverse-order compensation now
execute real asynchronous control flow. Full checkpoints include replay journals,
consumed wait results, deadlines, inbox and compensation history. Recovery requires
one active owner and the same workflow definition. Interrupted handlers replay at
least once, so external effects need execution-ID-based idempotency.

Queue state/results/progress persist in memory/Redis/PostgreSQL. Workers register
before run, repeated run is idempotent, close waits for handlers. Scheduler failure
retries wait for the next interval; cancelled callbacks cannot change replacement
schedules. Queue events forward documented job:event payloads. Metrics reflect
observed work and registered resources, not hard-coded zero placeholders.

Stream consumer groups enforce acknowledgment ownership and backpressure. Redis
and PostgreSQL retain cursors/pending deliveries and reclaim expired receipts;
late acknowledgments cannot complete reassigned deliveries. Memory groups are
process-local. JobStorage snapshots isolate overlapping queue names and mutable
payloads. Namespaced FlowFn adapter calls use unambiguous encoded tuples.

Admin binds all scope fields including installation/legacy alias and region;
queue reads reflect live results. Dispatcher redacts payloads/results/errors/logs.
Redrive deletes DLQ evidence only after enqueue and snapshot persistence, and
refuses non-failed existing jobs. Components do not share a transaction; a failed
snapshot save can leave both live work and DLQ evidence. Trusted domain-service
calls bypass dispatcher authentication/redaction by design.

## Still open original obligations and production risks

- Queue active-job lease renewal, stalled-worker recovery and fencing are absent;
  Worker settings.stalledInterval/maxStalledCount are still ignored. Queue enqueue
  deduplication is serialized only per instance; competing instances can overwrite
  the same ID. These are production gates for distributed workers.
- Custom backoff currently falls back to fixed delay; named strategy support,
  batch timeout/cache/limiter parity, and timeout/removal edge cases remain.
- Workflow execution ownership/catalog updates have no distributed lease/CAS;
  definitions are not fingerprinted for recovery compatibility.
- Scheduler state is process-local, with no persistent restart or multi-owner
  coordination. Worker pools, auto-scaling, shutdown signal/timeout options absent.
- Config telemetry/onError are not fully wired; original detailed health output
  and OpenTelemetry integration require implementation. Metrics have bounded
  process-local samples, not cross-process aggregation.
- Stream partitions are stored as metadata, not actual partition assignment;
  pattern subscriptions and original advanced stream options need validation.
- D1/SQS/Kafka adapters are absent. SPEC1138–1205 gives supported API examples,
  while SPEC2064–2105 places those providers, worker pools, dashboard and OTel in
  Phase4(Q4 2026). This contradiction is recorded, not silently reclassified.
- Package exports/subpath compatibility, installed CJS/ESM/type consumers, audit,
  original performance targets, coverage and native cloud evidence remain open.
- Admin currently exposes queues/jobs/workers/DLQ/events only and offset pagination;
  nextCursor remains null, with no claim that it denotes a terminal offset page.
- `npm run typecheck:tests --workspace @flowfn/core` now passes across all source
  and tests, including native provider tests. It exposed and fixed missing public
  Stream replay/count declarations, primitive Job update typing/runtime semantics,
  untyped inherited tests and the ignored event-type filter.
