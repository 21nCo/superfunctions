# Architecture sketch

## Modules and responsibilities

1. `plugfn/typescript/src/core`
   - Runtime orchestration, connection lifecycle, workflow lifecycle, and provider execution.

2. `plugfn/typescript/src/router`
   - Canonical route inventory, auth-derived principal resolution, HTTP envelopes, and raw-body handoff to webhook verification.

3. `plugfn/typescript/src/webhooks`
   - Provider event routing, raw-body verification, provider event normalization.

4. `plugfn/typescript/src/storage`
   - Shared DB-backed persistence for connections, OAuth state/tokens, workflows, and executions.

5. `plugfn/typescript/src/auth`
   - Thin legacy compatibility wrappers only; shared OAuth family remains the real implementation.

6. `plugfn/typescript/src/providers`
   - Provider implementations plus provider readiness metadata for the declared core provider set and any experimental/vertical providers.

7. `plugfn/python/plugfn`
   - Python parity runtime, adapters, provider exports, and security-equivalent route/webhook behavior.

8. `plugfn/cli`
   - Deterministic provider diagnostics and release-support tooling.

9. `plugfn/docs` + `plugfn/.conduct`
   - Truthful product contract, provider matrix, browser boundary, release-gate docs, and status artifacts.

10. `plugfn/scripts` or repo-root script wiring
   - Reproducible release gate and end-to-end verification entrypoints.

## Dependency graph

1. Contract/docs/package truth MUST land before any renewed production-ready claim.
2. Shared DB and first-class OAuth persistence MUST land before the legacy OAuth shim can be reduced safely.
3. Router/auth/webhook hardening MUST build on the shared persistence path.
4. Workflow durability and CLI diagnostics MUST build on the hardened runtime contract.
5. Python parity truth/importability MUST land before Python security parity.
6. Python security parity MUST land before Python core-provider parity.
7. Release gating MUST run only after TypeScript, CLI, Python, docs, and end-to-end surfaces exist.

# Phases overview

- Phase 00: reset the public contract, package surface, provider matrix, client boundary, and truthful docs.
  - Delivered capability: one coherent PlugFn product story and package contract.
  - Verification: repo-root grep/inventory checks for package names, readiness claims, matrix files, and absence of absolute paths.

- Phase 01: bind PlugFn runtime persistence cleanly to `@superfunctions/db` and add first-class OAuth storage modules.
  - Delivered capability: canonical DB/storage boundary with explicit OAuth state/token models.
  - Verification: TypeScript typecheck plus targeted storage contract tests.

- Phase 02: migrate TypeScript OAuth runtime fully onto shared stores and reduce the legacy path to a thin wrapper.
  - Delivered capability: no connection-record OAuth hacks and a wrapper-only legacy module.
  - Verification: callback/storage tests plus legacy-shim grep/tests.

- Phase 03: harden TypeScript route auth and raw-body webhook verification.
  - Delivered capability: fail-closed auth and byte-accurate webhook verification.
  - Verification: router auth tests, webhook signature tests, and provider-specific raw-body regression tests.

- Phase 04: close workflow lifecycle correctness and make CLI diagnostics real.
  - Delivered capability: trigger unregister correctness, durable delay/idempotency semantics, and useful `plugfn test`.
  - Verification: workflow lifecycle tests and CLI command tests.

- Phase 05: make Python importable/test-green and align Python docs/status with reality.
  - Delivered capability: trustworthy Python baseline and parity matrix truth.
  - Verification: `pytest` pass plus docs truth checks.

- Phase 06: harden Python adapters and webhook handling to match TypeScript security posture.
  - Delivered capability: auth-derived identity and raw-body verification in FastAPI/Flask/webhooks.
  - Verification: Python adapter auth/webhook tests.

- Phase 07: implement Python parity for the core provider set and publish the final provider matrix.
  - Delivered capability: core provider exports and parity coverage for GitHub, Linear, ClickUp, and Gmail.
  - Verification: provider import/action/trigger tests plus matrix inventory checks.

- Phase 08: add the repo-root PlugFn release gate and final end-to-end evidence path.
  - Delivered capability: authoritative production-readiness proof across runtime, CLI, Python, docs, and e2e OAuth/webhook checks.
  - Verification: `npm run gate:plugfn-release`.

# Definition of Done (global)

No phase is complete unless its verification steps pass.
