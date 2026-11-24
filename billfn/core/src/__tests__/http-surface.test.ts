import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn, createBillFnError, createWebhookIngress } from '../index.js';
import type { BillFnCatalog, BillFnConfig, BillFnProviderAdapter } from '../types.js';

// The router's HTTP surface: error details, request content type and size, and no account creation by mutations.

const catalog: BillFnCatalog = {
  plans: [
    {
      productKey: 'nucleus',
      planKey: 'pro',
      displayName: 'Pro',
      features: {},
      limits: {},
      prices: [
        {
          priceId: 'price_pro_dodo_month',
          provider: 'dodo',
          providerProductId: 'pdt_pro_month',
          currency: 'USD',
          amount: 12,
          kind: 'subscription',
          interval: 'month'
        }
      ]
    }
  ]
};

const SUBJECT = { principalId: 'payer' };

async function setup(config: Partial<BillFnConfig> = {}) {
  const db = memoryAdapter({ debug: false });
  const cancelSubscription = vi.fn<NonNullable<BillFnProviderAdapter['cancelSubscription']>>(async (input) => ({
    operationStatus: 'applied',
    billingState: {
      subscriptionStatus: 'canceled',
      checkoutStatus: 'succeeded',
      providerSubscriptionId: input.subscription.providerSubscriptionId,
      autoRenew: false
    }
  }));
  const syncSubscription = vi.fn<NonNullable<BillFnProviderAdapter['fetchSubscription']>>();
  const parseWebhookError: { current?: Error } = {};
  const provider: BillFnProviderAdapter = {
    provider: 'dodo',
    capabilities: {
      createCheckout: true,
      verifyCheckout: true,
      cancelSubscription: true,
      syncSubscription: true,
      restorePurchases: false,
      webhookIngestion: true
    },
    async createCheckout(input) {
      return { status: 'requires_action', checkoutUrl: 'https://billing.example.test/checkout', providerCheckoutId: `checkout_${input.checkoutSessionId}` };
    },
    async verifyCheckout(input) {
      return {
        subscriptionStatus: 'active',
        checkoutStatus: 'succeeded',
        providerSubscriptionId: `sub_${input.checkoutSession.checkoutSessionId}`,
        providerChargeId: 'charge_paid',
        autoRenew: true
      };
    },
    fetchSubscription: syncSubscription,
    cancelSubscription,
    async parseWebhook() {
      throw (
        parseWebhookError.current ??
        createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: 'Dodo request failed with status 400',
          details: { status: 400, body: '{"secret":"provider-internal"}', bundleIds: ['com.example.app'] }
        })
      );
    }
  };
  const billfn = createBillFn({
    db,
    catalog,
    providers: { dodo: provider },
    auth: { resolveSubject: () => SUBJECT },
    ...config
  });
  const accounts = () => db.findMany({ model: 'billingAccounts', where: [], namespace: 'billfn' });
  const call = (path: string, init: RequestInit) => billfn.router.handle(new Request(`https://billfn.example.test/billfn${path}`, init));
  return { billfn, cancelSubscription, syncSubscription, accounts, call, parseWebhookError };
}

describe('error details returned to callers', () => {
  it('leaves out a provider response body and configuration, keeping the rest', async () => {
    const env = await setup();

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error: { code: string; details?: Record<string, unknown> } };

    expect(payload.error.code).toBe('BILLFN_PROVIDER_ERROR');
    expect(payload.error.details).toEqual({ status: 400 });
    expect(JSON.stringify(payload)).not.toContain('provider-internal');
  });

  it('leaves out a provider response body nested anywhere in the details', async () => {
    const env = await setup();
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { status: 502, response: { body: '{"secret":"nested-internal"}', status: 502 }, attempts: [{ raw: 'attempt-internal', at: 1 }] }
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error: { details?: Record<string, unknown> } };

    expect(payload.error.details).toEqual({ status: 502, response: { status: 502 }, attempts: [{ at: 1 }] });
  });
});

