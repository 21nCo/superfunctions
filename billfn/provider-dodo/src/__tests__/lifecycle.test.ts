import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn, type BillFnLifecycleEvent } from '@billfn/core';
import { createDodoProvider } from '../index.js';

/** A Dodo API double holding one subscription, answering in Dodo's response shape. */
function createDodoApi() {
  let subscription: Record<string, unknown> | null = null;
  /** Answers for the next subscription reads, taking the place of Dodo's (a failed or unusable read). */
  const readAnswers: Array<() => Response> = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === 'POST' && path === '/checkouts') {
      // The customer completes the checkout session: Dodo starts the subscription with the session's metadata.
      const [item] = body.product_cart as Array<{ product_id: string }>;
      subscription = {
        subscription_id: 'sub_dodo_1',
        product_id: item!.product_id,
        status: 'active',
        next_billing_date: '2026-12-10T00:00:00.000Z',
        cancel_at_next_billing_date: false,
        metadata: body.metadata
      };
      return Response.json({ session_id: 'cks_dodo_1', checkout_url: 'https://test.checkout.dodopayments.com/cks_dodo_1' });
    }
    if (path === '/checkouts/cks_dodo_1' && subscription) {
      return Response.json({ id: 'cks_dodo_1', created_at: '2026-11-10T00:00:00Z', payment_id: 'pay_dodo_1', payment_status: 'succeeded' });
    }
    if (path === '/payments/pay_dodo_1' && subscription) {
      return Response.json({
        payment_id: 'pay_dodo_1',
        status: 'succeeded',
        checkout_session_id: 'cks_dodo_1',
        subscription_id: 'sub_dodo_1',
        metadata: subscription.metadata
      });
    }
    if (init?.method === 'POST' && path === '/subscriptions/sub_dodo_1/change-plan' && subscription) {
      // Dodo moves the subscription to the new product and keeps the checkout's metadata as it was.
      subscription = { ...subscription, product_id: body.product_id };
      return Response.json({ subscription_id: 'sub_dodo_1', payment_id: null, payment_link: null });
    }
    if (path === '/subscriptions/sub_dodo_1' && subscription) {
      const answerRead = init?.method === 'PATCH' ? undefined : readAnswers.shift();
      if (answerRead) {
        return answerRead();
      }
      if (init?.method === 'PATCH') {
        // Dodo keeps a subscription canceled at its next billing date active until then.
        subscription = { ...subscription, ...body };
      }
      return Response.json(subscription);
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  }) as typeof fetch;
  return {
    fetchMock,
    /** The subscription as Dodo holds it now. */
    current() {
      return subscription!;
    },
    /** Answers the next subscription read with this response instead of the subscription. */
    answerNextRead(answer: () => Response) {
      readAnswers.push(answer);
    },
    /** Changes the subscription as Dodo would on its side, such as a payment hold. */
    update(patch: Record<string, unknown>) {
      subscription = { ...subscription!, ...patch };
    }
  };
}

const webhookSecretBytes = Buffer.from('dodo-lifecycle-webhook-secret');

