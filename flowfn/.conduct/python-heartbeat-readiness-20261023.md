# Queue renewal timing after delayed native replies

2026-10-23; follows typing checkpoint 71274497916b28f2df1ec32cd3da321fb94cce1a.

## Reproduced behavior and fix

A queue lease's conservative local deadline starts before its claim/renewal
request. The old heartbeat loop waited a fresh lease/3 interval after receiving
that request's reply. Reply latency therefore consumed the ownership budget and
was followed by an additional full interval. This could lose a lease even when
renewing immediately would have completed before the conservative deadline.

With actual Redis/PostgreSQL storage, a 1000ms lease and an explicit 450ms delay
only in delivery of each successful claim/renew reply, both providers lost local
ownership and were subsequently reclaimed by a competitor. This experiment uses
real server clocks/transitions; its response delay is injected and does not prove
that the earlier intermittent full-suite failures had the same cause.

The queue loop now targets renewal one-third of the lease duration after the
previous request began. If that target passed while awaiting a reply, renewal
begins immediately. The request-start expiry bound, timeout, ownership fencing,
retry backoff and no-resumption-after-loss behavior remain unchanged. Leases are
not lengthened. No server-time comparison against client wall time is introduced.

The new parametrized native regression retains the 1000ms lease and 450ms reply
delay. It requires multiple successful renewals, no local loss, no competing
claim and a successfully persisted completion. Existing hung-renewal, late-claim,
remote-takeover and stale-completion tests remain present.

## Diagnosis before runtime changes

- Twelve focused real-native cases (three repeats of ordinary/transient-error
  scenarios per provider) passed. PostgreSQL renewal max 56.52ms; maximum measured
  event-loop lag 20.07ms. Redis renewal max 7.49ms. No ownership loss reproduced.
- A quiet, instrumented full source suite passed 189 cases with 6 backend-specific
  skips in 82.78s. Original heartbeat tests had renewal max 24.10ms and loop lag
  max 32.03ms. This does not identify the cause of earlier uninstrumented failures.
- The separate delayed-reply experiment failed on both providers before the fix:
  local loss was set and the competitor reclaimed the job. Claim replies took
  approximately 454/455ms. Both new regression cases pass after the fix.
- An initial optional tracing harness produced fixture setup errors from nested
  event loops. Its fixture was corrected and verified on both original transient
  heartbeat tests before the full trace. That failed harness run is not runtime
  evidence. No application source was changed to accommodate the harness.

Reproduction artifacts:

```sh
PYTEST_ADDOPTS='../.conduct/heartbeat_diagnostics.py -k heartbeat_diagnostic -s' \
  node flowfn/typescript/scripts/provider-acceptance.mjs --python
PYTEST_ADDOPTS='../.conduct/heartbeat_diagnostics.py -k heartbeat_delayed_reply_diagnostic -s' \
  node flowfn/typescript/scripts/provider-acceptance.mjs --python
PYTHONPATH="$PWD/flowfn/.conduct" PYTEST_ADDOPTS='-p heartbeat_trace_plugin -s' \
  node flowfn/typescript/scripts/provider-acceptance.mjs --python
```

The optional plugin records native query/transition timing, claim expiry,
backend clocks and loop scheduling lag for the original queue heartbeat tests.
It uses diagnostic-only access to asyncpg pool connections to attach query
loggers. It is not loaded by normal CI and does not alter lease policy. The
standalone diagnostic is a deliberately selected pytest artifact outside the
normal package suite; the permanent regression is inside the normal test suite.

## Validation and limits

The unchanged normal CI command passes install, wheel/sdist build, Ruff, strict
mypy on 81 source/test/benchmark files and 89 tests (108 absent-provider skips).
Log: /tmp/flowfn-heartbeat-normal-ci.log. No suppression/dependency changes.

Full native source passes 191 tests with 6 backend-specific skips, 86.90s;
/tmp/flowfn-heartbeat-native-source-fixed.log. Focused new regression: 2 pass,
195 deselected, 4.53s; /tmp/flowfn-heartbeat-delayed-fixed.log. Baseline experiment:
/tmp/flowfn-heartbeat-delayed-baseline.log. Earlier diagnostic logs:
/tmp/flowfn-heartbeat-diagnostics.log and
/tmp/flowfn-heartbeat-full-trace-final.log.

Earlier intermittent one-second heartbeat and concurrent workflow recovery
failures remain unexplained separately. Their passing reruns are not proof of
resolution. This change fixes the independently reproduced queue scheduling
case, not every native ownership concern. Python workflow/stream monitors also
use post-response waits; TypeScript uses interval scheduling with a request-start
validity bound. Those paths were inspected but are unchanged and have no new
latency acceptance claim here. Original performance/provider/deployment and
broader readiness gates remain open.

Final installed-wheel/native validation passes **191 tests, 6 backend-specific
skips**, 87.24s, with the wheel import verified outside the checkout:
/tmp/flowfn-heartbeat-native-wheel-fixed.log. The final standalone diagnostic
artifact also passes both delayed-reply provider cases (4.44s), after its pytest
fixture registration/import cleanup; /tmp/flowfn-heartbeat-diagnostic-final.log.
Both diagnostic artifacts pass Ruff and compile. git diff --check passes.

All owned native runners exited. Their container removal and absence readback
completed, followed by an empty final flowfn-acceptance container listing. The
owned /tmp/flowfn-python-types-resume environment and
/tmp/flowfn-types-wheel-consumer directory were removed with absence checked.
Generated coverage and diagnostic bytecode were removed. Logs and ignored build
outputs remain; no owned validation process remains. No push, release, deployment
or external provider operation was performed.
