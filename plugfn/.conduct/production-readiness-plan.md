# PlugFn Production Readiness Plan

**Date**: 2026-05-19
**Status**: Draft implementation plan
**Scope**: PlugFn runtime, provider system, client SDK, security, and production readiness

## Goal

Make PlugFn a production-ready, Postgres-first integration runtime that consumer apps such as Fellotron and future Nucleum products can adopt without hand-rolling OAuth, token vaults, webhook verification, provider action clients, installation lifecycle, or integration status UI primitives.

PlugFn should not own every consumer domain model, but it should provide enough runtime, sync, and optional persistence primitives that consumers can adopt it without rebuilding integration infrastructure.

## Product Contract

PlugFn owns:

- provider registration and discovery
- user, organization, and delegated installation lifecycle
- OAuth start, callback, token exchange, refresh, revoke, and disconnect
- encrypted token vault and rotation-ready key references
- provider action execution
- webhook ingress, verification, idempotency, normalization, and delivery tracking
- sync/backfill jobs, checkpoints, pagination, retries, and progress state
- typed server SDK and browser-safe client SDK
- provider readiness gates and operational runbooks
- optional persistence sinks and transforms

Consumers own:

- product-specific UI
- domain-specific data models
- decisions about which external records become product records
- app-specific authorization policy around who may see or act on imported data
- downstream processing after PlugFn emits normalized provider events

## Readiness Principles

1. No global production-ready claim is allowed unless `npm run gate:plugfn-release` passes on the same commit.
2. Production readiness remains provider-specific.
3. Provider source-tree presence does not equal supported adoption.
4. Secrets live in runtime integration config or secret resolvers, not static provider constructors.
5. Browser clients may initiate and inspect integrations, but never receive provider secrets, raw access tokens, refresh tokens, or webhook verification capability.
6. Postgres via `@superfunctions/db` is the first production target.
7. User-level, organization-level, and delegated/shared connections are first-class runtime concepts.

## Target Package Shape

The scalable shape for hundreds of providers is a small core runtime plus provider packages:

```txt
plugfn
@plugfn/client
@plugfn/provider-github
@plugfn/provider-linear
@plugfn/provider-gmail
@plugfn/provider-notion
@plugfn/persistence-db
@plugfn/persistence-datafn
```

During migration, the monorepo can keep providers under `plugfn/providers/*` or `plugfn/provider-*/*` while publishing them as independent workspaces. The core runtime should not need a code change for every provider.

Provider packages define static behavior:

```ts
import { githubProvider } from "@plugfn/provider-github";

plug.providers.register(
  githubProvider({
    defaultScopes: ["repo", "read:org", "user:email"],
    sinks: {
      issue: githubIssueSink,
    },
  })
);
```

Runtime config holds secrets:

```ts
const plug = plugFn({
  database,
  auth,
  baseUrl: "https://app.example.com",
  encryptionKey: process.env.PLUGFN_ENCRYPTION_KEY!,
  integrations: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
});
```

For multi-tenant apps, this should also support a secret resolver:

```ts
const plug = plugFn({
  integrations: {
    github: {
      async resolveOAuthClient(context) {
        return tenantSecretStore.getOAuthClient({
          tenantId: context.tenantId,
          provider: "github",
        });
      },
    },
  },
});
```

## Core Runtime Model

PlugFn needs to model installation ownership explicitly:

```ts
type PlugFnConnectionOwner =
  | { kind: "user"; userId: string; tenantId?: string }
  | { kind: "organization"; organizationId: string; installedByUserId: string }
  | {
      kind: "delegated";
      organizationId: string;
      delegatedToUserId: string;
      installedByUserId: string;
      grants: string[];
    };
```

Connection APIs should accept owner scope:

```ts
await plug.connections.start({
  provider: "github",
  owner: { kind: "organization", organizationId, installedByUserId },
  returnTo: "/settings/integrations",
});

await plug.connections.list({
  owner: { kind: "user", userId },
});

await plug.connections.disconnect({
  connectionId,
  actor: { userId, roles },
});
```

