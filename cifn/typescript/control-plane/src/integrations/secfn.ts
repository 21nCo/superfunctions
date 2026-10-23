import type { SecretsAdapter } from './types.js';
import type { AdapterConfig } from './config.js';

export class MemorySecretsAdapter implements SecretsAdapter {
  private secrets = new Map<string, string>();

  async getSecret(key: string): Promise<string | null> {
    return this.secrets.get(key) ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
  }

  async listKeys(): Promise<string[]> {
    return Array.from(this.secrets.keys());
  }

  async validateToken(token: string, expectedKey?: string): Promise<boolean> {
    if (expectedKey) {
      const storedToken = this.secrets.get(expectedKey);
      return storedToken === token;
    }

    for (const value of this.secrets.values()) {
      if (value === token) {
        return true;
      }
    }

    return false;
  }
}

export class SecFnSecretsAdapter implements SecretsAdapter {
  constructor(private config: { baseUrl: string; apiKey?: string; vaultPath?: string }) {}

  async getSecret(key: string): Promise<string | null> {
    const path = this.config.vaultPath ?? 'cifn';
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.config.baseUrl}/secrets/${path}/${key}`, {
      headers,
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`SecFn getSecret failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { value?: string };
    return result.value ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    const path = this.config.vaultPath ?? 'cifn';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.config.baseUrl}/secrets/${path}/${key}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ value }),
    });

    if (!response.ok) {
      throw new Error(`SecFn setSecret failed: ${response.status} ${response.statusText}`);
    }
  }

  async listKeys(): Promise<string[]> {
    const path = this.config.vaultPath ?? 'cifn';
    const headers: Record<string, string> = {};
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(`${this.config.baseUrl}/secrets/${path}`, {
      headers,
    });

    if (!response.ok) {
      throw new Error(`SecFn listKeys failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { keys?: string[] };
    return result.keys ?? [];
  }

  async validateToken(token: string, expectedKey?: string): Promise<boolean> {
    if (expectedKey) {
      const storedToken = await this.getSecret(expectedKey);
      return storedToken === token;
    }

    const keys = await this.listKeys();
    for (const key of keys) {
      const value = await this.getSecret(key);
      if (value === token) {
        return true;
      }
    }

    return false;
  }
}

export function createSecretsAdapter(config: AdapterConfig['secrets']): SecretsAdapter {
  if (config.type === 'memory') {
    return new MemorySecretsAdapter();
  }

  if (!config.secfnBaseUrl) {
    throw new Error('SecFn adapter requires baseUrl');
  }

  return new SecFnSecretsAdapter({
    baseUrl: config.secfnBaseUrl,
    apiKey: config.secfnApiKey,
    vaultPath: config.secfnVaultPath,
  });
}
