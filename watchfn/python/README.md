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
