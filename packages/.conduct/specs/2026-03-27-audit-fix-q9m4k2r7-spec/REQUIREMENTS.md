# Requirements

## Table of contents

- `FLOW-001`
- `FLOW-002`
- `FLOW-003`
- `FLOW-004`
- `ROUTER-001`
- `PROVIDER-001`
- `DOCS-001`
- `DOCS-002`
- `GATE-001`
- `TEST-001`
- `COMPAT-001`

### ID: FLOW-001

- **Priority:** P0
- **Statement:** `@superfunctions/oauth-flow` MUST import and re-export canonical runtime-config and secret-resolution types from `@superfunctions/oauth-core` and `@superfunctions/oauth-http`, and MUST support runtime-config resolver parity instead of re-declaring those contracts locally.
- **Rationale:** The audit found internal contract drift inside the shared OAuth family, especially around `OAuthIntentSubject`, runtime config, and secret-resolution types.
- **Acceptance criteria:**
  - `packages/oauth-flow/src/service.ts` no longer contains local duplicate definitions for `OAuthIntentSubject`, `OAuthProviderRuntimeConfig`, `OAuthTokenGrantType`, `OAuthTokenAuthMethod`, `OAuthResolvedClientSecret`, `OAuthSecretResolverContext`, or `OAuthClientSecretResolver`.
  - `OAuthFlowServiceConfig` accepts both `providerRuntimeConfig` and `resolveProviderRuntimeConfig`, with resolver precedence documented and tested.
  - Any resolver input fields that are unavailable for refresh/disconnect operations are passed as `undefined` rather than fabricated values.
  - `oauth-flow` tests verify that resolver results take precedence over static config and that missing `clientId` still fails with `OAUTH_RUNTIME_CONFIG_INVALID`.
- **Test vectors:** `TV-FLOW-001`, `TV-COMPAT-001`
- **Notes:** Re-export compatibility MAY remain for one minor release, but the canonical owner of each symbol MUST be the lower-level package.

### ID: FLOW-002

- **Priority:** P0
- **Statement:** `@superfunctions/oauth-flow` MUST reject plaintext durable token persistence by default and MUST allow plaintext storage only through an explicit unsafe configuration mode.
- **Rationale:** The audit found that a plain `TokenVault` currently results in raw JSON token storage behind an `encryptedPayload` field, which is not acceptable as the default for a production substrate.
- **Acceptance criteria:**
  - `OAuthFlowServiceConfig` exposes a token-storage mode or equivalent explicit unsafe opt-in.
  - The default mode rejects non-encrypted vaults before any token record is written and returns `OAUTH_TOKEN_STORAGE_UNSAFE`.
  - An encrypted vault path continues to work for callback and refresh persistence.
  - A plaintext mode still exists for tests/prototypes, but it is explicitly named unsafe in code and docs.
  - `oauth-flow` docs and README use encrypted storage in the primary production examples.
- **Test vectors:** `TV-FLOW-002`, `TV-DOCS-001`
- **Notes:** This is an intentional security hardening change and MUST be documented as such.

### ID: FLOW-003

- **Priority:** P0
- **Statement:** `@superfunctions/oauth-flow` MUST expose truthful disconnect cleanup semantics by returning structured connection-cleanup results and by passing normalized disconnect context into consumer hooks.
- **Rationale:** The audit found that `disconnect()` reports `connectionDeleted: true` even when no consumer-owned connection record was removed.
- **Acceptance criteria:**
  - `OAuthFlowDisconnectResult` includes a structured `connectionCleanup` object with `attempted`, `deleted`, and `reason`.
  - `connectionDeleted` remains as a deprecated alias and always equals `connectionCleanup.deleted`.
  - `onDisconnected` receives normalized disconnect context including provider ID, connection ID, subject when known, token metadata when known, and the local cleanup flags.
  - If no disconnect hook is configured, `connectionCleanup` is reported as `not-configured` and `connectionDeleted` is `false`.
  - If a disconnect hook returns `deleted: true`, the result reports that truthfully.
