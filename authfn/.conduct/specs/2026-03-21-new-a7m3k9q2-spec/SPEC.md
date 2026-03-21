# Metadata

- Timestamp: `2026-03-21T14:40:09Z`
- Agent: `unknown-agent`
- Model: `Codex (GPT-5)`
- Launcher: `Codex Desktop`
- Workspace: `/Users/serro/Documents/dev/n/superfunctions/authfn`
- OS/Shell: `Darwin 25.3.0 arm64` / `/bin/zsh`
- Repo metadata: git repo at `/Users/serro/Documents/dev/n/superfunctions`; branch `heads/next`; commit `6f9a47d6c5f8ac166932e0156efb910bf5e32652`; worktree `dirty`
- Spec folder: `2026-03-21-new-a7m3k9q2-spec`
- Spec path: `/Users/serro/Documents/dev/n/superfunctions/authfn/.conduct/specs/2026-03-21-new-a7m3k9q2-spec`
- Spec type: `new`
- Spec id: `a7m3k9q2`
- Input paths read:
  - `/Users/serro/.codex/skills/spec/SKILL.md`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk/src/types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk/src/schema.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk/src/social-oauth/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/authfn.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/types.py`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/auth/src/types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/http/src/types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/http/src/router.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/cli/src/commands/generate-schema.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/oauth-core/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/oauth-flow/src/service.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/oauth-providers/src/policy-registry.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/python-core/superfunctions/http/types.py`
  - `/Users/serro/Documents/dev/n/21n/services/account/src/lib/auth.ts`
  - `/Users/serro/Documents/dev/n/21n/services/account/src/db/better-auth-schema.ts`
  - `/Users/serro/Documents/dev/n/21n/services/account/src/services/user-lookup.service.ts`
  - `/Users/serro/Documents/dev/n/21n/services/account/src/routes/lookup.ts`
  - `/Users/serro/Documents/dev/n/21n/services/mobile-oauth/src/routes/+page.server.ts`
  - `/Users/serro/Documents/dev/n/nucleus/client/components/account/auth.ts`
  - `/Users/serro/Documents/dev/n/nucleus/client/components/account/CloudSyncLogin.svelte`
  - `/Users/serro/Documents/dev/n/nucleus/client/components/account/ForgotPassword.svelte`
  - `/Users/serro/Documents/dev/n/nucleus/client/components/account/OAuthOptions.svelte`
  - `/Users/serro/Documents/dev/n/nucleus/client/components/oauth/OAuthRedirect.svelte`
  - `/Users/serro/Documents/dev/n/nucleus/client/layout/layers/AuthGuard.svelte`

## Overview

Project name: `authfn`

One-sentence goal: Build `authfn` into a full authentication platform, with TypeScript and Python parity, that can replace Better Auth for `21n` backend and `nucleus` frontend while remaining aligned with superfunctions abstractions.

Target users: application teams using superfunctions, especially teams running browser session auth, social sign-in, password auth, OTP flows, API keys, and multi-region account routing.

Target environments:

- TypeScript server runtimes using Web `Request`/`Response` and `@superfunctions/http` adapters
- Python server runtimes using `superfunctions.http` plus FastAPI/Flask adapters
- Browser frontends using cookie-based session auth and social redirects

Languages/packages required:

- TypeScript packages under `authfn/*`
- Python package under `authfn/python`
- `@superfunctions/http`
- `@superfunctions/db`
- `@superfunctions/auth`
- Shared OAuth packages from `packages/oauth-*`
- Shared OpenAPI support from a packages-level dependency defined in the companion spec

Existing systems it must integrate with:

- `@superfunctions/cli` schema generation
- `@superfunctions/http-*` adapters
- `superfunctions-fastapi` and `superfunctions-flask`
- `21n` account service patterns: browser cookies, OAuth callback handling, region lookup, cross-subdomain session behavior
- `nucleus` frontend flows: password, social, OTP, sign-out, current-session checks

Data model summary:

