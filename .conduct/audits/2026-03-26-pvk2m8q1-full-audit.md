# PlugFn Full Audit

## Metadata

- Timestamp: `2026-03-26T23:19:49+05:30`
- Auditor: Codex
- Model: `unknown` (model identifier was not surfaced in-thread)
- Launcher: `Codex Desktop`
- Command: `audit`
- Repository: `superfunctions`
- Commit: `5092916`
- Branch: `detached HEAD`
- Scope root: `plugfn/`
- Environment: `Darwin arm64`, `zsh`, timezone `Asia/Kolkata`
- Evidence mode: read-only code/spec/doc audit plus command-based verification
- Sanitization note: paths and command summaries below are reported repo-relative
- Final verdict: `plugfn` is not production-ready to become the default shared integration runtime for broad app usage across GitHub, Linear, Google-class integrations, webhooks, OAuth, and Python parity.

## Audit scope

This audit evaluates whether `plugfn` can safely serve as the default integration layer for apps built in this repository ecosystem, with emphasis on:

- shared-package alignment with `@superfunctions/db` and `@superfunctions/http`
- reusable OAuth and webhook infrastructure
- provider surface for GitHub, Linear, ClickUp, and Google-adjacent integrations
- operational hardening, security, verification, and release readiness
- TypeScript runtime quality, CLI usefulness, and Python parity
- whether the documented product contract matches what is actually implemented

## Inputs audited (intent + spec bundles)

Intent and product docs:

- In-thread user request dated `2026-03-26`
- `plugfn/README.md`
- `plugfn/SPEC.md`
- `plugfn/typescript/README.md`
- `plugfn/python/README.md`
- `plugfn/python/IMPLEMENTATION.md`
- `plugfn/python/SUMMARY.md`
- `plugfn/docs/architecture.md`
- `plugfn/docs/getting-started.md`
- `plugfn/docs/architecture/hardening-baseline.md`
- `plugfn/docs/architecture/provider-policy-matrix.md`
- `plugfn/docs/operations/release-gates.md`
- `plugfn/docs/providers/github.md`
- `plugfn/docs/providers/linear.md`
- `plugfn/docs/providers/clickup.md`
- `plugfn/.conduct/STATUS.md`

Spec bundles:

- `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/INTENT_AUDIT.md`
- `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/REQUIREMENTS.md`
- `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/SPEC.md`
- `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/PLAN.md`
- `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/TEST_VECTORS.md`
- `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/phases/PHASE_00.md` through `PHASE_14.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/INTENT_AUDIT.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/REQUIREMENTS.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/SPEC.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/PLAN.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/TEST_VECTORS.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/RELEASE_GATE.md`
- `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/phases/PHASE_00.md` through `PHASE_18.md`
- `.conduct/specs/2026-03-18-change-3dhqe3l2-spec/INTENT_AUDIT.md`
- `.conduct/specs/2026-03-18-change-3dhqe3l2-spec/REQUIREMENTS.md`
- `.conduct/specs/2026-03-18-change-3dhqe3l2-spec/SPEC.md`
- `.conduct/specs/2026-03-18-change-3dhqe3l2-spec/PLAN.md`
- `.conduct/specs/2026-03-18-change-3dhqe3l2-spec/TEST_VECTORS.md`
- `.conduct/specs/2026-03-18-change-3dhqe3l2-spec/phases/PHASE_00.md` through `PHASE_09.md`

Implementation surfaces sampled:

- `plugfn/typescript/src/**`
- `plugfn/typescript/tests/**`
- `plugfn/cli/src/**`
- `plugfn/python/plugfn/**`
- `plugfn/python/tests/**`

## High-level findings

