# Durable scheduled release publishing

Original scope: SPEC invariant 8 requires releases and scheduled publishing. The
previous release implementation only stored `publishAt`; no host operation ever
executed due releases. This checkpoint adds explicit trusted host execution,
shared manual/scheduled claims, durable per-document intents/results, schema-2
migration/backfill and actual Studio scheduling/outcome controls.

## Runtime contract

- `server.executeDueReleases()` and the exported host function scan a bounded due
  index. Future times survive restart. No timer or provider call starts at import
  or construction. The host owns cadence, monitored invocation and graceful drain.
- Manual and due paths use the same sorted membership snapshot and monotonic
  version CAS. Lease expiry permits takeover; only a successful competing version
  update supersedes the prior owner. Post-I/O writes cannot overwrite a winner.
- Persist exact workflow-checked revision, type, stable key and subject before
  sending. ContentFn's actor-bound durable replay resolves a committed publish
  whose response was lost, including after draft removal and database reopen.
- Current service permissions and, for manual calls, requesting-user permissions
  are checked. Unknown datasets, role failures and workflow/revision conflicts
  fail closed. Known per-document failures continue deterministically. Transient
  prerequisites retain due work; unknown publication remains `uncertain`.
- A changed subject, unavailable replay contract or unknown legacy manual send
  cannot become a fresh publication. No automatic key changes or blind retries.
- The due query selects identifiers/version only, not every candidate's document
  payload. Storage uses the existing shared adapter/schema wrapper. Both journal
  and membership reads/writes detach native JSON references so callers cannot
  bypass CAS by mutating returned objects.
- Empty due schedules retain null execution and CAS a 30-second backoff until
  documents are added. Manual empty publication rejects without mutation; the
  first nonempty run captures membership.
- Studio creates optional UTC schedules through actual authorized endpoints and
  displays durable completion/failure/pending outcomes. It never equates an
  uncertain or partial batch with completion.

Producer prerequisite: ordinary merge of ContentFn
`ea74ce3a84e662353dd8eaff3ae0676fa2127548` (sf-next PR 56). Its precise
`content.docs.publish.idempotency.v1` contract binds dataset/key/input/actor and
requires a verified nonempty subject. Legacy successful anonymous keys retain the
same record identity and deterministically conflict under the stronger contract.

## Verification

Commands use the CMS checkout's Node 20.20.0 and its matching native SQLite ABI:

- `npm test -w ./cmsfn/server`: 123 passed across 20 files, before the additional
  legacy-uncertainty and empty-schedule assertions; final focused scheduler run
  passed all 13 tests.
- `npm test -w ./cmsfn/studio`: 84 passed across 18 files.
- Focused scheduler/concurrent-release/SQLite-storage checks after native JSON
  detachment: 18 passed; the later added legacy case also passed.
- `npm run typecheck -w ./cmsfn/server` and `npm run typecheck -w ./cmsfn/studio`:
  passed. `npx --yes turbo@2.6.1 run build --filter=@cmsfn/studio...
  --filter=@cmsfn/server...`: 31 tasks passed.
- Native SQLite evidence includes exact due boundary, reopen, two independent
  simultaneous claimers, stale post-I/O owner fencing, manual overlap, lost ACK
  after producer commit, termination before send, revision retention, bounded
  batch continuation, policy outage/denial, changed subject, old-table additive
  DDL/backfill, invalid legacy dates, detached memory state and empty due
  authoring followed by add/restart/execution.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
  /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: normal npm
  11 clean packed installation, production-only audit, full native Chromium
  143.0.7499.4 App with actual CMS/Content HTTP endpoints, strict installed JSX/CJS
  consumers and ESM/CJS SSR exports. Browser execution performs 154 HTTP requests,
  creates an empty due schedule and verifies it remains unclaimed, adds membership,
  then loses the response after real ContentFn publication commits,
  shows uncertainty, recovers the original key and proves exactly one publish
  audit entry. No fake replacement producer endpoint or copied Studio subset.

The earlier 154-request installed pass preceded the empty-schedule correction;
the final clean packed run also passed 154 requests, including that regression
(`/tmp/cms-scheduler-empty-packed.log`). Final correction receipts: `/tmp/cms-scheduler-empty-tests.log`,
`/tmp/cms-scheduler-empty-types.log`, `/tmp/cms-scheduler-empty-build.log`.
The parent's independent scheduler run during broad host contention had six
timeouts and five passes; this is separate from the isolated 13-test passing run.

The initial CMS native run under Node 22 encountered the checkout's existing
Node-20-only SQLite binary; final CMS native checks use matching Node 20.20.0.
One intermediate full run saw an unrelated roles HTTP response containing `old`;
the same unmodified test passed in the subsequent full suite. The final native
scheduler/storage checks remain independent of that mocked role fixture.

## Deployment and remaining boundaries

See `cmsfn/server/README.md` for exact schema-2 DDL, bounded idempotent backfill,
invalid-row reporting and host configuration. Drain old writers before migration;
`releaseExecutionSchemaVersion: 2` is a host assertion, not distributed old-binary
fencing. Existing SQL tables must migrate before this version's release writes.
Retain producer replay records and stable identity until unresolved runs settle;
dataset deletion/recreation or database rollback is outside replay guarantees.

Publication is deterministic per-document best effort, not dataset-atomic. The
latest terminal journal is retained until an explicit new manual run replaces it;
producer audit is the archival record. Unresolved runs are not automatically
expired. Custom storage-adapter deadlines and host callback cancellation remain
host responsibilities. This slice did not deploy a worker, migrate production,
exercise external SQL services, send provider webhooks, or validate native Safari.
History and remaining original Studio operational acceptance remain open; this is
not a declaration that all CMS readiness requirements are complete.
