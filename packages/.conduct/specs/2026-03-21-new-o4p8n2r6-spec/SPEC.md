# Metadata

- Timestamp: `2026-03-21T14:40:09Z`
- Agent: `unknown-agent`
- Model: `Codex (GPT-5)`
- Launcher: `Codex Desktop`
- Workspace: `/Users/serro/Documents/dev/n/superfunctions/packages`
- OS/Shell: `Darwin 25.3.0 arm64` / `/bin/zsh`
- Repo metadata: git repo at `/Users/serro/Documents/dev/n/superfunctions`; branch `heads/next`; commit `6f9a47d6c5f8ac166932e0156efb910bf5e32652`; worktree `dirty`
- Spec folder: `2026-03-21-new-o4p8n2r6-spec`
- Spec path: `/Users/serro/Documents/dev/n/superfunctions/packages/.conduct/specs/2026-03-21-new-o4p8n2r6-spec`
- Spec type: `new`
- Spec id: `o4p8n2r6`
- Input paths read:
  - `/Users/serro/.codex/skills/spec/SKILL.md`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/auth/src/types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/http/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/http/src/types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/http/src/router.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/cli/src/commands/generate-schema.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/cli/src/utils/schema-generators.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/cli/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/oauth-core/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/oauth-flow/src/service.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/oauth-storage/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/oauth-http/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/oauth-providers/src/policy-registry.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/python-core/superfunctions/http/types.py`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/python-fastapi/superfunctions_fastapi/adapter.py`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/python-flask/superfunctions_flask/adapter.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk/src/social-oauth/index.ts`
  - `/Users/serro/Documents/dev/n/21n/services/account/src/lib/auth.ts`
  - `/Users/serro/Documents/dev/n/nucleus/client/components/account/auth.ts`

## Overview

Project name: `superfunctions packages`

One-sentence goal: Extend the shared packages so `authfn` can be implemented as a first-class auth platform without duplicating OAuth, HTTP, OpenAPI, CLI, or Python infrastructure, while keeping those primitives reusable for other superfunctions.

Target users:

- superfunctions library authors
- `authfn` implementers
- future `plugfn`, `recfn`, and other function authors needing shared OAuth/HTTP primitives

Target environments:

- TypeScript packages running in Node/Web-Request environments
- Python packages running with FastAPI and Flask adapters
- Browser redirect-based OAuth and cookie-auth flows

Languages/packages required:

- TypeScript: `packages/auth`, `packages/http`, `packages/oauth-*`, `packages/cli`, plus new shared packages
- Python: `packages/python-core`, `packages/python-fastapi`, `packages/python-flask`

Existing systems it must integrate with:

- `authfn`
- `plugfn`
- `@superfunctions/http-*`
- `@superfunctions/cli`
- `superfunctions-fastapi`
- `superfunctions-flask`

Data model summary:

- Shared auth types
- Shared OAuth state/token/consent/revocation storage schemas
- Shared route metadata/OpenAPI schema representations
- Shared cookie/header abstractions for Python HTTP responses

Security model:

- Redirect allowlisting
- OAuth state replay prevention
- provider secret resolution without leakage
- multi-value cookie propagation in Python adapters
- redaction-safe observability

Performance constraints:

- Shared OAuth flow components MUST remain adapter-light and index-friendly
- OpenAPI generation MUST be deterministic and offline
- Python parity MUST not depend on network access for schema/OpenAPI generation

Non-goals:

- No migration strategy for existing downstream consumers
- No implementation of product-specific auth policies inside shared packages
- No replacement of `authfn` business logic by shared packages

Hard constraints:

- Shared packages MUST remain framework-agnostic unless they are explicitly adapters
- Shared packages MUST be the single source of truth for reusable OAuth and shared HTTP/OpenAPI behavior
- Shared packages MUST support Python from the start where needed by `authfn`

## Glossary

- `Shared auth abstraction`: the common session/provider types used by superfunctions libraries.
- `Route metadata`: typed metadata attached to `@superfunctions/http` routes for OpenAPI, auth, validation, and docs.
- `OAuth intent`: an auth or connection-start request persisted across redirect/callback boundaries.
- `Browser-auth intent`: an OAuth flow started before a local user or connection identifier is known, used by `authfn` social sign-in.
- `Connection intent`: an OAuth flow started for a known tenant/user/connection, used by packages like `plugfn`.
- `Runtime secret resolver`: a component that produces provider credentials at request time, including support for Apple-style generated client secrets.
- `Python cookie materialization`: the adapter behavior that converts a shared response model into actual repeated `Set-Cookie` headers.

## Goals / Non-goals

### Goals

- Shared packages MUST provide the reusable auth, HTTP, OAuth, OpenAPI, CLI, and Python primitives required by `authfn`.
- Shared OAuth packages MUST support both connection-style OAuth and pre-user browser-auth intents.
- Shared HTTP packages MUST support cookie helpers and route metadata without forcing each library to implement them ad hoc.
- Shared OpenAPI generation MUST be provided in reusable packages rather than bespoke per-library code.
- Shared Python abstractions MUST support auth, OAuth, cookies, and OpenAPI generation for `authfn`.

### Non-goals

- Shared packages MUST NOT embed `authfn`-specific user/session business rules.
- Shared packages MUST NOT define migration plans for current downstream consumers.
- Shared packages MUST NOT take over product-specific multi-region policy decisions; they provide primitives and metadata support only.

## Public API

### Package inventory

Modified TypeScript packages:

- `packages/auth`
- `packages/http`
- `packages/oauth-core`
- `packages/oauth-http`
- `packages/oauth-storage`
- `packages/oauth-flow`
- `packages/oauth-providers`
- `packages/oauth-testing`
- `packages/cli`

New TypeScript packages:

- `packages/oauth-router` published as `@superfunctions/oauth-router`
- `packages/http-openapi` published as `@superfunctions/http-openapi`

Modified Python packages/modules:

- `packages/python-core/superfunctions/http`
- `packages/python-core/superfunctions/db` as needed for schema typing parity
- `packages/python-fastapi`
- `packages/python-flask`

New Python modules in `packages/python-core`:

- `superfunctions.auth`
- `superfunctions.oauth.core`
- `superfunctions.oauth.http`
- `superfunctions.oauth.storage`
- `superfunctions.oauth.flow`
- `superfunctions.http.openapi`

### Shared auth abstraction API

TypeScript:

```ts
export interface AuthSubject {
  actorId: string;
  actorType: "user" | "api-key" | "service";
  tenantId?: string;
  regionId?: string;
  email?: string;
  attributes?: Record<string, unknown>;
}

