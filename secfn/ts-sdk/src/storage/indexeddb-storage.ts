import type {
  Secret,
  SecretAccess,
  Role,
  UserRole,
  SecurityEvent,
  RateLimitEntry,
  SecretScanResult,
  EventQuery,
  SecurityMetrics,
  TimeRange,
} from '../types/index.js';

const DB_VERSION = 1;

const STORES = {
  secrets: 'secfn_secrets',
  secretAccess: 'secfn_secret_access',
  roles: 'secfn_roles',
  userRoles: 'secfn_user_roles',
  securityEvents: 'secfn_security_events',
  rateLimits: 'secfn_rate_limits',
  scanResults: 'secfn_scan_results',
  config: 'secfn_config',
} as const;

export class IndexedDBStorage {
  private db: IDBDatabase | null = null;
  private dbName: string;

  constructor(dbName = 'secfn') {
    this.dbName = dbName;
  }

  async initialize(): Promise<void> {
    if (this.db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains(STORES.secrets)) {
          const secretsStore = db.createObjectStore(STORES.secrets, { keyPath: 'id' });
          secretsStore.createIndex('key', 'key', { unique: true });
          secretsStore.createIndex('environment', 'environment');
          secretsStore.createIndex('expiresAt', 'expiresAt');
          secretsStore.createIndex('tags', 'tags', { multiEntry: true });
        }

        if (!db.objectStoreNames.contains(STORES.secretAccess)) {
          const accessStore = db.createObjectStore(STORES.secretAccess, { keyPath: 'id' });
          accessStore.createIndex('secretId', 'secretId');
          accessStore.createIndex('userId', 'userId');
          accessStore.createIndex('timestamp', 'timestamp');
        }

        if (!db.objectStoreNames.contains(STORES.roles)) {
          db.createObjectStore(STORES.roles, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(STORES.userRoles)) {
          const userRolesStore = db.createObjectStore(STORES.userRoles, { keyPath: ['userId', 'roleId'] });
          userRolesStore.createIndex('userId', 'userId');
          userRolesStore.createIndex('roleId', 'roleId');
        }

        if (!db.objectStoreNames.contains(STORES.securityEvents)) {
          const eventsStore = db.createObjectStore(STORES.securityEvents, { keyPath: 'id' });
          eventsStore.createIndex('timestamp', 'timestamp');
          eventsStore.createIndex('type', 'type');
          eventsStore.createIndex('severity', 'severity');
          eventsStore.createIndex('userId', 'userId');
          eventsStore.createIndex('ip', 'ip');
        }

        if (!db.objectStoreNames.contains(STORES.rateLimits)) {
          db.createObjectStore(STORES.rateLimits, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(STORES.scanResults)) {
          const scanStore = db.createObjectStore(STORES.scanResults, { keyPath: 'id' });
          scanStore.createIndex('timestamp', 'timestamp');
          scanStore.createIndex('severity', 'severity');
          scanStore.createIndex('file', 'file');
        }

        if (!db.objectStoreNames.contains(STORES.config)) {
          db.createObjectStore(STORES.config, { keyPath: 'key' });
        }
      };
    });
  }

  private getStore(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBObjectStore {
    if (!this.db) throw new Error('Database not initialized');
    const tx = this.db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  async saveSecret(secret: Secret): Promise<void> {
    const store = this.getStore(STORES.secrets, 'readwrite');
    await this.promisifyRequest(store.put(secret));
  }

  async getSecret(id: string): Promise<Secret | null> {
    const store = this.getStore(STORES.secrets);
    const result = await this.promisifyRequest<Secret>(store.get(id));
    return result || null;
  }

  async getSecretByKey(key: string): Promise<Secret | null> {
    const store = this.getStore(STORES.secrets);
    const index = store.index('key');
    const result = await this.promisifyRequest<Secret>(index.get(key));
    return result || null;
  }

  async listSecrets(filter?: { environment?: string; tags?: string[] }): Promise<Secret[]> {
    const store = this.getStore(STORES.secrets);
    const secrets = await this.promisifyRequest<Secret[]>(store.getAll());
    
    if (!filter) return secrets;
    
    return secrets.filter(secret => {
      if (filter.environment && secret.environment !== filter.environment) {
        return false;
      }
      if (filter.tags && !filter.tags.some(tag => secret.tags.includes(tag))) {
        return false;
      }
      return true;
    });
  }

  async deleteSecret(id: string): Promise<void> {
    const store = this.getStore(STORES.secrets, 'readwrite');
    await this.promisifyRequest(store.delete(id));
  }

  async logSecretAccess(access: SecretAccess): Promise<void> {
    const store = this.getStore(STORES.secretAccess, 'readwrite');
    await this.promisifyRequest(store.put(access));
  }

  async getSecretAccessLog(secretId: string, limit = 100): Promise<SecretAccess[]> {
    const store = this.getStore(STORES.secretAccess);
    const index = store.index('secretId');
    const allAccess = await this.promisifyRequest<SecretAccess[]>(index.getAll(secretId));
    return allAccess.slice(-limit);
  }

  async saveRole(role: Role): Promise<void> {
    const store = this.getStore(STORES.roles, 'readwrite');
    await this.promisifyRequest(store.put(role));
  }

  async getRole(id: string): Promise<Role | null> {
    const store = this.getStore(STORES.roles);
    const result = await this.promisifyRequest<Role>(store.get(id));
    return result || null;
  }

  async listRoles(): Promise<Role[]> {
    const store = this.getStore(STORES.roles);
    return await this.promisifyRequest<Role[]>(store.getAll());
  }

  async deleteRole(id: string): Promise<void> {
    const store = this.getStore(STORES.roles, 'readwrite');
    await this.promisifyRequest(store.delete(id));
  }

  async assignUserRole(userRole: UserRole): Promise<void> {
    const store = this.getStore(STORES.userRoles, 'readwrite');
    await this.promisifyRequest(store.put(userRole));
  }

  async getUserRoles(userId: string): Promise<UserRole[]> {
    const store = this.getStore(STORES.userRoles);
    const index = store.index('userId');
    return await this.promisifyRequest<UserRole[]>(index.getAll(userId));
  }

  async removeUserRole(userId: string, roleId: string): Promise<void> {
    const store = this.getStore(STORES.userRoles, 'readwrite');
    await this.promisifyRequest(store.delete([userId, roleId]));
  }

  async logSecurityEvent(event: SecurityEvent): Promise<void> {
    const store = this.getStore(STORES.securityEvents, 'readwrite');
    await this.promisifyRequest(store.put(event));
  }

  async queryEvents(query: EventQuery): Promise<SecurityEvent[]> {
    const store = this.getStore(STORES.securityEvents);
    let events = await this.promisifyRequest<SecurityEvent[]>(store.getAll());

    if (query.type) {
      const types = Array.isArray(query.type) ? query.type : [query.type];
      events = events.filter(e => types.includes(e.type));
    }

    if (query.severity) {
      const severities = Array.isArray(query.severity) ? query.severity : [query.severity];
      events = events.filter(e => severities.includes(e.severity));
    }

    if (query.userId) {
      events = events.filter(e => e.userId === query.userId);
    }

    if (query.ip) {
      events = events.filter(e => e.ip === query.ip);
    }

    if (query.startDate) {
      events = events.filter(e => e.timestamp >= query.startDate!);
    }

    if (query.endDate) {
      events = events.filter(e => e.timestamp <= query.endDate!);
    }

    if (query.resolved !== undefined) {
      events = events.filter(e => e.resolved === query.resolved);
    }

    events.sort((a, b) => b.timestamp - a.timestamp);

    if (query.offset) {
      events = events.slice(query.offset);
    }

    if (query.limit) {
      events = events.slice(0, query.limit);
    }

    return events;
  }

  async getMetrics(range: TimeRange): Promise<SecurityMetrics> {
    const events = await this.queryEvents({
      startDate: range.start,
      endDate: range.end,
    });

    const eventsByType: Record<string, number> = {};
    const eventsBySeverity: Record<string, number> = {};
    const ipCounts: Record<string, number> = {};
    const userCounts: Record<string, number> = {};

    for (const event of events) {
      eventsByType[event.type] = (eventsByType[event.type] || 0) + 1;
      eventsBySeverity[event.severity] = (eventsBySeverity[event.severity] || 0) + 1;
      ipCounts[event.ip] = (ipCounts[event.ip] || 0) + 1;
      if (event.userId) {
        userCounts[event.userId] = (userCounts[event.userId] || 0) + 1;
      }
    }

    const topIPs = Object.entries(ipCounts)
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const topUsers = Object.entries(userCounts)
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      timeRange: range,
      totalEvents: events.length,
      eventsByType,
      eventsBySeverity,
      topIPs,
      topUsers,
    };
  }

  async getRateLimitEntry(key: string): Promise<RateLimitEntry | null> {
    const store = this.getStore(STORES.rateLimits);
    const result = await this.promisifyRequest<RateLimitEntry>(store.get(key));
    return result || null;
  }

  async setRateLimitEntry(entry: RateLimitEntry): Promise<void> {
    const store = this.getStore(STORES.rateLimits, 'readwrite');
    await this.promisifyRequest(store.put(entry));
  }

  async deleteRateLimitEntry(key: string): Promise<void> {
    const store = this.getStore(STORES.rateLimits, 'readwrite');
    await this.promisifyRequest(store.delete(key));
  }

  async saveScanResult(result: SecretScanResult): Promise<void> {
    const store = this.getStore(STORES.scanResults, 'readwrite');
    await this.promisifyRequest(store.put(result));
  }

  async getScanHistory(limit = 100): Promise<SecretScanResult[]> {
    const store = this.getStore(STORES.scanResults);
    const results = await this.promisifyRequest<SecretScanResult[]>(store.getAll());
    return results.slice(-limit);
  }

  async cleanup(retentionMs: number): Promise<void> {
    const cutoffTime = Date.now() - retentionMs;

    const eventsStore = this.getStore(STORES.securityEvents, 'readwrite');
    const events = await this.promisifyRequest<SecurityEvent[]>(eventsStore.getAll());
    for (const event of events) {
      if (event.timestamp < cutoffTime) {
        await this.promisifyRequest(eventsStore.delete(event.id));
      }
    }

    const scanStore = this.getStore(STORES.scanResults, 'readwrite');
    const scans = await this.promisifyRequest<SecretScanResult[]>(scanStore.getAll());
    for (const scan of scans) {
      if (scan.timestamp < cutoffTime) {
        await this.promisifyRequest(scanStore.delete(scan.id));
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.dbName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
