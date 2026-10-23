# Request-start scheduling for workflows, streams and TypeScript queues

2026-10-23; follows queue heartbeat checkpoint
6a7e711c091ef1a5264c8167131cc50db5c339f7.

## Confirmed defects

New native tests retain 1000ms leases and delay only delivery of successful real
claim/renewal replies by 450ms. The actual Redis/PostgreSQL transitions, clocks,
ownership tokens and persisted results remain in use. Before changes:

- Python workflow and stream handlers were cancelled on both providers: 4 failed
  cases. Recorded successful stream claim replies took about 453–458ms; the
  additional post-reply wait consumed the remaining renewal budget.
- TypeScript queues aborted their handlers on both providers: 2 failed cases.
  Claim replies took 453.84/455.12ms and renewal replies 459.35/455.66ms. The first
  heartbeat interval began after the claim reply while its conservative deadline
  was measured from request start.

These controlled response-delay reproductions are distinct from the earlier
intermittent full-suite heartbeat/workflow failures. They do not establish the
cause of those earlier failures or claim all ownership concerns resolved.

## Behavior

Python workflow and stream monitors track an absolute renewal target derived
from the last request start. Claim/renew reply latency consumes the interval;
a passed target triggers immediate renewal. Existing conservative deadlines,
asyncio wait_for bounds, lost-ownership cancellation, and bounded retry delay
remain intact. Handler acknowledgements and persisted workflow completion remain
covered by the native regressions.

The TypeScript queue uses a scheduled wake for the earlier of its next renewal
or conservative expiry. While a provider request is pending, expiry still wakes
and aborts the handler. A positive reply received after expiry cannot restore
ownership. Only the current job guard can schedule another timer, preventing a
late reply from restarting renewal after completion/release or replacement.
Renewal and retry targets use request start; only one request can be pending.
Timers still clamp to the platform maximum and recheck the monotonic deadline.
No lease durations, workload thresholds, native storage schema or dependencies
change. No new provider interface is introduced.

## Validation commands

```sh
PATH=/tmp/flowfn-lease-followup-ci/bin:$PATH node scripts/ci-run-python-package.mjs flowfn/python
npm run lint --workspace=@flowfn/core
npm run typecheck:tests --workspace=@flowfn/core
npm test --workspace=@flowfn/core
node flowfn/typescript/scripts/provider-acceptance.mjs
FLOWFN_PYTHON_VERSION=3.12 node flowfn/typescript/scripts/provider-acceptance.mjs --python
FLOWFN_PYTHON_VERSION=3.12 node flowfn/typescript/scripts/provider-acceptance.mjs --python-wheel
```

The native runner owns disposable loopback Redis 7/PostgreSQL 16 containers,
removes them and reads back absence. Python wheel mode verifies site-packages
outside the checkout before running copied tests. TypeScript native tests run
source after the package build; they do not claim an external hosted deployment.

Baseline logs: /tmp/flowfn-other-lease-baseline.log and
/tmp/flowfn-ts-lease-baseline.log. Fixed focused Python: 4 pass, 197 deselected,
8.79s (/tmp/flowfn-other-lease-fixed.log). Fixed focused TypeScript delayed/expired
reply cases: 4 pass, 75 skipped (/tmp/flowfn-ts-lease-safety.log).

## Cancellation-resistant successful replies

A further native reproduction exposed a separate safety gap: asyncio.wait_for
may return successfully after its timeout when the awaited operation suppresses
CancelledError and returns a positive reply. Before an explicit deadline check,
all six queue/workflow/stream provider cases failed to mark ownership lost or
cancel the handler. These tests perform a real successful renewal, hold its
reply, and suppress cancellation once; later calls remain cooperative.

An initial fixture suppressed every cancellation and stalled stream teardown.
The owned pytest process was terminated after about a minute; the existing runner
then removed its containers and absence was verified. The bounded one-shot
fixture produced six assertion failures in 8.57s without hanging cleanup:
/tmp/flowfn-resistant-baseline-bounded.log. This is real late-reply safety
reproduction, separate from the earlier optional tracing harness setup issue.

All three Python monitors now check the previous monotonic deadline immediately
after the await and before refreshing it. A positive late reply is fenced even
when wait_for returned it successfully. Queue loss events and workflow/stream
handler cancellation remain observable. This does not claim that Python can
forcibly terminate an arbitrary awaitable that suppresses cancellation forever.
The combined ten delayed/resistant native cases pass in 15.22s:
/tmp/flowfn-resistant-fixed.log.

TypeScript native coverage additionally verifies that an outstanding positive
reply cannot revive an expired handler or restart timers after completion/lease
release. Tests explicitly settle their held provider promises during cleanup.

