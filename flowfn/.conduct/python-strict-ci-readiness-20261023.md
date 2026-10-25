# Python strict CI checkpoint

2026-10-23, based on 8acd13499dce513ec55a6e44b62311bcbb84fde6.

The normal Python CI command now passes installation, wheel/sdist build, Ruff,
strict whole-package mypy and tests. This supersedes the 407-diagnostic typing
status in python-ci-checkpoint-20261023.md. Native ownership reliability remains
under investigation because repeated native runs were not uniformly successful.

## Changes

- Type test handlers, contexts, queue/message values, subprocess handles, native
  fixtures and benchmark inputs/results against existing SDK contracts. Assert
  optional claims/records/attributes exist before use. No cases/assertions removed.
- Fixture subclasses declare the existing test URL attribute and inherit real
  adapters without overrides. Concrete provider checks also select child-worker
  backends and cleanup. Method instrumentation uses pytest restoration and concrete
  ownership-ID types. Dynamic payloads and variadic transitions retain their SDK
  types; unannotated redis-py Pipeline.multi is viewed as Callable[[], None].
- Stream.subscribe overloads preserve the decorated handler type and expose direct
  registration as an awaitable task. Its implementation is unchanged. This is the
  only runtime-package edit. No strictness, exclusion, dependency, TypeScript,
  root metadata or .gitignore changes; no added diagnostic suppression.
- Correct native clock fixtures whose 250/350ms windows included setup/database
  roundtrips. The retry uses an explicit 2000ms delay, distinct from creation's
  200ms, and its deadline must lie between native timestamps plus that delay.
  Both early-dequeue assertions remain. The absolute-schedule test preserves the
  exact caller timestamp with a 2000ms budget. Both verify the early check precedes
  the deadline, then wait for that deadline and assert claim time is at/after it.
  Diagnostic timestamps expose overruns. Benchmark thresholds/workloads unchanged.
- Preserve concurrent workflow-recovery winner/fencing assertions and add the
  exception results to failure diagnostics.

## Validation

Fresh Python 3.11.14 environment, normal editable dev install, mypy 1.18.2,
Ruff 0.17.2, and the unchanged shared command:

```sh
PATH=/tmp/flowfn-python-types-resume/bin:$PATH node scripts/ci-run-python-package.mjs flowfn/python
```

Final: wheel/sdist and Ruff pass; strict mypy passes all **81 source/test/benchmark
files**; pytest **89 pass, 106 provider skips**, 5.69s. Absent-provider skips do
not prove native acceptance. Four existing Pydantic warnings remain.
Log: /tmp/flowfn-types-normal-ci-final.log. git diff --check passes.

A separate isolated Python 3.12 consumer installed the built wheel outside the
checkout. Strict mypy accepted a decorated async Message handler assigned to
Callable[[Message], Awaitable[None]], and direct registration assigned to
asyncio.Task[Any]. Execution passed readiness and close. Logs:
/tmp/flowfn-types-wheel-consumer.log and
/tmp/flowfn-types-wheel-consumer-runtime.log.

## Native outcomes, including failures

The existing runner creates real disposable loopback Redis7/PostgreSQL16 and
uses independent clients/killed workers. Wheel mode verifies site-packages import
outside the checkout before running copied tests.

```sh
FLOWFN_PYTHON_VERSION=3.12 node flowfn/typescript/scripts/provider-acceptance.mjs --python
FLOWFN_PYTHON_VERSION=3.12 node flowfn/typescript/scripts/provider-acceptance.mjs --python-wheel
```

- Initial source:188 pass/6 skip/1 failure, relative retry-clock narrow window;
  /tmp/flowfn-types-native-source.log.
- Source before clock corrections:189 pass/6 skip,66.93s;
  /tmp/flowfn-types-native-source-final.log.
- Initial wheel:188 pass/6 skip/1 failure, PostgreSQL concurrent workflow recovery
  had zero successful resumes. Original assertion lacked exception details;
  diagnostic assertions now preserve them. /tmp/flowfn-types-native-wheel-final.log.
- Source after relative-clock correction:186 pass/6 skip/3 failures,83.57s.
  Absolute-window failure subsequently corrected as above. The other failures:
  PostgreSQL lost ownership during the unchanged1s lease heartbeat test, and only
  one renewal during the transient-failure test's2.2s window. These are unresolved
  reliability evidence, not conclusively attributed to host load or concealed by
  longer leases. /tmp/flowfn-types-native-source-clock.log.
- Final wheel including both clock corrections:189 pass/6 backend-specific skips,
  82.69s. /tmp/flowfn-types-native-wheel-clock.log. A passing run does not erase the
  intermittent ownership/recovery failures above.

Original performance, provider deployment and broader readiness gates remain
open. No performance benchmark or external provider acceptance is claimed.
All native runners exited and removed their uniquely named containers with
absence readback. Final docker listing found no flowfn-acceptance containers.
Wheel temporary tests were removed by the runner. Generated coverage was removed.
Owned typing environment and consumer fixture temporarily remain outside the
checkout for the following diagnosis. No validation process remains active.
