import { describe, it, expect } from 'vitest';
import { computeWebhookSignature } from '../src/webhooks/sign.js';
import { createHmac } from 'node:crypto';

describe('Webhook HMAC signing (TV-WH-004)', () => {
  it('computes HMAC-SHA256 of body with secret', () => {
    const body = '{"event":"bot.joined","timestamp":"2026-02-28T14:05:00Z","data":{"botId":"bot_abc123"}}';
    const secret = 'whsec_test';
    const sig = computeWebhookSignature(body, secret);

    const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(sig).toBe(expected);
  });

  it('produces different signatures for different secrets', () => {
    const body = '{"event":"bot.joined"}';
    const sig1 = computeWebhookSignature(body, 'secret1');
    const sig2 = computeWebhookSignature(body, 'secret2');
    expect(sig1).not.toBe(sig2);
  });

  it('produces different signatures for different bodies', () => {
    const secret = 'whsec_test';
    const sig1 = computeWebhookSignature('{"event":"bot.joined"}', secret);
    const sig2 = computeWebhookSignature('{"event":"bot.left"}', secret);
    expect(sig1).not.toBe(sig2);
  });
});
