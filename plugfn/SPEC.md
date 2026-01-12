# PlugFn Full Specification

> Self-hosted integration platform for developers - Connect your apps to the world

## Overview

PlugFn is a developer-first integration platform that enables seamless connections between your applications and external services. Think "Zapier for devs" - but self-hosted, code-first, and built for the super-functions ecosystem. It provides a unified interface for interacting with 100+ APIs, handling authentication, webhooks, rate limiting, and error handling automatically.

**Version**: 1.0.0  
**Target Release**: Q3 2026  
**Status**: Specification

## Core Philosophy

- **Self-hosted first**: No vendor lock-in, run on your infrastructure
- **Code-first**: TypeScript-native API, no UI required (but UI available)
- **Developer experience**: Simple SDK, works locally, minimal configuration
- **Type-safe**: Full TypeScript support with auto-generated types per integration
- **Provider-agnostic**: Unified interface across all integrations
- **Composable**: Built for the super-functions ecosystem
- **Framework-agnostic**: Works with any framework via @superfunctions/http adapters
- **Multi-tenant ready**: Per-user connections with secure token storage
- **Extensible**: Easy to add custom providers
- **Observable**: Built-in logging, metrics, and monitoring

## Architecture

```
plugfn/
├── ts-sdk/
│   ├── src/
│   │   ├── core/
│   │   │   ├── plug-fn.ts              # Main SDK entry
│   │   │   ├── integration-manager.ts  # Orchestrates integrations
│   │   │   ├── connection-manager.ts   # Manages user connections
│   │   │   ├── action-executor.ts      # Executes actions with retry
│   │   │   ├── trigger-engine.ts       # Webhook + polling engine
│   │   │   ├── workflow-engine.ts      # Workflow orchestration
│   │   │   └── type-generator.ts       # Generate types from specs
│   │   ├── auth/
│   │   │   ├── oauth-flow.ts           # OAuth 2.0 flow handler
│   │   │   ├── api-key-auth.ts         # API key auth
│   │   │   ├── jwt-auth.ts             # JWT auth
│   │   │   ├── basic-auth.ts           # Basic auth
│   │   │   ├── token-store.ts          # Secure token storage
│   │   │   └── types.ts
│   │   ├── providers/
│   │   │   ├── registry.ts             # Provider registry
│   │   │   ├── base-provider.ts        # Base provider interface
│   │   │   ├── github/
│   │   │   │   ├── index.ts
│   │   │   │   ├── actions.ts          # All GitHub actions
│   │   │   │   ├── triggers.ts         # GitHub webhooks
│   │   │   │   ├── auth.ts             # OAuth config
│   │   │   │   ├── types.ts            # TypeScript types
│   │   │   │   └── spec.json           # OpenAPI/metadata
│   │   │   ├── slack/
│   │   │   ├── discord/
│   │   │   ├── linear/
│   │   │   ├── stripe/
│   │   │   ├── notion/
│   │   │   ├── google-calendar/
│   │   │   ├── sendgrid/
│   │   │   └── ...
│   │   ├── webhooks/
│   │   │   ├── webhook-handler.ts      # Unified webhook ingestion
│   │   │   ├── webhook-router.ts       # Route to providers
│   │   │   ├── signature-validator.ts  # Verify webhook signatures
│   │   │   └── event-emitter.ts        # Emit typed events
│   │   ├── middleware/
│   │   │   ├── retry.ts                # Retry logic
│   │   │   ├── rate-limiter.ts         # Per-provider rate limiting
│   │   │   ├── logging.ts              # Request logging
│   │   │   ├── metrics.ts              # Performance metrics
│   │   │   └── caching.ts              # Response caching
│   │   ├── storage/
│   │   │   ├── connection-storage.ts   # Store connections
│   │   │   ├── token-storage.ts        # Store tokens securely
│   │   │   ├── webhook-storage.ts      # Store webhook configs
│   │   │   ├── workflow-storage.ts     # Store workflows
│   │   │   └── adapters/
│   │   │       ├── database.ts         # @superfunctions/db
│   │   │       ├── memory.ts
│   │   │       └── file.ts
│   │   ├── utils/
│   │   │   ├── crypto.ts               # Token encryption
│   │   │   ├── url-builder.ts          # Build API URLs
│   │   │   ├── request.ts              # HTTP client
│   │   │   └── validation.ts           # Zod schemas
│   │   └── types/
│   │       ├── provider.ts
│   │       ├── action.ts
│   │       ├── trigger.ts
│   │       ├── connection.ts
│   │       └── workflow.ts
│   └── examples/
├── dashboard/                           # Connection management UI
│   └── src/
│       ├── components/
│       │   ├── ConnectionList.tsx
│       │   ├── ProviderCard.tsx
│       │   ├── OAuthCallback.tsx
│       │   └── WorkflowBuilder.tsx
│       └── pages/
├── cli/
│   └── src/
│       ├── commands/
│       │   ├── init.ts                 # Initialize plugfn
│       │   ├── generate-types.ts       # Generate types
│       │   ├── add-provider.ts         # Add new provider
│       │   └── test.ts                 # Test connections
│       └── templates/
└── shared-types/                        # Shared TypeScript types
```

## Core Features

### 1. Basic Setup & Configuration

#### Installation

```bash
npm install plugfn @superfunctions/db @superfunctions/http
```

#### Initialization

