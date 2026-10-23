# Requirement Index

- `PKG-001`
- `AUTH-001`
- `HTTP-001`
- `HTTP-002`
- `OAUTH-CORE-001`
- `OAUTH-HTTP-001`
- `OAUTH-STORAGE-001`
- `OAUTH-FLOW-001`
- `OAUTH-ROUTER-001`
- `PROVIDER-001`
- `OPENAPI-001`
- `CLI-001`
- `PY-001`
- `ADAPTER-001`
- `TEST-001`

## PKG-001

- ID: `PKG-001`
- Priority: `P0`
- Statement: the `packages` workspace MUST provide every shared dependency needed for the `authfn` spec without forcing `authfn` to duplicate OAuth, HTTP, OpenAPI, CLI, or Python infrastructure.
- Rationale: The companion `authfn` spec assumes these shared contracts exist.
- Acceptance criteria:
  - The packages listed in `SPEC.md` exist or are modified as specified.
  - Responsibility boundaries are documented and testable.
  - `authfn` implementation can consume these packages directly.
- Test vectors: `TV-PKG-001`, `TV-PKG-012`
- Notes: This is the umbrella requirement that binds the rest together.

## AUTH-001

- ID: `AUTH-001`
- Priority: `P0`
- Statement: `packages/auth` MUST expand the shared auth abstraction to model actor-centric sessions for users, API keys, and services with TypeScript and Python parity.
- Rationale: The current resource-oriented session shape is too narrow for the target auth platform.
- Acceptance criteria:
  - Shared auth types include subject/actor information.
  - Existing `AuthProvider` semantics remain centered on request authentication.
  - Python parity types exist under `superfunctions.auth`.
- Test vectors: `TV-PKG-001`
- Notes: Product-specific auth state remains outside shared types.

## HTTP-001

- ID: `HTTP-001`
- Priority: `P0`
- Statement: `packages/http` MUST provide cookie parsing/serialization helpers and typed route metadata suitable for auth and OpenAPI generation.
- Rationale: `authfn` needs cookie sessions and route metadata, and these should be shared HTTP concerns.
- Acceptance criteria:
  - Cookie helpers are reusable by any package.
  - Route metadata typing covers auth mode and OpenAPI metadata.
  - Route metadata handling is deterministic.
- Test vectors: `TV-PKG-002`, `TV-PKG-008`
- Notes: This does not replace the existing router; it enriches it.

## HTTP-002

- ID: `HTTP-002`
- Priority: `P0`
- Statement: Python shared HTTP types MUST support cookie materialization and OpenAPI generation without collapsing repeated cookies.
- Rationale: `authfn` Python parity depends on real browser-session cookies.
- Acceptance criteria:
  - Python `Response` supports cookies explicitly.
  - Generated responses can emit multiple cookies in order.
  - OpenAPI helpers consume route metadata from Python routes.
- Test vectors: `TV-PKG-002`, `TV-PKG-010`
- Notes: This requirement is shared-package-level; `authfn` does not own it.

## OAUTH-CORE-001

- ID: `OAUTH-CORE-001`
- Priority: `P0`
- Statement: `oauth-core` MUST model both connection-style and browser-auth OAuth intents and expose canonical redirect/state/token error semantics.
- Rationale: `authfn` social sign-in starts before a local user is known, while other packages already use connection semantics.
- Acceptance criteria:
  - Intent subject types distinguish browser-auth and connection cases.
  - Redirect allowlist validation remains in shared OAuth logic.
  - Browser-auth intents do not require a pre-existing user ID.
- Test vectors: `TV-PKG-003`, `TV-PKG-004`
- Notes: This change is foundational for `authfn` social login.

## OAUTH-HTTP-001

- ID: `OAUTH-HTTP-001`
- Priority: `P0`
- Statement: `oauth-http` MUST support runtime provider secret resolution, pluggable transports, and Apple-compatible client secret generation pathways.
- Rationale: Multi-region and Apple sign-in both require request-aware runtime credential handling.
- Acceptance criteria:
  - Runtime config can be supplied by resolver, not only static maps.
  - Secret resolution failures return structured errors.
  - Apple secret generation can be delegated to resolver hooks.
- Test vectors: `TV-PKG-007`
- Notes: Secret storage remains the consumer’s responsibility.

## OAUTH-STORAGE-001

- ID: `OAUTH-STORAGE-001`
- Priority: `P0`
- Statement: `oauth-storage` MUST provide canonical reusable stores and schemas for states, tokens, consents, and revocation failures.
- Rationale: `authfn` and `plugfn` need shared durable OAuth persistence semantics.
- Acceptance criteria:
  - Memory and DB-backed adapters exist for each shared store type.
  - Abstract schema definitions exist for CLI/ORM generation.
  - State replay protection is preserved.
- Test vectors: `TV-PKG-005`
- Notes: Product-local account-link tables are out of scope here.

## OAUTH-FLOW-001

