# Metadata

- **timestamp**: 2026-03-12T11:10:31Z
- **agent_name**: unknown-agent
- **model**: gpt-5-codex
- **launcher**: Codex Desktop
- **workspace**: /Users/serro/Documents/dev/n/superfunctions
- **os**: Darwin 25.3.0 arm64
- **shell**: /bin/zsh
- **git.branch**: heads/next
- **git.commit**: 5fe59b66a1ebf692ef723eb68f708e60a90de457
- **git.dirty**: true
- **spec_type**: audit-fix
- **spec_id**: o4u9k2m7
- **spec_folder**: 2026-03-12-audit-fix-o4u9k2m7-spec
- **spec_path**: /Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec
- **authoritative_inputs**:
  - In-thread audit observations from user (2026-03-12) covering OAuth package health, plugfn/authfn/recfn reuse gaps, and shared-package extraction opportunities.
  - /Users/serro/Documents/dev/n/superfunctions/AGENTS.md
  - /Users/serro/.codex/skills/spec/SKILL.md
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/.conduct/audits/2026-03-12-k7m4r9q2-full-audit.md
  - /Users/serro/Documents/dev/n/superfunctions/packages/oauth-core/src/service.ts
  - /Users/serro/Documents/dev/n/superfunctions/packages/oauth-storage/src/adapters/memory.ts
  - /Users/serro/Documents/dev/n/superfunctions/packages/oauth-testing/src/index.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/core/connection-manager.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/auth/oauth-flow.ts
  - /Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk/src/social-oauth/index.ts
  - /Users/serro/Documents/dev/n/superfunctions/recfn/server/src/webhooks/deliver.ts
  - /Users/serro/Documents/dev/n/superfunctions/recfn/server/src/middleware/envelope.ts
  - /Users/serro/Documents/dev/n/superfunctions/recfn/server/src/calendar/token-store.ts
  - /Users/serro/Documents/dev/n/superfunctions/packages/middleware/src/rate-limit.ts
  - /tmp/jscpd-superfunctions-1773313190/jscpd-report.json
- **audit_reference**:
  - filename: 2026-03-12-k7m4r9q2-full-audit.md
  - path: /Users/serro/Documents/dev/n/superfunctions/plugfn/.conduct/audits/2026-03-12-k7m4r9q2-full-audit.md
  - audited_spec_folder: /Users/serro/Documents/dev/n/superfunctions/plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec
  - note: This spec also covers user-provided repo-wide audit findings from the current thread.

# Overview

This spec delivers a full audit-fix program for shared infrastructure reuse across the Superfunctions monorepo, with three primary outcomes:

1. OAuth common logic is centralized in shared packages, including a new high-level orchestration package (`@superfunctions/oauth-flow`) and migration of plugfn/authfn/recfn OAuth call paths.
2. Reusable patterns currently duplicated in recfn/cifn/cmsfn/plugfn are extracted into shared packages and adopted by consumers.
3. A new root `docs/` site is added using Fumadocs + shared theme primitives so all shared packages are documented for both internal superfunction authors and external library builders.

This is a no-MVP, full-scope spec. All identified audit issues and extraction opportunities in scope are included. The only explicit deferral is full “authfn comprehensive better-auth parity” implementation, per user instruction.

## Context

- **Project name**: Superfunctions monorepo
- **One-sentence goal**: Consolidate duplicated cross-function infrastructure into shared packages (OAuth + reusable primitives), enforce shared HTTP/DB patterns, and publish beginner-friendly root shared-package docs.
- **Target users**:
  - Superfunctions package maintainers (authfn, plugfn, recfn, cifn, cmsfn, searchfn, storage packages)
  - External library/application builders consuming `@superfunctions/*` packages directly
- **Target environments**:
  - TypeScript/Node.js (primary)
  - Python packages (docs + minor dedupe helper scope)
  - Server runtime and framework adapters via `@superfunctions/http-*`
- **Languages/packages required**:
  - TypeScript workspaces in `packages/*`, `authfn/*`, `plugfn/*`, `recfn/*`, `cifn/*`, `searchfn/*`
  - Python in `packages/python-*`, `authfn/python`, `secfn/python` (limited scope)
