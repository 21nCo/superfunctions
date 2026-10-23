export interface SecFnClient {
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  listKeys(): Promise<string[]>;
}

export class MemorySecFnClient implements SecFnClient {
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
}
