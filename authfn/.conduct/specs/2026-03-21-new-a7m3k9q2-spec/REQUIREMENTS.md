# Requirement Index

- `ARCH-001`
- `CORE-001`
- `CORE-002`
- `HTTP-001`
- `DATA-001`
- `SESS-001`
- `PASS-001`
- `OTP-001`
- `OTP-002`
- `SOC-001`
- `SOC-002`
- `API-001`
- `TFA-001`
- `REGION-001`
- `PLUG-001`
- `CLIENT-001`
- `PY-001`
- `OAS-001`
- `OBS-001`

## ARCH-001

- ID: `ARCH-001`
- Priority: `P0`
- Statement: `authfn` MUST be restructured as a multi-package architecture with `@authfn/core`, `@authfn/client`, `@authfn/svelte`, and Python parity under `authfn/python`.
- Rationale: The required feature set is larger than the current single API-key package and needs clear boundaries without duplicating shared packages.
- Acceptance criteria:
  - `authfn/core` exposes `createAuthFn` and `getSchema`.
  - `authfn/client` exposes the typed browser client.
  - `authfn/svelte` exposes only thin Svelte wrappers over `authfn/client`.
  - Python package exposes matching server-side constructs and plugin factories.
- Test vectors: `TV-AF-001`, `TV-AF-014`
- Notes: Compatibility with the current `authfn/ts-sdk` package name is undefined in this spec.

## CORE-001

- ID: `CORE-001`
- Priority: `P0`
- Statement: `@authfn/core` MUST implement a user/session kernel using `@superfunctions/http`, `@superfunctions/db`, and `@superfunctions/auth`, and MUST NOT duplicate router or database abstraction logic.
- Rationale: The core replacement for Better Auth depends on browser sessions and reusable auth provider integration.
- Acceptance criteria:
  - Core router is built from `@superfunctions/http` routes.
  - Persistence uses `@superfunctions/db` adapter calls and `getSchema`.
  - `provider.authenticate()` returns `AuthFnSession` for session and API-key auth.
  - No internal custom router/database abstraction is introduced.
- Test vectors: `TV-AF-001`, `TV-AF-002`, `TV-AF-009`
- Notes: Cookie helpers and OpenAPI support come from shared packages, not from custom duplicated code.

## CORE-002

- ID: `CORE-002`
- Priority: `P0`
- Statement: `@authfn/core` MUST compose plugin schemas and plugin routes deterministically in registration order.
- Rationale: Password, OTP, social auth, 2FA, API keys, and multi-region support are all plugin-driven.
- Acceptance criteria:
  - `getSchema(config)` merges plugin table schemas.
  - Duplicate table names or field collisions fail deterministically with a structured error.
  - Router output for a fixed config is stable across runs.
- Test vectors: `TV-AF-001`, `TV-AF-012`
- Notes: The plugin contract is part of the public platform.

## HTTP-001

- ID: `HTTP-001`
- Priority: `P0`
- Statement: `authfn` MUST expose a stable HTTP API for session, password, OTP, social OAuth, 2FA, API keys, and multi-region lookup/runtime routes.
- Rationale: Replacing Better Auth in `21n` and `nucleus` requires a complete route surface, not only internal services.
- Acceptance criteria:
  - All routes listed in `SPEC.md` exist.
  - JSON success/error envelopes are canonical and request-id-carrying.
  - Redirect-based routes enforce allowlisted redirect behavior.
  - CSRF is enforced on unsafe session-bound routes.
- Test vectors: `TV-AF-002`, `TV-AF-004`, `TV-AF-006`, `TV-AF-010`, `TV-AF-011`, `TV-AF-013`
- Notes: Routes MAY be mounted under a configurable base path.

## DATA-001

- ID: `DATA-001`
- Priority: `P0`
- Statement: `authfn` MUST define deterministic schemas for users, sessions, password credentials, OTP challenges, OAuth accounts, API keys, 2FA data, and multi-region profile data.
- Rationale: `@superfunctions/cli` generation and ORM portability depend on stable abstract schemas.
- Acceptance criteria:
  - `getSchema()` returns all required tables for enabled plugins.
  - Required indexes exist for session lookup, email lookup, OTP lookup, OAuth account lookup, API key lookup, and region lookup.
  - Secrets are stored hashed or encrypted as appropriate.
- Test vectors: `TV-AF-001`, `TV-AF-009`, `TV-AF-010`, `TV-AF-011`
- Notes: Shared OAuth token/state tables come from the shared packages spec and MUST NOT be duplicated.

## SESS-001

