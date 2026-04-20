# Phase goal

Make the Python SDK importable, test-green, and truthful about its maturity before security and provider parity work continues.

# In scope / Out of scope

- In scope: Python import-time failures, provider model correctness, README/SUMMARY/STATUS truth, parity baseline tests
- Out of scope: Python raw-body webhook verification and provider expansion

# Deliverables

- `plugfn/python/plugfn/types.py`
- `plugfn/python/plugfn/providers/__init__.py`
- `plugfn/python/plugfn/providers/github.py`
- `plugfn/python/tests/test_imports.py`
- `plugfn/python/README.md`
- `plugfn/python/SUMMARY.md`
- `plugfn/python/IMPLEMENTATION.md`
- `plugfn/.conduct/STATUS.md`

# Requirements covered

- `PY-001`
- `DOCS-001`

# Implementation tasks

1. Fix the provider model so import-time provider registration does not mutate undeclared fields.
2. Add a Python import/parity-baseline test that fails on collection-time errors.
3. Rewrite Python README/SUMMARY/IMPLEMENTATION language to match actual parity and maturity.
4. Ensure `plugfn/.conduct/STATUS.md` reflects the new cross-language truth.

# Verification steps

- Run `python3 -m pytest -q plugfn/python/tests`
- Run `rg -n "production ready|full parity|Coming Soon" plugfn/python/README.md plugfn/python/SUMMARY.md plugfn/python/IMPLEMENTATION.md plugfn/.conduct/STATUS.md`
- Expected outcome: pytest passes and maturity claims are mutually consistent and scoped to the provider matrix.

# Stop condition

Report the import-time root cause fixed and the exact maturity label chosen for Python after this phase.