- **Existing systems it must integrate with**:
  - `@superfunctions/http` + adapter packages
  - `@superfunctions/db`
  - Existing OAuth packages (`oauth-core`, `oauth-http`, `oauth-storage`, `oauth-providers`, `oauth-testing`)
  - Existing docs-theme package (`@superfunctions/docs-theme`)
- **Data model summary**:
  - OAuth state records, token vault records, connection records
  - Webhook deliveries/signatures/idempotency keys
  - Generic envelope + error metadata
  - Queue job payload envelopes
- **Security model**:
  - Multi-tenant user/tenant scoping
  - OAuth state replay prevention and redirect allowlists
  - AES-256-GCM encrypted token storage
  - Webhook HMAC signing and verification
  - Redaction and safe error surfaces
- **Performance constraints**:
  - OAuth callback and token exchange must remain low-latency and deterministic under retries
  - Queue and webhook utilities must handle bursty workloads and retry safely
  - Docs site must build in workspace CI without requiring local-only artifacts
- **Non-goals / out of scope**:
  - Full authfn comprehensive account/session/credential management parity with better-auth
- **Hard constraints**:
  - No scope reduction
  - Must preserve backwards compatibility with migration shims where required
  - Must remain framework-agnostic for shared packages

# Glossary

- **Shared Package**: Any package under `packages/*` published as `@superfunctions/*` and intended for reuse across multiple superfunctions and external consumers.
- **Consumer Function**: A top-level function package (`authfn`, `plugfn`, `recfn`, etc.) that imports shared packages.
- **OAuth Core**: Low-level OAuth primitives (state, PKCE, callback validation, provider descriptors, token endpoint transport, token storage).
- **OAuth Flow**: High-level orchestration from authorization URL generation through callback/token persistence/refresh/revoke/disconnect.
- **Legacy Wrapper**: Existing module kept for compatibility that delegates to new shared package behavior without business logic.
- **Canonical Envelope**: Standard success/error response payload shape used by shared envelope package.
- **Deterministic Error**: Error code + status + retryability + stable shape that is not framework-specific.
- **External Builder**: Developer who consumes shared packages without using a superfunction product package.

# Goals / Non-goals

## Goals

1. All shared OAuth business logic MUST reside in `packages/oauth-*` plus new `packages/oauth-flow`.
2. `authfn` and `plugfn` MUST use shared OAuth orchestration instead of duplicating equivalent flow logic.
3. `recfn` calendar token refresh/storage MUST integrate with shared OAuth storage/flow abstractions.
4. Reusable infrastructure patterns from recfn/cifn/cmsfn MUST be extracted into shared packages and adopted.
5. Shared middleware/rate-limit behavior MUST support both fixed/sliding-window and token-bucket policies with deterministic semantics.
6. Storage and search adapter duplication clusters identified by audit MUST be structurally deduplicated.
7. A root docs app MUST document all shared packages with beginner-friendly and external-consumer examples.
8. PlugFn and AuthFn architecture MUST explicitly align with `@superfunctions/http` for exposure and `@superfunctions/db` for persistence contracts.

## Non-goals

1. This spec does not implement comprehensive authfn identity/session/account/passkey/OIDC management parity (explicitly deferred by user).
2. This spec does not replace domain-specific bot lifecycle logic, meeting platform adapters, ASR pipelines, or recording analytics with shared packages.
3. This spec does not require a single universal envelope shape to be enforced instantly across every existing function route in one breaking release; staged adoption with compatibility adapters is allowed.

# Public API

## New package: `@superfunctions/oauth-flow`

