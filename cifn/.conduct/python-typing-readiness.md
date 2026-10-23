# Python constructor and CI typing readiness

Date: 2026-10-23. Baseline: `592e21b018059a26736230ccda5d4336b3290135`.

The actual shared Python CI runner reproduced the hosted failure: strict mypy
reported 15 errors in four test files after normal installation, wheel/sdist build
and successful Ruff. The errors exposed aliased Pydantic constructor/default
inference, raw string enum inputs, an imprecise exception-class annotation, and
unparameterized dictionaries.

## Changes

Aliased fields now express wire aliases through `Annotated` metadata and optional
fields have explicit `None` assignments. Static Python constructors therefore use
Python field names and correct optional defaults without requiring a Pydantic mypy
plugin. Runtime aliases, `populate_by_name`, enum conversion and serialization
remain intact. All 22 model JSON schemas compared exactly equal before/after under
Pydantic 2.14.1. No field or validation rule was removed.

The raw snake-case/camelCase string-enum and missing-required-field tests now call
`model_validate`, preserving deliberate wire-input conversion and failure coverage.
Typed constructors continue to exercise `JobSpec(runs_on=...)`, optional `RunStep`
fields and `PipelineRef` defaults. Captured headers/query parameters are typed as
string dictionaries, and error subclass fixtures use `type[CiFnError]`.

The wheel now contains `cifn/py.typed`. A plugin-free strict consumer fixture checks
Python-name constructors, omitted and supplied optional aliased fields, enum
values, wire validation and alias serialization. No type ignores, excluded tests,
weakened strictness settings, dependency caps or dependency additions were used.
The existing minimum Python 3.10 mypy target remains unchanged.

## Validation

| Environment | Result |
| --- | --- |
| Fresh Python 3.11.14; Pydantic 2.14.1; mypy 2.4.0; pytest 9.1.1 | Actual `scripts/ci-run-python-package.mjs cifn/python` passes normal editable installation, wheel+sdist build, Ruff, strict mypy over all 12 source/test files, and 81 tests |
| Fresh installed wheel, Python 3.11.14 / Pydantic 2.14.1 | Strict constructor consumer, consumer runtime, all 81 tests, and `pip check` pass |
| Actual Python 3.10.19 / Pydantic 2.5.0, full source checks | Strict mypy over all 12 files and Ruff pass |
| Fresh installed wheel, Python 3.10.19 / declared-minimum Pydantic 2.5.0 | Strict constructor consumer, consumer runtime, all 81 tests, and `pip check` pass |

Minimum-Pydantic installation used the explicit test-environment requirement
`pydantic==2.5.0` with normal pip resolution; the package dependency remains
`pydantic>=2.5.0`. Each wheel test ran copied tests outside the checkout with
`PYTHONPATH` unset. Import readback confirmed `site-packages/cifn/__init__.py`.
The wheel was inspected for `cifn/py.typed`; its SHA-256 was
`23da7574fd69a351f886a3dfb09d20524ea0eee67ddfbe5301ea48571acb2a71`.

Local logs:

- `/tmp/ci-python311-baseline-ci-oct23.log`
- `/tmp/ci-python311-fixed-ci-oct23.log`
- `/tmp/ci-python-model-schemas-before-oct23.json`
- `/tmp/ci-wheel310-oct23.log` and `/tmp/ci-wheel311-oct23.log`
- `/tmp/ci-python310-full-{types,ruff}-oct23.log`

Reproduction, using the intended interpreter on `PATH`:

```sh
python -m pip install --upgrade pip build
node scripts/ci-run-python-package.mjs cifn/python
# In separate wheel environments with tests copied outside the checkout:
python -m mypy --strict tests/typing_consumer.py
python tests/typing_consumer.py
python -m pytest -q --asyncio-mode=auto tests
python -m pip check
```

These checks verify the Python package and its existing local transport fixtures.
They do not prove a deployed control plane, provider delivery, runner execution,
remote log persistence, or hosted CI success after publication. Existing CiFn
readiness limitations remain in force; no TypeScript/runtime features were changed.
