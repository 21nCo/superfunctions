import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn } from '../index.js';
import type { BillFnCatalog, BillFnParsedWebhookEvent, BillFnProviderAdapter } from '../types.js';

// A webhook that names a BillFn checkout session only through metadata the payer can set links to that session's
// plan and billing account only when it pays for the session's product.

const catalog: BillFnCatalog = {
  plans: [
    {
      productKey: 'nucleus',
      planKey: 'enterprise',
      displayName: 'Enterprise',
      features: { sso: true },
      limits: {},
      prices: [
        {
          priceId: 'price_enterprise_month',
          provider: 'dodo',
          providerProductId: 'pdt_enterprise_month',
          currency: 'USD',
          amount: 500,
          kind: 'subscription',
          interval: 'month'
        }
      ]
    },
    {
      productKey: 'nucleus',
      planKey: 'starter',
      displayName: 'Starter',
      features: {},
      limits: {},
      prices: [
        {
          priceId: 'price_starter_month',
          provider: 'dodo',
          providerProductId: 'pdt_starter_month',
          currency: 'USD',
          amount: 5,
          kind: 'subscription',
          interval: 'month'
        }
      ]
    }
  ]
};

const ATTACKER = { principalId: 'attacker' };

function setup() {
  let next: Partial<BillFnParsedWebhookEvent> = {};
  const provider: BillFnProviderAdapter = {
    provider: 'dodo',
    capabilities: {
      createCheckout: true,
      verifyCheckout: false,
      cancelSubscription: false,
      syncSubscription: false,
      restorePurchases: false,
      webhookIngestion: true
    },
    async createCheckout(input) {
      return {
        status: 'requires_action',
        checkoutUrl: 'https://billing.example.test/checkout',
        providerCheckoutId: `cks_${input.checkoutSessionId}`
      };
    },
    async parseWebhook() {
      return [
        {
          providerEventId: 'evt_link',
          type: 'subscription.active',
          signatureVerified: true,
          occurredAt: '2026-11-20T00:00:00.000Z',
          ...next
        } as BillFnParsedWebhookEvent
      ];
    }
  };
  const billfn = createBillFn({ db: memoryAdapter({ debug: false }), catalog, providers: { dodo: provider } });
  const deliver = async (event: Partial<BillFnParsedWebhookEvent>) => {
    next = event;
    const response = await billfn.handleWebhook({ provider: 'dodo', rawBody: '{}', headers: new Headers() });
    expect(response.ok).toBe(true);
  };
  const entitlements = async () => {
    const response = await billfn.getEntitlements(ATTACKER);
    return response.ok ? response.data : null;
  };
  const openCheckout = async (planKey: string) => {
    const created = await billfn.createCheckout({ subject: ATTACKER, planKey, provider: 'dodo', interval: 'month' });
    if (!created.ok) {
      throw new Error('expected a checkout');
    }
    return created.data.checkoutSession;
  };
  return { deliver, entitlements, openCheckout };
}

/** A paid subscription event naming the session through BillFn's checkout session id. */
function paidEvent(checkoutSessionId: string, product: string, metadata: Record<string, unknown> = {}) {
  return {
    checkoutReferenceId: checkoutSessionId,
    providerSubscriptionId: 'sub_paid',
    billingState: {
      subscriptionStatus: 'active' as const,
      checkoutStatus: 'succeeded' as const,
      providerSubscriptionId: 'sub_paid',
      providerChargeId: 'pay_paid',
      currentPeriodStart: '2026-11-20T00:00:00.000Z',
      currentPeriodEnd: '2026-12-20T00:00:00.000Z',
      autoRenew: true,
      raw: { product_id: product, metadata }
    },
    raw: { data: { product_id: product, metadata } }
  };
}

describe('webhook events linked to a checkout session by its BillFn id', () => {
  it('does not activate the session plan for a payment of a product outside the catalog', async () => {
    const env = setup();
    const session = await env.openCheckout('enterprise');

    await env.deliver(paidEvent(session.checkoutSessionId, 'pdt_cheap_not_in_catalog'));

    const data = await env.entitlements();
    expect(data?.subscription).toBeNull();
    expect(data?.entitlements?.status ?? 'inactive').not.toBe('active');
  });

  it('does not activate the session plan for a payment of another catalog product', async () => {
    const env = setup();
    const session = await env.openCheckout('enterprise');

    await env.deliver(paidEvent(session.checkoutSessionId, 'pdt_starter_month'));

    const data = await env.entitlements();
    expect(data?.subscription?.planKey).not.toBe('enterprise');
  });

  it('does not link a payment whose metadata names another billing account', async () => {
    const env = setup();
    const session = await env.openCheckout('enterprise');

    await env.deliver(
      paidEvent(session.checkoutSessionId, 'pdt_enterprise_month', { billfn_billing_account_id: 'ba_user_someone_else' })
    );

    expect((await env.entitlements())?.subscription).toBeNull();
  });

  it('activates the session plan for a payment of the session product', async () => {
    const env = setup();
    const session = await env.openCheckout('enterprise');

    await env.deliver(paidEvent(session.checkoutSessionId, 'pdt_enterprise_month'));

    const data = await env.entitlements();
    expect(data?.subscription).toMatchObject({ planKey: 'enterprise', providerSubscriptionId: 'sub_paid' });
    expect(data?.entitlements?.status).toBe('active');
  });

  it('does not trust a provider checkout id that came from metadata', async () => {
    const env = setup();
    const session = await env.openCheckout('enterprise');

    await env.deliver({
      ...paidEvent(`cks_${session.checkoutSessionId}`, 'pdt_cheap_not_in_catalog'),
      checkoutReferenceSource: 'metadata'
    });

    expect((await env.entitlements())?.subscription).toBeNull();
  });

  it('does not take a price id from metadata as proof of paying for the session product', async () => {
    const env = setup();
    const session = await env.openCheckout('enterprise');
    const forged = paidEvent(session.checkoutSessionId, 'pdt_cheap_not_in_catalog', {
      billfn_price_id: 'price_enterprise_month',
      billfn_billing_account_id: 'ba_user_attacker'
    });

    await env.deliver({ ...forged, priceId: 'price_enterprise_month', checkoutReferenceSource: 'metadata' });

    const data = await env.entitlements();
    expect(data?.subscription?.planKey).not.toBe('enterprise');
    expect(data?.entitlements?.status ?? 'inactive').not.toBe('active');
  });

  it('does not bootstrap the plan a metadata price id names for a payment of another product', async () => {
    const env = setup();
    await env.openCheckout('starter');
    const forged = paidEvent('chk_unknown_session', 'pdt_cheap_not_in_catalog', {
      billfn_price_id: 'price_enterprise_month',
      billfn_billing_account_id: 'ba_user_attacker'
    });

    await env.deliver({ ...forged, priceId: 'price_enterprise_month', checkoutReferenceSource: 'metadata' });

    expect((await env.entitlements())?.subscription?.planKey).not.toBe('enterprise');
  });

  it('trusts the provider\'s own checkout id without a product check', async () => {
    const env = setup();
    const session = await env.openCheckout('enterprise');

    await env.deliver({ ...paidEvent(`cks_${session.checkoutSessionId}`, 'pdt_any'), checkoutReferenceId: `cks_${session.checkoutSessionId}` });

    expect((await env.entitlements())?.subscription).toMatchObject({ planKey: 'enterprise' });
  });
});
