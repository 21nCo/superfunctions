# Stored trace queries

The TypeScript `trace.query`, `trace.getTrace`, and `trace.getServiceMap` APIs now query canonical `track` / `trace.span` events through WatchFn's existing storage/query engine. Locally recorded spans include the configured WatchFn name as their service. Ingested canonical spans can carry a different service for parent-child relationships across services.

`query` returns copied, typed stored spans. It supports operation, trace ID, service, error status, nonnegative finite duration comparisons, event time ranges, ordering and limits. Error means `tags.error === true`; other spans have status `ok`. Time ranges select the stored envelope timestamp, normally recording/completion time, rather than span start time. Results reflect stored events; call `flush()` before querying newly buffered local spans outside callbacks.

`getTrace` returns null for an absent trace. Otherwise it returns the trace ID, earliest span start, latest span end, elapsed duration and error status. `includeSpans` adds spans sorted by start time and ID; `includeLogs` adds stored log events with the same trace ID. Span-attached log fields remain inside each span. Both optional collections are omitted by default. Returned data is copied. Duplicate span identities fail explicitly.

`getServiceMap` returns sorted service nodes, directed cross-service parent-child edges, and an `unlinkedSpans` count. An edge records calls, errors and average child duration. Parent lookup includes trace ID, so coincident span IDs in different traces cannot form edges. Same-service children do not form edges. Missing service or a missing/unattributed parent increases the unlinked count. Root spans with a service are normal roots. `minCalls` filters edges without discarding service nodes. A time window may exclude parents and increase the unlinked count.

Details and maps reject more than 10,000 matching spans; details also reject more than 10,000 correlated logs. These are result-capacity checks, not physical scan or memory bounds: the generic query engine still scans and collects before applying its limit. No flush is performed inside the APIs, so an alert callback can query stored traces and add a note without joining its own flush.

## Validation

- Memory and actual SQLite public API tests cover operation/status/duration/time/order filtering, copied results, details/log correlation, service edges, cross-trace orphan isolation, minCalls, duplicate identity rejection, invalid input, actual local span recording and alert callback queries with persisted notes.
- Full TypeScript suite: 284 tests; strict source types and core build pass.
- Fresh seven-tarball installation exercises trace queries, details/logs and cross-service edges in ESM and CJS, along with strict declarations and the existing alert/provider/optional-peer acceptance checks.

## Remaining scope

This implements stored TypeScript queries, not automatic distributed-context propagation, automatic LogFn ingestion, Python parity, complete trace retention or bounded physical scanning. Other original WatchFn requirements and integration with the latest shared prerequisite remain open. No production deployment or full readiness claim is made.
