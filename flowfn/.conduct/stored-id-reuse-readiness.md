# Reuse private stored job IDs

The c3a3e16203bd2c0489cc6656840aeb7ec48cd548 memory checkpoint still had
retained-memory measurements near or above the original under-1KB/job target.
A synthetic V8 heap snapshot identified duplicate immutable UUID strings: each
Map key retained its original string while `saveJob` replaced the corresponding
job with a JSON snapshot containing a new equal string.

`MemoryAdapter.saveJob` now captures the existing record once, validates its
lease, and reuses its private ID in the new snapshot. It also reads the authoritative
lease from that same captured record. All other job fields remain independently
snapshotted; public APIs still return detached JSON snapshots. No metrics, job
fields, completed records, handler results, or isolation checks were removed.

## Heap evidence

The unchanged 1,000-job memory workload was inspected in owned Node 20.20.0
processes after the benchmark's GC-controlled measurement. Before the change,
all 1,000 Map key/stored-ID pairs were distinct equal strings, occupying 112,000
bytes together. Afterward all pairs referenced the same respective strings,
occupying 56,000 bytes. Each snapshot retained all 1,000 jobs. Job objects 144 KB,
options 56 KB, data 32 KB, logs 32 KB and timestamp numbers 48 KB were unchanged.
These are unique shallow object sizes from the selected heap graph, not a
substitute for whole-process retained heap measurement. The large snapshots were
removed after extracting the committed summary.

## Unchanged benchmark comparison

An owned temporary baseline was extracted from exact c3a3; all 98 tracked package
files were byte-compared with Git objects before building. Baseline and candidate
used the same installed dependencies, Node 20.20.0 and unchanged benchmark script.
The benchmark SHA-256 and all raw result fields are retained in
[measurements](stored-id-reuse-measurements-20261023.json).

Each of three alternating baseline/candidate pairs retained 1,000 jobs with 32
producers and 16 handlers, awaited completion, forced GC, and kept all metrics.
No workload or threshold changed.

| Pair | Baseline bytes/job | Candidate bytes/job |
| --- | ---: | ---: |
| 1 | 1021.056 | 943.640 |
| 2 | 993.232 | 966.904 |
| 3 | 1005.920 | 922.064 |

All three candidate results satisfy the original strict under 1,000-byte goal for
this local workload. All six runs passed the unchanged enqueue/dequeue/handler
latency gates. Baseline variation includes one result below 1,000, so the conclusion
is the consistent candidate reduction plus direct duplicate-allocation evidence,
not a claim that every baseline run must fail. Arbitrary payload sizes, provider
adapters and production hosts are not certified by this local measurement.

Commands, executed serially with Node 20 on PATH:

- Baseline and candidate: `npm run build` from their respective TypeScript package
  directories (ESM/CommonJS/declarations).
- Candidate: `npm run lint`, `npm run typecheck:tests`, `npm test`.
  Both typechecks passed; 169 tests passed and 85 provider-dependent cases skipped.
  Existing lease-transition, stale-token and snapshot mutation tests remained intact.
- Each pair: `FLOWFN_BENCHMARK_JOBS=1000 FLOWFN_BENCHMARK_PRODUCERS=32
  node --expose-gc flowfn/typescript/scripts/queue-benchmark.mjs`.

Logs: `/tmp/flow-id-{baseline-build,candidate-build,source-types,test-types,tests}.log`
and `/tmp/flow-id-pair-{1,2,3}-{baseline,candidate}.log`.
No native provider, Python memory, package-release or deployment result is claimed.
