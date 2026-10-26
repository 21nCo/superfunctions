# Stored goals and dated pace

Scope: WatchFn SPEC.md section 8, Goals & Targets (lines 994–1013). At baseline `8b00ca264`, TypeScript `createGoal` returned undefined and `getGoalProgress` returned an empty object; Python had no stored goal methods. This checkpoint implements these APIs over retained canonical business events in both languages. Revenue, browser/multilocation synthetic execution and other original requirements remain open.

## Contract and storage

Definitions are immutable `goal-v1` rows in `watchfn_business_definitions`, with SHA-256 identity over `[application,"goal",name]`. `getBusinessSchema()` / `get_business_schema()` now include the alert tables required when a goal requests pace notifications. Hosts must apply this complete schema before starting writers. The shared adapter is wrapped internally in TypeScript; Python uses the existing SQLAlchemy adapter and database storage lifecycle. No additional database abstraction is introduced.

The SPEC example metric `purchase.completed.total` resolves to exact event name `purchase.completed` and property `total`. An explicit `{event,field}` selector removes ambiguity for nested properties. Canonical application identity must match the configured host. Relevant legacy events without ownership fail instead of guessing a tenant. Existing `business.track`, flush and canonical ingestion produce the queried records. Definitions and progress use the same lifecycle admission as stored funnels/alerts; stopped clients reject work, and stop joins admitted operations.

Because the example leaves calendar and pace details unspecified, the following are explicit interpretations, not quotations of additional original requirements:

- UTC date-only input means midnight, including the dated query. Day/week periods are anchored to `startDate`; month/year periods retain the original calendar day and clamp shorter months independently (January 31 → February 28 → March 31; leap-day year anchors remain stable). An exact boundary begins the next period. Supported calendar years are 1000–9999; periods extending beyond the supported calendar fail.
- `on_track_check: "50%"` means pace evaluation becomes eligible at 50% elapsed time. Expected progress is target × elapsed fraction. Below pace means actual < expected. Future goals are unknown/ineligible during alert evaluation; explicit progress queries before the start reject.
- Sum/count with no observations report observed zero. Average/min/max without observations are unknown/null. Negative finite values are included. Invalid values, nonfinite aggregates and nonfinite progress percentages fail explicitly.
- Progress returns the period boundaries, requested instant, actual, target, progress percentage, elapsed percentage, expected value, below-pace state, observation status and event count. Results describe retained history, not evidence that missing or expired history never existed.

The existing streaming query is bounded to 10,000 candidates, 64 KiB per event and 16 MiB total; alert evaluation also honors its smaller configured observation maximum. Exceeding a bound fails rather than returning a partial total. No new currency semantics are inferred from numeric goal metrics.

## Atomic alerts and recurring episodes

An optional `alerts` block resolves trusted aliases from the existing named-channel map and snapshots actual channel configurations. A goal without enabled pace notifications stores no alert row and needs no channel or HTTP dispatcher. With notifications, goal and associated alert insert in the same transaction; failure of the second insert rolls back the goal. Unique identity prevents replacement by concurrent duplicate creation.

The explicit serialized condition is `business-goal`, containing the canonical goal definition, application identity and below/on-pace operator. Existing scheduled/explicit alert evaluation and the durable outbox perform delivery; creating or reading a goal does not send messages. This checkpoint does not add an implicit scheduler.

A new calendar period closes an old active episode with `resolvedBy: goal-period-ended` and atomically records the new period identity. The normal next evaluation transaction may then trigger the new period. If execution fails between those commits, retry evaluates the persisted new period and emits its trigger once. Existing outbox ordering/uncertainty rules remain. Backward alert evaluation rejects; historical progress remains read-only. Revision checks reject an intervening edit/disable after period rollover rather than applying old observations to a new definition.

No-alert definition/progress interoperability is verified through one SQLite file shared by independently installed TypeScript and Python consumers. Alert dispatch namespaces retain their existing distinct `ts-v3` / `python-v2` protocol ownership. A host must not run both dispatch protocols in the same owned alert namespace; bilateral goal data does not imply cross-protocol outbox compatibility.

## Validation

Final command results and prerequisite commit are recorded below after completion. Focused source coverage includes anchored periods, leap day/exact boundaries, negative values, empty aggregates, malformed dates/identities, more than 1,000 observations, bounded failure, future eligibility, independent SQLite reopen, a failed second insert, actual local webhook delivery, crash-equivalent post-commit callback failure and an intervening rollover disable. No external provider sends or deployments were performed.

The first native Python notification fixture exposed shared SQLAlchemy table reflection opening another connection inside an active SQLite transaction: the dispatch marker could roll back while later goal/alert writes persisted. Shared prerequisite `e3c4ad24cfbcf1ac6da17a5f92a9e0e261d8b66c` (integrated here as `fd03a109d`) reflects through the active transaction connection. The temporary read-only preflight used to attribute the failure was removed; product behavior relies on the actual shared transaction correction. Native first-use commit/rollback coverage is retained in the shared package, and the Watch fixture explicitly injects failure at the second goal/alert insert.

Python's current storage query returns a materialized retained-event snapshot, so its capacity check covers that snapshot before filtering; TypeScript can stream storage-filtered candidates. Both fail closed on their stated bounds. This does not establish unlimited-history goal aggregation or identical storage scanning costs.

Final October 26 validation:

- TypeScript complete source suite: 398 passed across 39 files; `tsc --noEmit` and package build passed.
- Fresh five-tarball package consumer: actual goal creation/progress, ESM/CJS execution on Node 18.18.0, 20.19.0 and 22.23.4, declarations with TypeScript 5.0.4/5.3.3/5.4.5, existing external Zod composition, production audit zero findings.
- Normal Python CI: wheel/sdist build and all 329 tests passed. This package has no additional configured Ruff/mypy gates; none are inferred.
- Fresh seven-wheel isolated Python 3.11 consumer: all 329 copied tests passed; imports were verified from site-packages. A separate clean base-only installation created/read a goal with `httpx` absent, confirming optional delivery dependencies are not needed for no-alert goals.
- The fresh wheel consumer then launched the existing fresh five-tarball bilateral fixture against one owned SQLite file. Python read the TypeScript-created goal and canonical positive/negative events; TypeScript read the Python-created goal. Both returned actual 20, expected 50 at the January31-anchored February14 date. Existing funnel exact/fractional timestamp vectors remained green.
- Local receipts: `/tmp/watch-goals-ts-full.log`, `/tmp/watch-goals-ts-types.log`, `/tmp/watch-goals-ts-build.log`, `/tmp/watch-goals-packed.log`, `/tmp/watch-goals-python-ci.log`, `/tmp/watch-goals-wheels.log`. Focused final suites were TypeScript6 and Python7. Earlier fixture failures were corrected before these final checks; no timeout or assertion was weakened.
- All owned test/consumer processes exited; temporary wheel, npm and SQLite fixtures were removed by their `finally`/temporary-directory lifecycle. No external resources, live providers, deployments or publication were used for acceptance.
