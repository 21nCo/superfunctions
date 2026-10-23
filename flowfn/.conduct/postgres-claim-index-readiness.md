# PostgreSQL claim-order index

The atomic dequeue query already orders jobs by priority descending, the LIFO
partition before FIFO, LIFO enqueue order descending, then FIFO enqueue order
ascending. It locks one eligible candidate with SKIP LOCKED and samples the lease
clock after ownership. The new partial index supplies those same order keys for
waiting/delayed jobs within a queue. Availability, job name and dependency filters
remain in the query. No claim, lease, retry, payload or ordering semantics change.

The existing ready index remains for other access paths. This adds index storage
and write maintenance on enqueue and state changes; it is not a universal speedup.

## Generated schema parity

Actual drizzle-kit 0.31.8 generation with the existing drizzle-orm 0.45.4 revealed
that `.priority.desc()` emits `DESC NULLS LAST`, whereas the existing query and
raw initialization DDL use PostgreSQL's descending default, NULLS FIRST. Although
priority is NOT NULL, PostgreSQL's planner still distinguishes those pathkeys.
The schema now explicitly calls `.desc().nullsFirst()`.

Both complete generated migrations were executed in an owned PostgreSQL 16
container, populated with 10,000 ready FIFO jobs, analyzed, and tested using the
actual captured dequeue SQL inside rolled-back transactions. Before correction,
the plan used a ready-index bitmap scan and Sort. Corrected generated DDL used
the claim-order Index Scan without Sort, matching the raw initialization plan.
The CASE expression with trailing DESC generated valid SQL in both versions.

The committed JSON includes the actual plans and definitions. This verifies the
specific ready FIFO shape, not performance for future-due or dependency-blocked
high-priority prefixes. It is not a reason to remove eligibility checks.

## Installation and migration

Fresh initialization creates the index. Existing schemas with enqueue_order gain
it during initialization; the new native test drops the index from a populated
schema, initializes twice, checks the valid index and descending/null-order bits,
confirms queued rows are unchanged, and claims the retained job. It also checks
Drizzle's priority column metadata. Existing mixed FIFO/LIFO/priority, large
sequence, rollback/reopen and migration tests remain intact.

Intermediate schemas still require stopped writers and migrateQueueOrderingSchema
followed by initialize. Legacy migration initializes the destination schema. The
index does not change the table protocol or require old-format rows to be rewritten.

Ordinary CREATE INDEX blocks writes during construction. Populated deployments
must schedule maintenance or prebuild the exact index CONCURRENTLY outside a
transaction. Verify pg_index.indisvalid and the definition before starting;
IF NOT EXISTS does not repair a failed or mismatched pre-existing named index.
No zero-downtime or automatic cleanup guarantee is implied.

## Paired measurements

Baseline: 7827a94295a1f668d314f6261b06e4df3e2e6b28. All 33 unique embedded source
files across four baseline maps match exact Git objects. The benchmark script
also matches that head byte-for-byte; hashes are committed with the evidence.
The baseline used an owned temporary dist/dependency overlay; candidate used the
same installed dependency versions. Node20.20.0, owned loopback PostgreSQL16,
32 producers,16 handlers, metrics and completed-history retention unchanged.
Three alternating pairs ran at each size on the coordinated development host.
No trial is excluded, including the first 1,000-job candidate regression.

| Jobs | Pair | Baseline jobs/s | Candidate jobs/s | Baseline enqueue p99 ms | Candidate enqueue p99 ms | Baseline dequeue p99 ms | Candidate dequeue p99 ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1 | 1460.30 | 753.33 | 19.79 | 24.08 | 12.00 | 13.84 |
| 1,000 | 2 | 1481.09 | 1607.77 | 17.98 | 19.61 | 16.47 | 13.56 |
| 1,000 | 3 | 1452.59 | 1520.79 | 17.76 | 19.49 | 16.29 | 12.32 |
| 10,000 | 1 | 736.13 | 1155.38 | 20.98 | 70.32 | 26.85 | 48.47 |
| 10,000 | 2 | 722.28 | 1492.84 | 111.05 | 56.73 | 37.85 | 13.25 |
| 10,000 | 3 | 769.28 | 997.56 | 44.35 | 16.32 | 26.78 | 30.05 |

Throughput improves in all three 10,000-job pairs, but one candidate still misses
PostgreSQL's specified 1,000 jobs/s target. One 1,000-job candidate substantially
regresses throughput; the other two improve modestly. Enqueue p99 is worse in all
three smaller pairs and mixed in the larger pairs. Dequeue p99 is also mixed.
Every candidate still fails enqueue<5ms, dequeue<10ms and queue-to-handler<100ms;
candidate handler p99 ranges307–994ms at1,000 jobs and3613–6450ms at10,000 jobs.
Four of six candidates meet the PostgreSQL throughput target alone. The original
performance gates remain open; no blanket improvement, Redis improvement, Python
improvement or hosted-service result is claimed.

Full records, including memory-adapter runs, all target booleans, source hashes
and both plan comparisons are in `postgres-claim-index-measurements-20261023.json`.
The query-plan fixture is attribution, not an independent throughput acceptance.
No benchmark thresholds, workloads or metrics were changed.

## Correctness and cleanup receipt

- Source and test TypeScript checks passed. Full source suite:170 passed,86
  provider-dependent cases explicitly skipped. The test count increased by the
  single native index installation/metadata regression.
- Existing `node flowfn/typescript/scripts/provider-acceptance.mjs` rebuilt
  CommonJS/ESM/declarations and passed all86 Redis/PostgreSQL tests. Original
  provider timeouts and resource cleanup policy were unchanged.
- The first native run passed the existing85 cases but failed the new test's
  mistaken assumption that `pg_get_indexdef(index,column,true)` includes DESC.
  It returns the expression only. The corrected test separately asserts the
  priority expression and `pg_index.indoption` bits for DESC plus NULLS FIRST;
  the final full native run passes86/86. No runtime fix or timeout relaxation was
  needed for this fixture error.
- Generated SQL used normal isolated npm exec with exact
  `--package=drizzle-kit@0.31.8 --package=drizzle-orm@0.45.4`, an owned empty
  `--prefix`, and `drizzle-kit generate --dialect=postgresql
  --schema=flowfn/typescript/src/adapters/postgres/schema.ts --out=<owned-output>`.
  Both full migrations executed against a disposable PostgreSQL16 container.
- Benchmark container `flow-pg-index-925dd9d2-09ed-4494-974f-1626902f17e1` was removed by the comparison harness
  with exact-name absence readback. Generated-DDL container
  `flow-index-ddl-8d81be27-9563-4a1e-b931-5c62a1385a8b` and both native harness
  containers were removed and read back absent. Unrelated containers were left
  untouched. The verified baseline directory and owned SQL-generation directory
  were removed. No owned test/server/container remains.

Logs: `/tmp/flow-pg-index-{types,test-types,source,native-final}.log`,
`/tmp/flow-pg-index-test-types-final.log`, `/tmp/flow-index-ddl-native.log`.
The initial new-test failure remains in `/tmp/flow-pg-index-native.log`.
Durable measurements and query plans are committed beside this receipt.

No dependency, shared adapter, public API, Python implementation, ignore rule,
provider/deployment configuration or release change. Python behavior and the
broader incomplete FlowFn requirements are not certified by this TypeScript
PostgreSQL indexing checkpoint.