Required runtime tables:

- `plugfn_connections`
- `plugfn_oauth_states`
- `plugfn_oauth_tokens`
- `plugfn_provider_installations`
- `plugfn_connection_grants`
- `plugfn_webhook_endpoints`
- `plugfn_webhook_receipts`
- `plugfn_webhook_deliveries`
- `plugfn_sync_jobs`
- `plugfn_sync_checkpoints`
- `plugfn_action_logs`
- `plugfn_provider_events`
- `plugfn_secret_refs`

Existing table names can be migrated, but new names should avoid collisions with consumer app tables.

## Browser Client SDK

Add `@plugfn/client` with safe browser APIs:

```ts
const plug = createPlugFnClient({ baseUrl: "/api/plugfn" });

await plug.listProviders();
await plug.listConnections();
await plug.startConnection({ provider: "github", ownerKind: "user" });
await plug.disconnect({ provider: "github", connectionId });
await plug.getConnectionStatus({ provider: "github" });
```

If a provider is not registered or configured on the backend, the server returns deterministic errors:

```json
{
  "ok": false,
  "error": {
    "code": "PROVIDER_NOT_REGISTERED",
    "message": "github is not available"
  }
}
```

The client SDK must never expose:

- token exchange
- token refresh
- token values
- provider secrets
- credentialed provider actions
- webhook verification
- workflow execution

## Webhook Ingress V2

The current common route shape is useful but too rigid:

```txt
POST /webhooks/:provider/:event
```

The production route model should support provider-resolved events:

```txt
POST /webhooks/:provider
POST /webhooks/:provider/:route
POST /webhooks/:provider/:event
```

Provider adapters own:

- event name resolution from headers/body/path
- signature verification
- raw body handling
- timestamp tolerance checks where applicable
- idempotency key extraction
- payload normalization
- connection/installation resolution

Webhook receipts are persisted before handler execution:

```ts
type PlugFnWebhookReceipt = {
  id: string;
  provider: string;
  event: string;
  idempotencyKey: string;
  connectionId?: string;
  ownerRef?: PlugFnConnectionOwner;
  headersRedacted: Record<string, string>;
  payloadHash: string;
  receivedAt: Date;
  verificationStatus: "verified" | "failed" | "not-required";
};
```

Deliveries are tracked separately:

```ts
type PlugFnWebhookDelivery = {
  id: string;
  receiptId: string;
  sinkId?: string;
  handlerName?: string;
  status: "pending" | "running" | "success" | "failed" | "dead-lettered";
  attempts: number;
  nextAttemptAt?: Date;
  error?: string;
};
```

## Sync And Backfill

PlugFn should provide durable sync jobs:

```ts
await plug.sync.backfill({
  provider: "gmail",
  connectionId,
  resource: "messages",
  mode: "full",
  sink: "fellotron.messages",
});

await plug.sync.incremental({
  provider: "github",
  connectionId,
  resource: "issues",
  sink: "nucleum.externalIssues",
});
```

Sync jobs must support:

- pagination
- resumable checkpoints
- rate limit handling
- retries with backoff
- partial failure
- cancellation
- progress state
- per-owner authorization
- provider-specific checkpoint contracts
- sync result summaries

Job state:

```ts
type PlugFnSyncJob = {
  id: string;
  provider: string;
  connectionId: string;
  resource: string;
  mode: "full" | "incremental";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  cursor?: string;
  checkpoint?: unknown;
  fetchedCount: number;
  persistedCount: number;
  skippedCount: number;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
};
```

## Persistence Sinks

PlugFn should not force a single app data model, but it should offer persistence sinks so consumers do not rewrite the same backfill/webhook glue.

Sink contract:

```ts
type PlugFnPersistenceSink<Raw, Record> = {
  id: string;
  provider: string;
  resource: string;
  idempotencyKey(raw: Raw, context: PlugFnSinkContext): string;
  transform(raw: Raw, context: PlugFnSinkContext): Promise<Record> | Record;
  upsert(record: Record, context: PlugFnSinkContext): Promise<void>;
  delete?(raw: Raw, context: PlugFnSinkContext): Promise<void>;
};
```

Consumer example:

```ts
const gmailMessageSink = createPlugFnSink({
  id: "fellotron.gmailMessages",
  provider: "gmail",
  resource: "message",
  idempotencyKey: (message) => message.providerMessageId,
  transform: (message, context) => ({
    accountId: context.connectionId,
    providerMessageId: message.providerMessageId,
    subject: message.subject,
    snippet: message.snippet,
    raw: message,
  }),
  upsert: (record) => fellotronDb.gmailMessages.upsert(record),
});
```

Postgres-first helper package:

```ts
createDbSink({
  adapter: superfunctionsDb,
  model: "external_messages",
  uniqueBy: ["provider", "providerMessageId"],
  transform,
});
```

DataFn sink can come later after Nucleum chooses its consumption path.

## Provider Type Safety

Current PlugFn has runtime validation through Zod, but dynamic provider access is mostly `any`. Production PlugFn should support typed provider registration:

```ts
const plug = plugFn(config)
  .use(githubProvider())
  .use(linearProvider())
  .use(gmailProvider());

await plug.github.issues.list({
  owner: "21nCo",
  repo: "21n",
});
```

The dynamic action API remains available:

```ts
await plug.action("github", "issues.list", {
  owner: "21nCo",
  repo: "21n",
});
```

Provider packages should export:

- provider factory
- action parameter types
- action return types
- normalized event types
- sync resource types
- sink input types
- generated client method metadata

## Provider System

Provider package contract:

```ts
type PlugFnProviderDefinition = {
  id: string;
  displayName: string;
  version: string;
  auth: PlugFnProviderAuthDefinition;
  actions: Record<string, PlugFnActionDefinition>;
  webhooks?: PlugFnWebhookDefinition[];
  sync?: Record<string, PlugFnSyncResourceDefinition>;
  capabilities: PlugFnProviderCapabilities;
  defaultPolicies?: PlugFnProviderPolicy[];
};
```

Provider package responsibilities:

- define OAuth endpoints/scopes
- define API action schemas
- normalize raw provider responses
- define webhook verification and event parsing
- define sync resources and checkpoint behavior
- define provider-specific errors and rate limits

Core runtime responsibilities:

- call provider definitions
- store runtime state
- enforce auth/ownership/policy
- route OAuth and webhooks
- execute actions and sync jobs
- invoke sinks

## Target Providers

### GitHub

Required:

- OAuth app support
- optional GitHub App installation support
- repo list/get
- issue list/get/create/update/comment
- pull request list/get/create/comment/review
- webhook verification
- webhook event normalization
- org-level installation ownership

### Linear

Required:

- OAuth
- team list
- issue search/list/get/create/update
- comment create
- webhook verification
- user/org ownership

### Gmail

Required:

- OAuth with offline access
- profile action
- message list/get/modify
- full and incremental sync
- durable checkpoints
- Pub/Sub watch creation/renewal
- Pub/Sub push ingestion
- normalized message type
- configurable scope modes: metadata, snippet, full body, modify
- sink support

### Notion

Required:

- OAuth
- workspace/bot identity
- page/database search
- page/database read
- page create/update where scopes allow
- normalized page/database/block types
- initial import/backfill
- polling sync if webhook support is unavailable or insufficient

### Google Provider Split

Avoid one vague "google" provider. Use:

- `google` for profile/account identity only
- `gmail` for mail
- future `google-drive`
- future `google-calendar`
- future `google-docs`

## Fellotron Replacement Path

### Current Safe Path

For current Fellotron, PlugFn should first replace:

- Google OAuth connection start/callback
- encrypted token storage
- refresh and disconnect
- connection list/status

Fellotron keeps:

