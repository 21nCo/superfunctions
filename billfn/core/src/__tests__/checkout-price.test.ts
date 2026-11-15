import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn } from '../index.js';
import type {
  BillFnCatalog,
  BillFnConfig,
  BillFnCreateCheckoutInput,
  BillFnPriceEligibilityInput,
  BillFnProviderAdapter
} from '../types.js';

const catalog: BillFnCatalog = {
  plans: [
    {
      productKey: 'nucleus',
      planKey: 'pro',
      displayName: 'Pro',
      features: { sync: true },
      limits: {},
      prices: [
        // Listed first on purpose: a tagged discount must never become the default.
        {
          priceId: 'price_pro_dodo_month_intro',
          provider: 'dodo',
          providerProductId: 'pdt_pro_month_intro',
          currency: 'USD',
          amount: 6,
          kind: 'subscription',
          interval: 'month',
          eligibility: 'first-purchase'
        },
        {
          priceId: 'price_pro_dodo_month',
          provider: 'dodo',
          providerProductId: 'pdt_pro_month',
          currency: 'USD',
          amount: 12,
          kind: 'subscription',
          interval: 'month'
        },
        {
          priceId: 'price_pro_dodo_year',
          provider: 'dodo',
          providerProductId: 'pdt_pro_year',
          currency: 'USD',
          amount: 100,
          kind: 'subscription',
          interval: 'year'
        },
        {
          priceId: 'price_pro_apple_month',
          provider: 'apple',
          providerProductId: 'apple.pro.month',
          currency: 'USD',
          amount: 12,
          kind: 'subscription',
          interval: 'month'
        }
      ]
    },
    {
      productKey: 'nucleus',
      planKey: 'team',
      displayName: 'Team',
      features: { sync: true },
      limits: {},
      prices: [
        {
          priceId: 'price_team_dodo_month',
          provider: 'dodo',
          providerProductId: 'pdt_team_month',
          currency: 'USD',
          amount: 30,
          kind: 'subscription',
          interval: 'month'
        },
        {
          priceId: 'price_team_apple_month_intro',
          provider: 'apple',
          providerProductId: 'apple.team.month.intro',
          currency: 'USD',
          amount: 15,
          kind: 'subscription',
          interval: 'month',
          eligibility: 'first-purchase'
        }
      ]
    }
  ]
};

function setup(checkout?: BillFnConfig['checkout']) {
  const db = memoryAdapter({ debug: false });
  const createCheckout = vi.fn(async (input: BillFnCreateCheckoutInput) => ({
    status: 'requires_action' as const,
    checkoutUrl: `https://billing.example.test/checkout/${input.price.providerProductId}`,
    providerCheckoutId: `checkout_${input.checkoutSessionId}`
  }));
  const provider = (name: 'dodo' | 'apple'): BillFnProviderAdapter => ({
    provider: name,
    capabilities: {
      createCheckout: true,
      verifyCheckout: false,
      cancelSubscription: false,
      syncSubscription: false,
      restorePurchases: false,
      webhookIngestion: false
    },
    createCheckout
  });
  const billfn = createBillFn({
    db,
    catalog,
    providers: { dodo: provider('dodo'), apple: provider('apple') },
    checkout
  });
  const storedSessions = () => db.findMany<{ priceId: string }>({ model: 'checkoutSessions', where: [], namespace: 'billfn' });
  return { billfn, createCheckout, storedSessions };
}

function postCheckout(billfn: ReturnType<typeof setup>['billfn'], body: Record<string, unknown>) {
  return billfn.router.handle(
    new Request('https://billfn.example.test/billfn/checkouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: { principalId: 'user_1' }, ...body })
    })
  );
}