- Critical: The Python SDK is not production-ready and does not provide parity. `python3 -m pytest -q` fails during collection because `plugfn/python/plugfn/providers/github.py` mutates a Pydantic `Provider` model with undeclared `auth_config`, and `plugfn/python/plugfn/providers/__init__.py` exports only GitHub and Slack. This directly contradicts `plugfn/python/IMPLEMENTATION.md` and `plugfn/python/SUMMARY.md`.
- Critical: The package/distribution contract is contradictory. The actual TypeScript package is `plugfn` in `plugfn/typescript/package.json`, and the CLI package is `@plugfn/cli` in `plugfn/cli/package.json`, while core docs tell users to install `@superfunctions/plugfn` and `@superfunctions/plugfn-cli`.
- Critical: Shared OAuth hardening is incomplete. `plugfn/typescript/src/core/connection-manager.ts` uses `@superfunctions/oauth-flow`, but still persists OAuth state and tokens through synthetic connection records (`__oauth_state_system__`, `__oauth_token_system__`) instead of the first-class `@superfunctions/db` storage path required by the 2026-03-12 hardening spec.
- Critical: The legacy OAuth compatibility path is not thin. `plugfn/typescript/src/auth/oauth-flow.ts` still owns state-store defaults, token exchange logic, refresh logic, and provider descriptor translation, despite the spec requiring a wrapper-only shim.
- High: Webhook verification is not production-hard for real providers. GitHub, Linear, ClickUp, and the Python webhook handler all compute HMACs over `JSON.stringify(payload)` or equivalent JSON reserialization instead of the raw request body bytes that provider signatures are typically based on.
- High: Route auth is only partially hardened. The TypeScript router can enforce caller identity when an explicit `authenticate` function is supplied, but its fallback accepts bearer tokens as raw user IDs and does not automatically consume `PlugFnConfig.auth`. The Python FastAPI and Flask adapters still trust request/query `user_id` inputs or contain `pass` placeholders where auth-derived identity should exist.
- High: Workflow disable/delete does not actually unregister live handlers. `plugfn/typescript/src/core/workflow-engine.ts` calls `unregisterTrigger()` on disable/delete, but the method is a log-only no-op.
- High: Documentation and status artifacts materially overstate readiness. `plugfn/.conduct/STATUS.md` claims "Production Ready"; `plugfn/python/SUMMARY.md` claims full parity and production readiness; `plugfn/python/README.md` simultaneously says "Coming Soon"; and several release docs still contain machine-specific absolute paths.
- Medium: The product scope is internally conflicted. The user intent and top-level docs describe a general shared integration runtime, but the March 11 spec bundle pivots heavily into Finatron/Fellotron mail ingestion, managed mailboxes, and finance-specific controls. That scope drift makes current "readiness" claims ambiguous and hard to trust.
- Medium: There is no explicit, supported browser/client SDK contract. `plugfn/README.md` positions the TypeScript SDK as "Full-featured SDK for Node.js and TypeScript applications," which is server-first. A safe client-side SDK boundary is not specified.

## Intent Inventory

| Intent ID | Intent | Primary sources | Observed status |
| --- | --- | --- | --- |
| INT-U01 | Make `plugfn` the default shared integration runtime across apps | user request, `plugfn/README.md`, `plugfn/SPEC.md` | Partial |
| INT-U02 | Handle OAuth through shared packages and safe persistence | user request, `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/REQUIREMENTS.md` | Partial |
| INT-U03 | Automatically expose webhook/OAuth HTTP routes via `@superfunctions/http` | user request, `plugfn/typescript/README.md`, `plugfn/docs/getting-started.md` | Partial |
| INT-U04 | Use `@superfunctions/db` as the shared persistence contract | user request, `.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/REQUIREMENTS.md` | Partial |
| INT-U05 | Provide broad reusable provider coverage for GitHub, Linear, Google-like app integrations | user request, `plugfn/README.md`, `plugfn/SPEC.md`, `.conduct/specs/2026-03-18-change-3dhqe3l2-spec/REQUIREMENTS.md` | Partial |
| INT-U06 | Be production-safe for security, operations, and failure behavior | user request, `plugfn/.conduct/STATUS.md`, `plugfn/docs/operations/release-gates.md`, spec bundles | Fail |
| INT-U07 | Provide a client-side SDK only if a clear need exists | user request, `plugfn/README.md` | Gap |
| INT-U08 | Provide Python parity | user request, `plugfn/python/README.md`, `plugfn/python/IMPLEMENTATION.md`, `plugfn/python/SUMMARY.md` | Fail |

## Intent → Spec coverage matrix

