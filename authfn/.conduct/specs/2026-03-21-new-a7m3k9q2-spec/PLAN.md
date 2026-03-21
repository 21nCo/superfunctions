# Architecture Sketch

Modules and responsibilities:

- `authfn/core`
  - user/session kernel
  - plugin runtime and hook runner
  - core schema composer
  - route composer using `@superfunctions/http`
  - `@superfunctions/auth` provider
- `authfn/core` bundled plugins
  - password
  - email OTP
  - social OAuth
  - API keys
  - 2FA
  - multi-region
- `authfn/client`
  - typed browser client with cookie-aware fetch behavior
- `authfn/svelte`
  - thin Svelte adapters over `authfn/client`
- `authfn/python`
  - mirrored server-side behavior and plugins over Python shared abstractions

Dependencies:

- Shared OAuth packages provide protocol/state/token/provider logic.
- Shared HTTP/OpenAPI packages provide routing, cookies, and schema generation support.
- `@superfunctions/cli` consumes `getSchema()` output and plugin-contributed schemas.

# Dependency Graph

1. Shared packages spec delivers enriched `@superfunctions/auth`, `@superfunctions/http` helpers, shared OAuth improvements, Python OAuth parity, and shared OpenAPI support.
2. `authfn/core` package layout and plugin runtime are created.
3. User/session kernel and schema composer are implemented.
4. Password and OTP plugins build on the kernel.
5. Social OAuth plugin builds on shared OAuth packages.
6. API key and 2FA plugins build on the kernel and plugin runtime.
7. Multi-region plugin builds on runtime resolver, hooks, and shared OAuth runtime config.
8. Client packages and Python parity finalize the surface.

# Phases Overview

- `Phase 00` → establish package layout and plugin/core contracts → verify package builds and schema composition stubs
- `Phase 01` → implement user/session kernel and HTTP surface skeleton → verify cookie/session round-trips locally
- `Phase 02` → implement password plugin and browser client core → verify sign-up/sign-in/get-session
- `Phase 03` → implement OTP plugin and challenge delivery interfaces → verify verification/sign-in/reset flows
- `Phase 04` → implement social OAuth plugin on shared OAuth packages → verify Google/Apple/GitHub flows with fixtures
- `Phase 05` → implement API key and 2FA plugins → verify bearer auth and second-factor challenges
- `Phase 06` → implement bundled multi-region plugin and runtime resolution → verify lookup, mismatch, and runtime overrides
- `Phase 07` → implement Python parity → verify matching routes, schemas, cookies, and plugin behavior
- `Phase 08` → implement Svelte adapter, OpenAPI output, and end-to-end hardening → verify full browser integration matrix

# Definition of Done

No phase is complete unless its verification steps pass.
