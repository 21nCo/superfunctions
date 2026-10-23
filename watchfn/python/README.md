# WatchFn Python

The Python HTTP routes reuse the shared `superfunctions.http` and
`superfunctions.auth` contracts. Install `watchfn[fastapi]` or `watchfn[flask]`
and pass a WatchFn instance to the corresponding adapter factory. Start the
instance before ingestion and stop it during application shutdown.

```python
from watchfn import WatchFn
from watchfn.adapters.fastapi import create_fastapi_router

watch = WatchFn("application", auth={"provider": server_auth_provider})
app.include_router(create_fastapi_router(watch, prefix="/watch"))
```

`server_auth_provider` implements the shared asynchronous `AuthProvider` and
returns an `AuthSession` or `None`. Providers should treat HTTP header names
case-insensitively because adapter header dictionaries preserve different casing.
The provider owns authentication deadlines, revocation, rotation and credential
verification. WatchFn validates the shared session and checks exact scopes:

- `watchfn:ingest` permits POST `/ingest`.
- `watchfn:query` permits POST `/query`.

Authentication runs before WatchFn reads the body. Absent/malformed/expired
sessions return401, missing scopes return403, and provider exceptions return a
sanitized503. Expiry must be timezone-aware. Wildcards do not grant authority.
A provider takes precedence over any legacy `apiKey`; there is no fallback.
Legacy `auth={"apiKey": "server-secret"}` grants both operations and must stay
server-side. `api_key` is also accepted. Empty keys, unknown auth fields,
malformed providers, configured credentials with `enabled=False`, and
`enabled=True` without credentials reject construction. Omitting auth retains
unauthenticated compatibility. GET `/health` remains public.

These scopes do not filter tenant/app data or enforce session `resource_ids`.
A query-scoped principal can read all retained events in this WatchFn instance.
Use trusted storage separation for mutually untrusted tenants. Programmatic
calls remain trusted host APIs.

## Implemented storage and payload contract

HTTP storage supports memory and transactional database adapters. POST `/ingest` accepts
one event, a list, or `{"events": [...]}` with1–500 events. Each event has a
nonblank `name`, optional object `properties` and `context`, and optional
`type="track"`. Unsupported fields/types reject the entire batch before writes.
The request limit is8MiB and each JSON event limit is64KiB. HTTP202 with
`{"accepted": count}` means the batch has been added to the memory store or the database transaction
has returned successfully. Memory mode does not mean durable persistence. A stopped instance or storage error returns
503. The default memory store retains the latest1000 events, including events
from programmatic collectors; older events may be evicted immediately as new
batches arrive. Memory admission is serialized with background batch writes.

POST `/query` accepts structured options matching the supported TypeScript query
subset. `watch.query(options_dict)` returns raw/grouped dictionaries; existing
`watch.query()` and `watch.query(metric="name")` still return Event objects.
HTTP keeps `{"results": [...]}`. Supported options are:

- `metric`: exact event name or type for structured queries.
- `where`: dotted fields with direct equality or eq/neq/gt/gte/lt/lte/contains/exists.
  Explicit top-level fields take precedence over properties even when null/false/0.
  Missing differs from null for equality; both fail exists and ordered predicates.
  As in TypeScript, ordered comparisons coerce numeric strings/booleans/empty
  arrays, and contains converts scalar/array/object values to JavaScript-style text.
  Numeric aggregates ignore strings, booleans, missing and nonfinite values.
- `timeRange`: inclusive epoch-millisecond or timezone-aware ISO bounds, a two-item
  array, an object with from/to, or last-Nm/h/d/w and today/yesterday/this-week/this-month (also `{shortcut: ...}`). Relative
  bounds are resolved once for the query, not separately per row.
- `groupBy`: a dotted scalar field, `{interval: "5m"}`, or a list of both.
  Supported units are ms/s/m/h/d/w. Grouping requires aggregations.
- `aggregations`: named count/sum/avg/min/max/percentile/count_distinct/rate operations.
  Numeric/distinct operations require field; percentile requires a value from0 through100.
  Rate requires numerator/denominator objects each containing a metric string, and
  counts matching events after common filters/time/grouping; zero denominator yields
  null. With a primary metric, non-rate aggregates count only that metric while
  rate selectors can read their separately named metric streams.
  Empty count/sum/distinct yield0; empty avg/min/max/percentile yield null.
