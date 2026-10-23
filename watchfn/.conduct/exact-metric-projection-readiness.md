# Exact scalar metric precedence with projected database queries

2026-10-23. A native SQLite regression demonstrated that projection time/app
filters could hide an existing exact scalar metric before suffix fallback was
decided. Memory returned null while database aggregation incorrectly returned10.
The same scenario is present in Python's shared query golden vectors.

Filtered scalar suffix queries now probe the unfiltered iterator for exact metric
presence, short-circuit and close it on the first match, then retain the ordinary
filtered/projection-pushed candidate scan. Queries without suffix fallback or
residual filters keep their previous scan path. No getAll materialization or
projection schema change. The additional probe uses the existing128-row database
pages; absent exact metrics may cost a full additional scan. Probe/candidate scans
are live, not a snapshot across concurrent changes, and total latency/row count is
not bounded by the page size.

Validation: native SQLite streaming acceptance2pass, including memory/database
parity and assertions that all adapter pages remain128 rows and time/app pushdown
is retained. Full TypeScript suite235pass, strict types and CJS/ESM/declaration
build pass.28 shared TS/Python query vectors and8 timezone/DST vectors pass the
rebuilt engine. The focused iterator regression proves early close and no extra
probe for ordinary count aggregation. Python checkpoint925b separately records
114 source/installed-wheel tests and native SQLite parity behavior.

Logs: /tmp/watch-exact-metric-before.log (reproduced failure), and
/tmp/watch-exact-metric-{native,tests,types,build,golden}.log (successful checks).
Owned native SQLite directories/connections removed in finally; runners exited.
No deployments, provider sends, push or base merge. Original broader readiness
scope, Python indexed queries and other documented lifecycle/transport gaps remain.
