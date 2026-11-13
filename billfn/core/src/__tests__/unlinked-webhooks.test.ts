import { describe, expect, it } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { MemoryQueueAdapter } from '@superfunctions/queue';
import { createBillFn, createBillFnReconciliationWorker } from '../index.js';
import type {
  BillFnCatalog,
  BillFnParsedWebhookEvent,
  BillFnProviderAdapter,
  BillFnQueuedJob,
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

type ProviderOptions = {
  verifiedSubscriptionId?: string;
  /** Runs while the provider is read live, before verification or restore returns. */
  duringLiveRead?: () => Promise<void>;
};

/**
 * A Dodo-shaped provider whose webhook body is the JSON list of parsed events,
 * so each test states exactly which verified events a delivery carries.
 */
function createProvider(options: ProviderOptions): BillFnProviderAdapter {
  const verifiedSubscriptionId = options.verifiedSubscriptionId;
  return {
    provider: 'dodo',
    capabilities: {
      createCheckout: true,
      verifyCheckout: true,
      cancelSubscription: false,
      syncSubscription: false,
      restorePurchases: true,
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
      await options.duringLiveRead?.();
      return {
        subscriptionStatus: 'active',
        checkoutStatus: 'succeeded',
        providerSubscriptionId: verifiedSubscriptionId,
        autoRenew: true,
        raw: { verified: true }
      };
    },
    async restorePurchases() {
      await options.duringLiveRead?.();
      return [
        {
          subscriptionStatus: 'active',
          checkoutStatus: 'succeeded',
          providerSubscriptionId: verifiedSubscriptionId,
          autoRenew: true,
          raw: { restored: true }
        }
      ];
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
  checkoutReferenceId?: string;
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
    checkoutReferenceId: input.checkoutReferenceId,
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

function setup(options: ProviderOptions & { db?: ReturnType<typeof memoryAdapter> } = {}) {
  const db = options.db ?? memoryAdapter({ debug: false });
  let now = new Date('2026-11-01T00:00:00.000Z');
  const billfn = createBillFn({
    db,
    catalog,
    providers: { dodo: createProvider(options) },
    now: () => now
  });
  return {
    db,
    billfn,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    async checkout(principalId: string) {
      const created = await billfn.createCheckout({
        subject: { principalId },
        planKey: 'pro',
        provider: 'dodo',
        interval: 'month'
      });
      if (!created.ok) {
        throw new Error('expected checkout');
      }
      return created.data.checkoutSession;
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

/** Fails the next subscription update while `armed` is set, as a transient database error would. */
function withFailingSubscriptionUpdate(db: ReturnType<typeof memoryAdapter>, fault: { armed: boolean }) {
  return {
    ...db,
    async updateMany(params: Parameters<typeof db.updateMany>[0]) {
      if (params.model === 'subscriptions' && fault.armed) {
        fault.armed = false;
        throw new Error('injected subscription write failure');
      }
      return db.updateMany(params);
    }
  } as ReturnType<typeof memoryAdapter>;
}

type Db = ReturnType<typeof memoryAdapter>;
type DbHook<M extends 'create' | 'findOne' | 'findMany' | 'updateMany'> = (
  params: Parameters<Db[M]>[0],
  next: () => Promise<unknown>
) => Promise<unknown>;

/** Runs each hook around the adapter call it names, so a test can pause or fail one exact database step. */
function interceptDb(
  db: Db,
  hooks: { create?: DbHook<'create'>; findOne?: DbHook<'findOne'>; findMany?: DbHook<'findMany'>; updateMany?: DbHook<'updateMany'> }
): Db {
  return {
    ...db,
    create: (params: Parameters<Db['create']>[0]) =>
      hooks.create ? hooks.create(params, () => db.create(params)) : db.create(params),
    findOne: (params: Parameters<Db['findOne']>[0]) =>
      hooks.findOne ? hooks.findOne(params, () => db.findOne(params)) : db.findOne(params),
    findMany: (params: Parameters<Db['findMany']>[0]) =>
      hooks.findMany ? hooks.findMany(params, () => db.findMany(params)) : db.findMany(params),
    updateMany: (params: Parameters<Db['updateMany']>[0]) =>
      hooks.updateMany ? hooks.updateMany(params, () => db.updateMany(params)) : db.updateMany(params)
  } as Db;
}

const REPLAY_LEASE_MS = 15 * 60 * 1000;

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

  it('skips unlinked events older than the live state a checkout verification links', async () => {
    const { billfn, subscriptions, unlinked, advance, checkout } = setup({ verifiedSubscriptionId: 'sub_linked_later' });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_link_a',
        subscriptionId: 'sub_linked_later',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_link_b',
        subscriptionId: 'sub_linked_later',
        status: 'past_due',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);
    expect(await subscriptions()).toHaveLength(0);

    advance(1000);
    const session = await checkout('link_user');
    const verified = await billfn.verifyCheckout({
      subject: { principalId: 'link_user' },
      checkoutSessionId: session.checkoutSessionId
    });

    // The provider reported the subscription active just now; the stored past_due is stale.
    if (!verified.ok) {
      throw new Error('expected verification');
    }
    expect(verified.data.subscription.status).toBe('active');
    expect(verified.data.entitlements.status).toBe('active');
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ billingAccountId: 'ba_user_link_user', status: 'active' });
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_link_a', status: 'skipped', subscriptionId: subscription?.id }),
      expect.objectContaining({ providerEventId: 'evt_link_b', status: 'skipped', subscriptionId: subscription?.id })
    ]);

    // A later event for the linked reference applies directly and leaves nothing unlinked.
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_link_c',
        subscriptionId: 'sub_linked_later',
        status: 'past_due',
        occurredAt: '2026-11-01T00:00:10.000Z'
      })
    ]);
    expect((await subscriptions())[0]?.status).toBe('past_due');
    expect(await unlinked()).toHaveLength(2);
  });

  it('applies an unlinked event that occurred after the live read a checkout verification links', async () => {
    let during: () => Promise<void> = async () => undefined;
    const { billfn, subscriptions, unlinked, advance, checkout } = setup({
      verifiedSubscriptionId: 'sub_in_flight',
      duringLiveRead: () => during()
    });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_flight_old',
        subscriptionId: 'sub_in_flight',
        status: 'expired',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);
    advance(1000);
    const session = await checkout('flight_user');
    // The provider sends a cancellation while BillFn is still reading the checkout.
    during = async () => {
      advance(1000);
      await deliver(billfn, [
        subscriptionEvent({
          eventId: 'evt_flight_new',
          subscriptionId: 'sub_in_flight',
          status: 'canceled',
          occurredAt: '2026-11-01T00:00:02.000Z'
        })
      ]);
    };

    const verified = await billfn.verifyCheckout({
      subject: { principalId: 'flight_user' },
      checkoutSessionId: session.checkoutSessionId
    });

    if (!verified.ok) {
      throw new Error('expected verification');
    }
    expect(verified.data.subscription.status).toBe('canceled');
    expect(verified.data.entitlements.status).toBe('inactive');
    const [subscription] = await subscriptions();
    expect(subscription?.status).toBe('canceled');
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_flight_new', status: 'replayed' }),
      expect.objectContaining({ providerEventId: 'evt_flight_old', status: 'skipped' })
    ]);
  });

  it('skips unlinked events older than the live state a restored purchase links', async () => {
    const { billfn, subscriptions, unlinked, advance } = setup({ verifiedSubscriptionId: 'sub_restored' });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_restore_old',
        subscriptionId: 'sub_restored',
        status: 'expired',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);
    advance(1000);

    const restored = await billfn.restorePurchases({
      subject: { principalId: 'restore_user' },
      provider: 'dodo',
      planKey: 'pro'
    });

    if (!restored.ok) {
      throw new Error('expected restore');
    }
    expect(restored.data.subscription.status).toBe('active');
    expect(restored.data.entitlements.status).toBe('active');
    const [subscription] = await subscriptions();
    expect(subscription).toMatchObject({ billingAccountId: 'ba_user_restore_user', status: 'active' });
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_restore_old', status: 'skipped', subscriptionId: subscription?.id })
    ]);
  });

  it('replays unlinked events in event-time order after an event links the reference through its checkout', async () => {
    const { billfn, subscriptions, unlinked, advance, checkout } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'checkout_ref_user', bytes: 0 });
    // Delivered newest first; replay must apply them oldest first.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_ref_cancel',
        subscriptionId: 'sub_checkout_ref',
        status: 'canceled',
        occurredAt: '2026-10-31T12:00:00.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_ref_past_due',
        subscriptionId: 'sub_checkout_ref',
        status: 'past_due',
        occurredAt: '2026-10-31T06:00:00.000Z'
      })
    ]);
    advance(1000);
    const session = await checkout('checkout_ref_user');

    // The oldest event names the checkout, so it creates the subscription and links the reference.
    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_ref_active',
        subscriptionId: 'sub_checkout_ref',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z',
        checkoutReferenceId: session.providerCheckoutId
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({
      billingAccountId: 'ba_user_checkout_ref_user',
      status: 'canceled',
      metadata: expect.objectContaining({ billfnProviderEventOccurredAt: '2026-10-31T12:00:00.000Z' })
    });
    const entitlements = await billfn.getEntitlements({ principalId: 'checkout_ref_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_ref_cancel', status: 'replayed', subscriptionId: subscription?.id }),
      expect.objectContaining({ providerEventId: 'evt_ref_past_due', status: 'replayed', subscriptionId: subscription?.id })
    ]);
  });

  it('keeps the linking webhook retryable when replaying an unlinked event fails', async () => {
    const fault = { armed: false };
    const db = withFailingSubscriptionUpdate(memoryAdapter({ debug: false }), fault);
    const { billfn, subscriptions, unlinked, receipt, advance } = setup({ db });
    await billfn.quotaProvider.recordUsage({ principalId: 'retry_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_retry_cancel',
        subscriptionId: 'sub_retry',
        status: 'canceled',
        occurredAt: '2026-10-31T12:00:00.000Z'
      })
    ]);
    advance(1000);
    const bootstrap = subscriptionEvent({
      eventId: 'evt_retry_active',
      subscriptionId: 'sub_retry',
      status: 'active',
      occurredAt: '2026-10-31T00:00:00.000Z',
      billingAccountId: 'ba_user_retry_user'
    });

    // The bootstrap creates the subscription; replaying the cancellation onto it fails once.
    fault.armed = true;
    await expect(deliver(billfn, [bootstrap])).rejects.toThrow('injected subscription write failure');

    expect((await receipt('evt_retry_active'))?.processedAt).toBeFalsy();
    expect(await unlinked()).toEqual([
      expect.objectContaining({
        providerEventId: 'evt_retry_cancel',
        status: 'unlinked',
        error: 'injected subscription write failure'
      })
    ]);

    // The provider redelivers the unacknowledged event and the retained cancellation is applied.
    advance(1000);
    const redelivered = await deliver(billfn, [bootstrap]);

    expect(redelivered.ok && redelivered.data.processed).toBe(1);
    expect((await receipt('evt_retry_active'))?.processedAt).toBeTruthy();
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ billingAccountId: 'ba_user_retry_user', status: 'canceled' });
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_retry_cancel', status: 'replayed', error: null })
    ]);
  });

  it('does not replay unlinked events older than 90 days and purges them', async () => {
    const { billfn, subscriptions, unlinked, advance, checkout } = setup({ verifiedSubscriptionId: 'sub_expired' });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_expired',
        subscriptionId: 'sub_expired',
        status: 'past_due',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);

    advance(91 * DAY);
    const session = await checkout('expired_user');
    await billfn.verifyCheckout({
      subject: { principalId: 'expired_user' },
      checkoutSessionId: session.checkoutSessionId
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

  it('keeps a verified live state when a replay resumes after the verification was interrupted', async () => {
    const fault = { armed: false };
    const db = interceptDb(memoryAdapter({ debug: false }), {
      async findMany(params, next) {
        if (params.model === 'unlinkedWebhookEvents' && fault.armed) {
          fault.armed = false;
          throw new Error('injected unlinked query failure');
        }
        return next();
      }
    });
    const { billfn, subscriptions, unlinked, advance, checkout } = setup({ db, verifiedSubscriptionId: 'sub_interrupted' });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_interrupted_cancel',
        subscriptionId: 'sub_interrupted',
        status: 'canceled',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);
    advance(1000);
    const session = await checkout('interrupted_user');

    // The live state is saved, then the replay that follows it fails.
    fault.armed = true;
    await expect(
      billfn.verifyCheckout({ subject: { principalId: 'interrupted_user' }, checkoutSessionId: session.checkoutSessionId })
    ).rejects.toThrow('injected unlinked query failure');
    expect((await subscriptions())[0]?.status).toBe('active');

    // A delayed event for the reference resumes the replay; the cancellation predates the live read.
    advance(1000);
    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_interrupted_delayed',
        subscriptionId: 'sub_interrupted',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ billingAccountId: 'ba_user_interrupted_user', status: 'active' });
    const entitlements = await billfn.getEntitlements({ principalId: 'interrupted_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('active');
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_interrupted_cancel', status: 'skipped', subscriptionId: subscription?.id })
    ]);
  });

  it('replays an event stored while a checkout verification links its reference, against the live state', async () => {
    let linkWhileStoring: (() => Promise<void>) | null = null;
    const db = interceptDb(memoryAdapter({ debug: false }), {
      async create(params, next) {
        if (params.model === 'unlinkedWebhookEvents' && linkWhileStoring) {
          const link = linkWhileStoring;
          linkWhileStoring = null;
          await link();
        }
        return next();
      }
    });
    const { billfn, subscriptions, unlinked, receipt, advance, checkout } = setup({
      db,
      verifiedSubscriptionId: 'sub_store_race'
    });
    const session = await checkout('store_race_user');
    advance(1000);
    // The event found no link; before it is stored, a verification links the reference and finds nothing to replay.
    linkWhileStoring = async () => {
      advance(1000);
      const verified = await billfn.verifyCheckout({
        subject: { principalId: 'store_race_user' },
        checkoutSessionId: session.checkoutSessionId
      });
      expect(verified.ok && verified.data.subscription.status).toBe('active');
    };

    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_store_race',
        subscriptionId: 'sub_store_race',
        status: 'past_due',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    expect(linkWhileStoring).toBeNull();
    expect((await receipt('evt_store_race'))?.processedAt).toBeTruthy();
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ billingAccountId: 'ba_user_store_race_user', status: 'active' });
    const entitlements = await billfn.getEntitlements({ principalId: 'store_race_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('active');
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_store_race', status: 'skipped', subscriptionId: subscription?.id })
    ]);
  });

  it('keeps the linking webhook retryable while an interrupted replay still holds an event', async () => {
    const fault = { armed: false };
    const db = interceptDb(memoryAdapter({ debug: false }), {
      async updateMany(params, next) {
        if (params.model === 'unlinkedWebhookEvents' && params.data.status === 'replayed' && fault.armed) {
          fault.armed = false;
          throw new Error('injected replay finalize failure');
        }
        return next();
      }
    });
    const { billfn, subscriptions, unlinked, receipt, advance } = setup({ db });
    await billfn.quotaProvider.recordUsage({ principalId: 'lease_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_lease_a_active',
        subscriptionId: 'sub_lease',
        status: 'active',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_lease_b_cancel',
        subscriptionId: 'sub_lease',
        status: 'canceled',
        occurredAt: '2026-10-31T12:00:00.000Z'
      })
    ]);
    advance(1000);
    const bootstrap = subscriptionEvent({
      eventId: 'evt_lease_bootstrap',
      subscriptionId: 'sub_lease',
      status: 'active',
      occurredAt: '2026-10-30T00:00:00.000Z',
      billingAccountId: 'ba_user_lease_user'
    });

    // The first retained event is applied, but recording it as replayed fails, leaving its replay claim behind.
    fault.armed = true;
    await expect(deliver(billfn, [bootstrap])).rejects.toThrow('injected replay finalize failure');

    // A redelivery inside the claim's lease must not acknowledge the event while the cancellation is unapplied.
    advance(1000);
    await expect(deliver(billfn, [bootstrap])).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
    expect((await receipt('evt_lease_bootstrap'))?.processedAt).toBeFalsy();
    expect((await subscriptions())[0]?.status).toBe('active');
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_lease_a_active', status: 'replaying' }),
      expect.objectContaining({ providerEventId: 'evt_lease_b_cancel', status: 'unlinked' })
    ]);

    // Once the lease expires, the next redelivery takes the claim over and applies the cancellation.
    advance(REPLAY_LEASE_MS);
    const redelivered = await deliver(billfn, [bootstrap]);

    expect(redelivered.ok && redelivered.data.processed).toBe(1);
    expect((await receipt('evt_lease_bootstrap'))?.processedAt).toBeTruthy();
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ billingAccountId: 'ba_user_lease_user', status: 'canceled' });
    const entitlements = await billfn.getEntitlements({ principalId: 'lease_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_lease_a_active', status: 'replayed', replayClaimId: null }),
      expect.objectContaining({ providerEventId: 'evt_lease_b_cancel', status: 'replayed', subscriptionId: subscription?.id })
    ]);
  });

  it('retries a queued linking webhook after the lease of an interrupted replay run expires', async () => {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-01T00:00:00.000Z') };
    const queue = new MemoryQueueAdapter<BillFnQueuedJob>({ now: () => clock.current.getTime() });
    const config = { db, catalog, queue, now: () => clock.current, providers: { dodo: createProvider({}) } };
    const billfn = createBillFn(config);
    const worker = createBillFnReconciliationWorker(config);
    await billfn.quotaProvider.recordUsage({ principalId: 'queued_lease_user', bytes: 0 });
    for (const event of [
      subscriptionEvent({
        eventId: 'evt_queued_a_active',
        subscriptionId: 'sub_queued_lease',
        status: 'active',
        occurredAt: '2026-10-31T00:00:00.000Z'
      }),
      subscriptionEvent({
        eventId: 'evt_queued_b_cancel',
        subscriptionId: 'sub_queued_lease',
        status: 'canceled',
        occurredAt: '2026-10-31T12:00:00.000Z'
      })
    ]) {
      await deliver(billfn, [event]);
      await worker.runNext();
    }
    // A replay run claimed the first retained event and stopped before releasing it.
    await db.updateMany({
      model: 'unlinkedWebhookEvents',
      where: [{ field: 'providerEventId', operator: 'eq', value: 'evt_queued_a_active' }],
      data: { status: 'replaying', replayClaimId: 'uwr_interrupted', replayClaimedAt: clock.current.toISOString() },
      namespace: 'billfn'
    });

    const accepted = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_queued_bootstrap',
        subscriptionId: 'sub_queued_lease',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z',
        billingAccountId: 'ba_user_queued_lease_user'
      })
    ]);
    expect(accepted.ok && accepted.data.processed).toBe(1);
    await expect(worker.runNext()).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });

    // The job is not done: the queue keeps the message and redelivers it after the lease.
    expect(await queue.size('billfn-reconciliation')).toBe(1);
    expect(await worker.runNext()).toBeNull();
    clock.current = new Date(clock.current.getTime() + REPLAY_LEASE_MS);
    expect(await worker.runNext()).toMatchObject({ status: 'succeeded' });

    const subscriptions = await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
    expect(subscriptions).toEqual([
      expect.objectContaining({ billingAccountId: 'ba_user_queued_lease_user', status: 'canceled' })
    ]);
    const receipt = await db.findOne<BillFnWebhookReceipt>({
      model: 'webhookReceipts',
      where: [{ field: 'providerEventId', operator: 'eq', value: 'evt_queued_bootstrap' }],
      namespace: 'billfn'
    });
    expect(receipt?.processedAt).toBeTruthy();
    const rows = await db.findMany<BillFnUnlinkedWebhookEvent>({
      model: 'unlinkedWebhookEvents',
      where: [],
      orderBy: [{ field: 'providerEventId', direction: 'asc' }],
      namespace: 'billfn'
    });
    expect(rows.map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_queued_a_active', 'replayed'],
      ['evt_queued_b_cancel', 'replayed']
    ]);
  });

  it('applies an event to a subscription another delivery bootstraps after the event found no link', async () => {
    let bootstrapAfterLookup: (() => Promise<void>) | null = null;
    const db = interceptDb(memoryAdapter({ debug: false }), {
      async findOne(params, next) {
        const found = await next();
        if (params.model === 'subscriptions' && bootstrapAfterLookup) {
          const bootstrap = bootstrapAfterLookup;
          bootstrapAfterLookup = null;
          await bootstrap();
        }
        return found;
      }
    });
    const { billfn, subscriptions, unlinked, receipt } = setup({ db });
    await billfn.quotaProvider.recordUsage({ principalId: 'late_link_user', bytes: 0 });
    // The cancellation's lookup finds nothing; an older delivery with metadata then creates the subscription.
    bootstrapAfterLookup = async () => {
      const bootstrapped = await deliver(billfn, [
        subscriptionEvent({
          eventId: 'evt_late_link_bootstrap',
          subscriptionId: 'sub_late_link',
          status: 'active',
          occurredAt: '2026-10-30T00:00:00.000Z',
          billingAccountId: 'ba_user_late_link_user'
        })
      ]);
      expect(bootstrapped.ok && bootstrapped.data.processed).toBe(1);
    };

    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_late_link_cancel',
        subscriptionId: 'sub_late_link',
        status: 'canceled',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    expect(bootstrapAfterLookup).toBeNull();
    expect((await receipt('evt_late_link_cancel'))?.processedAt).toBeTruthy();
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ billingAccountId: 'ba_user_late_link_user', status: 'canceled' });
    const entitlements = await billfn.getEntitlements({ principalId: 'late_link_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
    expect(await unlinked()).toHaveLength(0);
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
