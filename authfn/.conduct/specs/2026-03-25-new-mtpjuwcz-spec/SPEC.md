# Metadata

- Timestamp: `2026-03-25T11:04:02Z`
- Agent: `unknown-agent`
- Model: `Codex (GPT-5)`
- Launcher: `Codex Desktop`
- Workspace: `/Users/serro/.codex/worktrees/b39f/superfunctions`
- OS/Shell: `Darwin 25.3.0 arm64` / `/bin/zsh`
- Repo metadata: git repo at `/Users/serro/.codex/worktrees/b39f/superfunctions`; branch `HEAD`; commit `ca86e25e6faf11da93e390c18dad8ae5f22b6f69`; worktree `clean`
- Spec folder: `2026-03-25-new-mtpjuwcz-spec`
- Spec path: `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/.conduct/specs/2026-03-25-new-mtpjuwcz-spec`
- Spec type: `new`
- Spec id: `mtpjuwcz`
- Input paths read:
  - `/Users/serro/.codex/skills/spec/SKILL.md`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/AGENTS.md`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/package.json`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/package.json`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/README.md`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/types.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/plugin-types.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/schema.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/plugin-runner.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/openapi.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/http/router.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/core/cookies.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/core/errors.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/plugins/email-password.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/plugins/api-keys.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/plugins/two-factor.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/core/src/plugins/social-oauth.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/client/src/index.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/client/src/types.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/client/src/http-client.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/http-express/README.md`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/db/src/adapters/drizzle/index.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/db/src/adapter/factory.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/cli/src/cli.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/cli/src/commands/generate-schema.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/cli/src/commands/generate.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/cli/src/utils/discover-packages.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/cli/src/utils/parse-library-init.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/packages/cli/src/utils/schema-generators.ts`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/datafn/examples/sharing-app/README.md`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/datafn/examples/sharing-app/package.json`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/datafn/examples/sharing-app/server/package.json`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/datafn/examples/sharing-app/client/package.json`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/filefn/examples/full-demo/README.md`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/filefn/examples/full-demo/server/package.json`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/filefn/examples/full-demo/client/package.json`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/.conduct/specs/2026-03-21-new-a7m3k9q2-spec/SPEC.md`
  - `/Users/serro/.codex/worktrees/b39f/superfunctions/authfn/.conduct/specs/2026-03-21-new-a7m3k9q2-spec/TEST_VECTORS.md`

## Overview

Project name: `authfn` example apps portfolio

One-sentence goal: Create a portfolio of focused, deterministic `authfn` example apps that each demonstrate a bounded authentication capability, use CLI-generated Postgres/Drizzle schemas, and double as Playwright-grade end-to-end fixtures.

Target users:

- `authfn` maintainers validating feature behavior across browser flows
- downstream application teams learning how to compose `@authfn/core`, `@authfn/client`, `@authfn/svelte`, and shared HTTP adapters
- CI or local developers needing deterministic end-to-end fixtures for password, OTP, OAuth, 2FA, API-key, and multi-region flows

Target environments:

- TypeScript-only example apps
- Node.js 18+ example servers
- browser clients driven by Playwright Chromium
- local development on macOS/Linux using HTTP on localhost
- local Postgres supplied via Docker Compose or a user-provided `DATABASE_URL`

Languages/packages required:

- `@authfn/core`
- `@authfn/client`
- `@authfn/svelte`
- `@superfunctions/http-express`
- `@superfunctions/db`
- `@superfunctions/cli`
- `drizzle-orm`
- `postgres`
- `express`
- `svelte`
- `vite`
- `@playwright/test`

Existing systems it must integrate with:

- root npm workspaces in `/Users/serro/.codex/worktrees/b39f/superfunctions/package.json`
- `authfn` plugin and client packages
- `packages/cli` schema generation flow
- Drizzle schema generation and `drizzle-kit push`
- existing example conventions established by `datafn/examples/sharing-app` and `filefn/examples/full-demo`

Data model summary:

- Example infrastructure: scenario definitions, demo reset state, fake OTP inbox state, fake OAuth account fixtures, captured event ring buffer
- Auth tables: `users`, `sessions`, and the plugin-specific tables contributed by the selected example plugins
- Example-specific data: stable seed identities, region routing fixtures, fake provider accounts, API key records created through auth routes

Security model:

- Example auth surfaces remain cookie/session and API-key based through `authfn`
- Demo-only helper routes are local-development fixtures and MUST NOT be designed as production-ready control planes
- PII in examples is fake and deterministic
- Passwords, OTP codes, API key secrets, OAuth tokens, and recovery codes MUST NOT be emitted via observability logs; they MAY only appear in explicit demo fixtures whose purpose is deterministic test control

Performance constraints:

- Examples MUST optimize for determinism and clarity over throughput
- Each example MUST cold-start locally within the same order of magnitude as existing demo apps in the repo
- Playwright suites MUST run without external network dependencies

Non-goals:

- Python example apps
- live third-party Google/GitHub/Apple credentials
- a single “all features in one screen” mega-demo
- a cross-framework auth example matrix in this bundle
- deployment automation beyond local run/build/test/db-generate/db-push workflows

Hard constraints:

- Server auth schemas MUST be generated with `packages/cli` and MUST NOT be hand-written
- Example servers MUST use Postgres with Drizzle for persisted auth state
- Example apps MUST be split into focused examples rather than one bloated example
- The portfolio MUST cover the five apps previously ideated:
  - `password-sessions`
  - `otp-recovery`
  - `social-oauth`
  - `account-settings`
  - `multi-region-routing`
- Deterministic Playwright fixtures MUST be first-class scope, not an afterthought

Assumptions:

- The canonical server stack for examples is Express plus `@superfunctions/http-express` because `authfn` intentionally does not ship an `authfn/server` wrapper.
- The canonical browser stack for examples is Svelte 5 plus Vite so the examples exercise both `@authfn/client` and `@authfn/svelte`.
- A single shared Postgres service MAY back all examples as long as each example uses an isolated namespace.

## Glossary

- Example portfolio: the full `authfn/examples/*` workspace set.
- Example root: the top-level directory for a single scenario, containing `package.json`, `README.md`, `playwright.config.ts`, `e2e/`, `server/`, and `client/`.
- Shared harness: the private workspace package that removes duplication across example apps.
- Scenario: the bounded auth capability demonstrated by one example app.
- Demo route: a route mounted only by example servers for deterministic reset, inspection, or fake-provider behavior.
- Schema generation path: the required flow of `superfunctions generate-schema` producing the Drizzle schema consumed by the example server.
- Plugin descriptor: a static representation of a plugin factory call extracted by the CLI from `createAuthFn(...)` source.
- Fake provider: a deterministic local OAuth provider implementation used instead of live external identity providers.
- Authority: the base URL the multi-region example treats as canonical for a region.

## Goals / Non-goals

### Goals

- The repo MUST expose a scalable `authfn/examples` portfolio rather than a single overloaded example.
- Every example MUST be executable manually and verifiable automatically with Playwright.
- Every example server MUST use generated Drizzle auth schemas from `@superfunctions/cli`.
- The example portfolio MUST demonstrate the actual `authfn` surface, including the feature areas not currently covered by the browser client API.
- The shared harness MUST make scenario seeding, fake delivery, fake OAuth, and event capture deterministic.

### Non-goals

- This bundle does not add Python parity for browser examples.
- This bundle does not introduce a published `authfn/server` package.
- This bundle does not cover production OAuth trust setup with live providers.
- This bundle does not define hosted preview infrastructure.

## Public API

### Workspace and package layout

The root workspace manifest MUST include:

- `authfn/examples/*`
- `authfn/examples/*/*`

The portfolio MUST add the following private workspaces:

- `authfn/examples/shared`
- `authfn/examples/password-sessions`
- `authfn/examples/otp-recovery`
- `authfn/examples/social-oauth`
- `authfn/examples/account-settings`
- `authfn/examples/multi-region-routing`

Each example root MUST contain:

- `README.md`
- `package.json`
- `playwright.config.ts`
- `e2e/`
- `server/`
- `client/`

Each example server MUST contain:

- `package.json`
- `tsconfig.json`
- `superfunctions.config.ts`
- `drizzle.config.ts`
- `src/auth.ts`
- `src/db/client.ts`
- `src/db/generated/authfn-schema.ts` generated by CLI
- `src/index.ts`

Each example client MUST contain:

- `package.json`
- `tsconfig.json`
- `vite.config.ts`
- `index.html`
- `src/main.ts`
- `src/App.svelte`

### Shared harness exports

`authfn/examples/shared` MUST export utilities that cover:

- deterministic seed fixtures for each scenario
- Express app composition for example servers
- local cookie-policy helpers for non-TLS localhost
- event capture and in-memory event ring buffer access
- demo reset route registration
- OTP inbox capture and query
- fake OAuth provider registration and identity fixtures
- stable `data-testid` constants or helper builders
- Playwright helper functions for reset and inbox reads

### Server composition contract

Each example server MUST:

1. create a Postgres-backed Drizzle instance
2. import generated tables from `src/db/generated/authfn-schema.ts`
3. create a Drizzle adapter from `@superfunctions/db/adapters`
4. create `auth` with `createAuthFn(...)`
5. mount `auth.router` via `toExpress(...)`
6. mount example-only demo routes from the shared harness

### CLI integration contract

`@authfn/core` MUST expose package metadata in `package.json`:

```json
{
  "superfunctions": {
    "initFunction": "createAuthFn",
    "schemaVersion": 1,
    "libraryNames": ["authfn"]
  }
}
```

The CLI parser MUST preserve plugin factory calls as static descriptors:

```ts
interface StaticCallDescriptor {
  __functionCall: string;
  __args?: unknown[];
}
```

`@authfn/core.getSchema(config)` MUST accept `config.plugins` entries that are either:

- live `AuthFnPlugin` objects
- `StaticCallDescriptor` values for bundled plugin factories

Bundled plugin factories that MUST resolve from descriptors:

- `authFnPasswordPlugin`
- `authFnEmailOtpPlugin`
- `authFnSocialOAuthPlugin`
- `authFnApiKeyPlugin`
- `authFnTwoFactorPlugin`
- `authFnMultiRegionPlugin`

### Browser client API expansion

`@authfn/client` MUST add or expose typed helpers for example-covered routes that are currently absent:

```ts
interface AuthFnClient {
  createApiKey(input: {
    name: string;
    scopes?: string[];
    metadata?: Record<string, unknown>;
    expiresAt?: string;
  }): Promise<AuthFnSuccessEnvelope<{
    keyId: string;
    secret: string;
    secretReturnedOnce: true;
  }> | AuthFnErrorEnvelope>;

  listApiKeys(): Promise<AuthFnSuccessEnvelope<{
    keys: Array<Record<string, unknown>>;
  }> | AuthFnErrorEnvelope>;

  revokeApiKey(input: {
    keyId: string;
  }): Promise<AuthFnSuccessEnvelope<{
    revoked: true;
    keyId: string;
  }> | AuthFnErrorEnvelope>;

  completeTwoFactorChallenge(input: {
    challengeId: string;
    code: string;
  }): Promise<AuthFnSessionEnvelope | AuthFnErrorEnvelope>;

  disableTwoFactor(input: {
    code: string;
  }): Promise<AuthFnSuccessEnvelope<{
    disabled: true;
  }> | AuthFnErrorEnvelope>;

  disconnectSocialAccount(input: {
    provider: 'google' | 'apple' | 'github';
  }): Promise<AuthFnSuccessEnvelope<{
    disconnected: true;
    provider: 'google' | 'apple' | 'github';
  }> | AuthFnErrorEnvelope>;

  lookupRegion(input: {
    identifier: string;
  }): Promise<AuthFnSuccessEnvelope<{
    regionId: string;
    authority: string;
    userId?: string;
  }> | AuthFnErrorEnvelope>;

  getRuntime(): Promise<AuthFnSuccessEnvelope<Record<string, unknown>> | AuthFnErrorEnvelope>;
}
```