- **Test vectors:** `TV-FLOW-003`, `TV-COMPAT-001`
- **Notes:** `oauth-flow` is responsible only for honest reporting of consumer cleanup, not for inventing a domain connection model.

### ID: FLOW-004

- **Priority:** P1
- **Statement:** `@superfunctions/oauth-flow` MUST validate disconnect hook outputs and MUST preserve deterministic, redaction-safe error and event behavior for new resolver and storage failure paths.
- **Rationale:** The audit found that the high-level observability surface is directionally correct but still too easy to undermine with misleading cleanup flags and unsafe storage behavior.
- **Acceptance criteria:**
  - A disconnect hook throw surfaces as `OAUTH_HOOK_FAILED` only after local token cleanup has already been attempted.
  - An invalid disconnect hook return shape surfaces as `VALIDATION_ERROR`.
  - `OAUTH_TOKEN_STORAGE_UNSAFE` failures emit the operation failure event with no token or secret material in `details`.
  - Disconnect success/failure events include only redaction-safe cleanup metadata.
- **Test vectors:** `TV-FLOW-004`, `TV-FLOW-002`
- **Notes:** This requirement extends the existing event model; it does not replace the current event names.

### ID: ROUTER-001

- **Priority:** P0
- **Statement:** `@superfunctions/oauth-router` MUST apply secure-by-default route metadata, MUST stop hardcoding `auth: none` for every route, and MUST allow explicit per-route metadata overrides.
- **Rationale:** The audit found that both browser and connection route factories currently publish public disconnect endpoints by default, which is a serious reusable-package footgun.
- **Acceptance criteria:**
  - Connection routes default `start` and `disconnect` to authenticated metadata and keep `callback` public.
  - Browser routes keep `start` and `callback` public by default but default `disconnect` to authenticated metadata.
  - Both route factories accept explicit metadata overrides for each generated route.
  - `oauth-router` gains dedicated docs coverage and auth navigation entry.
- **Test vectors:** `TV-ROUTER-001`, `TV-DOCS-002`
- **Notes:** A consumer MAY still choose public disconnect routes, but only by explicit override.

### ID: PROVIDER-001

- **Priority:** P0
- **Statement:** `@superfunctions/oauth-providers` MUST support durable consent and policy-audit persistence through explicit store interfaces, and MUST stop relying on in-process arrays and `Math.random()` as the effective audit boundary.
- **Rationale:** The audit found that the current policy registry is useful for convenience but not durable enough for production audit/compliance expectations.
- **Acceptance criteria:**
  - `ProviderPolicyRegistry` accepts explicit persistence options for consent and policy audit events.
  - The default registry path still works by using built-in in-memory stores, but docs label it as convenience-only and non-durable.
  - Consent and audit persistence APIs are Promise-based.
  - `Math.random()` is removed from consent/audit ID generation in favor of an injected generator or a cryptographically safe default.
  - Store failures surface as deterministic provider-policy errors.
- **Test vectors:** `TV-PROVIDER-001`, `TV-PROVIDER-002`, `TV-DOCS-001`
- **Notes:** The consent store MAY reuse `OAuthConsentStore` from `@superfunctions/oauth-storage`; if it does, the mapping between provider-policy consent metadata and stored consent metadata MUST be documented.

### ID: DOCS-001

- **Priority:** P0
- **Statement:** Shared OAuth docs and READMEs MUST correct the audited correctness and safety issues, including the `oauth_tokens` table name and encrypted-first production guidance.
- **Rationale:** The audit found that the docs currently contain a real storage-name mismatch and normalize insecure production examples.
- **Acceptance criteria:**
  - `packages/oauth-storage/README.md` and `docs/content/docs/authentication/oauth-storage.mdx` use `oauth_tokens` as the default token table/model name.
  - `docs/content/docs/authentication/oauth-flow.mdx` uses encrypted storage in the primary quick-start and real-world production examples, with any plaintext example clearly marked as test/prototype-only.
  - `docs/content/docs/authentication/oauth-providers.mdx` states that the default policy registry is in-memory convenience mode unless persistent stores are supplied.
  - `docs/content/docs/architecture/oauth-flow-architecture.mdx` includes `oauth-router` and the new persistence/security caveats.
