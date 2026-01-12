# SecFn

> Comprehensive self-hosted security platform for developers

SecFn is a developer-first security solution that combines vulnerability scanning, access control, secrets management, and security monitoring into a single self-hosted platform.

## Features

- 🔐 **Secrets Vault** - AES-256-GCM encrypted secret storage with rotation and access logging
- 🔍 **Secret Scanning** - Pattern-based detection of 20+ secret types in code and git history
- 🛡️ **Access Control** - Role-based permissions (RBAC) with caching and inheritance
- ⏱️ **Rate Limiting** - Token bucket algorithm with multi-level limits
- 📊 **Security Monitoring** - Event logging, metrics, and anomaly detection
- 🗄️ **Self-Hosted** - IndexedDB storage, no external dependencies
- 🚀 **Developer-Friendly** - Simple API, TypeScript support, works locally

## Installation

```bash
npm install secfn
```

## Quick Start

```typescript
import { createSecFn } from 'secfn';

const secFn = createSecFn({
  namespace: 'my-app',
  masterKey: process.env.MASTER_KEY,
});

await secFn.initialize();

const vault = secFn.createSecretsVault();
await vault.set('api_key', 'secret-value', {
  tags: ['production'],
  environment: 'production',
});

const secret = await vault.get('api_key');
console.log('Retrieved:', secret);

await secFn.destroy();
```

## Core Components

### 1. Secrets Vault

Encrypted storage and management of application secrets.

```typescript
const vault = secFn.createSecretsVault();

await vault.set('stripe_api_key', 'sk_live_...', {
  tags: ['payment', 'production'],
  environment: 'production',
  expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
  rotateEvery: 90 * 24 * 60 * 60 * 1000,
});

const key = await vault.get('stripe_api_key');

const secrets = await vault.list({ environment: 'production' });

await vault.rotate('stripe_api_key', 'sk_live_new...');

const accessLog = await vault.getAccessLog('stripe_api_key', 100);
```

### 2. Secret Scanner

Detect hardcoded secrets in source code with 20+ built-in patterns.

```typescript
const scanner = secFn.createSecretScanner({
  excludePaths: ['node_modules/**', 'dist/**'],
  minEntropy: 3.5,
});

const results = await scanner.scanDirectory('./src');

results.forEach(result => {
  console.log(`${result.severity}: ${result.pattern} in ${result.file}:${result.line}`);
  console.log(`  Match: ${result.redactedMatch}`);
});

const gitResults = await scanner.scanGitHistory({
  branch: 'main',
  commits: 100,
});

scanner.addPattern({
  name: 'Custom Secret',
  pattern: /custom_secret_[a-zA-Z0-9]{32}/g,
  entropy: 4.0,
  description: 'Custom application secret',
  severity: 'high',
});
```

**Built-in Secret Patterns:**
- AWS Access Keys, Secret Keys
- GitHub Tokens
- Stripe API Keys
- OpenAI & Anthropic API Keys
- Google API Keys
- Slack Tokens
- NPM Tokens
- JWT Tokens
- Database Connection Strings
- Private Keys (RSA, OpenSSH, DSA, EC, PGP)
- And many more...

### 3. Access Control (RBAC)

Fine-grained role-based access control with permission caching.

```typescript
const access = secFn.createAccessControl();

await access.createRole({
  name: 'editor',
  description: 'Can edit projects and files',
  permissions: ['project:read', 'project:write', 'file:read', 'file:write'],
});

await access.createRole({
  name: 'admin',
  description: 'Full system access',
  permissions: ['*:*'],
});

await access.assignRole('user_123', 'editor', {
  resourceIds: ['project_abc', 'project_def'],
});

const allowed = await access.check({
  userId: 'user_123',
  action: 'project:write',
  resourceId: 'project_abc',
});

const permissions = await access.getUserPermissions('user_123');
```

### 4. Rate Limiting

Protect against brute force and API abuse with token bucket algorithm.