describe('request content type', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', '', 'example+json', '+json', 'application/+json', 'application/json/x'])(
    'refuses a write sent as %j before acting on it',
    async (contentType) => {
      const env = await setup();
      await env.billfn.createCheckout({ subject: SUBJECT, planKey: 'pro', provider: 'dodo', interval: 'month' });

      const response = await env.call('/subscriptions/cancel', {
        method: 'POST',
        headers: contentType ? { 'content-type': contentType } : {},
        body: '{}'
      });

      expect(response.status).toBe(400);
      expect(env.cancelSubscription).not.toHaveBeenCalled();
    }
  );

  it.each(['application/json', 'application/json; charset=utf-8', 'application/vnd.example+json'])(
    'accepts a write sent as %s',
    async (contentType) => {
      const env = await setup();

      const response = await env.call('/checkouts', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: JSON.stringify({ planKey: 'pro', provider: 'dodo', interval: 'month' })
      });

      expect(response.status).toBe(201);
    }
  );
});

describe('request size', () => {
  const large = JSON.stringify({ planKey: 'pro', provider: 'dodo', padding: 'x'.repeat(300 * 1024) });

  it('refuses a JSON body over the limit', async () => {
    const env = await setup();

    const response = await env.call('/checkouts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: large });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('at most');
  });

  it('refuses a webhook body over the limit before parsing it', async () => {
    const env = await setup();

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: large });

    expect(response.status).toBe(400);
  });

  it('refuses an ingress delivery over the limit before any owner lookup', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { owned: false } }));
    const ingress = createWebhookIngress({
      regions: [{ id: 'useast', url: 'https://useast.billfn.test/billfn/' }],
      defaultRegion: 'useast',
      internalToken: 'test-internal-token',
      fetch: fetchMock as unknown as typeof fetch
    });

    const response = await ingress.handle('dodo', new Request('https://ingress.example.test/dodo', { method: 'POST', body: large }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** A body streamed in chunks with no content-length, counting how many chunks were pulled. */
function streamedBody(chunkBytes: number, chunks: number) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    }
  });
  return { stream, pulled: () => pulled };
}

describe('streamed request bodies', () => {
  it('stops reading an ingress delivery with no content-length once it passes the limit', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true, data: { owned: false } }));
    const ingress = createWebhookIngress({
      regions: [{ id: 'useast', url: 'https://useast.billfn.test/billfn/' }],
      defaultRegion: 'useast',
      internalToken: 'test-internal-token',
      fetch: fetchMock as unknown as typeof fetch
    });
    const body = streamedBody(64 * 1024, 1000);

    const response = await ingress.handle(
      'dodo',
      new Request('https://ingress.example.test/dodo', { method: 'POST', body: body.stream, duplex: 'half' } as RequestInit)
    );

    expect(response.status).toBe(400);
    expect(body.pulled()).toBeLessThan(10);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers an oversized streamed router body even while an unread clone of the request is held', async () => {
    const env = await setup();
    const body = streamedBody(64 * 1024, 1000);
    const request = new Request('https://billfn.example.test/billfn/checkouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body.stream,
      duplex: 'half'
    } as RequestInit);
    const held = request.clone();

    const response = await env.billfn.router.handle(request);

    expect(response.status).toBe(400);
    expect(held.bodyUsed).toBe(false);
  });
});

describe('billing accounts', () => {
  it.each([
    ['/subscriptions/cancel', {}],
    ['/subscriptions/resume', {}],
    ['/subscriptions/change', { targetPriceId: 'price_pro_dodo_month' }],
    ['/subscriptions/sync', {}]
  ])('does not create one for a subject without one on %s', async (path, body) => {
    const env = await setup();

    const response = await env.call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    expect(response.status).toBe(404);
    expect(await env.accounts()).toHaveLength(0);
  });
});

describe('checkout metadata', () => {
  it.each([
    ['too many keys', Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`key_${index}`, 'value']))],
    ['a long value', { note: 'x'.repeat(501) }],
    ['a long key', { ['k'.repeat(41)]: 'value' }],
    ['a nested value', { nested: { deep: true } }],
    ['an array', ['value']]
  ])('refuses %s', async (_name, metadata) => {
    const env = await setup();

    await expect(
      env.billfn.createCheckout({ subject: SUBJECT, planKey: 'pro', provider: 'dodo', interval: 'month', metadata: metadata as never })
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
  });

  it('accepts small scalar metadata', async () => {
    const env = await setup();

    const created = await env.billfn.createCheckout({
      subject: SUBJECT,
      planKey: 'pro',
      provider: 'dodo',
      interval: 'month',
      metadata: { campaign: 'spring', seats: 3, trial: false }
    });

    expect(created.ok).toBe(true);
  });
});
