# PHASE_02: Logger & Hooks Infrastructure

## Phase Goal
Implement the logger interface, noop logger, and plugin hook system to enable observability and extensibility.

## In Scope
- DatafnLogger protocol
- Noop logger implementation
- Console logger implementation (simple)
- Plugin hook runner (before/after hooks)
- Plugin filtering by `runs_on`

## Out of Scope
- Wiring logger/hooks into handlers (Phase 7)
- Search plugin implementation
- WebSocket manager

## Deliverables

### New files
1. `datafn/python/datafn/logger.py` — Logger protocol + noop logger + console logger
2. `datafn/python/datafn/hooks.py` — Plugin hook runner

### Test files
3. `datafn/python/tests/test_logger.py` — Logger tests
4. `datafn/python/tests/test_hooks.py` — Hook runner tests

## Requirements Covered
- SRV-001, SRV-002

## Implementation Tasks

1. [ ] Create `logger.py`:
   - Define `DatafnLogger` Protocol with `info`, `warn`, `error`, `debug` methods
   - Each method signature: `(message: str, context: Optional[Dict[str, Any]] = None) -> None`
   - Implement `NoopLogger` class that does nothing
   - Implement `ConsoleLogger` class that prints to stdout
   - `create_logger(logger=None)` → returns provided logger or NoopLogger
2. [ ] Create `hooks.py`:
   - Define `HookContext` TypedDict: `{"env": str, "schema": dict, "context": Any}`
   - Define `HookError` TypedDict: `{"code": str, "message": str, "details": Optional[dict]}`
   - Implement `run_before_hook(plugins, env, hook_name, ctx, payload)`:
     - Filter plugins where `env in plugin.runs_on`
     - Call each plugin's hook method sequentially
     - If hook returns a modified payload, use it for next plugin (chaining)
     - If hook raises or returns error, stop immediately (fail-closed)
     - Return `{"ok": True, "value": final_payload}` or `{"ok": False, "error": error}`
   - Implement `run_after_hook(plugins, env, hook_name, ctx, payload, result)`:
     - Filter plugins where `env in plugin.runs_on`
     - Call each plugin's hook method sequentially
     - If hook raises, log error but continue (fail-open)
     - After hooks for queries can return transformed result
3. [ ] Write `tests/test_logger.py`:
   - NoopLogger doesn't raise
   - ConsoleLogger outputs to stdout (capture with capsys)
   - create_logger returns NoopLogger when None passed
4. [ ] Write `tests/test_hooks.py`:
   - Before hook: single plugin modifies payload
   - Before hook: first error stops chain (fail-closed)
   - Before hook: plugins filtered by runs_on
   - After hook: errors are swallowed (fail-open)
   - After hook: result transformation works
   - No plugins: returns original payload unchanged

## Verification Steps

```bash
cd datafn/python
python -m pytest tests/test_logger.py tests/test_hooks.py -v
```

**Expected outcomes:**
- Logger interface tests pass
- Hook runner tests pass with fail-closed/fail-open semantics

```bash
python -m pytest tests/ -v
```

**Expected outcomes:**
- All existing tests continue to pass

## Stop Condition
- Logger and hooks modules are implemented and tested
- Ready for Phase 7 (integration into server + handlers)
