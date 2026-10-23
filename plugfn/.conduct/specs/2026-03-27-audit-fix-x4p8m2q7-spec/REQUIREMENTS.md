# Requirement IDs

- CONTRACT-001
- PKG-001
- PLAT-001
- OAUTH-001
- OAUTH-002
- ROUTER-001
- AUTH-001
- WEBHOOK-001
- WORKFLOW-001
- CLI-001
- PY-001
- PY-002
- PY-003
- PROVIDER-001
- SDK-001
- DOCS-001
- REL-001

## ID: CONTRACT-001

- Priority: P0
- Statement: PlugFn MUST define one coherent product contract as the general shared integration runtime, and MUST treat Finatron/Fellotron or mail-specific features as optional vertical scope unless those features independently satisfy the same production gate.
- Rationale: The audit found that conflicting product stories make current readiness claims untrustworthy.
- Acceptance criteria:
  - `plugfn/README.md`, `plugfn/SPEC.md`, `plugfn/typescript/README.md`, `plugfn/python/README.md`, `plugfn/.conduct/STATUS.md`, and `plugfn/docs/getting-started.md` describe the same core runtime scope.
  - A provider/feature readiness matrix exists and explicitly separates core runtime scope from vertical-only or experimental scope.
  - Production-ready claims are scoped to the readiness matrix, not to undeclared “all providers” or vertical modules.
- Test vectors: TV-CONTRACT-001, TV-DOCS-001
- Notes: Existing `plugfn/typescript/src/finatron`, `plugfn/typescript/src/fellotron`, and `plugfn/typescript/src/mail` MAY remain, but their status MUST be explicit.

## ID: PKG-001

- Priority: P0
- Statement: PlugFn MUST align package manifests, install instructions, and import examples on the publishable package names `plugfn` and `@plugfn/cli`.
- Rationale: Contradictory package names are a direct adoption blocker.
- Acceptance criteria:
  - `plugfn/typescript/package.json` remains `plugfn`.
  - `plugfn/cli/package.json` remains `@plugfn/cli`.
  - Public docs under `plugfn/**` do not instruct consumers to install `@superfunctions/plugfn` or `@superfunctions/plugfn-cli`.
  - Import examples under `plugfn/**` use package names that resolve against the actual published contract.
- Test vectors: TV-PKG-001
- Notes: This requirement is about package/distribution truth, not about renaming the underlying runtime modules.

## ID: PLAT-001

- Priority: P0
- Statement: PlugFn MUST use `@superfunctions/db` as the canonical persistence contract for runtime state, including first-class OAuth storage bindings.
- Rationale: The audit found partial/ad hoc DB contracts and OAuth persistence hacks.
- Acceptance criteria:
  - `PlugFnConfig.database` and related runtime storage contracts bind directly to `@superfunctions/db` `Adapter` semantics rather than ad hoc `Partial` wrappers.
  - PlugFn defines explicit model/table mappings for connections, OAuth state, OAuth tokens, workflows, and workflow executions.
  - No OAuth state or OAuth token persistence relies on synthetic connection records or synthetic system users/providers.
- Test vectors: TV-PLAT-001, TV-OAUTH-001
- Notes: PlugFn MAY wrap the shared adapter with helper methods, but the wrapper MUST remain a strict layer above the canonical adapter.

## ID: OAUTH-001

- Priority: P0
- Statement: PlugFn MUST persist OAuth state and token material through first-class shared OAuth stores backed by the shared DB contract.
- Rationale: Reusing the shared OAuth family is not sufficient if persistence still bypasses the intended storage model.
- Acceptance criteria:
  - `plugfn/typescript/src/core/connection-manager.ts` uses explicit OAuth state/token store bindings backed by first-class storage.
  - Synthetic connection-record identifiers such as `__oauth_state_system__` and `__oauth_token_system__` are absent from runtime code.
  - Callback handling writes connection records and token records through separate, explicit persistence paths.
- Test vectors: TV-OAUTH-001
- Notes: Connection records MAY store stable references to token records.

## ID: OAUTH-002

- Priority: P0
- Statement: `plugfn/typescript/src/auth/oauth-flow.ts` MUST remain a thin compatibility shim and MUST NOT own OAuth orchestration logic beyond warning and delegation.
- Rationale: The audit found that the “legacy path” still contains real business logic, defeating the shared-package migration.
- Acceptance criteria:
  - The legacy path emits a deterministic deprecation warning with replacement and removal target.
  - The legacy path does not instantiate state stores or token clients with business defaults beyond delegation wiring.
  - The legacy path does not implement token exchange, token refresh, callback state verification, or provider descriptor translation beyond thin argument mapping.
- Test vectors: TV-OAUTH-002
- Notes: A single minor release of compatibility is allowed.

