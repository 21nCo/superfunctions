import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn } from '../index.js';
import type {
  BillFnCatalog,
  BillFnParsedWebhookEvent,
  BillFnProviderAdapter,
  BillFnSubscription,
  BillFnUnlinkedWebhookEvent,
  BillFnWebhookReceipt,
  SubscriptionStatus
} from '../types.js';

const catalog: BillFnCatalog = {
  plans: [
    {
      productKey: 'nucleus',
      planKey: 'pro',
      displayName: 'Pro',
      features: { sync: true },
      limits: { storage: 1000 },
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

const DAY = 24 * 60 * 60 * 1000;

/**
 * A Dodo-shaped provider whose webhook body is the JSON list of parsed events,
 * so each test states exactly which verified events a delivery carries.
 */
function createProvider(verifiedSubscriptionId?: string): BillFnProviderAdapter {
  return {
    provider: 'dodo',
    capabilities: {
      createCheckout: true,
      verifyCheckout: true,
      cancelSubscription: false,
      syncSubscription: false,
      restorePurchases: false,
      webhookIngestion: true
    },
    async createCheckout(input) {
      return {
        status: 'requires_action',
        checkoutUrl: 'https://billing.example.test/checkout',
        providerCheckoutId: `checkout_${input.checkoutSessionId}`
      };
    },
    async verifyCheckout() {
      return {
        subscriptionStatus: 'active',
        checkoutStatus: 'succeeded',
        providerSubscriptionId: verifiedSubscriptionId,
        autoRenew: true,
        raw: { verified: true }
      };
    },
    async parseWebhook(input) {
      return JSON.parse(input.rawBody) as BillFnParsedWebhookEvent[];
    }
  };
}

function subscriptionEvent(input: {
  eventId: string;
  subscriptionId: string;
  status: SubscriptionStatus;
  occurredAt: string;
  billingAccountId?: string;
  productId?: string;
}): BillFnParsedWebhookEvent {
  const data: Record<string, unknown> = {
    subscription_id: input.subscriptionId,
    product_id: input.productId ?? 'pdt_pro_month',
    status: input.status
  };
  if (input.billingAccountId) {
    data.metadata = { billfn_billing_account_id: input.billingAccountId };
  }
  return {
    providerEventId: input.eventId,
    type: `subscription.${input.status}`,
    signatureVerified: true,
    occurredAt: input.occurredAt,
    priceId: input.productId ?? 'pdt_pro_month',
    providerSubscriptionId: input.subscriptionId,
    billingState: {
      subscriptionStatus: input.status,
      checkoutStatus: 'succeeded',
      providerSubscriptionId: input.subscriptionId,
      autoRenew: input.status === 'active',
      raw: data
    },
    raw: { type: `subscription.${input.status}`, data }
  };
}

function deliver(billfn: ReturnType<typeof createBillFn>, events: BillFnParsedWebhookEvent[]) {
  return billfn.handleWebhook({ provider: 'dodo', rawBody: JSON.stringify(events), headers: new Headers() });
}

function setup(options: { verifiedSubscriptionId?: string; db?: ReturnType<typeof memoryAdapter> } = {}) {
  const db = options.db ?? memoryAdapter({ debug: false });
  let now = new Date('2026-11-01T00:00:00.000Z');
  const billfn = createBillFn({
    db,
    catalog,
    providers: { dodo: createProvider(options.verifiedSubscriptionId) },
    now: () => now
  });
  return {
    db,
    billfn,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    async subscriptions() {
      return db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
    },
    async unlinked() {
      return db.findMany<BillFnUnlinkedWebhookEvent>({
        model: 'unlinkedWebhookEvents',
        where: [],
        orderBy: [{ field: 'providerEventId', direction: 'asc' }],
        namespace: 'billfn'
      });
    },
    async receipt(eventId: string) {
      return db.findOne<BillFnWebhookReceipt>({
        model: 'webhookReceipts',
        where: [{ field: 'providerEventId', operator: 'eq', value: eventId }],
        namespace: 'billfn'
      });
    }
  };
}

/** Enforces the unique (provider, providerSubscriptionId) index the memory adapter does not. */
function withSubscriptionReferenceUniqueness(db: ReturnType<typeof memoryAdapter>, onDuplicate: () => void) {
  let lock: Promise<unknown> = Promise.resolve();
  return {
    ...db,
    async create<T>(params: Parameters<typeof db.create>[0]): Promise<T> {
      if (params.model !== 'subscriptions') {
        return db.create<T>(params);
      }
      const run = lock.then(async () => {
        const data = params.data as Partial<BillFnSubscription>;
        const existing = await db.findOne({
          model: 'subscriptions',
          where: [
            { field: 'provider', operator: 'eq', value: data.provider },
            { field: 'providerSubscriptionId', operator: 'eq', value: data.providerSubscriptionId }
          ],
          namespace: params.namespace
        });
        if (existing) {
          onDuplicate();
          throw new Error('duplicate key value violates unique constraint "subscriptions_provider_subscription_idx"');
        }
        return db.create<T>(params);
      });
      lock = run.catch(() => undefined);
      return run;
    }
  } as ReturnType<typeof memoryAdapter>;
}

describe('webhook events for subscriptions BillFn has not seen', () => {
  it('stores an event without billing account metadata as unlinked and answers 2xx', async () => {
    const { billfn, subscriptions, unlinked, receipt } = setup();
    const event = subscriptionEvent({
      eventId: 'evt_unlinked',
      subscriptionId: 'sub_unseen',
      status: 'active',
      occurredAt: '2026-10-31T00:00:00.000Z'
    });

    const response = await billfn.router.handle(
      new Request('https://billfn.example.test/billfn/webhooks/dodo', {
        method: 'POST',
        body: JSON.stringify([event])
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, data: { accepted: true, processed: 1 } });
    expect(await subscriptions()).toHaveLength(0);
    expect((await receipt('evt_unlinked'))?.processedAt).toBeTruthy();
    const [stored, ...rest] = await unlinked();
    expect(rest).toHaveLength(0);
    expect(stored).toMatchObject({
      provider: 'dodo',
      providerEventId: 'evt_unlinked',
      providerReference: 'sub_unseen',
      status: 'unlinked',
      reason: 'billing_account_metadata_missing',
      occurredAt: '2026-10-31T00:00:00.000Z',
      createdAt: '2026-11-01T00:00:00.000Z',
      expiresAt: '2027-01-30T00:00:00.000Z'
    });

    // A redelivery is deduplicated by its receipt and stores nothing new.
    const redelivered = await deliver(billfn, [event]);
    expect(redelivered.ok && redelivered.data.processed).toBe(0);
    expect(await unlinked()).toHaveLength(1);
  });

  it('stores metadata naming a billing account that does not exist as unlinked without creating it', async () => {
    const { billfn, db, subscriptions, unlinked } = setup();

    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_unknown_account',
        subscriptionId: 'sub_unknown_account',
        status: 'active',
        occurredAt: '2026-10-31T00:00:00.000Z',
        billingAccountId: 'ba_user_nobody'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    expect(await subscriptions()).toHaveLength(0);
    expect(await db.findMany({ model: 'billingAccounts', where: [], namespace: 'billfn' })).toHaveLength(0);
    expect(await unlinked()).toEqual([
      expect.objectContaining({
        providerReference: 'sub_unknown_account',
        status: 'unlinked',
        reason: 'billing_account_not_found',
        metadataBillingAccountId: 'ba_user_nobody'
      })
    ]);
  });

  it('bootstraps a subscription from billing account metadata and skips older unlinked events', async () => {
    const { billfn, subscriptions, unlinked, advance } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'meta_user', bytes: 0 });

    // An older event arrives first, before any metadata names the account.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_meta_older',
        subscriptionId: 'sub_meta',
        status: 'past_due',
        occurredAt: '2026-10-30T00:00:00.000Z'
      })
    ]);
    advance(1000);
    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_meta_newer',
        subscriptionId: 'sub_meta',
        status: 'active',
        occurredAt: '2026-10-31T00:00:00.000Z',
        billingAccountId: 'ba_user_meta_user'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({
      billingAccountId: 'ba_user_meta_user',
      provider: 'dodo',
      providerSubscriptionId: 'sub_meta',
      planKey: 'pro',
      priceId: 'price_pro_dodo_month',
      status: 'active'
    });
    const entitlements = await billfn.getEntitlements({ principalId: 'meta_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('active');
    expect(await unlinked()).toEqual([
      expect.objectContaining({
        providerEventId: 'evt_meta_older',
        status: 'skipped',
        subscriptionId: subscription?.id
      })
    ]);
  });

  it('replays unlinked events in provider event-time order when a checkout links the reference', async () => {
    const { billfn, subscriptions, unlinked, advance } = setup({ verifiedSubscriptionId: 'sub_linked_later' });

    // Delivered newest first; replay must apply them oldest first.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_link_b',
        subscriptionId: 'sub_linked_later',
        status: 'past_due',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_link_a',
        subscriptionId: 'sub_linked_later',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z'
      })
    ]);
    expect(await subscriptions()).toHaveLength(0);
    expect((await unlinked()).map((row) => row.status)).toEqual(['unlinked', 'unlinked']);

    advance(1000);
    const checkout = await billfn.createCheckout({
      subject: { principalId: 'link_user' },
      planKey: 'pro',
      provider: 'dodo',
      interval: 'month'
    });
    if (!checkout.ok) {
      throw new Error('expected checkout');
    }
    const verified = await billfn.verifyCheckout({
      subject: { principalId: 'link_user' },
      checkoutSessionId: checkout.data.checkoutSession.checkoutSessionId
    });

    expect(verified.ok).toBe(true);
    if (!verified.ok) {
      throw new Error('expected verification');
    }
    // The response reflects the replayed state, not the pre-replay snapshot.
    expect(verified.data.subscription.status).toBe('past_due');
    expect(verified.data.entitlements.status).toBe('grace');
    const [subscription] = await subscriptions();
    expect(subscription).toMatchObject({
      billingAccountId: 'ba_user_link_user',
      status: 'past_due',
      metadata: expect.objectContaining({ billfnProviderEventOccurredAt: '2026-10-31T00:00:00.000Z' })
    });
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_link_a', status: 'replayed', subscriptionId: subscription?.id }),
      expect.objectContaining({ providerEventId: 'evt_link_b', status: 'replayed', subscriptionId: subscription?.id })
    ]);

    // A later event for the linked reference applies directly and leaves nothing unlinked.
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_link_c',
        subscriptionId: 'sub_linked_later',
        status: 'active',
        occurredAt: '2026-11-01T00:00:00.000Z'
      })
    ]);
    expect((await subscriptions())[0]?.status).toBe('active');
    expect(await unlinked()).toHaveLength(2);
  });

  it('does not replay unlinked events older than 90 days and purges them', async () => {
    const { billfn, subscriptions, unlinked, advance } = setup({ verifiedSubscriptionId: 'sub_expired' });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_expired',
        subscriptionId: 'sub_expired',
        status: 'past_due',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);

    advance(91 * DAY);
    const checkout = await billfn.createCheckout({
      subject: { principalId: 'expired_user' },
      planKey: 'pro',
      provider: 'dodo',
      interval: 'month'
    });
    if (!checkout.ok) {
      throw new Error('expected checkout');
    }
    await billfn.verifyCheckout({
      subject: { principalId: 'expired_user' },
      checkoutSessionId: checkout.data.checkoutSession.checkoutSessionId
    });
    expect((await subscriptions())[0]?.status).toBe('active');
    expect((await unlinked())[0]?.status).toBe('unlinked');

    // Storing another unlinked event removes rows past their retention.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_fresh',
        subscriptionId: 'sub_other',
        status: 'active',
        occurredAt: '2027-01-31T00:00:00.000Z'
      })
    ]);
    expect((await unlinked()).map((row) => row.providerEventId)).toEqual(['evt_fresh']);
  });

  it('creates one subscription when two deliveries race to bootstrap the same reference', async () => {
    let duplicateInserts = 0;
    const db = withSubscriptionReferenceUniqueness(memoryAdapter({ debug: false }), () => {
      duplicateInserts += 1;
    });
    const { billfn, subscriptions, receipt } = setup({ db });
    await billfn.quotaProvider.recordUsage({ principalId: 'race_user', bytes: 0 });
    const newer = subscriptionEvent({
      eventId: 'evt_race_newer',
      subscriptionId: 'sub_race',
      status: 'canceled',
      occurredAt: '2026-10-31T00:00:00.000Z',
      billingAccountId: 'ba_user_race_user'
    });
    const older = subscriptionEvent({
      eventId: 'evt_race_older',
      subscriptionId: 'sub_race',
      status: 'active',
      occurredAt: '2026-10-30T00:00:00.000Z',
      billingAccountId: 'ba_user_race_user'
    });

    const [first, second] = await Promise.all([deliver(billfn, [newer]), deliver(billfn, [older])]);

    expect(first.ok && first.data.processed).toBe(1);
    expect(second.ok && second.data.processed).toBe(1);
    // Both deliveries found no row and raced to insert; the loser recovered from the unique index.
    expect(duplicateInserts).toBe(1);
    const all = await subscriptions();
    expect(all).toHaveLength(1);
    // Whichever delivery created the row, the newer provider state wins.
    expect(all[0]).toMatchObject({ billingAccountId: 'ba_user_race_user', status: 'canceled' });
    expect((await receipt('evt_race_newer'))?.processedAt).toBeTruthy();
    expect((await receipt('evt_race_older'))?.processedAt).toBeTruthy();
  });
});