- `orderBy`: `{field: "mean", direction: "desc"}` (or asc).
- `limit`:0–1000, default1000, applied after filtering/grouping/ordering. Unlike the
  earlier memory-only HTTP checkpoint's latest-tail limit, structured queries now
  select the first rows after ordering, matching TypeScript. Specify descending
  order when requesting recent/largest rows. Legacy metric-query behavior remains.

For example:

```python
watch.query({
    "metric": "api.request",
    "where": {"duration": {"gte": 0}},
    "timeRange": "last-1h",
    "groupBy": ["endpoint", {"interval": "5m"}],
    "aggregations": {
        "count": {"operation": "count"},
        "p95": {"operation": "percentile", "field": "duration", "percentile": 95},
    },
    "orderBy": {"field": "p95", "direction": "desc"},
    "limit": 100,
})
```

Invalid options/group values/nonfinite aggregate results reject, and HTTP returns
400. Requests remain limited to64KiB and results to8MiB; output overflow/storage
failure returns503. Query validates before flushing the synchronous batcher and
uses one complete bounded storage scan, so limit/aggregation never hides scan
capacity overflow. Numeric semantics target JavaScript IEEE doubles, including
sequential sums. Timezone-less arbitrary date parsing, alert observation queries, query pushdown
and unbounded TypeScript result sizes are not implemented by this slice. Unsupported
options fail explicitly; this is not full query/metrics parity.

Calendar shortcuts follow the host local timezone, matching TypeScript Date:
local midnight→now for today; previous midnight→today midnight for yesterday;
Sunday-start week; first day of month. Endpoints are inclusive, even yesterday's
upper midnight. DST days can be23 or25 hours; a repeated midnight selects the
earlier instant and a nonexistent midnight advances through the gap. Hosts must
align their timezone and timezone database versions across languages. The package
does not silently switch calendar queries to UTC or infer a tenant timezone.
Shared vectors cover UTC/Kolkata, New York spring/fall and Havana/Sao Paulo midnight
transitions; they do not certify every historical timezone database rule.

`watch.aggregate({"metric": "request.duration", "aggregation": "avg"})` provides
the scalar aggregate API. It returns value rows and accepts pNN percentile
shorthand, grouping, filters and time ranges. An exact request.duration event uses
its value field. Only when no exact event exists anywhere in the admitted scan
can it use request events' duration field. Exact presence is checked before
where/time filters, so an exact metric outside the selected window disables
fallback and can yield null. An explicit field, count or rate disables suffix
fallback. This uses one bounded storage scan; complete-scan overflow still fails.

The shared Request protocol exposes buffered `body()`, not a streaming iterator.
Declared length is checked before reading and actual bytes before JSON parsing,
but the host/proxy must enforce transport memory and request-time limits. WatchFn
also does not bound time spent in a custom auth provider or a blocked batch flush.

## Transactional database storage

Pass `storage="database", database=adapter` to WatchFn. Missing adapters and
adapters without transaction capability reject construction. The implementation
uses shared `superfunctions.db` operations, with a Watch-owned JSON-text codec
and `get_watchfn_schema()` returning a shared `TableSchema`. Consumers do not
provide an adapter schema. Apply migrations before starting WatchFn: the shared
SQLAlchemy adapter does not implement schema creation. The default table is
`watchfn_events`, with string primary-key `id`, text `payload`, and the nullable
projection columns declared by the exported schema. It matches the TypeScript
JSON-text storage shape; Python writes projectionVersion0 so TypeScript retains
its scan fallback. This does not migrate the old unfinished `watch_events` stub
or guarantee full interoperability with arbitrary TypeScript event shapes.

WatchFn owns one database worker thread/event loop per started instance. Every
adapter operation runs there and is serialized, including synchronous track
batch flushes and queries. HTTP ingestion awaits an atomic transaction; query
runs its synchronous flush/bridge off the request loop. No request loop is run
recursively. `stop()` drains admitted operations and shuts down the worker without
closing the caller-owned adapter/engine. Always stop before disposing the engine.
Requests after stop cannot write; database queries after stop return503. Calling
start again creates a new owner loop. The validated adapter is shared SQLAlchemy
with a synchronous, thread-compatible engine and a file-backed SQLite database.
Already initialized foreign-loop clients, non-thread-compatible connections and
SQLite thread-local in-memory pools are not supported by this bridge. Custom
adapters must honor the shared transaction contract and be usable on the owned
loop, including a new loop after restart. A blocked adapter can delay stop; there
is no safe forced cancellation/commit claim.

