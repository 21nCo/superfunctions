# Python calendar, rate and scalar aggregate checkpoint

2026-10-23. Extends structured queries with today/yesterday/this-week/this-month,
metric-selector event-count rates and the public scalar aggregate API, including
pNN percentile shorthand and exact-metric-first suffix fallback. Existing bounds,
legacy metric query, auth, transaction ownership and HTTP results shape remain.

Calendar boundaries use host local time like TypeScript Date, including Sunday
week start, inclusive upper midnight for yesterday, earlier repeated midnight and
forward normalization through skipped midnight. No implicit tenant timezone or UTC
policy is introduced. Deployments must align timezone databases and host TZ. Naive
arbitrary date strings still reject. Eight shared clock/timezone vectors cover UTC,
Kolkata, New York spring/fall and Havana/Sao Paulo midnight transitions.

Rate counts selected numerator/denominator metric events after shared residual
filters/time/grouping; denominator zero yields null. Mixed primary-metric aggregates
remain restricted to that metric. Scalar aggregate defaults to value; a dotted
metric falls back to its base/last field only when no exact event exists anywhere
in the bounded scan before residual filters. Explicit field/count/rate disable
suffix fallback. No second Python storage scan or silent overflow truncation.

Validation:114 tests pass in normal Python CI and fresh installed five-wheel
acceptance with native SQLite/shared SQLAlchemy and real FastAPI/Flask adapters.
Reopen tests exercise grouped rate, calendar selection, scalar average/percentile,
exact metric outside range suppressing fallback and scan overflow.28 query golden
vectors and8 timezone/DST vectors pass Python and the built TypeScript engine.
Logs /tmp/watch-python-query-next-{ci,wheel,tests,golden}.log. Owned venv and temporary
consumers cleaned; runners exited. Existing Pydantic/datetime/testclient warnings
remain. No deployment/provider request/push/base merge.

The actual TypeScript projected DB path has a separately reproduced discrepancy:
an exact metric hidden by projection time/app filters incorrectly enables suffix
fallback. Memory and Python correctly return null in the same case. Native SQLite
reproduction is retained in /tmp/watch-exact-metric-before.log; the TypeScript fix
is a separate follow-up, so this checkpoint alone does not claim DB-wide cross-
language parity. Remaining scope includes indexed Python query/retention, alert
observation/lifecycle, issue/tenant parity, process-crash durable queues and the
previously documented storage/transport limits. Host timezone compatibility beyond
the explicit vectors is not exhaustively certified.
