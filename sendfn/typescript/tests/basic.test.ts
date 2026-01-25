import { describe, it, expect, beforeEach } from 'vitest';
import { sendfn, SendfnConfig, awsSesAdapter, consoleSmsAdapter } from '../src';
import { Adapter } from '@superfunctions/db';

// Simple Mock Adapter implementation
class MockAdapter implements Adapter {
  private store = new Map<string, any[]>();

  async create(params: any): Promise<any> {
    const table = this.store.get(params.model) || [];
    const item = { ...params.data }; 
    table.push(item);
    this.store.set(params.model, table);
    return item;
  }

  async update(params: any): Promise<any> {
     const table = this.store.get(params.model) || [];
     // Assumes where clause is simple ID check for this mock
     // In Sendfn we use where: [{ field: 'id', operator: 'eq', value: id }]
     if (params.where && params.where.length > 0) {
         const id = params.where[0].value;
         const index = table.findIndex(i => i.id === id);
         if (index !== -1) {
             table[index] = { ...table[index], ...params.data };
             this.store.set(params.model, table);
             return table[index];
         }
     }
     return params.data;
  }

  async delete(params: any): Promise<any> {
      return true;
  }

  async findOne(params: any): Promise<any> {
      const table = this.store.get(params.model) || [];
      if (params.where && params.where.length > 0) {
          const w = params.where[0];
          return table.find(i => i[w.field] === w.value) || null;
      }
      return null;
  }

  async findMany(params: any): Promise<any[]> {
      const table = this.store.get(params.model) || [];
       if (params.where && params.where.length > 0) {
          return table.filter(item => {
              return params.where.every((w: any) => item[w.field] === w.value);
          });
      }
      return table;
  }
  
  async count(params: any): Promise<number> { return 0; }
  async createMany(params: any): Promise<any[]> { return []; }
  async updateMany(params: any): Promise<any> { return {}; }
  async deleteMany(params: any): Promise<any> { return {}; }
  async upsert(params: any): Promise<any> { return {}; }
  async query(query: string, params?: any[]): Promise<any> { return []; }
  async transaction(fn: any): Promise<any> { return fn(this); }
  async $disconnect(): Promise<void> {}
  async $connect(): Promise<void> {}
  async health(): Promise<any> { return { status: 'ok' }; }
  
  implementation = 'mock';
  capabilities = {} as any;
}

describe('Sendfn SDK Basic Test', () => {
  let client: ReturnType<typeof sendfn>;
  let mockAdapter: MockAdapter;

  beforeEach(() => {
    mockAdapter = new MockAdapter();
    const config: SendfnConfig = {
      database: mockAdapter,
      // Use adapter pattern
      emailProvider: awsSesAdapter({
          accessKeyId: 'fake',
          secretAccessKey: 'fake',
          region: 'us-east-1'
      }),
      email: {
        fromEmail: 'test@example.com'
      },
      smsProvider: consoleSmsAdapter(),
      options: {
        suppressionEnabled: true,
      }
    };
    client = sendfn(config);
  });

  it('should initialize correctly', () => {
    expect(client).toBeDefined();
  });

  it('should allow device registration', async () => {
    const token = await client.registerDevice({
      userId: 'user-1',
      token: 'token-123',
      platform: 'android',
    });

    expect(token).toBeDefined();
    expect(token.userId).toBe('user-1');
  });

  it('should check suppression list', async () => {
    await client.addToSuppressionList({
        email: 'bounced@example.com',
        reason: 'bounce',
        source: 'manual',
        bounceType: 'Permanent',
        suppressedAt: new Date()
    });

    const result = await client.checkSuppressionList('bounced@example.com');
    expect(result.suppressed).toBe(true);
  });
  
  it('should allow sending sms via console adapter', async () => {
      const res = await client.sms({
          userId: 'user-1',
          to: '+1234567890',
          message: 'Hello World'
      });
      
      expect(res).toBeDefined();
      expect(res.status).toBe('sent');
      expect(res.provider).toBe('console-sms');
  });
});