| Intent ID | Key mapped requirements | Coverage result | Notes |
| --- | --- | --- | --- |
| INT-U01 | `PLUG-001` (2026-03-18), `PLAT-001`, `PLAT-002`, `DOCS-001` | Partial | TS runtime is close, but packaging/docs inconsistencies and Python gaps block standardization. |
| INT-U02 | `OAUTH-008`, `OAUTH-009`, `OAUTH-010` | Fail / Partial | Shared packages are used, but persistence still relies on connection-record hacks and the legacy shim still contains business logic. |
| INT-U03 | `PLAT-002`, `PLUG-001` (2026-03-11), `PLUG-002`, `PLUG-003` | Partial | TS router uses `@superfunctions/http`, but auth defaults and webhook verification are not yet production-hard; Python adapters are weaker. |
| INT-U04 | `PLAT-001`, `OAUTH-008` | Partial | Shared DB types are imported, but runtime contracts remain ad hoc and OAuth state/token storage is not first-class. |
| INT-U05 | `LIN-001`, `GH-001`, `CLICKUP-001`, `DOCS-001` | Partial | GitHub, Linear, and ClickUp exist in TS; Gmail exists, but no broader Google suite and no meaningful Python parity. |
| INT-U06 | `SEC-001`, `SEC-002`, `SEC-003`, `OPS-001`, `OPS-002`, `OPS-003`, `OPS-004` | Fail / Partial | Good security utilities and runbooks exist, but release gates do not currently prove a releasable system. |
| INT-U07 | no explicit requirement found | Gap | No spec defines a safe browser/client boundary; current package is server-first. |
| INT-U08 | implied by user intent plus Python docs | Fail | Python is not parity-complete, not test-green, and not honest about current maturity. |

## Requirement coverage summary

Pass:

- `PLAT-003`
- `PLUG-004`
- `PLUG-005`
- `OPS-003`
- `LIN-001`
- `GH-001`
- `CLICKUP-001`

Partial:

- `OAUTH-009`
- `PLAT-001`
- `PLAT-002`
- `PLAT-004`
- `PLUG-001` (2026-03-11 auth enforcement)
- `PLUG-002`
- `PLUG-003`
- `PLUG-006`
- `PLUG-007`
- `PLUG-008`
- `SEC-001`
- `SEC-002`
- `SEC-003`
- `OPS-004`
- `TEST-001`
- `DOCS-001`

Fail:

- `OAUTH-008`
- `OAUTH-010`
- `OPS-001`
- `OPS-002`

Net: the TypeScript core shows meaningful progress and several strong primitives, but the combined runtime/docs/verification story is still below a safe "default integration platform" bar.

## Requirement-by-requirement results

### Shared OAuth and platform alignment (`.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec`)

- `OAUTH-008` — Fail. `plugfn/typescript/src/core/connection-manager.ts` still stores OAuth state and token records inside synthetic connection objects (`__oauth_state_system__`, `__oauth_token_system__`) and scans them via `listConnections(...)`. That is the exact "connection-record hack" the requirement forbids.
- `OAUTH-009` — Partial. `ConnectionManager` delegates start/callback/refresh/disconnect to `@superfunctions/oauth-flow`, which is the right direction, but the persistence layer and descriptor/runtime adaptation are still custom-heavy enough that the "no duplicated orchestration helper remains" bar is not fully met.
- `OAUTH-010` — Fail. `plugfn/typescript/src/auth/oauth-flow.ts` is not a thin wrapper. It owns warning emission, memory-store defaults, authorization URL creation, token exchange, token refresh, state verification, and descriptor translation.
- `PLAT-001` — Partial. `plugfn/typescript/src/types/config.ts` imports `type { Adapter as DbAdapter } from '@superfunctions/db'`, but then wraps it in `Partial<DbAdapter>` and extends it with a large ad hoc interface. That is better than a totally standalone contract, but not a clean bind to shared DB types.
- `PLAT-002` — Partial. `plugfn/typescript/src/router/http-router.ts` is built on `@superfunctions/http`, and docs include Express/Fastify/Hono examples. However, the audit could not verify a clean passing route/build matrix for the TS package in the current environment, and the router auth story is still partly demo-grade.
- `PLAT-003` — Pass. `plugfn/typescript/src/core/connection-manager.ts` defines deterministic priority ordering using `lastUsedAt`, `connectedAt`, `createdAt`, and finally lexical `connection.id`, with matching tests in `plugfn/typescript/tests/connection-selection.test.ts`.
- `PLAT-004` — Partial. Legacy path notes and warnings exist for `plugfn/auth/oauth-flow`, but there is no full migration guide covering the broader doc/install/import churn. The requirement asked for deprecation shims plus migration notes; only the shim side is convincingly present.

