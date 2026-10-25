# Queue performance diagnosis, 25 October 2026

The unchanged c779dbd2561208a254e6fa57c5c545b8fcc10652 TypeScript queue benchmark still fails the PostgreSQL enqueue p99 target at the original default 1,000-job workload. A bounded ordinary-create batching candidate was rejected after paired measurements; it is not included in source.

## Contract and environment

SPEC.md requires enqueue p99 <5 ms, dequeue p99 <10 ms, Redis >=10,000 jobs/s, PostgreSQL >=1,000 jobs/s, and queue-to-processing <100 ms. The specification does not identify a job count. The existing benchmark defaults to 1,000 jobs; the retained 10,000-job case is additional stress evidence, not a replacement threshold. Both workloads retain 32 producers, 16 handlers, metrics, completed jobs, and the default PostgreSQL pool size. Python, stream, workflow, and deployed-provider performance are not established by this receipt.

The Docker daemon returned HTTP500 before a successful container-create receipt. A bounded subsequent exact-name inspection timed out; absence of `flow-profile-redis-5b171965-c416-42c7-9d99-8bf7849b872f` remains unverified. No daemon restart or host setting change was attempted. Instead the runs used disposable foreground native Redis8.10.2 and PostgreSQL16.13 on loopback random ports, private temporary data/socket directories, and an isolated UTF8 PostgreSQL cluster. These differ from previous Docker service versions and execution topology: absolute improvements over earlier Docker measurements cannot be attributed to product changes.

Each JSON record reports its actual Node version (v22.22.1 in the paired runs). Native binaries are `/opt/homebrew/bin/redis-server` and `/opt/homebrew/opt/postgresql@16/bin/postgres`. The unchanged runner is `flowfn/typescript/scripts/queue-benchmark.mjs`, executed with `node --expose-gc`, `FLOWFN_BENCHMARK_JOBS=1000` or `10000`, and `FLOWFN_BENCHMARK_PRODUCERS=32`, with disposable service URLs. Redis scripts were flushed before each fresh benchmark process. All individual benchmark namespaces were removed by the runner; service processes were terminated and their private data directories removed in the supervisor's finally block.

## Exact baseline

The isolated c779 baseline copied built distribution files and the unchanged benchmark. All33 unique embedded sources across four source maps were byte-compared against c779 Git objects before use. Dependency links used the same installed graph as the candidate. Three unprofiled runs per workload are retained in `native-queue-baseline-20261025.json` without excluding outliers.

At1,000 jobs Redis passed the four queue latency/throughput targets in all three runs: 16,327–17,417 jobs/s, enqueue4.24–4.53 ms, dequeue0.63–0.66 ms, and handler34–36 ms. PostgreSQL achieved7,642–7,744 jobs/s, dequeue3.34–4.03 ms and handler54–56 ms, but enqueue8.21–8.55 ms failed all three times. This is workload-specific evidence, not universal satisfaction of the latency contract.

At10,000 jobs provider throughput and enqueue/dequeue targets passed these initial baseline runs, but queue-to-handler p99 remained353–375 ms for Redis and494–538 ms for PostgreSQL. Handler latency includes real queue backlog. Neither narrowing this definition nor reducing the workload is part of the proposed work.

## Phase attribution

A separate instrumented10,000-job run counted10,000 PostgreSQL inserts,10,026 claims,10,000 updates, and one final stats query. Summed query latency was about32.7 seconds across concurrent operations; summed connection acquisition was22.1 seconds, with pool acquisition p99 about2.39 ms. These overlapping durations are not elapsed wall time. An instrumented1,000-job startup recorded first inserts around11.8–13.3 ms versus later inserts around2.4–3 ms, and first claim acquisition around5–8.6 ms. Profiling overhead was substantial, so these runs are attribution evidence, not acceptance measurements. The CPU profile included the memory case; common snapshot/GC costs cannot be assigned solely to PostgreSQL.

## Rejected create batching experiment

The candidate microtask-coalesced ordinary creates into at most32 requests/64 KiB per statement, left keyed deduplication unchanged, used the database clock and existing ID uniqueness, and bounded all pending requests across queues and executing SQL to256 requests/4 MiB (one larger existing payload admitted exclusively). New native tests covered first-ID winners and independent snapshots, invalid request isolation, total pending admission and release after failure, ambiguous committed acknowledgment without automatic replay, and close before flush.

