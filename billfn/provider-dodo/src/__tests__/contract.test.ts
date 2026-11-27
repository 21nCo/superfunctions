import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BillFnBillingAccount,
  BillFnCheckoutSession,
  BillFnPriceDefinition,
  BillFnSubscription,
  BillFnVerifyCheckoutInput
} from '@billfn/core';
import { DODO_PROVIDER_HTTP_DEADLINE_MS, createDodoProvider, type DodoProviderConfig } from '../index.js';
import recorded from './fixtures/dodo-api-v1.124.0.json';

/*
 * Contract tests: every adapter call against responses recorded from Dodo's public API reference
 * (fixtures/dodo-api-v1.124.0.json names the source and version). Each test pins the request Dodo documents
 * and how the adapter reads Dodo's documented answer.
 */

const TEST_HOST = 'https://test.dodopayments.com';
const SESSION_ID = recorded.createCheckoutSession.response.session_id;
const PAYMENT_ID = recorded.getCheckoutSession.response.payment_id;
const SUBSCRIPTION_ID = recorded.getSubscription.response.subscription_id;

type Route = unknown | ((body: Record<string, unknown> | undefined) => Response);

interface RecordedCall {
  method: string;
  url: string;
  body?: Record<string, unknown>;
  authorization?: string | null;
}

/** A Dodo API double that answers `METHOD /path` with a recorded body and records every request. */
function dodoApi(routes: Record<string, Route>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body, authorization: new Headers(init?.headers).get('authorization') });
    const route = routes[`${method} ${new URL(url).pathname}`];
    if (route === undefined) {
      return new Response(`no recorded Dodo response for ${method} ${url}`, { status: 500 });
    }
    return typeof route === 'function' ? (route as (b: typeof body) => Response)(body) : Response.json(route);
  }) as typeof fetch;
  return { fetchMock, calls };
}

function provider(fetchMock: typeof fetch, config: Partial<DodoProviderConfig> = {}) {
  return createDodoProvider({ apiKey: 'dodo_test_key', fetch: fetchMock, ...config });
}

const billingAccount: BillFnBillingAccount = {
  id: 'ba_user_123',
  ownerType: 'user',
  ownerId: 'user_123',
  createdAt: '2026-11-17T00:00:00.000Z',
  updatedAt: '2026-11-17T00:00:00.000Z'
};

const plan = { productKey: 'nucleus', planKey: 'nucleus', displayName: 'Nucleus', features: {}, limits: {}, prices: [] };

const monthPrice: BillFnPriceDefinition = {
  priceId: 'price_nucleus_month',
  provider: 'dodo',
  providerProductId: 'pdt_nucleus_month',
  currency: 'USD',
  amount: 1200,
  kind: 'subscription',
  interval: 'month'
};

const lifetimePrice: BillFnPriceDefinition = {
  priceId: 'price_nucleus_lifetime',
  provider: 'dodo',
  providerProductId: 'pdt_nucleus_lifetime',
  currency: 'USD',
  amount: 9900,
  kind: 'one_time',
  interval: 'lifetime'
};

function checkoutSession(price: BillFnPriceDefinition, patch: Partial<BillFnCheckoutSession> = {}): BillFnCheckoutSession {
  return {
    checkoutSessionId: 'chk_123',
    billingAccountId: billingAccount.id,
    planKey: 'nucleus',
    priceId: price.priceId,
    provider: 'dodo',
    providerCheckoutId: SESSION_ID,
    status: 'requires_action',
    createdAt: '2026-11-17T09:00:00.000Z',
    updatedAt: '2026-11-17T09:00:00.000Z',
    ...patch
  };
}

function verifyInput(price: BillFnPriceDefinition, patch: Partial<BillFnVerifyCheckoutInput> = {}): BillFnVerifyCheckoutInput {
  return { checkoutSession: checkoutSession(price), billingAccount, plan, price, ...patch };
}

function subscription(patch: Partial<BillFnSubscription> = {}): BillFnSubscription {
  return {
    id: 'bsub_1',
    billingAccountId: billingAccount.id,
    planKey: 'nucleus',
    priceId: monthPrice.priceId,
    provider: 'dodo',
    providerSubscriptionId: SUBSCRIPTION_ID,
    providerChargeId: PAYMENT_ID,
    status: 'active',
    autoRenew: true,
    createdAt: '2026-11-17T09:01:00.000Z',
    updatedAt: '2026-11-17T09:01:00.000Z',
    ...patch
  };
}

const paths = (calls: RecordedCall[]) => calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);

