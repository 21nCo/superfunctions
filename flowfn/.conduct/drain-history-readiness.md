# Queue drain avoids redundant retained-history reads

The original queue throughput and latency gates remain open. CPU attribution of
an unchanged 10,000-job queue run found repeated Redis `getAllJobs` JSON parsing
from drain statistics among the dominant JavaScript costs. A trial of server-side
Lua aggregation made the repeated full scan worse and was discarded; no Redis
schema or script change remains.

`QueueImpl.drain` now waits while local handlers are in flight: their presence
already proves the queue is not drained. It checks worker errors and invalid
closed/paused/no-worker states as before. Once local work settles, authoritative
storage counts are still required before returning, including remote-owned jobs.
Idle notifications avoid the polling delay; the existing notification epoch still
protects reads that were already pending when a worker completed. The timer
fallback remains for remote progress. No metrics, retained records, payloads,
leases or benchmark thresholds were removed.

## Performance evidence

The baseline is built d2e42101f64aa199c9d9960f7b004938fefdd9b5, captured before
source modification. All32 embedded source-map files match exact Git objects at
that head. Its dist, package metadata and identical benchmark script
ran in an owned temporary directory using the same resolved installed dependency
paths as the candidate. Node20.20.0; loopback Docker Redis7; GC enabled;32 producers,
16 handlers, metrics enabled, retained completed jobs. Three alternating pairs
ran at each size, with SCRIPT FLUSH before each fresh process. Other coordinated
heavy builds/tests were held during comparisons. This remains a development host,
not a hosted service guarantee. Full raw records and script hash are committed in
`drain-history-measurements-20261023.json`.

| Jobs | Pair | Baseline jobs/s | Candidate jobs/s | Baseline dequeue p99 ms | Candidate dequeue p99 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 1,000 | 1 | 7,459 | 9,451 | 5.40 | 1.23 |
| 1,000 | 2 | 6,658 | 9,347 | 5.10 | 3.13 |
| 1,000 | 3 | 8,835 | 10,142 | 1.48 | 1.12 |
| 10,000 | 1 | 7,042 | 8,515 | 18.93 | 1.51 |
| 10,000 | 2 | 6,667 | 7,734 | 19.04 | 2.30 |
| 10,000 | 3 | 6,296 | 8,265 | 19.66 | 2.01 |

Every pair improves throughput/dequeue latency, but only one original1,000-job
candidate trial exceeds10,000jobs/s, and all its enqueue p99 values remain above
5ms (6.19–6.36ms). At10,000jobs dequeue p99 now passes10ms, but throughput remains
below10,000jobs/s and queue-to-handler p99 is851–979ms, above100ms. Larger-run
memory-adapter handler p99 also remains above100ms. No PostgreSQL or Python
performance improvement is inferred. External provider/load/full readiness gates
remain unmet.

The temporary baseline initially failed before measurement because its dependency
lookup lacked the package-local UUID placement; a dependency overlay linked the
actual package-local and root resolutions before all reported comparisons. That
failed fixture used Node22; all reported comparisons explicitly use Node20.20.
The failed fixture's container was removed with readback. No dependency manifest
or lockfile change is included.

## Correctness validation

- A new regression holds a local handler through three poll periods and verifies
  no retained-history request occurs. After local completion, drain still waits
  for an independently claimed remote job and returns only after its acknowledgment.
  It fails on the previous source and passes on the candidate.
- The existing stale-statistics notification test now starts its held waiting
  snapshot before the claim enters the handler, preserving the original race
  while exercising the new local-work optimization. Prompt idle notification,
  retries and lifecycle cases remain intact:9 focused tests pass.
- Source/test typechecks, ESM/CommonJS/declaration builds and170 source tests pass;
  85 provider-dependent cases are separately skipped in that source run.

Logs: `/tmp/flow-drain-{baseline-regression,focused,types,test-types,source}.log`,
`/tmp/flow-drain-candidate-build.log`, `/tmp/flow-stats-compare.log`.
Profiling is attribution only, never timing acceptance. Unchanged rejected
aggregation measurements are retained locally in
`/tmp/flow-stats-rejected-comparisons.json`.

- Native `node flowfn/typescript/scripts/provider-acceptance.mjs`:85 Redis and
  PostgreSQL cases pass after the final candidate build. Log:
  `/tmp/flow-drain-native.log`. The runner removed both uniquely named containers
  and verified their absence. These are correctness tests, not a PostgreSQL
  performance rerun.
- Comparison container `flow-stats-dd1f8234-11eb-4216-8c60-d4e32e6279a9`
  reported DBSIZE0, was removed, and exact-name readback was empty. The owned
  baseline directory and temporary comparison helper were removed with absence
  verified. No owned provider/test process remains.

No public API, adapter storage protocol, dependency, export, Python source or
ignore-rule change. No release, deployment or base merge.
