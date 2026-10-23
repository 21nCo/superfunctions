# Phase 00: Package scaffold and type definitions

## Phase goal
Set up the Python package structure and define all Pydantic models and enums.

## In scope
- `cifn/python/pyproject.toml` with hatchling, dependencies, dev deps, tool config
- `cifn/python/cifn/__init__.py` with version and stub exports
- `cifn/python/cifn/types.py` with all enums and Pydantic models
- `cifn/python/tests/__init__.py`
- `cifn/python/tests/test_types.py` with model validation tests

## Out of scope
- HTTP client, errors, sync wrappers, README

## Deliverables

### `cifn/python/pyproject.toml`
- Build system: hatchling
- Name: `cifn`, version `0.0.1`
- Python >=3.10
- Dependencies: `pydantic>=2.5.0`, `httpx>=0.27.0`
- Dev deps: pytest, pytest-asyncio, pytest-cov, mypy, ruff, black
- Tool config: ruff (E,W,F,I,B,C4), black (line-length 100), mypy (strict), pytest (asyncio_mode=auto)

### `cifn/python/cifn/types.py`
- Enums: `TriggerType`, `RunStatus`, `JobStatus`, `StepStatus`, `StepUsesType`, `ErrorCode`
- Pipeline models: `PipelineRef`, `TriggerInput`, `OnPush`, `OnPullRequest`, `OnSchedule`, `OnTriggers`, `RunStep`, `UsesStep`, `JobSpec`, `PipelineSpec`
- Runtime models: `Step`, `Job`, `Run`
- Response models: `CreateRunResult`, `ListRunsResult`, `CancelRunResult`, `Artifact`, `ArtifactList`, `JobLogLine`, `JobLogs`, `RegisterRunnerResult`, `HeartbeatResult`
- All models: `model_config = ConfigDict(populate_by_name=True)`

### `cifn/python/cifn/__init__.py`
- Export `__version__`, all types, enums (errors and client added in later phases)

### `cifn/python/tests/test_types.py`
- Test all enum values match expected strings
- Test PipelineSpec round-trip (deserialize camelCase -> access snake_case -> serialize camelCase)
- Test Run, Job, Step deserialization from server JSON
- Test response models (CreateRunResult, ListRunsResult, etc.)
- Test populate_by_name (both snake_case and camelCase construction)
- Test discriminated union for steps (RunStep vs UsesStep)
- Test missing optional fields default to None
- Negative: invalid enum value raises error
- Negative: missing required field raises ValidationError

## Requirements covered
PKG-001, PKG-002, PKG-003 (partial), TYPE-001, TYPE-002, TYPE-003, TYPE-004, TYPE-006, TYPE-007

## Implementation tasks
1. Create `cifn/python/pyproject.toml` following cachefn pattern
2. Create `cifn/python/cifn/__init__.py` with version and stub `__all__`
3. Create `cifn/python/cifn/types.py` with all enums
4. Add pipeline Pydantic models to `types.py`
5. Add runtime Pydantic models (Step, Job, Run) to `types.py`
6. Add response models to `types.py`
7. Create `cifn/python/tests/__init__.py`
8. Create `cifn/python/tests/test_types.py` with all model tests
9. Update `__init__.py` exports to include all types

## Verification steps
```bash
cd cifn/python
pip install -e ".[dev]"
pytest tests/test_types.py -v
ruff check cifn/
black --check cifn/
mypy cifn/types.py
```

**Expected outcomes:**
- All tests in `test_types.py` pass.
- `ruff check` reports zero errors.
- `black --check` reports no reformatting needed.
- `mypy` reports zero errors.

## Stop condition
All TV-TYPE-* and TV-CFG-001 test vectors pass. Types module is complete and tested. Report back before starting Phase 01.
