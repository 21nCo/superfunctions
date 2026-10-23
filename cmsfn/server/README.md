# CmsFn HTTP server

`createCmsfnServer(config)` returns a Node HTTP server with an initial-startup `readiness` promise. Constructing or importing the server performs no network I/O. The first `listening` event starts a ContentFn capability probe. Hosts should await the promise before marking their service ready or routing Studio traffic:

```ts
const server = createCmsfnServer(config);
await new Promise<void>(resolve => server.listen(3000, resolve));
const readiness = await server.readiness;
if (!readiness.ok) {
  server.close();
  throw new Error(readiness.error.code);
}
```

Listening alone does not mean ContentFn is ready. The promise resolves to an envelope, including failures, rather than emitting an unhandled asynchronous server error. It records initial startup, not ongoing health. `GET /cmsfn/status` performs a fresh check, and each Content-backed operation checks the capabilities it needs after local authorization and input/dataset validation. Local role CRUD and release create/list/add remain usable during a ContentFn outage. Relevant operations fail with `CONTENTFN_UNAVAILABLE` before forwarding when the producer is incompatible or unavailable; subsequent requests can recover without restarting CMS.

Startup/status require `content.schema`, `content.docs`, `content.assets`, plus `content.realtime` when preview is enabled. Publish/unpublish/release-publish require docs; preview requires docs/realtime; events require audit; webhook history requires audit/webhooks; import/export require schema/docs/assets. Disabled preview does not probe on a token request. Declarations are coarse feature checks; endpoint envelopes still undergo their existing validation.

For a protected ContentFn status endpoint, configure `contentfnStatusHeaders: () => ({ authorization: serviceCredential })`. This is server-owned service identity, independent of incoming browser headers and operation-specific audit/ops credentials. The resolver and HTTP/body read each have a two-second deadline. Status responses are limited to 64 KiB, malformed/non-success bodies fail closed, and redirects are rejected. Closing the server aborts in-flight lifecycle/operation status probes. The host owns any side effects inside its credential resolver.

See `../.conduct/status-capability-readiness.md` for evidence and remaining requirements. History and deployment acceptance remain separate work. Scheduled execution is described below.

## Scheduled release execution (schema 2)

CmsFn exposes `server.executeDueReleases({ limit: 10, maxDocuments: 20 })` and the
standalone `executeDueReleases(config, options)` for a trusted host worker. Run
this method periodically from your host job system and await each call. No
background timer starts on import, construction or listen. The host must monitor
returned outcomes and invoke the worker frequently enough for its scheduling SLA;
there is no promise of millisecond execution at a requested wall-clock time.

Configure `releaseExecutionSchemaVersion: 2` and
`resolveReleaseExecutionIdentity: async ({ dataset, releaseId }) => ({ subject,
roles, headers })` on the server. Resolve current `CmsfnRole[]` from trusted policy
and authenticate `headers` as that same stable `subject` at ContentFn. Credentials
stay in memory; subject, revision, keys and metadata-only outcomes persist. Do not
copy browser credentials or let request input choose this principal. Scheduled
execution requires `release.manage` and per-document `doc.publish`; manual
execution additionally requires the requesting user's current permissions. Host
policy errors fail closed. Missing/incompatible ContentFn capability or transient
policy/transport failures retain due work with a 30-second backoff.

ContentFn must advertise `content.docs.publish.idempotency.v1` (ContentFn PR 56
prerequisite). Startup readiness checks it when scheduling is configured; each run
also checks it using the actual execution credential. This requires ContentFn's
trusted context resolver and authenticated nonempty subject. The host must retain
that subject and producer idempotency records through recovery. Do not delete and
recreate a dataset or roll back the producer database while a run is unresolved.

