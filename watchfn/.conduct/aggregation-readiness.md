# Query aggregation checkpoint

Named `watch.query({ aggregations: ... })` now returns flat result rows whose
aggregation names contain computed numbers or explicit nulls. `watch.aggregate`
returns the same row shape using the `value` column. Both paths apply metric,
where and time filters before aggregation, then order and limit result rows.
Storage query delegation receives raw filter options, never an aggregate-row
limit or grouping instruction that would truncate the input before computation.

Implemented operations are count, sum, avg, min, max, count_distinct and
percentile. Numeric operations include finite numeric samples only; strings,
missing/null values and nonfinite numbers are not coerced. Empty count/sum are
zero; empty avg/min/max/percentile are null. Percentiles use linear interpolation
between sorted samples and accept endpoints0/100. Overflow raises an error.
Distinct counts support finite scalar values, preserving numeric/string/boolean
identity, and exclude missing/null values.

Grouping accepts a field, an interval object or a mixed list. Output preserves
field names (including dotted names) and places bucket start epoch milliseconds
in `timestamp`. Intervals support positive integer ms/s/m/h/d/w durations with
fixed UTC epoch alignment. Groups contain only observed samples; no empty buckets
or fabricated measurements are filled. Invalid/missing timestamps are excluded
from time buckets. Group values are finite scalars; missing fields group as null.
Typed JSON group keys avoid delimiter/type collisions. Sorting dotted flat result
keys does not change the original nested-event field lookup precedence.

The scalar aggregate facade accepts pNN shorthand. An exact metric name reads its
`value` field by default; if no exact events exist, a dotted metric such as
`api.request.duration` selects `api.request` events and their `duration` field.
An explicit `field` always controls selection. Count does not infer a suffix.

Malformed filters, limits, ordering, grouping and aggregate definitions raise
QueryValidationError before storage access. Rate deliberately rejects until its
cross-metric numerator/denominator scope and zero-denominator contract are
implemented. Grouping without aggregations also rejects explicitly: the original
slowRequests SPEC example using only groupBy remains an unresolved contract, not
a silently ignored option. Tuple time ranges, calendar/timezone buckets, database
aggregation pushdown, cardinality/throughput limits and the separate preexisting
Aggregator utility's behavior remain outside this checkpoint.

WatchFn.aggregate now uses the real query engine; WatchFn.query also reports an
unavailable backend instead of returning an invented empty result. A stopped
instance with retained storage continues supporting readback.

Validation:20 focused query tests pass (11 aggregation regressions plus9 existing
query regressions); full WatchFn source `tsc --noEmit` passes. Tests exercise real
WatchFn ingestion/aggregate calls, numeric and empty-set semantics, mixed time
buckets, typed grouping, percentile endpoints, invalid input before backend
access, pre-aggregation limit handling and overflow. Native-provider performance,
full HTTP/packed integration and all other original readiness gates remain open.


## Cross-metric rate checkpoint

Named rate aggregations and `watch.aggregate({aggregation: "rate", numerator, denominator})` now implement the SPEC's metric-count ratio. Each selector is `{metric: string}`. Both selectors share the query's time range, filters and grouping, but select their own event names/types. The outer metric continues to select events for ordinary statistics in a mixed query; it must not discard numerator events before calculating the rate. Storage query pushdown therefore omits the outer metric when a rate needs other metrics.

The result is numerator count divided by denominator count, not a percentage or events per second. Zero denominators return null, including empty datasets; a positive denominator with no numerator returns zero. A group containing only error events remains visible with a null ratio and zero ordinary request count. Unrelated metric groups are omitted when an outer metric or rate-only query defines the relevant metric set. Selector-specific filters are not supported and are rejected rather than ignored.

Five additional tests cover the SPEC mixed aggregation, global filters/time buckets, missing denominators, raw-storage query selection, malformed selectors and the public aggregate helper. This supersedes the earlier rate-rejection limitation. Other original limitations above remain open.

Validation for this checkpoint:125 core and12 browser tests pass; source typecheck and all core builds pass. Both built ESM and synchronous CommonJS execute mixed request-count/error-rate queries and return count2/ratio0.5. Provider-scale aggregation and separate utility behavior remain unproven.


## Tuple ranges and bounded time buckets

The query engine accepts two-element `[from, to]` bounds using numeric epochs, Dates or ISO strings, inclusively, matching the alert-context range form in the original specification. Malformed, missing, nonfinite or reversed tuple bounds reject as QueryValidationError. This does not implement the separate logs/trace query facades that still have other outstanding contracts.

TimeRangeParser.getBuckets now rejects nonfinite/reversed ranges, zero/negative/nonfinite sizes, floating-point steps that cannot advance, and excessive output before allocating. Its default maximum is100000 buckets; callers can explicitly provide a different positive integer maximum as the third argument. Duration parsing rejects zero and unsafe millisecond arithmetic. These guards prevent infinite loops and accidental unbounded allocation without changing valid bucket boundaries.

Validation:47 focused query/HTTP tests and the source typecheck pass, including4 new tuple/bucket cases. Module/declaration builds pass. Calendar timezone semantics and range-edge conventions remain separate gates.