### PlugFn runtime hardening (`plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec`)

- `PLUG-001` — Partial. The TypeScript router rejects mismatched `userId`/`tenantId` bodies via `assertIdentityMatches(...)` and supports injected auth. But its default fallback accepts any bearer token as the effective user ID, and the Python FastAPI/Flask adapters still trust `user_id` query inputs or contain auth TODOs.
- `PLUG-002` — Partial. The TypeScript webhook handler fail-closes when a trigger has `verifySignature` configured and no secret is present. But GitHub/Linear/ClickUp verification hashes the reserialized JSON payload instead of raw request bytes, and the Python handler verifies only "if secret provided," which is fail-open behavior.
- `PLUG-003` — Partial. The TypeScript webhook handler resolves provider path/event mappings deterministically and rejects unknown mappings. This looks structurally sound, but the audit could not execute the full TS test matrix in the current environment, so coverage remains evidence-backed but not fully release-gated.
- `PLUG-004` — Pass. Deterministic connection selection and explicit ambiguity rejection are implemented and tested.
- `PLUG-005` — Pass. `plugfn/typescript/src/utils/request.ts` preserves content-type semantics, supports form encoding, and avoids unconditional JSON serialization. Matching retry/rate-limit transport tests exist.
- `PLUG-006` — Partial. Retry logic honors `Retry-After` hints, and the package has rate-limit tests. But the spec explicitly calls for a distributed bucket backend for multi-instance fairness, and the observed implementation remains local/in-memory.
- `PLUG-007` — Partial. `plugfn/typescript/src/core/workflow-engine.ts` persists execution state and supports idempotent resume behavior, and `plugfn/typescript/tests/workflow-idempotency.test.ts` exists. However, trigger unregistration is a no-op and workflow delay scheduling remains process-local (`setTimeout`), so runtime lifecycle safety is incomplete.
- `PLUG-008` — Partial. The CLI `test` command is no longer pure placeholder output; it validates provider descriptor URLs, deterministic auth URL generation, callback stub shape, and optional health checks. But it does not validate a real configured connection or action execution path, so it is still lighter than the operational wording implies.
- `SEC-001` — Partial. Useful lifecycle primitives exist (`retention`, `export-delete`) and security tests are present. What is missing is proof that those controls are comprehensively wired through the full runtime and Python parity surface.
- `SEC-002` — Partial. Redaction utilities and tests exist, which is good. The audit did not find equivalent evidence that all default logs/metrics paths across the runtime consistently use those utilities.
- `SEC-003` — Partial. The TypeScript path shows deliberate tenant/user checks and isolation helper modules, but the Python adapters still accept caller-provided `user_id` values from the HTTP layer, which undercuts the cross-language security claim.
- `OPS-001` — Fail. The spec requires passing tests and removal of placeholder critical-path behavior across both TS and Python before release. Python fails at import-time during `pytest` collection, FastAPI auth paths still contain `pass`, and TypeScript verification is not in a release-ready state.
- `OPS-002` — Fail. The required integrated verification matrix is not demonstrably green. `npm exec --workspace @plugfn/cli -- vitest --run` passed, but `npm exec --workspace plugfn -- vitest --run` failed while loading `plugfn/typescript/vitest.config.ts`, and Python `pytest` failed during collection.
- `OPS-003` — Pass. Runbooks exist for OAuth incidents, provider throttling, webhook security, and mail delivery under `plugfn/docs/runbooks/`.
- `OPS-004` — Partial. Docs were updated, but they are inconsistent, contain stale install instructions, and include machine-specific absolute-path examples in release guidance.

### Shared provider/runtime surface (`.conduct/specs/2026-03-18-change-3dhqe3l2-spec`)

