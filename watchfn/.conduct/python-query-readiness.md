# Python structured query checkpoint

2026-10-23. Implements the core structured query example in SPEC Query Language
(1702 onward) over the existing bounded memory/database scan. Structured queries
support metric name/type, dotted own-field precedence, filters, inclusive absolute
and last-N time ranges, scalar/time grouping, count/sum/avg/min/max/percentile/distinct,
ordering and bounded result limits. HTTP preserves the actual TypeScript public
shape: {results: array}. Python query(dict) returns dictionaries; existing
query(metric="name") continues returning Event objects.

Shared JSON golden vectors execute unchanged in Python and the actual rebuilt
TypeScript QueryEngine. They cover missing/null distinction, numeric versus boolean
equality, numeric-string/boolean/empty-array ordered coercion, scalar/object contains,
array own index/length access, numeric grouping identity, inclusive timestamps,
empty aggregates, percentile interpolation, distinct counts and sequential IEEE
sum arithmetic. This avoids Python3.12 compensated sum changing the TypeScript
result for [1e16,1,-1e16]. Floating-point handling targets JS double semantics;
this is not an exhaustive certification of all cross-runtime number-to-string
edge cases or non-JSON host objects.

Validation:

- Normal repository Python CI builds wheel/sdist and passes89 tests.
- Fresh isolated five-wheel installation passes89 tests, including real shared
  SQLite/SQLAlchemy, FastAPI and Flask adapter execution after database reopen.
- Actual database grouped percentile/filter query returns expected data. Tightened
  scan capacity returns503 even with limit1, before any incomplete aggregation can
  succeed. Legacy sync batching/auth/rollback/cancellation tests remain green.
- Current TypeScript CJS/ESM/declaration rebuild passes;18 shared golden vectors
  pass its QueryEngine and Python. No TypeScript source or shared package changed.

Logs: /tmp/watch-python-query-ci.log, /tmp/watch-python-query-wheel.log,
/tmp/watch-python-query-tests.log, /tmp/watch-python-query-ts-build.log and
/tmp/watch-python-query-golden.log. An initial new-test decorator syntax error was
fixed before successful runs. Existing Pydantic/datetime and testclient warnings
remain; no new lint/type cleanliness claim. Owned source venv/installed consumer
cleaned and all runners exited. No external provider/deployment/push/base merge.

Limits: Python structured results remain bounded at1000 (default1000), and now
select the first rows after ordering like TypeScript, replacing the preceding
HTTP checkpoint's latest-tail selection. This is documented; callers can specify
descending order. Calendar shortcuts, timezone-less date parsing, rate aggregation,
scalar aggregate shorthand/suffix fallback, alert observations, indexed queries,
retention and full metrics/issue/alert/tenant parity remain open. The database's
10000-row/16MiB complete-scan caps remain unchanged; overflow is explicit503.
Unsupported options reject rather than silently downgrade. Original readiness
scope is not completed by this checkpoint.
