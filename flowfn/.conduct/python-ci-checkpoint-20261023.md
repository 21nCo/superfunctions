# Python lint and native package checkpoint — full typing gate remains open

2026-10-23, based on `0610204ef00d42d16a5915db12a0d37f8a6f7ce2`.

**The normal full Python CI command still fails.** It now installs, builds and
passes Ruff, then reports **407 strict mypy diagnostics in 30 test/benchmark files
(79 checked files)**. The earlier source-only typing evidence is not a passing
whole-package CI result. Remaining work includes concrete fixture/handler types,
Optional claim narrowing, typed subprocess handles and method instrumentation.
No source/test strictness was relaxed to conceal these failures.

## Changes and contracts

- Correct import ordering, unused imports, equivalent simple expressions and
  multi-statement lines identified by the existing lint configuration. Nested
  asynchronous acquisition/transaction contexts are combined in the same entry
  and reverse-exit order. SQL/Lua payloads, benchmark workload and thresholds are
  unchanged.
- Explicitly bind delivery payloads, decision futures and ownership IDs/tokens
  in Redis/PostgreSQL callbacks; bind memory acknowledgement message identity,
  scheduler owner task, event listener and saga compensation references. Subscriber
  snapshots still occur once per delivery before task creation. Existing stream
  acknowledgement, cancellation, renewal, reclaim and shutdown contracts remain
  covered. These make callback lifetimes explicit; this checkpoint does not claim
  a newly reproduced runtime failure from the lint diagnostics alone.
- Register the existing parametrized Redis/PostgreSQL adapter fixture centrally
  in `tests/conftest.py`, replacing imported fixture names shadowed by test
  parameters. The fixture's provider cases, namespace cleanup and skip conditions
  are unchanged; test collection remains 195 cases. No assertions or cases removed.
- Add Redis/asyncpg to the package's **dev extra**, using the exact existing
  optional dependency constraints. Normal development typechecking now has the
  supported native imports; runtime dependencies stay unchanged.
- Exclude only setuptools' generated `build/` copy from mypy discovery. The normal
  runner builds before checking, and otherwise encounters the same package twice.
  Runtime source, tests and benchmarks all remain in `mypy .`; no error-code
  ignores or source exclusions were added.

## Validation

A fresh Python 3.11.14 environment was seeded with pip/build, then the unchanged
shared runner was used:

```sh
PATH=/tmp/flowfn-python-ci-oct23/bin:$PATH node scripts/ci-run-python-package.mjs flowfn/python
```

Initial current-head reproduction found 179 Ruff diagnostics; the older hosted
log described a different source snapshot. Final ordinary editable `[dev]`
installation, wheel/sdist builds and Ruff **pass**. Full mypy **fails with 407
remaining diagnostics**, so the runner correctly exits nonzero before pytest.
Separately, configured strict `mypy flowfn` **passes all 47 runtime source files**.
Without provider URLs, the source suite passes **89 cases**, skipping the existing
106 provider cases. This separate test execution does not turn the failed CI
runner into a success.

Both native source and installed-wheel tests were executed through the existing
owned-resource runner:

```sh
FLOWFN_PYTHON_VERSION=3.12 node flowfn/typescript/scripts/provider-acceptance.mjs --python
FLOWFN_PYTHON_VERSION=3.12 node flowfn/typescript/scripts/provider-acceptance.mjs --python-wheel
```

- Source/native: **189 pass, 6 backend-specific skips**, 69.33 seconds.
- Installed wheel/native: **189 pass, 6 backend-specific skips**, 68.75 seconds.
  The runner verifies `flowfn.__file__` is in isolated `site-packages`, outside the
  checkout, before executing copied tests. The skipped parametrizations are
  existing PostgreSQL-only or Redis-only regression branches, not omitted native
  providers. Tests exercise real Redis and PostgreSQL, independent clients,
  durable workflow/queue/stream ownership, cancellation, leases, process recovery,
  clocks, dependency/DLQ behavior, telemetry and shutdown.
- Final `git diff --check`, source typecheck and Ruff pass after reducing formatter
  churn. No TypeScript runtime/package changes were made by this Python slice.

Logs: `/tmp/flowfn-python-ci-before.log`, `/tmp/flowfn-python-ci-checkpoint.log`,
`/tmp/flowfn-python-source-types-checkpoint.log`,
`/tmp/flowfn-python-lint-checkpoint.log`, `/tmp/flowfn-python-source-tests.log`,
`/tmp/flowfn-python-native-final.log`, `/tmp/flowfn-python-wheel-native-final.log`.

The native runners each remove their uniquely named loopback Redis/PostgreSQL
containers and read back absence. A subsequent listing found no remaining
`flowfn-acceptance-*` containers. The installed-wheel runner also deletes its copied
test directory. All validation commands exited. This provides local functional
and package evidence only: no performance targets, remote provider deployment or
broader original readiness requirements are claimed complete. Existing Redis
throughput/enqueue and other documented performance gates remain open.

The owned `/tmp/flowfn-python-ci-oct23` environment was removed with absence
verified. The generated coverage file was removed; ignored wheel/sdist outputs
and diagnostic logs remain available for inspection. No owned process remains.
