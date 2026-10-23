# Architecture Sketch

Modules and responsibilities:

- `packages/auth`
  - actor-centric auth session/provider abstractions
- `packages/http`
  - route metadata typing, cookie helpers
- `packages/http-openapi`
  - deterministic OpenAPI generation from route metadata
- `packages/oauth-core`
  - protocol primitives and intent modeling
- `packages/oauth-http`
  - token/revocation HTTP and runtime secret resolution
- `packages/oauth-storage`
  - reusable state/token/consent/revocation stores and schema
- `packages/oauth-flow`
  - orchestration, hooks, events, browser-auth and connection intents
- `packages/oauth-router`
  - reusable route factories on top of `@superfunctions/http`
- `packages/cli`
  - plugin-composed library discovery and schema generation
- `packages/python-core`
  - shared Python auth/oauth/http/openapi primitives
- `packages/python-fastapi`, `packages/python-flask`
  - adapter fidelity for cookies and metadata

# Dependency Graph

1. Expand `packages/auth` and `packages/http` contracts.
2. Add new OpenAPI package and Python HTTP cookie/OpenAPI support.
3. Extend OAuth core/http/storage.
4. Extend OAuth flow and add route factories.
5. Update provider registry/runtime secret handling.
6. Update CLI discovery/schema generation for plugin-composed scoped packages.
7. Harden Python adapters and shared contract tests.

# Phases Overview

- `Phase 00` → establish shared auth/http contracts → verify TS/Python type parity and cookie helpers
- `Phase 01` → extend OAuth core/http/storage → verify browser-auth intent and reusable schemas
- `Phase 02` → extend OAuth flow and add oauth-router → verify reusable route factories
- `Phase 03` → update provider registry/runtime secrets → verify Google/Apple/GitHub runtime behavior
- `Phase 04` → add shared OpenAPI generation → verify deterministic documents in TS/Python
- `Phase 05` → update CLI and testing harnesses → verify plugin-composed authfn schema discovery
- `Phase 06` → harden Python adapters and parity → verify repeated cookies and route metadata survive adapters

# Definition of Done

No phase is complete unless its verification steps pass.