```typescript
import { plugFn } from 'plugfn';
import { drizzleAdapter } from '@superfunctions/db/adapters';
import { createAuthFn } from 'authfn';

const db = drizzle(client, { schema });
const adapter = drizzleAdapter({ db, dialect: 'postgres' });

const auth = createAuthFn({
  database: adapter,
  namespace: 'authfn'
});

const plug = plugFn({
  database: adapter,
  auth: auth.provider,
  baseUrl: 'https://myapp.com',
  encryptionKey: process.env.ENCRYPTION_KEY,
  integrations: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      scopes: ['repo', 'issues', 'user']
    },
    slack: {
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      scopes: ['chat:write', 'channels:read']
    },
    stripe: {
      apiKey: process.env.STRIPE_API_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET
    }
  },
  cache: {
    enabled: true,
    ttl: 300000
  },
  rateLimit: {
    enabled: true,
    respectProviderLimits: true
  }
});
```

#### Mount API Routes

```typescript
import express from 'express';
import { toExpress } from '@superfunctions/http-express';

const app = express();

app.use('/api/plugfn', toExpress(plug.router));

app.listen(3000);
```

### 2. Connection Management

#### OAuth Flow

```typescript
async function connectGitHub(userId: string) {
  const authUrl = await plug.connections.getAuthUrl({
    userId,
    provider: 'github',
    redirectUri: 'https://myapp.com/integrations/callback',
    state: generateState()
  });
  
  return authUrl;
}

app.get('/integrations/callback', async (req, res) => {
  const { code, state } = req.query;
  
  const connection = await plug.connections.handleCallback({
    code: code as string,
    state: state as string
  });
  
  console.log(`Connected: ${connection.provider} for user ${connection.userId}`);
  res.redirect('/integrations');
});
```

#### List Connections

```typescript
const connections = await plug.connections.list({
  userId: 'user-123'
});

connections.forEach(conn => {
  console.log(`${conn.provider}: ${conn.status}`);
  console.log(`Connected: ${conn.connectedAt}`);
  console.log(`Scopes: ${conn.scopes.join(', ')}`);
});
```

#### Disconnect

```typescript
await plug.connections.disconnect({
  userId: 'user-123',
  provider: 'github'
});
```

#### Multi-Account Support

```typescript
const connections = await plug.connections.list({
  userId: 'user-123',
  provider: 'github'
});

const personalGithub = connections.find(c => c.name === 'Personal');
const workGithub = connections.find(c => c.name === 'Work');

const personalIssues = await plug.github.issues.list({
  userId: 'user-123',
  connectionId: personalGithub.id
});
```

### 3. Actions - Calling External APIs

#### Simple Action Execution

```typescript
const issue = await plug.github.issues.create({
  userId: 'user-123',
  params: {
    owner: 'myorg',
    repo: 'myrepo',
    title: 'Bug: Something broke',
    body: 'Description of the bug',
    labels: ['bug', 'high-priority']
  }
});

console.log(`Created issue #${issue.number}: ${issue.html_url}`);
```

#### Action with Connection Selection

```typescript
const message = await plug.slack.postMessage({
  userId: 'user-123',
  connectionId: 'conn-work-slack',
  params: {
    channel: '#engineering',
    text: 'Deploy complete! :rocket:',
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Deploy Status*\nSuccess ✅' }
      }
    ]
  }
});
```

#### Batch Actions

```typescript
const results = await plug.batch([
  { provider: 'github', action: 'issues.list', userId: 'user-123', params: { owner: 'org', repo: 'repo1' } },
  { provider: 'github', action: 'issues.list', userId: 'user-123', params: { owner: 'org', repo: 'repo2' } },
  { provider: 'linear', action: 'issues.list', userId: 'user-123', params: { teamId: 'team-123' } }
]);

results.forEach((result, index) => {
  if (result.success) {
    console.log(`Action ${index}: ${result.data.length} items`);
  } else {
    console.error(`Action ${index} failed:`, result.error);
  }
});
```

#### Provider Capabilities

```typescript
interface ActionOptions {
  userId: string;
  connectionId?: string;
  params: Record<string, any>;
  retry?: {
    maxAttempts?: number;
    delay?: number;
    backoff?: 'linear' | 'exponential';
  };
  timeout?: number;
  cache?: boolean | {
    ttl?: number;
    key?: string;
  };
}

interface ActionResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  provider: string;
  action: string;
  cached?: boolean;
  duration: number;
  retries: number;
}
```

### 4. Triggers - Receiving Events

#### Webhook Setup

```typescript
plug.webhooks.register({
  provider: 'github',
  events: ['issues', 'pull_request'],
  webhookUrl: 'https://myapp.com/api/plugfn/webhooks/github',
  secret: process.env.GITHUB_WEBHOOK_SECRET
});

plug.webhooks.register({
  provider: 'stripe',
  events: ['customer.created', 'payment_intent.succeeded'],
  webhookUrl: 'https://myapp.com/api/plugfn/webhooks/stripe',
  secret: process.env.STRIPE_WEBHOOK_SECRET
});
```

#### Event Listeners

```typescript
plug.github.on('issues.opened', async (event) => {
  console.log(`New issue: ${event.issue.title}`);
  
  await plug.slack.postMessage({
    userId: event.installation.userId,
    params: {
      channel: '#github-feed',
      text: `🐛 New issue: *${event.issue.title}*\n${event.issue.html_url}`
    }
  });
  
  await plug.linear.issues.create({
    userId: event.installation.userId,
    params: {
      teamId: 'team-123',
      title: event.issue.title,
      description: event.issue.body,
      labels: ['from-github'],
      externalId: event.issue.id.toString()
    }
  });
});

