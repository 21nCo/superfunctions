import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn } from '../index.js';
import type { BillFnCatalog, BillFnConfig, BillFnProviderAdapter } from '../types.js';

// Router subject resolution (fail closed without a resolver) and the refund
// route's host authorization.

const catalog: BillFnCatalog = {
  plans: [
    {
      productKey: 'nucleus',
      planKey: 'pro',
      displayName: 'Pro',
      features: { sync: true },
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

const VICTIM = { principalId: 'victim' };
const CALLER = { principalId: 'caller' };

function createProvider() {
  const cancelSubscription = vi.fn<NonNullable<BillFnProviderAdapter['cancelSubscription']>>(async (input) => ({
    operationStatus: 'applied',
    billingState: {
      subscriptionStatus: 'canceled',
      checkoutStatus: 'succeeded',
      providerSubscriptionId: input.subscription.providerSubscriptionId,
      providerChargeId: input.subscription.providerChargeId,
      autoRenew: false
    }
  }));
  const refundCharge = vi.fn<NonNullable<BillFnProviderAdapter['refundCharge']>>(async (input) => ({
    operationStatus: 'applied',
    providerRefundId: `refund_${input.providerChargeId ?? 'none'}`
  }));
  const provider: BillFnProviderAdapter = {
    provider: 'dodo',
    capabilities: {
      createCheckout: true,
      verifyCheckout: true,
      cancelSubscription: true,
      syncSubscription: false,
      restorePurchases: false,
      webhookIngestion: false,
      refundCharge: true
    },
    async createCheckout(input) {
      return {
        status: 'requires_action',
        checkoutUrl: 'https://billing.example.test/checkout',
        providerCheckoutId: `checkout_${input.checkoutSessionId}`
      };
    },
    async verifyCheckout(input) {
      return {
        subscriptionStatus: 'active',
        checkoutStatus: 'succeeded',
        providerSubscriptionId: `sub_${input.checkoutSession.checkoutSessionId}`,
        providerChargeId: `charge_${input.checkoutSession.checkoutSessionId}`,
        currentPeriodStart: '2026-04-20T00:00:00.000Z',
        currentPeriodEnd: '2026-05-20T00:00:00.000Z',
        autoRenew: true
      };
    },
    cancelSubscription,
    refundCharge
  };
  return { provider, cancelSubscription, refundCharge };
}

async function setup(config: Partial<BillFnConfig> = {}) {
  const db = memoryAdapter({ debug: false });
  const { provider, cancelSubscription, refundCharge } = createProvider();
  const billfn = createBillFn({ db, catalog, providers: { dodo: provider }, ...config });
  for (const subject of [VICTIM, CALLER]) {
    const created = await billfn.createCheckout({ subject, planKey: 'pro', provider: 'dodo', interval: 'month' });
    if (!created.ok) {
      throw new Error('expected a checkout');
    }
    const verified = await billfn.verifyCheckout({ subject, checkoutSessionId: created.data.checkoutSession.checkoutSessionId });
    if (!verified.ok) {
      throw new Error('expected a verified checkout');
    }
  }
  const refunds = () => db.findMany<{ billingAccountId: string }>({ model: 'refunds', where: [], namespace: 'billfn' });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await billfn.router.handle(
      new Request(`https://billfn.example.test/billfn${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      })
    );
    return { status: response.status, payload: (await response.json()) as { ok: boolean; data?: any; error?: { code: string } } };
  };
  return { billfn, call, cancelSubscription, refundCharge, refunds };
}

describe('router subjects without auth.resolveSubject', () => {
  it.each([
    ['GET', '/entitlements?principalId=victim', undefined],
    ['GET', '/usage?principalId=victim', undefined],
    ['POST', '/checkouts', { subject: VICTIM, planKey: 'pro', provider: 'dodo', interval: 'month' }],
    ['POST', '/subscriptions/cancel', { subject: VICTIM }],
    ['POST', '/subscriptions/change', { subject: VICTIM, targetPriceId: 'price_pro_dodo_month' }],
    ['POST', '/subscriptions/resume', { subject: VICTIM }],
    ['POST', '/subscriptions/sync', { subject: VICTIM }],
    ['POST', '/subscriptions/refund', { subject: VICTIM }],
    ['POST', '/checkouts/verify', { subject: VICTIM, checkoutSessionId: 'chk_any' }],
    ['POST', '/purchases/restore', { subject: VICTIM, planKey: 'pro', provider: 'dodo', purchaseReference: 'ref' }]
  ])('refuses %s %s with 401 instead of trusting the client subject', async (method, path, body) => {
    const env = await setup();

    const { status, payload } = await env.call(method, path, body);

    expect(status).toBe(401);
    expect(payload.error?.code).toBe('BILLFN_UNAUTHENTICATED');
    expect(env.cancelSubscription).not.toHaveBeenCalled();
    expect(env.refundCharge).not.toHaveBeenCalled();
  });

  it('leaves the victim subscription untouched when a caller names it in a cancel body', async () => {
    const env = await setup();

    await env.call('POST', '/subscriptions/cancel', { subject: VICTIM });

    const entitlements = await env.billfn.getEntitlements(VICTIM);
    expect(entitlements.ok && entitlements.data.subscription?.status).toBe('active');
  });

  it('takes the subject from the body or query string when the host sets auth.allowClientSubject', async () => {
    const env = await setup({ auth: { allowClientSubject: true } });

    const read = await env.call('GET', '/entitlements?principalId=victim');
    const canceled = await env.call('POST', '/subscriptions/cancel', { subject: VICTIM });

    expect(read.status).toBe(200);
    expect(read.payload.data.billingAccount.id).toBe('ba_user_victim');
    expect(canceled.status).toBe(200);
    expect(env.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it('does not treat a truthy non-boolean allowClientSubject as the opt-in', async () => {
    const env = await setup({ auth: { allowClientSubject: 'yes' as unknown as boolean } });

    const { status } = await env.call('GET', '/entitlements?principalId=victim');

    expect(status).toBe(401);
  });

  it('ignores the client subject when a resolver is configured, even with allowClientSubject', async () => {
    const env = await setup({ auth: { resolveSubject: () => CALLER, allowClientSubject: true } });

    const { status, payload } = await env.call('GET', '/entitlements?principalId=victim');

    expect(status).toBe(200);
    expect(payload.data.billingAccount.id).toBe('ba_user_caller');
  });
});

describe('router refunds', () => {
  it('refuses a refund with 403 when the host configured no refunds.authorize', async () => {
    const env = await setup({ auth: { resolveSubject: () => CALLER } });

    const { status, payload } = await env.call('POST', '/subscriptions/refund', {});

    expect(status).toBe(403);
    expect(payload.error?.code).toBe('BILLFN_UNAUTHORIZED');
    expect(env.refundCharge).not.toHaveBeenCalled();
    expect(await env.refunds()).toHaveLength(0);
    const entitlements = await env.billfn.getEntitlements(CALLER);
    expect(entitlements.ok && entitlements.data.subscription?.status).toBe('active');
  });

  it.each([false, 'yes', 1, undefined])('refuses a refund with 403 when refunds.authorize returns %s', async (answer) => {
    const env = await setup({
      auth: { resolveSubject: () => CALLER },
      refunds: { authorize: () => answer as boolean }
    });

    const { status } = await env.call('POST', '/subscriptions/refund', { mode: 'full' });

    expect(status).toBe(403);
    expect(env.refundCharge).not.toHaveBeenCalled();
    expect(await env.refunds()).toHaveLength(0);
  });

  it('refuses before asking the host when the subject cannot be resolved', async () => {
    const authorize = vi.fn(() => true);
    const env = await setup({ refunds: { authorize } });

    const { status } = await env.call('POST', '/subscriptions/refund', { subject: VICTIM });

    expect(status).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
    expect(env.refundCharge).not.toHaveBeenCalled();
  });

  it('refunds when refunds.authorize approves, passing it the resolved subject and the request fields', async () => {
    const authorize = vi.fn(() => true);
    const env = await setup({ auth: { resolveSubject: () => CALLER }, refunds: { authorize } });

    const { status, payload } = await env.call('POST', '/subscriptions/refund', {
      subject: VICTIM,
      mode: 'full',
      reason: 'requested_by_customer'
    });

    expect(status).toBe(200);
    expect(payload.data.refund.billingAccountId).toBe('ba_user_caller');
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0][0]).toMatchObject({ subject: CALLER, mode: 'full', reason: 'requested_by_customer' });
    expect((authorize.mock.calls[0][0] as { request: unknown }).request).toBeInstanceOf(Request);
    expect(env.refundCharge).toHaveBeenCalledTimes(1);
  });

  it('keeps in-process refundCharge available to host code without the router hook', async () => {
    const env = await setup();

    const refunded = await env.billfn.refundCharge({ subject: CALLER, mode: 'full' });

    expect(refunded.ok).toBe(true);
    expect(env.refundCharge).toHaveBeenCalledTimes(1);
  });
});
