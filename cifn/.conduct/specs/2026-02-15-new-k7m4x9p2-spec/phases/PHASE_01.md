# Phase 01: Error hierarchy and envelope handling

## Phase goal
Define the exception hierarchy mapping CiFn error codes to Python exceptions, and the async-to-sync helper.

## In scope
- `cifn/python/cifn/errors.py` with all exception classes and error code mapping
- `cifn/python/cifn/_sync.py` with async-to-sync runner helper
- `cifn/python/tests/test_errors.py`
- Update `__init__.py` exports

## Out of scope
- HTTP client methods (Phase 02)
- Sync wrappers on client (Phase 03)

## Deliverables

### `cifn/python/cifn/errors.py`
- `CiFnError(Exception)`: Base exception with `code: str`, `message: str`, `details: Optional[dict]`, `http_status: Optional[int]`
- Subclasses (each with class-level `code` attribute):
  - `CiFnBadRequestError` (code=`BAD_REQUEST`)
  - `CiFnUnauthorizedError` (code=`UNAUTHORIZED`)
  - `CiFnRunnerTokenInvalidError` (code=`RUNNER_TOKEN_INVALID`)
  - `CiFnPipelineInvalidError` (code=`PIPELINE_INVALID`)
  - `CiFnRunCreateFailedError` (code=`RUN_CREATE_FAILED`)
  - `CiFnRunNotFoundError` (code=`RUN_NOT_FOUND`)
  - `CiFnRunAlreadyFinishedError` (code=`RUN_ALREADY_FINISHED`)
  - `CiFnRunnerNotFoundError` (code=`RUNNER_NOT_FOUND`)
  - `CiFnInternalError` (code=`INTERNAL_ERROR`)
  - `CiFnConnectionError` (no server code; for network/transport errors)
- `ERROR_CODE_MAP: Dict[str, Type[CiFnError]]` mapping code strings to exception classes
- `raise_for_error(code: str, message: str, details: Optional[dict], http_status: int) -> NoReturn` helper

### `cifn/python/cifn/_sync.py`
- `run_sync(coro: Coroutine[Any, Any, T]) -> T`: Runs an async coroutine synchronously.
  - If no event loop is running: use `asyncio.run()`.
  - If an event loop is already running: use `concurrent.futures.ThreadPoolExecutor` to run in a new thread with its own loop.

### `cifn/python/tests/test_errors.py`
- Test each exception subclass has correct `code` attribute
- Test `ERROR_CODE_MAP` maps all `ErrorCode` enum values
- Test `raise_for_error` raises correct subclass for each code
- Test `raise_for_error` with unknown code raises base `CiFnError`
- Test `CiFnError` attributes: code, message, details, http_status
- Test `CiFnConnectionError` has no code attribute
- Test `str(exception)` includes code and message but NOT tokens

## Requirements covered
TYPE-005, ENV-002, ENV-003, SEC-002, SYNC-002 (partial: helper only)

## Implementation tasks
1. Create `cifn/python/cifn/errors.py` with base exception class
2. Add all exception subclasses with `code` class attribute
3. Add `ERROR_CODE_MAP` dict
4. Add `raise_for_error()` helper function
5. Create `cifn/python/cifn/_sync.py` with `run_sync()` helper
6. Create `cifn/python/tests/test_errors.py`
7. Update `cifn/python/cifn/__init__.py` to export all errors

## Verification steps
```bash
cd cifn/python
pytest tests/test_errors.py -v
pytest tests/test_types.py -v  # regression check
mypy cifn/errors.py cifn/_sync.py
```

**Expected outcomes:**
- All tests in `test_errors.py` pass.
- All tests in `test_types.py` still pass (regression).
- `mypy` reports zero errors.

## Stop condition
All TV-ENV-003, TV-ENV-006, TV-ENV-007, TV-SEC-002 test vectors pass. Error hierarchy complete and tested. Report back before starting Phase 02.