export interface AuthSession<TMetadata = Record<string, unknown>> {
  id: string;
  type: string;
  subject: AuthSubject;
  resourceIds?: string[];
  scopes?: string[];
  methods?: string[];
  expiresAt?: Date;
  metadata?: TMetadata;
}

export interface AuthProvider<TSession extends AuthSession = AuthSession> {
  authenticate(request: Request): Promise<TSession | null>;
  authorize?(session: TSession, resourceId: string): Promise<boolean>;
  revoke?(sessionId: string): Promise<void>;
}
```

Python:

```py
class AuthSubject(BaseModel):
    actor_id: str
    actor_type: Literal["user", "api-key", "service"]
    tenant_id: str | None = None
    region_id: str | None = None
    email: str | None = None
    attributes: dict[str, Any] | None = None

class AuthSession(BaseModel):
    id: str
    type: str
    subject: AuthSubject
    resource_ids: list[str] | None = None
    scopes: list[str] | None = None
    methods: list[str] | None = None
    expires_at: datetime | None = None
    metadata: dict[str, Any] | None = None
```

### Shared HTTP API

TypeScript additions:

```ts
export interface HttpRouteMeta {
  auth?: {
    mode: "none" | "cookie-session" | "bearer" | "hybrid";
    csrf?: boolean;
  };
  openapi?: {
    operationId: string;
    summary?: string;
    description?: string;
    tags?: string[];
    requestBodySchema?: Record<string, unknown>;
    responseSchemas?: Record<string, Record<string, unknown>>;
  };
}

export interface SetCookieInput {
  name: string;
  value: string;
  path?: string;
  domain?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "lax" | "strict" | "none";
  maxAge?: number;
  expires?: Date;
}

export function parseCookies(request: Request): Record<string, string>;
export function serializeSetCookie(input: SetCookieInput): string;
```

Python additions:

```py
class SetCookie(BaseModel):
    name: str
    value: str
    path: str = "/"
    domain: str | None = None
    secure: bool = True
    http_only: bool = True
    same_site: Literal["lax", "strict", "none"] = "lax"
    max_age: int | None = None
    expires: datetime | None = None

class Response(BaseModel):
    status: int = 200
    headers: dict[str, str] = {}
    cookies: list[SetCookie] = []
    body: str | bytes | dict[str, Any] | list[Any] | None = None
```

### Shared OAuth APIs

`oauth-core` MUST add typed browser-auth intents:

```ts
export type OAuthIntentSubject =
  | {
      kind: "connection";
      tenantId: string;
      userId: string;
      connectionId?: string;
    }
  | {
      kind: "browser-auth";
      intentId: string;
      tenantId?: string;
      regionId?: string;
      returnTo?: string;
      metadata?: Record<string, unknown>;
    };
```

`oauth-flow` MUST expose:

```ts
export interface OAuthFlowService {
  start(input: OAuthFlowStartInput): Promise<OAuthFlowStartResult>;
  handleCallback(input: OAuthFlowCallbackInput): Promise<OAuthFlowCallbackResult>;
  refresh(input: OAuthFlowRefreshInput): Promise<OAuthTokenSet>;
  disconnect(input: OAuthFlowDisconnectInput): Promise<OAuthFlowDisconnectResult>;
}
```

with `OAuthFlowStartInput.subject` using `OAuthIntentSubject` rather than requiring a known `userId` in all cases.

`oauth-router` MUST expose route factories:

```ts
export function createOAuthBrowserRoutes(config: OAuthBrowserRouteConfig): Route[];
export function createOAuthConnectionRoutes(config: OAuthConnectionRouteConfig): Route[];
```

### Shared OpenAPI API

TypeScript:

```ts
export function generateOpenApiDocument(input: {
  title: string;
  version: string;
  routers: Router[];
}): Record<string, unknown>;
```

Python:

```py
def generate_openapi_document(title: str, version: str, routes: list[Route]) -> dict[str, Any]:
    ...