- Core: `users`, `sessions`
- Plugins: `password_credentials`, `otp_challenges`, `oauth_accounts`, `api_keys`, `two_factor_enrollments`, `two_factor_recovery_codes`, `region_profiles`
- Shared OAuth token/state persistence comes from the companion packages spec and MUST NOT be reimplemented inside `authfn`

Security model:

- Cookie-based browser sessions with CSRF protection
- Password hashing with adaptive algorithms
- Single-use OTP challenges
- Shared OAuth state replay prevention
- Optional 2FA challenge step
- Multi-region routing MUST NOT leak whether an account exists outside allowed lookup semantics
- PII present: email address, names, login metadata, region affinity

Performance constraints:

- Session validation MUST be constant-shape and database-index-backed
- OTP and OAuth state lookups MUST be single-record indexed lookups
- Multi-region lookup MUST support request-time resolution without requiring frontend-side hard-coded region maps

Non-goals:

- No migration plan from Better Auth in this spec bundle
- No support for legacy `nucleus` custom `STOKEN` auth model
- No bundled email/SMS delivery provider implementation; interfaces only

Hard constraints:

- `authfn` MUST reuse `@superfunctions/http`, `@superfunctions/db`, `@superfunctions/auth`, and shared OAuth packages
- `authfn` MUST NOT duplicate shared HTTP router or OAuth protocol logic
- TypeScript and Python support are both in scope from the start
- Plugins SHOULD be used for optional/auth-method-specific behaviors unless a core capability is strictly required for correctness

## Glossary

- `Core capability`: a subsystem that every `authfn` deployment depends on, regardless of plugin selection. Examples: user/session kernel, plugin runtime, schema composition, cookie/session validation.
- `Bundled plugin`: an `authfn` plugin shipped inside the repo and supported as part of the platform. Bundled plugins are in-scope for this spec.
- `Identity method`: a way to prove identity and start or continue a session. In scope: email-password, email OTP, Google/Apple/GitHub OAuth.
- `Session`: a server-persisted browser authentication record represented to the browser via cookies.
- `Challenge`: a short-lived verification unit such as an OTP or 2FA challenge.
- `Region profile`: the region/domain affinity for a user account plus the request-routing data needed to keep auth flows on the correct authority.
- `Runtime resolver`: a request-aware component that provides cookie policy, issuer/base URL, OAuth provider runtime config, and region metadata.

## Goals / Non-goals

### Goals

- `authfn` MUST provide a reusable identity/session kernel based on `@superfunctions/http`, `@superfunctions/db`, and `@superfunctions/auth`.
- `authfn` MUST support Google, Apple, and GitHub browser OAuth sign-in using the shared OAuth packages.
- `authfn` MUST support email-password sign-up/sign-in and email OTP flows including verification and password reset.
- `authfn` MUST support 2FA as a bundled plugin, not as hard-coded core logic.
- `authfn` MUST support multi-region routing as a bundled first-class plugin because it can be implemented via hooks and runtime resolution without changing the core session model.
- `authfn` MUST expose a TypeScript client and a Svelte adapter suitable for `nucleus`.
- `authfn` MUST expose Python server parity using the shared Python abstractions and the shared Python OAuth support defined by the companion packages spec.

### Non-goals

- This spec does not define data migration, cookie cutover, or backward compatibility with Better Auth tables/cookies.
- This spec does not preserve legacy `nucleus` auth contracts outside the Better Auth replacement surface.
- This spec does not define built-in email or SMS provider implementations.

## Public API

### Package layout

TypeScript packages:

- `authfn/core` published as `@authfn/core`
- `authfn/client` published as `@authfn/client`
- `authfn/svelte` published as `@authfn/svelte`

Python package:

- `authfn/python` published as `authfn`

`authfn/ts-sdk` is replaced by the new package layout. Compatibility behavior is undefined in this spec.

### TypeScript core API