- inbox UI
- `gmail_message` product table
- custom tabs
- local archive/read presentation state
- product-specific routes until PlugFn client exists

### Production Target Path

After PlugFn Gmail sync/webhook/sink support is production-ready:

```ts
const plug = plugFn(config)
  .use(gmailProvider({
    sinks: {
      message: fellotronGmailMessageSink,
    },
  }));

await plug.sync.backfill({
  provider: "gmail",
  connectionId,
  resource: "messages",
  mode: "full",
});
```

Browser:

```ts
const plug = createPlugFnClient({ baseUrl: "/api/plugfn" });

await plug.startConnection({ provider: "gmail", ownerKind: "user" });
const connections = await plug.listConnections({ provider: "gmail" });
```

Webhook:

```txt
POST /api/plugfn/webhooks/gmail/pubsub
```

PlugFn:

1. verifies/validates Pub/Sub envelope
2. resolves Gmail connection from email/history payload
3. stores webhook receipt
4. schedules incremental sync
5. fetches changed messages
6. invokes `fellotronGmailMessageSink`
7. advances checkpoint

## Route Contract

Server routes should include:

```txt
GET    /providers
GET    /connections
POST   /connections/start
GET    /connections/callback/:provider
POST   /connections/disconnect
POST   /connections/revoke
GET    /connections/:connectionId/status
POST   /sync/jobs
GET    /sync/jobs/:jobId
POST   /sync/jobs/:jobId/cancel
POST   /webhooks/:provider
POST   /webhooks/:provider/:route
GET    /events
GET    /metrics
```

Legacy routes may remain temporarily:

```txt
POST /connections/auth
GET  /callback
```

## Security Requirements

OAuth:

- state must be random, bound to owner/tenant/provider/redirect, expiring, and single-use
- redirect URI must be allowlisted
- PKCE must be used when supported
- provider errors must be deterministic and redacted
- token exchange must be server-only

Tokens:

- encrypted at rest
- key references stored separately
- rotation story documented and tested
- refresh token never exposed in logs or client responses
- access token never exposed except inside server-side provider action execution

Webhooks:

- raw body preserved
- signatures verified before processing
- timestamp tolerance where provider supports it
- idempotency persisted
- replay protection persisted
- failed deliveries tracked and retryable

Authorization:

- connection ownership enforced on every operation
- org installs require org admin policy hook
- delegated installs require grants
- server action execution checks actor permissions
- client routes never trust caller-supplied `userId`

Observability:

- structured logs
- token redaction
- provider/action/connection/job metrics
- webhook receipt and delivery tracing
- sync job progress
- health checks per provider

## CLI Requirements

CLI should support:

```bash
plugfn providers list
plugfn providers inspect github
plugfn connections list --provider gmail
plugfn sync backfill --provider gmail --connection <id> --resource messages
plugfn webhooks replay --receipt <id>
plugfn doctor
plugfn generate-types
```

`plugfn doctor` should validate:

- DB schema installed
- provider registered
- provider configured
- OAuth redirect allowlist
- webhook secret presence
- release-gate readiness
- client/server route reachability

## Release Gates

The release gate should include:

- TypeScript build
- TypeScript typecheck
- TypeScript tests
- provider package builds
- provider package tests
- CLI build/typecheck/tests
- client build/typecheck/tests
- Python status checks or explicit exclusion from production claim
- Postgres adapter integration tests
- OAuth callback replay tests
- webhook replay/idempotency tests
- sync backfill/resume tests
- security redaction tests
- docs truth inventory

Provider-specific production gates:

```bash
npm run gate:plugfn-release
npm run gate:plugfn-provider-github
npm run gate:plugfn-provider-linear
npm run gate:plugfn-provider-gmail
npm run gate:plugfn-provider-notion
```

## Implementation Phases

### Phase 0: Current Gate Repair

- Fix current `npm run gate:plugfn-release` failures.
- Make docs and matrix match current reality.
- Keep production claims blocked until green.

### Phase 1: Schema And Runtime Ownership

