# Phase goal

Bring Python adapters and webhook handling up to the same auth-derived and raw-body-verified security contract as TypeScript.

# In scope / Out of scope

- In scope: FastAPI/Flask auth derivation, webhook raw-body verification, Python route-envelope parity
- Out of scope: Python core-provider expansion

# Deliverables

- `plugfn/python/plugfn/adapters/fastapi.py`
- `plugfn/python/plugfn/adapters/flask.py`
- `plugfn/python/plugfn/webhooks/webhook_handler.py`
- `plugfn/python/plugfn/core/connection_manager.py`
- `plugfn/python/tests/test_fastapi_auth.py`
- `plugfn/python/tests/test_flask_auth.py`
- `plugfn/python/tests/test_webhook_raw_body.py`

# Requirements covered

- `ROUTER-001`
- `AUTH-001`
- `WEBHOOK-001`
- `PY-002`

# Implementation tasks

1. Remove any HTTP-layer trust in `user_id` query/body input from FastAPI and Flask adapters.
2. Require auth-derived principal resolution for non-webhook routes.
3. Preserve raw request bytes for signed webhook verification.
4. Make missing-secret or resolver-failure paths fail closed.
5. Add Python tests that mirror the TypeScript auth and raw-body webhook guarantees.

# Verification steps

- Run `python3 -m pytest -q plugfn/python/tests/test_fastapi_auth.py plugfn/python/tests/test_flask_auth.py plugfn/python/tests/test_webhook_raw_body.py`
- Run `rg -n "user_id.*query|request\\.args|pass$|json.dumps\\(" plugfn/python/plugfn/adapters plugfn/python/plugfn/webhooks plugfn/python/plugfn/core`
- Expected outcome: targeted Python tests pass and the unsafe auth/webhook patterns are absent from the targeted files.

# Stop condition

Report the final Python auth-source-of-truth and the providers now covered by raw-body verification tests.