plug.stripe.on('customer.created', async (event) => {
  console.log(`New customer: ${event.data.object.email}`);
  
  await plug.sendgrid.send({
    userId: 'system',
    params: {
      to: event.data.object.email,
      from: 'hello@myapp.com',
      templateId: 'welcome-template',
      dynamicTemplateData: {
        name: event.data.object.name
      }
    }
  });
  
  await plug.notion.pages.create({
    userId: 'system',
    params: {
      parent: { database_id: 'customers-db' },
      properties: {
        Email: { email: event.data.object.email },
        Name: { title: [{ text: { content: event.data.object.name } }] },
        'Created At': { date: { start: new Date().toISOString() } }
      }
    }
  });
});

plug.discord.on('message', async (event) => {
  if (event.content.startsWith('/bug')) {
    const title = event.content.replace('/bug', '').trim();
    
    const issue = await plug.github.issues.create({
      userId: event.author.id,
      params: {
        owner: 'myorg',
        repo: 'myrepo',
        title,
        body: `Reported by ${event.author.username} in Discord`,
        labels: ['bug', 'from-discord']
      }
    });
    
    await event.reply(`Created issue #${issue.number}: ${issue.html_url}`);
  }
});
```

#### Polling Triggers

For services without webhooks:

```typescript
plug.enablePolling({
  provider: 'notion',
  action: 'databases.query',
  interval: 60000,
  params: {
    databaseId: 'tasks-db',
    filter: { property: 'Status', select: { equals: 'New' } }
  },
  onChange: async (newItems, prevItems) => {
    for (const item of newItems) {
      await plug.slack.postMessage({
        userId: 'system',
        params: {
          channel: '#tasks',
          text: `New task: ${item.properties.Name.title[0].text.content}`
        }
      });
    }
  }
});
```

#### Event Schema

```typescript
interface WebhookEvent {
  id: string;
  provider: string;
  event: string;
  payload: any;
  signature: string;
  receivedAt: Date;
  verified: boolean;
  userId?: string;
  connectionId?: string;
}

interface TriggerHandler {
  (event: WebhookEvent): Promise<void>;
}
```

### 5. Workflows - Chaining Actions

#### Sequential Workflow

```typescript
const workflow = plug.workflow('github-issue-to-linear')
  .name('Sync GitHub issues to Linear')
  .trigger(plug.github.on('issues.opened'))
  .action(async (context) => {
    const issue = context.trigger.issue;
    
    const linearIssue = await plug.linear.issues.create({
      userId: context.userId,
      params: {
        teamId: 'team-123',
        title: issue.title,
        description: issue.body,
        labels: ['from-github'],
        externalId: issue.id.toString()
      }
    });
    
    return { githubIssue: issue, linearIssue };
  })
  .action(async (context) => {
    await plug.github.issues.createComment({
      userId: context.userId,
      params: {
        owner: context.data.githubIssue.owner,
        repo: context.data.githubIssue.repo,
        issueNumber: context.data.githubIssue.number,
        body: `Synced to Linear: ${context.data.linearIssue.url}`
      }
    });
  })
  .onError(async (error, context) => {
    await plug.slack.postMessage({
      userId: 'system',
      params: {
        channel: '#errors',
        text: `Workflow failed: ${error.message}`
      }
    });
  })
  .enable();
```

#### Conditional Workflow

```typescript
const workflow = plug.workflow('stripe-payment-flow')
  .trigger(plug.stripe.on('payment_intent.succeeded'))
  .filter((context) => {
    return context.trigger.data.object.amount >= 10000;
  })
  .action(async (context) => {
    const payment = context.trigger.data.object;
    
    await plug.sendgrid.send({
      userId: 'system',
      params: {
        to: payment.receipt_email,
        from: 'receipts@myapp.com',
        templateId: 'receipt-template',
        dynamicTemplateData: {
          amount: payment.amount / 100,
          currency: payment.currency.toUpperCase()
        }
      }
    });
    
    return { payment };
  })
  .branch({
    condition: (context) => context.data.payment.amount >= 50000,
    then: async (context) => {
      await plug.slack.postMessage({
        userId: 'system',
        params: {
          channel: '#high-value-sales',
          text: `🎉 Large payment received: $${context.data.payment.amount / 100}`
        }
      });
    },
    else: async (context) => {
      await plug.slack.postMessage({
        userId: 'system',
        params: {
          channel: '#sales',
          text: `Payment received: $${context.data.payment.amount / 100}`
        }
      });
    }
  })
  .enable();
```

#### Parallel Workflow

```typescript
const workflow = plug.workflow('new-customer-onboarding')
  .trigger(plug.stripe.on('customer.created'))
  .parallel([
    async (context) => {
      await plug.sendgrid.send({
        userId: 'system',
        params: {
          to: context.trigger.data.object.email,
          templateId: 'welcome-email'
        }
      });
    },
    async (context) => {
      await plug.notion.pages.create({
        userId: 'system',
        params: {
          parent: { database_id: 'customers-db' },
          properties: {
            Email: { email: context.trigger.data.object.email }
          }
        }
      });
    },
    async (context) => {
      await plug.slack.postMessage({
        userId: 'system',
        params: {
          channel: '#new-customers',
          text: `New customer: ${context.trigger.data.object.email}`
        }
      });
    }
  ])
  .enable();