```typescript
const limiter = secFn.createRateLimiter({
  rules: {
    global: { requests: 1000, window: 60000 },
    perUser: { requests: 100, window: 60000 },
    perIP: { requests: 50, window: 60000, blockDuration: 300000 },
    perEndpoint: {
      '/api/login': { requests: 5, window: 300000 },
      '/api/search': { requests: 100, window: 60000 },
    },
  },
  onLimitExceeded: async (violation) => {
    console.warn(`Rate limit exceeded for ${violation.ip}`);
  },
});

const result = await limiter.check({
  userId: 'user_123',
  ip: '192.168.1.1',
  endpoint: '/api/search',
});

if (!result.allowed) {
  throw new Error(`Rate limit exceeded. Retry after ${result.retryAfter}ms`);
}

await limiter.resetUser('user_123');
await limiter.unblock('ip:192.168.1.1');
```

### 5. Security Monitoring

Comprehensive event logging with metrics and anomaly detection.

```typescript
const monitoring = secFn.createMonitoring({
  retention: 90 * 24 * 60 * 60 * 1000,
  anomalyDetection: {
    enabled: true,
    sensitivity: 0.8,
  },
});

await monitoring.logEvent({
  type: 'auth_failure',
  severity: 'medium',
  userId: 'user_123',
  ip: '192.168.1.1',
  resource: '/api/login',
  action: 'login',
  metadata: {
    reason: 'invalid_password',
    attemptCount: 3,
  },
});

const events = await monitoring.queryEvents({
  type: 'auth_failure',
  severity: ['high', 'critical'],
  startDate: Date.now() - 24 * 60 * 60 * 1000,
});

const metrics = await monitoring.getMetrics({
  start: Date.now() - 7 * 24 * 60 * 60 * 1000,
  end: Date.now(),
});

console.log('Total events:', metrics.totalEvents);
console.log('Events by type:', metrics.eventsByType);
console.log('Anomalies:', metrics.anomalies);

await monitoring.resolveEvent('event_123', {
  resolvedBy: 'admin_456',
  notes: 'False positive',
});
```

## Storage

SecFn uses IndexedDB for browser/local storage with no external dependencies.

```typescript
const secFn = createSecFn({
  storage: {
    type: 'indexeddb',
    dbName: 'my-app-security',
    retentionDays: 90,
  },
});
```

**Storage Schema:**
- `secfn_secrets` - Encrypted secrets
- `secfn_secret_access` - Access logs
- `secfn_roles` - Role definitions
- `secfn_user_roles` - User-role assignments
- `secfn_security_events` - Security events
- `secfn_rate_limits` - Rate limit tracking
- `secfn_scan_results` - Secret scan results

## Performance

**V0 Benchmarks:**
- Scan 10,000 files for secrets: <10s
- Rate limit check: <5ms
- Access control check: <10ms (with cache)
- Log 1,000 security events: <500ms
- Query 10,000 events: <100ms
- Encrypt/decrypt secret: <10ms

## Examples

See `examples/basic-usage.ts` for a comprehensive demonstration of all features.

```bash
npm run build
node dist/examples/basic-usage.js
```

## Development

```bash
npm install

npm run build

npm run build:watch

npm test

npm run test:watch

npm run test:coverage

npm run typecheck

npm run lint
```

## Architecture

```
secfn/
├── storage/           # IndexedDB persistence
├── secrets/           # Vault & encryption
├── scanning/          # Secret detection
├── access-control/    # RBAC system
├── rate-limiting/     # Request throttling
├── monitoring/        # Event logging
└── core/              # Main orchestrator
```

## Security Best Practices

1. **Master Key**: Always use a strong, randomly generated master key in production
2. **Rotation**: Enable automatic secret rotation for sensitive credentials
3. **Monitoring**: Review security events and anomalies regularly
4. **Access Control**: Apply principle of least privilege
5. **Rate Limiting**: Configure appropriate limits for your use case
6. **Scanning**: Integrate secret scanning into your CI/CD pipeline

## Roadmap

- [ ] File system storage backend
- [ ] Database adapter support (@superfunctions/db)
- [ ] Vulnerability scanning (SQL injection, XSS, etc.)
- [ ] Security middleware for Express/Hono/Fastify
- [ ] HTML security dashboard
- [ ] CLI tools
- [ ] Real-time alert notifications
- [ ] Advanced anomaly detection with ML

## License

MIT

## Contributing

Contributions welcome! This is part of the super-functions ecosystem.

## Support

For issues and questions, please open an issue on GitHub.