## ID: ROUTER-001

- Priority: P0
- Statement: PlugFn MUST expose its canonical OAuth, webhook, and management routes through `@superfunctions/http` in TypeScript and equivalent FastAPI/Flask adapters in Python.
- Rationale: The user explicitly wants automatic route exposure, and the audit found only partial hardening around that surface.
- Acceptance criteria:
  - The canonical route inventory is available in TypeScript and Python adapters.
  - Route success and error envelopes are consistent across languages.
  - Webhook handlers receive raw request body bytes and normalized headers before verification.
  - Router auth defaults derive from configured auth integration unless an explicit override is provided.
- Test vectors: TV-ROUTER-001, TV-AUTH-001, TV-WEBHOOK-001
- Notes: This requirement does not require framework-specific route duplication outside the shared adapter surface.

## ID: AUTH-001

- Priority: P0
- Statement: PlugFn MUST derive non-webhook route identity from configured auth providers and MUST reject caller-controlled identity as the source of truth.
- Rationale: The audit found permissive fallback behavior in TypeScript and unsafe `user_id` trust in Python adapters.
- Acceptance criteria:
  - TypeScript router rejects unauthenticated non-webhook requests with `PLUGFN_AUTH_REQUIRED`.
  - TypeScript router validates any caller-supplied identity fields against the derived principal and returns `TENANT_ACCESS_DENIED` on mismatch.
  - Python FastAPI and Flask adapters derive the principal from auth integration and do not trust query/body `user_id` fields.
  - No default fallback interprets a raw bearer token string as the user ID.
- Test vectors: TV-AUTH-001, TV-PY-002
- Notes: Webhook routes MAY remain unauthenticated if signature verification and provider mapping succeed.

## ID: WEBHOOK-001

- Priority: P0
- Statement: PlugFn MUST verify signed webhooks against raw request bytes and MUST fail closed when verification is required.
- Rationale: Re-serializing parsed JSON breaks provider signature contracts and weakens integrity guarantees.
- Acceptance criteria:
  - TypeScript GitHub, Linear, ClickUp, Gmail, and any other signed providers verify against raw request body bytes.
  - Python webhook verification uses raw bytes and the same fail-closed semantics.
  - Missing secret material or resolver errors return `WEBHOOK_SECRET_MISSING` or equivalent deterministic failure and do not mark events as verified.
  - Runtime tests prove that JSON reserialization cannot pass signature checks for the same payload when raw bytes differ.
- Test vectors: TV-WEBHOOK-001, TV-PY-002
- Notes: Providers with no signing contract MAY skip signature verification only if their readiness-matrix note says so explicitly.

## ID: WORKFLOW-001

- Priority: P1
- Statement: PlugFn MUST make workflow trigger registration, unregistration, delay scheduling, and idempotent resume behavior correct for multi-instance operation.
- Rationale: A no-op unregister path and process-local delay handling are not production-safe.
- Acceptance criteria:
  - Disabling a workflow detaches its active trigger bindings.
  - Deleting a workflow detaches its active trigger bindings before record deletion.
  - Delayed or resumed executions survive process restart and multi-instance execution.
  - Failures to unregister or resume deterministically return `WORKFLOW_TRIGGER_UNREGISTER_FAILED` or `WORKFLOW_DURABILITY_UNSUPPORTED`.
- Test vectors: TV-WORKFLOW-001, TV-WORKFLOW-002
- Notes: If a trigger backend cannot support unregister, the runtime MUST expose that limitation explicitly and MUST NOT silently log-and-ignore it.

## ID: CLI-001

- Priority: P1
- Statement: The PlugFn CLI MUST perform real configured provider diagnostics and MUST emit deterministic JSON and exit codes.
- Rationale: A truthful operations story requires more than placeholder or schema-only checks.
- Acceptance criteria:
  - `plugfn test` validates connection resolution and at least one provider action against configured runtime state.
  - Optional OAuth and webhook diagnostics are available through the same command surface.
  - `--json` output contains explicit pass/fail status and failure codes.
  - Exit codes are deterministic and documented.
- Test vectors: TV-CLI-001
- Notes: The CLI MAY offer a non-JSON human mode in addition to the machine-readable path.

## ID: PY-001

- Priority: P0
- Statement: The Python SDK MUST import cleanly, pass `pytest`, and document its maturity truthfully.
- Rationale: The audit found import-time test failures and conflicting docs that overclaim parity.
- Acceptance criteria:
  - `python3 -m pytest -q` passes from `plugfn/python`.
  - Provider model definitions do not rely on undeclared field mutation that breaks import-time initialization.
  - `plugfn/python/README.md`, `plugfn/python/SUMMARY.md`, and `plugfn/.conduct/STATUS.md` agree on actual maturity and parity scope.