```

#### Workflow with Delays

```typescript
const workflow = plug.workflow('trial-ending-reminder')
  .trigger(plug.stripe.on('customer.subscription.created'))
  .filter((context) => context.trigger.data.object.trial_end !== null)
  .delay({ days: 3 })
  .action(async (context) => {
    await plug.sendgrid.send({
      userId: 'system',
      params: {
        to: context.trigger.data.object.customer.email,
        templateId: 'trial-reminder-3days'
      }
    });
  })
  .delay({ days: 4 })
  .action(async (context) => {
    await plug.sendgrid.send({
      userId: 'system',
      params: {
        to: context.trigger.data.object.customer.email,
        templateId: 'trial-reminder-1day'
      }
    });
  })
  .enable();
```

#### Workflow Management

```typescript
const workflows = await plug.workflows.list();

await plug.workflows.disable('workflow-id');
await plug.workflows.enable('workflow-id');
await plug.workflows.delete('workflow-id');

const stats = await plug.workflows.getStats('workflow-id');
console.log(`Executions: ${stats.totalExecutions}`);
console.log(`Success rate: ${stats.successRate}%`);
console.log(`Avg duration: ${stats.avgDuration}ms`);
```

### 6. Custom Provider Development

#### Provider Interface

```typescript
import { Provider, Action, Trigger, AuthType } from 'plugfn';
import { z } from 'zod';

export const customAPIProvider: Provider = {
  name: 'custom-api',
  displayName: 'Custom API',
  version: '1.0.0',
  description: 'Integration with Custom API',
  iconUrl: 'https://custom-api.com/icon.png',
  
  auth: {
    type: AuthType.ApiKey,
    config: {
      headerName: 'X-API-Key',
      paramName: 'apiKey'
    }
  },
  
  baseUrl: 'https://api.custom.com/v1',
  
  actions: {
    getData: {
      name: 'getData',
      displayName: 'Get Data',
      description: 'Fetch data from the API',
      
      parameters: z.object({
        id: z.string().describe('Resource ID'),
        fields: z.array(z.string()).optional().describe('Fields to include')
      }),
      
      returns: z.object({
        id: z.string(),
        name: z.string(),
        data: z.any()
      }),
      
      execute: async (params, context) => {
        const url = `${context.provider.baseUrl}/data/${params.id}`;
        const queryParams = params.fields 
          ? `?fields=${params.fields.join(',')}`
          : '';
        
        const response = await context.http.get(`${url}${queryParams}`, {
          headers: {
            'X-API-Key': context.auth.credentials.apiKey
          }
        });
        
        return response.data;
      }
    },
    
    createData: {
      name: 'createData',
      displayName: 'Create Data',
      description: 'Create new data',
      
      parameters: z.object({
        name: z.string(),
        data: z.record(z.any())
      }),
      
      returns: z.object({
        id: z.string(),
        name: z.string(),
        createdAt: z.string()
      }),
      
      execute: async (params, context) => {
        const response = await context.http.post(
          `${context.provider.baseUrl}/data`,
          params,
          {
            headers: {
              'X-API-Key': context.auth.credentials.apiKey,
              'Content-Type': 'application/json'
            }
          }
        );
        
        return response.data;
      }
    }
  },
  
  triggers: {
    dataCreated: {
      name: 'dataCreated',
      displayName: 'Data Created',
      description: 'Triggered when new data is created',
      type: 'webhook',
      
      webhookConfig: {
        path: '/webhooks/custom-api/data-created',
        method: 'POST',
        
        verifySignature: async (payload, signature, secret) => {
          const crypto = require('crypto');
          const hmac = crypto.createHmac('sha256', secret);
          hmac.update(JSON.stringify(payload));
          const expectedSignature = hmac.digest('hex');
          return signature === expectedSignature;
        }
      },
      
      schema: z.object({
        event: z.literal('data.created'),
        data: z.object({
          id: z.string(),
          name: z.string(),
          createdAt: z.string()
        })
      }),
      
      handler: async (payload) => {
        return {
          event: 'dataCreated',
          data: payload.data
        };
      }
    }
  },
  
  rateLimit: {
    requests: 100,
    window: 60000
  }
};

plug.registerProvider(customAPIProvider);
```

#### OAuth Provider

```typescript
export const customOAuthProvider: Provider = {
  name: 'custom-oauth',
  displayName: 'Custom OAuth Provider',
  version: '1.0.0',
  
  auth: {
    type: AuthType.OAuth2,
    config: {
      authorizationUrl: 'https://auth.custom.com/oauth/authorize',
      tokenUrl: 'https://auth.custom.com/oauth/token',
      scopes: ['read', 'write'],
      scopeSeparator: ' ',
      
      getAuthParams: (config) => ({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scopes.join(' '),
        state: config.state
      }),
      
      getTokenParams: (config, code) => ({
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri
      }),
      
      refreshToken: async (config, refreshToken) => {
        const response = await fetch(config.tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: config.clientId,
            client_secret: config.clientSecret
          })
        });
        return response.json();
      }
    }
  },
  
  baseUrl: 'https://api.custom.com/v1',
  
  actions: {
    // ... actions
  }
};
```

### 7. Integration with Other SuperFunctions

#### With AuthFn

```typescript
import { createAuthFn } from 'authfn';
import { plugFn } from 'plugfn';

const auth = createAuthFn({
  database: adapter,
  namespace: 'authfn'
});

const plug = plugFn({
  database: adapter,
  auth: auth.provider,
  integrations: { ... }
});

app.use('/api/auth', toExpress(auth.router));
app.use('/api/plugfn', toExpress(plug.router));
```

#### With CacheFn

```typescript
import { cacheFn } from 'cachefn';

