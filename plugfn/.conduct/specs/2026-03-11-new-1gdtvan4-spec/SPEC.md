# Metadata

- **timestamp**: 2026-03-11T17:37:22Z
- **agent_name**: unknown-agent
- **model**: gpt-5 (Codex)
- **launcher**: Codex Desktop
- **workspace/project path**: /Users/serro/Documents/dev/n/superfunctions/plugfn
- **os**: macOS 26.3.1 (Darwin 25.3.0, arm64)
- **shell**: /bin/zsh
- **git.branch**: next
- **git.commit**: 5fe59b66a1ebf692ef723eb68f708e60a90de457
- **git.dirty**: true
- **spec_folder**: 2026-03-11-new-1gdtvan4-spec
- **spec_path**: /Users/serro/Documents/dev/n/superfunctions/plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec
- **spec_type**: new
- **spec_id**: 1gdtvan4
- **input paths (notes/intent/docs read)**:
  - /Users/serro/.codex/skills/spec/SKILL.md
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/README.md
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/docs/architecture.md
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/README.md
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/core/plug-fn.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/core/connection-manager.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/core/action-executor.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/webhooks/webhook-handler.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/router/http-router.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/utils/request.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/providers/index.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/tests/basic.test.ts
  - /Users/serro/Documents/dev/n/superfunctions/plugfn/cli/src/commands/test.ts
  - /Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk/src/index.ts
  - /Users/serro/Documents/dev/n/superfunctions/packages/auth/src/types.ts
  - User thread intent (Finatron + Fellotron architecture, provider rules/restrictions, forwarding/alias alternatives, E2E email risks, shared OAuth primitives, production readiness requirement)

## Overview

This spec defines a production-grade architecture and execution plan for:

1. Hardening `plugfn` from scaffold state to production readiness.
2. Introducing reusable OAuth primitives in shared `superfunctions` packages.
3. Implementing email-provider integrations needed for Finatron and Fellotron.
4. Ensuring future `authfn` social OAuth sign-in uses the same shared primitives.

### Context

- **Project name**: superfunctions (`plugfn`-centered change with cross-workspace integration)
- **One-sentence goal**: Build production-ready shared OAuth + email integration infrastructure so Finatron and Fellotron can ingest, parse, and act on multi-provider communications while reusing the same OAuth foundation in future `authfn` social sign-in.
- **Target users**: 21n maintainers, integrator developers, and end users of Finatron/Fellotron in personal-use contexts.
- **Target environments**:
  - TypeScript runtime: Node 18+
  - Python runtime: Python 3.10+
  - HTTP APIs for server-side integrations
  - Optional web/browser clients for OAuth initiation and management
- **Languages/packages required**: TypeScript packages + Python SDK parity where applicable.
- **Existing systems it must integrate with**:
  - `plugfn/typescript`, `plugfn/python`, `plugfn/cli`
  - `authfn/ts-sdk`
  - `packages/auth`, `packages/http`, `packages/db`
- **Data model summary**:
  - Tenants, users, provider connections, OAuth states, encrypted tokens, sync checkpoints, messages, message metadata, parsing jobs, policy decisions, outbound send jobs, audit records.
- **Security model**:
  - Multi-tenant isolation, least-privilege scopes, encrypted credentials, strict webhook verification, auditability.
- **Performance constraints**:
  - Low-latency OAuth callback handling.
  - Incremental sync at provider limits.
  - Deterministic retries with bounded backoff.
- **Non-goals / out of scope**:
  - Building a full consumer email client UX in this spec.
  - Defining non-email social/messaging provider APIs in full detail (only extension contract is required here).
- **Hard constraints**:
  - No placeholder production gaps in OAuth/auth/webhook core.
  - All MUST requirements are testable with positive and negative vectors.
  - No scope reduction to MVP.

### Assumptions

1. This spec treats Gmail, Outlook/Microsoft 365, Yahoo Mail, iCloud Mail, and generic IMAP/SMTP as required email-provider surface.
2. For provider policy deltas, policy values are read from a versioned provider policy registry, not hardcoded constants.
3. `authfn` remains API-key capable and gains social OAuth support by composition, not rewrite.

