# Phase goal

Restore Python core parity so the package has valid models, synchronized metadata, and working shared infrastructure.

## In scope / Out of scope

- **In scope**:
  - Python version/license sync
  - Python model alias correctness
  - cache, rate-limit, retry, metrics, and logging wiring
  - canonical Python error classes
- **Out of scope**:
  - full Python provider completion
  - docs rewrite

## Deliverables

- `browsefn/python/pyproject.toml`
- `browsefn/python/browsefn/__init__.py`
- `browsefn/python/browsefn/core/types.py`
- `browsefn/python/browsefn/core/browse_fn.py`
- `browsefn/python/browsefn/core/cache_manager.py`
- `browsefn/python/browsefn/core/rate_limiter.py`
- `browsefn/python/browsefn/core/provider_manager.py`
- `browsefn/python/browsefn/middleware/retry.py`
- `browsefn/python/browsefn/middleware/logging.py`
- `browsefn/python/browsefn/middleware/metrics.py`
- `browsefn/python/tests/test_cache_manager.py`
- `browsefn/python/tests/test_rate_limiter.py`
- `browsefn/python/tests/test_provider_manager.py`
- `browsefn/python/tests/test_middleware.py`

## Requirements covered

- PKG-001
- PY-001
- CACHE-001
- RATE-001
- OBS-001

## Implementation tasks

1. Synchronize Python package version and metadata with the TypeScript package and docs.
2. Fix field alias handling so internal code uses valid Python attributes and serialized output still matches canonical names.
3. Wire cache, rate limits, retry, metrics, and logging into actual Python request execution paths.
4. Repair Python tests so they compile and reflect the canonical behavior.

## Verification steps

1. Run `python3 -m compileall browsefn/python/browsefn browsefn/python/tests`.
Expected: compileall exits `0`.
2. Run `python3 -m pytest browsefn/python/tests/test_cache_manager.py browsefn/python/tests/test_rate_limiter.py browsefn/python/tests/test_provider_manager.py browsefn/python/tests/test_middleware.py -q`.
Expected: tests pass.

## Stop condition

Report the synchronized Python version, the metrics alias fix, and the first clean Python compileall run.