const cache = cacheFn({
  name: 'plugfn-cache',
  storage: 'indexeddb'
});

const plug = plugFn({
  cache: {
    enabled: true,
    instance: cache,
    defaultTTL: 300000
  }
});

const cachedResult = await plug.github.repos.get({
  userId: 'user-123',
  params: { owner: 'org', repo: 'repo' },
  cache: { ttl: 600000 }
});
```

#### With SearchFn

```typescript
import { SearchFn } from 'searchfn';

const search = new SearchFn({
  name: 'integrations',
  fields: ['name', 'description', 'provider']
});

plug.on('connection.created', async (event) => {
  await search.add({
    id: event.connection.id,
    fields: {
      name: event.connection.provider,
      description: event.connection.metadata?.description || '',
      provider: event.connection.provider
    },
    store: {
      userId: event.connection.userId,
      connectedAt: event.connection.connectedAt
    }
  });
});

const results = await search.search('github');
```

#### With BotFn

```typescript
import { createDiscordBot } from 'botfn';

const bot = createDiscordBot({
  token: process.env.DISCORD_TOKEN,
  plugins: [
    {
      name: 'integrations',
      commands: [
        {
          name: 'connect',
          description: 'Connect an integration',
          execute: async (interaction) => {
            const provider = interaction.options.getString('provider');
            const authUrl = await plug.connections.getAuthUrl({
              userId: interaction.user.id,
              provider
            });
            await interaction.reply(`Connect here: ${authUrl}`);
          }
        },
        {
          name: 'github-issue',
          description: 'Create a GitHub issue',
          execute: async (interaction) => {
            const title = interaction.options.getString('title');
            const body = interaction.options.getString('body');
            
            const issue = await plug.github.issues.create({
              userId: interaction.user.id,
              params: {
                owner: 'myorg',
                repo: 'myrepo',
                title,
                body
              }
            });
            
            await interaction.reply(`Created: ${issue.html_url}`);
          }
        }
      ]
    }
  ]
});
```

### 8. Type Generation

#### Generate Types

```bash
npx plugfn generate-types --provider github --output ./types/github.ts

npx plugfn generate-types --all --output ./types
```

#### Use Generated Types

```typescript
import type { GitHubIssue, GitHubCreateIssueParams } from './types/github';

const params: GitHubCreateIssueParams = {
  owner: 'myorg',
  repo: 'myrepo',
  title: 'Bug report',
  body: 'Description',
  labels: ['bug']
};

const issue: GitHubIssue = await plug.github.issues.create({
  userId: 'user-123',
  params
});
```

### 9. Testing & Mocking

#### Mock Providers

```typescript
import { mockProvider, mockResponse } from 'plugfn/testing';

const mockGitHub = mockProvider('github', {
  'issues.create': mockResponse({
    id: 1,
    number: 123,
    title: 'Test issue',
    html_url: 'https://github.com/org/repo/issues/123'
  }),
  'issues.list': mockResponse([
    { id: 1, number: 123, title: 'Issue 1' },
    { id: 2, number: 124, title: 'Issue 2' }
  ])
});

const plug = plugFn({
  integrations: {
    github: mockGitHub
  }
});

const issue = await plug.github.issues.create({
  userId: 'test-user',
  params: { ... }
});

expect(issue.number).toBe(123);
```

#### Test Workflows

```typescript
import { testWorkflow } from 'plugfn/testing';

const workflow = plug.workflow('test-workflow')
  .trigger(plug.github.on('issues.opened'))
  .action(async (context) => {
    await plug.slack.postMessage({ ... });
  });

const result = await testWorkflow(workflow, {
  trigger: {
    provider: 'github',
    event: 'issues.opened',
    payload: {
      issue: { id: 1, title: 'Test issue' }
    }
  },
  mocks: {
    slack: mockProvider('slack', {
      'postMessage': mockResponse({ ok: true, ts: '1234567890.123456' })
    })
  }
});

expect(result.success).toBe(true);
```

### 10. Monitoring & Observability

#### Metrics

```typescript
const metrics = await plug.getMetrics({
  timeRange: 'last-24h',
  groupBy: 'provider'
});

console.log(`Total requests: ${metrics.totalRequests}`);
console.log(`Success rate: ${metrics.successRate}%`);
console.log(`Avg response time: ${metrics.avgResponseTime}ms`);

metrics.byProvider.forEach(provider => {
  console.log(`\n${provider.name}:`);
  console.log(`  Requests: ${provider.requests}`);
  console.log(`  Success: ${provider.successRate}%`);
  console.log(`  Avg time: ${provider.avgResponseTime}ms`);
  console.log(`  Rate limit hits: ${provider.rateLimitHits}`);
});
```

#### Event Logging

```typescript
plug.on('action.start', (event) => {
  console.log(`[${event.provider}] Starting ${event.action}`);
});

plug.on('action.success', (event) => {
  console.log(`[${event.provider}] ${event.action} succeeded in ${event.duration}ms`);
});

plug.on('action.error', (event) => {
  console.error(`[${event.provider}] ${event.action} failed:`, event.error);
  console.error(`  Retries: ${event.retries}`);
  console.error(`  Duration: ${event.duration}ms`);
});

plug.on('connection.created', (event) => {
  console.log(`User ${event.userId} connected ${event.provider}`);
});

plug.on('connection.expired', (event) => {
  console.warn(`Connection expired: ${event.provider} for user ${event.userId}`);
});

plug.on('webhook.received', (event) => {
  console.log(`Webhook: ${event.provider}.${event.event}`);
});

