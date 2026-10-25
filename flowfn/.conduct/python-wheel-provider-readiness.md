# Installed Python wheel with native providers

2026-10-20. The provider runner now accepts `--python-wheel`. It builds one fresh
wheel, copies the test suite into a temporary directory outside the repository,
installs the wheel with its declared dev/Redis/PostgreSQL extras, and verifies
that `flowfn` imports from site-packages before running tests. Python isolated
mode and removal of inherited PYTHONPATH prevent checkout imports. Cross-process
recovery tests use the same installed interpreter and package.

Commands from the worktree root:

```sh
node flowfn/typescript/scripts/provider-acceptance.mjs --python-wheel
FLOWFN_PYTHON_VERSION=3.9 node flowfn/typescript/scripts/provider-acceptance.mjs --python-wheel
```

At Python source commit `4cd908022`, each run passed 189 tests with six
backend-specific skips against real disposable Redis 7 and PostgreSQL 16.
This includes relative queue clock skew, explicit absolute schedules, distinct
initial/retry delays, stale ownership, stream retention, and subprocess recovery.
Logs: `/tmp/flowfn-python-wheel-native-312.log` and
`/tmp/flowfn-python-wheel-native-39.log`. Each reported the actual site-packages
import path. One existing Pydantic class-configuration warning remains.

The runner removes its unique loopback-bound containers and reads back their
absence, then removes its temporary wheel/tests directory, including on failure.
Both runs completed cleanup; unrelated containers were untouched. The original
`--python` source mode remains available. JavaScript syntax and diff checks pass.

This closes the installed-artifact gap for these Python/native contracts. It does
not establish hosted provider behavior, every supported Python/runtime version,
dependency-minimum compatibility, static typing or the full original FlowFn
specification. Queue performance and other recorded readiness gates remain open.
