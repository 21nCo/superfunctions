# Recoverable recording and search cleanup

Date: 2026-10-20. Requirement: BOT-007 in
`specs/2026-02-28-new-r7k4m2x9-spec/REQUIREMENTS.md`.

## Behavior

The HTTP DELETE route invokes `deleteBotAggregate`, which records a durable
namespace-scoped marker and inventory before external cleanup. It removes search
documents and recording objects before the existing atomic database aggregate
delete. A failed removal or final database transaction keeps the marker pending;
retrying the same ID repeats idempotent removals. Only completed cleanup returns
`deleted: true` (HTTP 200). HTTP 202 reports `deleted: false` and pending/blocked
state. A missing bot returns 404; active bots return 409. Completed markers remain
for idempotency, with resource references and producer rows removed.

Built-in recording upload and transcript index publication reserve a producer
intent before external writes. The bot-root write serializes admission with
marker creation; child mutations use the same gate. No database transaction spans
external I/O. Intent resources are included even if no recording row was admitted.
Missing bot roots cannot acquire an intent. Recording and intent inventory uses
explicit ordered pagination rather than an adapter's default result limit.

Each bot has a 64-intent admission bound. Successful operations release their
intent when a recording row exists and deletion has not begun. Failed or crashed
operations remain uncertain/active. The trusted store recovery method requires an
explicit stopped-operation assertion and nonempty reason, and only operates
with a pending deletion. It is not exposed through HTTP. Timeouts or age alone
never settle an intent. Cleanup adapters must acknowledge completed, idempotent
removal; missing storage/search dependencies block affected cleanup.

## Migration and operational contract

Apply both new tables and indexes from `getRecFnSchema()` before starting this
version: `botDeletions` and `botProducers`. The schema uses JSON text for resources
and ISO text timestamps. Existing bot/recording rows require no backfill because
they are inventoried when deletion starts. Stop older workers before migration;
they bypass admission. Keep marker tables across restarts and do not roll back
to writers without fencing while pending operations exist. Never reuse deleted
bot IDs. Normal successful cleanup removes media references from the marker.

There is no automatic reconciliation scheduler in this change. Hosts retry DELETE
and resolve blocked producers only after proving the original operation and any
remote side effect have stopped. `store.deleteBot()` remains the database-only
primitive; callers needing BOT-007 must use the coordinator/HTTP route. Custom
producers must participate in admission/completion before writing storage/search.
Direct external writes are outside the guarantee. A host with recordings must
provide a search cleanup adapter even if it believes no index exists: missing
configuration alone cannot prove absence of previous index entries.

## Validation

Commands run from the worktree root:

- `npm run build -w @recfn/server`: pass; `/tmp/recfn-deletion-final-build.log`.
- `npm test -w @recfn/server`: 226 tests across 40 files pass;
  `/tmp/recfn-deletion-final-tests.log`.
- `npm run build -w @recfn/client`: pass;
  `/tmp/recfn-deletion-client-build.log`.
- `npm test -w @recfn/client`: 12 tests pass;
  `/tmp/recfn-deletion-client-tests.log`.
- `PYTHONPATH=recfn/python python3 -m pytest recfn/python/tests -q`: Python 3.9,
  14 tests pass; `/tmp/recfn-deletion-python-tests.log`.

Ten new server acceptance cases use file-backed SQLite through the shared
Kysely adapter, real `@superfunctions/storage-local` files, and the actual
SearchFn memory adapter. They verify:

1. Search and file deletion failures, database reopen, namespace isolation and
   repeated completion acknowledgements.
2. An upload paused before bytes are written, durable reservation, blocked
   deletion, rejected late row admission, and removal of its late object.
3. A stranded producer surviving reopen, HTTP 202 until explicit stopped-operation
   reconciliation, then HTTP 200 with actual file removal.
4. Complete cleanup of 105 recordings/transcripts/files/search records and missing
   root rejection, exceeding one explicit database page.
5. A SQLite trigger failing final bot deletion after object removal, preservation
   of pending intent/DB aggregate, and successful retry after reopen.
6. Delayed transcript search publication through the production pipeline and
   cleanup of its late indexed documents. ASR uses a fixture adapter.
7. Admission rejection from a second independent SQLite connection after marker
   creation, plus missing cleanup dependencies preserving blocked state.
8. 65 sequential successful producers releasing capacity, followed by the exact
   64 unresolved intent bound without truncating deletion's blocked list.

9. Competing SQLite connections retain one journal; any native lock contention
   is explicitly retried and never mistaken for completed cleanup.

10. Successful external writes whose key differs from the persisted recording
    retain cleanup ownership, and both keys are removed.

TypeScript and Python client tests preserve `deleted: false` and producer status
from HTTP 202. Python remains a transport client, not a second persistence engine.

## Limits

The stranded-producer case reconstructs durable state and reopens the database;
it is not an operating-system crash or remote network cancellation test. Search
uses its real memory adapter, retained across DB reopen, not a durable external
search provider. SQLite root-write serialization is covered; other database
isolation modes need their own concurrency acceptance. Pagination bounds each query,
not total resource inventory memory; large aggregates still need an operational
size bound or a separately designed streaming cleanup journal. Initial SQLite
admission can report lock contention before an intent commits; callers retry the
request rather than assuming HTTP 202 was accepted. The competing-connection
case permits native busy/locked errors but rejects unique-marker failures. No hosted meeting,
cloud storage, external ASR or remote index was used. This evidence closes the
implemented local BOT-007 cleanup boundary, not overall RecFn production readiness.