The first native run caught enqueue-order interleaving between independently executing batches: four cases passed and FIFO failed. Per-queue serialization corrected this, after which all five native cases passed. Source and test typechecks and the build passed. This candidate was then measured against the exact baseline, in three alternating baseline/candidate pairs for each unchanged workload. Every result is retained in `postgres-create-batch-rejected-20261025.json`.

At1,000 jobs candidate enqueue remained7.94–8.17 ms versus baseline8.47–9.22 ms, still failing the target. Candidate throughput was8,936/6,792/8,940 versus7,261/7,402/7,341 jobs/s; one candidate dequeue p99 was14.57 ms. At10,000 jobs candidate throughput was5,342/6,353/6,462 versus10,070/4,397/10,260 jobs/s. Candidate handler p99 was1,370/1,114/1,087 versus489/1,260/492 ms. Thus faster admission in some cases increased accumulated backlog; the change did not establish a useful improvement across the original measurements and introduced new admission behavior. It was removed completely from source and tests. No production performance improvement is claimed.

## Cleanup and remaining work

The final paired supervisor confirmed both owned service processes stopped and its private directory removed. Earlier native profile/baseline/test supervisors likewise completed owned-process termination and data removal. No deployed provider or account resource was used. Docker exact-name absence remains the separate unresolved observation above.

Original performance requirements remain open, particularly cold PostgreSQL enqueue latency and sustained queue-to-handler latency. Further optimization must preserve request isolation, priority/FIFO/LIFO, delays/dependencies, lease fencing, public snapshots, and bounded pending work. Pool prewarming, increased pool size, or a changed measurement definition would not by themselves demonstrate a default-runtime implementation improvement.

## Rejected claim batching experiments

A separate claim-only candidate grouped up to32 matching queue/name/duration requests in one microtask, bounded all outstanding calls to256, and claimed exactly the caller count with `FOR UPDATE SKIP LOCKED`. Ordered candidates mapped to distinct caller tokens; the database clock was sampled after locking. It did not prefetch or replay an unknown commit. Five new native tests passed: ordered priority/FIFO/LIFO with delays/dependencies and sparse null results; independent connection ownership without extra claims; total pending admission including executing SQL; ambiguous commit without replay; and close before flush. Source/test types and builds passed for the experimental code.

The first variant serialized statements per group. `postgres-serialized-claim-rejected-20261025.json` retains all three pairs at each workload, both sides on Node22.22.1. At1,000 jobs candidate throughput fell to2,768–2,921 versus6,681–7,554 jobs/s, with dequeue p99 26.10–27.68 ms versus3.51–4.17 ms. At10,000 jobs it achieved2,951–3,025 versus9,459–10,352 jobs/s and handler p99 2,919–3,006 versus472–516 ms. The per-group serialization removed existing parallel SQL execution; ordinary asynchronous worker polls often formed small batches.

The final variant kept independent statements concurrent and used the unchanged original one-row SQL for single-request groups. Its five focused native cases also passed. `postgres-concurrent-claim-rejected-20261025.json` retains all three baseline/candidate pairs at each workload. These pairs used Node20.20.0 on both sides; do not compare their absolute values against the earlier Node22 variants as a controlled code-only comparison. Within these final pairs,1,000-job enqueue improved from8.68–9.49 to7.49–7.62 ms but still failed the5 ms target. Dequeue worsened from3.95–4.23 to9.49–9.85 ms. Candidate throughput was7,636/6,742/7,502 versus7,279/6,870/7,415 jobs/s. At10,000 jobs candidate throughput was9,963/9,406/10,010 versus10,046/10,090/10,214 jobs/s; handler p99 was502/557/512 versus500/500/488 ms. There was no sufficient measured benefit to justify new batching complexity and admission errors.

Both claim candidates and their candidate-specific tests were therefore removed. Product source and tests match c779 exactly. The built distribution was restored from the byte-verified baseline copy. All focused/native benchmark supervisors stopped their owned native servers and removed private service data, including the final focus and timing runs. No extra full provider suite was run for discarded code; the earlier c779 acceptance remains its existing evidence, not a newly rerun result. The original performance gates remain open. This checkpoint preserves diagnosis and rejected experiments only.
