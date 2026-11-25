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

  it('keeps the error code and status when the details object itself is not plain data', async () => {
    const env = await setup();
    class ProviderDetails {
      status = 418;
    }
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: new ProviderDetails() as unknown as Record<string, unknown>
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error: { code: string; details?: unknown } };

    expect(payload.error.code).toBe('BILLFN_PROVIDER_ERROR');
    expect(payload.error.details).toBeUndefined();
  });

  it('leaves out a plain object with its own serializer', async () => {
    const env = await setup();
    const response = { data: 'serializer-internal', status: 502 };
    Object.defineProperty(response, 'toJSON', { value: () => ({ status: 502 }), enumerable: false });
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { status: 502, response }
    });

    const answer = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });

    const text = await answer.text();
    expect(text).not.toContain('serializer-internal');
    expect((JSON.parse(text) as { error: { details?: unknown } }).error.details).toEqual({ status: 502 });
  });

  it('leaves out an array with its own serializer', async () => {
    const env = await setup();
    const attempts = [{ data: 'array-serializer-internal' }];
    Object.defineProperty(attempts, 'toJSON', { value: () => [], enumerable: false });
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { status: 502, attempts }
    });

    const answer = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });

    const text = await answer.text();
    expect(text).not.toContain('array-serializer-internal');
    expect((JSON.parse(text) as { error: { details?: unknown } }).error.details).toEqual({ status: 502 });
  });

  it('leaves out an array subclass with an inherited serializer', async () => {
    const env = await setup();
    class Attempts extends Array<{ data: string }> {
      static get [Symbol.species]() {
        return Array;
      }
      toJSON() {
        return [];
      }
    }
    const attempts = new Attempts();
    attempts.push({ data: 'subclass-serializer-internal' });
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { status: 502, attempts }
    });

    const answer = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });

    const text = await answer.text();
    expect(text).not.toContain('subclass-serializer-internal');
    expect((JSON.parse(text) as { error: { details?: unknown } }).error.details).toEqual({ status: 502 });
  });

  it('answers a deeply nested details object with its own code and status, cut off at depth', async () => {
    const env = await setup();
    let nested: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 4000; level += 1) {
      nested = { next: nested };
    }
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { status: 502, nested }
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error: { code: string; details?: { status?: number } } };

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe('BILLFN_PROVIDER_ERROR');
    expect(payload.error.details?.status).toBe(502);
  });

  it('answers details with a throwing toJSON getter without reading it', async () => {
    const env = await setup();
    const details = { status: 502 };
    let reads = 0;
    Object.defineProperty(details, 'toJSON', {
      get() {
        reads += 1;
        throw new Error('test-getter-read');
      },
      enumerable: false
    });
    env.parseWebhookError.current = createBillFnError({ code: 'BILLFN_PROVIDER_ERROR', message: 'Provider request failed', details });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error: { code: string; details?: unknown } };

    expect(response.status).toBe(502);
    expect(payload.error.code).toBe('BILLFN_PROVIDER_ERROR');
    expect(reads).toBe(0);
  });

  it('leaves out bigint and function values, including a function with its own serializer', async () => {
    const env = await setup();
    const serialized = Object.assign(() => undefined, { toJSON: () => ({ body: 'function-internal' }) });
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { status: 502, amount: BigInt(10), serialized }
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).not.toContain('function-internal');
    expect((JSON.parse(text) as { error: { details?: unknown } }).error.details).toEqual({ status: 502 });
  });

  it('walks an array without its own methods, so an own map cannot replace the filtering', async () => {
    const env = await setup();
    const attempts: unknown[] = [{ at: 1, body: 'item-internal' }];
    Object.defineProperty(attempts, 'map', { value: () => [{ body: 'map-internal' }], enumerable: false });
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { status: 502, attempts }
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const text = await response.text();

    expect(text).not.toContain('internal');
    expect((JSON.parse(text) as { error: { details?: unknown } }).error.details).toEqual({ status: 502, attempts: [{ at: 1 }] });
  });

  it('leaves out objects in the details that are not plain data', async () => {
    const env = await setup();
    class ProviderResponse {
      constructor(public data: string) {}
      toJSON() {
        return { hidden: true };
      }
    }
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { status: 502, response: new ProviderResponse('class-internal') }
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const text = await response.text();

    expect(text).not.toContain('class-internal');
    expect((JSON.parse(text) as { error: { details?: unknown } }).error.details).toEqual({ status: 502 });
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

  it('answers no details when every value in them is left out', async () => {
    const env = await setup();
    class ProviderResponse {
      data = 'left-out';
    }
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { response: new ProviderResponse() }
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error: Record<string, unknown> };

    expect(payload.error).not.toHaveProperty('details');
  });

  it('answers no details when left-out values sit deeper, in objects and arrays', async () => {
    const env = await setup();
    class ProviderResponse {
      data = 'left-out';
    }
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { response: { data: new ProviderResponse() }, attempts: [new ProviderResponse()], body: 'private' }
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error: Record<string, unknown> };

    expect(payload.error).not.toHaveProperty('details');
  });

  it('keeps the public values beside left-out ones in arrays', async () => {
    const env = await setup();
    class ProviderResponse {
      data = 'left-out';
    }
    env.parseWebhookError.current = createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: 'Provider request failed',
      details: { attempts: [new ProviderResponse(), { at: 1 }], tags: [] }
    });

    const response = await env.call('/webhooks/dodo', { method: 'POST', body: '{}' });
    const payload = (await response.json()) as { error: { details?: unknown } };

    expect(payload.error.details).toEqual({ attempts: [{ at: 1 }], tags: [] });
  });
});

