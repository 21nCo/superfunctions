# Python CI and installed wheel checkpoint

2026-10-23. Base `3a96022047f0c9b7f3e00439cc6b8d0b4995ac78`.

The fresh normal package CI runner on this head reproduced four Ruff errors in
example imports. The older hosted log also contained source issues already fixed
by intervening commits. After example import cleanup, the normal mypy step exposed
untyped tests/examples, an example reusing one variable for async/sync statistics,
and synchronous memoization erasing callable return types in recursive examples.

The synchronous wrapper now preserves its original callable's parameters and
return type with ParamSpec/TypeVar, including cache entries and delete arguments.
Runtime caching, expiry, capacity, validation, key generation and exception behavior
are unchanged. Tests/examples receive explicit types matching their values, the
statistics example uses distinct variables, and Python 3.12 eager scheduling is
resolved by feature detection while retaining the existing older-version skips.
The populated-cache test observes the same `items()` calls through a wrapping spy;
it still asserts zero enumeration on populated unexpired hits and statistics.
No assertions were removed, strictness reduced, ignores added or runtime
requirements/dependencies changed.

## Normal CI reproduction

A new Python 3.11.14 virtual environment was created at
`/tmp/cachefn-python-ci-oct23`, seeded with pip. `build` was installed as in the
hosted Python job's bootstrap. The unchanged shared runner was then invoked:

```sh
PATH=/tmp/cachefn-python-ci-oct23/bin:$PATH node scripts/ci-run-python-package.mjs cachefn/python
```

This performs ordinary editable `[dev]` installation, builds wheel and sdist,
runs `python -m ruff check .`, `python -m mypy .` and `python -m pytest .`.
Final result: build and Ruff pass; mypy passes all 28 checked files;
**62 tests pass and the three existing Python-3.12 eager-task cases skip**.
Tool versions: Ruff 0.17.2, mypy 2.4.0, Pydantic 2.14.1, pytest 9.1.1.
The local OS is macOS; this is not a claim about a new hosted CI result.

Logs: `/tmp/cachefn-python-ci-before.log`, `/tmp/cachefn-python-mypy-before.log`,
`/tmp/cachefn-python-ci-final.log`.

## Installed package validation

A separate Python 3.12.12 virtual environment installed the freshly built
`cachefn-0.0.1-py3-none-any.whl[dev]`. Tests and pytest configuration were copied to
an owned temporary directory outside the repository; no source checkout path was
added. `cachefn.__file__` resolved to that environment's `site-packages/cachefn`.
All **65 tests pass**, including the three eager-task scheduling cases.

A strict mypy consumer of the installed package verifies a decorated callable
`(value: int, *, offset: int = 1) -> str` remains `str`, accepts its original
arguments and exposes typed `delete`. A negative consumer deliberately passes a
string for the integer argument and an unknown delete keyword; mypy rejects both
with `arg-type` and `call-arg`. The negative check is expected to fail and is not
included as a failing default test.

Logs: `/tmp/cachefn-python-wheel-import.log`,
`/tmp/cachefn-python-wheel-tests.log`, `/tmp/cachefn-python-wheel-types.log`,
`/tmp/cachefn-python-wheel-types-negative.log`.

This repairs checks for the existing Python implementation; CacheFn V0's original
TypeScript scope is unchanged and no Python parity features or performance claim
are added. TypeScript/browser code, thresholds, dependency manifests, lockfiles,
shared CI scripts and ignore rules are unchanged. Existing provider/browser/full
readiness gates retain their earlier status.

Cleanup: both owned virtual environments and the copied-test temporary directory
were removed with absence verified. All commands exited; no owned processes or
services remain. Diagnostic logs remain in `/tmp`; ignored package build outputs
remain available for inspection.
