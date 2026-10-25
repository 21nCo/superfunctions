# Queue claim protocol and bounded performance evidence

2026-10-20. PostgreSQL claims now use one SQL statement instead of a separate
BEGIN, candidate SELECT, lease UPDATE and COMMIT sequence. A materialized
candidate CTE retains `FOR UPDATE SKIP LOCKED` ownership through the update.
The lease clock is evaluated after candidate locking. Queue/name isolation,
dependency completion, priority/LIFO order and unique lease tokens remain intact.
Concurrent claims from two independent pools verify distinct jobs/tokens and
read back each persisted owner.

At this October 20 checkpoint, Redis retained individual EVALSHA commands. After a confirmed NOSCRIPT,
concurrent callers share one SCRIPT LOAD; the native cold-start test observes one
load for 32 callers and verifies all 32 jobs. A real restricted ACL user that
permits EVAL/EVALSHA but denies SCRIPT LOAD uses the original EVAL fallback.
A second confirmed NOSCRIPT after a load/flush race can also use EVAL once.
Transport errors never replay a mutation: the test commits two real writes, then
injects lost replies and confirms both callers reject without another command.

The benchmark can optionally produce an inspector CPU profile via
`FLOWFN_BENCHMARK_CPU_PROFILE=/absolute/path/file.cpuprofile`. The profile session
is disconnected in finally. Profiling adds overhead; timing comparisons below
come from unprofiled runs with the original unchanged workload.

## Local results and original gates

Command: `FLOWFN_BENCHMARK=1 FLOWFN_BENCHMARK_PRODUCERS=32 node flowfn/typescript/scripts/provider-acceptance.mjs`.
Every trial retains 1,000 jobs, 32 concurrent producers, 16 handlers, completion
checks, metrics/memory overhead, and the same thresholds. Node 20.20.0 with local
Docker Redis 7/PostgreSQL 16; this development machine has other activity.

| Adapter and trial | Jobs/sec | Enqueue p99 ms | Dequeue p99 ms | Queue-to-handler p99 ms |
| --- | ---: | ---: | ---: | ---: |
| Redis baseline | 6468 | 9.83 | 4.08 | 85 |
| Redis final 1 | 6325 | 10.34 | 5.51 | 77 |
| Redis final 2 | 6321 | 9.83 | 3.27 | 92 |
| PostgreSQL baseline | 942 | 23.08 | 17.14 | 672 |
| PostgreSQL second pre-claim sample | 1131 | 24.25 | 17.78 | 477 |
| PostgreSQL final 1 | 1479 | 20.51 | 11.98 | 350 |
| PostgreSQL final 2 | 1440 | 21.74 | 16.82 | 341 |

The SQL protocol reduction is concrete; two local timing samples are not a
statistical performance guarantee. Redis has no demonstrated throughput gain;
coalescing reduces repeated cold source transfer. Redis still misses 10,000
jobs/sec and enqueue p99 below 5ms. PostgreSQL exceeds 1,000 jobs/sec in these two
final trials, but still misses enqueue p99 below 5ms, dequeue p99 below 10ms and
queue-to-handler p99 below 100ms. No target was relaxed. Larger workloads,
dependency/dedup-heavy queues, remote latency, sustained load and other providers
remain performance gates.

Exact records: `queue-claim-measurements-20261020.json`. Logs:
`/tmp/flowfn-perf-clock-baseline.log`, `/tmp/flowfn-perf-load-only.log`,
`/tmp/flowfn-perf-atomic-after1.log`, `/tmp/flowfn-perf-atomic-after2.log`.
The opt-in profile is `/tmp/flowfn-queue-before.cpuprofile`; its combined
memory/Redis/PostgreSQL workload is dominated by idle/waiting samples and is not
a Redis-only CPU attribution.

## Correctness validation

- `node flowfn/typescript/scripts/provider-acceptance.mjs`: build and 66 native
  tests pass, `/tmp/flowfn-perf-native-final.log`.
- `npm test -w @flowfn/core`: 157 pass, 66 provider-dependent cases skipped;
  `/tmp/flowfn-perf-source-tests.log`.
- `npm run lint -w @flowfn/core` and `npm run typecheck:tests -w @flowfn/core`:
  pass, `/tmp/flowfn-perf-source-types.log` and `/tmp/flowfn-perf-test-types.log`.

The runner removes and reads back its uniquely named disposable containers.
No unrelated service or shared Redis client option was changed. Functional native
coverage includes skewed clocks, delayed/requeued work, concurrent ownership,
lease loss, deduplication, recovery, FIFO/LIFO, dependencies and process restart.
This is not a blanket readiness or hosted-provider claim.

## October 23: bounded batching and delayed replies

Redis now coalesces already submitted create, claim and write calls separately
per queue/script into a microtask batch of at most 32 requests and 65,536 encoded
argument bytes. An existing oversized single input is sent alone. Each request
keeps its own result, error and claim token; no job is prefetched. Storage TIME is
sampled for each operation. Lua catches each request failure so valid neighboring
requests complete. This does not add rollback: a failing Lua operation can have
already changed storage, as with the previous individual script. Requests sharing
a script execute in submission order within that batch; concurrently submitted
calls across scripts have no new global ordering guarantee.