describe('request content type', () => {
  it.each(['text/plain', 'application/x-www-form-urlencoded', '', 'example+json', '+json', 'application/+json', 'application/json/x', 'application/json; charset=utf-8, text/plain', 'application/json; profile="unfinished', 'application/json; charset', 'application/json; =utf-8'])(
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

  it.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/vnd.example+json', 'application/vnd.example+json; profile="a,b"', 'application/json; profile="a\\"b"'])(
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

describe('content type parsing time', () => {
  it('refuses a long malformed header of empty parameters promptly', async () => {
    const env = await setup();
    const header = `application/json${' ; '.repeat(5000)}x`;
    const started = performance.now();

    const response = await env.call('/checkouts', { method: 'POST', headers: { 'content-type': header }, body: '{}' });

    expect(response.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(500);
  });
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

describe('partly read bodies', () => {
  it('refuses a body middleware already started reading instead of parsing its remainder', async () => {
    const env = await setup();
    // A prefix chunk, then a complete JSON body: parsing the remainder alone would succeed.
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"ignored": '), encoder.encode(JSON.stringify({ planKey: 'pro', provider: 'dodo', interval: 'month' }))];
    const request = new Request('https://billfn.example.test/billfn/checkouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift();
          if (next) {
            controller.enqueue(next);
          } else {
            controller.close();
          }
        }
      }),
      duplex: 'half'
    } as RequestInit);
    const reader = request.body!.getReader();
    await reader.read();
    reader.releaseLock();

    const response = await env.billfn.router.handle(request);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('already read');
  });
});

describe('unreadable bodies', () => {
  it('answers 400 when middleware holds a lock on the body', async () => {
    const env = await setup();
    const request = new Request('https://billfn.example.test/billfn/checkouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planKey: 'pro', provider: 'dodo', interval: 'month' })
    });
    request.body!.getReader();

    const response = await env.billfn.router.handle(request);

    expect(response.status).toBe(400);
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

  it('refuses nested metadata sent through the router before creating an account', async () => {
    const env = await setup();

    const response = await env.call('/checkouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planKey: 'pro', provider: 'dodo', interval: 'month', metadata: { campaign: { name: 'spring' } } })
    });

    expect(response.status).toBe(400);
    expect(await env.accounts()).toHaveLength(0);
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
