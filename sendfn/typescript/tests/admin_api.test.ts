import { describe, expect, it } from 'vitest';
import type { EmailProvider, SendEmailRequest, SendEmailResponse } from '../src/email/provider';
import { sendfn, type SendfnConfig } from '../src/sendfn';
import { StrongMockAdapter } from './mock-adapter';

class FakeEmailProvider implements EmailProvider {
  readonly name = 'fake-email';
  readonly capabilities = {
    supportsTemplates: true,
    supportsAttachments: true,
    supportsBulkSend: false,
    supportsScheduling: false,
    maxRecipientsPerEmail: 50,
    maxAttachmentSize: 10 * 1024 * 1024,
  };

  async initialize(): Promise<void> {}

  async sendEmail(_params: SendEmailRequest): Promise<SendEmailResponse> {
    return {
      success: true,
      providerMessageId: 'ses-admin-1',
      timestamp: new Date('2026-04-05T00:00:00Z'),
    };
  }

  async sendBulkEmail(): Promise<SendEmailResponse[]> {
    return [];
  }

  validateEmail(): boolean {
    return true;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

describe('admin API envelopes', () => {
  it('returns canonical success envelopes for authorized admin email sends', async () => {
    const client = sendfn({
      database: new StrongMockAdapter() as any,
      emailProvider: new FakeEmailProvider(),
      email: {
        fromEmail: 'noreply@example.com',
      },
      enableApi: true,
      apiConfig: {
        adminKey: 'top-secret',
      },
    } satisfies SendfnConfig);

    const response = await (client.router as any).handle(
      new Request('http://localhost/email', {
        method: 'POST',
        headers: {
          authorization: 'Bearer top-secret',
          'content-type': 'application/json',
          'x-request-id': 'req_admin_success',
        },
        body: JSON.stringify({
          userId: 'user-1',
          to: 'user@example.com',
          subject: 'Hello',
          html: '<p>Hello</p>',
        }),
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: {
        status: 'sent',
        providerMessageId: 'ses-admin-1',
      },
      error: null,
      meta: {
        requestId: 'req_admin_success',
        version: 'v0',
      },
    });
  });

  it('returns canonical unauthorized envelopes for admin routes', async () => {
    const client = sendfn({
      database: new StrongMockAdapter() as any,
      enableApi: true,
      apiConfig: {
        adminKey: 'top-secret',
      },
    } satisfies SendfnConfig);

    const response = await (client.router as any).handle(
      new Request('http://localhost/email', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req_admin_unauthorized',
        },
        body: JSON.stringify({
          userId: 'user-1',
          to: 'user@example.com',
          subject: 'Hello',
          html: '<p>Hello</p>',
        }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      data: null,
      error: {
        code: 'SENDFN_UNAUTHORIZED',
        message: 'Unauthorized',
        retryable: false,
      },
      meta: {
        requestId: 'req_admin_unauthorized',
        version: 'v0',
      },
    });
  });
});