### Demo route contract

Auth routes MUST keep the existing authfn success/error envelopes.

Example-only demo routes MUST use:

```ts
interface AuthFnExampleSuccessEnvelope<T> {
  ok: true;
  data: T;
  requestId: string;
}

interface AuthFnExampleErrorEnvelope {
  ok: false;
  error: {
    code:
      | 'AUTHFN_EXAMPLE_EXTERNAL_NETWORK_FORBIDDEN'
      | 'AUTHFN_EXAMPLE_OAUTH_PROVIDER_UNKNOWN'
      | 'AUTHFN_EXAMPLE_OTP_NOT_FOUND'
      | 'AUTHFN_EXAMPLE_SCENARIO_UNKNOWN'
      | 'AUTHFN_EXAMPLE_UI_CONTRACT_MISSING';
    message: string;
    retryable: false;
    details?: Record<string, unknown>;
  };
  requestId: string;
}
```

Required shared demo routes:

- `POST /demo/reset`
- `GET /demo/events`
- `GET /demo/otp/latest`

Required fake provider routes for `social-oauth`:

- `GET /demo/providers/:provider/authorize`
- `POST /demo/providers/:provider/token`
- `GET /demo/providers/:provider/userinfo`
- `GET /demo/providers/github/emails`

### Stable UI contract

Each example client MUST expose stable `data-testid` selectors for the controls the Playwright suite uses.

Required selector families:

- example shell: `example-title`, `example-description`, `auth-state-panel`, `event-log-panel`
- password example: `sign-up-form`, `sign-in-form`, `sessions-list`, `sign-out-button`
- OTP example: `otp-send-form`, `otp-inbox-panel`, `otp-verify-form`, `password-reset-form`
- social example: `social-google-button`, `social-github-button`, `social-apple-button`, `social-disconnect-button`
- account settings example: `two-factor-enroll-button`, `two-factor-confirm-form`, `two-factor-challenge-form`, `api-key-create-form`, `api-key-list`
- multi-region example: `region-lookup-form`, `runtime-panel`, `authority-banner`, `redirect-target`

## Data formats / protocol

### Schema generation files

Each example server MUST generate auth tables with:

```bash
superfunctions generate-schema \
  --config ./superfunctions.config.ts \
  --library authfn \
  --adapter drizzle \
  --output ./src/db/generated \
  --force
```

The generated file MUST be named `authfn-schema.ts` by the current CLI output convention.

No example server MAY define hand-written Drizzle tables for `users`, `sessions`, or plugin-contributed auth tables.

### `POST /demo/reset`

Request:

```json
{
  "scenario": "baseline"
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "scenario": "baseline",
    "seeded": true,
    "namespace": "authfn_pw_demo",
    "authorities": ["http://127.0.0.1:3011"]
  },
  "requestId": "<non-empty-string>"
}
```

### `GET /demo/otp/latest?purpose=<purpose>&email=<email>`

Response:

```json
{
  "ok": true,
  "data": {
    "purpose": "verify-email",
    "email": "ada@example.com",
    "code": "731942"
  },
  "requestId": "<non-empty-string>"
}
```

If no match exists, the route MUST return `AUTHFN_EXAMPLE_OTP_NOT_FOUND`.

### `GET /demo/events`

Response:

```json
{
  "ok": true,
  "data": {
    "events": [
      {
        "type": "authfn.session.issued",
        "requestId": "<non-empty-string>"
      }
    ]
  },
  "requestId": "<non-empty-string>"
}
```

Secrets MUST be redacted or omitted.

## Semantics

### Portfolio semantics

- Each example MUST remain narrowly scoped to one capability cluster.
- Shared code MUST live in `authfn/examples/shared`; examples MUST consume it rather than copy/paste seed or fixture logic.
- Example roots MAY share naming and file patterns, but each README MUST document its specific flows and ports.

### Example scenario semantics

