# Architecture Sketch

## Modules and responsibilities

1. `packages/oauth-core`
   - Provider-agnostic OAuth state machine.
   - PKCE/state/nonce generation and validation.
   - Callback replay prevention and scope policy hooks.

2. `packages/oauth-http`
   - OAuth token/revoke transport.
   - Content-type aware serialization/parsing.
   - Retry and provider error normalization.

3. `packages/oauth-storage`
   - Durable state store interfaces/adapters.
   - Token vault interfaces/adapters.
   - Key-rotation-aware persistence contracts.

4. `packages/oauth-providers`
   - Provider descriptors and policy metadata.
   - Google/Microsoft/Yahoo/Apple/social provider manifests.

5. `packages/oauth-testing`
   - Deterministic test fixtures and mock provider servers.

6. `plugfn/typescript`
   - Connection manager, action executor, webhooks, workflows.
   - Email adapters and sync orchestrator.
   - Policy enforcement and operational APIs.

7. `plugfn/python`
   - Parity integration layer for core provider operations.

8. `authfn/ts-sdk`
   - Existing API key auth.
   - New social OAuth module using shared OAuth packages.

9. Shared operational assets
   - Runbooks, docs, migration guides, verification scripts.

## Dependency graph

1. `oauth-core` depends on `oauth-storage` interfaces only (no concrete adapter dependency).
2. `oauth-http` depends on provider descriptors from `oauth-providers`.
3. `oauth-providers` is data/config-focused and independent of runtime state.
4. `oauth-testing` depends on `oauth-core`, `oauth-http`, and mock adapters.
5. `plugfn` depends on `oauth-core`, `oauth-http`, `oauth-storage`, `oauth-providers`.
6. `authfn` social OAuth depends on same four shared packages.
7. Email adapters in `plugfn` depend on shared OAuth stack + provider policy registry.

# Phases Overview

- **Phase 00**: Baseline, inventory, and migration gates.
  - Delivered capability: verified baseline and explicit hardening backlog.
  - Verification: existing test/lint/build baseline + inventory reports.

- **Phase 01**: Build shared OAuth package skeletons.
  - Delivered capability: package topology and compile-safe interfaces.
  - Verification: per-package build/typecheck.

- **Phase 02**: Implement OAuth core and durable state/token storage.
  - Delivered capability: secure auth URL + callback + token vault primitives.
  - Verification: oauth-core/state/vault tests (positive + negative).

- **Phase 03**: Implement OAuth HTTP and provider manifests.
  - Delivered capability: standards-compliant token/revoke transport and provider descriptors.
  - Verification: mocked provider contract tests.

- **Phase 04**: Migrate `plugfn` OAuth internals to shared packages.
  - Delivered capability: `plugfn` connection flow uses shared OAuth stack.
  - Verification: `plugfn` connection tests + legacy duplication grep gates.

- **Phase 05**: Harden `plugfn` route auth, webhook security, and HTTP transport.
  - Delivered capability: fail-closed auth/webhook behavior and correct payload transport.
  - Verification: route/webhook/transport integration tests.

- **Phase 06**: Harden workflow, rate-limits, retries, metrics, and CLI diagnostics.
  - Delivered capability: crash-safe workflows and actionable operational tooling.
  - Verification: workflow idempotency tests + CLI test command checks.

- **Phase 07**: Gmail adapter implementation.
  - Delivered capability: full + incremental sync, watch renewal, policy enforcement.
  - Verification: adapter conformance + synthetic sync tests.

- **Phase 08**: Outlook adapter implementation.
  - Delivered capability: Graph subscription + delta sync with throttling compliance.
  - Verification: adapter conformance + delta token tests.

- **Phase 09**: Yahoo, iCloud, and generic IMAP/SMTP adapters.
  - Delivered capability: broad provider coverage with secure defaults.
  - Verification: adapter conformance matrix.

- **Phase 10**: Forwarding ingest and managed-mailbox safety controls.
  - Delivered capability: optional fallback ingest and guarded managed mailbox.
  - Verification: policy tests for opt-in, backup channel, and risk acknowledgment.

- **Phase 11**: Finatron parsing pipeline.
  - Delivered capability: deterministic-first financial extraction with model fallback.
  - Verification: parser golden vectors with confidence/provenance assertions.

- **Phase 12**: Fellotron outbound send governor and abuse controls.
  - Delivered capability: policy-gated sending with idempotent queue execution.
  - Verification: send-policy and throttle tests.

- **Phase 13**: `authfn` social OAuth integration.
  - Delivered capability: social sign-in using shared OAuth primitives.
  - Verification: `authfn` social login e2e tests + no-duplication checks.

- **Phase 14**: Security/compliance closure and production release gate.
  - Delivered capability: retention/export/delete, redaction, runbooks, docs, matrix gate.
  - Verification: full multi-workspace release checklist passes.

# Definition Of Done (Global)

No phase is complete unless its verification steps pass.

Global completion requires:

1. All MUST requirements in `REQUIREMENTS.md` are implemented and verified.
2. All positive and negative vectors in `TEST_VECTORS.md` are executed or automated equivalent checks are present.
3. `plugfn` and shared OAuth packages are production-ready under this spec’s failure-mode criteria.
4. Required adapters (Gmail, Outlook, Yahoo, iCloud, generic IMAP/SMTP, forwarding, managed-mail) pass conformance checks.
5. `authfn` social OAuth flow uses shared OAuth packages with no duplicated OAuth core logic.
6. Security, lifecycle, observability, runbook, and documentation gates pass.
