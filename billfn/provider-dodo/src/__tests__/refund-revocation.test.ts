import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn } from '@billfn/core';
import { createDodoProvider } from '../index.js';

// A one-time (lifetime) purchase that Dodo later refunds in full or loses to a chargeback stops granting access.

const webhookSecretBytes = Buffer.from('dodo-refund-revocation-webhook-secret');

const lifetimePrice = {
  priceId: 'price_nucleus_lifetime',
  provider: 'dodo' as const,
  providerProductId: 'pdt_nucleus_lifetime',
  currency: 'USD',
  amount: 99,
  kind: 'one_time' as const
};

/** A Dodo API double holding one one-time payment, answering in Dodo's response shape. */
function createDodoApi() {
  let payment: Record<string, unknown> | null = null;
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (init?.method === 'POST' && path === '/checkouts') {
      const [item] = body.product_cart as Array<{ product_id: string }>;
      payment = {
        payment_id: 'pay_dodo_lifetime',
        status: 'succeeded',
        checkout_session_id: 'cks_dodo_lifetime',
        subscription_id: null,
        subscription_ids: [],
        product_cart: [{ product_id: item!.product_id, quantity: 1 }],
        refunds: [],
        disputes: [],
        metadata: body.metadata
      };
      return Response.json({ session_id: 'cks_dodo_lifetime', checkout_url: 'https://test.checkout.dodopayments.com/cks_dodo_lifetime' });
    }
    if (path === '/checkouts/cks_dodo_lifetime' && payment) {
      return Response.json({ id: 'cks_dodo_lifetime', created_at: '2026-11-10T00:00:00Z', payment_id: 'pay_dodo_lifetime', payment_status: 'succeeded' });
    }
    if (path === '/payments/pay_dodo_lifetime' && payment) {
      return Response.json(payment);
    }
    if (init?.method === 'POST' && path === '/refunds' && payment) {
      return Response.json({ refund_id: 'ref_dodo_lifetime', payment_id: 'pay_dodo_lifetime', status: 'succeeded', is_partial: false });
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  }) as typeof fetch;
  return {
    fetchMock,
    /** Records a refund or dispute on the payment, as Dodo does beside its unchanged `succeeded` status. */
    takeBack(patch: { refunds?: unknown[]; disputes?: unknown[] }) {
      payment = { ...payment!, ...patch };
    }
  };
}

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

async function purchased() {
  let tick = Date.parse('2026-11-10T00:00:00.000Z');
  const clock = () => new Date((tick += 1000));
  const api = createDodoApi();
  const { fetchMock } = api;
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
          prices: [lifetimePrice]
        }
      ]
    },
    providers: {
      dodo: createDodoProvider({
        apiKey: 'test-key',
        fetch: fetchMock,
        webhookSecret: `whsec_${webhookSecretBytes.toString('base64')}`,
        now: clock
      })
    },
    // One controllable clock for BillFn and the adapter, which dates a revocation by when its Dodo read started;
    // each call moves it on, so a restore comes after the revocation it follows.
    now: clock
  });
  const subject = { principalId: 'user_1' };
  const created = await billfn.createCheckout({ subject, planKey: 'nucleus', provider: 'dodo', priceId: lifetimePrice.priceId });
  if (!created.ok) {
    throw new Error('expected a checkout');
  }
  const verified = await billfn.verifyCheckout({ subject, checkoutSessionId: created.data.checkoutSession.checkoutSessionId });
  if (!verified.ok) {
    throw new Error('expected a verified checkout');
  }
  const entitlementStatus = async () => {
    const entitlements = await billfn.getEntitlements(subject);
    return entitlements.ok ? entitlements.data.entitlements?.status : undefined;
  };
  return { billfn, subject, entitlementStatus, api };
}

const event = (type: string, data: Record<string, unknown>) => ({
  business_id: 'bus_test',
  type,
  timestamp: '2026-11-12T00:00:00Z',
  data: { payment_id: 'pay_dodo_lifetime', ...data }
});

