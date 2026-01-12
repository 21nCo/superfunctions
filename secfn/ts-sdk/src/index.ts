export { SecFn, createSecFn, type SecFnConfig } from './core/secfn.js';

export { SecretsVault, type SecretsVaultConfig, type SetSecretOptions } from './secrets/vault.js';
export { SecretEncryption } from './secrets/encryption.js';

export { SecretScanner, type SecretScannerConfig, type ScanOptions, type GitScanOptions } from './scanning/scanner.js';
export { DEFAULT_PATTERNS } from './scanning/patterns.js';

export { AccessControl, type AccessControlConfig, type CreateRoleOptions, type AssignRoleOptions } from './access-control/rbac.js';

export { RateLimiter, type RateLimiterConfig, type RateLimitCheckRequest } from './rate-limiting/rate-limiter.js';

export { SecurityMonitor, type MonitoringConfig, type LogEventOptions, type ResolveEventOptions } from './monitoring/security-monitor.js';

export { IndexedDBStorage } from './storage/indexeddb-storage.js';

export * from './types/index.js';

export {
  generateId,
  calculateEntropy,
  redactSecret,
  isExpired,
  delay,
  sanitizeForLog,
  parseTimeWindow,
} from './utils/helpers.js';