```ts
import type {
  OAuthProviderDescriptor,
  OAuthTokenSet,
  AuthorizationRequest,
  AuthorizationResult,
} from "@superfunctions/oauth-core";
import type {
  OAuthStateStore,
  TokenVault,
  EncryptedTokenVault,
} from "@superfunctions/oauth-storage";
import type { OAuthTokenHttpClient } from "@superfunctions/oauth-http";

export type OAuthFlowSubject = {
  tenantId: string;
  userId: string;
  connectionId?: string;
};

export type OAuthFlowStartInput = OAuthFlowSubject & {
  providerId: string;
  redirectUri: string;
  scopes?: string[];
  prompt?: string;
  loginHint?: string;
  metadata?: Record<string, unknown>;
};

export type OAuthFlowCallbackInput = {
  providerId?: string; // optional: resolved from state if omitted
  code: string;
  state: string;
  redirectUri: string;
};

export type OAuthFlowRefreshInput = {
  connectionId: string;
  providerId: string;
  redirectUri: string;
  scopes?: string[];
};

export type OAuthFlowDisconnectInput = {
  connectionId: string;
  providerId: string;
  revokeRemote?: boolean;
  tokenTypeHint?: "access_token" | "refresh_token";
};

export type OAuthFlowStartResult = AuthorizationResult & {
  providerId: string;
};

export type OAuthFlowCallbackResult = {
  providerId: string;
  subject: OAuthFlowSubject;
  tokenSet: OAuthTokenSet;
  tokenRecordId: string;
  connectionId: string;
};

export type OAuthFlowDisconnectResult = {
  disconnected: boolean;
  remoteRevokeAttempted: boolean;
  localTokenDeleted: boolean;
  connectionDeleted: boolean;
};

export type OAuthFlowIdentityHooks = {
  onConnected?: (result: OAuthFlowCallbackResult) => Promise<void>;
  onDisconnected?: (input: OAuthFlowDisconnectInput) => Promise<void>;
};

export interface OAuthFlowService {
  start(input: OAuthFlowStartInput): Promise<OAuthFlowStartResult>;
  handleCallback(input: OAuthFlowCallbackInput): Promise<OAuthFlowCallbackResult>;
  refresh(input: OAuthFlowRefreshInput): Promise<OAuthTokenSet>;
  disconnect(input: OAuthFlowDisconnectInput): Promise<OAuthFlowDisconnectResult>;
}

export function createOAuthFlowService(config: {
  providers: Record<string, OAuthProviderDescriptor>;
  providerRuntimeConfig: Record<string, { clientId: string; clientSecret: string; allowlistedRedirectUris?: string[] }>;
  stateStore: OAuthStateStore;
  tokenVault: TokenVault | EncryptedTokenVault;
  tokenHttpClient?: OAuthTokenHttpClient;
  identityHooks?: OAuthFlowIdentityHooks;
  keyRef?: string;
  now?: () => Date;
}): OAuthFlowService;
```

## New package: `@superfunctions/webhooks`

```ts
export type WebhookSignatureAlgorithm = "hmac-sha256";

export function signWebhookPayload(input: {
  payload: string;
  secret: string;
  algorithm?: WebhookSignatureAlgorithm;
  output?: "hex" | "base64";
}): string;

export function verifyWebhookSignature(input: {
  payload: string;
  secret: string;
  signature: string;
  prefix?: string; // e.g. "sha256="
  algorithm?: WebhookSignatureAlgorithm;
  encoding?: "hex" | "base64";
}): boolean;

export interface WebhookDeliveryTarget {
  url: string;
  secret?: string;
  headers?: Record<string, string>;
}

export interface WebhookDeliverOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  backoffMultiplier?: number;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface WebhookDeliverResult {
  ok: boolean;
  attempt: number;
  status?: number;
}

export function deliverWebhook(
  target: WebhookDeliveryTarget,
  payload: Record<string, unknown>,
  options?: WebhookDeliverOptions,
): Promise<WebhookDeliverResult>;
```

## New package: `@superfunctions/envelope`

```ts
export type EnvelopeMeta = {
  requestId?: string;
  timestamp: string;
  version?: string;
};

export type SuccessEnvelope<T> = {
  ok: true;
  data: T;
  meta: EnvelopeMeta;
};

export type ErrorEnvelope = {
  ok: false;
  error: {
    code: string;
    message: string;
    status: number;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
  meta: EnvelopeMeta;
};

export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export function ok<T>(data: T, meta?: Partial<EnvelopeMeta>): SuccessEnvelope<T>;
export function err(input: {
  code: string;
  message: string;
  status: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
  meta?: Partial<EnvelopeMeta>;
}): ErrorEnvelope;

// Compat helpers for legacy shapes
export function toResultEnvelope<T>(envelope: Envelope<T>):
  | { ok: true; result: T }
  | { ok: false; error: ErrorEnvelope["error"] };
```

## New package: `@superfunctions/errors`