describe('Dodo environment', () => {
  it('calls the test mode host by default and the live host only when live mode is configured', async () => {
    const testApi = dodoApi({ 'POST /checkouts': recorded.createCheckoutSession.response });
    await provider(testApi.fetchMock).createCheckout?.({ checkoutSessionId: 'chk_123', billingAccount, plan, price: monthPrice });
    expect(testApi.calls[0]?.url).toBe(`${TEST_HOST}/checkouts`);
    expect(testApi.calls[0]?.authorization).toBe('Bearer dodo_test_key');

    const liveApi = dodoApi({ 'POST /checkouts': recorded.createCheckoutSession.response });
    await provider(liveApi.fetchMock, { environment: 'live_mode' }).createCheckout?.({
      checkoutSessionId: 'chk_123',
      billingAccount,
      plan,
      price: monthPrice
    });
    expect(liveApi.calls[0]?.url).toBe('https://live.dodopayments.com/checkouts');

    const proxied = dodoApi({ 'POST /checkouts': recorded.createCheckoutSession.response });
    await provider(proxied.fetchMock, { environment: 'live_mode', baseUrl: 'https://dodo.proxy.test/' }).createCheckout?.({
      checkoutSessionId: 'chk_123',
      billingAccount,
      plan,
      price: monthPrice
    });
    expect(proxied.calls[0]?.url).toBe('https://dodo.proxy.test/checkouts');
  });

  it.each([
    ['no trailing slash', 'https://dodo.proxy.test/v1', 'https://dodo.proxy.test/v1/checkouts'],
    ['one trailing slash', 'https://dodo.proxy.test/v1/', 'https://dodo.proxy.test/v1/checkouts'],
    ['several trailing slashes', 'https://dodo.proxy.test/v1///', 'https://dodo.proxy.test/v1/checkouts'],
    ['a long trailing slash run', `https://dodo.proxy.test${'/'.repeat(100_000)}`, 'https://dodo.proxy.test/checkouts'],
    [
      'a long slash run followed by a non-slash suffix',
      `https://dodo.proxy.test${'/'.repeat(100_000)}v1`,
      `https://dodo.proxy.test${'/'.repeat(100_000)}v1/checkouts`
    ]
  ])('trims only the trailing slashes of a configured base URL with %s', async (_label, baseUrl, expected) => {
    const api = dodoApi({ [`POST ${new URL(expected).pathname}`]: recorded.createCheckoutSession.response });
    const started = performance.now();
    await provider(api.fetchMock, { baseUrl }).createCheckout?.({
      checkoutSessionId: 'chk_123',
      billingAccount,
      plan,
      price: monthPrice
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(api.calls[0]?.url).toBe(expected);
  });

  it('rejects an environment Dodo does not have instead of guessing a mode', () => {
    expect(() => provider(vi.fn() as typeof fetch, { environment: 'live' as DodoProviderConfig['environment'] })).toThrow(
      expect.objectContaining({ code: 'BILLFN_VALIDATION_ERROR' })
    );
  });
});

describe('createCheckout -> POST /checkouts', () => {
  it('creates a checkout session for the price checkout selected, with its trial and BillFn metadata', async () => {
    const api = dodoApi({ 'POST /checkouts': recorded.createCheckoutSession.response });
    // A BILL-6 tagged price that checkout chose for this account: its own product and trial.
    const discounted: BillFnPriceDefinition = {
      ...monthPrice,
      priceId: 'price_nucleus_month_intro',
      providerProductId: 'pdt_nucleus_month_intro',
      eligibility: 'first-purchase',
      trialDays: 14
    };

    const result = await provider(api.fetchMock).createCheckout?.({
      checkoutSessionId: 'chk_123',
      billingAccount,
      plan,
      price: discounted,
      metadata: { billfn_region: 'euwest', nested: { ignored: true } },
      customer: {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        billing: { country: 'US', zipcode: '94105', phone: 'not an address field' }
      },
      successUrl: 'https://app.example/billing/return',
      cancelUrl: 'https://app.example/billing'
    });

    expect(paths(api.calls)).toEqual(['POST /checkouts']);
    expect(api.calls[0]?.body).toEqual({
      product_cart: [{ product_id: 'pdt_nucleus_month_intro', quantity: 1 }],
      metadata: {
        billfn_region: 'euwest',
        billfn_checkout_session_id: 'chk_123',
        billfn_billing_account_id: 'ba_user_123',
        billfn_product_id: 'pdt_nucleus_month_intro',
        billfn_price_id: 'price_nucleus_month_intro',
        billfn_currency: 'USD'
      },
      customer: { email: 'ada@example.com', name: 'Ada Lovelace' },
      billing_address: { country: 'US', zipcode: '94105' },
      return_url: 'https://app.example/billing/return',
      cancel_url: 'https://app.example/billing',
      subscription_data: { trial_period_days: 14 }
    });
    expect(result).toEqual({
      status: 'requires_action',
      providerCheckoutId: SESSION_ID,
      providerChargeId: undefined,
      checkoutUrl: recorded.createCheckoutSession.response.checkout_url,
      raw: recorded.createCheckoutSession.response
    });
  });

  it('sends a one-time price as a cart without subscription data and leaves unknown customer fields out', async () => {
    const api = dodoApi({ 'POST /checkouts': recorded.createCheckoutSession.response });
    await provider(api.fetchMock).createCheckout?.({
      checkoutSessionId: 'chk_123',
      billingAccount,
      plan,
      price: { ...lifetimePrice, currency: 'eur', trialDays: 7 },
      customer: { name: 'No Email', billing: { city: 'Nowhere' } }
    });

    expect(api.calls[0]?.body).toEqual({
      product_cart: [{ product_id: 'pdt_nucleus_lifetime', quantity: 1 }],
      metadata: {
        billfn_checkout_session_id: 'chk_123',
        billfn_billing_account_id: 'ba_user_123',
        billfn_product_id: 'pdt_nucleus_lifetime',
        billfn_price_id: 'price_nucleus_lifetime',
        billfn_currency: 'EUR'
      }
    });
  });

  it('fails when Dodo answers without a checkout session id', async () => {
    const api = dodoApi({ 'POST /checkouts': { checkout_url: 'https://test.checkout.dodopayments.com/x' } });
    await expect(
      provider(api.fetchMock).createCheckout?.({ checkoutSessionId: 'chk_123', billingAccount, plan, price: monthPrice })
    ).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });
  });

  it.each([
    [201, 'Dodo created the checkout but its session details did not arrive before the deadline', false],
    [401, 'Dodo request failed with status 401', true]
  ])('reports checkout HTTP %i when the body stalls', async (status, message, retryable) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response(new ReadableStream(), { status })) as typeof fetch;
      const pending = provider(fetchMock).createCheckout?.({ checkoutSessionId: 'chk_123', billingAccount, plan, price: monthPrice });
      await Promise.all([
        expect(pending).rejects.toMatchObject({
          code: 'BILLFN_PROVIDER_ERROR',
          message,
          retryable,
          details: { status }
        }),
        vi.advanceTimersByTimeAsync(DODO_PROVIDER_HTTP_DEADLINE_MS)
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('verifyCheckout -> GET /checkouts/{id}, /payments/{id}, /subscriptions/{id}', () => {
  it('follows a subscription checkout session to its payment and subscription', async () => {
    const api = dodoApi({
      [`GET /checkouts/${SESSION_ID}`]: recorded.getCheckoutSession.response,
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: recorded.getSubscription.response
    });

    const state = await provider(api.fetchMock).verifyCheckout?.(verifyInput(monthPrice));

    expect(paths(api.calls)).toEqual([
      `GET /checkouts/${SESSION_ID}`,
      `GET /payments/${PAYMENT_ID}`,
      `GET /subscriptions/${SUBSCRIPTION_ID}`
    ]);
    expect(state).toMatchObject({
      subscriptionStatus: 'active',
      checkoutStatus: 'succeeded',
      providerSubscriptionId: SUBSCRIPTION_ID,
      providerChargeId: PAYMENT_ID,
      currentPeriodStart: '2026-11-17T09:01:00Z',
      currentPeriodEnd: '2026-12-17T09:01:00Z',
      autoRenew: true
    });
  });

  it('follows a one-time checkout session to its payment', async () => {
    const api = dodoApi({
      [`GET /checkouts/${SESSION_ID}`]: recorded.getCheckoutSession.response,
      [`GET /payments/${PAYMENT_ID}`]: recorded.getOneTimePayment.response
    });

    const state = await provider(api.fetchMock).verifyCheckout?.(verifyInput(lifetimePrice));

    expect(paths(api.calls)).toEqual([`GET /checkouts/${SESSION_ID}`, `GET /payments/${PAYMENT_ID}`]);
    expect(state).toMatchObject({
      subscriptionStatus: 'active',
      checkoutStatus: 'succeeded',
      providerChargeId: PAYMENT_ID,
      autoRenew: false
    });
    expect(state?.providerSubscriptionId).toBeUndefined();
  });

  it('reports a session still collecting details as not yet payable without writing a state', async () => {
    const api = dodoApi({ [`GET /checkouts/${SESSION_ID}`]: recorded.getCheckoutSessionCollectingDetails.response });

    await expect(provider(api.fetchMock).verifyCheckout?.(verifyInput(monthPrice))).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      details: { checkoutStatus: 'pending' }
    });
    expect(api.calls).toHaveLength(1);
  });

  it('maps a declined one-time payment to a failed checkout', async () => {
    const api = dodoApi({
      [`GET /checkouts/${SESSION_ID}`]: { ...recorded.getCheckoutSession.response, payment_status: 'failed' },
      [`GET /payments/${PAYMENT_ID}`]: { ...recorded.getOneTimePayment.response, status: 'failed' }
    });

    await expect(provider(api.fetchMock).verifyCheckout?.(verifyInput(lifetimePrice))).resolves.toMatchObject({
      subscriptionStatus: 'failed',
      checkoutStatus: 'failed'
    });
  });

  it('follows the session to the retry of a declined subscription payment BillFn recorded', async () => {
    const RETRY_ID = 'pay_retry_after_decline';
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: { ...recorded.getSubscriptionPayment.response, status: 'failed', subscription_id: null, subscription_ids: [] },
      [`GET /checkouts/${SESSION_ID}`]: { ...recorded.getCheckoutSession.response, payment_id: RETRY_ID },
      [`GET /payments/${RETRY_ID}`]: { ...recorded.getSubscriptionPayment.response, payment_id: RETRY_ID },
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: recorded.getSubscription.response
    });
    // The first verification recorded the declined payment on the checkout session.
    const input = verifyInput(monthPrice, { checkoutSession: checkoutSession(monthPrice, { status: 'failed', providerChargeId: PAYMENT_ID }) });

    const state = await provider(api.fetchMock).verifyCheckout?.(input);

    expect(paths(api.calls)).toEqual([
      `GET /payments/${PAYMENT_ID}`,
      `GET /checkouts/${SESSION_ID}`,
      `GET /payments/${RETRY_ID}`,
      `GET /subscriptions/${SUBSCRIPTION_ID}`
    ]);
    expect(state).toMatchObject({ subscriptionStatus: 'active', checkoutStatus: 'succeeded', providerChargeId: RETRY_ID });
  });

  it('follows the session to the retry of a declined one-time payment BillFn recorded', async () => {
    const RETRY_ID = 'pay_retry_after_decline';
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: { ...recorded.getOneTimePayment.response, status: 'failed' },
      [`GET /checkouts/${SESSION_ID}`]: { ...recorded.getCheckoutSession.response, payment_id: RETRY_ID },
      [`GET /payments/${RETRY_ID}`]: { ...recorded.getOneTimePayment.response, payment_id: RETRY_ID }
    });
    const input = verifyInput(lifetimePrice, { checkoutSession: checkoutSession(lifetimePrice, { status: 'failed', providerChargeId: PAYMENT_ID }) });

    const state = await provider(api.fetchMock).verifyCheckout?.(input);

    expect(paths(api.calls)).toEqual([`GET /payments/${PAYMENT_ID}`, `GET /checkouts/${SESSION_ID}`, `GET /payments/${RETRY_ID}`]);
    expect(state).toMatchObject({ subscriptionStatus: 'active', checkoutStatus: 'succeeded', providerChargeId: RETRY_ID });
  });

  it('keeps a declined payment failed while its session names no other payment', async () => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: { ...recorded.getOneTimePayment.response, status: 'failed' },
      [`GET /checkouts/${SESSION_ID}`]: { ...recorded.getCheckoutSession.response, payment_status: 'failed' }
    });
    const input = verifyInput(lifetimePrice, { checkoutSession: checkoutSession(lifetimePrice, { status: 'failed', providerChargeId: PAYMENT_ID }) });

    await expect(provider(api.fetchMock).verifyCheckout?.(input)).resolves.toMatchObject({
      checkoutStatus: 'failed',
      providerChargeId: PAYMENT_ID
    });
    expect(paths(api.calls)).toEqual([`GET /payments/${PAYMENT_ID}`, `GET /checkouts/${SESSION_ID}`]);
  });

  it('verifies a 0.7.0 one-time checkout, which recorded its payment as the checkout, without a checkout session', async () => {
    const api = dodoApi({ [`GET /payments/${PAYMENT_ID}`]: { ...recorded.getOneTimePayment.response, status: 'failed' } });
    const input = verifyInput(lifetimePrice, {
      checkoutSession: checkoutSession(lifetimePrice, { providerCheckoutId: PAYMENT_ID, providerChargeId: PAYMENT_ID })
    });

    await expect(provider(api.fetchMock).verifyCheckout?.(input)).resolves.toMatchObject({
      checkoutStatus: 'failed',
      providerChargeId: PAYMENT_ID
    });
    expect(paths(api.calls)).toEqual([`GET /payments/${PAYMENT_ID}`]);
  });

  it('verifies a 0.7.0 subscription checkout whose declined payment was recorded only as the checkout', async () => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: { ...recorded.getSubscriptionPayment.response, status: 'failed', subscription_id: null, subscription_ids: [] }
    });
    const input = verifyInput(monthPrice, {
      checkoutSession: checkoutSession(monthPrice, { providerCheckoutId: PAYMENT_ID })
    });

    await expect(provider(api.fetchMock).verifyCheckout?.(input)).resolves.toMatchObject({
      checkoutStatus: 'failed',
      providerChargeId: PAYMENT_ID
    });
    expect(paths(api.calls)).toEqual([`GET /payments/${PAYMENT_ID}`]);
  });

  it('rejects a payment made through another checkout session', async () => {
    const api = dodoApi({
      [`GET /checkouts/${SESSION_ID}`]: recorded.getCheckoutSession.response,
      [`GET /payments/${PAYMENT_ID}`]: { ...recorded.getSubscriptionPayment.response, checkout_session_id: 'cks_other' }
    });

    await expect(provider(api.fetchMock).verifyCheckout?.(verifyInput(monthPrice))).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT'
    });
    expect(api.calls).toHaveLength(2);
  });

  it('rejects a subscription payment whose metadata names another billing account', async () => {
    const payment = recorded.getSubscriptionPayment.response;
    const api = dodoApi({
      [`GET /checkouts/${SESSION_ID}`]: recorded.getCheckoutSession.response,
      [`GET /payments/${PAYMENT_ID}`]: {
        ...payment,
        metadata: { ...payment.metadata, billfn_billing_account_id: 'ba_attacker' }
      }
    });

    await expect(provider(api.fetchMock).verifyCheckout?.(verifyInput(monthPrice))).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT'
    });
  });

  it('does not link a client-sent payment id to the subscription it verifies', async () => {
    const api = dodoApi({ [`GET /subscriptions/${SUBSCRIPTION_ID}`]: recorded.getSubscription.response });

    const state = await provider(api.fetchMock).verifyCheckout?.(
      verifyInput(monthPrice, { payload: { subscription_id: SUBSCRIPTION_ID, payment_id: 'pay_someone_else' } })
    );

    expect(paths(api.calls)).toEqual([`GET /subscriptions/${SUBSCRIPTION_ID}`]);
    expect(state?.providerSubscriptionId).toBe(SUBSCRIPTION_ID);
    expect(state?.providerChargeId).toBeUndefined();
  });

  it('encodes identifiers so a client-sent id cannot address another Dodo endpoint', async () => {
    const api = dodoApi({});
    await expect(
      provider(api.fetchMock).verifyCheckout?.(verifyInput(monthPrice, { payload: { subscription_id: '../refunds' } }))
    ).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });
    expect(api.calls[0]?.url).toBe(`${TEST_HOST}/subscriptions/..%2Frefunds`);
  });
});

