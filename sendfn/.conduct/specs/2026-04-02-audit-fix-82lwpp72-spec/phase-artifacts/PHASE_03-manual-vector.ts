import { sendfn } from '../../../../sendfn/typescript/src/sendfn';
import { SendfnDb } from '../../../../sendfn/typescript/src/database/sendfn-db';

class MockAdapter {
  id = 'manual-mock';
  name = 'Manual Mock Adapter';
  version = '0.1.0';
  capabilities = {} as any;
  internal = {} as any;

  private store = new Map<string, any[]>();

  private getTable(model: string): any[] {
    const table = this.store.get(model);
    if (table) {
      return table;
    }

    const nextTable: any[] = [];
    this.store.set(model, nextTable);
    return nextTable;
  }

  private matches(item: any, where: any[] = []): boolean {
    return where.every((clause) => {
      const value = item[clause.field];
      switch (clause.operator) {
        case 'eq':
          return value === clause.value;
        case 'lt':
          return value < clause.value;
        case 'lte':
          return value <= clause.value;
        case 'gt':
          return value > clause.value;
        case 'gte':
          return value >= clause.value;
        case 'in':
          return Array.isArray(clause.value) && clause.value.includes(value);
        default:
          return false;
      }
    });
  }

  async create<T = any>(params: any): Promise<T> {
    const table = this.getTable(params.model);
    const item = { ...params.data };
    table.push(item);
    return item;
  }

  async findOne<T = any>(params: any): Promise<T | null> {
    return (await this.findMany<T>({ ...params, limit: 1 }))[0] ?? null;
  }

  async findMany<T = any>(params: any): Promise<T[]> {
    const rows = [...this.getTable(params.model)].filter((item) => this.matches(item, params.where));
    if (params.orderBy) {
      for (const order of [...params.orderBy].reverse()) {
        const direction = order.direction === 'desc' ? -1 : 1;
        rows.sort((left, right) => {
          if (left[order.field] === right[order.field]) {
            return 0;
          }

          return left[order.field] > right[order.field] ? direction : -direction;
        });
      }
    }

    const offset = params.offset ?? 0;
    const limit = params.limit ?? rows.length;
    return rows.slice(offset, offset + limit);
  }

  async update<T = any>(params: any): Promise<T> {
    const row = this.getTable(params.model).find((item) => this.matches(item, params.where));
    if (!row) {
      throw new Error('Record not found');
    }

    Object.assign(row, params.data);
    return row;
  }

  async delete(params: any): Promise<void> {
    this.store.set(
      params.model,
      this.getTable(params.model).filter((item) => !this.matches(item, params.where))
    );
  }

  async createMany<T = any>(params: any): Promise<T[]> {
    return Promise.all(params.data.map((data: any) => this.create({ ...params, data })));
  }

  async updateMany(): Promise<number> {
    return 0;
  }

  async deleteMany(): Promise<number> {
    return 0;
  }

  async upsert<T = any>(params: any): Promise<T> {
    const existing = await this.findOne(params);
    return existing
      ? this.update({ model: params.model, where: params.where, data: params.update })
      : this.create({ model: params.model, data: params.create });
  }

  async count(params: any): Promise<number> {
    return (await this.findMany(params)).length;
  }

  async transaction<R>(callback: (trx: this) => Promise<R>): Promise<R> {
    return callback(this);
  }

  async initialize(): Promise<void> {}
  async isHealthy(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}
  async getSchemaVersion(): Promise<number> {
    return 0;
  }
  async setSchemaVersion(): Promise<void> {}
  async validateSchema(): Promise<{ valid: true }> {
    return { valid: true };
  }
}

async function main(): Promise<void> {
  const adapter = new MockAdapter();
  const db = new SendfnDb(adapter as any);
  const client = sendfn({ database: adapter as any });

  await adapter.create({
    model: 'email_transactions',
    data: {
      id: 'tx-1',
      userId: 'user-123',
      to: 'user@example.com',
      from: 'noreply@example.com',
      subject: 'Hello',
      templateId: null,
      templateData: null,
      provider: 'aws-ses',
      providerMessageId: 'ses-123',
      status: 'sent',
      sentAt: new Date('2026-04-01T00:00:00Z'),
      deliveredAt: null,
      bouncedAt: null,
      complainedAt: null,
      metadata: {},
      createdAt: new Date('2026-04-01T00:00:00Z'),
      updatedAt: new Date('2026-04-01T00:00:00Z'),
    },
  });

  await adapter.create({
    model: 'communication_events',
    data: {
      id: 'evt-1',
      referenceId: 'tx-1',
      referenceType: 'email',
      eventType: 'delivered',
      provider: 'aws-ses',
      providerEventId: 'ses-123',
      recipientEmail: 'user@example.com',
      recipientPhone: null,
      deviceToken: null,
      metadata: {},
      eventTimestamp: new Date('2026-04-02T00:00:05Z'),
      createdAt: new Date('2026-04-02T00:00:05Z'),
    },
  });

  const emailTransaction = await db.getEmailTransactionByProviderMessageId('ses-123');
  const events = await client.queryEvents({
    providerMessageId: 'ses-123',
    provider: 'aws-ses',
    userId: 'user-123',
    startAt: new Date('2026-04-01T00:00:00Z'),
    endAt: new Date('2026-04-03T00:00:00Z'),
  });

  await client.bulkAddToSuppressionList([
    {
      email: ' User@Example.com ',
      reason: 'manual',
      source: 'admin',
      bounceType: null,
      metadata: {},
      suppressedAt: new Date('2026-04-02T00:00:00Z'),
    },
  ]);

  const exported = await client.exportSuppressionList();
  await client.removeFromSuppressionList('user@example.com');
  const suppressionCheck = await client.checkSuppressionList('user@example.com');

  console.log(
    JSON.stringify(
      {
        dbVector: {
          emailTransaction: { id: emailTransaction?.id ?? null },
          events: events.map((event) => ({ referenceId: event.referenceId })),
        },
        suppressionVector: {
          normalizedStoredEmail: exported[0]?.email ?? null,
          exportOrder: exported.map((entry) => entry.email),
          removed: suppressionCheck.suppressed === false,
        },
      },
      null,
      2
    )
  );
}

void main();
