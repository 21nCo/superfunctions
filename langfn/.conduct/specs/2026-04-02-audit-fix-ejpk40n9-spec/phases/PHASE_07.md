# Phase goal

Harden the LangFn HTTP surface so all route builders expose canonical envelopes with pluggable auth, validation, tenant scoping, and rate limiting.

# In scope

- Framework-agnostic route builders for `health`, `complete`, `chat`, `stream`, `embed`, `traces`, and `feedback`.
- Request validation, canonical success/error envelopes, and SSE streaming output.
- Pluggable auth, tenant/user/run/conversation headers, and tenant-aware rate limiting.
- Shared superfunctions HTTP/auth/secfn integration.

# Out of scope

- MCP transports and evaluation workflows.
- Provider transport pooling beyond what Phase 01 and Phase 09 establish.

# Deliverables

- `langfn/typescript/src/http/index.ts`
- `langfn/typescript/src/http/routes.ts`
- `langfn/typescript/src/http/auth.ts`
- `langfn/typescript/src/http/rate_limit.ts`
- `langfn/typescript/src/http/validation.ts`
- `langfn/typescript/src/index.ts`
- `langfn/typescript/tests/http-routes.test.ts`
- `langfn/python/langfn/http/__init__.py`
- `langfn/python/langfn/http/routes.py`
- `langfn/python/langfn/http/handlers.py`
- `langfn/python/langfn/http/auth.py`
- `langfn/python/langfn/http/rate_limit.py`
- `langfn/python/langfn/http/validation.py`
- `langfn/python/langfn/__init__.py`
- `langfn/python/tests/test_http_routes.py`

# Requirements covered

- `HTTP-001`
- `HTTP-002`
- `SEC-001`
- `ENG-001`

# Implementation tasks

1. Implement route builders for `health`, `complete`, `chat`, `stream`, `embed`, `traces`, and `feedback` using shared HTTP abstractions in both languages.
2. Normalize all success and error responses to the canonical HTTP envelopes from `SPEC.md`.
3. Add request validation for all non-health endpoints and return canonical `VALIDATION_ERROR` failures on invalid bodies.
4. Wire pluggable auth through shared superfunctions auth abstractions and require auth for all non-health endpoints.
5. Propagate tenant/user/run/conversation headers into trace metadata and rate-limit keys.
6. Implement tenant-aware rate limiting through `secfn` or equivalent shared security hooks instead of bespoke in-route counters.
7. Add HTTP integration tests that cover anonymous `/health`, authenticated success paths, validation errors, rate limiting, and SSE stream envelopes.

# Verification steps

1. Run `npm --prefix langfn/typescript test -- tests/http-routes.test.ts`.
   Expected outcome: TypeScript HTTP route tests pass for success, validation, auth, rate-limit, and SSE scenarios.
2. Run `python3 -m pytest langfn/python/tests/test_http_routes.py -q`.
   Expected outcome: Python HTTP route tests pass for the same cases.

# Stop condition

- Stop after the canonical HTTP route set is complete, non-health routes enforce auth plus rate limits, tenant context is propagated correctly, and the verification suites pass.