The EVALSHA/NOSCRIPT/SCRIPT LOAD/ACL fallback protocol is unchanged. An unknown
transport outcome rejects every affected caller without application replay. A
lost claim reply can leave remotely active jobs until normal lease recovery.
Closing an adapter rejects unsent batches; accepted remote operations retain their
ordinary lease ownership. Processor shutdown returns its received claims without
running handlers. No Redis client options, schema or public interfaces changed.
Batch limits bound grouping, not total application concurrency or oversized inputs.

Queue drain wakes when local processing observes an empty queue, retaining an
epoch across statistics reads to avoid losing that notification. It still checks
authoritative storage counts and retains the 20ms fallback for remote progress.
Claim replies received after the conservative monotonic lease deadline are now
marked lost before handler entry. A native held-reply fixture with a 200ms lease
and 250ms hold ran two handler invocations before this fix; after it, only the
recovered claim's fresh token reaches the handler. The drain tests fail on the
original implementation and pass without advancing a polling timer after the fix.

### Unchanged workload, repeated comparison

Command: `FLOWFN_REDIS_URL=<owned loopback Redis> FLOWFN_BENCHMARK_PRODUCERS=32 node --expose-gc flowfn/typescript/scripts/queue-benchmark.mjs`.
Node 20.20.0, Redis 7.4.9, 1,000 jobs, 32 producers, 16 handlers, real completion
and drain checks, existing metrics/memory overhead. The baseline is built from
`f74b006eae8fb442b1a65a52bc6dac20d6ca26e2`; candidate is this source checkpoint.
Each fresh process starts after SCRIPT FLUSH. Pair order is baseline/candidate,
candidate/baseline, baseline/candidate. Other coordinated agent builds and
benchmarks were stopped during these runs; this remains a local development host.
The benchmark and original thresholds are unchanged.

| Pair | Variant | Jobs/sec | Enqueue p99 ms | Dequeue p99 ms | Handler p99 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Baseline | 8154 | 10.96 | 2.84 | 69 |
| 1 | Candidate | 8926 | 6.14 | 1.43 | 64 |
| 2 | Baseline | 8577 | 8.41 | 2.12 | 64 |
| 2 | Candidate | 7578 | 6.47 | 6.61 | 84 |
| 3 | Baseline | 8729 | 6.64 | 1.95 | 62 |
| 3 | Candidate | 9590 | 6.03 | 2.97 | 64 |

**All three candidate runs still fail Redis >=10,000 jobs/sec and enqueue p99
<5ms.** Enqueue latency improves in each pair; throughput has no consistent gain.
All measured dequeue and handler p99 values satisfy their original <10ms/<100ms
gates. Candidate retained-job heap delta is 794.6–797.2 bytes for Redis, but the
memory adapter remains 1609.7–1756.6 bytes; this fixture includes runtime/metrics
overhead and does not establish all system memory, startup or idle CPU targets.
The complete raw records, including memory results and RSS, are in
`queue-batch-measurements-20261023.json`. Larger/sustained/dependency-heavy workloads,
remote providers and the earlier PostgreSQL latency failures remain open.

Adapter-local pipeline and first-use EVAL experiments were discarded because
repeated results did not establish a useful improvement. Only bounded operation
batching and the tested drain/lease fixes are retained; no threshold was relaxed.

### Validation and boundaries

- `node flowfn/typescript/scripts/provider-acceptance.mjs --redis-only`: current
  ESM/CJS/declaration build and **45 native Redis tests pass**. This new option
  creates only owned Redis and explicitly removes inherited PostgreSQL URL input.
- `npm run lint -w @flowfn/core` and `npm run typecheck:tests -w @flowfn/core`: pass.
- `env -u FLOWFN_REDIS_URL -u FLOWFN_POSTGRES_URL npm test -w @flowfn/core`:
  **159 pass, 75 provider-dependent cases skipped**. Redis's 45 were separately
  executed above; the 30 PostgreSQL cases were not rerun in this slice.
- Native coverage includes byte/count bounds, FIFO, unique persisted tokens,
  dedup/idempotence, independent input failures, completion fencing, lost committed
  claim replies and recovery, delayed reply expiry, pending processor shutdown,
  unsent adapter close, storage clock skew and the previous queue/stream/workflow
  contracts. No test asserts exactly-once delivery after an unknown remote outcome.
- Before/after regression logs: `/tmp/flow-redis-oct23-expired-claim-before.log`,
  `/tmp/flow-redis-oct23-drain-before.log`, `/tmp/flow-redis-oct23-regressions-after.log`.
  Full logs: `/tmp/flow-redis-oct23-final-native.log`, `-source.log`, `-types.log`,
  `-test-types.log` with the same prefix.
- Python Redis queue source uses its own per-job/index protocol and is unchanged;
  this TypeScript optimization is not Python parity or Python performance evidence.
- No dependencies, lockfiles, shared client options, providers or deployments changed.
  This checkpoint does not establish the original full readiness requirement.
- Cleanup: the native runner removed its owned Redis container with deletion
  readback. The separately owned benchmark container
  `flowfn-perf-oct23-2737381e-84d3-45a0-bb2d-6d60261c3c15` reported `DBSIZE=0`,
  was removed, and an exact-name `docker ps -a` readback returned no container.
  All benchmark/test subprocesses exited; no owned service remains running.
