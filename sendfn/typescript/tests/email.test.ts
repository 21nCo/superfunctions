import { beforeEach, describe, expect, it } from 'vitest';
import {
  Attachment,
  EmailProviderError,
  SendEmailParams,
  SendfnDatabaseAdapter,
  SuppressionError,
  TemplateError,
  ValidationError,
} from '../src';
import { EmailService } from '../src/email/service';
import { TemplateEngine, TemplateRegistry } from '../src/templates/engine';
import { StrongMockAdapter } from './mock-adapter';

class MockProvider {
  readonly name = 'mock-email';
  readonly capabilities = {
    supportsTemplates: true,
    supportsAttachments: true,
    supportsBulkSend: true,
    supportsScheduling: false,
    maxRecipientsPerEmail: 50,
    maxAttachmentSize: 10 * 1024 * 1024,
  };

  sendCalls = 0;
  responses: any[] = [];

  async initialize(): Promise<void> {}
  async isHealthy(): Promise<boolean> { return true; }
  async close(): Promise<void> {}
  validateEmail(): boolean { return true; }
  async sendBulkEmail(): Promise<any[]> { return []; }

  async sendEmail(): Promise<any> {
    this.sendCalls += 1;
    return (
      this.responses.shift() || {
        success: true,
        providerMessageId: 'msg-1',
        timestamp: new Date('2026-01-01T00:00:00Z'),
      }
    );
  }
}

describe('EmailService', () => {
  let provider: MockProvider;
  let db: SendfnDatabaseAdapter;
  let registry: TemplateRegistry;
  let service: EmailService;

  beforeEach(() => {
    provider = new MockProvider();
    db = new SendfnDatabaseAdapter(new StrongMockAdapter() as any);
    registry = new TemplateRegistry();
    service = new EmailService(
      provider as any,
      db,
      new TemplateEngine(),
      registry,
      { fromEmail: 'noreply@example.com' },
      { suppressionEnabled: true, retryAttempts: 3, retryDelay: 0 }
    );
  });

  it('short-circuits suppressed recipients before provider invocation', async () => {
    await db.addToSuppressionList({
      email: 'user@example.com',
      reason: 'manual',
      source: 'manual',
      bounceType: null,
      metadata: {},
      suppressedAt: new Date(),
    });

    await expect(
      service.sendEmail({
        userId: 'user-1',
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hello</p>',
      })
    ).rejects.toMatchObject({
      code: 'SENDFN_SUPPRESSED',
      message: 'Recipient is suppressed',
    });

    expect(provider.sendCalls).toBe(0);
  });

  it('fails with stable template and validation errors before provider invocation', async () => {
    await expect(
      service.sendEmail({
        userId: 'user-1',
        to: 'user@example.com',
        templateId: 'missing-template',
      } as SendEmailParams)
    ).rejects.toMatchObject({
      code: 'SENDFN_TEMPLATE_NOT_FOUND',
      message: 'Template `missing-template` was not found',
    });

    await expect(
      service.sendEmail({
        userId: 'user-1',
        to: 'user@example.com',
      } as SendEmailParams)
    ).rejects.toMatchObject({
      code: 'SENDFN_VALIDATION_ERROR',
    });

    expect(provider.sendCalls).toBe(0);
  });

  it('enforces provider limits before sending', async () => {
    const recipients = Array.from({ length: 51 }, (_, index) => `user${index}@example.com`);
    const oversized: Attachment = {
      filename: 'big.bin',
      content: Buffer.alloc(11 * 1024 * 1024),
    };

    await expect(
      service.sendEmail({
        userId: 'user-1',
        to: recipients,
        subject: 'Hello',
        html: '<p>Hello</p>',
      })
    ).rejects.toMatchObject({
      code: 'SENDFN_PROVIDER_LIMIT',
      message: 'Email request exceeds provider limits',
    });

    await expect(
      service.sendEmail({
        userId: 'user-1',
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hello</p>',
        attachments: [oversized],
      })
    ).rejects.toBeInstanceOf(EmailProviderError);

    expect(provider.sendCalls).toBe(0);
  });

  it('uses bounded retry behavior for retryable failures and does not retry non-retryable ones', async () => {
    provider.responses = [
      { success: false, timestamp: new Date(), error: { code: 'Throttling', message: 'slow down', retryable: true } },
      { success: false, timestamp: new Date(), error: { code: 'Throttling', message: 'slow down', retryable: true } },
      { success: true, providerMessageId: 'ses-123', timestamp: new Date('2026-01-01T00:00:00Z') },
    ];

    const sent = await service.sendEmail({
      userId: 'user-1',
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(provider.sendCalls).toBe(3);
    expect(sent.status).toBe('sent');
    expect(sent.providerMessageId).toBe('ses-123');

    provider.sendCalls = 0;
    provider.responses = [
      { success: false, timestamp: new Date(), error: { code: 'BadRequest', message: 'nope', retryable: false } },
    ];

    await expect(
      service.sendEmail({
        userId: 'user-1',
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hello</p>',
      })
    ).rejects.toMatchObject({
      code: 'BadRequest',
    });
    expect(provider.sendCalls).toBe(1);
  });

  it('surfaces retry exhaustion with a stable code', async () => {
    provider.responses = [
      { success: false, timestamp: new Date(), error: { code: 'Throttling', message: 'slow down', retryable: true } },
      { success: false, timestamp: new Date(), error: { code: 'Throttling', message: 'slow down', retryable: true } },
      { success: false, timestamp: new Date(), error: { code: 'Throttling', message: 'slow down', retryable: true } },
    ];

    await expect(
      service.sendEmail({
        userId: 'user-1',
        to: 'user@example.com',
        subject: 'Hello',
        html: '<p>Hello</p>',
      })
    ).rejects.toMatchObject({
      code: 'SENDFN_PROVIDER_RETRY_EXHAUSTED',
      message: 'Email provider retry limit exhausted',
    });

    expect(provider.sendCalls).toBe(3);
  });
});