```ts
export type ErrorCodeDefinition = {
  code: string;
  httpStatus: number;
  retryable: boolean;
  messageTemplate?: string;
};

export interface ErrorRegistry {
  register(def: ErrorCodeDefinition): void;
  get(code: string): ErrorCodeDefinition | null;
  resolveOrDefault(code: string): ErrorCodeDefinition;
}

export class SuperfunctionsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export function createErrorRegistry(defs?: ErrorCodeDefinition[]): ErrorRegistry;
export function makeError(input: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  registry?: ErrorRegistry;
}): SuperfunctionsError;
```

## New package: `@superfunctions/queue`

```ts
export interface QueueMessage {
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
  id?: string;
}

export interface QueueAdapter {
  enqueue(queueName: string, message: QueueMessage): Promise<void>;
  dequeue(queueName: string): Promise<QueueMessage | null>;
  peek(queueName: string): QueueMessage[];
  size(queueName: string): number;
  dequeueMatching?(queueName: string, matcher: (msg: QueueMessage) => boolean): Promise<QueueMessage | null>;
}

export function createMemoryQueueAdapter(): QueueAdapter;
export function createFlowFnHttpQueueAdapter(config: {
  baseUrl: string;
  apiKey: string;
  fetcher?: typeof fetch;
}): QueueAdapter;
```

## New package: `@superfunctions/metrics`

```ts
export interface MetricsEmitter {
  track(event: string, properties?: Record<string, unknown>): void;
}

export function createMetricsEmitter(track?: MetricsEmitter["track"]): MetricsEmitter;
export function createNamespacedEmitter(namespace: string, emitter: MetricsEmitter): MetricsEmitter;
```

## New package: `@superfunctions/config`

```ts
export interface IntEnvSpec {
  key: string;
  defaultValue: number;
  min?: number;
  max?: number;
}

export interface StringEnvSpec {
  key: string;
  defaultValue?: string;
  required?: boolean;
}

export function readIntEnv(spec: IntEnvSpec): number;
export function readStringEnv(spec: StringEnvSpec): string;
export function readBooleanEnv(input: { key: string; defaultValue?: boolean }): boolean;
```

## Existing package extension: `@superfunctions/auth`

```ts
export function extractBearerToken(request: Request): string | null;
export function createBearerAuthMiddleware(options: {
  validateToken: (token: string) => Promise<{ userId: string; tenantId?: string } | null>;
  onUnauthorized?: () => Response;
}): import("@superfunctions/http").Middleware;
```

## Existing package extension: rate limiting

```ts
// Either new @superfunctions/rate-limit package OR @superfunctions/middleware enhancement
export type RateLimitAlgorithm = "fixed-window" | "sliding-window" | "token-bucket";

export function createRateLimiter(config: {
  algorithm: RateLimitAlgorithm;
  windowMs: number;
  maxRequests: number;
  refillRatePerSecond?: number; // token-bucket
  persistence?: import("@superfunctions/db").Adapter | import("@superfunctions/db").KVStoreAdapter;
}): {
  check(input: { key: string }): Promise<{ allowed: boolean; remaining: number; resetAt: string; total: number }>;
  reset(key: string): Promise<void>;
};
```

## Root docs app (`/docs`)

- Framework: Next.js + Fumadocs
- Shared style: `@superfunctions/docs-theme`
- URL base for package docs: `/docs/shared/{package}`
- Generated/curated sections:
  - Getting started
  - Concepts
  - API usage
  - External builder recipes
  - Migration guides
  - Troubleshooting

# Data formats / protocol

