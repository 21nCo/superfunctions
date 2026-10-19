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