- `password-sessions` MUST demonstrate sign-up, sign-in, current session, session listing, session revocation, and sign-out.
- `otp-recovery` MUST demonstrate verify-email OTP, OTP sign-in, and password reset.
- `social-oauth` MUST demonstrate provider start, callback completion, and disconnect using a local fake provider.
- `account-settings` MUST demonstrate API key creation/list/revocation and 2FA enroll/confirm/challenge/disable.
- `multi-region-routing` MUST demonstrate identifier lookup, wrong-authority feedback, correct-authority continuation, and runtime inspection across two local authorities.

### CLI/schema semantics

- Example servers MUST keep the authoritative `createAuthFn(...)` initialization in `src/auth.ts`.
- `superfunctions.config.ts` MUST point `libraries` at `./src/auth.ts`.
- CLI parsing MUST be sufficient for bundled plugin factories with serializable config.
- Runtime-only function values inside plugin configs MAY remain `undefined` during schema generation if they do not affect table shape.
- Schema generation MUST fail deterministically when a plugin factory cannot be resolved to a bundled authfn plugin.

### Postgres and namespace semantics

- Every example MUST use Postgres.
- Every example MUST isolate auth tables with a dedicated namespace string.
- `multi-region-routing` MAY share one namespace across both local authorities because both servers represent the same logical auth deployment.

### Local development semantics

- Example cookie policy MUST disable `secure` on plain `http://127.0.0.1` and `http://localhost`.
- Example client-server communication MUST work on local HTTP without requiring TLS.
- Playwright configs MUST start the example server(s) and client preview automatically.

## Invariants

- The portfolio MUST NOT collapse into a single “everything demo”.
- The five examples MUST exist simultaneously in the final state.
- Example auth tables MUST be generated, not hand-authored.
- Every Playwright suite MUST be able to reset its baseline through `POST /demo/reset`.
- Fake OTP codes, fake provider identities, and demo seed users MUST be deterministic.
- Example tests MUST NOT depend on live Google, GitHub, Apple, or email delivery services.
- `@authfn/client` example coverage MUST rely on official typed methods by the end of the bundle wherever an official auth route exists.

Determinism rules:

- fixed seed users, fixed authorities, fixed ports, fixed fake provider identities, and deterministic demo OTP retrieval are REQUIRED
- `requestId` values MAY vary per request but MUST remain present and non-empty
- timestamps in demo envelopes MAY vary if not explicitly pinned; tests SHOULD assert semantic outcomes instead of exact clock values unless the example injects a fixed clock

## Security

- Demo-only helper routes MUST be mounted only by example apps and MUST NOT leak into published library packages.
- Example observability output MUST exclude passwords, OTP hashes, OTP codes, API key secrets, OAuth tokens, and recovery codes.
- The `social-oauth` example MUST use local fake provider endpoints only.
- The `multi-region-routing` example MUST avoid public DNS dependencies; local authorities MUST be expressed with localhost-compatible URLs.
- Example docs MUST state clearly that demo helper routes are not production patterns.

## Limits/caps

- `GET /demo/events` MUST return at most the most recent 200 events.
- `GET /demo/otp/latest` MUST return at most one latest match.
- Each example MUST define fixed default ports and MAY allow overrides via env vars.
- The fake provider fixture set MUST remain intentionally small and deterministic.

## Observability

- Example servers MUST wire `config.observability.emit(...)` to an in-memory event buffer exposed by `GET /demo/events`.
- Event capture MUST be sufficient for Playwright assertions around session issuance, OAuth completion, API key creation/revocation, 2FA enable/challenge, and region lookup.
- Example tests MAY assert event type and relative ordering.
- Event payloads MUST NOT expose sensitive values.

## Compatibility / versioning strategy

- Example workspaces are private and MUST NOT be published.
- The `@authfn/client` additions in this bundle are additive and SHOULD be treated as minor-version surface expansion.
- The CLI/authfn integration changes are backwards-compatible additions to enable real `authfn` schema generation.
- Existing non-example authfn package entry points MUST remain intact.

## Undefined / Explicitly user-deferred only

None.
