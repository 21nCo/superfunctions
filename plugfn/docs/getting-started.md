# Getting Started with PlugFn

PlugFn powers Finatron and Fellotron integrations with shared OAuth primitives and policy-guarded provider adapters.

## Install

```bash
npm install @superfunctions/plugfn @superfunctions/db @superfunctions/http
```

## Core Setup

```ts
import { plugFn } from '@superfunctions/plugfn';
import { gmailProvider, outlookProvider } from '@superfunctions/plugfn/providers';

const plug = plugFn({
  database: adapter,
  auth: authProvider,
  baseUrl: 'https://app.example.com',
  encryptionKey: process.env.ENCRYPTION_KEY!,
  integrations: {
    gmail: {
      type: 'oauth2',
      clientId: process.env.GMAIL_CLIENT_ID!,
      clientSecret: process.env.GMAIL_CLIENT_SECRET!,
      redirectUris: ['https://app.example.com/oauth/callback'],
    },
    outlook: {
      type: 'oauth2',
      clientId: process.env.MS_CLIENT_ID!,
      clientSecret: process.env.MS_CLIENT_SECRET!,
      redirectUris: ['https://app.example.com/oauth/callback'],
    },
  },
});

plug.providers.register(gmailProvider);
plug.providers.register(outlookProvider);
```

## Database Contract

Use a database adapter compatible with `@superfunctions/db` contracts. PlugFn storage wrappers build on
that shared adapter baseline for connections, webhooks, workflow state, and execution logs.

OAuth flows in `plugfn` use shared packages:

- `@superfunctions/oauth-core`
- `@superfunctions/oauth-http`
- `@superfunctions/oauth-storage`
- `@superfunctions/oauth-providers`

## Mounting Routes with `@superfunctions/http-*`

Use `@superfunctions/http` + framework adapters rather than framework-specific route wiring.

### Express

```ts
import express from 'express';
import { createExpressAdapter } from '@superfunctions/http-express';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';

const app = express();
const adapter = createExpressAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

### Fastify

```ts
import Fastify from 'fastify';
import { createFastifyAdapter } from '@superfunctions/http-fastify';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';

const app = Fastify();
const adapter = createFastifyAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

### Hono

```ts
import { Hono } from 'hono';
import { createHonoAdapter } from '@superfunctions/http-hono';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';

const app = new Hono();
const adapter = createHonoAdapter(app);
adapter.mount(createRouter({ routes: createPlugFnRouter(plug) }), '/api/plugfn');
```

## Provider Coverage For Finatron/Fellotron

Required adapters are available for:

- `gmail`
- `outlook`
- `yahoo`
- `icloud`
- `imap-smtp`
- `forwarding` (optional fallback ingest)
- `managed-mail` (explicit opt-in mode)

Provider operations are enforced through the policy registry before external API calls.

## Managed Mailbox Risk Boundary

Managed mailbox mode is not a default path. Finance-critical usage must require:

1. Explicit user opt-in.
2. Backup channel confirmation.
3. Risk acknowledgment.

E2EE security mode metadata must be explicit per mailbox (`non-recoverable` or `escrow-recoverable`).

## Lifecycle and Security Controls

PlugFn includes lifecycle and telemetry controls for production operations:

- Retention sweeps with legal-hold exceptions.
- Portable user export across connections/tokens/messages/parse artifacts.
- Cascading user deletion with residual-record detection.
- Tenant/user isolation guards that return `TENANT_ACCESS_DENIED` on cross-scope access.
- Redaction utilities for logs and metric dimensions.

## Runbooks

Operational runbooks:

- [OAuth Incident](./runbooks/oauth-incident.md)
- [Provider Throttle Incident](./runbooks/provider-throttle-incident.md)
- [Webhook Security Incident](./runbooks/webhook-security-incident.md)
- [Mail Delivery Incident](./runbooks/mail-delivery-incident.md)

## Interop with authfn

`authfn` social OAuth reuses the same shared OAuth package family. Keep provider configuration and redirect URI controls aligned across both services to avoid callback mismatch and policy drift.

Legacy path note:
- `plugfn/auth/oauth-flow` is a compatibility shim for one minor release.
- It emits `DEPRECATED_PATH` and points to `@superfunctions/oauth-flow`.
- Planned removal target: `plugfn@0.2.0`.

## Release Verification

```bash
cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript
npm test -- --run tests/security/lifecycle.test.ts tests/security/redaction.test.ts tests/security/isolation.test.ts

cd /Users/serro/Documents/dev/n/superfunctions
turbo run build test --filter=@superfunctions/oauth-core --filter=@superfunctions/oauth-http --filter=@superfunctions/oauth-storage --filter=@superfunctions/oauth-providers --filter=plugfn --filter=@authfn/core
```
