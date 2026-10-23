# BrowseFn Python Testing

Use these commands from the repository root.

## Install Editable Package

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e "browsefn/python[test]"
```

## Sanity Check

```bash
python3 - <<'PY'
from browsefn import __version__, browse_fn

print(__version__)
print(type(browse_fn()).__name__)
PY
```

Expected output:

- `0.1.0`
- `BrowseFn`

## Core Python Verification

```bash
python3 -m compileall browsefn/python/browsefn browsefn/python/tests
python3 -m pytest browsefn/python/tests/test_cache_manager.py browsefn/python/tests/test_rate_limiter.py browsefn/python/tests/test_provider_manager.py browsefn/python/tests/test_middleware.py -q
```

## API And Router Verification

```bash
python3 -m pytest browsefn/python/tests/test_web.py browsefn/python/tests/test_images.py browsefn/python/tests/test_geo.py browsefn/python/tests/test_router.py -q
```

## Notes

- The Python router relies on the shared package in `packages/python-core/`
- The test harness adds both repo-local Python package roots automatically
- Canonical emitted web provider id is `cheerio`; `bs4` and `beautifulsoup` remain accepted aliases
