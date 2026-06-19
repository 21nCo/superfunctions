import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  metaWhatsAppAdapter,
  sendfn,
  type SendfnConfig,
} from '../src';
import { createSendFn as createEdgeSendFn } from '../src/edge';
import { StrongMockAdapter } from './mock-adapter';

describe('WhatsApp channel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ messages: [{ id: 'wamid.123' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends through Meta Cloud API and records a transaction/event', async () => {
    const adapter = new StrongMockAdapter();
    const client = sendfn({
      database: adapter as any,
      whatsappProvider: metaWhatsAppAdapter({
        accessToken: 'test-token',
        phoneNumberId: 'phone-number-id',
      }),
    } satisfies SendfnConfig);

    const transaction = await client.whatsapp({
      userId: 'user-1',
      to: '+15551234567',
      message: 'Hello from sendfn',
      metadata: { traceId: 'trace-1' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v20.0/phone-number-id/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+15551234567',
      type: 'text',
      text: {
        preview_url: false,
        body: 'Hello from sendfn',
      },
    });
    expect(transaction).toMatchObject({
      userId: 'user-1',
      to: '+15551234567',
      message: 'Hello from sendfn',
      provider: 'meta-whatsapp',
      providerMessageId: 'wamid.123',
      status: 'sent',
    });

    const events = await client.getWhatsAppEvents(transaction.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      referenceType: 'whatsapp',
      eventType: 'sent',
      provider: 'meta-whatsapp',
      providerEventId: 'wamid.123',
      recipientPhone: '+15551234567',
    });
  });

  it('returns provider failure metadata for non-2xx Meta responses', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 131000,
            message: 'Something went wrong',
          },
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      )
    );

    const adapter = metaWhatsAppAdapter({
      accessToken: 'test-token',
      phoneNumberId: 'phone-number-id',
    });

    const response = await adapter.sendWhatsApp({
      to: '+15551234567',
      message: 'Hello',
    });

    expect(response).toMatchObject({
      success: false,
      error: {
        code: '131000',
        message: 'Something went wrong',
        retryable: true,
      },
    });
  });

  it('supports the edge client without a database adapter', async () => {
    const client = createEdgeSendFn({
      whatsappProvider: metaWhatsAppAdapter({
        accessToken: 'test-token',
        phoneNumberId: 'phone-number-id',
      }),
    });

    const transaction = await client.whatsapp({
      userId: 'user-1',
      to: '+15551234567',
      message: 'Hello edge',
    });

    expect(transaction).toMatchObject({
      userId: 'user-1',
      to: '+15551234567',
      message: 'Hello edge',
      provider: 'meta-whatsapp',
      providerMessageId: 'wamid.123',
      status: 'sent',
    });
  });
});