- Test vectors: TV-PY-001, TV-DOCS-001
- Notes: Truthful experimental wording is acceptable only until parity requirements in this spec are satisfied.

## ID: PY-002

- Priority: P0
- Statement: Python adapters and webhook handlers MUST enforce the same auth-derived identity and raw-body verification guarantees as the TypeScript runtime.
- Rationale: Cross-language security asymmetry blocks production readiness.
- Acceptance criteria:
  - FastAPI and Flask adapters derive principal identity from auth integration.
  - No `pass` placeholders remain in critical auth or webhook flows.
  - Webhook verification uses raw bytes and fails closed when verification is configured or required.
  - Tests cover positive and negative auth and webhook scenarios.
- Test vectors: TV-PY-002
- Notes: Sync wrappers MAY exist in Flask, but security semantics MUST remain equivalent.

## ID: PY-003

- Priority: P1
- Statement: Python MUST provide parity for the declared core provider set and MUST export only what its provider matrix truthfully supports.
- Rationale: The audit found only GitHub/Slack exports and no truthful matrix for the broader production story.
- Acceptance criteria:
  - Python exports the core provider set declared by the provider readiness matrix.
  - The matrix explicitly marks TypeScript/Python readiness for GitHub, Linear, ClickUp, and Gmail.
  - Unsupported providers are either absent from production docs or marked `beta`, `experimental`, `vertical-only`, or `unsupported`.
  - Python tests cover import/export and basic action/trigger contract availability for the core provider set.
- Test vectors: TV-PY-003, TV-PROVIDER-001
- Notes: This requirement is scoped to the declared core provider set, not to every provider in the repository.

## ID: PROVIDER-001

- Priority: P1
- Statement: PlugFn MUST publish and enforce a provider readiness matrix that names the core provider set and marks all other provider states explicitly.
- Rationale: Truthful scope is required both for adoption and for release claims.
- Acceptance criteria:
  - A public provider readiness matrix exists under `plugfn/docs/`.
  - The matrix includes at least GitHub, Linear, ClickUp, and Gmail.
  - Each matrix entry declares status plus TypeScript/Python readiness.
  - Public docs and status files use the matrix rather than broad unsupported claims such as “75+ providers” without qualification.
- Test vectors: TV-PROVIDER-001, TV-CONTRACT-001
- Notes: Additional providers MAY be listed as non-production-ready.

## ID: SDK-001

- Priority: P2
- Statement: PlugFn MUST define a safe browser/client boundary and MUST keep privileged provider operations server-side.
- Rationale: The audit found no explicit browser contract, which is risky for a security-sensitive integration runtime.
- Acceptance criteria:
  - Public docs explicitly state whether a browser package exists.
  - If a browser helper exists, it is limited to connect-initiation and provider catalog discovery.
  - Token exchange, refresh, disconnect, webhook verification, and direct credentialed actions remain server-only.
- Test vectors: TV-SDK-001
- Notes: This spec does not require shipping a browser package.

## ID: DOCS-001

- Priority: P0
- Statement: PlugFn docs, status artifacts, and release guidance MUST be truthful, portable, and free of machine-specific absolute paths.
- Rationale: Overstated or non-portable docs reduce trust and break reproducible release workflows.
- Acceptance criteria:
  - Public docs under `plugfn/**` contain no absolute local-machine paths.
  - `plugfn/.conduct/STATUS.md` and Python docs do not claim production readiness or parity unless validated by the release gate and matrix.
  - Release verification commands are written from repo root without machine-specific `cd /...` prefixes.
  - Package/install/import instructions are consistent with `PKG-001`.
- Test vectors: TV-DOCS-001
- Notes: Existing historical artifacts outside `plugfn/**` are out of scope unless they are referenced by PlugFn release docs.

## ID: REL-001

- Priority: P0
- Statement: PlugFn MUST provide a reproducible repo-root release gate covering TypeScript runtime, CLI, Python, docs inventory, and end-to-end OAuth + webhook verification.
- Rationale: A production-ready claim is not credible without a single authoritative release proof.
- Acceptance criteria:
  - A canonical repo-root gate command exists.
  - The gate runs TypeScript runtime build/typecheck/tests.
  - The gate runs CLI build/typecheck/tests.
  - The gate runs Python `pytest`.
  - The gate runs docs/status inventory checks, including portable-path and readiness-matrix checks.
  - The gate runs at least one end-to-end OAuth callback path and one end-to-end webhook verification path.
  - `plugfn/.conduct/STATUS.md` is only allowed to claim production readiness after a green gate.
- Test vectors: TV-REL-001, TV-DOCS-001
- Notes: The gate MAY compose npm, pytest, and custom scripts, but it MUST be runnable from repo root.
