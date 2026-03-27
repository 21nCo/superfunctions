# Phase goal

Provide Python parity for the core provider set and publish the final truthful provider readiness matrix.

# In scope / Out of scope

- In scope: Python core-provider exports and tests, provider matrix finalization, parity docs
- Out of scope: non-core providers beyond truthful matrix labeling

# Deliverables

- `plugfn/python/plugfn/providers/__init__.py`
- `plugfn/python/plugfn/providers/github.py`
- `plugfn/python/plugfn/providers/linear.py`
- `plugfn/python/plugfn/providers/clickup.py`
- `plugfn/python/plugfn/providers/gmail.py`
- `plugfn/python/tests/test_provider_parity.py`
- `plugfn/docs/provider-readiness-matrix.md`
- `plugfn/python/README.md`

# Requirements covered

- `PY-003`
- `PROVIDER-001`

# Implementation tasks

1. Export the core provider set from the Python package.
2. Implement or stub-with-explicit-unsupported-guard the core provider contract so matrix claims are truthful.
3. Add parity tests for import/export and basic action/trigger availability for GitHub, Linear, ClickUp, and Gmail.
4. Finalize the provider readiness matrix with TypeScript/Python readiness columns and support statuses.

# Verification steps

- Run `python3 -m pytest -q plugfn/python/tests/test_provider_parity.py`
- Run `python3 - <<'PY'\nfrom plugfn.providers import github_provider, linear_provider, clickup_provider, gmail_provider\nprint(github_provider.name, linear_provider.name, clickup_provider.name, gmail_provider.name)\nPY`
- Run `rg -n "github|linear|clickup|gmail" plugfn/docs/provider-readiness-matrix.md`
- Expected outcome: core Python provider imports resolve, parity tests pass, and the matrix explicitly reflects the same core provider set.

# Stop condition

Report the final core provider set and any providers left outside the production-ready claim.