```ts
import type { Adapter } from "@superfunctions/db";
import type { Router, Route } from "@superfunctions/http";
import type { AuthProvider, AuthSession } from "@superfunctions/auth";
import type { SchemaDefinition } from "@superfunctions/cli";

export type AuthFnActorType = "user" | "api-key";
export type AuthFnAuthMethod =
  | "password"
  | "email-otp"
  | "oauth-google"
  | "oauth-apple"
  | "oauth-github"
  | "api-key"
  | "two-factor";

export interface AuthFnSession extends AuthSession {
  id: string;
  type: "session" | "api-key";
  actorType: AuthFnActorType;
  actorId: string;
  tenantId?: string;
  regionId?: string;
  methods: AuthFnAuthMethod[];
  primaryEmail?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface AuthFnCookieConfig {
  prefix?: string;
  domain?: string | ((input: { request: Request; regionId?: string }) => string | undefined);
  secure?: boolean | ((request: Request) => boolean);
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  sessionMaxAgeSeconds?: number;
  csrfMaxAgeSeconds?: number;
}

export interface AuthFnRuntimeResolution {
  issuer: string;
  baseUrl: string;
  regionId?: string;
  cookie?: Partial<AuthFnCookieConfig>;
  oauth?: {
    google?: Record<string, unknown>;
    apple?: Record<string, unknown>;
    github?: Record<string, unknown>;
  };
}

export interface AuthFnRuntimeResolver {
  resolve(request: Request): Promise<AuthFnRuntimeResolution> | AuthFnRuntimeResolution;
}

export interface AuthFnHookContext {
  request?: Request;
  runtime?: AuthFnRuntimeResolution;
  pluginName?: string;
  session?: AuthFnSession;
  actorId?: string;
}

export interface AuthFnHooks {
  beforeUserCreate(ctx: AuthFnHookContext, input: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  afterUserCreate(ctx: AuthFnHookContext, user: Record<string, unknown>): Promise<void>;
  beforeSessionIssue(ctx: AuthFnHookContext, input: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  afterSessionIssue(ctx: AuthFnHookContext, session: AuthFnSession): Promise<void>;
  beforeChallengeSend(ctx: AuthFnHookContext, input: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  afterChallengeSend(ctx: AuthFnHookContext, result: Record<string, unknown>): Promise<void>;
  beforeOAuthStart(ctx: AuthFnHookContext, input: Record<string, unknown>): Promise<Record<string, unknown> | void>;
  afterOAuthCallback(ctx: AuthFnHookContext, result: Record<string, unknown>): Promise<void>;
}

export interface AuthFnPlugin {
  name: string;
  schema?: (config: AuthFnConfig) => SchemaDefinition["schemas"];
  routes?: (ctx: AuthFnPluginRuntimeContext) => Route[];
  hooks?: Partial<AuthFnHooks>;
  validateConfig?: (config: AuthFnConfig) => void;
}

export interface AuthFnConfig {
  database: Adapter;
  namespace?: string;
  basePath?: string;
  cookie?: AuthFnCookieConfig;
  runtime?: AuthFnRuntimeResolver;
  hooks?: Partial<AuthFnHooks>;
  plugins: AuthFnPlugin[];
  openApi?: boolean | { title: string; version: string };
}

export interface AuthFnInstance {
  router: Router;
  provider: AuthProvider<AuthFnSession>;
  getSchema(): SchemaDefinition;
  openApi?(): Record<string, unknown>;
}

export function createAuthFn(config: AuthFnConfig): AuthFnInstance;
export function getSchema(config: AuthFnConfig): SchemaDefinition;
```

### Required bundled plugins

`@authfn/core` MUST export the following plugin factory functions:

```ts
export function authFnPasswordPlugin(config: PasswordPluginConfig): AuthFnPlugin;
export function authFnEmailOtpPlugin(config: EmailOtpPluginConfig): AuthFnPlugin;
export function authFnSocialOAuthPlugin(config: SocialOAuthPluginConfig): AuthFnPlugin;
export function authFnApiKeyPlugin(config: ApiKeyPluginConfig): AuthFnPlugin;
export function authFnTwoFactorPlugin(config: TwoFactorPluginConfig): AuthFnPlugin;
export function authFnMultiRegionPlugin(config: MultiRegionPluginConfig): AuthFnPlugin;
```

### TypeScript client API

