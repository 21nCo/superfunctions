# Phase goal

Complete Python parity for the full authfn surface.

# In scope / Out of scope

- In scope: parity gaps across routes, hooks, schemas, errors, adapter integration
- Out of scope: framework-specific Python UI helpers

# Deliverables

- `authfn/python/authfn/config.py`
- `authfn/python/authfn/errors.py`
- `authfn/python/authfn/http.py`
- `authfn/python/tests/test_sessions.py`
- `authfn/python/tests/test_password.py`
- `authfn/python/tests/test_openapi.py`

# Requirements covered

- `PY-001`

# Implementation tasks

1. Normalize Python config and error models to match TypeScript semantics.
2. Ensure Python route handlers match path names and envelope shapes.
3. Verify cookie propagation through FastAPI and Flask adapters using shared package updates.
4. Add parity tests for sessions, password, OTP, social, API keys, 2FA, and multi-region.

# Verification steps

- Run `python -m pytest authfn/python/tests`
- Run representative FastAPI and Flask smoke apps locally
- Expected outcome: Python behavior matches the TypeScript contract and no cookie/header loss occurs.

# Stop condition

Report parity matrix and any intentionally undefined Python-only differences; there should be none for in-scope behavior.
