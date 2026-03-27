# Architecture sketch

Modules and responsibilities:

- `packages/oauth-core`
  - canonical intent-subject and runtime-config resolver contracts
  - redirect/state invariants used by higher layers
- `packages/oauth-http`
  - canonical token grant/auth-method and client-secret resolver contracts
  - shared token/revoke HTTP transport behavior
- `packages/oauth-storage`
  - encrypted token vault contract, reusable consent storage, and schema truth
- `packages/oauth-flow`
  - high-level orchestration, safe token persistence defaults, resolver parity, cleanup reporting, and redaction-safe events
- `packages/oauth-router`
  - reusable route factories with secure default metadata and override hooks
- `packages/oauth-providers`
  - curated provider policies plus durable consent/audit persistence interfaces
- `docs/content/docs/authentication`
  - package reference pages and navigation for the shared OAuth family
- `docs/content/docs/architecture`
  - architecture and migration guidance for the shared OAuth stack
- `repo root package.json`, `turbo.json`, package test configs
  - reproducible build/test gate for the shared OAuth family

# Dependency graph

1. Align type ownership and runtime-config resolution between `oauth-core`, `oauth-http`, and `oauth-flow`.
2. Harden `oauth-flow` token persistence defaults and disconnect semantics.
3. Harden `oauth-router` route metadata defaults against the new `oauth-flow` contracts.
4. Add durable provider-policy persistence and deterministic IDs in `oauth-providers`.
5. Update READMEs and docs pages so the public guidance matches the hardened contracts.
6. Add build/test resolution improvements and the shared OAuth release gate.
7. Run integrated regression verification across the full family.

# Phases overview

- `Phase 00` → align canonical type ownership and runtime-config resolver parity → verify `oauth-flow` consumes lower-level contracts without drift
- `Phase 01` → harden `oauth-flow` token persistence defaults → verify encrypted-required mode and explicit unsafe opt-in
- `Phase 02` → fix disconnect semantics and hook reporting → verify truthful cleanup flags and deterministic hook failures
- `Phase 03` → secure `oauth-router` defaults → verify authenticated route metadata defaults and explicit overrides
- `Phase 04` → add durable provider-policy persistence → verify async consent/audit storage and deterministic IDs
- `Phase 05` → repair docs and package ergonomics → verify README inventory, router docs page, and corrected production guidance
- `Phase 06` → make verification reproducible → verify package-local tests and the repo-root shared OAuth gate

# Definition of Done

No phase is complete unless its verification steps pass.
