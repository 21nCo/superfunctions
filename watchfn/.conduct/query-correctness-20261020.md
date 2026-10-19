# Query correctness checkpoint

QueryEngine now applies time ranges through the existing TimeRangeParser instead
of ignoring them. Relative shortcuts, shortcut objects, absolute bounds and
one-sided bounds are supported. Event timestamps may be epoch milliseconds,
Date objects or serialized date strings; invalid/missing timestamps are excluded.
Bounds are inclusive, matching TimeRangeParser.inRange. Invalid or reversed
bounds are rejected, including empty range objects.

Nested lookup supports explicit properties paths and shorthand property paths.
An own top-level field wins even when false, zero, empty or null. Inherited fields
are not queried. Missing/null fields and NaN cannot pass ordered comparisons;
missing/null values cannot match substring filters via string coercion. Existing
strict equality/inequality behavior is unchanged. Sorting copies the result array
so neither MemoryStorage insertion order nor specialized storage arrays mutate.

Validation: eight focused query regressions pass under Vitest 3.2.4; the complete
WatchFn source TypeScript check passes (`tsc --noEmit -p
watchfn/typescript/tsconfig.json`). Tests cover relative/absolute boundary behavior,
serialization, malformed ranges, falsy/nested values, missing comparisons, stored
insertion order and frozen specialized results.

This is a query correctness prerequisite only. Aggregations and grouping remain
unimplemented; tuple ranges shown elsewhere in SPEC are not part of the current
QueryOptions type and remain unresolved. Database pushdown, query scalability,
full endpoint behavior and the other original WatchFn requirements are not
established by these checks.

Follow-up: preserved LogFn events use canonical ISO `ts`, while native WatchFn events use `timestamp`. Time-range queries now fall back to `ts` only when `timestamp` is undefined; an explicit zero/null timestamp retains precedence. Nine focused query tests and the full source typecheck pass. Fresh packed acceptance now includes a time-range query against an ingested LogFn-shaped event; that packed check is still pending dependency closure installation.