Each in-process Event receives a private stable UUID and frozen JSON payload on
its first database write. A restored batch retries those same IDs and verifies
existing payloads, so a postcommit acknowledgement failure does not duplicate
that batch. These IDs are not public HTTP idempotency keys: a new HTTP request
creates new events and can duplicate an earlier uncertain request. HTTP delivery
remains at least once. Cancellation stops waiting but does not cancel an admitted
transaction; its outcome may remain uncertain to the caller. The batcher queue
itself is not durable across process crashes.

Database queries scan in bounded100-row pages in one adapter transaction, with
limits of10000 rows and16MiB of encoded payload. Overflow, malformed/unsupported
stored event shapes or missing migrations return503, never partial success.
Query ordering is receivedAt then id (not strict insertion ordering for ties).
The requested limit applies after scanning/filtering. Snapshot isolation depends
on the backend transaction semantics. Stored payloads are limited to64KiB on
write; querying preexisting oversized rows detects size only after the adapter
has fetched them. Hosts must protect table contents and adapter allocation.
Index-backed queries, retention, broader query/issue/alert parity and tenant
filtering remain required follow-up work.

## Validation

Run the normal repository Python CI entrypoint:
`node scripts/ci-run-python-package.mjs watchfn/python`.
With `uv` installed, `python watchfn/python/scripts/verify-http-wheel.py` builds
five local wheels, installs them in an isolated environment and runs tests through
the actual shared FastAPI and Flask adapters. It removes the temporary consumer
and uses no external service. The tests exercise framework HTTP stacks in-process;
they do not certify a deployed server or proxy's transport limits.

### Stored alert evaluation

`watch.alerts.register(Alert(...))` and `watch.alerts.evaluate_stored()` connect
existing `track(name, properties)` observations to windowed conditions. Import
`Alert` from `watchfn.alerts.alert_manager`. For example:

```python
from watchfn.alerts.alert_manager import Alert

watch.track('api', {'latency': 120})
watch.alerts.register(Alert(
    id='slow-api', name='Slow API', description=None, enabled=True,
    condition={'metric': 'api.latency', 'operator': 'gt', 'threshold': 100,
               'window': '5m', 'aggregation': 'avg'},
    severity='warning', channels=[],
    auto_resolve={'enabled': True, 'condition': {
        'metric': 'api.latency', 'operator': 'lt', 'threshold': 50,
        'window': '5m'}}))
results = watch.alerts.evaluate_stored()  # Requires watch.start().
```

Evaluation flushes pending producers and reads one completed storage snapshot.
Database reads keep the existing 10,000-row/16-MiB scan bounds; memory retains
its configured recent-event limit. The per-metric observation cap defaults to
10,000 (`maximum=...`, 1..1,000,000); overflow or a storage failure raises before
any alert state changes. `now` is optional epoch milliseconds. Composite children
use their own metrics and windows; each distinct metric/window is selected independently from the same snapshot.
Anomalies use all retained observations through `now`, ordered by timestamp.
An exact metric name/type within that loaded window selects its finite numeric
`value`; otherwise `api.latency` reads `latency` from `api` events. Even an exact
sample with a nonnumeric value suppresses fallback. This alert presence scope
is distinct from scalar aggregate's global exact-name precedence.

`result.matched` is `True`, `False`, or `None` (unknown); `observed` distinguishes
missing/insufficient data from a healthy measurement. Only an explicitly enabled
`auto_resolve` condition returning true resolves a triggered alert. Threshold
windows are inclusive; nonfinite values, booleans, strings and future samples
are excluded. `minDataPoints` and legacy `min_data_points` are supported for
anomalies. Invalid conditions fail before reading storage.

With memory storage, definitions and state remain process-local and legacy array
`evaluate`/`evaluate_all(data)` remain separate from the windowed path. Database
storage now uses the durable manager below. Both synchronous paths use the same
DB owner-loop boundary as synchronous queries; do not block an async request loop
with them.


### Durable database alert lifecycle and pending outbox

For `storage="database"`, `watch.alerts` now persists definitions/state through
the existing shared adapter. Start WatchFn before any durable alert operation;
unlike the former process-local register, durable registration requires an active
storage owner loop. Stop drains admitted database operations. Apply both tables returned by `get_alert_schema()`
in addition to `get_watchfn_schema()` before using alerts. Event-only clients do
not query the alert tables. Schemas use the TS names `watchfn_alerts` and
`watchfn_alert_outbox`, namespace/id/revision columns, and Watch-owned JSON-text
payloads. The namespace is the Watch name (maximum128 characters); it is a host
partition, not user/tenant authorization. The host applies migrations and database
indexes; no schema creation happens automatically.