```ts
export interface AuthFnClient {
  getSession(): Promise<AuthFnSessionEnvelope>;
  signUpWithPassword(input: { email: string; password: string; profile?: Record<string, unknown> }): Promise<AuthFnSessionEnvelope>;
  signInWithPassword(input: { email: string; password: string }): Promise<AuthFnSessionEnvelope>;
  signOut(input?: { allSessions?: boolean }): Promise<AuthFnSuccessEnvelope>;
  listSessions(): Promise<AuthFnListSessionsEnvelope>;
  revokeSession(input: { sessionId: string }): Promise<AuthFnSuccessEnvelope>;
  sendOtp(input: { purpose: "verify-email" | "sign-in" | "reset-password"; email: string }): Promise<AuthFnOtpEnvelope>;
  verifyOtp(input: { purpose: "verify-email" | "sign-in" | "reset-password"; email: string; code: string }): Promise<AuthFnSessionEnvelope | AuthFnSuccessEnvelope>;
  startSocialSignIn(input: { provider: "google" | "apple" | "github"; returnTo: string }): Promise<{ redirectTo: string }>;
  enableTwoFactor(): Promise<{ secret: string; recoveryCodes: string[]; challengeId: string }>;
  confirmTwoFactor(input: { challengeId: string; code: string }): Promise<AuthFnSuccessEnvelope>;
}
```

`@authfn/svelte` MUST provide a thin adapter:

```ts
export function createAuthFnSessionStore(client: AuthFnClient): Readable<AuthFnSession | null>;
export function createAuthFnClientContext(client: AuthFnClient): { client: AuthFnClient };
```

### Python API

```py
from authfn import create_authfn, get_schema
from authfn.types import AuthFnConfig, AuthFnPlugin, AuthFnSession

auth = create_authfn(
    AuthFnConfig(
        database=adapter,
        namespace="authfn",
        base_path="/auth",
        plugins=[...],
        runtime=runtime_resolver,
        open_api=True,
    )
)

router = auth.router
provider = auth.provider
schema = get_schema(config)
```

Python MUST expose plugin factories paralleling TypeScript names and semantics.

### HTTP endpoints

All successful JSON endpoints MUST return the success envelope defined below unless they intentionally return a redirect response.

Core/session routes:

- `GET /auth/session`
- `GET /auth/sessions`
- `POST /auth/sign-out`
- `POST /auth/sessions/:sessionId/revoke`

Password routes:

- `POST /auth/sign-up/password`
- `POST /auth/sign-in/password`

OTP routes:

- `POST /auth/otp/send`
- `POST /auth/otp/verify`
- `POST /auth/password/reset/start`
- `POST /auth/password/reset/complete`

Social routes:

- `POST /auth/social/start`
- `GET /auth/social/callback/:provider`
- `POST /auth/social/disconnect/:provider`

2FA routes:

- `POST /auth/2fa/enroll`
- `POST /auth/2fa/confirm`
- `POST /auth/2fa/challenge`
- `POST /auth/2fa/disable`

API key routes:

- `POST /auth/api-keys`
- `GET /auth/api-keys`
- `DELETE /auth/api-keys/:keyId`

Multi-region routes:

- `POST /auth/regions/lookup`
- `GET /auth/runtime`

### Events

`authfn` MUST emit structured events for:

- `authfn.user.created`
- `authfn.session.issued`
- `authfn.session.revoked`
- `authfn.otp.sent`
- `authfn.otp.verified`
- `authfn.oauth.started`
- `authfn.oauth.completed`
- `authfn.api_key.created`
- `authfn.api_key.revoked`
- `authfn.2fa.enabled`
- `authfn.2fa.challenged`
- `authfn.region.lookup`

## Data formats / protocol

### Canonical JSON envelopes

Success:

```json
{
  "ok": true,
  "data": {},
  "requestId": "req_01HZYX..."
}
```

Error:

```json
{
  "ok": false,
  "error": {
    "code": "AUTHFN_INVALID_CREDENTIALS",
    "message": "Invalid email or password",
    "retryable": false,
    "details": {}
  },
  "requestId": "req_01HZYX..."
}
```