### Open Questions (non-blocking for this spec)

1. Which KMS provider(s) are preferred for default envelope encryption in production deployments?
2. Which initial social providers are mandatory for `authfn` v1 social sign-in (Google, Microsoft, GitHub, Apple)?
3. Which deployment target is primary for distributed state/token stores (Redis vs SQL vs Dynamo)?

## Glossary

- **Adapter**: Provider-specific implementation of a normalized integration contract.
- **Connection**: A tenant/user-bound authenticated linkage to one provider account.
- **StateStore**: Durable storage for OAuth state/nonce/PKCE verifier tuples.
- **TokenVault**: Encrypted storage and retrieval system for provider credentials.
- **Checkpoint**: Durable incremental-sync position (history ID, delta token, UID validity tuple).
- **Provider Policy Registry (PPR)**: Versioned capability/restriction metadata for each provider.
- **Restricted scope**: Provider-defined high-risk OAuth scope requiring elevated review controls.
- **Forwarding connector**: Inbound-only flow where user forwards mail to controlled address.
- **Managed mailbox**: Fellotron-hosted mailbox/address provided to end users.
- **Critical financial message**: Statements, transaction alerts, security alerts, billing alerts, KYC/AML notices.
- **Deterministic operation**: Same input state and external responses produce same persisted state transitions.

## Goals / Non-goals

### Goals

1. `plugfn` MUST provide production-safe OAuth, webhook, action execution, and workflow behavior.
2. Shared OAuth packages MUST be reusable by both `plugfn` and `authfn`.
3. Email ingestion and outbound controls MUST support Finatron/Fellotron needs across major providers.
4. Provider restrictions/policies MUST be first-class and enforceable at runtime.
5. Reliability, security, and compliance controls MUST be explicit, testable, and auditable.

### Non-goals

1. Full social/messaging adapter implementation beyond email in this spec bundle.
2. Full UX design for mailbox clients, compose UI, or end-user dashboards.
3. Legal advice; this spec defines technical controls and evidence workflows only.

## Public API

### Package topology (normative)

The monorepo MUST provide these TypeScript packages:

1. `@superfunctions/oauth-core`
2. `@superfunctions/oauth-http`
3. `@superfunctions/oauth-storage`
4. `@superfunctions/oauth-providers`
5. `@superfunctions/oauth-testing`

`plugfn` MUST consume packages 1-4 directly and package 5 in tests.

`authfn` social OAuth module MUST consume packages 1-4.

### `@superfunctions/oauth-core` API

```ts
export interface OAuthProviderDescriptor {
  id: string;
  authorizationUrl: string;
  tokenUrl: string;
  revocationUrl?: string;
  defaultScopes: string[];
  supportsPkce: boolean;
  supportsRefreshToken: boolean;
  scopeSeparator?: " " | ",";
  extraAuthParams?: Record<string, string>;
  tokenAuthMethod?: "client_secret_post" | "client_secret_basic";
}

export interface AuthorizationRequest {
  providerId: string;
  tenantId: string;
  userId: string;
  redirectUri: string;
  scopes?: string[];
  connectionName?: string;
  prompt?: string;
  loginHint?: string;
}

export interface AuthorizationResult {
  authorizationUrl: string;
  stateId: string;
  expiresAt: string;
}

export interface OAuthCallbackInput {
  providerId: string;
  code: string;
  state: string;
  redirectUri: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope?: string;
  tokenType?: string;
  idToken?: string;
}

export interface OAuthService {
  createAuthorizationRequest(input: AuthorizationRequest): Promise<AuthorizationResult>;
  handleCallback(input: OAuthCallbackInput): Promise<OAuthTokenSet>;
  refresh(input: { providerId: string; refreshToken: string; redirectUri: string; scopes?: string[] }): Promise<OAuthTokenSet>;
  revoke(input: { providerId: string; token: string; tokenTypeHint?: "access_token" | "refresh_token" }): Promise<void>;
}
```

