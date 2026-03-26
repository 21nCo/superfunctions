# Plan

## Architecture Sketch

- `authfn/examples/shared`
  - deterministic fixtures, demo routes, event capture, OTP inbox helpers, fake OAuth provider, selector constants, Playwright helpers
- `authfn/examples/<scenario>`
  - root package scripts plus Playwright config and scenario README
- `authfn/examples/<scenario>/server`
  - Express server, `createAuthFn(...)`, CLI config, Drizzle config, generated auth schema import, scenario seed/reset hooks
- `authfn/examples/<scenario>/client`
  - Svelte 5 + Vite client using official authfn browser APIs
- `@authfn/core`
  - package metadata for CLI discovery, schema resolution for static bundled-plugin descriptors
- `@authfn/client`
  - additive methods needed by examples
- `@superfunctions/cli`
  - function-call descriptor preservation sufficient for `authfn` schema generation

## Dependency Graph

1. CLI/authfn integration MUST exist before generated-schema server flows can work.
2. Shared harness MUST exist before the scenario apps can reuse seed/demo logic.
3. Client API expansion MUST exist before account-settings and multi-region examples can use official typed methods.
4. Individual examples depend on shared harness plus generated schema flow.
5. Portfolio docs and full verification depend on all example roots being in place.

## Phases Overview

- `Phase 00`
  - Goal: make CLI-backed authfn schema generation real.
  - Delivered capability: `@authfn/core` is discoverable by `@superfunctions/cli`, bundled plugin descriptors resolve, and auth example servers can generate Drizzle schemas.
  - Verification: CLI tests and example-style schema generation command.
- `Phase 01`
  - Goal: scaffold the portfolio and shared harness.
  - Delivered capability: workspace wiring, shared package, shared README, shared reset/event/inbox/provider helpers.
  - Verification: workspace install/build plus reset/event smoke checks.
- `Phase 02`
  - Goal: implement `password-sessions`.
  - Delivered capability: focused password/session example with Playwright.
  - Verification: `db:generate`, `db:push`, `test:e2e`.
- `Phase 03`
  - Goal: implement `otp-recovery`.
  - Delivered capability: OTP inbox, verify-email, OTP sign-in, password reset, Playwright.
  - Verification: `db:generate`, `db:push`, `test:e2e`.
- `Phase 04`
  - Goal: implement `social-oauth`.
  - Delivered capability: local fake providers, callback completion, disconnect, Playwright.
  - Verification: `db:generate`, `db:push`, `test:e2e`.
- `Phase 05`
  - Goal: implement `account-settings` and client API expansion.
  - Delivered capability: typed client methods for API keys/2FA/runtime/region plus settings example and Playwright.
  - Verification: `@authfn/client` tests and example `test:e2e`.
- `Phase 06`
  - Goal: implement `multi-region-routing`.
  - Delivered capability: dual-authority local demo with region lookup and wrong-authority correction.
  - Verification: dual-server Playwright suite.
- `Phase 07`
  - Goal: portfolio polish and full-matrix verification.
  - Delivered capability: final docs, selector contract checks, deterministic no-external-network verification.
  - Verification: run all example suites and shared validation checks.

## Definition Of Done

No phase is complete unless its verification steps pass.
