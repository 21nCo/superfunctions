import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BillFnBillingAccount,
  BillFnCheckoutSession,
  BillFnPriceDefinition,
  BillFnSubscription,
  BillFnVerifyCheckoutInput
} from '@billfn/core';
import { createDodoProvider, type DodoProviderConfig } from '../index.js';
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
});

describe('parseWebhook with recorded Dodo payloads', () => {
  const secretBytes = Buffer.from('dodo-contract-webhook-secret');
  const webhookSecret = `whsec_${secretBytes.toString('base64')}`;

  async function parse(payload: unknown) {
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secretBytes).update(`msg_contract.${timestamp}.${rawBody}`).digest('base64');
    const events = await createDodoProvider({ apiKey: 'dodo_test_key', webhookSecret }).parseWebhook?.({
      rawBody,
      headers: new Headers({ 'webhook-id': 'msg_contract', 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` })
    });
    return events![0]!;
  }

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

  it('names only the product of a subscription payment that carries its product, never the checkout price', async () => {
    const payment = recorded.webhooks.paymentSucceededForSubscription;
    const event = await parse({
      ...payment,
      data: { ...payment.data, product_cart: [{ product_id: 'pdt_nucleus_month', quantity: 1 }] }
    });

    expect(event.priceId).toBe('pdt_nucleus_month');
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

  it('records a refund without a billing state for its charge', async () => {
    const event = await parse(recorded.webhooks.refundSucceeded);

    expect(event).toMatchObject({ type: 'refund.succeeded', providerChargeId: PAYMENT_ID });
    expect(event.billingState).toBeUndefined();
    expect(event.priceId).toBeUndefined();
  });
});

describe('Standard Webhooks test vectors', () => {
  // The signing vector of the Standard Webhooks reference suite
  // (standard-webhooks/standard-webhooks libraries/python/tests/test_webhooks.py, test_sign_function).
  const vector = {
    secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
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
    ['another secret', { secret: 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD' }]
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
