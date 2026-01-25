import type { Secret, SecretAccess, Environment } from '../types/index.js';
import type { IndexedDBStorage } from '../storage/indexeddb-storage.js';
import { SecretEncryption } from './encryption.js';
import { generateId, isExpired } from '../utils/helpers.js';

export interface SecretsVaultConfig {
  storage: IndexedDBStorage;
  encryption: {
    algorithm: 'AES-256-GCM';
    masterKey: string;
    keyDerivation?: 'PBKDF2' | 'scrypt';
  };
  rotation?: {
    checkInterval: number;
    notifyBefore: number;
  };
}

export interface SetSecretOptions {
  tags?: string[];
  environment?: Environment;
  expiresAt?: number;
  rotateEvery?: number;
  createdBy?: string;
}

export class SecretsVault {
  private storage: IndexedDBStorage;
  private encryption: SecretEncryption;
  private masterKey: string;
  private rotationInterval?: NodeJS.Timeout;

  constructor(config: SecretsVaultConfig) {
    this.storage = config.storage;
    this.encryption = new SecretEncryption();
    this.masterKey = config.encryption.masterKey;

    if (config.rotation) {
      this.startRotationCheck(config.rotation.checkInterval, config.rotation.notifyBefore);
    }
  }

  async set(key: string, value: string, options: SetSecretOptions = {}): Promise<string> {
    const existing = await this.storage.getSecretByKey(key);
    const now = Date.now();

    const encryptedValue = await this.encryption.encrypt(value, this.masterKey);

    const secret: Secret = {
      id: existing?.id || generateId('secret'),
      key,
      value: encryptedValue,
      encrypted: true,
      version: existing ? existing.version + 1 : 1,
      tags: options.tags || [],
      environment: options.environment,
      expiresAt: options.expiresAt,
      rotateEvery: options.rotateEvery,
      lastRotated: now,
      lastAccessed: undefined,
      accessCount: 0,
      createdBy: options.createdBy || 'system',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    await this.storage.saveSecret(secret);

    await this.logAccess(secret.id, options.createdBy || 'system', 'write');

    return secret.id;
  }

  async get(key: string, userId = 'system'): Promise<string | null> {
    const secret = await this.storage.getSecretByKey(key);
    
    if (!secret) return null;

    if (isExpired(secret.expiresAt)) {
      throw new Error(`Secret '${key}' has expired`);
    }

    const decryptedValue = await this.encryption.decrypt(secret.value, this.masterKey);

    secret.lastAccessed = Date.now();
    secret.accessCount += 1;
    await this.storage.saveSecret(secret);

    await this.logAccess(secret.id, userId, 'read');

    return decryptedValue;
  }

  async list(filter?: { environment?: Environment; tags?: string[] }): Promise<Array<Omit<Secret, 'value'>>> {
    const secrets = await this.storage.listSecrets(filter);
    
    return secrets.map(({ value, ...rest }) => rest);
  }

  async rotate(key: string, newValue: string, userId = 'system'): Promise<void> {
    const secret = await this.storage.getSecretByKey(key);
    
    if (!secret) {
      throw new Error(`Secret '${key}' not found`);
    }

    const encryptedValue = await this.encryption.encrypt(newValue, this.masterKey);

    secret.value = encryptedValue;
    secret.version += 1;
    secret.lastRotated = Date.now();
    secret.updatedAt = Date.now();

    await this.storage.saveSecret(secret);

    await this.logAccess(secret.id, userId, 'rotate');
  }

  async delete(key: string, userId = 'system'): Promise<void> {
    const secret = await this.storage.getSecretByKey(key);
    
    if (!secret) {
      throw new Error(`Secret '${key}' not found`);
    }

    await this.storage.deleteSecret(secret.id);

    await this.logAccess(secret.id, userId, 'delete');
  }

  async getAccessLog(key: string, limit = 100): Promise<SecretAccess[]> {
    const secret = await this.storage.getSecretByKey(key);
    
    if (!secret) {
      throw new Error(`Secret '${key}' not found`);
    }

    return await this.storage.getSecretAccessLog(secret.id, limit);
  }

  async getSecretsNeedingRotation(beforeMs: number = 7 * 24 * 60 * 60 * 1000): Promise<Secret[]> {
    const allSecrets = await this.storage.listSecrets();
    const now = Date.now();
    const threshold = now + beforeMs;

    return allSecrets.filter(secret => {
      if (!secret.rotateEvery || !secret.lastRotated) return false;
      
      const nextRotation = secret.lastRotated + secret.rotateEvery;
      return nextRotation <= threshold;
    });
  }

  async getExpiredSecrets(): Promise<Secret[]> {
    const allSecrets = await this.storage.listSecrets();
    return allSecrets.filter(secret => isExpired(secret.expiresAt));
  }

  private async logAccess(secretId: string, userId: string, action: 'read' | 'write' | 'delete' | 'rotate'): Promise<void> {
    const accessLog: SecretAccess = {
      id: generateId('access'),
      secretId,
      userId,
      action,
      timestamp: Date.now(),
    };

    await this.storage.logSecretAccess(accessLog);
  }

  private startRotationCheck(interval: number, notifyBefore: number): void {
    this.rotationInterval = setInterval(async () => {
      const needsRotation = await this.getSecretsNeedingRotation(notifyBefore);
      
      if (needsRotation.length > 0) {
        console.warn(`[SecFn] ${needsRotation.length} secret(s) need rotation:`, 
          needsRotation.map(s => s.key));
      }
    }, interval);
  }

  stop(): void {
    if (this.rotationInterval) {
      clearInterval(this.rotationInterval);
    }
  }
}
