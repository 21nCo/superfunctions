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

### Scoped Studio preview

Configure `preview.enabled`, a trusted HTTP(S) `preview.targetOrigin`, and a server-only
`previewSecret` containing at least 32 bytes of unpredictable key material. The optional
host-only `previewTokenTtlSec` is an integer from 1 to 900 (default 900). The token endpoint
requires `doc.read`, a configured dataset and one to 100 document IDs; the caller cannot
choose the signed audience. Draft IDs normalize to their base document IDs.

The preview target imports `verifyPreviewToken` from `@cmsfn/server` and supplies its
own trusted audience plus the dataset and document it is about to read:

```ts
const claims = verifyPreviewToken(secret, token, {
  audience: 'https://preview.example.com', dataset, docId,
});
if (!claims) return new Response('Denied', { status: 403 });
```

Do not derive the expected audience from untrusted request headers. Verify before reading
any draft. Version 2 tokens intentionally invalidate old unaudienced tokens; upgrade the
CMS issuer and preview target together. Tokens are bearer credentials: the host must
suppress token-bearing URL logs, avoid third-party resources and redirects from its
preview route, and return appropriate no-store/referrer headers. Studio rejects resolver
URLs outside the configured origin or with URL credentials, uses no-referrer iframes,
renews tokens and removes the frame on expiry, denial, timeout or scope change. It cannot
police redirects initiated by the trusted preview target.

For live updates, set `contentfn.realtimeUrl` to the actual HTTP(S)
`/contentfn/events` endpoint. Native EventSource sends browser cookies with credentials;
the host must authenticate those cookies for `realtime.subscribe`. Cross-origin use
requires explicit credentialed CORS and compatible cookie policy. Native EventSource
cannot attach custom bearer headers: use a same-origin authenticated host proxy when the
producer requires headers. Do not put bearer tokens in the events URL. The client rejects recognized credential
query names (`token`, `accessToken`, `authorization`, `cmsfnPreviewToken`, `apiKey`,
`auth`, `bearer`), ignoring case, underscores and hyphens. This is not a general secret
scanner; the host must exclude credentials under other names too. A host-provided
WebSocket URL remains supported but is not the built-in ContentFn HTTP route. Events
must match the active dataset and document before refreshing; closing or changing scope
cancels queued refreshes.

### Reference candidates

`POST /cmsfn/references/query` accepts `{ dataset, types, search?, cursor?, limit? }`.
The configured dataset and every requested type require `doc.read`. Roles are resolved
once per request; missing, denied or throwing role resolution fails closed before any
upstream query or capability check. `contentfnReferenceHeaders(request)` optionally
supplies trusted ContentFn credentials after authorization; browser headers are not
forwarded automatically. The producer must enforce the configured dataset query contract.

Queries use the published perspective, `_id` ascending and only `_id`, `_type`, `title`
and `name` projection. The response is `{ dataset, data: [{ _id, _type, label }],
nextCursor }`. No document body or arbitrary upstream error detail is returned. Requests
are bounded to 96 KiB, 50 target types, 128-character dataset/type/filter values, 65,536
characters of cursor and 20 candidates. Returned IDs are bounded to 32,768 characters,
labels to 160, and upstream responses to 2 MiB. Oversized pages retry the same cursor
with smaller limits down to one within a ten-second query deadline; an oversized single
candidate fails explicitly. Host identity, credential and capability callbacks retain
their existing host lifecycle contract.

ContentFn owns keyset cursor validation and dataset isolation. Filter/type/dataset changes
must start a new traversal; this is deterministic pagination, not a snapshot under
concurrent writes. The producer does not include dataset on individual query rows: the
CMS response binds it to the authorized query and rejects a conflicting dataset if one
is supplied by the upstream. HTML/empty HTTP 401/403 responses are treated as denial.

## Operational logging

The server emits metadata-only attempt/result pairs for role upsert/delete, preview
minting and manual or scheduled release publication. Each pair carries an operation ID;
results distinguish success, denial/failure, partial publication and pending/uncertain
execution. No raw documents, asset bytes, tokens, headers, role definitions, upstream
error messages or per-document failure text are copied. Fields are allowlisted, strings
are at most 512 UTF-8 bytes without control characters, and counts are bounded integers.
Invalid metadata values are omitted rather than truncated into ambiguous identities.

```ts
const server = createCmsfnServer({
  ...config,
  resolveLogSubject: async (request, signal) => {
    // Resolve a verified subject from your existing host session service.
    return hostSessions.subject(request, { signal });
  },
  logging: { sink: (_level, message, metadata) => logger.info(message, metadata) },
});
```

The sink uses the existing CMS logging interface; a host can connect its actual LogFn
logger without a second logging framework or a mandatory dependency. LogFn's own
privacy/retention/delivery settings remain authoritative. Its default redaction can
remove subject metadata; configure only the exact safe leaves the deployment needs.
Without a sink the server writes structured JSON to stdout. Subject enrichment is
optional and bounded to 250 ms, with an aborted signal on timeout; failure omits the
subject and does not change authorization. It never accepts an actor from request
payloads or automatically trusts identity headers. Hosts needing complete actor records
must supply the verified resolver. Scheduled records use the verified execution subject.

Authentication routes are deployment-defined. After the host completes a login or
logout, call `server.reportSessionEvent('session.login' | 'session.logout',
{ subject, succeeded })` with verified metadata only. CMS does not invent a session or
claim that this hook performs authentication. Runtime calls require one of those exact
actions, a plain input object with an own boolean `succeeded`, and an optional nonempty
subject string of at most 512 UTF-8 bytes without control characters. Unknown keys
(including credentials), symbols, inherited inputs and accessor properties are rejected
before any log event is admitted, using a generic `TypeError` without input echoes.

Synchronous sink throws and asynchronous rejection increment
`server.loggingStatus().failures`; they never turn an already committed operation into
a failed HTTP result that could trigger an unsafe retry. At most 128 asynchronous sink
calls remain in flight; excess records increment the failure counter without queuing.
`pending` reports these outstanding callbacks. Monitor these process-local counters and
configure the host logger's own flush/shutdown policy. A non-cooperative host callback
cannot be cancelled by CMS, and a synchronously blocking sink still blocks the process.
This is bounded best-effort operational logging, not a durable audit outbox, external
delivery acknowledgement or exactly-once guarantee. Existing ContentFn audit and release
journals remain the authoritative durable operation records.
