import type { TokenStore } from './types.js';

/**
 * In-memory token store implementation
 */
export class MemoryTokenStore implements TokenStore {
  private store = new Map<string, { value: string; expiresAt?: number }>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up expired tokens every minute
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    
    if (!item) {
      return null;
    }
    
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    
    return item.value;
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const expiresAt = ttl ? Date.now() + ttl : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, item] of this.store.entries()) {
      if (item.expiresAt && now > item.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

