# Survey SDK minimum Python runtime acceptance

2026-10-23, source head df8bb384ec7ad1745e7dbc83ce3787d0546cff01.

The declared contract is Python >=3.9 in userfn/python/pyproject.toml, with no
mandatory runtime dependencies and an optional surveys extra requiring
httpx>=0.27,<1. The built wheel retains Requires-Python >=3.9. This acceptance
uses the available Xcode CPython 3.9.6 interpreter, not a newer Python runtime.
It verifies the selected dependency set (HTTPX 0.28.1 / HTTPCore 1.0.9), not every
allowed dependency version or every Python 3.9 patch/platform combination.

## Source and wheel checks

Separate owned virtual environments were created with uv and Python 3.9.6.
The source environment used the normal editable [dev,surveys] install. All
**201 Python source tests passed in 11.58s**, including the 13 survey transport
cases for stable retry/payload, receipt validation, body bounds, permanent HTTP
status handling and deadlines. These 13 tests use HTTPX MockTransport; they are
not presented as server integration evidence.

The existing service tests/surveys-http.test.ts was separately run with
USERFN_SURVEY_PYTHON pointing to the 3.9.6 source environment. Its actual local
HTTP service and two SQLite connections passed the complete fixture (one test,
655ms test time / 1.95s process report). This includes Python submission, dropping
the first response after commit, same-key receipt replay, a second submission,
and 429 cap denial, alongside the existing TypeScript and durable policy cases.
The fixture closes its sockets and adapters.

A fresh isolated build produced wheel and sdist under Python 3.9.6. A separate
noneditable wheel environment installed only the surveys extra plus pytest for
validation. Under python -I, the import was verified inside that environment's
lib/python3.9/site-packages/userfn rather than the checkout. A copied survey test
file outside the checkout passed **13 tests in 0.17s**. The wheel environment did
not use the source pyproject's pythonpath setting.

Receipts:
- /tmp/userfn-survey39-source-install.log
- /tmp/userfn-survey39-source-tests.log
- /tmp/userfn-survey39-native-http.log
- /tmp/userfn-survey39-build.log
- /tmp/userfn-survey39-wheel-install.log
- /tmp/userfn-survey39-wheel-import.log
- /tmp/userfn-survey39-wheel-tests.log

## Installed-package HTTP fixture

The existing service/scripts/verify-survey-package.mjs fixture was run from a
temporary copy with only its checkout root and audit-output path set explicitly,
to avoid overwriting the earlier acceptance receipt. It normally packs and
installs seven local npm packages, runs real HTTP against the built UserFn
service, and invokes the separately installed Python wheel with python -I.
Its service storage is the shared memory adapter; durable SQLite evidence is the
separate source fixture above.

An initial attempt with system npm 10.8.2 failed inside npm with
"Cannot read properties of null (reading 'edgesOut')" before HTTP acceptance
(/tmp/userfn-survey39-packed-http.log). The rerun uses the existing npm 11.21.0
CLI at /Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js,
matching prior checkout acceptance, without peer-dependency bypasses or root
manifest/lockfile edits.

The npm11 rerun passed actual installed ESM/CJS/Python3.9-wheel HTTP submission,
lost-ACK retry, stable receipt replay, and cap denial. Both ESM and CJS consumer
declarations passed strict NodeNext typechecking. Seven local tarballs installed
normally; production audit reported zero vulnerabilities.
Receipts: /tmp/userfn-survey39-packed-http-npm11.log and
/tmp/userfn-survey39-packed-audit.json.

## Reproduction and cleanup

Use a Python3.9 interpreter to create separate source and wheel environments:

```sh
uv venv --python /path/to/python3.9 /tmp/userfn39-source
uv pip install --python /tmp/userfn39-source/bin/python -e './userfn/python[dev,surveys]'
/tmp/userfn39-source/bin/python -m pytest userfn/python/tests -q
/tmp/userfn39-source/bin/python -m build --outdir /tmp/userfn39-dist userfn/python
uv venv --python /path/to/python3.9 /tmp/userfn39-wheel
uv pip install --python /tmp/userfn39-wheel/bin/python '/tmp/userfn39-dist/userfn-0.1.0-py3-none-any.whl[surveys]'
# From userfn/service, with its normal installed dependencies:
USERFN_SURVEY_PYTHON=/tmp/userfn39-source/bin/python ../../node_modules/.bin/vitest run tests/surveys-http.test.ts
# From the repository root, after building the normal package closure:
USERFN_NPM_CLI=/path/to/npm11/bin/npm-cli.js USERFN_SURVEY_WHEEL_PYTHON=/tmp/userfn39-wheel/bin/python node userfn/service/scripts/verify-survey-package.mjs
```

All owned test/build/fixture processes exited. The fixture removed its temporary
npm consumer in finally. The two owned Python environments, copied fixture/test,
and wheel/sdist output directory were removed after preserving logs and audit
receipt; absence was read back. Shared npm/uv caches and prior environments owned
by other work were left intact. This is an evidence-only change: no runtime,
package metadata, lockfile or original requirement was altered, and no push or
deployment occurred. This verifies minimum-Python compatibility for explicit
survey submission; it does not complete survey eligibility/rendering or broader
UserFn readiness.