- ID: `SESS-001`
- Priority: `P0`
- Statement: `authfn` MUST implement secure cookie-based browser sessions with session listing, session revocation, configurable cookie policy, and CSRF protection.
- Rationale: Browser session behavior is the baseline replacement surface for Better Auth.
- Acceptance criteria:
  - Successful sign-in issues an HTTP-only session cookie and a CSRF cookie.
  - `GET /auth/session` returns the current session or a structured unauthenticated response.
  - `GET /auth/sessions` lists active sessions deterministically.
  - Revoked or expired sessions stop authenticating immediately.
- Test vectors: `TV-AF-002`, `TV-AF-013`, `TV-AF-016`
- Notes: Multi-session support is part of this requirement.

## PASS-001

- ID: `PASS-001`
- Priority: `P0`
- Statement: `authfn` MUST provide an email-password plugin with sign-up, sign-in, password hashing, and password reset integration hooks.
- Rationale: Email-password is a required sign-in method for the replacement target.
- Acceptance criteria:
  - Sign-up creates a user plus password credential in one logical transaction.
  - Sign-in verifies the stored hash and issues a session.
  - Wrong-password responses use canonical error codes.
  - Password-change completion is compatible with the reset OTP flow.
- Test vectors: `TV-AF-002`, `TV-AF-003`, `TV-AF-005`
- Notes: Built-in delivery is out of scope; reset depends on the OTP plugin.

## OTP-001

- ID: `OTP-001`
- Priority: `P0`
- Statement: `authfn` MUST provide an email OTP plugin supporting `verify-email`, `sign-in`, and `reset-password` challenge purposes through a provider-agnostic delivery interface.
- Rationale: `nucleus` depends on OTP-based account verification and recovery flows.
- Acceptance criteria:
  - Sending an OTP stores a hashed, expiring, single-use challenge.
  - Verifying an OTP enforces purpose matching and expiration.
  - `verify-email` marks the address verified.
  - `sign-in` may issue a session on success.
- Test vectors: `TV-AF-004`, `TV-AF-005`
- Notes: Other delivery channels are undefined; `email` is the only required channel in this spec.

## OTP-002

- ID: `OTP-002`
- Priority: `P0`
- Statement: `authfn` MUST expose OTP send/verify hooks so downstream integrations can customize delivery metadata, throttling, and post-verification side effects.
- Rationale: Provider-agnostic delivery and region-aware auth both require extensibility around OTP lifecycle.
- Acceptance criteria:
  - `beforeChallengeSend` can transform or reject a send request.
  - `afterChallengeSend` can observe send results without mutating committed challenge state.
  - OTP plugin emits lifecycle events without leaking codes.
- Test vectors: `TV-AF-004`, `TV-AF-012`
- Notes: Fail-closed/fail-open semantics follow the plugin runtime contract.

## SOC-001

- ID: `SOC-001`
- Priority: `P0`
- Statement: `authfn` MUST provide a social OAuth plugin for Google, Apple, and GitHub sign-in using the shared OAuth packages for protocol, state, token, and provider policy handling.
- Rationale: Social sign-in is required, and the repo already contains shared OAuth primitives that must be reused.
- Acceptance criteria:
  - Start flow returns a validated authorization URL.
  - Callback flow verifies state and provider configuration via shared packages.
  - Successful callback links a local OAuth account and issues a session.
  - Unsupported providers are rejected with canonical errors.
- Test vectors: `TV-AF-006`, `TV-AF-007`, `TV-AF-008`
- Notes: `authfn` owns local account linking and session issuance, not shared OAuth protocol internals.

## SOC-002

- ID: `SOC-002`
- Priority: `P0`
- Statement: `authfn` social sign-in MUST support callback completion for browser, embedded, and mobile redirect patterns through allowlisted redirect targets and plugin hooks.
- Rationale: The replacement target includes non-trivial OAuth callback completion behavior.
- Acceptance criteria:
  - Callback completion supports JSON and redirect outcomes.
  - Redirect targets are allowlisted.
  - Plugin hooks can transform final redirect decisions.
  - State replay or redirect mismatch produces canonical errors.
- Test vectors: `TV-AF-006`, `TV-AF-011`, `TV-AF-012`
- Notes: Deep-link utilities come from the shared packages spec.

## API-001

- ID: `API-001`
- Priority: `P0`
- Statement: `authfn` MUST provide an API key plugin with create/list/revoke flows, hashed-at-rest secrets, and `@superfunctions/auth` provider integration.
- Rationale: The current `authfn` capability set must remain available inside the broader platform.
- Acceptance criteria:
  - API key secret is returned exactly once at creation.
  - Stored secret material is hashed.
  - Revoked keys stop authenticating immediately.
  - API keys are listable without secret disclosure.
- Test vectors: `TV-AF-009`
- Notes: Fine-grained permission models beyond scopes are undefined in this spec.

## TFA-001

