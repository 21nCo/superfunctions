# Phase goal

Add shared OpenAPI generation for TypeScript and Python routes.

# In scope / Out of scope

- In scope: new `http-openapi` package and Python `superfunctions.http.openapi`
- Out of scope: CLI discovery

# Deliverables

- `packages/http-openapi/package.json`
- `packages/http-openapi/tsconfig.json`
- `packages/http-openapi/src/index.ts`
- `packages/http-openapi/src/generate.ts`
- `packages/http-openapi/src/__tests__/generate.test.ts`
- `packages/python-core/superfunctions/http/openapi.py`
- `packages/python-core/tests/test_openapi.py`

# Requirements covered

- `OPENAPI-001`
- `HTTP-001`
- `HTTP-002`

# Implementation tasks

1. Define the required route metadata contract for inclusion in OpenAPI.
2. Implement deterministic OpenAPI generation for TS routers.
3. Implement equivalent Python OpenAPI generation from Python routes.
4. Add tests for missing metadata failures and stable output.

# Verification steps

- Run `npm test --workspace @superfunctions/http-openapi`
- Run `python -m pytest packages/python-core/tests/test_openapi.py`
- Expected outcome: stable OpenAPI output is generated in TS and Python and incomplete metadata fails clearly.

# Stop condition

Report generator inputs, output guarantees, and failure behavior.
