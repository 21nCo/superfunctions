# Python CI typing checkpoint — 2026-10-23

Baseline `734198210952cb3e6cdaf8593f859b90ad44ad2c` failed the actual normal
Python CI runner at Ruff (12 diagnostics). Import cleanup exposed 26 configured
mypy errors in previously untyped tests and the packed consumer. Production
source already passed its configured checks.

Tests and the consumer now annotate fixtures, callbacks, captured results and
adapter methods. Assertions narrow optional persisted runs before reading them.
Typed constructors use `ResultStatus`; four explicit wire-input cases retain
string-to-enum conversion coverage for every status. Invalid execution limits
remain checked at Pydantic's raw-input `model_validate` boundary. Existing
execution, retry, cancellation, phase, reporting, storage and image assertions
remain in place. No production runtime changes, dependency changes, type ignores,
check exclusions or lint/type configuration relaxations were needed.

Validation:

- Fresh Python 3.11.14 environment ran
  `node scripts/ci-run-python-package.mjs testfn/python` with its interpreter on
  PATH: normal dependency installation, wheel/sdist build, Ruff, configured mypy
  across all 18 source/test/script files, and **24 tests passed**. Current resolved
  versions include pytest 9.1.1, mypy 2.4.0, Ruff 0.17.2, Pydantic 2.14.1,
  SQLAlchemy 2.1.6 and Pillow 13.0.0.
- Independent wheel environments on Python 3.11.14/current dependencies and
  Python 3.10.19/exact runtime minima (pytest 9.0.3, Pydantic 2.5.0,
  SQLAlchemy 2.0.0, Pillow 12.3.0) each passed **24 copied tests**, `pip check`,
  and the consumer from outside the checkout with PYTHONPATH unset. The consumer
  verifies site-packages import and the shipped `py.typed`, real pytest class and
  parameter node IDs, environment propagation, expected failed result, SQLite
  close/reopen and JSON reporting. Strict mypy passes on this consumer in both
  environments. Full configured source/test typing also passes on actual 3.10.
- Black formatted the changed tests/consumer. Ruff and `git diff --check` pass.
  Full package typing is the existing configured policy, not a new claim of
  strict checking across the whole package.

No Shared merge was needed for this standalone Python package's CI prerequisites.
No TypeScript/browser/native-engine checks were rerun. Original readiness gates
remain: native Safari and exact historical IndexedDB engines, universal speedup
and deployment/SLA claims, hosted verification, and the prior branch-coverage
shortfall. Python's Windows descendant-process cleanup and legacy SQLite host
constraint migration limits remain documented in `python-readiness.md`.
Nothing was pushed, published, deployed or sent to providers.

Receipts retained in `/tmp`: `test-python-ci-initial-oct23.log`,
`test-python-ci-final-oct23.log`, `test-python-mypy-initial-oct23.log`,
`test-python310-types-oct23.log`, `test-python-format-oct23.log`, and
`test-wheel{310,311}-{install,consumer,tests}-oct23.log`. Temporary environments
and copied acceptance fixtures are removed after validation; logs are retained.