- ID: `TFA-001`
- Priority: `P0`
- Statement: `authfn` MUST provide 2FA as a bundled plugin supporting enrollment, confirmation, login challenge, disable, and recovery codes.
- Rationale: 2FA is explicitly in scope and should remain decoupled from the core session engine.
- Acceptance criteria:
  - Enrolling 2FA produces a secret and recovery codes.
  - Confirming 2FA requires a valid code.
  - When 2FA is enabled, primary sign-in produces a challenge requirement instead of a completed session until satisfied.
  - Recovery codes are single-use.
- Test vectors: `TV-AF-010`
- Notes: TOTP is the required mechanism in this spec; other 2FA methods are undefined.

## REGION-001

- ID: `REGION-001`
- Priority: `P0`
- Statement: `authfn` MUST ship a bundled multi-region plugin that supports request-aware runtime resolution, region lookup, region mismatch handling, and pluggable global-directory integration.
- Rationale: `21n` and `nucleus` require multi-region auth behavior as a first-class supported feature.
- Acceptance criteria:
  - `POST /auth/regions/lookup` returns deterministic routing guidance.
  - Runtime resolution can vary issuer/base URL/cookie policy/provider config by request.
  - Region mismatch is surfaced as a canonical auth error with redirect metadata.
  - Plugin hooks support post-user-create directory registration.
- Test vectors: `TV-AF-011`, `TV-AF-012`
- Notes: This is a bundled plugin rather than a core capability because the session kernel remains region-agnostic.

## PLUG-001

- ID: `PLUG-001`
- Priority: `P0`
- Statement: `authfn` MUST expose a deterministic plugin and hook system with fail-closed `before*` hooks and fail-open `after*` hooks.
- Rationale: Optional capabilities like 2FA and multi-region routing depend on composable lifecycle control.
- Acceptance criteria:
  - Built-in plugins are regular plugins using the same public interface.
  - `before*` hook failures abort the operation with structured errors.
  - `after*` hook failures are observable but do not roll back committed core operations.
  - Plugin execution order follows registration order.
- Test vectors: `TV-AF-012`
- Notes: Only explicitly documented hooks are part of the stable contract.

## CLIENT-001

- ID: `CLIENT-001`
- Priority: `P1`
- Statement: `authfn` MUST provide a typed browser client and a thin Svelte adapter aligned to `authfn` semantics rather than Better Auth compatibility shims.
- Rationale: The frontend replacement target needs a supported client surface, but the user asked to optimize for clean `authfn` design.
- Acceptance criteria:
  - `@authfn/client` supports current-session, password, OTP, social, sign-out, and session-list actions.
  - `@authfn/client` works with cookie credentials by default.
  - `@authfn/svelte` only wraps the client and MUST NOT reimplement auth logic.
- Test vectors: `TV-AF-013`
- Notes: The API shape may differ from Better Auth.

## PY-001

- ID: `PY-001`
- Priority: `P0`
- Statement: `authfn` MUST provide Python parity for core behavior, bundled plugins, HTTP routes, schema generation, and error codes.
- Rationale: Python is explicitly in scope from the start.
- Acceptance criteria:
  - Python routes expose the same path names and JSON envelopes.
  - Python plugin factories mirror TypeScript plugin capability.
  - Python `get_schema()` output matches TypeScript semantics.
  - Python tests cover cookies, OTP, social callbacks, API keys, 2FA, and multi-region behavior.
- Test vectors: `TV-AF-014`
- Notes: Shared Python OAuth and HTTP/OpenAPI primitives are defined in the companion packages spec.

## OAS-001

- ID: `OAS-001`
- Priority: `P1`
- Statement: `authfn` MUST expose OpenAPI output through a shared packages-level dependency rather than implementing a bespoke OpenAPI generator.
- Rationale: The user explicitly asked that OpenAPI be shared if it does not already exist.
- Acceptance criteria:
  - Routes carry metadata required by the shared OpenAPI generator.
  - `authfn` can emit a deterministic OpenAPI document when enabled.
  - TypeScript and Python route surfaces are both representable.
- Test vectors: `TV-AF-015`
- Notes: The actual generator lives in the companion packages spec.

## OBS-001

- ID: `OBS-001`
- Priority: `P1`
- Statement: `authfn` MUST emit structured observability events and logs without leaking secrets or raw credential material.
- Rationale: A production auth platform needs lifecycle visibility and safe failure diagnosis.
- Acceptance criteria:
  - All core auth flows emit request-id-linked events.
  - Sensitive values are redacted or omitted.
  - Plugin failures are attributable by plugin name and hook name.
- Test vectors: `TV-AF-012`, `TV-AF-015`, `TV-AF-016`
- Notes: Shared event schemas and redaction helpers may be supplied by packages-level dependencies.