```python
from watchfn import get_alert_schema

# Apply exported TableSchemas using your migration system, then start WatchFn.
record = watch.alerts.create({
    'name': 'Slow API',
    'condition': {'metric': 'api.latency', 'operator': 'gt', 'threshold': 100,
                  'window': '5m'},
    'channels': [],
})
watch.track('api', {'latency': 120})
watch.alerts.evaluate_stored()
watch.alerts.acknowledge(record['id'], acknowledged_by='operator', note='Investigating')
watch.alerts.resolve(record['id'], resolved_by='operator', resolution='Fixed')
```

`create`, `get_record`, `list`, `update`, `trigger`, `add_note`, `acknowledge`,
`resolve`, `enable` and `disable` return detached sanitized record dictionaries.
`update(id, definition)` replaces the full definition and removes omitted optional
routing/recovery metadata while preserving lifecycle. Only triggered alerts may
be acknowledged; only active alerts resolve. Explicit `autoResolve` recovery and
unknown/no-data semantics remain. Conditions support the existing TS wire fields;
legacy anomaly `min_data_points` is normalized to persisted `minDataPoints`.

Partial compatibility: `register(Alert(...))` inserts the caller-owned ID once, or leaves
an identical persisted definition/state untouched. Changed definitions require
`update`; registration cannot reset an existing trigger. `get`, `get_all`,
`get_triggered` and `evaluate_stored` return detached legacy `Alert`/evaluation
objects, so mutating returned objects no longer edits database definitions.
Structured channel dictionaries are required for durable registration; legacy
channel names alone cannot configure delivery. In particular, `get(id)` returns
redacted channel names and is not a configuration export: passing that result to
`register` is rejected for configured channels. Use `create`/`update` with the
host's trusted full channel configuration; use `get_record` only for sanitized
inspection, not credential round-tripping. Identical re-registration means the
original full definition, not a public metadata projection. IDs are unique across the table;
reusing one caller-owned ID under another namespace fails. Legacy array evaluation
rejects on the durable manager; use actual stored observations. Removal is
explicitly unavailable until notification reconciliation is implemented; disable
an alert instead.

Every lifecycle transition compares the persisted revision and enqueues its
pending channel obligations in the same transaction. Failed outbox creation rolls
back lifecycle; concurrent/stale evaluation raises `AlertConflict` and must be
retried with fresh observations. A lost completion can be retried without
re-triggering an already-active alert. The shared transaction must implement the
optional atomic `update_many` extension; unsupported adapters reject before
writing, with no read/unconditional-write fallback. SQLite independent engines and
owner threads are tested. Backend transaction isolation/rowcount semantics remain
adapter responsibilities. Evaluation reads one bounded event snapshot and commits
each alert independently: a later page-item failure does not roll back prior
items. Observation and definition snapshots are not one database transaction.

`list(limit=50, after=None, status=None)` and `notifications(limit=50, after=None)`
use ID cursors, limits1–100. `evaluate_stored(limit=50, after=None)` uses the same
bounded definition page (use `list` to advance through pages including disabled
alerts); observation caps remain unchanged. `get_all` raises above100 records,
rather than truncating. Definitions are capped at32KiB, notes at100 with4096
characters each, and total stored payload at512KiB. Default pending capacity is
100 obligations per alert; exceeding it fails the transition, preserving prior
state. These per-record bounds do not limit total historical definitions/outbox
storage across all alerts.

**No Python delivery yet:** channel configurations are saved as pending obligations
for `triggered`, `acknowledged` and `resolved` events. `notifications` reports
pending metadata, never credentials; `process_notifications` raises explicitly.
Public channels report `configured: false` because no dispatcher/sender is
configured. No HTTP/provider requests are made. Pending jobs are not silently
marked sent or discarded. Credentials and notification snapshots remain plaintext
at rest; protect the database and backups. Shared adapter error text is sanitized
because it may contain SQL parameters. Custom adapters must honor the shared
error contract and must not log secrets themselves.

Lease-based dispatch, retries/dead-letter reconciliation, configured email/Slack/
PagerDuty/webhook sends, transition callbacks, calculated-value notification
context and complete TS lifecycle parity remain required follow-up work. Existing
HTTP auth/ingestion/query routes are unchanged; no public alert-management route
is introduced. The methods above are trusted host APIs.
