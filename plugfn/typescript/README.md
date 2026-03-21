# PlugFn TypeScript SDK

PlugFn is a TypeScript integration runtime for Finatron and Fellotron workloads, including shared OAuth flows, email provider adapters, workflow execution, and policy-enforced delivery controls.

## Installation

```bash
npm install @superfunctions/plugfn @superfunctions/db @superfunctions/http
```

## Quick Start

```ts
import { plugFn } from '@superfunctions/plugfn';
import {
  gmailProvider,
  outlookProvider,
  yahooProvider,
  icloudProvider,
  imapSmtpProvider,
  forwardingProvider,
  managedMailProvider,
} from '@superfunctions/plugfn/providers';

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
plug.providers.register(yahooProvider);
plug.providers.register(icloudProvider);
plug.providers.register(imapSmtpProvider);
plug.providers.register(forwardingProvider);
plug.providers.register(managedMailProvider);
```

## Canonical DB Adapter Contract

PlugFn expects a database adapter contract anchored to `@superfunctions/db` types.
PlugFn-specific storage helpers (`createConnection`, `listConnections`, etc.) can be provided on top
of that shared adapter base.

## Shared OAuth Foundation

PlugFn consumes shared OAuth packages:

- `@superfunctions/oauth-core`
- `@superfunctions/oauth-http`
- `@superfunctions/oauth-storage`
- `@superfunctions/oauth-providers`

This keeps OAuth state, callback validation, token exchange/refresh, and revocation behavior aligned with `authfn` social sign-in.

## HTTP Router Mounting (Shared Abstractions)

PlugFn routes should be mounted through `@superfunctions/http` and adapter packages.

### Express

```ts
import express from 'express';
import { createExpressAdapter } from '@superfunctions/http-express';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';

const app = express();
const httpAdapter = createExpressAdapter(app);
const router = createRouter({ routes: createPlugFnRouter(plug) });
httpAdapter.mount(router, '/api/plugfn');
```

### Fastify

```ts
import Fastify from 'fastify';
import { createFastifyAdapter } from '@superfunctions/http-fastify';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';

const app = Fastify();
const httpAdapter = createFastifyAdapter(app);
const router = createRouter({ routes: createPlugFnRouter(plug) });
httpAdapter.mount(router, '/api/plugfn');
```

### Hono

```ts
import { Hono } from 'hono';
import { createHonoAdapter } from '@superfunctions/http-hono';
import { createRouter } from '@superfunctions/http';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';

const app = new Hono();
const httpAdapter = createHonoAdapter(app);
const router = createRouter({ routes: createPlugFnRouter(plug) });
httpAdapter.mount(router, '/api/plugfn');
```

## Provider and Policy Notes

Required mail adapters include `gmail`, `outlook`, `yahoo`, `icloud`, `imap-smtp`, `forwarding`, and `managed-mail`.

Policy guardrails are enforced before outbound provider calls. This includes scope constraints, blocked operations, managed-mailbox opt-in requirements, and finance-risk acknowledgments.

## Conduct v0.3 Provider Contracts

For Conduct dependency alignment, PlugFn public provider contracts include:

- **Linear actions**: `issues.get`, `comments.create`, `issues.search`
- **Linear triggers**: `issue.updated`, `issue_comment.created` (or documented equivalent)
- **GitHub actions**: `issues.get`, `issues.update`, `pulls.create`, `pulls.createReview`
- **GitHub triggers**: `pull_request.closed`, `issue_comment.created`
- **ClickUp actions**: `tasks.create`, `tasks.get`, `tasks.update`, `tasks.list`, `comments.create`, `spaces.list`
- **ClickUp triggers**: `task.updated`, `task.statusChanged`

These are public provider-surface contracts (not Conduct-private APIs), and they remain routed through PlugFn runtime concerns (retry, rate-limit, and webhook verification).

## Security Controls

PlugFn exports security primitives for production operations:

- `retention`: retention policies and sweep orchestration.
- `export-delete`: portable export and cascading deletion across lifecycle stores.
- `redaction`: log/metric redaction and leak assertions.
- `isolation-guards`: tenant/user scope enforcement and cross-tenant denial.
- `e2ee-mode`: explicit managed-mailbox security mode metadata and escrow recovery audit events.

## Managed Mailbox E2EE Modes

Supported modes:

- `non-recoverable`: server-side recovery disabled.
- `escrow-recoverable`: server-side recovery allowed with explicit audited operations.

Security mode metadata must be explicit per mailbox.

## HTTP Surface

Typical routes exposed by the PlugFn router include:

- `GET /providers`
- `GET /connections`
- `POST /connections/auth`
- `POST /connections/disconnect`
- `POST /webhooks/:provider/:event`
- `GET /workflows`
- `GET /metrics`

## Legacy OAuth Path Compatibility

Legacy import path `plugfn/auth/oauth-flow` remains available for one minor release and emits:

- warning code: `DEPRECATED_PATH`
- replacement: `@superfunctions/oauth-flow`
- removal target: `plugfn@0.2.0`

Migration mapping:

| Legacy path | Replacement |
| --- | --- |
| `plugfn/auth/oauth-flow` | `@superfunctions/oauth-flow` + `@superfunctions/oauth-http` + `@superfunctions/oauth-storage` |
| `plugfn/auth/token-store` | `@superfunctions/oauth-storage` token vault APIs |

## Operations Runbooks

Runbooks are maintained under `/plugfn/docs/runbooks/`:

- OAuth incident response
- Provider throttling spikes
- Webhook security failures
- Mail delivery incidents

## Development

```bash
npm run build
npm test -- --run
npm run type-check
```

## License

Apache-2.0
