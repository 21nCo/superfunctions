# Python strict typing and packaged sink contract

Date: 2026-10-23. This checkpoint covers Python lint, typing, builds and local
runtime/installed-wheel validation. It does not close the other LogFn readiness
gates recorded in `readiness.md` and `default-redaction-readiness.md`.

## Contract and checks

`Sink` now requires only its actual positional callable contract. Plain sync/async
functions and bound methods no longer falsely require an async `flush` member.
Runtime hook discovery remains unchanged: optional synchronous or asynchronous
flush hooks run, and awaitable delivery/flush results are joined. The typed
consumer fixture exercises all five forms together and verifies delivery plus
both hook completions. `py.typed` is explicitly packaged so installed-wheel users
receive the public annotations rather than an untyped-import fallback.

Source imports and built-in generic annotations satisfy the existing Python 3.9
Ruff target. The collapsed HTTP completion condition preserves the same short
circuit ordering and behavior. Tests now annotate actual event batches, HTTP
callbacks, streams, Futures, fixtures and return types. Optional pipeline results
and current-task handles are narrowed with runtime assertions. Cyclic and
heterogeneous contexts use explicit object shapes; the malformed redaction
configuration test deliberately casts only at its invalid public-input boundary.
Additional pipeline fields use a TypedDict extension and remain in the redaction
assertions. No tests or malformed cases were removed, and no type ignores were
added.

Strict mypy still includes all source and tests (16 files). Generated `build/`
and `dist/` copies are the only excluded discovery paths, preventing duplicate
module errors after the CI build. The fixed 3.9 mypy target was removed: mypy now
checks the interpreter version whose dependencies were resolved and installed.
This avoids parsing current 3.11 dependencies as 3.9. There are no new dependency
pins, transitive constraints, relaxed strictness flags, or test exclusions.
`requires-python >=3.9`, Ruff's `py39`, and Black's `py39` remain unchanged.

## Validation

| Environment | Result |
| --- | --- |
| Actual Python 3.9.6 source environment, mypy 1.18.2 | Strict mypy: all 16 files pass; Ruff passes; 43 tests pass, 1 existing conditional skip |
| Fresh Python 3.11.14 development environment | Actual `scripts/ci-run-python-package.mjs logfn/python` passes normal editable installation, wheel+sdist build, Ruff, strict mypy and all 44 tests |
| Fresh Python 3.9.6 toolchain, mypy 1.19.1 | Full strict source+test mypy (16 files) and Ruff also pass |
| Fresh installed wheel, Python 3.9.6 | Strict consumer passes with mypy 1.19.1; consumer runtime passes; 43 tests pass, 1 conditional skip; `pip check` passes |
| Fresh installed wheel, Python 3.11.14 | Strict consumer passes with mypy 2.4.0; consumer runtime passes; all 44 tests pass; `pip check` passes |

The 3.9 skip is the pre-existing integer conversion limit case: this 3.9.6 runtime
has no `sys.set_int_max_str_digits`. Python 3.11 runs and passes that case.
Tests include actual loopback HTTP delivery, retry and terminal redaction, plus
async cancellation, inherited delivery, failed hooks, callback failures, privacy,
serialization bounds and malformed configuration. No external log provider was
used.

Fresh 3.11 resolution selected pytest 9.1.1, mypy 2.4.0, AnyIO 4.15.1 and Click
8.5.0. Fresh 3.9 wheel resolution selected pytest 8.4.2, mypy 1.19.1, AnyIO 4.12.1
and Click 8.1.8 according to package interpreter constraints. Both installs used
normal pip resolution without bypass flags. The earlier 3.11 environment's retained
older tools also passed the runner, but the fresh environment establishes that
success does not depend on those earlier temporary caps.

Wheel content inspection confirmed `logfn/py.typed`. Installed-consumer tests ran
from copied tests outside the checkout with `PYTHONPATH` unset; import readback
confirmed `site-packages/logfn/__init__.py` on both interpreters. The validated
wheel SHA-256 was
`71a67916d18ec8577884c7c3946e2d77d304c45acb8344ffae6db19f812093cd`.
README development instructions were added after that build; the validated Python
source, package-data configuration and consumer fixture are unchanged.

Local logs:

- `/tmp/log-python39-final-{types,ruff,tests}-oct23.log`
- `/tmp/log-python39-fresh-{types,ruff}-oct23.log`
- `/tmp/log-python311-clean-ci-oct23.log` and `/tmp/log-python311-final-ci-oct23.log`
- `/tmp/log-wheel39-oct23.log` and `/tmp/log-wheel311-oct23.log`

Reproduction uses the interpreter of interest:

```sh
python -m pip install -e 'logfn/python[dev]'
node scripts/ci-run-python-package.mjs logfn/python
# In a separate environment, install the wheel with dev extras, copy tests outside
# the checkout, and verify import location before checking the consumer:
python -m mypy --strict tests/typing_consumer.py
python tests/typing_consumer.py
python -m pytest -q --asyncio-mode=auto tests
python -m pip check
```

The shared CI workflow currently provisions Python 3.11. Minimum Python 3.9 is
separately verified here and must continue to be checked on an actual 3.9
interpreter; a 3.11 result is not evidence of minimum-version support. These local
results do not assert hosted CI success, registry publication, middleware parity,
shared HTTP abstraction integration, browser support or production delivery.
