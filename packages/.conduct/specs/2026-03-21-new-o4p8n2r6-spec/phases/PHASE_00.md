# Phase goal

Expand shared auth and HTTP contracts to support actor-centric sessions, cookies, and route metadata.

# In scope / Out of scope

- In scope: `packages/auth`, `packages/http`, Python shared HTTP/auth types
- Out of scope: OAuth orchestration changes

# Deliverables

- `packages/auth/src/types.ts`
- `packages/auth/src/index.ts`
- `packages/http/src/types.ts`
- `packages/http/src/index.ts`
- `packages/http/src/cookies.ts`
- `packages/python-core/superfunctions/auth/__init__.py`
- `packages/python-core/superfunctions/http/types.py`
- `packages/python-core/superfunctions/http/__init__.py`
- `packages/auth/src/__tests__/types.test.ts`
- `packages/http/src/__tests__/cookies.test.ts`

# Requirements covered

- `AUTH-001`
- `HTTP-001`
- `HTTP-002`

# Implementation tasks

1. Enrich shared auth subject/session/provider types.
2. Add route metadata typing for auth/OpenAPI usage.
3. Add cookie parse/serialize helpers in TypeScript.
4. Add explicit cookie models to Python shared HTTP types.
5. Add parity tests for TypeScript and Python auth/http types.

# Verification steps

- Run `npm test --workspace @superfunctions/auth`
- Run `npm test --workspace @superfunctions/http`
- Run `python -m pytest packages/python-core/tests`
- Expected outcome: type-level and runtime cookie/auth helpers behave deterministically in TS and Python.

# Stop condition

Report the final shared auth shape, route metadata shape, and cookie helper API.