describe('Dodo refunds and disputes of a one-time purchase', () => {
  it('grants the purchase before any refund', async () => {
    const { entitlementStatus } = await purchased();

    expect(await entitlementStatus()).toBe('active');
  });

  it('revokes the purchase when a full refund succeeds', async () => {
    const { billfn, entitlementStatus } = await purchased();

    const handled = await billfn.handleWebhook(
      dodoWebhook('msg_refund', event('refund.succeeded', { payload_type: 'Refund', refund_id: 'ref_1', status: 'succeeded', is_partial: false }))
    );

    expect(handled.ok).toBe(true);
    expect(await entitlementStatus()).toBe('inactive');
  });

  it('revokes the purchase when the merchant loses a chargeback', async () => {
    const { billfn, entitlementStatus } = await purchased();

    await billfn.handleWebhook(
      dodoWebhook('msg_dispute', event('dispute.lost', { payload_type: 'Dispute', dispute_id: 'dsp_1', dispute_status: 'dispute_lost' }))
    );

    expect(await entitlementStatus()).toBe('inactive');
  });

  it('keeps the purchase after a partial refund', async () => {
    const { billfn, entitlementStatus } = await purchased();

    await billfn.handleWebhook(
      dodoWebhook('msg_partial', event('refund.succeeded', { payload_type: 'Refund', refund_id: 'ref_2', status: 'succeeded', is_partial: true }))
    );

    expect(await entitlementStatus()).toBe('active');
  });

  it.each([
    ['a full refund', { refunds: [{ refund_id: 'ref_1', status: 'succeeded', is_partial: false }] }],
    ['a lost dispute', { disputes: [{ dispute_id: 'dsp_1', dispute_status: 'dispute_lost' }] }]
  ])('keeps the purchase revoked when the customer restores it after %s', async (_name, takeBack) => {
    const { billfn, subject, entitlementStatus, api } = await purchased();
    api.takeBack(takeBack);
    await billfn.handleWebhook(
      dodoWebhook(
        'msg_take_back',
        takeBack.refunds
          ? event('refund.succeeded', { payload_type: 'Refund', refund_id: 'ref_1', status: 'succeeded', is_partial: false })
          : event('dispute.lost', { payload_type: 'Dispute', dispute_id: 'dsp_1', dispute_status: 'dispute_lost' })
      )
    );

    const restored = await billfn.restorePurchases({
      subject,
      planKey: 'nucleus',
      provider: 'dodo',
      priceId: lifetimePrice.priceId,
      purchaseReference: 'pay_dodo_lifetime'
    });

    expect(restored.ok).toBe(true);
    expect(restored.ok && restored.data.subscription.status).toBe('canceled');
    expect(await entitlementStatus()).toBe('inactive');
  });

  it('restores nothing for a refunded purchase whose refund webhook has not arrived yet', async () => {
    const { billfn, subject, entitlementStatus, api } = await purchased();
    api.takeBack({ refunds: [{ refund_id: 'ref_1', status: 'succeeded', is_partial: false }] });

    const restored = await billfn.restorePurchases({
      subject,
      planKey: 'nucleus',
      provider: 'dodo',
      priceId: lifetimePrice.priceId,
      purchaseReference: 'pay_dodo_lifetime'
    });

    expect(restored.ok).toBe(true);
    expect(restored.ok && restored.data.subscription.status).toBe('canceled');
    expect(await entitlementStatus()).toBe('inactive');
  });

  it('keeps the purchase after a partial refund recorded on the payment', async () => {
    const { billfn, subject, entitlementStatus, api } = await purchased();
    api.takeBack({ refunds: [{ refund_id: 'ref_2', status: 'succeeded', is_partial: true }] });

    await billfn.restorePurchases({
      subject,
      planKey: 'nucleus',
      provider: 'dodo',
      priceId: lifetimePrice.priceId,
      purchaseReference: 'pay_dodo_lifetime'
    });

    expect(await entitlementStatus()).toBe('active');
  });

  it('revokes the purchase BillFn refunds in full once the refund webhook arrives', async () => {
    const { billfn, subject, entitlementStatus } = await purchased();

    const refunded = await billfn.refundCharge({ subject, mode: 'full' });
    expect(refunded.ok).toBe(true);
    expect(await entitlementStatus()).toBe('active');

    await billfn.handleWebhook(
      dodoWebhook('msg_refund_after', event('refund.succeeded', { payload_type: 'Refund', refund_id: 'ref_dodo_lifetime', status: 'succeeded', is_partial: false }))
    );

    expect(await entitlementStatus()).toBe('inactive');
  });
});