plug.on('rateLimit.hit', (event) => {
  console.warn(`Rate limit hit: ${event.provider}, retry after ${event.retryAfter}ms`);
});
```

#### Custom Logger

```typescript
const plug = plugFn({
  logger: {
    debug: (msg, meta) => logger.debug(msg, meta),
    info: (msg, meta) => logger.info(msg, meta),
    warn: (msg, meta) => logger.warn(msg, meta),
    error: (msg, meta) => logger.error(msg, meta)
  }
});
```

### 11. Dashboard UI

#### Mount Dashboard

```typescript
import { plugFnDashboard } from 'plugfn/dashboard';

app.use('/integrations', plugFnDashboard(plug, {
  auth: auth.provider,
  theme: {
    primaryColor: '#0066cc',
    logo: '/logo.png'
  },
  features: {
    connections: true,
    workflows: true,
    logs: true,
    metrics: true
  }
}));
```

#### Dashboard Features

- **Connection Management**: View, connect, disconnect integrations
- **Workflow Builder**: Visual workflow editor
- **Activity Logs**: View recent actions, webhooks, errors
- **Metrics Dashboard**: Charts and analytics
- **Provider Marketplace**: Browse and enable providers
- **API Keys**: Manage API keys for providers
- **Test Console**: Test actions interactively

## Provider Catalog

### Communication (8 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **Slack** | Send messages, create channels, invite users | Message posted, channel created | OAuth | Priority |
| **Discord** | Send messages, manage roles, create channels | Message, member joined | OAuth/Bot | Priority |
| **Telegram** | Send messages, create polls | Message received | Bot Token | Planned |
| **Email (SendGrid)** | Send email, manage templates | Email opened, clicked | API Key | Priority |
| **Email (Resend)** | Send email | Email delivered | API Key | Planned |
| **Email (Mailgun)** | Send email, manage lists | Email delivered | API Key | Planned |
| **Twilio** | Send SMS, make calls | SMS received, call ended | API Key | Planned |
| **WhatsApp Business** | Send messages | Message received | API Key | Future |

### Developer Tools (10 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **GitHub** | Issues, PRs, commits, releases | Issue opened, PR merged, push | OAuth/Token | Priority |
| **GitLab** | Issues, MRs, pipelines | Issue opened, pipeline | OAuth/Token | Planned |
| **Linear** | Issues, projects, comments | Issue created, updated | OAuth/API Key | Priority |
| **Jira** | Issues, boards, sprints | Issue created, updated | OAuth/API Key | Planned |
| **Sentry** | Errors, releases | Error occurred | API Key | Planned |
| **Vercel** | Deployments, projects | Deployment created | OAuth/Token | Planned |
| **Netlify** | Deployments, sites | Deploy started, succeeded | OAuth/Token | Planned |
| **CircleCI** | Workflows, jobs | Workflow completed | API Key | Future |
| **Travis CI** | Builds, jobs | Build completed | API Key | Future |
| **Jenkins** | Jobs, builds | Build completed | API Key/OAuth | Future |

### Productivity (12 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **Notion** | Pages, databases, blocks | Page created, updated | OAuth | Priority |
| **Google Calendar** | Events, calendars | Event created, updated | OAuth | Priority |
| **Google Drive** | Files, folders, sharing | File created, updated | OAuth | Planned |
| **Google Sheets** | Read, write, format | Row added, updated | OAuth | Planned |
| **Airtable** | Records, tables | Record created, updated | OAuth/API Key | Planned |
| **Trello** | Cards, boards, lists | Card created, moved | OAuth/API Key | Planned |
| **Asana** | Tasks, projects | Task created, completed | OAuth/Token | Planned |
| **ClickUp** | Tasks, lists, folders | Task created, updated | OAuth/API Key | Planned |
| **Monday.com** | Items, boards | Item created, updated | OAuth/API Key | Future |
| **Todoist** | Tasks, projects | Task created, completed | OAuth | Future |
| **Evernote** | Notes, notebooks | Note created, updated | OAuth | Future |
| **Dropbox** | Files, folders | File added, modified | OAuth | Future |

### Payment (5 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **Stripe** | Customers, subscriptions, payments | Payment succeeded, customer created | API Key | Priority |
| **PayPal** | Orders, payments | Payment captured | OAuth/API Key | Planned |
| **Lemon Squeezy** | Orders, subscriptions | Order created, subscription updated | API Key | Planned |
| **Paddle** | Transactions, subscriptions | Payment succeeded | API Key | Future |
| **Square** | Payments, customers | Payment created | OAuth | Future |

### Analytics (6 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **Google Analytics** | Events, reports | - | OAuth | Planned |
| **Mixpanel** | Events, profiles | - | API Key | Planned |
| **Amplitude** | Events, cohorts | - | API Key | Planned |
| **Segment** | Track, identify | - | API Key | Planned |
| **PostHog** | Events, feature flags | - | API Key | Future |
| **Plausible** | Pageviews, events | - | API Key | Future |

### AI/ML (8 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **OpenAI** | Chat, embeddings, images | - | API Key | Priority |
| **Anthropic** | Messages, completions | - | API Key | Priority |
| **Replicate** | Run models, predictions | Prediction completed | API Key | Planned |
| **HuggingFace** | Inference, models | - | API Key | Planned |
| **Stability AI** | Image generation | - | API Key | Planned |
| **ElevenLabs** | Text to speech | - | API Key | Planned |
| **AssemblyAI** | Transcription | - | API Key | Future |
| **Cohere** | Generate, embed | - | API Key | Future |

### CRM & Sales (6 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **HubSpot** | Contacts, deals, companies | Contact created, deal updated | OAuth | Planned |
| **Salesforce** | Leads, opportunities | Lead created, opportunity closed | OAuth | Planned |
| **Pipedrive** | Deals, contacts, activities | Deal added, updated | OAuth/API Key | Planned |
| **Intercom** | Conversations, users | Message sent, user created | OAuth/Token | Planned |
| **Zendesk** | Tickets, users | Ticket created, updated | OAuth/Token | Future |
| **Freshdesk** | Tickets, contacts | Ticket created, updated | API Key | Future |

### Database & Storage (8 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **Supabase** | Database, auth, storage | Database change | API Key | Planned |
| **Firebase** | Firestore, auth, storage | Document created, updated | OAuth/Key | Planned |
| **MongoDB Atlas** | Documents, collections | Document changed | API Key | Planned |
| **Redis Cloud** | Get, set, delete | - | API Key | Future |
| **Airtable** | Records, tables | Record created | OAuth | Planned |
| **Postgres** | Query, insert, update | - | Connection | Future |
| **MySQL** | Query, insert, update | - | Connection | Future |
| **Pinecone** | Vectors, queries | - | API Key | Future |

### Social Media (6 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **Twitter/X** | Post, retweet, like | Tweet posted, mentioned | OAuth | Planned |
| **LinkedIn** | Post, share | - | OAuth | Planned |
| **Facebook** | Post, comment | Post created | OAuth | Future |
| **Instagram** | Post, comment | Media published | OAuth | Future |
| **YouTube** | Upload, comment | Video published | OAuth | Future |
| **Reddit** | Post, comment | - | OAuth | Future |

### Cloud Services (6 providers)

| Provider | Actions | Triggers | Auth | Status |
|----------|---------|----------|------|--------|
| **AWS S3** | Upload, download, list | Object created | Access Key | Planned |
| **Cloudflare** | Workers, KV, R2 | - | API Key | Planned |
| **DigitalOcean** | Droplets, databases | - | API Token | Future |
| **Heroku** | Apps, dynos | Deploy | OAuth/API Key | Future |
| **Fly.io** | Apps, machines | - | API Token | Future |
| **Railway** | Projects, deployments | - | API Key | Future |

**Total: 75+ providers planned**

## Database Schema

### Tables

#### connections

Stores user integration connections:

```sql
CREATE TABLE plugfn_connections (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  provider VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  status VARCHAR(50) NOT NULL,
  credentials_encrypted TEXT NOT NULL,
  scopes JSON,
  metadata JSON,
  expires_at TIMESTAMP,
  connected_at TIMESTAMP NOT NULL,
  last_used_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_user_provider (user_id, provider),
  INDEX idx_status (status),
  INDEX idx_expires_at (expires_at)
);
```

#### webhooks

Stores webhook configurations:

```sql
CREATE TABLE plugfn_webhooks (
  id VARCHAR(255) PRIMARY KEY,
  provider VARCHAR(255) NOT NULL,
  connection_id VARCHAR(255),
  events JSON NOT NULL,
  webhook_url VARCHAR(500) NOT NULL,
  secret_encrypted TEXT NOT NULL,
  status VARCHAR(50) NOT NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_provider (provider),
  INDEX idx_connection (connection_id),
  FOREIGN KEY (connection_id) REFERENCES plugfn_connections(id) ON DELETE CASCADE
);
```

#### workflows

Stores workflow definitions:

```sql
CREATE TABLE plugfn_workflows (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  definition JSON NOT NULL,
  status VARCHAR(50) NOT NULL,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_user (user_id),
  INDEX idx_status (status)
);
```

#### workflow_executions

Stores workflow execution history:

```sql
CREATE TABLE plugfn_workflow_executions (
  id VARCHAR(255) PRIMARY KEY,
  workflow_id VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,
  input JSON,
  output JSON,
  error TEXT,
  duration_ms INTEGER,
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP,
  
  INDEX idx_workflow (workflow_id),
  INDEX idx_status (status),
  INDEX idx_started_at (started_at),
  FOREIGN KEY (workflow_id) REFERENCES plugfn_workflows(id) ON DELETE CASCADE
);
```

#### action_logs

Stores action execution logs:

```sql
CREATE TABLE plugfn_action_logs (
  id VARCHAR(255) PRIMARY KEY,
  user_id VARCHAR(255),
  connection_id VARCHAR(255),
  provider VARCHAR(255) NOT NULL,
  action VARCHAR(255) NOT NULL,
  status VARCHAR(50) NOT NULL,
  request JSON,
  response JSON,
  error TEXT,
  duration_ms INTEGER,
  retries INTEGER DEFAULT 0,
  cached BOOLEAN DEFAULT FALSE,
  executed_at TIMESTAMP NOT NULL,
  
  INDEX idx_user (user_id),
  INDEX idx_provider_action (provider, action),
  INDEX idx_status (status),
  INDEX idx_executed_at (executed_at)
);
```

## API Reference

### Core API

```typescript
interface PlugFnConfig {
  database: Adapter;
  auth: AuthProvider;
  baseUrl: string;
  encryptionKey: string;
  integrations: Record<string, IntegrationConfig>;
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
  retry?: RetryConfig;
  logger?: Logger;
  webhooks?: WebhookConfig;
}

