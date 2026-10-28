# DB JSON storage reconciliation and codec ownership

Candidate based on PR #248 head `43c943700`, merged with `origin/dev` at
`ad5a06fb5`. Merge conflicts were limited to the root lockfile and DB manifest.
Retained DB version 0.4.0, the schema-only entry point, JSON codecs, and Kysely
result fixes. Preserved upstream `rawSql` types, SQL implementations, and namespace
wrapper pass-through.

## Correctness fixes

`combinedCodecSchema` previously replaced an underlying JSON-text ownership marker
with a native/unspecified declaration from an intervening wrapper. A later text
wrapper then encoded again. Four new baseline cases failed when reading rows
written through the original owner, with `records.payload contains invalid JSON
text`. A roundtrip solely through the broken wrapper can hide double encoding, so
the regressions also check equality/membership against canonical rows, new writes
read through the original owner, and transaction reads/updates. They cover factory
and function-wrapper ownership and explicit native/omitted storage declarations.

Ownership registration now retains an existing JSON-text field owned by a lower
adapter. Native declarations cannot disable that underlying codec. No boolean
feature was added to this branch. The equivalent JSON fix and integer-boolean
ownership preservation were subsequently validated and pushed on the shared
readiness branch in `2f1674f1f`.

JSON-text predicates now support only `eq`, `ne`, `in`, and `not_in`. Range and
substring operators throw a TypeError identifying the field and operator without
the value. Seven new baseline operator cases failed before this change. README
documents this contract. Native JSON field predicate behavior is unchanged.

Baseline focused suite: 11 failed, 2 passed. Candidate focused suite: 13 passed.
Review evidence was read through GitHub CLI using account `thyaravind` after the
connector returned a pagination error:

- [Codec ownership review](https://github.com/21nCo/superfunctions/pull/248#discussion_r4291405634)
- [Predicate contract review](https://github.com/21nCo/superfunctions/pull/248#discussion_r4291405643)

## Dependency reconciliation

Retaining local DB 0.4.0 while preserving new dev consumers pinned to 0.3.1 caused
`npm install --package-lock-only` to fail with `ETARGET: No matching version found
for @superfunctions/db@0.3.1`. Updated the exact DB pins in billfn/admin, billfn/core,
secfn/core, secfn/server, packages/middleware, and packages/queue to 0.4.0. Extended
middleware and queue peer ranges to include 0.4 while retaining earlier ranges.
This keeps these consumers linked to the workspace containing both upstream raw
SQL support and the JSON codec fix. No packages were published.

Regenerated the lock from current dev using npm 11.6.1. The generated lock includes
broad npm normalization and removal of stale nested dependencies; it was not
manually trimmed. A clean scoped installation of DB, observability, and the six
affected consumers succeeded (803 packages, 14 seconds). A subsequent full DB
workspace npm 11 clean-install dry run passed (3,811 planned packages); this
validates the full install plan, not a second full materialized installation.

Only the DB development test runner is now pinned to Vitest 4.1.11. Other packages'
test tooling and the optional DB test-helper peer compatibility range remain
unchanged. Current advisory records include 3.2.4 in affected ranges and identify
4.1.11 as patched for both reviewed issues. These tests did not expose a UI server;
the version upgrade is not evidence that this task encountered exploitation:
[redirect mock advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9),
[UI server advisory](https://github.com/advisories/GHSA-5xrq-8626-4rwp).

## Validation

Final commands used Node 20.20.0 and npm 11.6.1. The shell's default Node 23 is
outside Vitest 4's supported engine range. npm printed engine warnings for unrelated
monorepo packages; the scoped installation and selected checks succeeded.

- Observability and DB builds passed.
- DB: 235 tests in 21 files passed, Vitest 4.1.11, one worker, 3.41 seconds.
- DB synchronous `@superfunctions/db/schema` entry passed on Node 20.20.0.
- Turbo build/typecheck for billfn/admin, secfn/server, queue, middleware and their
  dependencies: 28 successful tasks, concurrency 1, 42.443 seconds.
- Sequential affected-consumer suites: queue 127 passed / 40 skipped; middleware
  26 passed; billfn/core 48 passed; billfn/admin 5 passed; secfn/core 12 passed;
  secfn/server 52 passed / 10 skipped. Total 270 passed, 50 skipped.
- Queue SQLite concurrency, embedded PGlite, D1/workerd, and declaration acceptance
  ran. The first consumer pass did not set `SUPERFUNCTIONS_QUEUE_POSTGRES_URL` or
  `SECFN_TEST_DATABASE_URL`, accounting for the historical 50 skips above.
- No remaining merge markers; `git diff --check` passed.

Relevant commands from repository root (with Node 20.20 on PATH):

```sh
npm run build -w packages/observability
npm run build -w packages/db
npm test -w packages/db -- --maxWorkers=1
npm run test:schema-entry -w packages/db
turbo run build typecheck --filter=@billfn/admin... --filter=@secfn/server... --filter=@superfunctions/queue... --filter=@superfunctions/middleware... --concurrency=1
```

## Native PostgreSQL follow-up

A disposable PostgreSQL 14.20 UTF-8 cluster was initialized with trust auth,
listening only on `127.0.0.1:56406`, in `/tmp/db-json-pg-7yzak1tc`. Both URL variables
pointed to that owned cluster. Node 20.20.0 and the installed package test runners
ran these files sequentially with one worker:

- Queue `src/__tests__/postgres.test.ts`: 67 passed, no skips, 2.84 seconds,
  including all 40 formerly gated native-server checks through direct clients,
  Drizzle, and Kysely.
- SecFn `src/__tests__/postgres-contracts.test.ts`: 8 passed, 2 failed, no skips,
  30.35 seconds. The two migration-0004 tests failed on `NULLS NOT DISTINCT`.
  SecFn's README explicitly requires PostgreSQL 15+ for schema 4; PostgreSQL 14
  cannot parse this syntax. This run does not establish supported-version SecFn
  acceptance and is not evidence of an attributable DB codec regression.

The cluster was stopped with `pg_ctl -m fast -w stop` and its complete owned
directory removed in `finally`; removal was read back as true. No service remains.
At that point only Homebrew PostgreSQL 14 was installed. A subsequent keg-only
PostgreSQL 16.15 installation supplied a supported server without starting a login
service or changing `/opt/homebrew/bin/postgres` (still 14.20). Installation log:
`/tmp/db-json-postgres16-install-20261028.log`.

The SecFn file was rerun on a new owned UTF-8 PostgreSQL 16.15 cluster at
`127.0.0.1:57042`, data directory `/tmp/db-json-pg16-jawvzcb5`: **10 passed, no skips**,
35.84 seconds. This closes the remaining 10 native checks, including both schema-4
migrations and the 1,001-member test. The owned PostgreSQL 16 cluster was stopped
with wait, then its complete directory removed in `finally`; removal was verified.
The keg remains installed, with no running service created by this work. No tests,
migrations, or timeouts were weakened for either server version.

All 50 initially skipped native consumer checks therefore have passing follow-up
evidence: queue on PostgreSQL 14.20 and SecFn on its supported PostgreSQL 16.15.
This is scoped acceptance for the candidate, not qualification of every provider
or every PostgreSQL version.

Consumer tests ran `npm test -w <workspace> -- --maxWorkers=1` sequentially.
Logs: `/tmp/db-json-ci-20261028.log`, `/tmp/db-json-tests-20261028.log`,
`/tmp/db-json-consumer-build-20261028.log`, and
`/tmp/db-json-consumer-tests-20261028.log`, `/tmp/db-json-full-plan-20261028.log`,
`/tmp/db-json-postgres-queue-20261028.log`, and
`/tmp/db-json-postgres-secfn-20261028.log`, and
`/tmp/db-json-postgres16-secfn-20261028.log`. No overall production-readiness closure
is claimed.