```

### Shared CLI behavior

`@superfunctions/cli` MUST:

- discover `@authfn/core`
- pass plugin-rich config objects into `getSchema()`
- generate schemas for plugin-composed libraries without hand-maintained migration metadata inside the library package

## Data formats / protocol

### Shared OAuth persistence schema

Shared OAuth storage MUST define deterministic abstract schemas for:

- `oauth_states`
- `oauth_tokens`
- `oauth_consents`
- `oauth_revocation_failures`

The state and token tables MUST be reusable by `authfn` and `plugfn`.

### Shared route metadata

Routes intended for OpenAPI generation MUST carry deterministic metadata under `route.meta.openapi`.

### Shared error codes

Shared packages MUST define canonical reusable error families:

- `AUTH_VALIDATION_ERROR`
- `HTTP_META_INVALID`
- `OAUTH_STATE_INVALID`
- `OAUTH_STATE_REPLAYED`
- `OAUTH_REDIRECT_DISALLOWED`
- `OAUTH_PROVIDER_UNSUPPORTED`
- `OAUTH_RUNTIME_CONFIG_INVALID`
- `OAUTH_HOOK_FAILED`
- `OAUTH_SECRET_RESOLUTION_FAILED`
- `OPENAPI_META_INCOMPLETE`

### Python cookie protocol

- Python responses MUST materialize cookies from `Response.cookies`.
- Adapters MUST preserve all cookies as repeated `Set-Cookie` headers.
- Cookie order MUST be deterministic.

## Semantics

### Shared-package responsibility boundaries

- `packages/auth` owns common auth subject/session/provider semantics.
- `packages/http` owns routing, route metadata typing, and cookie helper utilities.
- `packages/http-openapi` owns OpenAPI document generation from route metadata.
- `packages/oauth-core` owns pure OAuth protocol types, PKCE/state helpers, provider descriptors, and intent modeling.
- `packages/oauth-http` owns token endpoint/revocation HTTP mechanics and runtime secret resolution.
- `packages/oauth-storage` owns state/token/consent/revocation stores and schema definitions.
- `packages/oauth-flow` owns orchestration, hook/event execution, and high-level flow semantics.
- `packages/oauth-router` owns reusable `@superfunctions/http` route factories around `oauth-flow`.
- `packages/cli` owns schema discovery and generation for plugin-composed authfn packages.

### Browser-auth vs connection-style OAuth

- Shared OAuth flow MUST support browser-auth intents where no local user is known yet.
- Shared OAuth flow MUST continue to support connection-style flows for packages such as `plugfn`.
- `authfn` social sign-in MUST use browser-auth intents, while connection managers MAY use connection intents.

### Runtime secret resolution

- Provider runtime config MUST support resolver functions, not just static maps.
- Apple support MUST allow generated client secrets through a resolver interface rather than forcing static secret strings.

### OpenAPI semantics

- OpenAPI generation MUST be deterministic for a fixed set of routes and route metadata.
- The generator MUST fail clearly if required metadata is missing for a route explicitly marked for inclusion.

### Python parity semantics

- Python shared modules MUST mirror the TypeScript semantics needed by `authfn`.
- FastAPI and Flask adapters MUST preserve cookies and route metadata fidelity.

## Invariants

- Shared OAuth state handling MUST remain single-use and replay-safe.
- Shared route metadata interpretation MUST be deterministic.
- Shared CLI generation MUST produce stable schema file output for stable input.
- Secret resolvers MUST never serialize secret material into OpenAPI, logs, or test snapshots.
- Shared packages MUST remain product-agnostic; product-specific rules stay in consuming libraries.

## Security

- Redirect allowlisting is mandatory in shared OAuth flow/router utilities.
- Secret resolver failures MUST return structured errors without leaking raw secret material.
- Python adapters MUST preserve secure cookie attributes exactly.
- Shared logs and events MUST be redaction-safe.

## Limits/caps

- OAuth state TTL MUST default to 10 minutes unless explicitly configured.
- Stored consent and revocation records MUST be indexable by provider and subject.
- OpenAPI generation MUST not perform live provider discovery at generation time.

## Observability

- `oauth-flow` MUST emit structured start/callback/refresh/disconnect events.
- `oauth-router` MUST propagate request IDs into emitted events when present.
- Shared OpenAPI generation SHOULD expose stable operation IDs and tag ordering.

## Compatibility / versioning strategy

- Public shared-package contracts defined here MUST be semver-versioned.
- Newly added packages MUST be documented as canonical shared dependencies for future superfunctions.
- Shared Python modules MUST version in lockstep with the semantic contracts they mirror.

## Undefined / Explicitly user-deferred only

- Downstream migration strategy from current shared package contracts
- Backward compatibility plan for existing consumers of current `authfn/ts-sdk` naming and older OAuth abstractions