### Required error codes

- `AUTHFN_VALIDATION_ERROR`
- `AUTHFN_INVALID_CREDENTIALS`
- `AUTHFN_SESSION_EXPIRED`
- `AUTHFN_SESSION_REVOKED`
- `AUTHFN_CSRF_INVALID`
- `AUTHFN_EMAIL_NOT_VERIFIED`
- `AUTHFN_OTP_INVALID`
- `AUTHFN_OTP_EXPIRED`
- `AUTHFN_OTP_REPLAYED`
- `AUTHFN_OAUTH_PROVIDER_UNSUPPORTED`
- `AUTHFN_OAUTH_CALLBACK_INVALID`
- `AUTHFN_OAUTH_STATE_REPLAYED`
- `AUTHFN_REDIRECT_URI_DISALLOWED`
- `AUTHFN_2FA_REQUIRED`
- `AUTHFN_2FA_INVALID_CODE`
- `AUTHFN_API_KEY_REVOKED`
- `AUTHFN_REGION_MISMATCH`
- `AUTHFN_REGION_NOT_FOUND`
- `AUTHFN_PLUGIN_ABORTED`
- `AUTHFN_DELIVERY_FAILED`
- `AUTHFN_RATE_LIMITED`
- `AUTHFN_NOT_FOUND`
- `AUTHFN_CONFLICT`
- `AUTHFN_INTERNAL_ERROR`

### Session cookie model

- Browser sessions MUST be database-backed.
- Session secrets MUST be stored hashed at rest.
- A deployment MUST issue at least:
  - one HTTP-only session cookie
  - one CSRF cookie for unsafe cookie-authenticated requests
- The session cookie MUST default to `Secure` and `SameSite=Lax`.
- The runtime resolver or multi-region plugin MAY elevate callback flows to `SameSite=None` when cross-site OAuth callbacks require it.
- Cookie naming MUST be prefix-based and deterministic within a deployment.

### OTP model

- OTP challenges MUST store purpose, identifier, code hash, expiration, attempt count, consumed-at timestamp, and delivery metadata.
- OTP verification MUST be single-use.
- OTP delivery MUST be performed through a provider-agnostic interface.

### OAuth model

- Social sign-in MUST rely on the shared OAuth packages for protocol, state, token exchange, and provider policy.
- `authfn` MUST store local account linkage in `oauth_accounts`.
- OAuth callback completion MUST be able to issue a session cookie and either return JSON or execute an allowlisted redirect.

### Multi-region model

- Multi-region data MUST include `regionId`, `authority`, and optional `domain`.
- Region lookup responses MUST be explicit about whether the caller should continue locally or redirect to another authority.
- Multi-region plugin state MUST be derived from a plugin resolver and MUST NOT be hard-coded into frontend packages.

## Semantics

### Core architecture

- `authfn` MUST use a core-plus-plugins design.
- Core capabilities are: user/session kernel, cookie/session validation, plugin runner, schema composer, HTTP router composition, and provider integration with `@superfunctions/auth`.
- Password, OTP, social OAuth, API keys, 2FA, and multi-region behavior MUST be delivered as bundled plugins.
- Plugin route registration order MUST follow the `plugins` array order.
- Plugin schema contributions MUST be merged deterministically in registration order and rejected on table/field collisions.

### Hook semantics

- `before*` hooks MUST be fail-closed.
- `before*` hooks MAY transform the payload passed to later hooks.
- `after*` hooks MUST be fail-open.
- `after*` hooks MAY observe results; they MUST NOT mutate persisted core state after commit unless the specific hook contract explicitly permits it.
- Multi-region plugin hooks are allowed to reroute request handling by returning structured redirect/routing data.

### Password semantics

- Password sign-up MUST create a user and a password credential record in one logical transaction.
- Password sign-in MUST create or rotate a session on success.
- Password hashing MUST be adaptive and configuration-safe; raw passwords MUST NOT be persisted or logged.

### OTP semantics

