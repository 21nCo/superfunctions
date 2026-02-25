# Phase 02: HTTP client core (all endpoints)

## Phase goal
Implement the `CiFnClient` class with all async HTTP methods, `CiFnConfig`, `create_cifn()` factory, and envelope unwrapping.

## In scope
- `cifn/python/cifn/client.py` with `CiFnConfig`, `CiFnClient`, `create_cifn()`
- Private `_request()` method for envelope unwrapping
- All async client methods: `create_run`, `list_runs`, `get_run`, `cancel_run`, `get_job_logs`, `get_artifacts`, `register_runner`, `runner_heartbeat`, `health`
- Context manager support (`async with`)
- `cifn/python/tests/conftest.py` with mock transport fixtures
- `cifn/python/tests/test_client.py` with success + error tests for all methods
- Update `__init__.py` exports

## Out of scope
- Sync wrappers (Phase 03)
- README (Phase 03)

## Deliverables

### `cifn/python/cifn/client.py`

**CiFnConfig (Pydantic BaseModel):**
- `base_url: str = "http://localhost:3100"`
- `api_key: Optional[str] = None`
- `token: Optional[str] = None`
- `timeout: float = 30.0`
- `verify_ssl: bool = True`
- Custom `__repr__` that redacts `api_key` and `token`
- `effective_token` property: returns `api_key or token`

**CiFnClient:**
- `__init__(self, config: CiFnConfig)`: Creates `httpx.AsyncClient` with base_url, timeout, verify, default auth header.
- `async _request(self, method: str, path: str, json: Optional[dict] = None, params: Optional[dict] = None, headers: Optional[dict] = None) -> dict`: Core request method:
  1. Sends HTTP request via self._http
  2. Parses JSON response
  3. If `ok: true`: returns `data` dict
  4. If `ok: false`: calls `raise_for_error()` with code, message, details, http_status
  5. On `httpx.ConnectError` / `httpx.TimeoutException`: raises `CiFnConnectionError`
  6. On non-JSON: raises `CiFnError` with `INTERNAL_ERROR`
- All async endpoint methods (see SPEC.md Public API for signatures)
- `async __aenter__` / `async __aexit__` for context manager
- `close()` to close httpx client

**create_cifn(config: CiFnConfig) -> CiFnClient**: Factory function.

### `cifn/python/tests/conftest.py`
- `mock_transport(responses: dict)`: Creates `httpx.MockTransport` that returns canned responses by path+method.
- `make_client(mock_transport) -> CiFnClient`: Creates client with mock transport for testing.

### `cifn/python/tests/test_client.py`
- Tests for each client method: success case, error case(s)
- Tests for `_request` envelope unwrapping (success, error, non-JSON, connection error)
- Tests for auth header presence
- Tests for `list_runs` limit clamping
- Tests for `health()` returning False on error
- Tests for `register_runner` and `runner_heartbeat`
- Tests for context manager
- Tests for config repr redaction

## Requirements covered
CFG-001, CFG-002, CFG-003, CLIENT-001 through CLIENT-010, ENV-001, ENV-002, SEC-001, SEC-003, TEST-001 (partial), TEST-002

## Implementation tasks
1. Create `CiFnConfig` class in `client.py` with all fields and custom repr
2. Create `CiFnClient.__init__` with httpx client setup
3. Implement `_request()` envelope handler
4. Implement `create_run()` method
5. Implement `list_runs()` method with limit clamping
6. Implement `get_run()` method
7. Implement `cancel_run()` method
8. Implement `get_job_logs()` method
9. Implement `get_artifacts()` method
10. Implement `register_runner()` method
11. Implement `runner_heartbeat()` method (with runner_secret auth override)
12. Implement `health()` method (returns bool, no raise)
13. Implement context manager methods
14. Create `create_cifn()` factory function
15. Create `tests/conftest.py` with mock transport
16. Create `tests/test_client.py` with all tests
17. Update `__init__.py` to export `CiFnClient`, `CiFnConfig`, `create_cifn`

## Verification steps
```bash
cd cifn/python
pytest tests/ -v
ruff check cifn/
black --check cifn/
mypy cifn/
```

**Expected outcomes:**
- All tests pass (including regression on test_types.py, test_errors.py).
- `ruff`, `black`, `mypy` all report zero errors.

## Stop condition
All TV-CLIENT-*, TV-CFG-*, TV-ENV-*, TV-SEC-* test vectors pass. All async client methods work against mock transport. Report back before starting Phase 03.
