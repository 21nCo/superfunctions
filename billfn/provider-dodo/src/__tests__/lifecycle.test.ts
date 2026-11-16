import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn, type BillFnLifecycleEvent } from '@billfn/core';
import { createDodoProvider } from '../index.js';

/** A Dodo API double holding one subscription, answering in Dodo's response shape. */
function createDodoApi() {
  let subscription: Record<string, unknown> | null = null;
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
    if (path === '/subscriptions/sub_dodo_1' && subscription) {
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

async function subscribed(options: { verify?: boolean } = {}) {
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
          prices: [
            {
              priceId: 'price_nucleus_month',
              provider: 'dodo',
              providerProductId: 'pdt_nucleus_month',
              currency: 'USD',
              amount: 12,
              kind: 'subscription',
              interval: 'month'
            }
          ]
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
  const created = await billfn.createCheckout({ subject, planKey: 'nucleus', provider: 'dodo', interval: 'month' });
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
});