Studio displays the optional local-time schedule field only for a configured
server, sends canonical UTC ISO timestamps, and displays the last durable run's
state and counts. Past times are immediately eligible on the next explicit host
sweep. `publishAt: null` remains manual. Empty releases wait with a 30-second
retry delay until documents are added; no execution snapshot is captured and
manual empty publication is rejected. Editing membership
after a run claims its sorted snapshot affects only a future explicit manual run.
An explicit manual publication of a scheduled release consumes that schedule;
automatic sweeps never start another execution for a completed run.

Each claim/update uses the release's monotonic `updatedAt` CAS. A 60-second lease
permits takeover after expiry; the persisted version CAS fences superseded workers.
Expiry alone does not invalidate an owner: it can renew if no newer claim or
membership write won the CAS. After supersession, its post-I/O transition fails
and it cannot overwrite the new journal. An already-sent producer request remains
protected by its persisted idempotency key. Before sending, the journal
records the exact workflow-checked revision and a stable idempotency key.
Independent workers/restarts replay the same request under the same subject,
including when ContentFn committed but its response was lost. They do not re-read
a removed draft to invent a different request. A stale worker cannot overwrite a
new owner's journal. Definitive per-document denials/conflicts are recorded and
the sorted batch continues; publication remains best effort, not dataset-atomic.

`complete` means all captured documents have definitive outcomes, including any
failures; it does not mean all documents published. `blocked` retains unsent work.
`uncertain` retains an in-flight operation whose outcome cannot yet be confirmed.
Never change its key, subject or revision to retry. Revoked permissions,
fingerprint conflicts and unavailable replay records require operator
reconciliation of the original producer/audit records; they do not become a new
run. Without a configured service identity, manual operations still share the
claim/journal, but an uncertain legacy send is quarantined rather than replayed.
The API exposes pending IDs and Studio labels publication incomplete.

Bounds: one sweep scans at most 50 due rows (default 10), each run attempts at most
500 documents (default 20 for sweeps), with a 20-second between-operation budget.
The sweep stops starting runs after 25 seconds; an already-started bounded run
finishes or persists its continuation. Host-policy resolution is bounded to two
seconds, status to two seconds, and document HTTP/body reads to five seconds and
2 MiB, with redirects rejected. Configure storage-adapter query deadlines at the
host: the shared adapter interface cannot cancel a hung database call. Host
callbacks must not perform uncancellable side effects. Await/drain active worker
calls before closing adapters or stopping the host.

### Upgrade existing storage

Drain every old CMS writer and worker before migration. Apply these additive
columns to the existing mapped release table (SQLite/PostgreSQL example; adapt
DDL and identifier quoting for your database):

```sql
ALTER TABLE cmsfn_releases ADD COLUMN nextRunAt TEXT;
ALTER TABLE cmsfn_releases ADD COLUMN execution TEXT;
CREATE INDEX cmsfn_releases_due ON cmsfn_releases(dataset, nextRunAt, releaseId);
```

Fresh tables also include both nullable fields. `execution` is JSON serialized by
CmsFn's own shared schema wrapper; supply an ordinary adapter without
`adapterSchema`. Run `backfillReleaseSchedules(db, { cursor, limit: 100 })` until
`nextCursor` is null, repeating the same page after interruption/conflict. Its
updates are idempotent CAS operations and preserve existing document lists.
Collect `invalid` across **all** pages: explicitly correct invalid legacy dates or
journal records, then rerun before enabling scheduling. No dates are inferred.
Keep old writers stopped throughout backfill. Only after successful DDL/backfill
set `releaseExecutionSchemaVersion: 2`. That value is an explicit host deployment
assertion, **not distributed fencing against old binaries**; mixed old/new writers
can invalidate the contract and are unsupported. Existing schema-1 SQL tables
must migrate before this version's release create/publish paths are used.

The latest execution journal remains attached to the release until a subsequent
explicit manual run replaces a terminal journal. It is not an archival audit log;
ContentFn retains the authoritative publication audit and idempotency records.
CmsFn does not automatically expire or delete unresolved run metadata.