describe('fetchSubscription -> GET /subscriptions/{id}', () => {
  it.each([
    ['pending', 'pending', 'pending', false],
    ['active', 'active', 'succeeded', true],
    ['on_hold', 'paused', 'succeeded', true],
    ['paused', 'paused', 'succeeded', true],
    ['past_due', 'grace', 'succeeded', true],
    ['cancelled', 'canceled', 'succeeded', false],
    ['failed', 'failed', 'failed', false],
    ['expired', 'expired', 'succeeded', false]
  ])('maps Dodo status %s to %s', async (dodoStatus, subscriptionStatus, checkoutStatus, autoRenew) => {
    const api = dodoApi({
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: { ...recorded.getSubscription.response, status: dodoStatus }
    });

    const state = await provider(api.fetchMock).fetchSubscription?.({ subscription: subscription(), plan, price: monthPrice });

    expect(state).toMatchObject({ subscriptionStatus, checkoutStatus, autoRenew, providerSubscriptionId: SUBSCRIPTION_ID });
  });
});

describe('cancelSubscription and resumeSubscription -> PATCH /subscriptions/{id}', () => {
  it('cancels at the next billing date, keeping the subscription active until then', async () => {
    const api = dodoApi({
      [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: { ...recorded.getSubscription.response, cancel_at_next_billing_date: true }
    });

    const result = await provider(api.fetchMock).cancelSubscription?.({ subscription: subscription() });

    expect(api.calls).toEqual([
      expect.objectContaining({ method: 'PATCH', body: { cancel_at_next_billing_date: true } })
    ]);
    expect(result).toMatchObject({
      operationStatus: 'applied',
      billingState: { subscriptionStatus: 'active', autoRenew: false, currentPeriodEnd: '2026-12-17T09:01:00Z' }
    });
  });

  it('resumes a paused subscription with status active sent alone', async () => {
    const api = dodoApi({ [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: recorded.getSubscription.response });

    const result = await provider(api.fetchMock).resumeSubscription?.({ subscription: subscription({ status: 'paused' }) });

    expect(api.calls).toEqual([expect.objectContaining({ method: 'PATCH', body: { status: 'active' } })]);
    expect(result).toMatchObject({ operationStatus: 'applied', billingState: { subscriptionStatus: 'active', autoRenew: true } });
  });

  it('resumes a paused subscription that is also scheduled to cancel, clearing the cancel in a second request', async () => {
    let stored: Record<string, unknown> = { ...recorded.getSubscription.response, status: 'on_hold', cancel_at_next_billing_date: true };
    const api = dodoApi({
      [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: (body: Record<string, unknown> | undefined) => {
        stored = { ...stored, ...body };
        return Response.json(stored);
      }
    });

    const result = await provider(api.fetchMock).resumeSubscription?.({
      subscription: subscription({ status: 'paused', autoRenew: false })
    });

    expect(api.calls.map((call) => call.body)).toEqual([{ status: 'active' }, { cancel_at_next_billing_date: false }]);
    expect(result).toMatchObject({ operationStatus: 'applied', billingState: { subscriptionStatus: 'active', autoRenew: true } });
  });

  it('records a resumed subscription that still ends when clearing its scheduled cancel fails', async () => {
    const api = dodoApi({
      [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: (body: Record<string, unknown> | undefined) =>
        body?.status === 'active'
          ? Response.json({ ...recorded.getSubscription.response, cancel_at_next_billing_date: true })
          : new Response('unavailable', { status: 503 })
    });

    const result = await provider(api.fetchMock).resumeSubscription?.({
      subscription: subscription({ status: 'paused', autoRenew: false })
    });

    expect(api.calls).toHaveLength(2);
    expect(result).toMatchObject({
      operationStatus: 'requires_action',
      billingState: { subscriptionStatus: 'active', autoRenew: false },
      clientAction: { metadata: { action: 'contact-support' } }
    });
  });

  it('records the resumed state when the request clearing the scheduled cancel gets no answer', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (String(init?.body).includes('"status"')) {
        return Response.json({ ...recorded.getSubscription.response, cancel_at_next_billing_date: true });
      }
      throw new TypeError('fetch failed');
    }) as typeof fetch;

    const result = await provider(fetchMock).resumeSubscription?.({
      subscription: subscription({ status: 'paused', autoRenew: false })
    });

    expect(result).toMatchObject({
      operationStatus: 'requires_action',
      billingState: { subscriptionStatus: 'active', autoRenew: false }
    });
  });
});

describe('cancel and resume answers that are not the subscription', () => {
  it.each([
    ['JSON null', () => Response.json(null)],
    ['an empty object', () => Response.json({})],
    ['an array', () => Response.json([])],
    ['an empty body', () => new Response('', { status: 200 })],
    ['another subscription', () => Response.json({ ...recorded.getSubscription.response, subscription_id: 'sub_other' })]
  ])('keeps an accepted cancellation applied without a state when Dodo answers %s', async (_label, answer) => {
    const api = dodoApi({ [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: answer });

    const result = await provider(api.fetchMock).cancelSubscription?.({ subscription: subscription() });

    expect(result?.operationStatus).toBe('applied');
    expect(result?.billingState).toBeUndefined();
  });

  it('keeps an accepted resume applied without a fabricated pending state when Dodo answers an empty object', async () => {
    const api = dodoApi({ [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: {} });

    const result = await provider(api.fetchMock).resumeSubscription?.({ subscription: subscription({ autoRenew: false }) });

    expect(result?.operationStatus).toBe('applied');
    expect(result?.billingState).toBeUndefined();
  });

  it('clears the scheduled cancel of a held subscription and records no state when the second answer is empty', async () => {
    const api = dodoApi({
      [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: (body: Record<string, unknown> | undefined) =>
        body?.status === 'active'
          ? Response.json({ ...recorded.getSubscription.response, cancel_at_next_billing_date: true })
          : Response.json({})
    });

    const result = await provider(api.fetchMock).resumeSubscription?.({
      subscription: subscription({ status: 'paused', autoRenew: false })
    });

    expect(api.calls.map((call) => call.body)).toEqual([{ status: 'active' }, { cancel_at_next_billing_date: false }]);
    expect(result?.operationStatus).toBe('applied');
    expect(result?.billingState).toBeUndefined();
  });

  it('asks for support without a state when the resume answer is unreadable and clearing the cancel fails', async () => {
    const api = dodoApi({
      [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: (body: Record<string, unknown> | undefined) =>
        body?.status === 'active' ? Response.json(null) : new Response('unavailable', { status: 503 })
    });

    const result = await provider(api.fetchMock).resumeSubscription?.({
      subscription: subscription({ status: 'paused', autoRenew: false })
    });

    expect(api.calls).toHaveLength(2);
    expect(result).toMatchObject({ operationStatus: 'requires_action', clientAction: { metadata: { action: 'contact-support' } } });
    expect(result?.billingState).toBeUndefined();
  });
});

describe('changeSubscription -> POST /subscriptions/{id}/change-plan', () => {
  const changeInput = () => ({
    subscription: subscription(),
    currentPlan: plan,
    currentPrice: monthPrice,
    targetPlan: plan,
    targetPrice: { ...monthPrice, priceId: 'price_nucleus_year', providerProductId: 'pdt_nucleus_year', interval: 'year' as const },
    effectiveAt: 'immediate' as const,
    prorationBehavior: 'prorate' as const
  });

  it('reads the subscription after the change, because change-plan answers with payment handles only', async () => {
    const changed = { ...recorded.getSubscription.response, product_id: 'pdt_nucleus_year' };
    const api = dodoApi({
      [`POST /subscriptions/${SUBSCRIPTION_ID}/change-plan`]: recorded.changePlan.response,
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: changed
    });

    const result = await provider(api.fetchMock).changeSubscription?.(changeInput());

    expect(paths(api.calls)).toEqual([
      `POST /subscriptions/${SUBSCRIPTION_ID}/change-plan`,
      `GET /subscriptions/${SUBSCRIPTION_ID}`
    ]);
    expect(api.calls[0]?.body).toEqual({
      product_id: 'pdt_nucleus_year',
      proration_billing_mode: 'prorated_immediately',
      quantity: 1,
      effective_at: 'immediately'
    });
    expect(result).toMatchObject({
      operationStatus: 'applied',
      billingState: { subscriptionStatus: 'active', providerSubscriptionId: SUBSCRIPTION_ID, autoRenew: true },
      raw: { changePlan: recorded.changePlan.response, subscription: changed }
    });
  });

  /** The stored subscription's own state, which lets BillFn record the target price and changes nothing else. */
  const storedState = {
    subscriptionStatus: 'active',
    checkoutStatus: 'succeeded',
    providerSubscriptionId: SUBSCRIPTION_ID,
    providerChargeId: PAYMENT_ID,
    currentPeriodStart: '2026-11-10T00:00:00.000Z',
    currentPeriodEnd: '2026-12-10T00:00:00.000Z',
    autoRenew: false
  };
  const storedSubscription = () =>
    subscription({ currentPeriodStart: storedState.currentPeriodStart, currentPeriodEnd: storedState.currentPeriodEnd, autoRenew: false });

  it('keeps an applied change applied with the stored state when the follow-up read fails', async () => {
    const api = dodoApi({
      [`POST /subscriptions/${SUBSCRIPTION_ID}/change-plan`]: recorded.changePlan.response,
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: () => new Response('unavailable', { status: 503 })
    });

    const result = await provider(api.fetchMock).changeSubscription?.({ ...changeInput(), subscription: storedSubscription() });

    expect(result?.operationStatus).toBe('applied');
    expect(result?.billingState).toStrictEqual(storedState);
  });

  it.each([
    [
      'headers',
      () => new Promise<Response>(() => {}),
      { subscriptionReadError: { status: 0, body: expect.stringContaining('read can be retried') } }
    ],
    [
      'body',
      async () => new Response(new ReadableStream()),
      { subscription: { bodyError: 'Dodo response body did not arrive before the deadline' } }
    ]
  ])('keeps a plan change applied when the follow-up read stalls before its %s', async (_label, answerRead, raw) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === 'POST' ? Response.json(recorded.changePlan.response) : answerRead()
      ) as typeof fetch;
      const pending = provider(fetchMock).changeSubscription?.({ ...changeInput(), subscription: storedSubscription() });
      await Promise.all([
        expect(pending).resolves.toMatchObject({ operationStatus: 'applied', billingState: storedState, raw }),
        vi.advanceTimersByTimeAsync(DODO_PROVIDER_HTTP_DEADLINE_MS)
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives no state for a next-renewal change whose follow-up read fails, since nothing changes now', async () => {
    const api = dodoApi({
      [`POST /subscriptions/${SUBSCRIPTION_ID}/change-plan`]: recorded.changePlan.response,
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: () => new Response('unavailable', { status: 503 })
    });

    const result = await provider(api.fetchMock).changeSubscription?.({ ...changeInput(), effectiveAt: 'next_renewal' });

    expect(result?.operationStatus).toBe('applied');
    expect(result?.billingState).toBeUndefined();
  });

  it.each([
    [
      'the request gets no answer',
      () => Promise.reject(new TypeError('fetch failed')),
      { subscriptionReadError: { status: 0 } }
    ],
    [
      'the body read fails',
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.reject(new DOMException('The operation was aborted', 'AbortError'))
        } as unknown as Response),
      { subscription: { bodyError: expect.stringContaining('AbortError') } }
    ],
    [
      'the body is not JSON',
      () => Promise.resolve(new Response('<html>gateway</html>', { status: 200 })),
      { subscription: { bodyError: expect.stringContaining('SyntaxError') } }
    ],
    ['the body is JSON null', () => Promise.resolve(Response.json(null)), { subscription: { body: null } }],
    ['the body is an empty object', () => Promise.resolve(Response.json({})), { subscription: {} }],
    ['the body is an array', () => Promise.resolve(Response.json([])), { subscription: { body: [] } }],
    [
      'the subscription has a status Dodo does not define',
      () => Promise.resolve(Response.json({ ...recorded.getSubscription.response, status: 'migrating' })),
      { subscription: { status: 'migrating' } }
    ],
    [
      'Dodo answers with another subscription',
      () => Promise.resolve(Response.json({ ...recorded.getSubscription.response, subscription_id: 'sub_other' })),
      { subscription: { subscription_id: 'sub_other' } }
    ]
  ])('keeps an applied change applied with the stored state, not the answer, when %s on the follow-up read', async (_label, answerRead, raw) => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      init?.method === 'POST' ? Response.json(recorded.changePlan.response) : answerRead()
    ) as typeof fetch;

    const result = await provider(fetchMock).changeSubscription?.({ ...changeInput(), subscription: storedSubscription() });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ operationStatus: 'applied', raw: { changePlan: recorded.changePlan.response, ...raw } });
    expect(result?.billingState).toStrictEqual(storedState);
  });

  it('reads the subscription after a change Dodo accepted with an unreadable answer', async () => {
    const api = dodoApi({
      [`POST /subscriptions/${SUBSCRIPTION_ID}/change-plan`]: () => new Response('ok', { status: 200 }),
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: recorded.getSubscription.response
    });

    const result = await provider(api.fetchMock).changeSubscription?.(changeInput());

    expect(result).toMatchObject({ operationStatus: 'applied', billingState: { subscriptionStatus: 'active' } });
  });

  it('records no state for an immediate replacement checkout whose cancellation answer is not the subscription', async () => {
    const api = dodoApi({
      [`POST /subscriptions/${SUBSCRIPTION_ID}/change-plan`]: () => new Response('not allowed', { status: 405 }),
      [`PATCH /subscriptions/${SUBSCRIPTION_ID}`]: {}
    });

    const result = await provider(api.fetchMock).changeSubscription?.(changeInput());

    expect(result).toMatchObject({
      operationStatus: 'requires_action',
      clientAction: { metadata: { action: 'replacement-checkout' } }
    });
    expect(result?.billingState).toBeUndefined();
  });

  it('hands the customer a plan-change payment link when Dodo returns one', async () => {
    const api = dodoApi({
      [`POST /subscriptions/${SUBSCRIPTION_ID}/change-plan`]: {
        ...recorded.changePlan.response,
        payment_id: 'pay_change_1',
        payment_link: 'https://test.checkout.dodopayments.com/pay_change_1'
      }
    });

    const result = await provider(api.fetchMock).changeSubscription?.(changeInput());

    expect(paths(api.calls)).toEqual([`POST /subscriptions/${SUBSCRIPTION_ID}/change-plan`]);
    expect(result).toMatchObject({
      operationStatus: 'requires_action',
      clientAction: { type: 'redirect', url: 'https://test.checkout.dodopayments.com/pay_change_1' }
    });
  });
});