/** A Dodo webhook delivery signed as Standard Webhooks specifies. */
function dodoWebhook(id: string, payload: unknown) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', webhookSecretBytes).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return {
    provider: 'dodo' as const,
    rawBody,
    headers: new Headers({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` })
  };
}

const monthlyPrice = {
  priceId: 'price_nucleus_month',
  provider: 'dodo' as const,
  providerProductId: 'pdt_nucleus_month',
  currency: 'USD',
  amount: 12,
  kind: 'subscription' as const,
  interval: 'month' as const
};

/** A second monthly price sold through the same Dodo product, and a yearly price on its own product. */
const sharedProductPrices = [
  monthlyPrice,
  { ...monthlyPrice, priceId: 'price_nucleus_month_loyal', amount: 10 },
  { ...monthlyPrice, priceId: 'price_nucleus_year', providerProductId: 'pdt_nucleus_year', amount: 120, interval: 'year' as const }
];

async function subscribed(options: { verify?: boolean; prices?: Array<typeof monthlyPrice> } = {}) {
  const api = createDodoApi();
  const { fetchMock } = api;
  const delivered: BillFnLifecycleEvent[] = [];
  const billfn = createBillFn({
    db: memoryAdapter({ debug: false }),
    catalog: {
      plans: [
        {
          productKey: 'nucleus',
          planKey: 'nucleus',
          displayName: 'Nucleus',
          features: { memotron: true },
          limits: {},
          prices: options.prices ?? [monthlyPrice]
        }
      ]
    },
    providers: {
      dodo: createDodoProvider({
        apiKey: 'test-key',
        fetch: fetchMock,
        webhookSecret: `whsec_${webhookSecretBytes.toString('base64')}`
      })
    },
    now: () => new Date('2026-11-10T00:00:00.000Z'),
    onEvent: (event) => {
      delivered.push(event);
    }
  });
  const subject = { principalId: 'user_1' };
  const created = await billfn.createCheckout({
    subject,
    planKey: 'nucleus',
    provider: 'dodo',
    interval: 'month',
    priceId: monthlyPrice.priceId
  });
  if (!created.ok) throw new Error('expected checkout');
  if (options.verify === false) {
    return { api, billfn, subject, delivered };
  }
  const verified = await billfn.verifyCheckout({ subject, checkoutSessionId: created.data.checkoutSession.checkoutSessionId });
  expect(verified.ok).toBe(true);
  return { api, billfn, subject, delivered };
}

describe('@billfn/provider-dodo lifecycle events', () => {
  it('a cancel at the next billing date records and delivers subscription.canceled', async () => {
    const { billfn, subject, delivered } = await subscribed();
    expect(delivered.filter((event) => event.type === 'subscription.canceled')).toEqual([]);

    const canceled = await billfn.cancelSubscription({ subject });
    expect(canceled.ok).toBe(true);
    const cancellations = delivered.filter((event) => event.type === 'subscription.canceled');
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]!.data).toMatchObject({
      status: 'active',
      autoRenew: false,
      currentPeriodEnd: '2026-12-10T00:00:00.000Z'
    });

    // A later sync of the same scheduled cancel records no other one.
    await billfn.cancelSubscription({ subject });
    expect(delivered.filter((event) => event.type === 'subscription.canceled')).toHaveLength(1);
  });

  it('a payment hold (on_hold) and its recovery record no subscription.canceled', async () => {
    const { api, billfn, subject, delivered } = await subscribed();
    api.update({ status: 'on_hold' });
    expect((await billfn.syncSubscription({ subject })).ok).toBe(true);
    api.update({ status: 'active' });
    expect((await billfn.syncSubscription({ subject })).ok).toBe(true);
    await billfn.services.events.dispatch();
    expect(delivered.filter((event) => event.type === 'subscription.canceled')).toEqual([]);
  });

  it('a cancel made during a payment hold records subscription.canceled once, through to the end', async () => {
    const { api, billfn, subject, delivered } = await subscribed();
    const cancellations = () => delivered.filter((event) => event.type === 'subscription.canceled');
    api.update({ status: 'on_hold' });
    expect((await billfn.syncSubscription({ subject })).ok).toBe(true);
    expect(cancellations()).toEqual([]);

    // The cancel sets cancel_at_next_billing_date; Dodo keeps the subscription on hold.
    expect((await billfn.cancelSubscription({ subject })).ok).toBe(true);
    expect(cancellations()).toHaveLength(1);
    expect(cancellations()[0]!.data).toMatchObject({ status: 'paused', autoRenew: false });

    // The hold clears, then the subscription ends: neither is another cancellation.
    api.update({ status: 'active' });
    expect((await billfn.syncSubscription({ subject })).ok).toBe(true);
    api.update({ status: 'cancelled' });
    expect((await billfn.syncSubscription({ subject })).ok).toBe(true);
    await billfn.services.events.dispatch();
    expect(cancellations()).toHaveLength(1);
  });

  it('resuming a held subscription that is scheduled to cancel clears the cancel, so it renews again', async () => {
    const { api, billfn, subject } = await subscribed();
    api.update({ status: 'on_hold' });
    expect((await billfn.syncSubscription({ subject })).ok).toBe(true);
    expect((await billfn.cancelSubscription({ subject })).ok).toBe(true);
    expect(api.current()).toMatchObject({ status: 'on_hold', cancel_at_next_billing_date: true });

    const resumed = await billfn.resumeSubscription({ subject });

    expect(resumed.ok).toBe(true);
    expect(api.current()).toMatchObject({ status: 'active', cancel_at_next_billing_date: false });
    const state = await billfn.getEntitlements(subject);
    expect(state.ok && state.data.subscription).toMatchObject({ status: 'active', autoRenew: true });
  });

  it('a subscription payment delivered before its older subscription.active event records a renewing subscription', async () => {
    const { api, billfn, subject } = await subscribed({ verify: false });
    const dodoSubscription = api.current();
    const paymentSucceeded = {
      type: 'payment.succeeded',
      timestamp: '2026-11-10T00:01:05Z',
      data: {
        payload_type: 'Payment',
        payment_id: 'pay_dodo_1',
        status: 'succeeded',
        checkout_session_id: 'cks_dodo_1',
        subscription_id: 'sub_dodo_1',
        product_cart: null,
        metadata: dodoSubscription.metadata
      }
    };
    const subscriptionActive = {
      type: 'subscription.active',
      timestamp: '2026-11-10T00:01:00Z',
      data: { payload_type: 'Subscription', ...dodoSubscription }
    };

    expect((await billfn.handleWebhook(dodoWebhook('msg_payment', paymentSucceeded))).ok).toBe(true);
    const afterPayment = await billfn.getEntitlements(subject);
    expect(afterPayment.ok && afterPayment.data.subscription).toMatchObject({
      status: 'active',
      providerSubscriptionId: 'sub_dodo_1',
      providerChargeId: 'pay_dodo_1',
      autoRenew: true
    });

    expect((await billfn.handleWebhook(dodoWebhook('msg_subscription', subscriptionActive))).ok).toBe(true);
    const afterBoth = await billfn.getEntitlements(subject);
    expect(afterBoth.ok && afterBoth.data.subscription).toMatchObject({ status: 'active', autoRenew: true });
  });
  describe('webhooks after a plan change keep the price BillFn recorded, not the checkout price in the metadata', () => {
    async function webhooksAfterChanges(targetPriceIds: string[], beforeChange?: (api: ReturnType<typeof createDodoApi>) => void) {
      const { api, billfn, subject } = await subscribed({ prices: sharedProductPrices });
      for (const targetPriceId of targetPriceIds) {
        beforeChange?.(api);
        const changed = await billfn.changeSubscription({ subject, targetPriceId, effectiveAt: 'immediate' });
        expect(changed.ok).toBe(true);
      }
      expect(api.current()).toMatchObject({
        product_id: 'pdt_nucleus_month',
        metadata: { billfn_price_id: 'price_nucleus_month', billfn_product_id: 'pdt_nucleus_month' }
      });
      const recorded = await billfn.getEntitlements(subject);
      expect(recorded.ok && recorded.data.subscription).toMatchObject({ priceId: 'price_nucleus_month_loyal' });

      const planChanged = {
        type: 'subscription.plan_changed',
        timestamp: '2026-11-11T00:00:00Z',
        data: { payload_type: 'Subscription', ...api.current() }
      };
      const renewal = {
        type: 'payment.succeeded',
        timestamp: '2026-12-10T00:00:05Z',
        data: {
          payload_type: 'Payment',
          payment_id: 'pay_dodo_2',
          status: 'succeeded',
          checkout_session_id: null,
          subscription_id: 'sub_dodo_1',
          product_cart: null,
          metadata: api.current().metadata
        }
      };
      const renewed = { type: 'subscription.renewed', timestamp: '2026-12-10T00:00:10Z', data: { payload_type: 'Subscription', ...api.current() } };
      for (const [id, payload] of [['msg_plan_changed', planChanged], ['msg_renewal', renewal], ['msg_renewed', renewed]] as const) {
        expect((await billfn.handleWebhook(dodoWebhook(id, payload))).ok).toBe(true);
      }
      const after = await billfn.getEntitlements(subject);
      expect(after.ok && after.data.subscription).toMatchObject({ priceId: 'price_nucleus_month_loyal', status: 'active' });
    }

    it('checkout price, change to another product, then change to another price of the checkout product', async () => {
      await webhooksAfterChanges(['price_nucleus_year', 'price_nucleus_month_loyal']);
    });

    it('a change to another price of the checkout product', async () => {
      await webhooksAfterChanges(['price_nucleus_month_loyal']);
    });

    it.each([
      ['fails with 503', () => new Response('unavailable', { status: 503 })],
      ['answers JSON null', () => Response.json(null)],
      ['answers an empty object', () => Response.json({})]
    ])('a change to another price of the checkout product whose follow-up read %s', async (_label, answer) => {
      await webhooksAfterChanges(['price_nucleus_month_loyal'], (api) => api.answerNextRead(answer));
    });
  });
});
