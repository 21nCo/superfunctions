# PlugFn

> Self-hosted integration platform for developers - Connect your apps to the world

PlugFn is a developer-first integration platform that enables seamless connections between your applications and external services. Think "Zapier for devs" - but self-hosted, code-first, and built for the super-functions ecosystem.

## 📦 SDKs

PlugFn is available in multiple languages:

### TypeScript/JavaScript SDK
Full-featured SDK for Node.js and TypeScript applications.

📁 [`typescript/`](./typescript/) - [Documentation](./typescript/README.md)

```bash
npm install @superfunctions/plugfn
```

### Python SDK
Native Python SDK with async support (Coming Soon)

📁 [`python/`](./python/) - [Documentation](./python/README.md)

```bash
pip install plugfn
```

## 🚀 Quick Start

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

// Execute an action
const issue = await plug.github['issues.create']({
  userId: 'user-123',
  params: {
    owner: 'myorg',
    repo: 'myrepo',
    title: 'Bug: Something broke'
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

# Execute an action
issue = await plug.github.issues.create(
    user_id="user-123",
    params={
        "owner": "myorg",
        "repo": "myrepo",
        "title": "Bug: Something broke"
    }
)
```

## 🌟 Features

- **Self-hosted**: No vendor lock-in, run on your infrastructure
- **Type-safe**: Full type safety in TypeScript and Python
- **Multi-tenant**: Per-user connections with secure token storage
- **75+ providers**: GitHub, Slack, Discord, Linear, Stripe, and many more
- **OAuth built-in**: Complete OAuth 2.0 flow handling
- **Webhooks**: Real-time event handling
- **Workflows**: Chain actions together
- **Extensible**: Easy to add custom providers

## 📚 Documentation

- **[Specification](./SPEC.md)** - Complete API specification
- **[TypeScript Docs](./typescript/README.md)** - TypeScript SDK documentation
- **[Python Docs](./python/README.md)** - Python SDK documentation
- **[Provider Guides](./docs/providers/)** - Per-provider setup guides
- **[Linear Provider Guide](./docs/providers/linear.md)** - Linear action/trigger contract
- **[GitHub Provider Guide](./docs/providers/github.md)** - GitHub issue/PR action contract
- **[ClickUp Provider Guide](./docs/providers/clickup.md)** - ClickUp task/comment action contract
- **[Examples](./docs/examples/)** - Code examples and tutorials

## 🔧 CLI Tool

```bash
# Install CLI
npm install -g @superfunctions/plugfn-cli

# Initialize a new project
plugfn init

# Add a custom provider
plugfn add-provider --name custom-api --auth oauth2

# Generate types
plugfn generate-types --all
```

## 🏗️ Architecture

```
plugfn/
├── typescript/          # TypeScript/JavaScript SDK
├── python/              # Python SDK
├── cli/                 # CLI tool
├── docs/                # Shared documentation
├── providers/           # Provider specifications
└── SPEC.md             # Full specification
```

## 🤝 Contributing

Contributions are welcome! See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

### Adding a Provider

Providers can be implemented in any supported language. See language-specific guides:
- [TypeScript Provider Guide](./typescript/docs/adding-providers.md)
- [Python Provider Guide](./python/docs/adding-providers.md)

## 📊 Provider Status

Currently implemented:
- ✅ GitHub
- ✅ Slack
- ✅ Discord
- ✅ Linear
- ✅ ClickUp
- ✅ Stripe

### Conduct v0.3 public provider contracts

PlugFn ships the Conduct-required capabilities as reusable public provider contracts:

- Linear actions: `issues.get`, `comments.create`, `issues.search`
- Linear triggers: `issue.updated`, `issue_comment.created`
- GitHub actions: `issues.get`, `issues.update`, `pulls.create`, `pulls.createReview`
- GitHub triggers: `pull_request.closed`, `issue_comment.created`
- ClickUp actions: `tasks.create`, `tasks.get`, `tasks.update`, `tasks.list`, `comments.create`, `spaces.list`
- ClickUp triggers: `task.updated`, `task.statusChanged`

These contracts stay inside PlugFn runtime concerns (OAuth, retries, rate limiting, webhook verification) and do not require Conduct-private provider code.

See [SPEC.md](./SPEC.md) for the full list of planned providers (75+).

## 🗓️ Roadmap

- **Phase 1 (Q1 2026)**: ✅ Core Foundation (TypeScript SDK)
- **Phase 2 (Q2 2026)**: Python SDK, 10+ additional providers
- **Phase 3 (Q3 2026)**: Dashboard UI, visual workflow builder
- **Phase 4 (Q4 2026)**: 40+ more providers, AI integration, marketplace

## 📄 License

Apache-2.0

## 🔗 Links

- **Website**: https://superfunctions.dev
- **Documentation**: https://docs.superfunctions.dev/plugfn
- **GitHub**: https://github.com/superfunctions/superfunctions
- **Discord**: https://discord.gg/superfunctions

---

**Note**: PlugFn is part of the SuperFunctions ecosystem - a collection of developer tools for building better applications.