- `PLUG-001` — Partial. The TypeScript package does expose shared runtime provider capabilities through PlugFn rather than Conduct-private code, which is good. But the "go-to shared runtime" goal remains undercut by packaging confusion, verification gaps, and the unresolved generic-vs-mail scope conflict.
- `LIN-001` — Pass. Linear provider docs and implementation expose `issues.get`, `comments.create`, `issues.search`, and webhook triggers with explicit verification hooks.
- `GH-001` — Pass. GitHub provider docs and implementation include `issues.get`, `issues.update`, `pulls.create`, `pulls.createReview`, and the documented triggers.
- `CLICKUP-001` — Pass. ClickUp exists as a first-class provider in TypeScript with the required actions/triggers and documented webhook verification hooks.
- `TEST-001` — Partial. The repository has a meaningful TypeScript test suite and a passing CLI test run, but the release audit cannot mark this complete while the TS workspace verification path is not clean and Python `pytest` fails at import time.
- `DOCS-001` — Partial. Provider docs for GitHub, Linear, and ClickUp exist, but the package/install/import story is contradictory enough that the public documentation cannot yet be treated as release-quality onboarding.

## Spec conflicts / spec gaps

- Scope conflict: the user request and top-level `plugfn` docs describe a generic reusable integration runtime, but `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/` pivots heavily into Finatron/Fellotron mail ingestion, managed mailbox controls, and finance-specific parsing/governors. The repo needs an explicit product decision on whether those are core `plugfn` scope, a separate package, or an optional vertical layer.
- Packaging conflict: `plugfn/typescript/package.json` declares `plugfn`, while `plugfn/README.md`, `plugfn/typescript/README.md`, and `plugfn/docs/getting-started.md` instruct `@superfunctions/plugfn`. `plugfn/cli/package.json` declares `@plugfn/cli`, while `plugfn/README.md` instructs `@superfunctions/plugfn-cli`.
- Python maturity conflict: `plugfn/README.md` says Python is "Coming Soon"; `plugfn/python/README.md` says "Coming Soon" while also advertising working features; `plugfn/python/IMPLEMENTATION.md` says feature-complete; `plugfn/python/SUMMARY.md` says full parity and production-ready. These claims cannot all be true, and the code/tests show they are not.
- Google/provider gap: the user asked for GitHub, Linear, Google, and similar providers. The TypeScript implementation includes Gmail but no general Google Calendar/Drive-style provider surface despite that broader story being present in `plugfn/SPEC.md`.
- Client-SDK gap: no document or spec defines what a safe client-side/browser SDK should contain, what must remain server-only, or how OAuth/webhook responsibilities are split. For a security-sensitive integration runtime, that omission matters.
- Release artifact portability gap: `plugfn/docs/getting-started.md`, `plugfn/docs/architecture/hardening-baseline.md`, and `plugfn/docs/operations/release-gates.md` still embed machine-specific absolute paths. Even the historical root `.conduct/logs.csv` contains absolute-path rows. That hurts portability and weakens trust in the release process.

## Cross-cutting audits

### Architecture and shared-package reuse

Positive:

- The TypeScript package is clearly trying to align with the ecosystem. It uses `@superfunctions/oauth-flow`, `@superfunctions/oauth-http`, `@superfunctions/oauth-storage`, `@superfunctions/oauth-providers`, `@superfunctions/http`, and shared DB types.
- The router surface is framework-agnostic and documented through shared HTTP adapters.
- Connection selection determinism is implemented carefully and tested.

Negative:

- The DB contract remains partially custom.
- OAuth persistence still piggybacks on connection records.
- The current product boundary is muddied by mail-specific runtime layers living inside the same package readiness narrative.

### Security and auth

Positive:

- The TypeScript router includes tenant/user mismatch checks.
- Redaction, lifecycle, isolation, and explicit E2EE-mode utilities exist, with dedicated tests.
- The TypeScript webhook handler fail-closes when signature verification is configured and the secret is missing.

Negative:

- Signature verification is based on reserialized JSON instead of raw bytes for several providers.
- TypeScript default auth fallback is too permissive for a production default.
- Python HTTP adapters still trust request-supplied `user_id` values and contain incomplete auth handling.
- Python webhook verification is fail-open when no secret is supplied.

### Operability and release readiness

Positive:

- Runbooks exist.
- The CLI has become more useful than a placeholder.
- The test suite shape is reasonably strong on the TypeScript side.

Negative:

- The integrated release matrix is not green.
- Python fails before tests even run.
- The CLI diagnostics still do not prove a real provider connection.
- Workflow trigger cleanup is incomplete.

### Documentation and consumer ergonomics

Positive:

