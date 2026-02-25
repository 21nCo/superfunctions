# Phase 03: Sync wrappers, README, final packaging

## Phase goal
Add sync wrapper methods to the client, write a README with usage examples, and ensure the package is installable and all quality checks pass.

## In scope
- Sync wrapper methods on `CiFnClient` using `_sync.run_sync()`
- `cifn/python/tests/test_sync.py`
- `cifn/python/README.md` with usage examples
- Final `__init__.py` with complete `__all__`
- Full quality pass: ruff, black, mypy, pytest

## Out of scope
- Nothing; this is the final phase.

## Deliverables

### Sync wrappers in `cifn/python/cifn/client.py`
Add to `CiFnClient`:
- `create_run_sync(...)` -> calls `run_sync(self.create_run(...))`
- `list_runs_sync(...)` -> calls `run_sync(self.list_runs(...))`
- `get_run_sync(run_id)` -> calls `run_sync(self.get_run(run_id))`
- `cancel_run_sync(run_id)` -> calls `run_sync(self.cancel_run(run_id))`
- `get_job_logs_sync(run_id, job_key)` -> calls `run_sync(self.get_job_logs(...))`
- `get_artifacts_sync(run_id)` -> calls `run_sync(self.get_artifacts(run_id))`
- `register_runner_sync(token, labels)` -> calls `run_sync(self.register_runner(...))`
- `runner_heartbeat_sync(runner_id, runner_secret)` -> calls `run_sync(self.runner_heartbeat(...))`
- `health_sync()` -> calls `run_sync(self.health())`

### `cifn/python/tests/test_sync.py`
- Test each sync wrapper returns same result as async equivalent
- Test sync wrapper works when no event loop is running
- Test sync wrapper works when event loop is already running (if possible to test)

### `cifn/python/README.md`
- Package description
- Installation: `pip install cifn`
- Quick start: async and sync usage examples
- API reference summary (link to SPEC.md for details)
- Error handling example
- Configuration example

### Final `cifn/python/cifn/__init__.py`
Complete `__all__` with every public symbol:
- `__version__`, `__author__`, `__license__`
- `CiFnClient`, `CiFnConfig`, `create_cifn`
- All type models
- All enums
- All exceptions

## Requirements covered
SYNC-001, SYNC-002, TEST-003, PKG-003 (final), PKG-004

## Implementation tasks
1. Add sync wrapper methods to `CiFnClient`
2. Create `tests/test_sync.py` with wrapper tests
3. Create `README.md` with usage examples
4. Finalize `__init__.py` exports with complete `__all__`
5. Run full quality check: `ruff check cifn/`, `black --check cifn/`, `mypy cifn/`
6. Run full test suite: `pytest tests/ -v --cov=cifn`
7. Verify package installs cleanly: `pip install -e .`

## Verification steps
```bash
cd cifn/python
pip install -e ".[dev]"
pytest tests/ -v --cov=cifn --cov-report=term-missing
ruff check cifn/
black --check cifn/
mypy cifn/
python -c "from cifn import CiFnClient, CiFnConfig, create_cifn, Run, PipelineSpec, CiFnError; print('All imports OK')"
```

**Expected outcomes:**
- All tests pass with reasonable coverage (>90%).
- `ruff`, `black`, `mypy` all report zero errors.
- Package imports work cleanly.
- `pip install -e .` succeeds.

## Stop condition
Full test suite passes. All quality checks pass. Package is installable. README exists with working examples. All TV-SYNC-* vectors pass. Phase complete; spec implementation done.
