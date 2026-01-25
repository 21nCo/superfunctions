import { Adapter, WhereClause } from "@superfunctions/db";

export class ResponseCache {
  private tableName = "langfn_cache";

  constructor(
    private readonly db: Adapter,
    private readonly ttl: number = 3600
  ) {}

  private async generateKey(prompt: string, model: string, provider: string, metadata?: Record<string, any>): Promise<string> {
    const keyContent = `${provider}:${model}:${prompt}:${JSON.stringify(metadata || {})}`;
    const msgUint8 = new TextEncoder().encode(keyContent);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async get(prompt: string, model: string, provider: string, metadata?: Record<string, any>): Promise<any | null> {
    const key = await this.generateKey(prompt, model, provider, metadata);
    const where: WhereClause[] = [{ field: "key", operator: "eq", value: key }];
    const record = await this.db.findOne<any>({
      model: this.tableName,
      where
    });

    if (!record) return null;

    if (record.expiresAt < Math.floor(Date.now() / 1000)) {
      await this.db.delete({ model: this.tableName, where });
      return null;
    }

    return record.value;
  }

  async set(prompt: string, model: string, provider: string, value: any, metadata?: Record<string, any>): Promise<void> {
    const key = await this.generateKey(prompt, model, provider, metadata);
    const expiresAt = Math.floor(Date.now() / 1000) + this.ttl;
    const data = {
      key,
      value,
      expiresAt,
      createdAt: Math.floor(Date.now() / 1000)
    };

    await this.db.upsert({
      model: this.tableName,
      where: [{ field: "key", operator: "eq", value: key }],
      create: data,
      update: data
    });
  }
}