- There is real documentation volume: getting started, provider guides, architecture notes, and runbooks.
- GitHub/Linear/ClickUp provider docs are reasonably concrete.

Negative:

- Install/import/package-name instructions are contradictory.
- Python docs contradict one another about maturity.
- Status artifacts overstate readiness.
- Several docs are not portable because of absolute paths.

### Python parity

Positive:

- There is a real Python package layout, typed models, framework adapters, and at least an attempt at provider coverage.

Negative:

- Only two providers are exported.
- The current package fails import-time tests.
- Adapters are not fully auth-safe.
- The documentation claims parity that the code does not support.

## Recommendations

1. Re-baseline the product contract before more implementation work.
   Decide whether `plugfn` is the general shared integration runtime, the mail/Finatron substrate, or both with a clearly separated optional module boundary. Do not keep shipping one readiness story for two materially different scopes.

2. Fix the public package surface immediately.
   Align `plugfn/typescript/package.json`, `plugfn/cli/package.json`, `plugfn/README.md`, `plugfn/typescript/README.md`, and `plugfn/docs/getting-started.md` on one install/import story. This is a low-effort, high-impact blocker for adoption.

3. Finish the shared OAuth hardening work before calling the runtime reusable.
   Replace connection-record OAuth state/token persistence with a first-class `@superfunctions/db`-backed path, and reduce `plugfn/typescript/src/auth/oauth-flow.ts` to an actual compatibility wrapper.

4. Harden webhook and auth boundaries.
   Verify signatures against raw request bytes, not reserialized JSON. Make injected/derived auth mandatory for non-webhook routes. Remove Python HTTP-layer `user_id` trust and TODO placeholders.

5. Treat Python as experimental until proven otherwise.
   Update docs/status immediately to reflect reality. If parity remains a requirement, define a parity matrix, get `pytest` green, implement the missing providers, and close the auth/security gaps before claiming production readiness.

6. Finish lifecycle correctness in the TypeScript runtime.
   Implement real trigger unregistration for disabled/deleted workflows, and decide which workflow timing/idempotency pieces must be durable across multi-instance operation.

7. Raise the release gate to an actual reproducible matrix.
   A production-ready claim for this package should require a clean build/typecheck/test path for `plugfn/typescript`, `plugfn/cli`, and `plugfn/python`, plus at least one end-to-end OAuth + webhook verification path.

8. Keep any future client-side SDK intentionally thin.
   Based on the current architecture, a browser/client helper should likely be limited to initiating connect flows and consuming backend-issued session state. Provider credentials, token exchange, webhook verification, and tenant authorization should remain server-side.

## Appendix: commands run + environment details

Environment summary:

- OS/arch: `Darwin arm64`
- Shell: `zsh`
- Timezone: `Asia/Kolkata`
- Git state: clean worktree on `detached HEAD`

Commands run (sanitized):

- `git status --short --branch`
  - Result: clean worktree, `HEAD (no branch)`
- `git rev-parse --short HEAD`
  - Result: `5092916`
- `git rev-parse --abbrev-ref HEAD`
  - Result: `HEAD`
- multiple `rg`, `sed`, and `nl` inspections across `plugfn/**`, `.conduct/specs/**`, and `.conduct/logs.csv`
  - Result: gathered code/spec/doc evidence cited in this audit
- `npm exec --workspace @plugfn/cli -- vitest --run`
  - Result: passed, `4` test files and `7` tests
- `npm exec --workspace plugfn -- vitest --run`
  - Result: CLI tests ran, then TypeScript workspace startup failed while loading `plugfn/typescript/vitest.config.ts` because `vitest/config` was not resolvable in the current environment
- `python3 -m pytest -q` (from `plugfn/python`)
  - Result: failed during collection with `ValueError: "Provider" object has no field "auth_config"`
- `python3 -m py_compile $(find plugfn/python/plugfn -name '*.py' -print)`
  - Result: passed
- `npx -y -p typescript@5.3.2 tsc -p plugfn/typescript/tsconfig.json --noEmit`
  - Result: not a clean release signal in the current environment because dependency/type resolution is incomplete
- `npx -y -p typescript@5.3.2 tsc -p plugfn/cli/tsconfig.json --noEmit`
  - Result: not a clean release signal in the current environment because local type dependencies are incomplete
