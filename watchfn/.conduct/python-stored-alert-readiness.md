# Python stored alert observation checkpoint

The original SPEC section 9 threshold/anomaly/composite examples require actual
metric windows. Existing Python `track` producers already persist named events,
but the standalone array alert manager was disconnected from that storage.

`WatchFn.alerts.evaluate_stored()` now flushes admitted producers, reads one
completed storage snapshot, extracts bounded numeric observations, and evaluates
registered conditions. Every composite child uses its own metric and threshold
window. Shared metrics retain independent ranges per condition; anomalies use retained history
through the evaluation instant. Exact name/type samples within the loaded range
select `value`; otherwise a dotted metric reads its final property from the base
event. Invalid exact values suppress fallback. Missing observations and numeric
arithmetic overflow are unknown, not recovery. Only explicit `auto_resolve`
conditions recover active alerts. Invalid configuration, storage errors, scan
limits and observation overflow leave all alert states unchanged.

The synchronous API uses the existing DB owner-loop bridge. Concurrent stored
evaluations are serialized; hosts must serialize definition mutation and legacy
array evaluation themselves. Definitions, state and channels remain the existing
process-local objects. No notifications are sent. Durable definition/lifecycle,
acknowledgement, notes and notification outbox parity remain original open work.
The legacy `evaluate`/`evaluate_all(data)` behavior remains separate and unchanged.

## Alert precedence compatibility

SPEC windows and the loader's explicit range define alert observations. Unlike
scalar aggregate, alert loader documentation did not define global exact-name
presence. Its memory implementation nevertheless set presence before filtering
timestamps, while projected DB reads could already exclude those timestamps.
The TS loader now filters timestamps first. Out-of-window exact events no longer
suppress memory fallback. Native SQLite and memory tests prove the same result,
including an in-window exact sample with a null value suppressing fallback.
Scalar aggregate retains its separately documented global precedence.

## Validation

- Normal Python CI entrypoint: 122 passed.
- Fresh core/SQLAlchemy/FastAPI/Flask/WatchFn wheels in an isolated consumer:
  122 passed, importing WatchFn from site-packages.
- Actual SQLite producer → flush → stored alert and scalar query; independent
  engine/client reopen re-registers a definition and evaluates persisted samples.
  Tests explicitly show definitions are not restored and scan overflow raises.
- Independent composite streams/windows, inclusive boundaries, future/non-numeric
  exclusion, unknown truth tables, explicit recovery, capacity/storage failure,
  stopped admission and zero-history anomaly behavior covered.
- Eight shared JSON condition vectors run through Python and built TS evaluators.
- Full TS suite: 235 passed; native SQLite query acceptance: 3 passed;
  TypeScript/declaration build and typecheck passed.
- One first installed run failed a test fixture's fractional-millisecond datetime
  roundtrip at the upper bound. The fixture now uses integer epoch milliseconds;
  production timestamp comparison remains strict and the installed rerun passed.

Logs: `/tmp/watch-alert-{ci,wheel,ts-tests,native,types,build}.log`.
Owned temporary wheel environments and SQLite fixtures clean up automatically;
source verification venv removed after acceptance. No hosted service, external
notification channel, deployment or publication was used.

### Independent windows for a repeated metric

A follow-up fixture exposed that merging the observation range for a repeated
metric could let an exact sample 30 minutes ago suppress a one-minute child's
base-property observation. Both managers now load/cache each distinct
metric/cutoff separately. Python derives all those selections from the same
single completed storage snapshot. TS retains its documented per-query live
reads; this change does not add a cross-query database snapshot guarantee.

The shared `alert-window-golden.json` fixture runs through each public manager
with both memory and native SQLite storage: the one-minute child reads the
recent base property, the one-hour child reads the older exact value; an invalid
exact value in the narrow window subsequently makes that child unknown.
Public caller-supplied metric maps remain compatible. Normal Python CI and fresh
five-wheel acceptance each pass 124 tests; the full TS suite passes 237 tests,
including both native SQLite public-manager cases. Typecheck/build and the eight
shared condition vectors pass. Logs: `/tmp/watch-alert-window-*.log`.
