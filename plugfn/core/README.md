# PlugFn TypeScript Runtime

PlugFn for TypeScript is the reference runtime for the shared PlugFn product contract. It is the most complete implementation today, but it is still under production-readiness hardening and must be read together with the public provider matrix.

## Install

```bash
npm install plugfn @superfunctions/db@0.3.2 @superfunctions/http@0.2.0
```

## Quick start

```ts
import {
  createPlugFnRouter,
  githubProvider,
  linearProvider,
  plugFn,
} from 'plugfn';

const plug = plugFn({
  database: adapter,
  auth: authProvider,
  baseUrl: 'https://app.example.com',
  encryptionKey: process.env.ENCRYPTION_KEY!,
  integrations: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
    linear: {
      clientId: process.env.LINEAR_CLIENT_ID!,
      clientSecret: process.env.LINEAR_CLIENT_SECRET!,
    },
  },
});

plug.providers.register(githubProvider);
plug.providers.register(linearProvider);

const router = createPlugFnRouter(plug);
```

## Shared foundations

PlugFn TypeScript is expected to build on shared packages rather than bespoke copies of generic infrastructure:

- `@superfunctions/db`
- `@superfunctions/http`
- `@superfunctions/oauth-core`
- `@superfunctions/oauth-flow`
- `@superfunctions/oauth-http`
- `@superfunctions/oauth-storage`
- `@superfunctions/oauth-providers`

## Route mounting

Route exposure should flow through `@superfunctions/http` adapters.

### Express

```ts
import express from 'express';
import { createExpressAdapter } from '@superfunctions/http-express';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter, plugFn } from 'plugfn';

const app = express();
const adapter = createExpressAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

### Fastify

```ts
import Fastify from 'fastify';
import { createFastifyAdapter } from '@superfunctions/http-fastify';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter, plugFn } from 'plugfn';

const app = Fastify();
const adapter = createFastifyAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

### Hono

```ts
import { Hono } from 'hono';
import { createHonoAdapter } from '@superfunctions/http-hono';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter, plugFn } from 'plugfn';

const app = new Hono();
const adapter = createHonoAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

## Provider scope

The core provider set tracked by release gating is:

- `github`
- `linear`
- `clickup`
- `gmail`
- `notion`

Other exported providers may still be useful, but they should be treated according to the readiness matrix rather than assumed production-ready by default.

See [../docs/provider-readiness-matrix.md](../docs/provider-readiness-matrix.md).

## OAuth migration

Version 0.2.0 removes the legacy `OAuthFlowHandler` export and
`plugfn/auth/oauth-flow` compatibility module at their announced removal target.
Use `createOAuthFlowService` from `@superfunctions/oauth-flow` with the shared
HTTP/storage packages. The connection manager already uses this canonical stack;
there is no legacy delegate or import-time deprecation shim.

## Browser safety

PlugFn publishes `@plugfn/client`, a thin browser-safe helper for provider discovery, connection lifecycle, and sync-job routes. Provider credentials, token exchange, webhook verification, and privileged provider actions stay on the server. See [../docs/client-sdk-boundary.md](../docs/client-sdk-boundary.md).

## Webhook workflow bindings

Automatic webhook workflows require an explicit `tenantId` on the workflow and
`definition.trigger.connectionId` in its definition. PlugFn matches the provider,
event, tenant, and connection before loading a workflow for execution.

Configure `webhooks.workflowBindings[provider]` with the provider's trusted
signing authorities. Give each authority a stable `id`, the SHA-256 hex
`credentialFingerprints` of its accepted verification credentials, and a
`resolve(subject)` function that searches only its own installation or
connection registry. Multiple credentials for one app can share the authority
when rotating its secret. PlugFn requires exactly one matching authority and one
active installation match with its authoritative `tenantId`, `connectionId`,
and a registry-managed `revoked` signal. Return the same active `AbortSignal`
for the lifetime of a binding generation. Abort it on a binding change or
revocation in every runtime that can deliver events for that authority. Build
the mapping when provisioning the integration and authorize the workflow's connection
when writing its definition. Keep each authenticated subject assigned to its
original tenant, including after revocation. Provision a distinct subject and
connection ID for a different tenant. A retained receipt prevents that delivery
from being admitted under a different binding through either HTTP or the
`PlugFn.webhooks.handle` API.

GitHub App webhooks use the numeric `installation.id` from the HMAC-verified
body as the subject, passed to the resolver as a string. The verified body also
identifies the event. Configure the GitHub App's server-held webhook secret in
the router. Custom providers can expose the authenticated subject and event
through `getWorkflowSubject` and `getWorkflowEvent`. When the verifier also
authenticates a unique delivery ID, the trigger can expose it through
`getAuthenticatedDeliveryId`. Otherwise PlugFn
uses the authenticated body hash to identify redeliveries. For a provider listed
in `workflowBindings`, pass the original request bytes as `rawBody` to
`PlugFn.webhooks.handle` and leave signature verification enabled. This applies
even when only standalone listeners are registered. PlugFn parses the verified
bytes for these providers. An SDK call with only a parsed payload, or with
signature verification disabled, rejects with `WEBHOOK_WORKFLOW_BINDING_REQUIRED`.
Use a credential for the same signing authority for a scoped delivery. The
lower-level `WebhookHandler.handleWebhook` supports standalone listeners.

Apply PlugFn schema version 9 with `superfunctions generate` and your adapter's
migration runner before starting the upgraded webhook workers. The migration
preserves existing receipt keys and adds a separately indexed workflow receipt
key and a scope marker on deliveries. Upgrade all retry workers before enabling
workflow bindings. Scoped deliveries enter through provider redelivery or the SDK
with the original body, signature headers, and verification credential.

Previously stored definitions without both binding fields are skipped during
webhook registration. To restore automatic dispatch, an administrator should
verify the owning tenant and connection, set `tenantId` on the workflow row and
`definition.trigger.connectionId` in the stored definition, then restart the
runtime or rehydrate its workflow triggers. This backfill uses existing columns. Each
single-tenant deployment must also configure an explicit binding. Manual
workflow execution remains available. When a provider has a resolver, a
verified delivery without a workflow subject can still reach an explicitly
registered server-side listener for its event.

An in-flight delivery may run its listener twice when you enable tenant binding.
Signed, bound deliveries use a separate receipt history for each verified signing
authority. Make listener effects idempotent with a durable key for the provider
and relevant tenant or connection. Use an event ID from the verified payload or a
stable business operation key. Enforce uniqueness in the transaction that applies
a local effect, or pass the key to the downstream service when it accepts an
idempotency key.

Use a new workflow ID when moving a bound workflow to a different tenant or
connection. This keeps execution history with the workflow's original tenant.

## Development

```bash
npm run build
npm test -- --run
npm run type-check
```