describe('refundCharge -> POST /refunds', () => {
  const refundInput = (patch: Record<string, unknown> = {}) => ({
    billingAccount,
    subscription: subscription(),
    mode: 'full' as const,
    reason: 'requested_by_customer',
    ...patch
  });

  it('refunds a whole payment by its id', async () => {
    const api = dodoApi({ 'POST /refunds': { ...recorded.createRefund.response, is_partial: false, amount: 1200 } });

    const result = await provider(api.fetchMock).refundCharge?.(refundInput());

    expect(api.calls).toEqual([
      expect.objectContaining({ method: 'POST', body: { payment_id: PAYMENT_ID, reason: 'requested_by_customer' } })
    ]);
    expect(result).toMatchObject({ operationStatus: 'applied', providerRefundId: recorded.createRefund.response.refund_id });
  });

  it('returns no billing state for a succeeded full refund; its refund.succeeded webhook revokes the purchase', async () => {
    const api = dodoApi({ 'POST /refunds': { ...recorded.createRefund.response, status: 'succeeded', is_partial: false } });

    const result = await provider(api.fetchMock).refundCharge?.(
      refundInput({ subscription: subscription({ providerSubscriptionId: undefined, autoRenew: false }) })
    );

    expect(result?.billingState).toBeUndefined();
  });

  it('refunds part of a payment through its line items in the currency the customer paid', async () => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /payments/${PAYMENT_ID}/line-items`]: recorded.getPaymentLineItems.response,
      'POST /refunds': recorded.createRefund.response
    });

    await provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 600 }));

    expect(paths(api.calls)).toEqual([`GET /payments/${PAYMENT_ID}`, `GET /payments/${PAYMENT_ID}/line-items`, 'POST /refunds']);
    // Without the currency, Dodo answers the line items in the settlement currency.
    expect(new URL(api.calls[1]!.url).searchParams.get('currency')).toBe('USD');
    expect(api.calls[2]?.body).toEqual({
      payment_id: PAYMENT_ID,
      reason: 'requested_by_customer',
      items: [{ item_id: 'pdt_nucleus_month', amount: 600 }],
      currency: 'USD'
    });
  });

  it('refuses a partial amount in another currency than the payment before creating a refund', async () => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /payments/${PAYMENT_ID}/line-items`]: recorded.getPaymentLineItems.response,
      'POST /refunds': recorded.createRefund.response
    });

    await expect(
      provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 600, currency: 'JPY' }))
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR', details: { refundCurrency: 'JPY', paymentCurrency: 'USD' } });
    expect(paths(api.calls)).not.toContain('POST /refunds');
  });

  it('refuses a partial refund whose currency is not a string', async () => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /payments/${PAYMENT_ID}/line-items`]: recorded.getPaymentLineItems.response,
      'POST /refunds': recorded.createRefund.response
    });

    await expect(
      provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 600, currency: null }))
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(paths(api.calls)).not.toContain('POST /refunds');
  });

  it('refunds a partial amount whose currency is the payment\'s', async () => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /payments/${PAYMENT_ID}/line-items`]: recorded.getPaymentLineItems.response,
      'POST /refunds': recorded.createRefund.response
    });

    await provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 600, currency: 'usd' }));

    expect(paths(api.calls)).toContain('POST /refunds');
  });

  it.each([
    ['more than remains refundable', { amount: 1201 }, recorded.getPaymentLineItems.response],
    ['a non-integer amount', { amount: 10.5 }, recorded.getPaymentLineItems.response],
    ['a payment method without partial refunds', { amount: 600 }, { ...recorded.getPaymentLineItems.response, partial_refund_allowed: false }]
  ])('refuses %s before creating a refund', async (_label, patch, lineItems) => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /payments/${PAYMENT_ID}/line-items`]: lineItems,
      'POST /refunds': recorded.createRefund.response
    });

    await expect(
      provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', ...patch }))
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(paths(api.calls)).not.toContain('POST /refunds');
  });

  it.each([
    // Adaptive pricing: the customer paid in INR for a price BillFn records in USD.
    ['was paid in another currency than the catalog price', { ...recorded.getSubscriptionPayment.response, currency: 'INR', settlement_currency: 'USD' }],
    [
      'does not record the catalog price currency',
      { ...recorded.getOneTimePayment.response, metadata: { ...recorded.getOneTimePayment.response.metadata, billfn_currency: undefined } }
    ],
    // A plan change moved the subscription to another price, whose currency BillFn records the refund in.
    [
      'was made for another catalog price than the subscription has now',
      { ...recorded.getSubscriptionPayment.response, metadata: { ...recorded.getSubscriptionPayment.response.metadata, billfn_price_id: 'price_nucleus_year_eur' } }
    ]
  ])('refuses a partial refund of a payment that %s before any line items or refund', async (_label, payment) => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: payment,
      [`GET /payments/${PAYMENT_ID}/line-items`]: recorded.getPaymentLineItems.response,
      'POST /refunds': recorded.createRefund.response
    });

    await expect(
      provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 600 }))
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(paths(api.calls)).toEqual([`GET /payments/${PAYMENT_ID}`]);
  });

  it('takes the checkout markers of a renewal payment from its subscription and refunds in the paid currency', async () => {
    const renewal = { ...recorded.getSubscriptionPayment.response, payment_id: 'pay_renewal_1', checkout_session_id: null, metadata: {} };
    const api = dodoApi({
      'GET /payments/pay_renewal_1': renewal,
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: recorded.getSubscription.response,
      'GET /payments/pay_renewal_1/line-items': recorded.getPaymentLineItems.response,
      'POST /refunds': recorded.createRefund.response
    });

    await provider(api.fetchMock).refundCharge?.(
      refundInput({ subscription: subscription({ providerChargeId: 'pay_renewal_1' }), mode: 'custom', amount: 600 })
    );

    expect(paths(api.calls)).toEqual([
      'GET /payments/pay_renewal_1',
      `GET /subscriptions/${SUBSCRIPTION_ID}`,
      'GET /payments/pay_renewal_1/line-items',
      'POST /refunds'
    ]);
    expect(api.calls[3]?.body).toMatchObject({ payment_id: 'pay_renewal_1', currency: 'USD' });
  });

  it.each([
    ['records no checkout markers', {}],
    ['records another catalog price', { ...recorded.getSubscription.response.metadata, billfn_price_id: 'price_nucleus_year_eur' }],
    ['records another currency', { ...recorded.getSubscription.response.metadata, billfn_currency: 'EUR' }]
  ])('refuses a partial refund of a renewal payment whose subscription %s', async (_label, subscriptionMetadata) => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: { ...recorded.getSubscriptionPayment.response, metadata: {} },
      [`GET /subscriptions/${SUBSCRIPTION_ID}`]: { ...recorded.getSubscription.response, metadata: subscriptionMetadata },
      [`GET /payments/${PAYMENT_ID}/line-items`]: recorded.getPaymentLineItems.response,
      'POST /refunds': recorded.createRefund.response
    });

    await expect(
      provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 600 }))
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(paths(api.calls)).toEqual([`GET /payments/${PAYMENT_ID}`, `GET /subscriptions/${SUBSCRIPTION_ID}`]);
  });

  it('keeps a refund Dodo accepted applied when its answer is unreadable', async () => {
    const api = dodoApi({ 'POST /refunds': () => new Response('<html>gateway</html>', { status: 200 }) });

    const result = await provider(api.fetchMock).refundCharge?.(refundInput());

    expect(result).toMatchObject({ operationStatus: 'applied', raw: { bodyError: expect.stringContaining('SyntaxError') } });
    expect(result?.providerRefundId).toBeUndefined();
  });

  it('refuses line items Dodo answers in another currency than the one requested', async () => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /payments/${PAYMENT_ID}/line-items`]: { ...recorded.getPaymentLineItems.response, currency: 'EUR' },
      'POST /refunds': recorded.createRefund.response
    });

    await expect(
      provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 600 }))
    ).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });
    expect(paths(api.calls)).not.toContain('POST /refunds');
  });

  it('surfaces a refund Dodo reports as failed instead of recording it as applied', async () => {
    const api = dodoApi({ 'POST /refunds': { ...recorded.createRefund.response, status: 'failed' } });

    await expect(provider(api.fetchMock).refundCharge?.(refundInput())).rejects.toMatchObject({
      code: 'BILLFN_PROVIDER_ERROR'
    });
  });

  it.each([
    ['a fractional balance', 10.5],
    ['a negative balance', -1],
    // 2^53 round-trips through JSON and is not a safe integer, so it must not be sent as minor units.
    ['an unsafe balance', Number.MAX_SAFE_INTEGER + 1]
  ])('refuses a partial refund when a line item has %s, before creating a refund', async (_label, refundableAmount) => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /payments/${PAYMENT_ID}/line-items`]: {
        ...recorded.getPaymentLineItems.response,
        items: [
          { items_id: 'item_seat', refundable_amount: 400 },
          { items_id: 'item_bad', refundable_amount: refundableAmount }
        ]
      },
      'POST /refunds': recorded.createRefund.response
    });

    await expect(provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 100 }))).rejects.toMatchObject({
      code: 'BILLFN_PROVIDER_ERROR',
      retryable: false,
      message: expect.stringContaining('nonnegative integer')
    });
    // The first line item could cover the amount. The malformed balance still refuses the refund.
    expect(paths(api.calls)).toEqual([`GET /payments/${PAYMENT_ID}`, `GET /payments/${PAYMENT_ID}/line-items`]);
  });

  it('splits a partial refund across valid line items and skips a zero balance', async () => {
    const api = dodoApi({
      [`GET /payments/${PAYMENT_ID}`]: recorded.getSubscriptionPayment.response,
      [`GET /payments/${PAYMENT_ID}/line-items`]: {
        ...recorded.getPaymentLineItems.response,
        items: [
          { items_id: 'item_seat', refundable_amount: 400 },
          { items_id: 'item_tax', refundable_amount: 0 },
          { items_id: 'item_addon', refundable_amount: 900 }
        ]
      },
      'POST /refunds': recorded.createRefund.response
    });

    await provider(api.fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 700 }));

    expect(api.calls.at(-1)?.body).toMatchObject({
      payment_id: PAYMENT_ID,
      currency: 'USD',
      items: [
        { item_id: 'item_seat', amount: 400 },
        { item_id: 'item_addon', amount: 300 }
      ]
    });
  });

  it('treats a stalled line-item body as a retryable read and does not send the refund', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        if (String(input).includes('/line-items')) {
          return { ok: true, status: 200, text: () => new Promise<string>(() => {}) } as unknown as Response;
        }
        return Response.json(recorded.getSubscriptionPayment.response);
      }) as typeof fetch;
      const pending = provider(fetchMock).refundCharge?.(refundInput({ mode: 'custom', amount: 600 }));
      await Promise.all([
        expect(pending).rejects.toMatchObject({
          code: 'BILLFN_PROVIDER_ERROR',
          retryable: true,
          message: expect.stringContaining('read can be retried')
        }),
        vi.advanceTimersByTimeAsync(DODO_PROVIDER_HTTP_DEADLINE_MS)
      ]);
      expect(vi.mocked(fetchMock).mock.calls.map((call) => String(call[0]))).not.toEqual(
        expect.arrayContaining([expect.stringContaining('/refunds')])
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a refund request that gets no response as an unknown outcome', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(() => new Promise<Response>(() => {})) as typeof fetch;
      const pending = provider(fetchMock).refundCharge?.(refundInput());
      await Promise.all([
        expect(pending).rejects.toMatchObject({
          code: 'BILLFN_PROVIDER_ERROR',
          retryable: false,
          message: expect.stringContaining('whether the change was applied is unknown')
        }),
        vi.advanceTimersByTimeAsync(DODO_PROVIDER_HTTP_DEADLINE_MS)
      ]);
      expect(vi.mocked(fetchMock).mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a refund Dodo accepted applied when the success body does not arrive before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {})
      }) as unknown as Response) as typeof fetch;
      const pending = provider(fetchMock).refundCharge?.(refundInput());
      await Promise.all([
        expect(pending).resolves.toMatchObject({
          operationStatus: 'applied',
          raw: { bodyError: 'Dodo accepted the change but the response body did not arrive before the deadline' }
        }),
        vi.advanceTimersByTimeAsync(DODO_PROVIDER_HTTP_DEADLINE_MS)
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('restorePurchases and importSubscription', () => {
  it('restores a one-time purchase from its payment and cart', async () => {
    const api = dodoApi({ [`GET /payments/${PAYMENT_ID}`]: recorded.getOneTimePayment.response });

    const states = await provider(api.fetchMock).restorePurchases?.({
      billingAccount,
      plan,
      price: lifetimePrice,
      purchaseReference: PAYMENT_ID
    });

    expect(states).toEqual([
      expect.objectContaining({ subscriptionStatus: 'active', checkoutStatus: 'succeeded', providerChargeId: PAYMENT_ID, autoRenew: false })
    ]);
  });

  it('imports a subscription by its id', async () => {
    const api = dodoApi({ [`GET /subscriptions/${SUBSCRIPTION_ID}`]: recorded.getSubscription.response });

    const state = await provider(api.fetchMock).importSubscription?.({ providerReference: SUBSCRIPTION_ID, billingAccount, plan });

    expect(state).toMatchObject({
      subscriptionStatus: 'active',
      providerSubscriptionId: SUBSCRIPTION_ID,
      currentPeriodEnd: '2026-12-17T09:01:00Z'
    });
  });

  it.each([404, 400, 422])('preserves import HTTP %i when the error body stalls', async (status) => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response(new ReadableStream(), { status })) as typeof fetch;
      const pending = provider(fetchMock).importSubscription?.({ providerReference: SUBSCRIPTION_ID, billingAccount, plan });
      await Promise.all([
        status === 404
          ? expect(pending).resolves.toBeNull()
          : expect(pending).rejects.toMatchObject({
            code: 'BILLFN_VALIDATION_ERROR',
            retryable: false,
            details: { status }
          }),
        vi.advanceTimersByTimeAsync(DODO_PROVIDER_HTTP_DEADLINE_MS)
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseWebhook with recorded Dodo payloads', () => {
  const secretBytes = Buffer.from('dodo-contract-webhook-secret');
  const webhookSecret = `whsec_${secretBytes.toString('base64')}`;

  async function parse(payload: unknown, fetchImpl?: typeof fetch) {
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secretBytes).update(`msg_contract.${timestamp}.${rawBody}`).digest('base64');
    const events = await createDodoProvider({ apiKey: 'dodo_test_key', webhookSecret, fetch: fetchImpl }).parseWebhook?.({
      rawBody,
      headers: new Headers({ 'webhook-id': 'msg_contract', 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` })
    });
    return events![0]!;
  }

  it.each([
    ['charges a subscription', { subscription_id: 'sub_mixed' }],
    ['is flagged multi-subscription', { subscription_id: null, subscription_ids: [], is_multi_subscription: true }]
  ])('names no product from the cart of a payment that %s', async (_name, patch) => {
    const payment = recorded.webhooks.paymentSucceededOneTime;
    const event = await parse({
      ...payment,
      data: { ...payment.data, ...patch, product_cart: [{ product_id: 'pdt_nucleus_lifetime', quantity: 1 }] }
    });

    expect(event.priceId).toBeUndefined();
  });

  it('marks a checkout reference read from metadata as metadata, and Dodo\'s own one as the provider\'s', async () => {
    const fromMetadata = await parse(recorded.webhooks.subscriptionPastDue);
    const fromDodo = await parse({
      ...recorded.webhooks.subscriptionPastDue,
      data: { ...recorded.webhooks.subscriptionPastDue.data, checkout_session_id: 'cks_native' }
    });

    expect(fromMetadata).toMatchObject({ checkoutReferenceId: 'chk_123', checkoutReferenceSource: 'metadata' });
    expect(fromDodo).toMatchObject({ checkoutReferenceId: 'cks_native', checkoutReferenceSource: 'provider' });
  });

  it('maps subscription.past_due to grace, names its product (not the checkout price) and the session', async () => {
    const event = await parse(recorded.webhooks.subscriptionPastDue);

    // The metadata names the checkout price, which a plan change to another price of the same product leaves stale.
    expect(recorded.webhooks.subscriptionPastDue.data.metadata.billfn_price_id).toBe('price_nucleus_month');
    expect(event).toMatchObject({
      providerEventId: 'msg_contract',
      type: 'subscription.past_due',
      occurredAt: '2026-12-17T09:05:00Z',
      priceId: 'pdt_nucleus_month',
      providerSubscriptionId: SUBSCRIPTION_ID,
      checkoutReferenceId: 'chk_123',
      billingState: { subscriptionStatus: 'grace', autoRenew: true }
    });
  });

  it('names the product, not the stale checkout price, after a plan change', async () => {
    const event = await parse(recorded.webhooks.subscriptionPlanChanged);

    expect(event.priceId).toBe('pdt_nucleus_year');
    expect(event.billingState).toMatchObject({ subscriptionStatus: 'active', currentPeriodEnd: '2027-12-01T12:00:00Z' });
  });

  it('links the charge of a subscription payment, which Dodo charges only while it renews', async () => {
    const event = await parse(recorded.webhooks.paymentSucceededForSubscription);

    expect(event.priceId).toBeUndefined();
    expect(event).toMatchObject({
      providerChargeId: PAYMENT_ID,
      providerSubscriptionId: SUBSCRIPTION_ID,
      checkoutReferenceId: SESSION_ID,
      billingState: { subscriptionStatus: 'active', providerSubscriptionId: SUBSCRIPTION_ID, providerChargeId: PAYMENT_ID, autoRenew: true }
    });
  });

  it('names a subscription payment\'s product only from its product_id, never from its cart or the checkout price', async () => {
    // Dodo's cart lists a payment's one-time items, so it does not name the subscription's product; the
    // subscription keeps its stored plan, and its own events carry product_id.
    const payment = recorded.webhooks.paymentSucceededForSubscription;
    const fromCart = await parse({
      ...payment,
      data: { ...payment.data, product_cart: [{ product_id: 'pdt_nucleus_month', quantity: 1 }] }
    });
    const fromProduct = await parse({ ...payment, data: { ...payment.data, product_id: 'pdt_nucleus_month' } });

    expect(fromCart.priceId).toBeUndefined();
    expect(fromProduct.priceId).toBe('pdt_nucleus_month');
  });

  it('leaves a declined renewal payment to the subscription events instead of failing the subscription', async () => {
    const event = await parse(recorded.webhooks.paymentFailedForRenewal);

    expect(event.providerSubscriptionId).toBe(SUBSCRIPTION_ID);
    expect(event.billingState).toBeUndefined();
  });

  it('maps a one-time payment and names its catalog price', async () => {
    const event = await parse(recorded.webhooks.paymentSucceededOneTime);

    expect(event).toMatchObject({
      priceId: 'price_nucleus_lifetime',
      providerChargeId: PAYMENT_ID,
      billingState: { subscriptionStatus: 'active', checkoutStatus: 'succeeded', autoRenew: false }
    });
  });

  /** A Dodo read double: answers GET /payments/:id and /subscriptions/:id from the given records. */
  function dodoReads(records: Record<string, unknown>) {
    return vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      return path in records ? Response.json(records[path]) : Response.json({ message: 'not found' }, { status: 404 });
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  }
  const oneTimePayment = recorded.getOneTimePayment.response;
  const refund = recorded.webhooks.refundSucceeded;
  const dispute = (type: string, status: string) => ({
    business_id: refund.business_id,
    type,
    timestamp: '2026-11-19T10:00:00Z',
    data: { payload_type: 'Dispute', dispute_id: 'dsp_contract', payment_id: oneTimePayment.payment_id, dispute_status: status, amount: '9900', currency: 'USD' }
  });

  it('revokes a one-time purchase on a full refund, after reading its payment from Dodo', async () => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: oneTimePayment });

    const event = await parse(refund, fetchMock);

    expect(event).toMatchObject({
      type: 'refund.succeeded',
      providerChargeId: oneTimePayment.payment_id,
      billingState: { subscriptionStatus: 'canceled', providerChargeId: oneTimePayment.payment_id, autoRenew: false }
    });
    expect(event.billingState?.providerSubscriptionId).toBeUndefined();
    expect(event.priceId).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['one subscription', recorded.getSubscriptionPayment.response],
    ['several subscriptions', { ...recorded.getOneTimePayment.response, subscription_ids: ['sub_a', 'sub_b'], is_multi_subscription: true }]
  ])('leaves a refunded charge of %s to Dodo\'s subscription events', async (_name, payment) => {
    const fetchMock = dodoReads({ [`/payments/${payment.payment_id}`]: payment });

    const event = await parse({ ...refund, data: { ...refund.data, payment_id: payment.payment_id } }, fetchMock);

    expect(event.billingState).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('links a revocation only through its charge, never through checkout metadata on the refund', async () => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: oneTimePayment });

    const event = await parse(
      { ...refund, data: { ...refund.data, metadata: { billfn_checkout_session_id: 'chk_someone_else' } } },
      fetchMock
    );

    expect(event.checkoutReferenceId).toBeUndefined();
    expect(event.providerSubscriptionId).toBeUndefined();
    expect(event.billingState).toMatchObject({ subscriptionStatus: 'canceled', providerChargeId: oneTimePayment.payment_id });
  });

  it('fails the delivery for a partial refund the payment does not list yet, so Dodo retries it', async () => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: { ...oneTimePayment, refund_status: 'partial' } });

    await expect(parse({ ...refund, data: { ...refund.data, is_partial: true, amount: 600 } }, fetchMock)).rejects.toMatchObject({
      code: 'BILLFN_PROVIDER_ERROR'
    });
  });

  it('keeps the purchase on a partial refund that leaves part of the payment paid', async () => {
    const listed = { refund_id: refund.data.refund_id, status: 'succeeded', is_partial: true, amount: 600 };
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: { ...oneTimePayment, refund_status: 'partial', refunds: [listed] } });

    const event = await parse({ ...refund, data: { ...refund.data, is_partial: true, amount: 600 } }, fetchMock);

    expect(event.billingState).toBeUndefined();
  });

  it('keeps the purchase while Dodo reports the payment only partially refunded, whatever the amounts', async () => {
    // Amounts in an adaptive currency are not comparable with the payment total; Dodo's refund_status decides.
    const earlier = { refund_id: 'ref_first', status: 'succeeded', is_partial: true, amount: 9300, currency: 'USD' };
    const rest = { refund_id: 'ref_rest', status: 'succeeded', is_partial: true, amount: 600, currency: 'USD' };
    const fetchMock = dodoReads({
      [`/payments/${oneTimePayment.payment_id}`]: { ...oneTimePayment, refund_status: 'partial', refunds: [earlier, rest] }
    });

    const event = await parse({ ...refund, data: { ...refund.data, refund_id: 'ref_rest', is_partial: true, amount: 600 } }, fetchMock);

    expect(event.billingState).toBeUndefined();
  });

  it('revokes when Dodo reports the payment fully refunded', async () => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: { ...oneTimePayment, refund_status: 'full' } });

    const event = await parse({ ...refund, data: { ...refund.data, refund_id: 'ref_rest', is_partial: true, amount: 600 } }, fetchMock);

    expect(event.billingState).toMatchObject({ subscriptionStatus: 'canceled' });
  });

  it.each([
    ['an opened dispute', dispute('dispute.opened', 'dispute_opened')],
    ['a won dispute', dispute('dispute.won', 'dispute_won')],
    ['a challenged dispute', dispute('dispute.challenged', 'dispute_challenged')]
  ])('leaves the purchase as it is for %s, without reading Dodo', async (_name, payload) => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: oneTimePayment });

    const event = await parse(payload, fetchMock);

    expect(event.billingState).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['dispute.lost', 'dispute_lost'],
    ['dispute.accepted', 'dispute_accepted']
  ])('revokes a one-time purchase on %s', async (type, status) => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: oneTimePayment });

    const event = await parse(dispute(type, status), fetchMock);

    expect(event.billingState).toMatchObject({ subscriptionStatus: 'canceled', providerChargeId: oneTimePayment.payment_id });
  });

  it.each([
    ['a payment answer that is not a record', { [`/payments/${recorded.getOneTimePayment.response.payment_id}`]: null }],
    ['another payment', { [`/payments/${recorded.getOneTimePayment.response.payment_id}`]: { ...recorded.getOneTimePayment.response, payment_id: 'pay_other' } }]
  ])('fails the delivery on %s instead of revoking', async (_name, records) => {
    const fetchMock = dodoReads(records);

    await expect(parse(refund, fetchMock)).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });
  });

  it('fails the delivery when the payment does not say whether it belongs to a subscription', async () => {
    const { subscription_id: _omitted, subscription_ids: _ids, ...unclassified } = oneTimePayment;
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: unclassified });

    await expect(parse(refund, fetchMock)).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });
  });

  it('revokes a one-time payment whose answer omits the optional subscription_id but lists no subscriptions', async () => {
    const { subscription_id: _omitted, ...withoutSubscriptionId } = oneTimePayment;
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: withoutSubscriptionId });

    const event = await parse(refund, fetchMock);

    expect(event.billingState).toMatchObject({ subscriptionStatus: 'canceled', providerChargeId: oneTimePayment.payment_id });
  });

  it('dates a revocation when its Dodo read started, not when the refund happened', async () => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: oneTimePayment });
    const before = Date.now();

    const event = await parse(refund, fetchMock);

    expect(event.occurredAt).not.toBe(refund.timestamp);
    expect(Date.parse(event.occurredAt!)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('dates a revocation with the configured clock', async () => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: oneTimePayment });
    const rawBody = JSON.stringify(refund);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secretBytes).update(`msg_contract.${timestamp}.${rawBody}`).digest('base64');

    const [event] = await createDodoProvider({
      apiKey: 'dodo_test_key',
      webhookSecret,
      fetch: fetchMock,
      now: () => new Date('2030-01-01T00:00:00.000Z')
    }).parseWebhook!({
      rawBody,
      headers: new Headers({ 'webhook-id': 'msg_contract', 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` })
    });

    expect(event!.occurredAt).toBe('2030-01-01T00:00:00.000Z');
  });

  it('revokes a refunded one-time restore even when the payment is flagged is_multi_subscription', async () => {
    const { subscription_ids: _ids, ...multi } = { ...oneTimePayment, is_multi_subscription: true, subscription_id: null };
    const refunded = { ...multi, refunds: [{ refund_id: 'ref_1', status: 'succeeded', is_partial: false }] };
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: refunded });

    const [restored] = await createDodoProvider({ apiKey: 'dodo_test_key', fetch: fetchMock }).restorePurchases!({
      billingAccount: { id: 'ba_user_123' },
      price: { kind: 'one_time', providerProductId: 'pdt_nucleus_lifetime' },
      purchaseReference: oneTimePayment.payment_id
    } as never);
    const event = await parse({ ...refund }, fetchMock);

    // The webhook has no price to go by and leaves a subscription-flagged payment alone; a restore has matched
    // the payment to its one-time price, so the refund revokes it.
    expect(event.billingState).toBeUndefined();
    expect(restored).toMatchObject({ subscriptionStatus: 'canceled', providerChargeId: oneTimePayment.payment_id });
  });

  it('refuses to restore a refunded cart that also charges a subscription, instead of canceling that subscription', async () => {
    const mixed = {
      ...oneTimePayment,
      subscription_id: SUBSCRIPTION_ID,
      subscription_ids: [SUBSCRIPTION_ID],
      refunds: [{ refund_id: 'ref_1', status: 'succeeded', is_partial: false }]
    };
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: mixed });

    await expect(
      createDodoProvider({ apiKey: 'dodo_test_key', fetch: fetchMock }).restorePurchases!({
        billingAccount: { id: 'ba_user_123' },
        price: { kind: 'one_time', providerProductId: 'pdt_nucleus_lifetime' },
        purchaseReference: oneTimePayment.payment_id
      } as never)
    ).rejects.toMatchObject({ code: 'BILLFN_CONFLICT', message: expect.stringContaining('also charges a subscription') });
  });

  it('revokes a reversed one-time restore whose payment omits both subscription fields', async () => {
    const { subscription_id: _id, subscription_ids: _ids, ...unclassified } = oneTimePayment;
    const reversed = { ...unclassified, refunds: [{ refund_id: 'ref_1', status: 'succeeded', is_partial: false }] };
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: reversed });

    const [restored] = await createDodoProvider({ apiKey: 'dodo_test_key', fetch: fetchMock }).restorePurchases!({
      billingAccount: { id: 'ba_user_123' },
      price: { kind: 'one_time', providerProductId: 'pdt_nucleus_lifetime' },
      purchaseReference: oneTimePayment.payment_id
    } as never);

    expect(restored).toMatchObject({ subscriptionStatus: 'canceled' });
  });

  it('fails a payment webhook for a reversed payment that does not say whether it is a one-time purchase', async () => {
    const { subscription_id: _id, subscription_ids: _ids, ...unclassified } = recorded.webhooks.paymentSucceededOneTime.data;
    const reversed = {
      ...recorded.webhooks.paymentSucceededOneTime,
      data: { ...unclassified, refunds: [{ refund_id: 'ref_1', status: 'succeeded', is_partial: false }] }
    };

    await expect(parse(reversed)).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });
  });

  it('keeps the signed refund time when Dodo\'s clock runs ahead of BillFn\'s', async () => {
    const fetchMock = dodoReads({ [`/payments/${oneTimePayment.payment_id}`]: oneTimePayment });
    const ahead = new Date(Date.now() + 60_000).toISOString();

    const event = await parse({ ...refund, timestamp: ahead }, fetchMock);

    expect(event.occurredAt).toBe(ahead);
  });

  it('fails the delivery when Dodo cannot answer the payment read, so Dodo retries it', async () => {
    const fetchMock = dodoReads({});

    await expect(parse(refund, fetchMock)).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });
  });
});

describe('Standard Webhooks test vectors', () => {
  // The signing vector of the Standard Webhooks reference suite
  // (standard-webhooks/standard-webhooks libraries/python/tests/test_webhooks.py, test_sign_function).
  // The reference secrets are built from their key bytes at runtime so this public test vector is not
  // committed as a literal webhook secret (secret scanners would report it).
  const referenceSecret = (keyBytes: number[]) => `whsec_${Buffer.from(keyBytes).toString('base64')}`;
  const vector = {
    secret: referenceSecret([
      49, 242, 144, 246, 191, 6, 41, 138, 171, 79, 8, 212, 60, 63, 8, 44, 246, 72, 163, 98, 218, 45, 164, 176
    ]),
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    payload: '{"test": 2432232314}',
    signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  function parseVector(overrides: Partial<typeof vector> = {}, nowSeconds = Number(vector.timestamp)) {
    vi.useFakeTimers();
    vi.setSystemTime(nowSeconds * 1000);
    const input = { ...vector, ...overrides };
    return createDodoProvider({ apiKey: 'dodo_test_key', webhookSecret: input.secret }).parseWebhook!({
      rawBody: input.payload,
      headers: new Headers({
        'webhook-id': input.id,
        'webhook-timestamp': input.timestamp,
        'webhook-signature': input.signature
      })
    });
  }

  it('accepts the reference signature, with or without the whsec_ prefix', async () => {
    await expect(parseVector()).resolves.toEqual([
      expect.objectContaining({ providerEventId: vector.id, signatureVerified: true, raw: { test: 2432232314 } })
    ]);
    await expect(parseVector({ secret: vector.secret.slice('whsec_'.length) })).resolves.toHaveLength(1);
  });

  it('accepts the reference signature among several space-separated signatures', async () => {
    await expect(
      parseVector({ signature: `v1,Ceo5qEr07ixe2NLpvHk3FH9bwy/WavXrAFQ/9tdO6mc= ${vector.signature}` })
    ).resolves.toHaveLength(1);
  });

  it.each([
    ['a one-character signature change', { signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OA=' }],
    ['an unsupported signature version', { signature: vector.signature.replace('v1,', 'v2,') }],
    ['another message id', { id: 'msg_p5jXN8AQM9LWM0D4loKWxJel' }],
    ['a changed body', { payload: '{"test": 2432232315}' }],
    [
      'another secret',
      {
        // The Standard Webhooks Rust reference tests' secret (libraries/rust/src/lib.rs).
        secret: referenceSecret([
          11, 97, 85, 176, 20, 8, 134, 187, 28, 10, 25, 80, 32, 197, 126, 111, 155, 18, 98, 202, 104, 111, 186, 3
        ])
      }
    ]
  ])('rejects %s', async (_label, overrides) => {
    await expect(parseVector(overrides)).rejects.toMatchObject({ code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID' });
  });

  it('rejects the reference signature outside the five-minute tolerance', async () => {
    await expect(parseVector({}, Number(vector.timestamp) + 301)).rejects.toMatchObject({
      code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID'
    });
    await expect(parseVector({}, Number(vector.timestamp) - 301)).rejects.toMatchObject({
      code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID'
    });
    await expect(parseVector({}, Number(vector.timestamp) + 300)).resolves.toHaveLength(1);
  });
});