- Rename/default models to `plugfn_*`.
- Add owner model for user/org/delegated installs.
- Add installation and grant tables.
- Add connection authorization checks.
- Add migration-safe compatibility for current connection records.

### Phase 2: Provider Package Contract

- Extract provider definition type.
- Add `.use(provider)` typed registration.
- Keep `.providers.register(provider)` compatibility.
- Move GitHub provider to first provider package/workspace.
- Prove no core runtime change is needed for an external provider.

### Phase 3: Client SDK

- Create `@plugfn/client`.
- Add provider catalog/status methods.
- Add start/list/disconnect/status methods.
- Add deterministic unavailable-provider errors.
- Add tests for missing provider, unconfigured provider, auth-required, and tenant mismatch.

### Phase 4: OAuth V2

- Add `connections/start` and provider callback routes.
- Add redirect allowlists and return-to allowlists.
- Add secret resolver support.
- Add remote revoke handling.
- Add refresh and disconnect lifecycle events.
- Add typed connection statuses.

### Phase 5: Webhook V2

- Add provider-resolved webhook ingress.
- Persist webhook receipts.
- Persist delivery attempts.
- Add replay protection.
- Add dead-letter state.
- Add webhook replay CLI command.

### Phase 6: Sync Jobs And Checkpoints

- Add `plug.sync.backfill`.
- Add `plug.sync.incremental`.
- Add sync job tables.
- Add checkpoint tables.
- Add provider sync resource contract.
- Add durable retry/backoff.

### Phase 7: Persistence Sinks

- Add sink contract.
- Add DB sink helper.
- Wire sinks into action, sync, and webhook flows.
- Add idempotency and transform tests.
- Keep DataFn sink out of first implementation unless needed later.

### Phase 8: Gmail Production Provider

- Move Gmail into provider package.
- Replace in-memory default sync/watch state with Postgres-backed stores.
- Add message normalization types.
- Add Pub/Sub push route.
- Add watch renewal job.
- Add metadata/snippet/full-body/modify scope modes.
- Add Fellotron adapter example.

### Phase 9: GitHub And Linear Production Providers

- Move GitHub and Linear into provider packages.
- Add org/user install tests.
- Add webhook event normalization and idempotency.
- Add read/write action coverage.
- Add sync resources for issues and PRs.

### Phase 10: Notion Provider

- Add Notion OAuth.
- Add page/database search/read/write actions.
- Add initial import sync.
- Add polling/checkpoint strategy if webhooks are unavailable or insufficient.
- Add normalized Notion entity types.

### Phase 11: Fellotron Migration Example

- Add an example app or integration fixture showing Fellotron-style Gmail adoption.
- Demonstrate connection install, message backfill, Pub/Sub webhook, sink persistence, disconnect.
- Keep consumer-specific UI outside PlugFn.

### Phase 12: Production Hardening

- Add audit log redaction tests.
- Add rate-limit tests.
- Add token-rotation test vectors.
- Add provider outage runbooks.
- Add operational dashboards/metrics docs.
- Add readiness matrix automation.

## Open Decisions

- Exact workspace naming for provider packages.
- Whether to keep current `plugfn/typescript/src/providers/*` as compatibility exports after package extraction.
- Whether Python remains experimental or receives parity later.
- Whether workflow execution remains part of core production claim or is separated from integration lifecycle readiness.

## Success Criteria

PlugFn is production-ready for a provider when:

1. The provider package has a green provider gate.
2. The root PlugFn release gate is green on the same commit.
3. OAuth, webhook, sync, disconnect, and ownership tests pass for that provider.
4. Runtime secrets are supplied only through integration config or secret resolvers.
5. Browser SDK can install/list/disconnect safely.
6. Webhook receipts and sync jobs are durable in Postgres.
7. Provider docs include setup, scopes, routes, security notes, and operational runbooks.
8. A Fellotron-style consumer can use the provider without hand-rolling OAuth, token storage, webhook verification, and sync checkpointing.
