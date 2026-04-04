import { describe, expect, it, vi } from 'vitest';
import { deliverWebhook, signWebhookPayload, verifyWebhookSignature } from '../index.js';

describe('webhooks package exports', () => {
  it('signs and verifies webhook payload using timing-safe verification path', () => {
    const payload = JSON.stringify({ event: 'bot.joined', id: 'evt_1' });
    const secret = 'whsec_test';

    const signature = signWebhookPayload(payload, secret);
    expect(signature).toMatch(/^[a-f0-9]+$/);
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    expect(verifyWebhookSignature(payload, 'bad-signature', secret)).toBe(false);
  });

  it('supports prefixed signature verification', () => {
    const payload = '{"ok":true}';
    const secret = 'secret';
    const signature = signWebhookPayload(payload, secret, { prefix: 'sha256=' });
    expect(verifyWebhookSignature(payload, signature, secret, { prefix: 'sha256=' })).toBe(true);
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(false);
  });

  it('delivers payload with bounded retries and returns structured attempts', async () => {
    let attempt = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      attempt += 1;
      if (attempt < 3) {
        return { ok: false, status: 500 };
      }

      return { ok: true, status: 200 };
    });

    const result = await deliverWebhook(
      {
        url: 'https://example.com/hook',
        payload: { hello: 'world' },
        secret: 'whsec_test',
        signatureHeader: 'X-Test-Signature',
      },
      {
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        maxRetries: 3,
        initialDelayMs: 1,
        maxDelayMs: 2,
      }
    );

    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(3);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, ok: false, status: 500 });
    expect(result.attempts[2]).toMatchObject({ attempt: 3, ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
