# Getting Started with PlugFn

Welcome to PlugFn! This guide will help you get started with building integrations in your preferred language.

## Choose Your SDK

### TypeScript/JavaScript
Best for Node.js applications, Next.js, Express, and other JavaScript frameworks.

👉 [TypeScript Quick Start](../typescript/README.md)

### Python
Best for Python applications, FastAPI, Flask, and Django.

👉 [Python Quick Start](../python/README.md)

## Installation

### TypeScript
```bash
npm install @superfunctions/plugfn
```

### Python
```bash
pip install plugfn
```

## Core Concepts

### 1. Providers
Providers are pre-built integrations with external services (GitHub, Slack, Stripe, etc.).

### 2. Actions
Actions are operations you can perform with a provider (create issue, send message, etc.).

### 3. Triggers
Triggers are events from providers that your app can respond to (webhook events).

### 4. Connections
Connections store user authentication credentials for each provider (OAuth tokens, API keys).

### 5. Workflows
Workflows chain multiple actions together in response to triggers.

## Basic Flow

1. **Initialize PlugFn** with your configuration
2. **Register providers** you want to use
3. **Set up OAuth** for user connections
4. **Execute actions** on behalf of users
5. **Handle webhooks** for real-time events
6. **Build workflows** to automate tasks

## Example: Create a GitHub Issue

### TypeScript
```typescript
import { plugFn } from '@superfunctions/plugfn';
import { githubProvider } from '@superfunctions/plugfn/providers';

const plug = plugFn({
  database: adapter,
  auth: authProvider,
  baseUrl: 'https://myapp.com',
  encryptionKey: process.env.ENCRYPTION_KEY,
  integrations: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET
    }
  }
});

plug.providers.register(githubProvider);

const issue = await plug.github['issues.create']({
  userId: 'user-123',
  params: {
    owner: 'myorg',
    repo: 'myrepo',
    title: 'Bug report'
  }
});
```

### Python
```python
from plugfn import PlugFn
from plugfn.providers import github_provider

plug = PlugFn(
    database=adapter,
    auth=auth_provider,
    base_url="https://myapp.com",
    encryption_key=os.getenv("ENCRYPTION_KEY"),
    integrations={
        "github": {
            "client_id": os.getenv("GITHUB_CLIENT_ID"),
            "client_secret": os.getenv("GITHUB_CLIENT_SECRET")
        }
    }
)

plug.providers.register(github_provider)

issue = await plug.github.issues.create(
    user_id="user-123",
    params={
        "owner": "myorg",
        "repo": "myrepo",
        "title": "Bug report"
    }
)
```

## Next Steps

1. **Choose your SDK** and follow the language-specific guide
2. **Configure providers** with your API credentials
3. **Set up OAuth** for user authentication
4. **Build your first integration**
5. **Explore examples** in the examples/ directory

## Resources

- [Provider Guides](./providers/) - Setup guides for each provider
- [API Reference](./api-reference/) - Complete API documentation
- [Examples](./examples/) - Code examples and tutorials
- [Specification](../SPEC.md) - Full technical specification

## Need Help?

- **Documentation**: https://docs.superfunctions.dev/plugfn
- **Discord**: https://discord.gg/superfunctions
- **GitHub Issues**: https://github.com/superfunctions/superfunctions/issues
- **Email**: support@superfunctions.dev

