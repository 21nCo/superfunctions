# Query streaming checkpoint

2026-10-20. The original query contract in `SPEC.md` (Query Language and Advanced
Aggregations) includes residual filters, time ranges, mixed grouping, complete
aggregates, ordering and final limits. A final result limit must not limit input
to aggregation. This checkpoint removes complete event-payload materialization
from compatible shared-database scans and aggregate execution while preserving
that contract; it does not declare the full broad-query scalability gate closed.

## Behavior

`StorageAdapter.iterateQuery` is an optional raw-candidate async iterable.
`DatabaseStorage` implements it using explicit 128-row storage-ID keyset pages,
without offsets or adapter-default truncation. Ordinary no-predicate scans retain
the existing database order. Projected scans merge three disjoint streams:
current-version indexed candidates, missing projections, and unknown versions.
Migration compatibility streams remain unfiltered until the query engine applies
canonical semantics. `getAll` and `executeQuery` remain array-returning compatibility
APIs; the query engine prefers iteration.

The projected union previously applied JavaScript string ordering to IDs after
retrieval. SQL collation, particularly UTF-8 versus JavaScript UTF-16 ordering of
custom non-BMP IDs, cannot be assumed equivalent. A bounded ID-only preflight
checks each candidate stream before any payload is yielded. Compatible streams
use the bounded merge. Incompatible ordering uses the original materialized
candidate sort, preserving answers and order. This costs an additional ID scan;
no bounded-memory claim is made for the compatibility fallback.

The engine applies metric, residual field and resolved time filters to all
candidates. Unordered raw queries with a result limit retain only the first
matching rows, but continue scanning so late storage failures reject the request.
Unlimited raw output and ordered raw output retain the existing array/sort path.
The comparator's mixed/null/missing-value behavior is preserved; a numeric-only
heap cannot silently replace that public behavior.

Aggregate groups retain count/sum/min/max/rate state, distinct scalar sets, and
finite numeric samples for exact averages/percentiles. Complete payloads are not
retained per group. Averages preserve the existing `sum(value / finalCount)`
floating-point operation order, avoiding both changed rounding and an inconsistent
second live database pass. Percentiles preserve exact interpolation. Empty groups,
null results, signed zero, overflow errors, first-seen group order, flat dotted
labels, post-aggregation ordering/limits and rate selector behavior are preserved.

The scalar dotted-metric fallback uses two candidate accumulators during one
scan. An exact metric's presence takes precedence before residual filters; once
seen, the suffix candidate state is discarded. Errors in unused suffix groups
cannot fail an exact-metric query. No second live query is used to decide the
metric or calculate denominators.

## Validation

- The full core suite passes 194 tests, including six new streaming regressions
  for cross-page filters/limits, late storage failure, exact average/signed-zero
  arithmetic, exact-metric precedence over invalid suffix groups, full grouped
  statistics and mixed-value stable ordering. Typecheck and dual-format build
  with declarations pass.
- Actual SQLite acceptance uses 4,207 records, with more than 1,000 records in
  each projection-version stream and interleaved storage IDs. It verifies bounded
  keyset calls, complete cross-page filters/order/limits/count/sum/avg/min/max/
  distinct/percentile/rate, scalar suffix fallback, and close/reopen. Additional
  BMP/non-BMP legacy IDs exercise the collation compatibility path.
- The old-schema 1,005-row migration acceptance and all three BotFn SQLite/HTTP
  scenarios pass after the storage change.
- A fixed-seed comparison of 2,700 queries against the preceding implementation
  matches exact results and errors, including floating-point edge values, scalar
  fallback, grouped/rate aggregates and mixed-value ordering.
- `scripts/verify-query-streaming.mjs` creates 20,001 actual SQLite events with
  8 KiB padding per payload (174,493,696-byte database). Limited filtered rows,
  complete scalar/grouped aggregates, suffix fallback and exact average/median
  succeed with V8's measured total heap limit of 62,914,560 bytes (60 MiB).
  The run forbids `getAll`/`executeQuery` materialization and reports measured
  end-of-run heap use; this is a constrained-process acceptance, not a load SLO.

Reproduce from the repository root after installing native SQLite dependencies:

```sh
npm test --workspace=@watchfn/core
npm exec --workspace=@watchfn/core -- tsc --noEmit
npm run build --workspace=@watchfn/core
npm exec --workspace=@watchfn/core -- vitest run --config tests/storage/query-streaming-sqlite.config.ts
npm exec --workspace=@watchfn/core -- vitest run --config tests/storage/event-indexes-sqlite.config.ts
npm exec --workspace=@watchfn/core -- vitest run --config tests/integrations/botfn-sqlite.config.ts
node --max-old-space-size=48 --max-semi-space-size=4 watchfn/typescript/scripts/verify-query-streaming.mjs
```

## Remaining original scalability gates

Pages are bounded by row count, not arbitrary payload bytes. Public ingress has
its own event/body limits; direct storage callers can supply larger payloads.
Group cardinality, exact average/percentile samples, distinct sets, unlimited raw
output, ordered raw candidates, custom-collation fallback and legacy adapter
arrays can still grow with data. No data is dropped or silently approximated to
meet the constrained-heap check, and no new product limit is imposed.

Keyset scans and the ordering preflight are live reads, not a retained transaction
snapshot. Concurrent insertion behind a cursor, deletion, projection/ID mutation
or retention cleanup can affect a traversal; this checkpoint does not claim
snapshot isolation. Canonical storage IDs remain immutable under Watch writes.
Scalable exact order/sample spill or database pushdown, large-cardinality resource
policy, cancellation/deadlines, hosted database portability, multi-process/load
behavior and original non-database/hybrid query capabilities remain open.
