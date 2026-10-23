# PostgreSQL namespace admission and ownership acceptance

## Reproduced portability defect

With the declared RecFn physical column types and PostgreSQL 16, two independent
processes concurrently creating the first bot in a namespace produced one success
and one SQLSTATE `23505`: `botAdmission_namespace_key`. The guard upsert targets
`ON CONFLICT (id)`, while the schema also declared namespace UNIQUE. PostgreSQL's
concurrent insertion can report the second uniqueness conflict outside that
arbiter, so the losing request received a database error rather than the expected
namespace quota response. The guard transaction rolled back; no over-admission
was observed.

The schema now has one admission uniqueness authority: unique/primary `id`,
deterministically SHA-256 of the UTF-8 namespace. Namespace remains required.
The store verifies both returned namespace and persisted maximum after upsert;
a tampered identity or configuration mismatch still fails closed. There is no
retry, alternate lock path or provider-effect replay added by this change.

## Existing installation migration is required

Changing TypeScript schema metadata does **not** remove an installed constraint.
Stop all producers/workers/writers and preserve the earlier admission/ownership
migration requirements. Resolve the actual physical table from the application's
Kysely schema mapping. Inspect and remove only its redundant namespace-only unique
constraint; retain the ID primary/unique key and every unrelated constraint.
Do not assume the generated constraint name matches the fixture or default name.

For an installation whose actual table is `public."botAdmission"`, inspect:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'public."botAdmission"'::regclass
  AND contype = 'u'
  AND conkey = ARRAY[
    (SELECT attnum FROM pg_attribute
     WHERE attrelid = 'public."botAdmission"'::regclass
       AND attname = 'namespace')
  ]::smallint[];
```

After verifying the result, execute `ALTER TABLE` against that exact table and
`DROP CONSTRAINT` using the returned, quoted identifier. The acceptance script
uses Kysely `sql.id` for both table and constraint. If the installation instead
created a standalone unique index, inspect `pg_index`/`pg_get_indexdef` and remove
only the namespace-only unique index; dropping unrelated/compound/primary indexes
is not part of this migration. Read back the remaining ID primary/unique key,
namespace-policy rows, and existing bots before restarting writers. The migration
does not rewrite policies, release claims, or clear held capacity.

The runtime schema explicitly declares JSON as `json-text` and dates as
`iso-text`. Migrations must honor those hints: these columns are PostgreSQL TEXT,
not JSONB/timestamptz. Native boolean and numeric columns remain PostgreSQL boolean
and double precision in this acceptance. An initial fixture incorrectly chose
physical columns from logical type alone; the strict codec rejected returned
JSONB objects as invalid JSON text. Correcting that fixture to the existing
published storage contract required no codec relaxation or runtime storage change.

## Reproducible native acceptance

Run from this checkout after building `@recfn/server`:

```sh
node recfn/.conduct/postgres-ownership-acceptance.mjs
```

Requires installed `pg`/Kysely and cached `postgres:16-bookworm`. The script never
pulls an image, accesses existing databases or creates external services. It owns
a uniquely named local container, exposes only a randomly assigned loopback port,
limits it to one CPU/256 MiB RAM, and places database data in a 128 MiB tmpfs.
Readiness checks the TCP listener, avoiding PostgreSQL's temporary initdb socket
server. Cleanup awaits every child, closes pools, removes the exact container ID,
verifies Docker reports that ID absent, and deletes its temporary call log.

The acceptance starts from the corrected schema, adds a deliberately nondefault
legacy namespace constraint, and requires its `23505` failure within at most 20
fresh-namespace races. Each attempt must have exactly one winner; the loser may
reach the normal quota check when scheduling avoids the secondary-index race.
The successful receipt reproduced `23505` on attempt 2. After both old
writer processes exit, it discovers the constraint through PostgreSQL catalogs,
drops only that constraint, verifies the ID primary key and existing bot remain,
and races a different namespace's first use. Additional cases exercise:

- Independent-process admission, with guard upsert verified as the first SQL
  operation, one accepted bot and one quota rejection.
- Independent reopened workers claiming one persisted pending intent and invoking
  a local provider once; failed join/ack retains public error plus held capacity.
- Rollback between work closure and final bot status, and held capacity after
  closing/reopening connections.
- Explicit token-bound reconciliation, namespace isolation, policy/identity
  mismatch rejection, and successful completion remaining done/closed after reopen.
- Atomic rollback of bot creation when pending-intent insertion fails, and claim
  rollback when the joining status update fails.
- SIGKILL after provider invocation, followed by a new process that does not take
  over or invoke the provider again.

## Validation receipt

On 2026-10-23, Node 20.20.0 and PostgreSQL 16.15 (Debian, aarch64), default
`read committed` isolation:

- `npm run build --workspace=@recfn/server`: passed.
- `npm test --workspace=@recfn/server`: 284 tests / 51 files passed, including
  existing native SQLite and worker lifecycle tests.
- `npm run typecheck --workspace=@recfn/server`: passed.
- The built-workspace PostgreSQL acceptance passed with 10 independent
  child processes, two legacy race attempts, and all listed mutation/ownership
  assertions. The removed physical constraint was
  `fixture_legacy_namespace_uniqueness`; ID primary key and existing rows survived.
- Owned container `recfn-pg-acceptance-19e5904a`, ID
  `1aafdc15553183723b2dbc4e669d2b32f28fb15b30f4db8de5478437667ba754`, was removed
  and its absence read back. The temporary call-log directory was removed, every
  owned child exited, and a subsequent owned-label inventory was empty.

Local receipts: `/tmp/rec-postgres-build.log`, `/tmp/rec-postgres-full.log`,
`/tmp/rec-postgres-types.log`, `/tmp/rec-postgres-ownership-final2.log`.
The preceding final fixture attempt produced quota rejection instead of the
intermittent legacy collision; it failed its reproduction assertion and cleaned
its container. The bounded fresh-namespace loop now makes that distinction
explicit without treating a missed reproduction as success.

Only TypeScript server schema metadata changed; no Python SDK/API or shared
adapter source changed. No Python behavior is inferred from these checks.

This is shared Kysely/PostgreSQL acceptance at the reported
isolation level with declared TEXT storage. It does not establish Drizzle/Prisma
acceptance, every PostgreSQL hosting/isolation configuration, live meeting/provider
termination, storage encryption attestation or deployment readiness. Existing
SQLite ownership/admission tests remain required.