- **Test vectors:** `TV-DOCS-001`
- **Notes:** This requirement is about correctness and safety, not about rewriting the docs site information architecture.

### ID: DOCS-002

- **Priority:** P1
- **Statement:** Every audited shared OAuth package MUST ship a package-local README, and the docs site MUST add first-class `oauth-router` discoverability.
- **Rationale:** The audit found sparse README coverage and no dedicated docs page for `oauth-router`, which weakens adoption ergonomics for a package family meant to be the default substrate.
- **Acceptance criteria:**
  - `README.md` exists for `oauth-core`, `oauth-http`, `oauth-storage`, `oauth-providers`, `oauth-flow`, `oauth-testing`, and `oauth-router`.
  - Each README contains install, quick start, package boundary, production-safety caveats, and a link/reference to the canonical docs page.
  - `docs/content/docs/authentication/oauth-router.mdx` exists.
  - `docs/content/docs/authentication/meta.json` includes `oauth-router`.
- **Test vectors:** `TV-DOCS-002`
- **Notes:** README wording MAY stay concise, but it MUST be accurate and package-specific.

### ID: GATE-001

- **Priority:** P0
- **Statement:** The shared OAuth family MUST provide reproducible package-level and repo-root verification commands that succeed from a fresh workspace after install, without requiring manually prebuilt sibling `dist` artifacts.
- **Rationale:** The audit found that most package-local test commands were not cleanly reproducible because workspace package resolution was brittle.
- **Acceptance criteria:**
  - A repo-root gate command exists for the shared OAuth family.
  - Package-local test commands for the audited OAuth packages resolve sibling workspace packages without ad hoc manual build steps.
  - The verification path is documented in package READMEs or shared package docs.
  - The gate fails if build/test/docs inventory checks fail.
- **Test vectors:** `TV-GATE-001`, `TV-DOCS-002`
- **Notes:** The implementation MAY use per-package `vitest.config.ts`, a shared runner, `turbo` dependency-closure builds, or a combination of those, as long as the acceptance criteria hold.

### ID: TEST-001

- **Priority:** P1
- **Statement:** The shared OAuth family MUST add deterministic regression tests that cover every new contract introduced by this audit-fix spec.
- **Rationale:** The audited package family is shared infrastructure; missing contract tests would let these same regressions recur across multiple consumers.
- **Acceptance criteria:**
  - Tests exist for resolver precedence, encrypted-required storage rejection, explicit unsafe storage opt-in, truthful disconnect cleanup reporting, disconnect hook validation, router secure defaults, provider-policy persistence, and docs inventory.
  - Tests assert deterministic error codes and redaction-safe behavior.
  - Test fixtures avoid embedding real secrets or machine-specific paths.
- **Test vectors:** `TV-FLOW-001`, `TV-FLOW-002`, `TV-FLOW-003`, `TV-FLOW-004`, `TV-ROUTER-001`, `TV-PROVIDER-001`, `TV-PROVIDER-002`, `TV-GATE-001`
- **Notes:** Contract tests MAY be colocated in package test suites; they do not need a single monolithic harness.

### ID: COMPAT-001

- **Priority:** P1
- **Statement:** Public contract changes introduced by this spec MUST ship with explicit compatibility notes, deprecation guidance, and documented migration expectations for package consumers.
- **Rationale:** This audit-fix work changes real shared APIs and defaults, so maintainers and downstream users need a clear migration story.
- **Acceptance criteria:**
  - `oauth-flow` documents `connectionDeleted` as a deprecated alias for one minor release.
  - `oauth-flow` documents the new encrypted-required default and the explicit unsafe opt-in.
  - `oauth-providers` documents any sync-to-async migration or new persistence-store requirement.
  - README or CHANGELOG text identifies breaking versus additive changes for each affected package.
- **Test vectors:** `TV-COMPAT-001`, `TV-DOCS-001`
- **Notes:** If a package lacks a CHANGELOG, the README MUST carry the compatibility guidance.
