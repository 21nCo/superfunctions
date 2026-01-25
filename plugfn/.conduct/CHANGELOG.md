# Changelog

All notable changes to PlugFn will be documented in this file.

## [1.0.0] - 2026-01-12

### Added

#### Core Foundation
- **Type System**: Complete TypeScript definitions for all components
- **Authentication**: OAuth 2.0, API Key, JWT, and Basic Auth support
- **Storage Layer**: Connection, webhook, and workflow storage with encryption
- **Security**: AES-256-GCM encryption for credentials

#### Managers & Engines
- **ConnectionManager**: OAuth flows, token refresh, connection CRUD
- **ProviderRegistry**: Dynamic provider registration and discovery
- **ActionExecutor**: Type-safe execution with retry, caching, rate limiting
- **WorkflowEngine**: Sequential, parallel, and conditional workflows
- **WebhookHandler**: Event routing and signature verification

#### Middleware
- **Retry**: Automatic retry with exponential backoff
- **Rate Limiting**: Token bucket rate limiter per provider
- **Caching**: In-memory caching with TTL
- **Logging**: Comprehensive action and event logging
- **Metrics**: Performance metrics collection and aggregation

#### Providers (Priority)
- **GitHub**: Repository management, issues, pull requests
- **Slack**: Messaging, channels, user management
- **Discord**: Messaging, channels, roles
- **Linear**: Issue tracking, teams, workflows
- **Stripe**: Payment processing, customers, subscriptions

#### HTTP Integration
- **Router**: Unified HTTP request handler
- **Express Adapter**: Express.js integration
- **Hono Adapter**: Hono framework integration

#### Development Tools
- **CLI Tool**: Project initialization, type generation, provider scaffolding
- **Testing Utilities**: Mock providers, workflow testing, assertions
- **Examples**: Basic usage, complete workflow, Express server

### Architecture
- Self-hosted first design
- Multi-tenant support with per-user connections
- Framework-agnostic via @superfunctions/http adapters
- Type-safe API with Zod validation
- Observable with built-in logging and metrics

### Documentation
- Full specification (SPEC.md)
- Implementation guide (IMPLEMENTATION.md)
- README with quick start
- CLI documentation
- Code examples

### Security
- Token encryption at rest (AES-256-GCM)
- OAuth state validation (CSRF protection)
- Webhook signature verification
- Automatic token refresh
- Rate limiting protection

### Performance
- Response caching
- Connection pooling
- Batch action execution
- Efficient rate limiting
- Lazy provider loading

## [Unreleased]

### Planned Features
- Additional providers (70+ total)
- Dashboard UI for connection management
- Visual workflow builder
- Database adapters for major databases
- Advanced workflow features (delays, loops, conditions)
- AI agent integration (LangChain, etc.)
- Community provider marketplace
- Enterprise features

### Coming in Q2 2026
- 10 additional providers
- Improved workflow builder
- Better error handling
- Performance optimizations

### Coming in Q3 2026
- Dashboard UI
- Type generator improvements
- 20 additional providers
- Metrics dashboard

### Coming in Q4 2026
- 40+ additional providers
- AI agent integration
- Community marketplace
- Enterprise features

---

**Note**: Version 1.0.0 represents the completion of Phase 1 (Core Foundation) as outlined in the specification.

