# Queue claim protocol and bounded performance evidence

2026-10-20. PostgreSQL claims now use one SQL statement instead of a separate
BEGIN, candidate SELECT, lease UPDATE and COMMIT sequence. A materialized
candidate CTE retains `FOR UPDATE SKIP LOCKED` ownership through the update.
The lease clock is evaluated after candidate locking. Queue/name isolation,
dependency completion, priority/LIFO order and unique lease tokens remain intact.
Concurrent claims from two independent pools verify distinct jobs/tokens and
read back each persisted owner.

Redis retains immediate individual EVALSHA commands. After a confirmed NOSCRIPT,
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
