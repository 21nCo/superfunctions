# Python resource typing and CI readiness

Date: 2026-10-23. Baseline: `5b3467b8a3c6d754a7f408732106600cf4eb7fe6`.

## Reproduction and changes

A fresh normal Python 3.11 environment reproduced the hosted runner's 11 Ruff
errors. Import cleanup exposed 15 configured-mypy errors, including all resource
factories returning `object`, collection defaults annotated nonoptional but
initialized with `None`, the optional WebSockets import fallback, binary-frame
typing, and an unannotated stream return.

All nine resource classes now live at module scope, receive the same HTTP client
through their constructor, and are returned by their existing factories with
concrete types. This makes the advertised public methods visible to type checkers.
An AST comparison verified that all 25 existing resource method bodies are
unchanged except replacing the captured `client` with `self._client`; request
paths, payloads, parsing and public method signatures remain intact. A regression
exercises all nine resource groups and verifies separate clients retain their own
base URL.

Collection fields on aggregate bots, meeting metadata and API errors now use
independent default factories. Their existing post-init normalization of explicit
`None` from untyped callers remains; tests cover normalization and instance
isolation. The wheel includes `py.typed` for installed-package consumers.

The WebSocket connector and connection use small structural protocols instead of
an incompatible module/fallback assignment. Runtime module patching and the
missing-dependency error remain available. Frame parsing accepts the actual
`str | bytes` transport union. Invalid UTF-8 binary JSON is ignored alongside
invalid JSON, preserving the subsequent valid frames. The existing canonical
status/participant/error shape checks and ping-task cancellation are retained.
A real loopback server sends invalid UTF-8, invalid JSON, an invalid status shape,
a valid binary status frame and a valid text participant frame; only the two valid
frames are yielded before clean close.

Response envelopes and event payloads keep their existing dynamic dictionary/Any
contracts. This checkpoint does not claim comprehensive entity validation or
redesign those APIs. No type ignores, removed tests, weakened check flags, or
new/pinned production dependencies were introduced.

## Validation

| Environment | Result |
| --- | --- |
| Fresh Python 3.11.14 / WebSockets 17.3 / mypy 2.4.0 / pytest 9.1.1 | Actual `scripts/ci-run-python-package.mjs recfn/python` passes normal installation, wheel+sdist build, Ruff, configured full mypy over 19 source/test files, and 17 tests |
| Fresh installed wheel, Python 3.11.14 / WebSockets 17.3 | Strict public-resource consumer, consumer runtime, all 17 tests, and `pip check` pass |
| Fresh installed wheel, actual Python 3.9.6 / minimum WebSockets 12.0 | Strict public-resource consumer, consumer runtime, all 17 tests, and `pip check` pass |
| Actual Python 3.9.6 source/test checks | Full mypy with explicit `--python-version 3.9` passes all 19 files; Ruff passes |

The source retains its existing configured mypy settings; only the installed-wheel
consumer is checked with `--strict`. The explicit 3.9 check supplements the
configuration's 3.10 target and establishes minimum-version parsing/type evidence
with dependencies installed for that interpreter.

The original 14 tests remain, with three additional regressions. The TypeScript
`@recfn/core` producer was rebuilt before the cross-language frame-schema check.
For copied wheel tests, `RECFN_CONTRACT_ROOT` selects that checkout rather than
skipping the producer comparison. `PYTHONPATH` was unset and imports were read back
from `site-packages/recfn/__init__.py`. The current WebSockets test emits one
unsuppressed deprecation warning because its server fixture uses the legacy API
shared with WebSockets 12.0; the SDK continues to use the installed package's
normal top-level connector.

Minimum WebSockets was selected only in the disposable test environment with
`websockets==12.0`; the package requirement remains `websockets>=12.0`. Both wheel
installs used normal pip resolution. The inspected wheel includes `recfn/py.typed`
and has SHA-256
`244d6931b5e644015eccb7b2dea7dc490f2bdef1b66fb1cd846c4b8f55ed47b2`.
README instructions were added after that wheel build; validated Python source,
package contents and consumer fixtures are unchanged.

Local receipts:

- `/tmp/rec-python311-baseline-ci-oct23.log`
- `/tmp/rec-python311-fixed-ci-oct23.log`
- `/tmp/rec-core-contract-build-oct23.log`
- `/tmp/rec-wheel39-oct23.log` and `/tmp/rec-wheel311-oct23.log`
- `/tmp/rec-python39-full-{types,ruff}-oct23.log`

Reproduction:

```sh
npm run build --workspace=@recfn/core
# Put the intended Python environment on PATH, with pip/build installed:
node scripts/ci-run-python-package.mjs recfn/python
# In a separate installed-wheel environment, with tests copied outside the checkout:
python -m mypy --strict tests/typing_consumer.py
python tests/typing_consumer.py
RECFN_CONTRACT_ROOT=/path/to/checkout python -m pytest -q --asyncio-mode=auto tests
python -m pip check
```

These local results do not establish hosted CI after publication, live meeting
provider entitlement/capture, production recording/transcription, arbitrary
malformed entity handling, or the other original RecFn readiness gates. No live
provider was contacted, and no TypeScript product code was changed.