## Canonical envelope (shared)

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "req_01j...",
    "timestamp": "2026-03-12T11:10:31Z",
    "version": "v1"
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "redirectUri is required",
    "status": 400,
    "retryable": false,
    "details": {
      "path": "redirectUri"
    }
  },
  "meta": {
    "requestId": "req_01j...",
    "timestamp": "2026-03-12T11:10:31Z",
    "version": "v1"
  }
}
```

## OAuth flow canonical event payloads

```json
{
  "type": "oauth.flow.started",
  "providerId": "google",
  "tenantId": "tenant_1",
  "userId": "user_1",
  "stateId": "st_...",
  "requestId": "req_...",
  "occurredAt": "2026-03-12T11:10:31Z"
}
```

```json
{
  "type": "oauth.flow.callback.success",
  "providerId": "google",
  "connectionId": "conn_...",
  "tokenRecordId": "tok_...",
  "requestId": "req_...",
  "occurredAt": "2026-03-12T11:10:32Z"
}
```

## Webhook delivery canonical headers

- `content-type: application/json`
- `x-sfn-signature` (or configured header)
- `x-sfn-event-id` (idempotency key)
- `x-sfn-attempt` (delivery attempt count)

# Semantics

## OAuth

1. `start()` MUST:
- validate provider existence and redirect URI allowlist
- create state with TTL and single-use semantics
- include PKCE for providers supporting PKCE
- return deterministic authorization URL and state ID

2. `handleCallback()` MUST:
- consume state atomically (single-use)
- reject replayed or expired states
- validate callback provider/redirect consistency
- exchange code using `@superfunctions/oauth-http`
- persist encrypted token payload via `@superfunctions/oauth-storage`
- invoke optional identity hooks without coupling to authfn-specific identity schema

3. `refresh()` MUST:
- use stored refresh token when available
- preserve prior refresh token when provider omits new one
- update vault timestamps deterministically

4. `disconnect()` MUST:
- attempt remote revoke when configured
- always cleanup local token + connection records
- return deterministic flags for remote/local cleanup state

## Shared reusable packages

- Shared package APIs MUST be function-agnostic and tenant-aware.
- Extracted modules MUST support both in-memory and persistence-backed adapters where relevant.
- Adoption in recfn/cifn/plugfn MUST remove duplicated business logic, not merely wrap duplicate copies.

## Docs

- Root docs MUST be complete for every shared package under `packages/*` and for Python shared packages under `packages/python-*`.
- Each package page MUST include:
  - what problem it solves
  - install instructions
  - minimal quick-start
  - production example
  - common failure modes + fixes
  - migration guidance from ad-hoc in-function implementations
- Documentation examples MUST be written for external consumers, not only superfunctions internals.

# Invariants

1. OAuth state consumption MUST be single-use across all storage backends.
2. OAuth callback processing MUST be idempotent with deterministic replay rejection code.
3. OAuth token records MUST never persist plaintext access tokens.
4. Webhook delivery retry MUST be at-least-once with deterministic max-attempt cutoff.
5. Envelope and error shapes MUST be stable and machine-parseable.
6. Connection selection in plugfn MUST be deterministic with explicit stable tie-breaker.
7. Rate limit algorithm selection MUST map to actual runtime behavior (no ignored config flags).
8. Docs navigation and page IDs MUST be stable between builds.

# Security

1. OAuth redirect URIs MUST be allowlisted per provider runtime config.
2. OAuth state mismatch and replay MUST fail closed with explicit error codes.
3. Token encryption MUST use AES-256-GCM (or stronger) with per-record IV and authenticated tags.
4. Webhook signature verification utilities MUST support timing-safe compare.
5. Shared error/envelope packages MUST not leak secrets/tokens in details by default.
6. Multi-tenant scoping MUST remain explicit for plugfn/authfn/recfn integrations.

# Limits/caps

1. OAuth state TTL default MUST be 10 minutes and configurable.
2. OAuth HTTP retry max attempts default MUST be 5.
3. Webhook delivery default max attempts MUST be 3 with exponential backoff.
4. Shared rate limit defaults MUST include documented values for each algorithm profile.
5. Docs examples MUST keep payload snippets under practical onboarding size (<=150 lines per snippet unless unavoidable).

# Observability

1. OAuth flow MUST emit start/success/failure/refresh/disconnect events with request IDs.
2. Shared webhook delivery MUST emit success/failure and attempt counts.
3. Shared queue adapters MUST expose minimal queue depth metrics hooks.
4. Docs site build MUST emit a package coverage report listing documented vs undocumented shared packages.

# Compatibility / versioning strategy

1. New shared packages MUST start at `0.x` and follow semver.
2. Legacy paths (`plugfn/typescript/src/auth/oauth-flow.ts`, duplicated recfn helpers, etc.) MAY remain as wrappers for one minor cycle but MUST emit deprecation notices.
3. Adoption changes MUST include codemods or migration notes where signatures change.
4. Envelope migration MUST provide adapters for existing `{ ok, result }` and `{ ok, data }` conventions.
5. Root docs MUST include version banner and package version mapping.

# Undefined / Explicitly user-deferred only

- Full authfn comprehensiveness implementation (better-auth-like comprehensive auth management) is explicitly deferred by user and is not required in this spec.
