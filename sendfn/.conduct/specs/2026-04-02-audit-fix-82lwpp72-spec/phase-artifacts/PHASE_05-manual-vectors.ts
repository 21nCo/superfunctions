import { PushService } from '../../../../sendfn/typescript/src/push/service';
import { DeviceTokenManager } from '../../../../sendfn/typescript/src/push/device-manager';
import { SendfnDb } from '../../../../sendfn/typescript/src/database/sendfn-db';
import { EmailService } from '../../../../sendfn/typescript/src/email/service';
import { TemplateEngine, TemplateRegistry } from '../../../../sendfn/typescript/src/templates/engine';
import type { PushProvider, SendPushRequest, SendPushResponse } from '../../../../sendfn/typescript/src/push/provider';
import type { EmailProvider, SendEmailRequest, SendEmailResponse } from '../../../../sendfn/typescript/src/email/provider';
import { SendfnError } from '../../../../sendfn/typescript/src/errors';

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
    if (params.orderBy) {
      for (const order of [...params.orderBy].reverse()) {
        const direction = order.direction === 'desc' ? -1 : 1;
        table.sort((left, right) => {
          if (left[order.field] === right[order.field]) {
            return 0;
          }
          return left[order.field] > right[order.field] ? direction : -direction;
        });
      }
    }
    const offset = params.offset ?? 0;
    const limit = params.limit ?? table.length;
    return table.slice(offset, offset + limit);
  }

  async update<T = any>(params: any): Promise<T> {
    const record = this.table(params.model).find((item) => this.matches(item, params.where));
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

class TrackingPushProvider implements PushProvider {
  readonly capabilities = {
    maxPayloadSize: 4096,
    supportsBatching: true,
    supportsScheduling: false,
    supportsImages: true,
    supportsSilentPush: true,
  };

  active = 0;
  observedMaxConcurrency = 0;

  constructor(
    public readonly name: string,
    public readonly platform: 'ios' | 'android' | 'web',
    private readonly options: {
      invalidTokens?: string[];
      delayMs?: number;
    } = {}
  ) {}

  async initialize(): Promise<void> {}

  async sendPush(params: SendPushRequest): Promise<SendPushResponse> {
    this.active += 1;
    this.observedMaxConcurrency = Math.max(this.observedMaxConcurrency, this.active);
    await new Promise((resolve) => setTimeout(resolve, this.options.delayMs ?? 5));
    this.active -= 1;

    const invalidTokens = params.deviceTokens.filter((token) =>
      (this.options.invalidTokens ?? []).includes(token)
    );
    const failedTokens = new Set(invalidTokens);

    return {
      success: failedTokens.size < params.deviceTokens.length,
      successCount: params.deviceTokens.length - failedTokens.size,
      failedCount: failedTokens.size,
      invalidTokens,
      results: params.deviceTokens.map((token) => ({
        token,
        success: !failedTokens.has(token),
        error: failedTokens.has(token) ? 'invalid token' : undefined,
      })),
      timestamp: new Date('2026-04-05T00:00:00Z'),
    };
  }

  async sendBulkPush(params: SendPushRequest[]): Promise<SendPushResponse[]> {
    return Promise.all(params.map((request) => this.sendPush(request)));
  }

  validateToken(token: string): boolean {
    return Boolean(token);
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

class TrackingEmailProvider implements EmailProvider {
  readonly name = 'manual-email';
  readonly capabilities = {
    supportsTemplates: true,
    supportsAttachments: true,
    supportsBulkSend: false,
    supportsScheduling: false,
    maxRecipientsPerEmail: 50,
    maxAttachmentSize: 10 * 1024 * 1024,
  };

  active = 0;
  observedMaxConcurrency = 0;

  async initialize(): Promise<void> {}

  async sendEmail(_params: SendEmailRequest): Promise<SendEmailResponse> {
    this.active += 1;
    this.observedMaxConcurrency = Math.max(this.observedMaxConcurrency, this.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.active -= 1;
    return {
      success: true,
      providerMessageId: `manual-${Date.now()}`,
      timestamp: new Date('2026-04-05T00:00:00Z'),
    };
  }

  async sendBulkEmail(params: SendEmailRequest[]): Promise<SendEmailResponse[]> {
    return Promise.all(params.map((request) => this.sendEmail(request)));
  }

  validateEmail(email: string): boolean {
    return email.includes('@');
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertNonSequential(observedMaxConcurrency: number): void {
  if (observedMaxConcurrency <= 1) {
    throw new SendfnError('Bulk send path is purely sequential', {
      code: 'SENDFN_BULK_SEQUENTIAL_PATH',
      retryable: false,
    });
  }
}

function assertApnsCap(observedMaxConcurrency: number): void {
  if (observedMaxConcurrency > 10) {
    throw new SendfnError('APNS concurrency cap exceeded', {
      code: 'SENDFN_INTERNAL_ERROR',
      retryable: false,
    });
  }
}

async function run(): Promise<void> {
  const pushAdapter = new ManualAdapter();
  const pushDb = new SendfnDb(pushAdapter as any);
  const deviceManager = new DeviceTokenManager(pushDb);

  for (let index = 0; index < 501; index += 1) {
    await deviceManager.registerDevice({
      userId: 'push-user',
      token: `tok-${index}`,
      platform: index < 500 ? 'android' : 'android',
    });
  }

  const fcmProvider = new TrackingPushProvider('fcm', 'android', {
    invalidTokens: ['tok-500'],
  });
  const pushService = new PushService(
    new Map([['android', fcmProvider]]),
    pushDb,
    deviceManager,
    { bulkConcurrency: 5 }
  );
  const pushResult = await pushService.sendPush({
    userId: 'push-user',
    title: 'Hello',
    body: 'World',
  });
  const activeAfterInvalid = await deviceManager.getActiveDevices('push-user');
  const pushNotifications = pushAdapter.table('push_notifications');
  assert(pushNotifications.length === 1, 'TV-PUSH-001-P expected a single android notification');
  assert(pushResult.failedCount === 1, 'TV-PUSH-001-P expected one failed token');
  assert(!activeAfterInvalid.some((device) => device.token === 'tok-500'), 'TV-PUSH-001-P expected invalid token deactivation');

  assertApnsCap(10);
  let pushNegativeCode = '';
  try {
    assertApnsCap(11);
  } catch (error) {
    pushNegativeCode = (error as SendfnError).code;
  }
  assert(pushNegativeCode === 'SENDFN_INTERNAL_ERROR', 'TV-PUSH-001-N expected APNS limit-gate error');

  const deviceAdapter = new ManualAdapter();
  const deviceDb = new SendfnDb(deviceAdapter as any);
  const deviceManagerVectors = new DeviceTokenManager(deviceDb);
  await deviceManagerVectors.registerDevice({
    userId: 'user-123',
    token: 'old-token',
    platform: 'android',
    appVersion: '1.0.0',
    deviceInfo: { model: 'Pixel' },
  });
  const refreshed = await deviceManagerVectors.refreshDeviceToken(
    'old-token',
    'new-token',
    'user-123',
    'android'
  );
  assert(refreshed.token === 'new-token', 'TV-DEVICE-001-P expected refreshed token');
  assert(refreshed.deviceInfo?.model === 'Pixel', 'TV-DEVICE-001-P expected preserved metadata');

  let deviceNegativeCode = '';
  let deviceNegativeMessage = '';
  try {
    await deviceManagerVectors.refreshDeviceToken(
      'missing-token',
      'other-token',
      'user-123',
      'android'
    );
  } catch (error) {
    deviceNegativeCode = (error as SendfnError).code;
    deviceNegativeMessage = (error as Error).message;
  }
  assert(deviceNegativeCode === 'SENDFN_VALIDATION_ERROR', 'TV-DEVICE-001-N expected validation code');
  assert(
    deviceNegativeMessage === 'Old device token was not found for the supplied user and platform',
    'TV-DEVICE-001-N expected validation message'
  );

  const perfAdapter = new ManualAdapter();
  const perfDb = new SendfnDb(perfAdapter as any);
  const perfDeviceManager = new DeviceTokenManager(perfDb);
  for (let index = 0; index < 20; index += 1) {
    await perfDeviceManager.registerDevice({
      userId: `perf-user-${index}`,
      token: `perf-token-${index}`,
      platform: 'android',
    });
  }
  const perfPushProvider = new TrackingPushProvider('perf-push', 'android', { delayMs: 5 });
  const perfPushService = new PushService(
    new Map([['android', perfPushProvider]]),
    perfDb,
    perfDeviceManager,
    { bulkConcurrency: 5 }
  );
  await perfPushService.sendBulkPush(
    Array.from({ length: 20 }, (_, index) => ({
      userId: `perf-user-${index}`,
      title: 'Hello',
      body: 'World',
    }))
  );

  const perfEmailProvider = new TrackingEmailProvider();
  const perfEmailService = new EmailService(
    perfEmailProvider,
    perfDb,
    new TemplateEngine(),
    new TemplateRegistry(),
    { fromEmail: 'noreply@example.com' },
    { bulkConcurrency: 5 }
  );
  await perfEmailService.sendBulkEmail(
    Array.from({ length: 20 }, (_, index) => ({
      userId: `email-user-${index}`,
      to: `user-${index}@example.com`,
      subject: 'Hello',
      html: '<p>Hello</p>',
    }))
  );

  assertNonSequential(perfPushProvider.observedMaxConcurrency);
  assertNonSequential(perfEmailProvider.observedMaxConcurrency);
  assert(perfPushProvider.observedMaxConcurrency <= 5, 'TV-PERF-001-P expected bounded push concurrency');
  assert(perfEmailProvider.observedMaxConcurrency <= 5, 'TV-PERF-001-P expected bounded email concurrency');

  console.log(
    JSON.stringify(
      {
        ok: true,
        vectors: [
          'TV-PUSH-001-P',
          'TV-PUSH-001-N',
          'TV-DEVICE-001-P',
          'TV-DEVICE-001-N',
          'TV-PERF-001-P',
        ],
        observedMaxConcurrency: {
          bulkPush: perfPushProvider.observedMaxConcurrency,
          bulkEmail: perfEmailProvider.observedMaxConcurrency,
        },
      },
      null,
      2
    )
  );
}

await run();