interface PlugFn {
  connections: ConnectionManager;
  workflows: WorkflowManager;
  webhooks: WebhookManager;
  providers: ProviderRegistry;
  
  [provider: string]: ProviderActions;
  
  batch(actions: BatchAction[]): Promise<BatchResult[]>;
  getMetrics(options: MetricsOptions): Promise<Metrics>;
  on(event: string, handler: EventHandler): void;
  off(event: string, handler: EventHandler): void;
}
```

### Connection Manager

```typescript
interface ConnectionManager {
  getAuthUrl(options: GetAuthUrlOptions): Promise<string>;
  handleCallback(options: HandleCallbackOptions): Promise<Connection>;
  list(options: ListConnectionsOptions): Promise<Connection[]>;
  get(id: string): Promise<Connection>;
  disconnect(options: DisconnectOptions): Promise<void>;
  refresh(id: string): Promise<Connection>;
}
```

### Workflow Manager

```typescript
interface WorkflowManager {
  list(options?: ListWorkflowsOptions): Promise<Workflow[]>;
  get(id: string): Promise<Workflow>;
  enable(id: string): Promise<void>;
  disable(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  getStats(id: string): Promise<WorkflowStats>;
}
```

### Provider Actions

```typescript
interface ProviderActions {
  [action: string]: (options: ActionOptions) => Promise<any>;
  on(event: string, handler: TriggerHandler): void;
}
```

## Performance Targets

- **Action execution**: <2s for most API calls
- **OAuth flow**: <5s total (user auth not included)
- **Webhook processing**: <500ms for verification and routing
- **Workflow execution**: <10s for multi-step workflows
- **Connection refresh**: <1s for token refresh
- **Type generation**: <5s per provider
- **Dashboard load**: <1s initial load
- **Cache hit rate**: >70% for repeated actions
- **Uptime**: 99.9% for webhook ingestion

## Security Considerations

### Token Storage

- All tokens encrypted at rest using AES-256
- Encryption key must be provided and stored securely
- Tokens decrypted only when needed for API calls
- Support for external key management (AWS KMS, etc.)

### OAuth Security

- State parameter validation (CSRF protection)
- Redirect URI validation
- PKCE support for public clients
- Token rotation for long-lived connections

### Webhook Security

- Signature verification for all webhooks
- Rate limiting per provider
- Request replay protection
- IP whitelist support

### General Security

- No secrets in logs or metrics
- API key masking in UI
- Role-based access control (RBAC)
- Audit logs for sensitive operations
- Connection expiry notifications

## Testing Strategy

### Unit Tests

- Provider actions
- Auth flows
- Webhook handlers
- Workflow engine
- Token encryption/decryption

### Integration Tests

- Full OAuth flow
- Action execution with real APIs (optional, using test accounts)
- Webhook delivery
- Workflow execution
- Connection management

### Mock Testing

- Mock providers for all tests
- Mock webhook events
- Mock OAuth responses
- Workflow testing utilities

### Load Testing

- Concurrent action execution
- Webhook burst handling
- Workflow scaling
- Database performance

## Documentation Requirements

### Getting Started

- Installation guide
- Quick start tutorial
- Basic concepts (connections, actions, triggers, workflows)
- Configuration guide

### Provider Guides

- Per-provider setup instructions
- OAuth configuration
- Available actions and triggers
- Code examples
- Rate limits and quotas

### Advanced Topics

- Custom provider development
- Workflow patterns
- Error handling strategies
- Performance optimization
- Security best practices

### API Reference

- Full TypeScript API docs
- Generated from JSDoc
- Interactive examples
- Type definitions

### Integration Guides

- Integration with authfn
- Integration with cachefn
- Integration with searchfn
- Integration with botfn
- Using with different frameworks

## Migration Path

### From Zapier

- Export Zaps as JSON
- Import and convert to workflows
- Provide mapping guide

### From Composio

- Similar API design for easy migration
- Connection migration tool
- Provider name mapping

### From Custom Integrations

- Provider template generator
- Migration helper utilities
- Compatibility layer

## Development Roadmap

### Phase 1 (Q1 2026) - Core Foundation

- Core SDK implementation
- Provider abstraction layer
- OAuth flow manager
- Action executor with retry
- Webhook handler
- Database schema
- 5 priority providers: GitHub, Slack, Discord, Linear, Stripe

### Phase 2 (Q2 2026) - Workflow Engine

- Workflow builder
- Trigger engine
- Sequential workflows
- Conditional logic
- Error handling
- 10 additional providers

### Phase 3 (Q3 2026) - Dashboard & Advanced Features

- Dashboard UI
- Connection management interface
- Workflow visual builder
- Metrics and analytics
- Type generator CLI
- Testing utilities
- 20 additional providers

### Phase 4 (Q4 2026) - Ecosystem & Scale

- AI agent integration (LangChain, etc.)
- Community provider marketplace
- Advanced workflow features (parallel, delays)
- Performance optimizations
- 40+ additional providers
- Enterprise features

## License

Apache-2.0

## Contributing

Contributions welcome! See CONTRIBUTING.md for guidelines.

### Adding a New Provider

1. Create provider directory in `src/providers/[provider-name]/`
2. Implement actions in `actions.ts`
3. Implement triggers in `triggers.ts` (if supported)
4. Define auth config in `auth.ts`
5. Add TypeScript types in `types.ts`
6. Add provider metadata in `spec.json`
7. Write tests
8. Add documentation
9. Submit PR

### Provider Template

```bash
npx plugfn create-provider --name custom-api --auth-type oauth
```

This generates a complete provider template with:
- Action boilerplate
- Trigger boilerplate
- Auth configuration
- TypeScript types
- Tests
- Documentation template
