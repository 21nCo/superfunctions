# Phase 24: Python Package

## Phase Goal
Implement the Python `apifn` package with FastAPI/Flask adapters, collection runner, and schema diff.

## In Scope
- `introspect_fastapi(app, config)` — extract/augment OpenAPI from FastAPI
- `introspect_flask(app, config)` — extract routes from Flask
- `read_collection(dir)` — read OpenCollection YAML
- `run_collection(collection, options)` — execute collection
- `diff_openapi(before, after)` — breaking change detection
- Python 3.10+ support

## Out of Scope
- Python UI components
- Python CLI (defer to TypeScript CLI)

## Deliverables
- `apifn/python/apifn/__init__.py`
- `apifn/python/apifn/config.py`
- `apifn/python/apifn/fastapi.py`
- `apifn/python/apifn/flask.py`
- `apifn/python/apifn/openapi.py`
- `apifn/python/apifn/collections.py`
- `apifn/python/apifn/diff.py`
- `apifn/python/tests/test_fastapi.py`
- `apifn/python/tests/test_flask.py`
- `apifn/python/tests/test_collections.py`
- `apifn/python/tests/test_diff.py`

## Requirements Covered
- PY-001, PY-002, PY-003, PY-004, PY-005

## Implementation Tasks
1. [ ] Set up pyproject.toml with dependencies: pyyaml, httpx, pydantic
2. [ ] Implement `ApifnConfig` dataclass
3. [ ] Implement `introspect_fastapi()`: call `app.openapi()`, augment with apifn metadata
4. [ ] Implement `introspect_flask()`: iterate `app.url_map`, build OpenAPI manually
5. [ ] Implement `read_collection()`: parse YAML files, build collection dict
6. [ ] Implement `run_collection()`: execute requests via httpx, collect results
7. [ ] Implement `diff_openapi()`: port TypeScript diff logic to Python
8. [ ] Write pytest tests for all functions
9. [ ] TV-PY-001: FastAPI introspection test
10. [ ] Verify `pip install -e .` works

## Verification Steps
1. `cd apifn/python && pip install -e . && pytest` → all tests pass
2. TV-PY-001: FastAPI app → valid OpenAPI dict
3. Collection runner executes requests and returns report
4. Diff produces same classifications as TypeScript version

## Stop Condition
All Python tests pass. FastAPI and Flask adapters produce valid OpenAPI. Report test count.