describe('checkout price selection', () => {
  it('uses the first untagged price for the provider and interval without a priceId and never asks the hook', async () => {
    const isPriceEligible = vi.fn(() => true);
    const { billfn, createCheckout } = setup({ isPriceEligible });

    const created = await billfn.createCheckout({
      subject: { principalId: 'user_1' },
      planKey: 'pro',
      provider: 'dodo',
      interval: 'month'
    });

    if (!created.ok) throw new Error('expected success');
    expect(created.data.checkoutSession.priceId).toBe('price_pro_dodo_month');
    expect(createCheckout.mock.calls[0]?.[0].price.priceId).toBe('price_pro_dodo_month');
    expect(isPriceEligible).not.toHaveBeenCalled();
  });

  it('sells an eligible discounted price and passes the account, plan and tagged price to the hook', async () => {
    const isPriceEligible = vi.fn(async (_input: BillFnPriceEligibilityInput) => true);
    const { billfn, createCheckout } = setup({ isPriceEligible });

    const response = await postCheckout(billfn, {
      planKey: 'pro',
      provider: 'dodo',
      interval: 'month',
      priceId: 'price_pro_dodo_month_intro'
    });
    const payload = (await response.json()) as { data: { checkoutSession: { priceId: string; billingAccountId: string } } };

    expect(response.status).toBe(201);
    expect(payload.data.checkoutSession.priceId).toBe('price_pro_dodo_month_intro');
    expect(isPriceEligible).toHaveBeenCalledTimes(1);
    expect(isPriceEligible.mock.calls[0]?.[0]).toMatchObject({
      billingAccountId: payload.data.checkoutSession.billingAccountId,
      planKey: 'pro',
      price: { priceId: 'price_pro_dodo_month_intro', eligibility: 'first-purchase', amount: 6 }
    });
    expect(createCheckout.mock.calls[0]?.[0].price).toMatchObject({ priceId: 'price_pro_dodo_month_intro', amount: 6 });
  });

  it.each([
    ['the hook refuses', { isPriceEligible: () => false }],
    ['the hook returns a truthy non-boolean', { isPriceEligible: () => 'yes' as unknown as boolean }],
    ['no hook is configured', undefined]
  ])('rejects a discounted price with 403 when %s, before any provider call or session', async (_label, checkout) => {
    const { billfn, createCheckout, storedSessions } = setup(checkout);

    const response = await postCheckout(billfn, {
      planKey: 'pro',
      provider: 'dodo',
      priceId: 'price_pro_dodo_month_intro'
    });
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(403);
    expect(payload.error.code).toBe('BILLFN_PRICE_NOT_ELIGIBLE');
    expect(createCheckout).not.toHaveBeenCalled();
    expect(await storedSessions()).toEqual([]);
  });

  it.each([
    ['an unknown price', { planKey: 'pro', provider: 'dodo', priceId: 'price_missing' }],
    ['a price of another plan', { planKey: 'pro', provider: 'dodo', priceId: 'price_team_dodo_month' }],
    ['a price of another provider', { planKey: 'pro', provider: 'dodo', priceId: 'price_pro_apple_month' }],
    ['a price of another interval', { planKey: 'pro', provider: 'dodo', interval: 'year', priceId: 'price_pro_dodo_month' }],
    ['a non-string priceId', { planKey: 'pro', provider: 'dodo', priceId: 12 }],
    ['an empty priceId', { planKey: 'pro', provider: 'dodo', priceId: '' }]
  ])('rejects %s with 400 without asking the hook or the provider', async (_label, body) => {
    const isPriceEligible = vi.fn(() => true);
    const { billfn, createCheckout, storedSessions } = setup({ isPriceEligible });

    const response = await postCheckout(billfn, body);
    const payload = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(400);
    expect(payload.error.code).toBe('BILLFN_VALIDATION_ERROR');
    expect(isPriceEligible).not.toHaveBeenCalled();
    expect(createCheckout).not.toHaveBeenCalled();
    expect(await storedSessions()).toEqual([]);
  });

  it('sells an explicitly chosen untagged price without an interval and without the hook', async () => {
    const isPriceEligible = vi.fn(() => false);
    const { billfn } = setup({ isPriceEligible });

    const created = await billfn.createCheckout({
      subject: { principalId: 'user_1' },
      planKey: 'pro',
      provider: 'dodo',
      priceId: 'price_pro_dodo_year'
    });

    if (!created.ok) throw new Error('expected success');
    expect(created.data.checkoutSession.priceId).toBe('price_pro_dodo_year');
    expect(isPriceEligible).not.toHaveBeenCalled();
  });

  it('does not fall back to a tagged price when a plan has no untagged default', async () => {
    const { billfn, createCheckout } = setup({ isPriceEligible: () => true });

    await expect(billfn.createCheckout({
      subject: { principalId: 'user_1' },
      planKey: 'team',
      provider: 'apple'
    })).rejects.toMatchObject({ code: 'BILLFN_CATALOG_PRICE_NOT_FOUND' });
    expect(createCheckout).not.toHaveBeenCalled();
  });
});
