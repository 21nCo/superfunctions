# Durable PostgreSQL queue insertion ordering

The native tied-timestamp regression reproduced LIFO returning `a,b,c` instead of
`c,b,a`; FIFO happened to pass that query plan. Timestamp sorting had no durable
insertion tie-break and could not guarantee either mode after row updates/restart.

Fresh PostgreSQL job tables now own a bigint enqueue sequence. Creation and explicit
reenqueue allocate positions; duplicate creation, progress saves and lease operations
preserve them. Candidate selection keeps priority first, then newest LIFO before oldest
FIFO, independent of timestamp ties. Sequence comparisons stay in PostgreSQL, including
values above JavaScript's safe-integer range. Gaps and allocation order are valid;
committed jobs are eligible according to existing delay/dependency/ownership rules.
This is not commit-order serialization of concurrent producers.

Existing intermediate schemas fail initialization until explicit
`migrateQueueOrderingSchema()` (or the existing migration entry point) runs with all
writers stopped. The migration holds advisory/table locks and transactionally assigns
historical timestamp/queue/ID order, including C-collated tie-breaks; it cannot recover
historical insertion order that was never recorded. Job JSON/state/leases are retained.
Column/default/sequence/constraint changes roll back together, concurrent migrations are
idempotent, and fresh enqueues follow the migrated positions. Full-table locking requires
a maintenance window. Old writers must remain stopped until replaced; this requirement
is not an enforced deployment fence. The original v0 migration keeps its backups.

Python's separate PostgreSQL queue already stores a BIGSERIAL sequence and selects by
priority/sequence; this TypeScript correction does not add a Python LIFO option.

Validation receipts on Node 20.20.0:

- `/tmp/flow-order-baseline.log`: native LIFO failure before correction, FIFO pass.
- `/tmp/flow-order-focused.log`: four native ordering/migration tests pass. Cases cover
  tied timestamps and updated rows; a reopened adapter on an independent connection pool;
  mixed modes/priority; SQL sequence values 9007199254740993 and above; duplicate create,
  save and reenqueue; forced transactional rollback, concurrent/idempotent migration and
  unchanged stored data. The independent-pool addition is included in the final full run.
- `/tmp/flow-order-full-final.log`: source types, strict test types, ESM/CJS/declaration
  build and 163 tests pass; 85 provider tests are skipped without service URLs.
  The initial Turbo command could not run because the sparse checkout omits turbo.json;
  actual package scripts (`lint`, `typecheck:tests`, `build`, `test`) ran sequentially.

- `/tmp/flow-order-postgres.log`: all 37 native PostgreSQL tests pass, including the
  original legacy migration and ownership/crash contracts. The disposable localhost
  PostgreSQL 16 container was capped at one CPU/256 MiB and removed with absence readback.
  Run against a disposable service with `FLOWFN_POSTGRES_URL` and
  `npm test --workspace=@flowfn/core -- src/adapters/postgres/postgres.test.ts
  --testTimeout 30000 --hookTimeout 30000`; the existing provider-acceptance script also
  provisions its own disposable PostgreSQL/Redis services.

- `/tmp/flow-order-packed-final.log`: fresh six-tarball normal npm11 install/ci,
  strict Node16/NodeNext declaration consumers, ESM/CJS core and admin consumers on
  Node 20.0.0, 20.20.0 and 22.23.3 passed. The new migration method is available in
  installed runtime and declarations; production audit reports zero vulnerabilities.
  Command: `NPM_CLI=/path/to/npm11/bin/npm-cli.js node
  flowfn/typescript/scripts/packed-consumer-acceptance.mjs`. The first invocation via
  `npx -c` inherited its call option into nested npm exec and failed EUSAGE after
  installation/types; `/tmp/flow-order-packed.log` retains that fixture-launch failure.
  Direct npm CLI invocation completed the matrix without source changes or bypass flags.
  Owned packed consumers were removed in finally and read back absent; no owned test,
  provider container or consumer process remains.

The original performance targets, unimplemented adapters and deployment/provider matrix
remain separate requirements; these ordering tests are not performance measurements.