- ID: `OAUTH-FLOW-001`
- Priority: `P0`
- Statement: `oauth-flow` MUST orchestrate start/callback/refresh/disconnect for both browser-auth and connection intents, with hooks and redaction-safe events.
- Rationale: The existing flow service is close, but it assumes known subjects and narrower hook shapes.
- Acceptance criteria:
  - Browser-auth intents can complete callbacks without a pre-known local user.
  - Hook failures return structured `OAUTH_HOOK_FAILED` errors.
  - Events cover start/callback/refresh/disconnect and omit secret material.
- Test vectors: `TV-PKG-004`, `TV-PKG-011`
- Notes: This requirement directly unlocks `authfn` social plugin design.

## OAUTH-ROUTER-001

- ID: `OAUTH-ROUTER-001`
- Priority: `P0`
- Statement: a new `@superfunctions/oauth-router` package MUST expose reusable `@superfunctions/http` route factories for browser-auth and connection OAuth flows.
- Rationale: `authfn` and other packages should not each hand-roll start/callback/disconnect routes.
- Acceptance criteria:
  - Route factories return plain `@superfunctions/http` routes.
  - Browser-auth route factory supports redirect and JSON completion modes.
  - Route factories consume shared flow/orchestration services.
- Test vectors: `TV-PKG-006`
- Notes: Python parity may live under `superfunctions.oauth.flow` rather than a separate Python package.

## PROVIDER-001

- ID: `PROVIDER-001`
- Priority: `P0`
- Statement: `oauth-providers` MUST publish canonical Google, Apple, and GitHub provider descriptors and policies suitable for both `authfn` social login and other superfunctions.
- Rationale: These three providers are the required authfn scope and must live in shared provider metadata.
- Acceptance criteria:
  - Provider descriptors cover authorization/token/revocation URLs and scopes.
  - Provider policy registry remains deterministic.
  - Apple-specific runtime needs are representable.
- Test vectors: `TV-PKG-007`
- Notes: Other providers may continue to exist; these three are the minimum required coverage here.

## OPENAPI-001

- ID: `OPENAPI-001`
- Priority: `P1`
- Statement: a new shared OpenAPI generator MUST exist for `@superfunctions/http` and Python `superfunctions.http` routes.
- Rationale: The user explicitly asked for shared OpenAPI support if no existing package already provides it.
- Acceptance criteria:
  - TypeScript generator emits a deterministic OpenAPI document from route metadata.
  - Python generator emits an equivalent document shape from Python routes.
  - Missing required metadata fails clearly.
- Test vectors: `TV-PKG-008`, `TV-PKG-010`
- Notes: The generator is shared infrastructure, not authfn-specific.

## CLI-001

- ID: `CLI-001`
- Priority: `P0`
- Statement: `@superfunctions/cli` MUST support discovery and schema generation for plugin-composed `authfn` packages and other scoped multi-package libraries.
- Rationale: `authfn` is explicitly being redesigned into a cleaner multi-package architecture.
- Acceptance criteria:
  - `@authfn/core` is discoverable.
  - Plugin-rich `createAuthFn()` configs can be passed into `getSchema()`.
  - Generated schema files remain deterministic.
- Test vectors: `TV-PKG-009`, `TV-PKG-012`
- Notes: This requirement is not limited to authfn; it improves shared CLI behavior.

## PY-001

- ID: `PY-001`
- Priority: `P0`
- Statement: `packages/python-core` MUST add shared auth, OAuth, and OpenAPI modules required by `authfn`.
- Rationale: Python is in scope from the start, and the current shared Python core does not include these modules.
- Acceptance criteria:
  - `superfunctions.auth` exists.
  - `superfunctions.oauth.*` modules exist with parity semantics to the TypeScript shared packages.
  - `superfunctions.http.openapi` exists.
- Test vectors: `TV-PKG-001`, `TV-PKG-010`
- Notes: The packaging model may remain under `python-core`; separate Python package splits are not required.

## ADAPTER-001

- ID: `ADAPTER-001`
- Priority: `P0`
- Statement: `superfunctions-fastapi` and `superfunctions-flask` MUST preserve cookie multiplicity and route metadata fidelity for the new shared Python HTTP model.
- Rationale: Session auth breaks if repeated cookies or metadata are lost at the adapter layer.
- Acceptance criteria:
  - Multiple cookies become multiple `Set-Cookie` headers.
  - Secure, SameSite, and domain attributes are preserved.
  - Route metadata needed by Python OpenAPI generation survives adapter usage.
- Test vectors: `TV-PKG-010`
- Notes: FastAPI’s native OpenAPI may be leveraged, but the shared route metadata remains the source of truth.

## TEST-001

- ID: `TEST-001`
- Priority: `P1`
- Statement: shared packages MUST ship deterministic contract tests, fixtures, and redaction checks for the new auth/http/oauth/openapi behavior.
- Rationale: The new shared surface is cross-cutting and cannot rely on downstream consumers to discover regressions.
- Acceptance criteria:
  - Contract tests cover browser-auth intents, cookie helpers, provider runtime resolvers, CLI generation, and Python cookie propagation.
  - Snapshots and fixtures exclude secrets.
  - `authfn` smoke verification can run against shared packages locally.
- Test vectors: `TV-PKG-011`, `TV-PKG-012`
- Notes: Existing `oauth-testing` should be expanded rather than bypassed.
