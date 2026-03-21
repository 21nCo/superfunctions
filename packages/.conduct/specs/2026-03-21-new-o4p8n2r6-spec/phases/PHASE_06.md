# Phase goal

Finalize Python shared OAuth/auth/openapi parity and harden FastAPI/Flask adapters.

# In scope / Out of scope

- In scope: `packages/python-core`, `packages/python-fastapi`, `packages/python-flask`
- Out of scope: downstream authfn implementation

# Deliverables

- `packages/python-core/superfunctions/oauth/core.py`
- `packages/python-core/superfunctions/oauth/http.py`
- `packages/python-core/superfunctions/oauth/storage.py`
- `packages/python-core/superfunctions/oauth/flow.py`
- `packages/python-core/superfunctions/oauth/__init__.py`
- `packages/python-fastapi/superfunctions_fastapi/adapter.py`
- `packages/python-fastapi/tests/test_cookies.py`
- `packages/python-flask/superfunctions_flask/adapter.py`
- `packages/python-flask/tests/test_cookies.py`

# Requirements covered

- `PY-001`
- `ADAPTER-001`
- `TEST-001`

# Implementation tasks

1. Add shared Python auth/oauth modules mirroring the TypeScript contracts needed by authfn.
2. Update FastAPI adapter to materialize multiple cookies and preserve route metadata.
3. Update Flask adapter to materialize multiple cookies and preserve route metadata.
4. Add parity tests and adapter-specific cookie tests.

# Verification steps

- Run `python -m pytest packages/python-core/tests packages/python-fastapi/tests packages/python-flask/tests`
- Build minimal FastAPI and Flask sample apps that issue session + CSRF cookies
- Expected outcome: both adapters emit repeated `Set-Cookie` headers and shared OpenAPI generation works.

# Stop condition

Report the Python module inventory, adapter behavior, and parity test results.
