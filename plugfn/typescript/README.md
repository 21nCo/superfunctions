# PlugFn TypeScript SDK

> Self-hosted integration platform for TypeScript/JavaScript applications

Full-featured TypeScript SDK for building integrations with 75+ APIs.

## Installation

```bash
npm install @superfunctions/plugfn @superfunctions/db @superfunctions/http

# Install framework adapter (choose one)
npm install @superfunctions/http-express
npm install @superfunctions/http-hono
npm install @superfunctions/http-fastify
npm install @superfunctions/http-next
```

## Quick Start

### 1. Initialize PlugFn

```typescript
import { plugFn } from '@superfunctions/plugfn';
import { drizzleAdapter } from '@superfunctions/db/adapters';
import { githubProvider } from '@superfunctions/plugfn/providers';

const plug = plugFn({
  database: adapter,
  auth: authProvider,
  baseUrl: 'https://myapp.com',
  encryptionKey: process.env.ENCRYPTION_KEY,
  integrations: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      scopes: ['repo', 'issues', 'user']
    }
  }
});

plug.providers.register(githubProvider);
```

### 2. Execute Actions

```typescript
// Execute an action
const issue = await plug.github['issues.create']({
  userId: 'user-123',
  params: {
    owner: 'myorg',
    repo: 'myrepo',
    title: 'Bug report',
    body: 'Something is broken'
  }
});
```

### 3. Mount HTTP Endpoints

#### With Express

```typescript
import express from 'express';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';
import { toExpress } from '@superfunctions/http-express';

const app = express();
app.use(express.json());

const router = createPlugFnRouter(plug);
app.use('/api/plugfn', toExpress(router));

app.listen(3000);
```

#### With Hono

```typescript
import { Hono } from 'hono';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';
import { toHono } from '@superfunctions/http-hono';

const app = new Hono();

const router = createPlugFnRouter(plug);
app.route('/api/plugfn', toHono(router));

export default app;
```

#### With Fastify

```typescript
import Fastify from 'fastify';
import { createPlugFnRouter } from '@superfunctions/plugfn/router';
import { toFastify } from '@superfunctions/http-fastify';

const fastify = Fastify();

const router = createPlugFnRouter(plug);
fastify.register(toFastify(router), { prefix: '/api/plugfn' });

await fastify.listen({ port: 3000 });
```

## Features

- ✅ **Type-safe**: Full TypeScript with auto-complete
- ✅ **OAuth built-in**: Complete OAuth 2.0 flow
- ✅ **Webhooks**: Real-time event handling
- ✅ **Workflows**: Chain actions together
- ✅ **5 providers**: GitHub, Slack, Discord, Linear, Stripe
- ✅ **Framework-agnostic**: Works with Express, Hono, Fastify, Next.js, SvelteKit
- ✅ **Testing utilities**: Mock providers and workflows

## HTTP Endpoints

Once mounted, the following endpoints are available:

- `GET /callback` - OAuth callback handler
- `POST /webhooks/:provider/:event` - Webhook receiver
- `GET /providers` - List available providers
- `GET /connections` - List user connections
- `POST /connections/auth` - Get OAuth authorization URL
- `POST /connections/disconnect` - Disconnect a connection
- `GET /workflows` - List workflows
- `GET /metrics` - Get execution metrics

## Documentation

- [Implementation Guide](./IMPLEMENTATION.md)
- [Status & Roadmap](./STATUS.md)
- [Changelog](./CHANGELOG.md)
- [Examples](./examples/)
- [API Reference](../docs/api-reference/)

## Examples

See the [`examples/`](./examples/) directory for:
- Basic usage
- Complete workflows
- Express server integration
- Testing examples

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Test
npm test

# Development mode
npm run dev
```

## License

Apache-2.0