### `@superfunctions/oauth-storage` API

```ts
export interface OAuthStateRecord {
  stateId: string;
  tenantId: string;
  userId: string;
  providerId: string;
  redirectUri: string;
  requestedScopes: string[];
  codeVerifier?: string;
  nonce?: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
}

export interface TokenRecord {
  tokenId: string;
  tenantId: string;
  userId: string;
  providerId: string;
  connectionId: string;
  encryptedPayload: string;
  keyRef: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface OAuthStateStore {
  put(record: OAuthStateRecord): Promise<void>;
  get(stateId: string): Promise<OAuthStateRecord | null>;
  consume(stateId: string, consumedAt: string): Promise<OAuthStateRecord | null>;
  deleteExpired(before: string): Promise<number>;
}

export interface TokenVault {
  put(record: TokenRecord): Promise<void>;
  get(tokenId: string): Promise<TokenRecord | null>;
  getByConnection(connectionId: string): Promise<TokenRecord | null>;
  rotateKey(tokenId: string, newKeyRef: string): Promise<void>;
  deleteByConnection(connectionId: string): Promise<void>;
}
```

### `plugfn` connection and action API additions

```ts
export interface GetAuthUrlOptions {
  tenantId: string;
  userId: string;
  provider: string;
  redirectUri: string;
  scopes?: string[];
  connectionName?: string;
}

export interface HandleCallbackOptions {
  provider: string;
  code: string;
  state: string;
  redirectUri: string;
}

export interface ActionOptions<TParams = any> {
  tenantId: string;
  userId: string;
  connectionId?: string;
  params: TParams;
  idempotencyKey?: string;
  cache?: boolean | { ttl?: number; key?: string };
}
```

HTTP endpoints (v2, normative):

- `POST /api/plugfn/v2/connections/auth-url`
- `POST /api/plugfn/v2/connections/callback`
- `GET /api/plugfn/v2/connections`
- `DELETE /api/plugfn/v2/connections/:connectionId`
- `POST /api/plugfn/v2/actions/:provider/:action`
- `POST /api/plugfn/v2/webhooks/:provider/:event`
- `GET /api/plugfn/v2/workflows`
- `POST /api/plugfn/v2/workflows/:workflowId/run`

All non-webhook endpoints MUST derive caller identity from configured auth middleware, not raw `userId` query parameters.

### Email adapter contract (normative)

```ts
export interface MailConnectionConfig {
  provider: "gmail" | "outlook" | "yahoo" | "icloud" | "imap-smtp" | "forwarding" | "managed-mail";
  accountAddress: string;
  accountId?: string;
}

export interface MailSyncRequest {
  tenantId: string;
  userId: string;
  connectionId: string;
  mode: "full" | "incremental";
  maxMessages?: number;
}

export interface MailMessage {
  messageId: string;
  threadId?: string;
  providerMessageId: string;
  mailbox: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  receivedAt: string;
  labels?: string[];
  hasAttachments: boolean;
  classification?: {
    kind: "financial" | "security" | "personal" | "marketing" | "unknown";
    confidence: number;
  };
}

export interface MailSyncResult {
  checkpoint: string;
  fetched: number;
  upserted: number;
  skipped: number;
  partial: boolean;
}
```

### `authfn` social OAuth module contract (normative)

```ts
export interface SocialAuthConfig {
  providers: Array<"google" | "microsoft" | "github" | "apple">;
  redirectBaseUrl: string;
}

export interface SocialAuthService {
  getLoginUrl(input: { tenantId: string; userIdHint?: string; provider: string; redirectUri: string }): Promise<{ url: string; stateId: string }>;
  handleLoginCallback(input: { provider: string; code: string; state: string; redirectUri: string }): Promise<{ identityId: string; email?: string; profile: Record<string, unknown> }>;
  disconnectIdentity(input: { tenantId: string; identityId: string }): Promise<void>;
}
```

## Data formats / protocol

### Canonical response envelope

