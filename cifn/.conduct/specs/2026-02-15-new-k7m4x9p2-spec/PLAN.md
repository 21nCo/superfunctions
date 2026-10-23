# CiFn Python SDK Implementation Plan

## Architecture sketch

```
cifn/python/
├── pyproject.toml              # hatchling build, deps: pydantic, httpx
├── cifn/
│   ├── __init__.py            # Exports: CiFnClient, CiFnConfig, create_cifn, models, enums, errors
│   ├── client.py              # CiFnClient class, factory function, _request() envelope handler
│   ├── types.py               # Pydantic models: PipelineSpec, Run, Job, Step, responses, enums
│   ├── errors.py              # CiFnError hierarchy, error code mapping, CiFnConnectionError
│   └── _sync.py               # Sync wrapper helper (run async in sync context)
├── tests/
│   ├── __init__.py
│   ├── conftest.py            # Shared fixtures (mock transport, client factory)
│   ├── test_types.py          # Pydantic model validation tests
│   ├── test_errors.py         # Exception hierarchy tests
│   ├── test_client.py         # HTTP client method tests (mock transport)
│   └── test_sync.py           # Sync wrapper tests
└── README.md                  # Usage examples
```

**Module responsibilities:**
- `types.py`: All Pydantic models (pipeline config, runtime objects, response models) and enums. No I/O.
- `errors.py`: Exception hierarchy and error code -> exception mapping. No I/O.
- `client.py`: `CiFnConfig`, `CiFnClient` (async methods + sync wrappers), `create_cifn()` factory. Owns httpx client lifecycle and envelope unwrapping.
- `_sync.py`: Private helper to run async coroutines in sync context (handles running event loop edge case).
- `__init__.py`: Re-exports all public symbols.

## Dependency graph

1. **`types.py`** (no deps except pydantic): Enums and Pydantic models. Must exist first.
2. **`errors.py`** (depends on `types.py` for `ErrorCode` enum): Exception classes and mapping dict.
3. **`_sync.py`** (no project deps): Async-to-sync helper utility.
4. **`client.py`** (depends on `types.py`, `errors.py`, `_sync.py`, httpx): HTTP client with all methods.
5. **`__init__.py`** (depends on all above): Re-exports.
6. **`tests/`** (depends on all above): Test suite.
7. **`pyproject.toml`** + **`README.md`**: Package config and docs.

## Phases overview

| Phase | Goal | Delivered capability | Verification |
|-------|------|----------------------|--------------|
| 00 | Package scaffold and types | pyproject.toml, enums, all Pydantic models, `__init__.py` stubs | `pytest tests/test_types.py` passes; all TV-TYPE-* vectors pass |
| 01 | Error hierarchy and envelope handling | Exception classes, error mapping, `_sync.py` helper | `pytest tests/test_errors.py` passes; all TV-ENV-* vectors pass |
| 02 | HTTP client core (runs endpoints) | `CiFnClient` with `create_run`, `list_runs`, `get_run`, `cancel_run`, `get_job_logs`, `get_artifacts`, `health` | `pytest tests/test_client.py` passes; all TV-CLIENT-* vectors pass |
| 03 | Runner endpoints, sync wrappers, packaging | `register_runner`, `runner_heartbeat`, all sync wrappers, README, final packaging | `pytest` all passes; `ruff`, `black`, `mypy` pass; package installable |

## Definition of Done (global)

No phase is complete unless:
1. All deliverables for that phase are implemented and committed.
2. Verification steps for that phase pass (exact commands in phases/PHASE_XX.md).
3. Test vectors referenced in the phase are passing.
4. No regressions: existing test vectors from earlier phases still pass.
