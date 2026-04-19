# Phase goal

Complete the Python web, image, geo, and router surfaces so the documented Python package is genuinely usable.

## In scope / Out of scope

- **In scope**:
  - Python web/image/geo service behavior
  - router input conversion
  - canonical envelopes
  - Python provider registration and parity
- **Out of scope**:
  - TypeScript docs cleanup
  - duplication threshold cleanup

## Deliverables

- `browsefn/python/browsefn/web/scraper.py`
- `browsefn/python/browsefn/web/providers/bs4.py`
- `browsefn/python/browsefn/images/browser.py`
- `browsefn/python/browsefn/images/providers/unsplash.py`
- `browsefn/python/browsefn/images/providers/pixabay.py`
- `browsefn/python/browsefn/images/providers/pexels.py`
- `browsefn/python/browsefn/geo/geocoder.py`
- `browsefn/python/browsefn/geo/providers/nominatim.py`
- `browsefn/python/browsefn/geo/providers/google_maps.py`
- `browsefn/python/browsefn/geo/providers/mapbox.py`
- `browsefn/python/browsefn/http/router.py`
- `browsefn/python/tests/test_web.py`
- `browsefn/python/tests/test_images.py`
- `browsefn/python/tests/test_geo.py`
- `browsefn/python/tests/test_router.py`

## Requirements covered

- WEB-001
- WEB-002
- IMG-001
- IMG-002
- GEO-001
- HTTP-001
- PY-001
- SEC-001

## Implementation tasks

1. Convert router query/body dictionaries into typed models before invoking service methods.
2. Ensure Python services use provider fallback, canonical error codes, and canonical provider IDs.
3. Implement real image download writes and batch behavior in Python providers.
4. Complete Python geo provider registration and normalized results for search/details.
5. Add Python API and router tests that mirror the canonical vectors.

## Verification steps

1. Run `python3 -m pytest browsefn/python/tests/test_web.py browsefn/python/tests/test_images.py browsefn/python/tests/test_geo.py browsefn/python/tests/test_router.py -q`.
Expected: tests pass.
2. Run `python3 -m compileall browsefn/python/browsefn browsefn/python/tests`.
Expected: compileall exits `0`.

## Stop condition

Report the Python router envelope shape, the provider IDs emitted by Python, and the passing Python API test set.