## Final checks and remaining uncertainty

Normal Python CI builds both distributions, passes Ruff and strict mypy across
82 files, and reports 89 passed / 118 provider-gated skips in 6.60s
(`/tmp/flowfn-followup-python-ci-final.log`). No checking rules or assertions were
removed. TypeScript source lint/typechecking and test typechecking pass
(`/tmp/flowfn-followup-ts-types-final.log`). The normal TypeScript suite before
the final two provider-only cleanup cases reported 159 passed / 79 skipped.

The first final TypeScript native run reported 75 passed / 6 failed in 203.52s
(`/tmp/flowfn-followup-ts-native-final.log`). All failures were PostgreSQL:
schedule completion, crash checkpoint, workflow cancellation, delayed queue
reply, ordinary queue renewal, and stream delivery. The newly added late-reply
cleanup cases passed. A fresh unchanged run reported 81 passed in 34.19s
(`/tmp/flowfn-followup-ts-native-rerun.log`). During that fresh run a
pg_stat_activity snapshot showed the native client idle on ClientRead 1.5ms
after its previous query and no blocked client query. That point-in-time check
cannot diagnose the earlier failure. An unrelated Docker workload existed
during the failed run; causality is unproven and it was left untouched.

The six failures remain unresolved acceptance evidence, alongside the earlier
intermittent heartbeat/workflow failures. A passing rerun establishes only that
the unchanged cases passed in that run. This checkpoint fixes the independently
reproduced response-delay scheduling and cancellation-resistant reply defects;
it does not establish sustained ownership reliability under every host or
storage condition, performance SLO completion, hosted provider acceptance, or
full FlowFn readiness.

The final Python source-native run reported 200 passed / 1 failed / 6 skipped
in 108.61s (`/tmp/flowfn-followup-python-native-final.log`). The failure was the
previous queue request-start regression on PostgreSQL: ownership was lost during
450ms reply delivery delays. All ten newly added cases passed. The old regression
now records monotonic request, storage-reply, delivered-reply and exception times
in assertion diagnostics; its 1000ms lease, 450ms delay and semantic assertions
are unchanged. This source-native failure remains open and is not erased by a
subsequent wheel or focused pass.

After that diagnostic-only test change, normal Python CI again passes build,
Ruff, strict mypy (82 files) and 89 tests / 118 provider skips in 6.56s
(`/tmp/flowfn-followup-python-ci-final2.log`). The final normal TypeScript suite
passes 159 tests / 81 provider skips in 2.24s
(`/tmp/flowfn-followup-ts-suite-final.log`).

Fresh Python 3.12 installed-wheel acceptance verified an import from isolated
site-packages and reported 199 passed / 2 failed / 6 skipped in 136.51s
(`/tmp/flowfn-followup-python-wheel-final.log`). Failures were the same queue
response-delay case and existing PostgreSQL remote workflow cancellation test;
all ten added cases passed. This wheel run is not a green acceptance claim.

A final focused diagnostic run (`PYTEST_ADDOPTS='-k
delayed_native_replies_renew_from_request_start -vv'` with source-native runner)
reported Redis pass / PostgreSQL fail / 205 deselected in 10.96s
(`/tmp/flowfn-followup-python-queue-diagnostic.log`). JSON diagnostics preserve
all timestamps. On PostgreSQL, enqueue took 5490ms; dequeue took 6.4ms plus
451.8ms reply delay. The first renewal took 13ms plus 452ms reply delay. The
second renewal was requested at 6414ms and had not returned when the test woke
at least 1600ms after claim reply at 5949ms. Only one renewal had completed and
the loss event was still unset. The old conservative deadline was approximately
6949ms. This suggests the asyncio.wait_for timeout may still be awaiting driver
cancellation completion; the trace does not prove where the provider awaited.
Independent expiry observation while cancellation is pending remains an open
runtime investigation. No lease was widened and no assertion was removed.

The focused run's disposable PostgreSQL initialization also took tens of seconds
before pytest started. These storage/runtime timing observations require further
diagnosis; they do not justify labeling all failures as host load or treating
unknown ownership as safe. The late-positive-reply checks in this change fence
a returned reply, but do not claim a hard timeout for an indefinitely pending
or cancellation-resistant provider operation.

Cleanup: all owned native runners exited; no `flowfn-acceptance-*` containers
remained on readback. The installed-wheel temporary directory was absent after
the runner's finally block. The owned normal-CI virtual environment and generated
coverage file were removed. Shared uv caches and unrelated containers/processes
were preserved. Final Ruff and strict mypy still pass after diagnostic rendering
was changed to JSON. No publication or deployment was performed.
