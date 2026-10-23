# Memory queue retention checkpoint

The original SPEC.md performance requirement is under1KB per in-memory job.
The existing benchmark includes retained jobs, metrics and runtime overhead; its
1,000-job workload previously measured roughly1.6–1.8KB per retained job.

Clearing a stored lease now assigns undefined rather than deleting the property.
This avoids V8 dictionary-property storage after completed/failed job snapshots.
Every public adapter snapshot still uses the existing JSON boundary and therefore
omits the cleared lease. Claim ownership checks and stale-token rejection remain
unchanged. A local Node20 diagnostic observed compact properties before/after
assignment and dictionary properties after deletion; no V8-specific API or flag
is used by the library.

Metrics now reuse their private tag snapshot within a series whose canonical key
contains every tag/value. Returned data points still receive independent tag
objects: mutating an input, one returned point or a later read cannot change
another point or retained data. Retention counts, values, timestamps, aggregation
semantics and the benchmark workload are unchanged.

## Measurements

The baseline is the built e847d1454e37e32b984e6dc87ccf915efc243cb2 implementation.
All32 embedded library source-map sources were compared byte-for-byte with that
Git head before copying the baseline into an owned temporary directory. Both
variants use the same installed dependencies; the baseline harness only rewrites
its relative dist import. An initial fixture attempt could not resolve uuid from
the copied location and produced no measurements; its dependency links were
corrected before all recorded runs.

Each fresh Node20.20.0 process runs the unchanged queue-benchmark.mjs with
--expose-gc,1,000jobs,32producers,16handlers, real completion/drain checks and
metrics enabled. Redis/PostgreSQL URLs and CPU profiling are unset. Pair order
alternates baseline/candidate, candidate/baseline, baseline/candidate. Other
coordinated tests/builds were stopped for measurements; this is still a local
development host, not an isolated machine or statistical performance guarantee.

| Pair | Variant | Heap bytes per retained job | Jobs/sec | Enqueue p99 ms |
| --- | --- | ---: | ---: | ---: |
| 1 | baseline | 1828.8 | 24243 | 1.81 |
| 1 | candidate | 1023.9 | 28215 | 1.84 |
| 2 | candidate | 1026.0 | 27362 | 1.75 |
| 2 | baseline | 2010.5 | 25061 | 1.76 |
| 3 | baseline | 1800.3 | 24110 | 1.74 |
| 3 | candidate | 1026.3 | 29071 | 1.78 |

The final measurements reduce retained heap by roughly43–49% in these pairs.
**The original1KB target remains open:** all candidates exceed1,000bytes and
two exceed1,024bytes. No threshold or workload was changed. All measured memory
queue enqueue/dequeue/handler latency targets pass, but this does not establish
sustained load, larger workloads, RSS/startup/idle CPU requirements or repair the
previous Redis/PostgreSQL performance failures.

Raw records (including the earlier lease-only comparison) are in
`memory-retention-measurements-20261023.json`. The lease-only variant reduced
heap to1,063–1,087bytes/job but still missed the target; metric tag reuse further
reduced it. Commands for a built checkout:

```sh
env -u FLOWFN_REDIS_URL -u FLOWFN_POSTGRES_URL -u FLOWFN_BENCHMARK_CPU_PROFILE FLOWFN_BENCHMARK_PRODUCERS=32 FLOWFN_BENCHMARK_JOBS=1000 node --expose-gc flowfn/typescript/scripts/queue-benchmark.mjs
```

## Validation

- ESM/CommonJS/declaration build passes.
- Source and test TypeScript checks pass.
- Full nonprovider suite:169passed,85provider-dependent tests skipped. No native
  provider result is claimed for this change.
- Five lease-transition cases verify public field omission, stale-token rejection
  and data snapshot isolation after completion, acknowledgment, requeue and
  recovery. A metric regression verifies input/sibling/later-read isolation,
  reordered tag keys and preservation of absent versus empty tags.
- The benchmark executes the actual built ESM queue/worker completion path.
- No dependencies, package exports, Python implementations or ignore rules changed.
  Python uses a separate memory representation; no Python memory claim is made.

Local logs: /tmp/flow-memory-final-build.log, /tmp/flow-memory-types.log,
/tmp/flow-memory-test-types.log, /tmp/flow-memory-tests.log,
/tmp/flow-memory-final-compare.log. The owned temporary baseline directory was removed after validation, with
absence read back; all benchmark/test subprocesses exited. This is measurable progress toward the original requirement, not
production-readiness completion.

The subsequent [stored ID reuse checkpoint](stored-id-reuse-readiness.md) preserves
this workload and records three candidate runs below the original 1,000-byte goal,
with direct heap evidence explaining the additional reduction.