- `verify-email` MUST mark the email address verified and MUST NOT create a second user.
- `sign-in` MUST be able to establish a session when the OTP challenge succeeds.
- `reset-password` MUST only permit password change after a valid reset-purpose OTP challenge.

### Social semantics

- Google, Apple, and GitHub MUST be supported.
- Social callback completion MUST link the provider account to the local user record.
- When an existing account is found by verified email, linking behavior MUST be deterministic and documented by plugin config.
- Apple sign-in MUST support provider runtime secrets/resolvers supplied through the shared OAuth packages.

### API key semantics

- API keys MUST be stored hashed at rest.
- API key secrets MUST be shown exactly once on creation.
- API key auth MUST integrate with `@superfunctions/auth` provider semantics.

### 2FA semantics

- 2FA MUST be implemented as a second-step plugin layered on top of a primary identity method.
- 2FA MUST support enrollment, confirmation, challenge, disable, and recovery codes.
- Enabling 2FA MUST NOT bypass the core session issuance logic; the session MUST reflect that 2FA was satisfied.

### Multi-region semantics

- Multi-region MUST be a bundled plugin rather than a core subsystem because it can be expressed through runtime resolution, plugin routes, schema contribution, and lifecycle hooks without changing the session kernel.
- Multi-region plugin MUST support:
  - region lookup by sign-in identifier
  - request-host-aware runtime resolution
  - region mismatch detection before completing sign-in
  - post-user-create registration with a pluggable global directory
  - region-aware cookie policy and social provider runtime config
- Multi-region plugin MUST expose both local-only and external-directory-backed operation modes.

### Python parity semantics

- Python behavior MUST match TypeScript endpoint names, payload shapes, error codes, and schema output.
- Python adapters MUST preserve cookie behavior defined by the shared packages spec.
- Python plugin hooks MUST follow the same fail-closed/fail-open semantics as TypeScript.

## Invariants

- Route names, route paths, and envelope shapes MUST be deterministic for a given plugin set.
- Schema output MUST be deterministic for a given config and plugin order.
- Session revocation MUST invalidate subsequent use immediately after the persistence write commits.
- OTP codes and recovery codes MUST be single-use.
- OAuth state MUST be single-use and replay-protected by the shared OAuth packages.
- `authfn` MUST NOT reimplement OAuth state handling or token exchange internally.
- Open redirect behavior is forbidden; every redirect target MUST be allowlisted by config or runtime resolver.

## Security

- Session cookies MUST be HTTP-only and secure by default.
- Unsafe session-bound requests MUST enforce CSRF protection.
- Password hashing MUST use a modern adaptive algorithm with configurable cost.
- Provider credentials, OTP codes, password hashes, API key secrets, OAuth access tokens, and refresh tokens MUST NOT appear in logs or emitted events.
- Multi-region lookup MUST return the minimum routing data required for the client to continue the auth flow.
- Plugin hook failures MUST be surfaced as structured auth errors, never as raw stack traces.

## Limits/caps

- Session max age MUST default to 7 days unless configured otherwise.
- OTP lifetime MUST default to 10 minutes and MUST be configurable.
- OTP attempts per challenge MUST be capped; default 5.
- Recovery code batch size MUST default to 10.
- API key name length MUST be capped; default 128 UTF-8 bytes.
- Allowed social providers are exactly `google`, `apple`, and `github` unless expanded in a future spec.

## Observability

- `authfn` MUST emit structured lifecycle events without secrets.
- Request IDs MUST be included in every envelope and event.
- Session issuance, OTP send/verify, OAuth start/callback, 2FA challenge, API key create/revoke, and region lookup MUST be measurable and testable.
- Plugin hooks SHOULD be traceable by plugin name and hook name.

## Compatibility / versioning strategy

- `authfn` MUST version its public HTTP surface and package exports semantically.
- Shared-package dependencies MUST be treated as stable contracts once implemented.
- Plugin route metadata MUST be stable enough to drive shared OpenAPI generation.

## Undefined / Explicitly user-deferred only

- Migration and cutover planning from Better Auth to `authfn`
- Compatibility with legacy `nucleus` auth flows outside the Better Auth replacement surface