All `plugfn` v2 HTTP responses MUST use:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "req_01j...",
    "timestamp": "2026-03-11T17:37:22Z"
  }
}
```

Failure envelope:

```json
{
  "ok": false,
  "error": {
    "code": "OAUTH_STATE_INVALID",
    "message": "OAuth state is invalid or expired",
    "status": 400,
    "retryable": false,
    "details": {}
  },
  "meta": {
    "requestId": "req_01j...",
    "timestamp": "2026-03-11T17:37:22Z"
  }
}
```

### Canonical error codes

- `OAUTH_STATE_INVALID`
- `OAUTH_STATE_REPLAYED`
- `OAUTH_CALLBACK_MISMATCH`
- `OAUTH_TOKEN_EXCHANGE_FAILED`
- `OAUTH_TOKEN_REFRESH_FAILED`
- `OAUTH_SCOPE_DISALLOWED`
- `CONNECTION_NOT_FOUND`
- `CONNECTION_AMBIGUOUS`
- `WEBHOOK_SIGNATURE_INVALID`
- `WEBHOOK_SECRET_NOT_FOUND`
- `PROVIDER_POLICY_BLOCKED`
- `PROVIDER_RATE_LIMITED`
- `MAIL_SYNC_CHECKPOINT_INVALID`
- `MAIL_SYNC_PARTIAL`
- `MAIL_SEND_BLOCKED`
- `TENANT_ACCESS_DENIED`
- `VALIDATION_ERROR`
- `INTERNAL_ERROR`

### Canonical persisted records (logical)

1. `oauth_states`
2. `provider_connections`
3. `token_vault_records`
4. `mail_sync_checkpoints`
5. `mail_messages`
6. `mail_parse_jobs`
7. `mail_parse_results`
8. `policy_decisions`
9. `send_jobs`
10. `audit_events`

### Deterministic serialization

- Timestamps MUST be ISO-8601 UTC strings.
- IDs MUST be lowercase URL-safe strings.
- JSON object key order is Undefined and MUST NOT be used for correctness.

## Semantics

### OAuth lifecycle semantics

1. Authorization request creation MUST persist state before returning authorization URL.
2. Callback handling MUST validate provider, redirect URI, and state ownership.
3. State consumption MUST be one-time and atomic.
4. Refresh MUST prefer stored refresh token and preserve old token on refresh failure.
5. Revoke/disconnect MUST revoke remotely if supported and always delete local credential records.

### Connection semantics

1. A connection is scoped by `(tenantId, userId, provider, accountAddress)`.
2. If multiple active connections exist for one provider, action execution MUST require explicit `connectionId` or deterministic default rules.
3. Default selection rule MUST be latest healthy connection by `lastUsedAt`, then `createdAt`, then `connectionId`.

### Mail sync semantics

1. First sync is full baseline; all subsequent syncs are incremental from checkpoint.
2. If checkpoint is invalid, adapter MUST report `MAIL_SYNC_CHECKPOINT_INVALID` and trigger controlled rebaseline.
3. Sync MUST be idempotent with provider message identifiers and immutable dedupe keys.
4. Provider push/webhook signals MAY trigger sync but MUST not be treated as complete source of truth.
5. Partial syncs MUST return `partial=true` and emit `MAIL_SYNC_PARTIAL` event.

### Finatron parsing semantics

1. Parsing pipeline MUST run deterministic extraction first and LLM extraction second.
2. Structured output MUST include confidence and provenance.
3. Low-confidence financial extraction MUST remain pending until user confirmation or rule override.

### Fellotron outbound semantics

1. Outbound send MUST pass policy checks (provider, abuse, recipient thresholds).
2. Send job execution MUST be idempotent by `(tenantId, provider, idempotencyKey)`.
3. On provider throttling, send jobs MUST respect `Retry-After` when present.

### Forwarding and managed mailbox semantics

1. Forwarding connector is optional fallback and inbound-only.
2. Managed mailbox mode MUST not be silently enabled; explicit user opt-in is required.
3. Finance-critical use of managed mailbox MUST enforce backup notification channel and explicit risk acknowledgment.

## Invariants

1. **Security invariant**: No plaintext provider access/refresh token is persisted.
2. **Replay invariant**: OAuth state cannot be consumed twice.
3. **Isolation invariant**: Cross-tenant access to connections, tokens, checkpoints, or mail records is forbidden.
4. **Idempotency invariant**: Repeating same sync window does not duplicate normalized messages.
5. **Ordering invariant**: Message listing is deterministic (`receivedAt DESC`, then `providerMessageId ASC`).
6. **Policy invariant**: Provider-policy blocks are enforced before external API call.
7. **Observability invariant**: Sensitive values are redacted from logs and metrics.
8. **Compatibility invariant**: `plugfn` v1 endpoints remain untouched during v2 introduction; v2 is additive until migration gate phase.

## Security

### Authn/Authz boundaries

1. User identity MUST be resolved from configured auth middleware/session.
2. `tenantId` MUST be validated against session context.
3. Admin operations (provider registry writes, policy overrides, key rotation) MUST require elevated auth context.

### Validation rules

1. Redirect URIs MUST match allowlisted values per provider integration config.
2. Requested scopes MUST be subset of provider allowlist and feature map.
3. Webhooks MUST be rejected if signature verification fails or secret lookup fails.
4. Encrypted payload schema version MUST be checked before decryption.

### Privacy constraints

1. Message body storage policy MUST be configurable (metadata-only, snippet, full body).
2. PII fields MUST be tagged and redacted in telemetry.
3. Data deletion MUST cascade: connections, tokens, checkpoints, raw messages, parsed artifacts.

### E2EE constraints

1. If managed mailbox E2EE mode is enabled, server-side AI parsing MUST be disabled unless decrypted content is processed in trusted client runtime.
2. Recovery model MUST be explicit: either non-recoverable keys or escrow-based recovery with user-visible trust implications.

## Limits/caps

1. OAuth state TTL MUST default to 10 minutes and be configurable between 1-30 minutes.
2. OAuth callback replay cache window MUST be at least 24 hours.
3. Webhook payload max size MUST default to 2 MB and be configurable.
4. Mail sync page size MUST be bounded per provider policy and internal cap.
5. Retry attempts MUST be capped (default 5) with exponential backoff and jitter.
6. Maximum concurrent sync jobs per connection MUST default to 1.
7. Send queue rate limits MUST enforce provider + tenant + recipient-domain dimensions.

## Observability

### Required telemetry

1. Structured logs for OAuth request/callback/refresh/revoke events.
2. Metrics: auth success rate, callback latency, token refresh failure rate, webhook verification failures, sync lag, send throttle hits.
3. Audit events for consent changes, scope changes, connection create/delete, data export/delete, policy overrides.

### Required redaction

1. Access tokens, refresh tokens, app passwords, SMTP credentials MUST never be logged.
2. Message body and attachments MUST not be logged except explicit debug mode with explicit redaction policy and tenant-local opt-in.

### Traceability

1. Every public API response MUST include `requestId`.
2. Async jobs MUST carry parent request correlation IDs.

## Compatibility / versioning strategy

1. New shared OAuth packages start at `0.x` or `1.0` per repository policy, but public API breakage MUST increment major.
2. `plugfn` v2 endpoints and contracts are additive first; deprecations need explicit migration docs and warning logs.
3. `plugfn` internals MUST remove direct OAuth logic duplication once shared packages are adopted.
4. `authfn` social OAuth module MUST depend on shared packages without copying OAuth logic.
5. Python parity MAY trail TypeScript by one phase, but public behavior contract MUST match before production readiness declaration.

## Undefined / Explicitly user-deferred only

No user-deferred scope items were provided.

Undefined (not required by this spec):

1. Consumer-facing mailbox UI/UX design details.
2. Billing/pricing model for managed mailbox.
3. Non-email social/messaging provider adapter internals beyond extension points.
4. Jurisdiction-specific legal language text for policy/legal notices.
