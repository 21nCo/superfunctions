import { IndexedDBStorage } from '../storage/indexeddb-storage.js';
import { SecretsVault, type SecretsVaultConfig } from '../secrets/vault.js';
import { SecretScanner, type SecretScannerConfig } from '../scanning/scanner.js';
import { AccessControl, type AccessControlConfig } from '../access-control/rbac.js';
import { RateLimiter, type RateLimiterConfig } from '../rate-limiting/rate-limiter.js';
import { SecurityMonitor, type MonitoringConfig } from '../monitoring/security-monitor.js';
import type { StorageConfig } from '../types/index.js';

export interface SecFnConfig {
  storage?: StorageConfig;
  masterKey?: string;
  namespace?: string;
}

export class SecFn {
  private storage: IndexedDBStorage;
  private masterKey?: string;
  private initialized: boolean = false;

  constructor(config: SecFnConfig = {}) {
    const dbName = config.storage?.dbName || config.namespace || 'secfn';
    this.storage = new IndexedDBStorage(dbName);
    this.masterKey = config.masterKey;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.storage.initialize();
    this.initialized = true;
  }

  createSecretsVault(config?: Partial<Omit<SecretsVaultConfig, 'storage'>>): SecretsVault {
    if (!this.masterKey && !config?.encryption?.masterKey) {
      throw new Error('Master key is required for secrets vault');
    }

    return new SecretsVault({
      storage: this.storage,
      encryption: {
        algorithm: 'AES-256-GCM',
        masterKey: config?.encryption?.masterKey || this.masterKey!,
        ...config?.encryption,
      },
      rotation: config?.rotation,
    });
  }

  createSecretScanner(config?: Partial<Omit<SecretScannerConfig, 'storage'>>): SecretScanner {
    return new SecretScanner({
      ...config,
      storage: this.storage,
    });
  }

  createAccessControl(config?: Partial<Omit<AccessControlConfig, 'storage'>>): AccessControl {
    return new AccessControl({
      storage: this.storage,
      cache: config?.cache,
    });
  }

  createRateLimiter(config: Omit<RateLimiterConfig, 'storage'>): RateLimiter {
    return new RateLimiter({
      storage: this.storage,
      rules: config.rules,
      onLimitExceeded: config.onLimitExceeded,
    });
  }

  createMonitoring(config?: Partial<Omit<MonitoringConfig, 'storage'>>): SecurityMonitor {
    return new SecurityMonitor({
      storage: this.storage,
      retention: config?.retention,
      anomalyDetection: config?.anomalyDetection,
    });
  }

  async destroy(): Promise<void> {
    await this.storage.destroy();
    this.initialized = false;
  }

  getStorage(): IndexedDBStorage {
    return this.storage;
  }
}

export function createSecFn(config?: SecFnConfig): SecFn {
  return new SecFn(config);
}
