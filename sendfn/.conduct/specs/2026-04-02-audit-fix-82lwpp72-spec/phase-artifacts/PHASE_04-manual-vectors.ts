import { AwsSnsVerifier, type SnsMessage } from '../../../../sendfn/typescript/src/events/aws-sns-verifier';
import { AwsSesWebhookHandler } from '../../../../sendfn/typescript/src/events/webhook-handler';
import { SendfnDb } from '../../../../sendfn/typescript/src/database/sendfn-db';
import { SuppressionManager } from '../../../../sendfn/typescript/src/suppression/manager';
import { sendfn, type SendfnConfig } from '../../../../sendfn/typescript/src/sendfn';

class ManualAdapter {
  id = 'manual';
  name = 'Manual Adapter';
  version = '0.1.0';
  capabilities = {} as any;
  internal = {} as any;

  private store = new Map<string, any[]>();

  table(model: string): any[] {
    const existing = this.store.get(model);
    if (existing) {
      return existing;
    }
    const next: any[] = [];
    this.store.set(model, next);
    return next;
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
        default:
          return false;
      }
    });
  }

  async create<T = any>(params: any): Promise<T> {
    const table = this.table(params.model);
    const item = { ...params.data };
    table.push(item);
    return item;
  }

  async findOne<T = any>(params: any): Promise<T | null> {
    return (await this.findMany<T>({ ...params, limit: 1 }))[0] ?? null;
  }

  async findMany<T = any>(params: any): Promise<T[]> {
    const table = [...this.table(params.model)].filter((item) => this.matches(item, params.where));
    const offset = params.offset ?? 0;
    const limit = params.limit ?? table.length;
    return table.slice(offset, offset + limit);
  }

  async update<T = any>(params: any): Promise<T> {
    const table = this.table(params.model);
    const record = table.find((item) => this.matches(item, params.where));
    if (!record) {
      throw new Error('Record not found');
    }
    Object.assign(record, params.data);
    return record;
  }

  async delete(params: any): Promise<void> {
    const next = this.table(params.model).filter((item) => !this.matches(item, params.where));
    this.store.set(params.model, next);
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
    if (existing) {
      return this.update({ model: params.model, where: params.where, data: params.update });
    }
    return this.create({ model: params.model, data: params.create });
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createVerifier(): AwsSnsVerifier {
  return new AwsSnsVerifier({
    now: () => new Date('2026-04-02T00:00:00Z'),
    fetchCertificate: async () => 'certificate',
    verifySignature: async (_canonicalMessage, signature) => signature === 'valid',
  });
}

function createEnvelope(message: Record<string, unknown>, overrides: Partial<SnsMessage> = {}): SnsMessage {
  return {
    Type: 'Notification',
    MessageId: 'sns-1',
    TopicArn: 'arn:aws:sns:us-east-1:123456789012:sendfn',
    Timestamp: '2026-04-02T00:00:00Z',
    SignatureVersion: '1',
    Signature: 'valid',
    SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    Message: JSON.stringify(message),
    ...overrides,
  };
}

async function seedTransaction(adapter: ManualAdapter, providerMessageId = 'ses-123'): Promise<void> {
  await adapter.create({
    model: 'email_transactions',
    data: {
      id: 'tx-1',
      userId: 'user-1',
      to: 'user@example.com',
      from: 'noreply@example.com',
      subject: 'Hello',
      templateId: null,
      templateData: null,
      provider: 'aws-ses',
      providerMessageId,
      status: 'sent',
      sentAt: new Date('2026-04-02T00:00:00Z'),
      deliveredAt: null,
      bouncedAt: null,
      complainedAt: null,
      metadata: {},
      createdAt: new Date('2026-04-02T00:00:00Z'),
      updatedAt: new Date('2026-04-02T00:00:00Z'),
    },
  });
}

async function run(): Promise<void> {
  const tv001pAdapter = new ManualAdapter();
  const tv001pClient = sendfn({
    database: tv001pAdapter as any,
    enableApi: true,
    apiConfig: { adminKey: 'top-secret' },
  } satisfies SendfnConfig);
  (tv001pClient.getWebhookHandlers().awsSes as any).verifier = createVerifier();
  const tv001pResponse = await (tv001pClient.router as any).handle(
    new Request('http://localhost/webhooks/aws-ses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'tv-webhook-001-p',
      },
      body: JSON.stringify(
        createEnvelope({
          notificationType: 'Delivery',
          mail: {
            messageId: 'ses-123',
            timestamp: '2026-04-02T00:00:00Z',
            destination: ['user@example.com'],
          },
          delivery: {
            timestamp: '2026-04-02T00:00:05Z',
            recipients: ['user@example.com'],
            processingTimeMillis: 100,
            smtpResponse: '250 ok',
          },
        })
      ),
    })
  );
  const tv001pBody = await tv001pResponse.json();
  assert(tv001pResponse.status === 200, 'TV-WEBHOOK-001-P expected status 200');
  assert(tv001pBody.ok === true, 'TV-WEBHOOK-001-P expected ok=true');
  assert(tv001pBody.data.accepted === true && tv001pBody.data.verified === true, 'TV-WEBHOOK-001-P expected accepted+verified');

  const tv001nAdapter = new ManualAdapter();
  const tv001nClient = sendfn({
    database: tv001nAdapter as any,
    enableApi: true,
    apiConfig: { adminKey: 'top-secret' },
  } satisfies SendfnConfig);
  (tv001nClient.getWebhookHandlers().awsSes as any).verifier = createVerifier();
  const tv001nResponse = await (tv001nClient.router as any).handle(
    new Request('http://localhost/webhooks/aws-ses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'tv-webhook-001-n',
      },
      body: JSON.stringify(
        createEnvelope(
          {
            notificationType: 'Delivery',
            mail: {
              messageId: 'ses-123',
              timestamp: '2026-04-02T00:00:00Z',
              destination: ['user@example.com'],
            },
            delivery: {
              timestamp: '2026-04-02T00:00:05Z',
              recipients: ['user@example.com'],
            },
          },
          { Signature: 'invalid' }
        )
      ),
    })
  );
  const tv001nBody = await tv001nResponse.json();
  assert(tv001nResponse.status === 400, 'TV-WEBHOOK-001-N expected status 400');
  assert(tv001nBody.error.code === 'SENDFN_WEBHOOK_SIGNATURE_INVALID', 'TV-WEBHOOK-001-N expected signature error code');
  assert(tv001nAdapter.table('communication_events').length === 0, 'TV-WEBHOOK-001-N expected zero event mutations');
  assert(tv001nAdapter.table('suppression_list').length === 0, 'TV-WEBHOOK-001-N expected zero suppression mutations');

  const tv002pAdapter = new ManualAdapter();
  await seedTransaction(tv002pAdapter);
  const tv002pDb = new SendfnDb(tv002pAdapter as any);
  const tv002pHandler = new AwsSesWebhookHandler(
    tv002pDb,
    new SuppressionManager(tv002pDb, { enabled: true }),
    { verifier: createVerifier() }
  );
  await tv002pHandler.handleSnsNotification(
    createEnvelope({
      notificationType: 'Bounce',
      mail: {
        messageId: 'ses-123',
        timestamp: '2026-04-02T00:00:00Z',
        destination: ['user@example.com'],
      },
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [
          {
            emailAddress: 'user@example.com',
            diagnosticCode: '550',
          },
        ],
      },
    })
  );
  assert(tv002pAdapter.table('email_transactions')[0].status === 'bounced', 'TV-WEBHOOK-002-P expected bounced transaction');
  assert(tv002pAdapter.table('communication_events')[0].referenceId === 'tx-1', 'TV-WEBHOOK-002-P expected correlated event reference');
  assert(tv002pAdapter.table('communication_events')[0].eventType === 'bounced', 'TV-WEBHOOK-002-P expected bounced event');
  assert(tv002pAdapter.table('suppression_list')[0].email === 'user@example.com', 'TV-WEBHOOK-002-P expected suppression email');
  assert(tv002pAdapter.table('suppression_list')[0].reason === 'bounce', 'TV-WEBHOOK-002-P expected suppression reason');

  const tv002nAdapter = new ManualAdapter();
  const tv002nDb = new SendfnDb(tv002nAdapter as any);
  const tv002nHandler = new AwsSesWebhookHandler(
    tv002nDb,
    new SuppressionManager(tv002nDb, { enabled: true }),
    { verifier: createVerifier() }
  );
  await tv002nHandler.handleSnsNotification(
    createEnvelope({
      notificationType: 'Complaint',
      mail: {
        messageId: 'ses-missing',
        timestamp: '2026-04-02T00:00:00Z',
        destination: ['user@example.com'],
      },
      complaint: {
        complainedRecipients: [{ emailAddress: 'user@example.com' }],
      },
    })
  );
  assert(tv002nAdapter.table('email_transactions').length === 0, 'TV-WEBHOOK-002-N expected no transaction mutations');
  assert(
    tv002nAdapter.table('communication_events')[0].referenceId === 'provider:aws-ses:ses-missing',
    'TV-WEBHOOK-002-N expected deterministic orphan reference'
  );
  assert(
    tv002nAdapter.table('communication_events')[0].metadata.orphaned === true,
    'TV-WEBHOOK-002-N expected orphan metadata'
  );
  assert(tv002nAdapter.table('suppression_list')[0].email === 'user@example.com', 'TV-WEBHOOK-002-N expected suppression email');
  assert(tv002nAdapter.table('suppression_list')[0].reason === 'complaint', 'TV-WEBHOOK-002-N expected suppression reason');

  console.log(
    JSON.stringify(
      {
        ok: true,
        vectors: ['TV-WEBHOOK-001-P', 'TV-WEBHOOK-001-N', 'TV-WEBHOOK-002-P', 'TV-WEBHOOK-002-N'],
      },
      null,
      2
    )
  );
}

await run();
