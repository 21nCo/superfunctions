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
  BillFnVerifiedBillingState,
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
    },
    {
      productKey: 'nucleus',
      planKey: 'team',
      displayName: 'Team',
      features: { sync: true },
      limits: { storage: 5000 },
      prices: [
        {
          priceId: 'price_team_dodo_month',
          provider: 'dodo',
          providerProductId: 'pdt_team_month',
          currency: 'USD',
          amount: 30,
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
  /** Runs while the provider is read live, before verification, restore or sync returns. */
  duringLiveRead?: () => Promise<void>;
  /** The charge a subscription sync reads from the provider; the provider supports sync when set. */
  syncedChargeId?: string;
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
      syncSubscription: Boolean(options.syncedChargeId),
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
    },
    ...(options.syncedChargeId
      ? {
          async fetchSubscription(input: { subscription: BillFnSubscription }) {
            await options.duringLiveRead?.();
            return {
              subscriptionStatus: 'active' as const,
              checkoutStatus: 'succeeded' as const,
              providerSubscriptionId: input.subscription.providerSubscriptionId,
              providerChargeId: options.syncedChargeId,
              autoRenew: true,
              raw: { synced: true }
            };
          }
        }
      : {})
  };
}

function subscriptionEvent(input: {
  eventId: string;
  /** Omitted for a payment event that names only its charge. */
  subscriptionId?: string;
  chargeId?: string;
  status: SubscriptionStatus;
  occurredAt: string;
  billingAccountId?: string;
  productId?: string;
  checkoutReferenceId?: string;
}): BillFnParsedWebhookEvent {
  const data: Record<string, unknown> = {
    product_id: input.productId ?? 'pdt_pro_month',
    status: input.status
  };
  if (input.subscriptionId) {
    data.subscription_id = input.subscriptionId;
  }
  if (input.chargeId) {
    data.payment_id = input.chargeId;
  }
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
    providerChargeId: input.chargeId,
    checkoutReferenceId: input.checkoutReferenceId,
    billingState: {
      subscriptionStatus: input.status,
      checkoutStatus: 'succeeded',
      providerSubscriptionId: input.subscriptionId,
      providerChargeId: input.chargeId,
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

/** Marks a retained event as claimed by another replay run that has not released it. */
function holdRetainedEvent(db: Db, eventId: string, replayClaimedAt = '2026-11-01T00:00:00.000Z', replayClaimId = 'uwr_other') {
  return db.updateMany({
    model: 'unlinkedWebhookEvents',
    where: [{ field: 'providerEventId', operator: 'eq', value: eventId }],
    data: { status: 'replaying', replayClaimId, replayClaimedAt },
    namespace: 'billfn'
  });
}

/** Another replay run finishing row `rowId` first: it moves the only subscription to `chargeId` and marks the row replayed. */
async function finishRowElsewhere(db: Db, rowId: string, chargeId: string) {
  const [subscription] = await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
  await db.updateMany({ model: 'subscriptions', where: [{ field: 'id', operator: 'eq', value: subscription.id }], data: { providerChargeId: chargeId }, namespace: 'billfn' });
  await db.updateMany({ model: 'unlinkedWebhookEvents', where: [{ field: 'id', operator: 'eq', value: rowId }], data: { status: 'replayed' }, namespace: 'billfn' });
}

/** An active event for sub_<name> with billing account metadata for <name>_user, which bootstraps the subscription. */
function bootstrapEvent(name: string, input: { chargeId?: string; occurredAt?: string } = {}) {
  return subscriptionEvent({
    eventId: `evt_${name}_bootstrap`,
    subscriptionId: `sub_${name}`,
    chargeId: input.chargeId,
    status: 'active',
    occurredAt: input.occurredAt ?? '2026-10-30T00:00:00.000Z',
    billingAccountId: `ba_user_${name}_user`
  });
}

async function entitlementStatus(billfn: ReturnType<typeof createBillFn>, principalId: string) {
  const entitlements = await billfn.getEntitlements({ principalId });
  return entitlements.ok ? entitlements.data.entitlements?.status : undefined;
}

type TestEnv = Pick<ReturnType<typeof setup>, 'billfn' | 'db' | 'advance' | 'subscriptions' | 'unlinked'>;

/**
 * Retains a renewal moving sub_<name> to pay_<name>_2 and holds it in another replay run, so a bootstrap
 * naming pay_<name>_1 links sub_<name> and fails retryably; the other run's lease then expires.
 */
async function bootstrapWhileRenewalHeld(env: TestEnv, name: string) {
  await env.billfn.quotaProvider.recordUsage({ principalId: `${name}_user`, bytes: 0 });
  await deliver(env.billfn, [
    subscriptionEvent({ eventId: `evt_${name}_renewal`, subscriptionId: `sub_${name}`, chargeId: `pay_${name}_2`, status: 'active', occurredAt: '2026-10-30T00:00:00.000Z' })
  ]);
  await holdRetainedEvent(env.db, `evt_${name}_renewal`);
  await expect(
    deliver(env.billfn, [bootstrapEvent(name, { chargeId: `pay_${name}_1`, occurredAt: '2026-10-29T00:00:00.000Z' })])
  ).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
  env.advance(REPLAY_LEASE_MS);
}

/** Retains a cancellation naming only pay_<name>, then bootstraps sub_<name> without that charge. */
async function retainChargeCancellationThenBootstrap(env: TestEnv, name: string, cancelEventId: string) {
  await env.billfn.quotaProvider.recordUsage({ principalId: `${name}_user`, bytes: 0 });
  await deliver(env.billfn, [
    subscriptionEvent({ eventId: cancelEventId, chargeId: `pay_${name}`, status: 'canceled', occurredAt: '2026-10-31T00:00:00.000Z' })
  ]);
  env.advance(1000);
  await deliver(env.billfn, [bootstrapEvent(name)]);
  const [bootstrapped] = await env.subscriptions();
  env.advance(1000);
  return bootstrapped;
}

/**
 * With a queue worker: bootstraps sub_<name>, then retains an event for a charge no subscription carries
 * yet, dated after the reads that follow, and holds it in another replay run.
 */
async function bootstrapAndHoldChargeEvent(
  env: { billfn: ReturnType<typeof createBillFn>; worker: ReturnType<typeof createBillFnReconciliationWorker>; db: Db },
  name: string,
  input: { bootstrapChargeId?: string; eventId: string; chargeId: string; status: SubscriptionStatus; claimId: string; claimedAt: string }
) {
  await env.billfn.quotaProvider.recordUsage({ principalId: `${name}_user`, bytes: 0 });
  await deliver(env.billfn, [bootstrapEvent(name, { chargeId: input.bootstrapChargeId })]);
  await env.worker.runNext();
  await deliver(env.billfn, [
    subscriptionEvent({ eventId: input.eventId, chargeId: input.chargeId, status: input.status, occurredAt: '2026-11-01T06:00:00.000Z' })
  ]);
  await env.worker.runNext();
  await holdRetainedEvent(env.db, input.eventId, input.claimedAt, input.claimId);
}

type Mutation = 'cancelSubscription' | 'changeSubscription' | 'resumeSubscription' | 'refundCharge';

/** Calls a provider mutation for the subject; a change targets the price the subscription already has. */
function runMutation(billfn: ReturnType<typeof createBillFn>, operation: Mutation, subject: { principalId: string }) {
  switch (operation) {
    case 'cancelSubscription':
      return billfn.cancelSubscription({ subject });
    case 'changeSubscription':
      return billfn.changeSubscription({ subject, targetPriceId: 'price_pro_dodo_month' });
    case 'resumeSubscription':
      return billfn.resumeSubscription({ subject });
    default:
      return billfn.refundCharge({ subject });
  }
}

/** Asserts the account's only subscription, its entitlements, and that the retained event finished on it. */
async function expectSoleSubscription(env: TestEnv, name: string, expected: { status: SubscriptionStatus; entitlement: string; eventId: string; eventStatus: string }) {
  const [subscription, ...others] = await env.subscriptions();
  expect(others).toHaveLength(0);
  expect(subscription).toMatchObject({ billingAccountId: `ba_user_${name}_user`, status: expected.status });
  expect(await entitlementStatus(env.billfn, `${name}_user`)).toBe(expected.entitlement);
  expect(await env.unlinked()).toEqual([
    expect.objectContaining({ providerEventId: expected.eventId, status: expected.eventStatus, subscriptionId: subscription?.id })
  ]);
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
    const env = setup({ db, verifiedSubscriptionId: 'sub_interrupted' });
    const { billfn, subscriptions, advance, checkout } = env;
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
    await expectSoleSubscription(env, 'interrupted', { status: 'active', entitlement: 'active', eventId: 'evt_interrupted_cancel', eventStatus: 'skipped' });
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
    const env = setup({ db, verifiedSubscriptionId: 'sub_store_race' });
    const { billfn, receipt, advance, checkout } = env;
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
    await expectSoleSubscription(env, 'store_race', { status: 'active', entitlement: 'active', eventId: 'evt_store_race', eventStatus: 'skipped' });
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

  it('replays a retained charge event once a later event adds that charge to the subscription', async () => {
    const { billfn, subscriptions, unlinked, receipt, advance } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'charge_link_user', bytes: 0 });
    // A payment failure names only its charge, which no subscription carries yet.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_charge_failed',
        chargeId: 'pay_charge_link',
        status: 'past_due',
        occurredAt: '2026-10-31T03:00:00.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_charge_bootstrap',
        subscriptionId: 'sub_charge_link',
        status: 'active',
        occurredAt: '2026-10-31T01:00:00.000Z',
        billingAccountId: 'ba_user_charge_link_user'
      })
    ]);
    expect(await unlinked()).toEqual([expect.objectContaining({ providerEventId: 'evt_charge_failed', status: 'unlinked' })]);
    advance(1000);

    // This event links the charge to the existing subscription.
    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_charge_active',
        subscriptionId: 'sub_charge_link',
        chargeId: 'pay_charge_link',
        status: 'active',
        occurredAt: '2026-10-31T02:00:00.000Z'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    expect((await receipt('evt_charge_active'))?.processedAt).toBeTruthy();
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ providerChargeId: 'pay_charge_link', status: 'past_due' });
    const entitlements = await billfn.getEntitlements({ principalId: 'charge_link_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('grace');
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_charge_failed', status: 'replayed', subscriptionId: subscription?.id })
    ]);
  });

  it('replays a retained cancellation once a later event adds that subscription to a charge-only row', async () => {
    const { billfn, subscriptions, unlinked, advance } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'sub_link_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_sub_link_cancel',
        subscriptionId: 'sub_added_later',
        status: 'canceled',
        occurredAt: '2026-10-31T03:00:00.000Z'
      })
    ]);
    advance(1000);
    // The first payment bootstraps a row that knows only its charge.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_sub_link_payment',
        chargeId: 'pay_first',
        status: 'active',
        occurredAt: '2026-10-31T01:00:00.000Z',
        billingAccountId: 'ba_user_sub_link_user'
      })
    ]);
    expect(await subscriptions()).toEqual([expect.objectContaining({ providerChargeId: 'pay_first', status: 'active' })]);
    advance(1000);

    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_sub_link_active',
        subscriptionId: 'sub_added_later',
        chargeId: 'pay_first',
        status: 'active',
        occurredAt: '2026-10-31T02:00:00.000Z'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ providerSubscriptionId: 'sub_added_later', status: 'canceled' });
    const entitlements = await billfn.getEntitlements({ principalId: 'sub_link_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_sub_link_cancel', status: 'replayed', subscriptionId: subscription?.id })
    ]);
  });

  it('replays events for a reference that a replayed event adds', async () => {
    const { billfn, subscriptions, unlinked, advance, checkout } = setup({ verifiedSubscriptionId: 'sub_chain' });
    // Neither event can be linked yet; the second only reaches the subscription through the charge the first adds.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_chain_a_renewed',
        subscriptionId: 'sub_chain',
        chargeId: 'pay_chain',
        status: 'active',
        occurredAt: '2026-11-01T00:00:10.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_chain_b_charge_failed',
        chargeId: 'pay_chain',
        status: 'expired',
        occurredAt: '2026-11-01T00:00:20.000Z'
      })
    ]);
    advance(1000);
    const session = await checkout('chain_user');

    const verified = await billfn.verifyCheckout({
      subject: { principalId: 'chain_user' },
      checkoutSessionId: session.checkoutSessionId
    });

    if (!verified.ok) {
      throw new Error('expected verification');
    }
    expect(verified.data.subscription).toMatchObject({ providerChargeId: 'pay_chain', status: 'expired' });
    expect(verified.data.entitlements.status).toBe('inactive');
    expect(await subscriptions()).toEqual([expect.objectContaining({ status: 'expired' })]);
    expect((await unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_chain_a_renewed', 'replayed'],
      ['evt_chain_b_charge_failed', 'replayed']
    ]);
  });

  it('keeps a cancellation a webhook bootstraps while checkout verification reads the provider', async () => {
    let during: () => Promise<void> = async () => undefined;
    const { billfn, subscriptions, unlinked, advance, checkout } = setup({
      verifiedSubscriptionId: 'sub_verify_bootstrap',
      duringLiveRead: () => during()
    });
    const session = await checkout('verify_bootstrap_user');
    advance(1000);
    during = async () => {
      advance(1000);
      const bootstrapped = await deliver(billfn, [
        subscriptionEvent({
          eventId: 'evt_verify_bootstrap_cancel',
          subscriptionId: 'sub_verify_bootstrap',
          status: 'canceled',
          occurredAt: '2026-11-01T00:00:02.000Z',
          billingAccountId: 'ba_user_verify_bootstrap_user'
        })
      ]);
      expect(bootstrapped.ok && bootstrapped.data.processed).toBe(1);
    };

    const verified = await billfn.verifyCheckout({
      subject: { principalId: 'verify_bootstrap_user' },
      checkoutSessionId: session.checkoutSessionId
    });

    // The provider read started before the cancellation, so its active state is stale.
    if (!verified.ok) {
      throw new Error('expected verification');
    }
    expect(verified.data.subscription.status).toBe('canceled');
    expect(verified.data.entitlements.status).toBe('inactive');
    expect(verified.data.checkoutSession).toMatchObject({ status: 'succeeded', providerSubscriptionId: 'sub_verify_bootstrap' });
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({
      status: 'canceled',
      providerCheckoutId: session.providerCheckoutId,
      metadata: expect.objectContaining({ billfnProviderEventOccurredAt: '2026-11-01T00:00:02.000Z' })
    });
    const entitlements = await billfn.getEntitlements({ principalId: 'verify_bootstrap_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
    expect(await unlinked()).toHaveLength(0);
  });

  it('keeps a cancellation a webhook bootstraps while a restore reads the provider', async () => {
    let during: () => Promise<void> = async () => undefined;
    const { billfn, subscriptions, advance } = setup({
      verifiedSubscriptionId: 'sub_restore_bootstrap',
      duringLiveRead: () => during()
    });
    await billfn.quotaProvider.recordUsage({ principalId: 'restore_bootstrap_user', bytes: 0 });
    during = async () => {
      advance(1000);
      await deliver(billfn, [
        subscriptionEvent({
          eventId: 'evt_restore_bootstrap_cancel',
          subscriptionId: 'sub_restore_bootstrap',
          status: 'canceled',
          occurredAt: '2026-11-01T00:00:01.000Z',
          billingAccountId: 'ba_user_restore_bootstrap_user'
        })
      ]);
    };

    const restored = await billfn.restorePurchases({
      subject: { principalId: 'restore_bootstrap_user' },
      provider: 'dodo',
      planKey: 'pro'
    });

    if (!restored.ok) {
      throw new Error('expected restore');
    }
    expect(restored.data.subscription.status).toBe('canceled');
    expect(restored.data.entitlements.status).toBe('inactive');
    expect(await subscriptions()).toEqual([expect.objectContaining({ status: 'canceled' })]);
    const entitlements = await billfn.getEntitlements({ principalId: 'restore_bootstrap_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
  });

  it('replays retained events for the charge a subscription sync adds, skipping ones older than the read', async () => {
    let during: () => Promise<void> = async () => undefined;
    const env = setup({ syncedChargeId: 'pay_sync', duringLiveRead: () => during() });
    const { billfn, subscriptions, unlinked, advance } = env;
    // A cancellation that names only the charge is retained before the subscription exists.
    const bootstrapped = await retainChargeCancellationThenBootstrap(env, 'sync', 'evt_sync_a_cancel');
    // A payment failure for the charge arrives while the sync reads the provider, so it is newer than the read.
    during = async () => {
      advance(1000);
      await deliver(billfn, [
        subscriptionEvent({
          eventId: 'evt_sync_b_failed',
          chargeId: 'pay_sync',
          status: 'past_due',
          occurredAt: '2026-11-01T00:00:03.000Z'
        })
      ]);
    };

    const synced = await billfn.syncSubscription({
      subject: { principalId: 'sync_user' },
      subscriptionId: bootstrapped?.id ?? ''
    });

    if (!synced.ok) {
      throw new Error('expected sync');
    }
    // The read's active state supersedes the older cancellation; the newer payment failure is applied after it.
    expect(synced.data.subscription).toMatchObject({ providerChargeId: 'pay_sync', status: 'past_due' });
    expect(synced.data.entitlements.status).toBe('grace');
    expect(await subscriptions()).toEqual([expect.objectContaining({ status: 'past_due' })]);
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_sync_a_cancel', status: 'skipped' }),
      expect.objectContaining({ providerEventId: 'evt_sync_b_failed', status: 'replayed' })
    ]);
  });

  it('keeps the live state a subscription sync job reads over an older retained event for the charge it adds', async () => {
    const env = setup({ syncedChargeId: 'pay_job_sync' });
    const { billfn, subscriptions, unlinked } = env;
    const bootstrapped = await retainChargeCancellationThenBootstrap(env, 'job_sync', 'evt_job_sync_cancel');

    const enqueued = await billfn.enqueueReconciliationJob({ kind: 'subscription-sync', subscriptionId: bootstrapped?.id });
    if (!enqueued.ok) {
      throw new Error('expected job');
    }
    const run = await billfn.runReconciliationJob({ jobId: enqueued.data.job.id });

    expect(run.ok && run.data.job.status).toBe('succeeded');
    expect(await subscriptions()).toEqual([
      expect.objectContaining({ providerChargeId: 'pay_job_sync', status: 'active' })
    ]);
    const entitlements = await billfn.getEntitlements({ principalId: 'job_sync_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('active');
    expect(await unlinked()).toEqual([expect.objectContaining({ providerEventId: 'evt_job_sync_cancel', status: 'skipped' })]);
  });

  it('replays on a sync job retry the retained event an interrupted replay held on the first attempt', async () => {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-01T00:00:00.000Z') };
    const queue = new MemoryQueueAdapter<BillFnQueuedJob>({ now: () => clock.current.getTime() });
    const config = {
      db,
      catalog,
      queue,
      now: () => clock.current,
      providers: { dodo: createProvider({ syncedChargeId: 'pay_sync_retry' }) }
    };
    const billfn = createBillFn(config);
    const worker = createBillFnReconciliationWorker(config);
    // A payment failure for a charge no subscription carries yet, dated after both sync reads below; a
    // replay run claimed it and stopped before releasing it.
    await bootstrapAndHoldChargeEvent({ billfn, worker, db }, 'sync_retry', {
      eventId: 'evt_sync_retry_failed',
      chargeId: 'pay_sync_retry',
      status: 'past_due',
      claimId: 'uwr_interrupted',
      claimedAt: clock.current.toISOString()
    });
    const [bootstrapped] = await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
    await billfn.enqueueReconciliationJob({ kind: 'subscription-sync', subscriptionId: bootstrapped?.id });

    // The first attempt saves the synced charge, then finds the retained event held and is retried.
    await expect(worker.runNext()).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
    const afterFirst = await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
    expect(afterFirst).toEqual([expect.objectContaining({ providerChargeId: 'pay_sync_retry', status: 'active' })]);

    // The retry adds no reference, but still replays the event once the interrupted claim's lease expires.
    clock.current = new Date(clock.current.getTime() + REPLAY_LEASE_MS);
    expect(await worker.runNext()).toMatchObject({ status: 'succeeded' });

    expect(await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' })).toEqual([
      expect.objectContaining({ providerChargeId: 'pay_sync_retry', status: 'past_due' })
    ]);
    const entitlements = await billfn.getEntitlements({ principalId: 'sync_retry_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('grace');
    const [row] = await db.findMany<BillFnUnlinkedWebhookEvent>({ model: 'unlinkedWebhookEvents', where: [], namespace: 'billfn' });
    expect(row).toMatchObject({ providerEventId: 'evt_sync_retry_failed', status: 'replayed', subscriptionId: bootstrapped?.id });
  });

  it('replays events after one whose reference an earlier replayed event replaced', async () => {
    const { billfn, subscriptions, unlinked, advance, receipt } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'churn_user', bytes: 0 });
    // Retained in delivery order: a renewal moves the subscription to charge pay_churn_2, a payment
    // failure names only the earlier charge pay_churn_1, then the subscription is canceled.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_churn_1_renewed',
        subscriptionId: 'sub_churn',
        chargeId: 'pay_churn_2',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_churn_2_failed',
        chargeId: 'pay_churn_1',
        status: 'past_due',
        occurredAt: '2026-10-30T12:00:00.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_churn_3_canceled',
        subscriptionId: 'sub_churn',
        status: 'canceled',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);
    advance(1000);

    // The bootstrap links sub_churn with the earlier charge pay_churn_1.
    const result = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_churn_0_bootstrap',
        subscriptionId: 'sub_churn',
        chargeId: 'pay_churn_1',
        status: 'active',
        occurredAt: '2026-10-29T00:00:00.000Z',
        billingAccountId: 'ba_user_churn_user'
      })
    ]);

    expect(result.ok && result.data).toMatchObject({ accepted: true, processed: 1 });
    expect((await receipt('evt_churn_0_bootstrap'))?.processedAt).toBeTruthy();
    const [subscription] = await subscriptions();
    expect(subscription).toMatchObject({ providerChargeId: 'pay_churn_2', status: 'canceled' });
    const entitlements = await billfn.getEntitlements({ principalId: 'churn_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
    // The payment failure for the replaced charge stays unlinked, as it would have been delivered in order.
    expect((await unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_churn_1_renewed', 'replayed'],
      ['evt_churn_2_failed', 'unlinked'],
      ['evt_churn_3_canceled', 'replayed']
    ]);
  });

  it('links the charge an earlier-dated payment event names after a verification linked only the subscription', async () => {
    const { billfn, subscriptions, unlinked, advance, checkout, receipt } = setup({ verifiedSubscriptionId: 'sub_vc' });
    // A cancellation naming only the charge, older than the verification, is retained.
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_vc_old', chargeId: 'pay_vc', status: 'canceled', occurredAt: '2026-10-31T00:00:00.000Z' })
    ]);
    advance(1000);
    const session = await checkout('vc_user');
    advance(1000);
    const verified = await billfn.verifyCheckout({
      subject: { principalId: 'vc_user' },
      checkoutSessionId: session.checkoutSessionId
    });
    expect(verified.ok && verified.data.subscription).toMatchObject({ status: 'active', providerChargeId: undefined });
    advance(1000);

    // The first payment event occurred before the verification read the provider: its state is stale, its charge is not.
    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_vc_payment',
        subscriptionId: 'sub_vc',
        chargeId: 'pay_vc',
        status: 'expired',
        occurredAt: '2026-11-01T00:00:01.000Z'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    expect((await receipt('evt_vc_payment'))?.processedAt).toBeTruthy();
    const [subscription, ...others] = await subscriptions();
    expect(others).toHaveLength(0);
    expect(subscription).toMatchObject({ providerSubscriptionId: 'sub_vc', providerChargeId: 'pay_vc', status: 'active' });
    expect(subscription?.metadata?.billfnProviderEventOccurredAt).toBe('2026-11-01T00:00:02.000Z');
    const entitlements = await billfn.getEntitlements({ principalId: 'vc_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('active');
    // The retained charge event is older than the verification, so linking its charge replays it as skipped.
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_vc_old', status: 'skipped', subscriptionId: subscription?.id })
    ]);
  });

  it('replays a newer retained charge event once an earlier-dated payment event links that charge', async () => {
    const { billfn, subscriptions, unlinked, advance, checkout } = setup({ verifiedSubscriptionId: 'sub_vn' });
    const session = await checkout('vn_user');
    advance(1000);
    await billfn.verifyCheckout({ subject: { principalId: 'vn_user' }, checkoutSessionId: session.checkoutSessionId });
    advance(1000);
    // A payment failure naming only the charge, after the verification, is retained: no subscription carries the charge.
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_vn_failed', chargeId: 'pay_vn', status: 'past_due', occurredAt: '2026-11-01T00:00:05.000Z' })
    ]);
    expect(await unlinked()).toEqual([expect.objectContaining({ providerEventId: 'evt_vn_failed', status: 'unlinked' })]);
    advance(1000);

    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_vn_payment',
        subscriptionId: 'sub_vn',
        chargeId: 'pay_vn',
        status: 'active',
        occurredAt: '2026-11-01T00:00:00.500Z'
      })
    ]);

    expect(response.ok && response.data.processed).toBe(1);
    expect(await subscriptions()).toEqual([
      expect.objectContaining({ providerChargeId: 'pay_vn', status: 'past_due' })
    ]);
    const entitlements = await billfn.getEntitlements({ principalId: 'vn_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('grace');
    expect(await unlinked()).toEqual([expect.objectContaining({ providerEventId: 'evt_vn_failed', status: 'replayed' })]);
  });

  it('links the charge of a retained event older than the live state and replays the events stored for it', async () => {
    const { billfn, subscriptions, unlinked, advance, checkout } = setup({ verifiedSubscriptionId: 'sub_rc' });
    // Retained before the subscription exists: an older event naming the subscription and its charge, an older
    // charge-only cancellation, and a payment failure for the charge dated after the verification below.
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_rc_1_link',
        subscriptionId: 'sub_rc',
        chargeId: 'pay_rc',
        status: 'expired',
        occurredAt: '2026-10-31T00:00:00.000Z'
      })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_rc_2_cancel', chargeId: 'pay_rc', status: 'canceled', occurredAt: '2026-10-31T12:00:00.000Z' })
    ]);
    advance(1000);
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_rc_3_failed', chargeId: 'pay_rc', status: 'past_due', occurredAt: '2026-11-01T00:01:00.000Z' })
    ]);
    advance(1000);
    const session = await checkout('rc_user');
    advance(1000);

    const verified = await billfn.verifyCheckout({
      subject: { principalId: 'rc_user' },
      checkoutSessionId: session.checkoutSessionId
    });

    // The live read links only the subscription. Its older retained event is skipped but links the charge, so the
    // charge's events replay too: the older cancellation is skipped and the newer payment failure applies.
    if (!verified.ok) {
      throw new Error('expected verification');
    }
    expect(verified.data.subscription).toMatchObject({ providerChargeId: 'pay_rc', status: 'past_due' });
    expect(verified.data.entitlements.status).toBe('grace');
    expect(await subscriptions()).toEqual([expect.objectContaining({ providerChargeId: 'pay_rc', status: 'past_due' })]);
    expect(await unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_rc_1_link', status: 'skipped' }),
      expect.objectContaining({ providerEventId: 'evt_rc_2_cancel', status: 'skipped' }),
      expect.objectContaining({ providerEventId: 'evt_rc_3_failed', status: 'replayed' })
    ]);
  });

  it('does not link a charge another subscription holds from an event older than the subscription state', async () => {
    const { billfn, subscriptions, unlinked } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'own_a', bytes: 0 });
    await billfn.quotaProvider.recordUsage({ principalId: 'own_b', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_own_a',
        subscriptionId: 'sub_own_a',
        status: 'active',
        occurredAt: '2026-10-31T00:00:00.000Z',
        billingAccountId: 'ba_user_own_a'
      }),
      subscriptionEvent({
        eventId: 'evt_own_b',
        subscriptionId: 'sub_own_b',
        chargeId: 'pay_own_b',
        status: 'active',
        occurredAt: '2026-10-31T00:00:00.000Z',
        billingAccountId: 'ba_user_own_b'
      })
    ]);

    // An older event pairs the first subscription with the charge the second already holds.
    const response = await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_own_stale',
        subscriptionId: 'sub_own_a',
        chargeId: 'pay_own_b',
        status: 'expired',
        occurredAt: '2026-10-30T00:00:00.000Z'
      })
    ]);

    expect(response.ok).toBe(true);
    const rows = await subscriptions();
    expect(rows.find((row) => row.providerSubscriptionId === 'sub_own_a')).toMatchObject({
      status: 'active',
      providerChargeId: undefined
    });
    expect(rows.filter((row) => row.providerChargeId === 'pay_own_b')).toEqual([
      expect.objectContaining({ providerSubscriptionId: 'sub_own_b', status: 'active' })
    ]);
    expect(await unlinked()).toHaveLength(0);
  });

  it('returns the state a committed cancellation wrote when reading it back fails', async () => {
    const fault = { armed: false };
    const providerCalls: string[] = [];
    const db = interceptDb(memoryAdapter({ debug: false }), {
      create: async (params, next) => {
        const type = (params.data as { type?: string }).type;
        if (params.model === 'billingEvents' && type === 'billfn.subscription.canceled') {
          fault.armed = true;
        }
        if (params.model === 'billingEvents' && type === 'billfn.subscription.cancel.requested') {
          fault.armed = false;
        }
        return next();
      },
      findOne: async (params, next) => {
        if (fault.armed && params.model === 'subscriptions') {
          throw new Error('injected subscription read failure');
        }
        return next();
      }
    });
    const base = createProvider({});
    const billfn = createBillFn({
      db,
      catalog,
      now: () => new Date('2026-11-01T00:00:00.000Z'),
      providers: {
        dodo: {
          ...base,
          capabilities: { ...base.capabilities, cancelSubscription: true },
          async cancelSubscription(input) {
            providerCalls.push('cancelSubscription');
            return {
              operationStatus: 'applied',
              billingState: {
                subscriptionStatus: 'canceled',
                checkoutStatus: 'succeeded',
                providerSubscriptionId: input.subscription.providerSubscriptionId,
                autoRenew: false
              }
            };
          }
        }
      }
    });
    await billfn.quotaProvider.recordUsage({ principalId: 'rf_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_rf_bootstrap',
        subscriptionId: 'sub_rf',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z',
        billingAccountId: 'ba_user_rf_user'
      })
    ]);

    const response = await billfn.cancelSubscription({ subject: { principalId: 'rf_user' } });

    expect(response.ok).toBe(true);
    expect(response.ok && response.data.subscription).toMatchObject({ providerSubscriptionId: 'sub_rf', status: 'canceled' });
    expect(response.ok && response.data.entitlements.status).toBe('inactive');
    expect(providerCalls).toEqual(['cancelSubscription']);
    const requested = await db.findMany<{ type: string }>({
      model: 'billingEvents',
      where: [{ field: 'type', operator: 'eq', value: 'billfn.subscription.cancel.requested' }],
      namespace: 'billfn'
    });
    expect(requested).toHaveLength(1);
  });

  it.each([
    ['cancelSubscription', 'billfn.subscription.cancel.requested'],
    ['changeSubscription', 'billfn.subscription.change.requested'],
    ['resumeSubscription', 'billfn.subscription.resume.requested'],
    ['refundCharge', 'billfn.refund.requested']
  ] as const)(
    'completes %s once the provider applied it while a retained event is held, and replays the event later',
    async (operation, billingEventType) => {
      const db = memoryAdapter({ debug: false });
      const clock = { current: new Date('2026-11-01T00:00:00.000Z') };
      const queue = new MemoryQueueAdapter<BillFnQueuedJob>({ now: () => clock.current.getTime() });
      const providerCalls: string[] = [];
      // Each mutation's response carries the charge pay_mut_next, which a retained event names.
      const operationResult = (status: SubscriptionStatus) => ({
        operationStatus: 'applied' as const,
        providerRefundId: 're_mut',
        billingState: {
          subscriptionStatus: status,
          checkoutStatus: 'succeeded' as const,
          providerSubscriptionId: 'sub_mut',
          providerChargeId: 'pay_mut_next',
          autoRenew: status === 'active'
        }
      });
      const base = createProvider({ syncedChargeId: 'pay_mut_next' });
      const provider: BillFnProviderAdapter = {
        ...base,
        capabilities: {
          ...base.capabilities,
          cancelSubscription: true,
          changeSubscription: true,
          resumeSubscription: true,
          refundCharge: true
        },
        async cancelSubscription() {
          providerCalls.push('cancelSubscription');
          return operationResult('canceled');
        },
        async changeSubscription() {
          providerCalls.push('changeSubscription');
          return operationResult('active');
        },
        async resumeSubscription() {
          providerCalls.push('resumeSubscription');
          return operationResult('active');
        },
        async refundCharge() {
          providerCalls.push('refundCharge');
          return operationResult('active');
        }
      };
      const config = { db, catalog, queue, now: () => clock.current, providers: { dodo: provider } };
      const billfn = createBillFn(config);
      const worker = createBillFnReconciliationWorker(config);
      // An expiry for the next charge, dated after the mutation, retained because no subscription carries it
      // yet, and held by another replay run.
      await bootstrapAndHoldChargeEvent({ billfn, worker, db }, 'mut', {
        bootstrapChargeId: 'pay_mut_first',
        eventId: 'evt_mut_expired',
        chargeId: 'pay_mut_next',
        status: 'expired',
        claimId: 'uwr_other',
        claimedAt: clock.current.toISOString()
      });
      const subject = { principalId: 'mut_user' };

      const response = await runMutation(billfn, operation, subject);

      expect(response.ok).toBe(true);
      expect(response.ok && response.data.subscription).toMatchObject({ providerChargeId: 'pay_mut_next' });
      expect(providerCalls).toEqual([operation]);
      const billingEvents = await db.findMany<{ type: string }>({
        model: 'billingEvents',
        where: [{ field: 'type', operator: 'eq', value: billingEventType }],
        namespace: 'billfn'
      });
      expect(billingEvents).toHaveLength(1);
      const [held] = await db.findMany<BillFnUnlinkedWebhookEvent>({
        model: 'unlinkedWebhookEvents',
        where: [{ field: 'providerEventId', operator: 'eq', value: 'evt_mut_expired' }],
        namespace: 'billfn'
      });
      expect(held).toMatchObject({ status: 'replaying', replayClaimId: 'uwr_other' });

      // The subscription sync the mutation enqueued replays the event once the other run's lease expires.
      clock.current = new Date(clock.current.getTime() + REPLAY_LEASE_MS);
      expect(await worker.runNext()).toMatchObject({ status: 'succeeded' });
      expect(providerCalls).toEqual([operation]);
      expect(await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' })).toEqual([
        expect.objectContaining({ providerChargeId: 'pay_mut_next', status: 'expired' })
      ]);
      const entitlements = await billfn.getEntitlements(subject);
      expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
      const [replayed] = await db.findMany<BillFnUnlinkedWebhookEvent>({
        model: 'unlinkedWebhookEvents',
        where: [{ field: 'providerEventId', operator: 'eq', value: 'evt_mut_expired' }],
        namespace: 'billfn'
      });
      expect(replayed).toMatchObject({ status: 'replayed' });
    }
  );
});

describe('ordered replay and committed provider mutations (PR #308 round 1)', () => {
  async function billingEventTypes(db: Db) {
    const events = await db.findMany<{ type: string }>({ model: 'billingEvents', where: [], namespace: 'billfn' });
    return events.map((event) => event.type);
  }

  it.each([
    ['cancelSubscription', 'canceled', 'inactive'],
    ['changeSubscription', 'active', 'active'],
    ['resumeSubscription', 'active', 'active'],
    ['refundCharge', 'canceled', 'inactive']
  ] as const)(
    'keeps the state %s committed after an event applied while the provider call was in flight',
    async (operation, committedStatus, entitlementStatus) => {
      const db = memoryAdapter({ debug: false });
      const clock = { current: new Date('2026-11-01T00:00:01.000Z') };
      const queue = new MemoryQueueAdapter<BillFnQueuedJob>({ now: () => clock.current.getTime() });
      const providerCalls: string[] = [];
      let worker!: ReturnType<typeof createBillFnReconciliationWorker>;
      let billfn!: ReturnType<typeof createBillFn>;
      // A past-due event occurs and is applied after the call starts (t1) and before the provider commits (t3).
      const commit = async (name: string) => {
        providerCalls.push(name);
        clock.current = new Date('2026-11-01T00:00:02.000Z');
        await deliver(billfn, [
          subscriptionEvent({ eventId: `evt_race_${name}`, subscriptionId: 'sub_race', status: 'past_due', occurredAt: clock.current.toISOString() })
        ]);
        await worker.runNext();
        clock.current = new Date('2026-11-01T00:00:03.000Z');
        return {
          operationStatus: 'applied' as const,
          providerRefundId: 're_race',
          billingState: {
            subscriptionStatus: committedStatus,
            checkoutStatus: 'succeeded' as const,
            providerSubscriptionId: 'sub_race',
            autoRenew: committedStatus === 'active'
          }
        };
      };
      const base = createProvider({ syncedChargeId: 'pay_race' });
      const provider: BillFnProviderAdapter = {
        ...base,
        capabilities: { ...base.capabilities, cancelSubscription: true, changeSubscription: true, resumeSubscription: true, refundCharge: true },
        cancelSubscription: () => commit('cancelSubscription'),
        changeSubscription: () => commit('changeSubscription'),
        resumeSubscription: () => commit('resumeSubscription'),
        refundCharge: () => commit('refundCharge')
      };
      const config = { db, catalog, queue, now: () => clock.current, providers: { dodo: provider } };
      billfn = createBillFn(config);
      worker = createBillFnReconciliationWorker(config);
      await billfn.quotaProvider.recordUsage({ principalId: 'race_user', bytes: 0 });
      await deliver(billfn, [
        subscriptionEvent({
          eventId: 'evt_race_bootstrap',
          subscriptionId: 'sub_race',
          chargeId: 'pay_race',
          status: 'active',
          occurredAt: '2026-10-30T00:00:00.000Z',
          billingAccountId: 'ba_user_race_user'
        })
      ]);
      await worker.runNext();
      const subject = { principalId: 'race_user' };

      const response = await runMutation(billfn, operation, subject);

      expect(response.ok).toBe(true);
      expect(response.ok && response.data.subscription).toMatchObject({ status: committedStatus });
      expect(response.ok && response.data.entitlements?.status).toBe(entitlementStatus);
      expect(providerCalls).toEqual([operation]);
      const [stored] = await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
      expect(stored).toMatchObject({
        status: committedStatus,
        metadata: expect.objectContaining({ billfnProviderEventOccurredAt: '2026-11-01T00:00:03.000Z' })
      });
      const entitlements = await billfn.getEntitlements(subject);
      expect(entitlements.ok && entitlements.data.entitlements?.status).toBe(entitlementStatus);
      const requested = (await billingEventTypes(db)).filter((type) => type.endsWith('.requested'));
      expect(requested).toHaveLength(1);
      // The race is reconciled by a provider read, never by repeating the mutation.
      const syncJobs = await db.findMany<{ kind: string }>({
        model: 'reconciliationJobs',
        where: [{ field: 'kind', operator: 'eq', value: 'subscription-sync' }],
        namespace: 'billfn'
      });
      expect(syncJobs).toHaveLength(1);
      expect(await worker.runNext()).toMatchObject({ status: 'succeeded' });
      expect(providerCalls).toEqual([operation]);
    }
  );

  it('keeps an event that occurred after a committed cancellation returned and reconciles the subscription', async () => {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-01T00:00:01.000Z') };
    const queue = new MemoryQueueAdapter<BillFnQueuedJob>({ now: () => clock.current.getTime() });
    let worker!: ReturnType<typeof createBillFnReconciliationWorker>;
    let billfn!: ReturnType<typeof createBillFn>;
    const base = createProvider({ syncedChargeId: 'pay_late' });
    const provider: BillFnProviderAdapter = {
      ...base,
      capabilities: { ...base.capabilities, cancelSubscription: true },
      async cancelSubscription() {
        // The provider reports a renewal that occurred after the cancellation returns.
        await deliver(billfn, [
          subscriptionEvent({ eventId: 'evt_late_renewal', subscriptionId: 'sub_late', status: 'past_due', occurredAt: '2026-11-01T01:00:00.000Z' })
        ]);
        await worker.runNext();
        clock.current = new Date('2026-11-01T00:00:03.000Z');
        return {
          operationStatus: 'applied',
          billingState: { subscriptionStatus: 'canceled', checkoutStatus: 'succeeded', providerSubscriptionId: 'sub_late', autoRenew: false }
        };
      }
    };
    const config = { db, catalog, queue, now: () => clock.current, providers: { dodo: provider } };
    billfn = createBillFn(config);
    worker = createBillFnReconciliationWorker(config);
    await billfn.quotaProvider.recordUsage({ principalId: 'late_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_late_bootstrap',
        subscriptionId: 'sub_late',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z',
        billingAccountId: 'ba_user_late_user'
      })
    ]);
    await worker.runNext();

    const response = await billfn.cancelSubscription({ subject: { principalId: 'late_user' } });

    expect(response.ok && response.data.subscription).toMatchObject({ status: 'past_due' });
    const syncJobs = await db.findMany<{ kind: string }>({
      model: 'reconciliationJobs',
      where: [{ field: 'kind', operator: 'eq', value: 'subscription-sync' }],
      namespace: 'billfn'
    });
    expect(syncJobs).toHaveLength(1);
  });

  it('reconciles a raced committed cancellation with an inline provider read when no queue is configured', async () => {
    const providerCalls: string[] = [];
    let billfn!: ReturnType<typeof createBillFn>;
    let current = new Date('2026-11-01T00:00:01.000Z');
    const base = createProvider({ syncedChargeId: 'pay_inline' });
    const provider: BillFnProviderAdapter = {
      ...base,
      capabilities: { ...base.capabilities, cancelSubscription: true },
      async cancelSubscription() {
        providerCalls.push('cancelSubscription');
        current = new Date('2026-11-01T00:00:02.000Z');
        await deliver(billfn, [
          subscriptionEvent({ eventId: 'evt_inline_race', subscriptionId: 'sub_inline', status: 'past_due', occurredAt: current.toISOString() })
        ]);
        current = new Date('2026-11-01T00:00:03.000Z');
        return {
          operationStatus: 'applied',
          billingState: { subscriptionStatus: 'canceled', checkoutStatus: 'succeeded', providerSubscriptionId: 'sub_inline', autoRenew: false }
        };
      }
    };
    billfn = createBillFn({ db: memoryAdapter({ debug: false }), catalog, now: () => current, providers: { dodo: provider } });
    await billfn.quotaProvider.recordUsage({ principalId: 'inline_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_inline_bootstrap',
        subscriptionId: 'sub_inline',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z',
        billingAccountId: 'ba_user_inline_user'
      })
    ]);

    const response = await billfn.cancelSubscription({ subject: { principalId: 'inline_user' } });

    // The fixture provider's record reads active, and that read, not a repeated cancellation, is returned.
    expect(response.ok && response.data.subscription).toMatchObject({ status: 'active', providerChargeId: 'pay_inline' });
    expect(providerCalls).toEqual(['cancelSubscription']);
  });

  it('does not apply a delivered event to the subscription whose charge a replayed event replaced', async () => {
    const env = setup();
    const { billfn, subscriptions, unlinked, receipt } = env;
    // A renewal moving sub_stale to pay_stale_2 is retained, then held while the bootstrap links sub_stale.
    await bootstrapWhileRenewalHeld(env, 'stale');

    // A payment failure naming only the first charge resolves to the subscription, but the replay
    // it triggers moves the subscription to pay_stale_2 first.
    const result = await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_stale_failed', chargeId: 'pay_stale_1', status: 'past_due', occurredAt: '2026-10-31T00:00:00.000Z' })
    ]);

    expect(result.ok).toBe(true);
    expect((await receipt('evt_stale_failed'))?.processedAt).toBeTruthy();
    expect(await subscriptions()).toEqual([
      expect.objectContaining({ providerSubscriptionId: 'sub_stale', providerChargeId: 'pay_stale_2', status: 'active' })
    ]);
    expect(await entitlementStatus(billfn, 'stale_user')).toBe('active');
    expect((await unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_stale_failed', 'unlinked'],
      ['evt_stale_renewal', 'replayed']
    ]);
  });

  it('keeps a newer state written concurrently over a replayed event without a provider time', async () => {
    const armed = { claim: false, written: false };
    let memory!: Db;
    const db = interceptDb((memory = memoryAdapter({ debug: false })), {
      updateMany: async (params, next) => {
        if (params.model === 'unlinkedWebhookEvents' && (params.data as { status?: string }).status === 'replaying') {
          armed.claim = true;
        }
        return next();
      },
      findOne: async (params, next) => {
        if (armed.claim && !armed.written && params.model === 'checkoutSessions') {
          // A concurrent sync writes newer provider state after the replay read the subscription.
          armed.written = true;
          const [current] = await memory.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
          await memory.updateMany({
            model: 'subscriptions',
            where: [{ field: 'id', operator: 'eq', value: current.id }],
            data: {
              status: 'canceled',
              updatedAt: '2026-11-01T00:00:05.000Z',
              metadata: { ...current.metadata, billfnProviderEventOccurredAt: '2026-11-01T00:00:05.000Z' }
            },
            namespace: 'billfn'
          });
        }
        return next();
      }
    });
    const { billfn, subscriptions, unlinked, advance } = setup({ db });
    await billfn.quotaProvider.recordUsage({ principalId: 'untimed_user', bytes: 0 });
    const untimed = { ...subscriptionEvent({ eventId: 'evt_untimed', subscriptionId: 'sub_untimed', status: 'past_due', occurredAt: '' }), occurredAt: undefined };
    await deliver(billfn, [untimed]);
    advance(1000);

    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_untimed_bootstrap',
        subscriptionId: 'sub_untimed',
        status: 'active',
        occurredAt: '2026-10-29T00:00:00.000Z',
        billingAccountId: 'ba_user_untimed_user'
      })
    ]);

    expect(armed.written).toBe(true);
    expect(await subscriptions()).toEqual([
      expect.objectContaining({
        status: 'canceled',
        metadata: expect.objectContaining({ billfnProviderEventOccurredAt: '2026-11-01T00:00:05.000Z' })
      })
    ]);
    expect(await unlinked()).toEqual([expect.objectContaining({ providerEventId: 'evt_untimed', status: 'skipped' })]);
  });

  it('replays a retained event naming a subscription and a charge once a charge-only event links that charge', async () => {
    const { billfn, subscriptions, unlinked, advance } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'secondary_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_secondary_cancel', subscriptionId: 'sub_secondary', chargeId: 'pay_secondary', status: 'canceled', occurredAt: '2026-10-31T00:00:00.000Z' })
    ]);
    advance(1000);

    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_secondary_payment',
        chargeId: 'pay_secondary',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z',
        billingAccountId: 'ba_user_secondary_user'
      })
    ]);

    expect(await subscriptions()).toEqual([
      expect.objectContaining({ providerSubscriptionId: 'sub_secondary', providerChargeId: 'pay_secondary', status: 'canceled' })
    ]);
    const entitlements = await billfn.getEntitlements({ principalId: 'secondary_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
    expect(await unlinked()).toEqual([
      expect.objectContaining({
        providerEventId: 'evt_secondary_cancel',
        providerReference: 'sub_secondary',
        providerSecondaryReference: 'pay_secondary',
        status: 'replayed'
      })
    ]);
  });

  it('replays an event naming a charge the subscription held only between two replayed events', async () => {
    const { billfn, db, subscriptions, unlinked, advance } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'between_user', bytes: 0 });
    for (const event of [
      subscriptionEvent({ eventId: 'evt_between_1_c1', subscriptionId: 'sub_between', chargeId: 'pay_between_1', status: 'active', occurredAt: '2026-10-30T00:00:00.000Z' }),
      subscriptionEvent({ eventId: 'evt_between_2_failed', chargeId: 'pay_between_1', status: 'past_due', occurredAt: '2026-10-30T12:00:00.000Z' }),
      subscriptionEvent({ eventId: 'evt_between_3_c2', subscriptionId: 'sub_between', chargeId: 'pay_between_2', status: 'active', occurredAt: '2026-10-31T00:00:00.000Z' })
    ]) {
      await deliver(billfn, [event]);
      advance(1000);
    }

    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_between_0_bootstrap',
        subscriptionId: 'sub_between',
        status: 'active',
        occurredAt: '2026-10-29T00:00:00.000Z',
        billingAccountId: 'ba_user_between_user'
      })
    ]);

    expect(await subscriptions()).toEqual([
      expect.objectContaining({ providerChargeId: 'pay_between_2', status: 'active' })
    ]);
    expect((await unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_between_1_c1', 'replayed'],
      ['evt_between_2_failed', 'replayed'],
      ['evt_between_3_c2', 'replayed']
    ]);
    expect(await billingEventTypes(db)).toContain('billfn.subscription.past_due');
  });

  it('records a replayed event once when its row is finished only on a later replay', async () => {
    const fault = { armed: true };
    const db = interceptDb(memoryAdapter({ debug: false }), {
      updateMany: async (params, next) => {
        if (fault.armed && params.model === 'unlinkedWebhookEvents' && (params.data as { status?: string }).status === 'replayed') {
          fault.armed = false;
          throw new Error('injected replay finalization failure');
        }
        return next();
      }
    });
    const { billfn, unlinked, advance } = setup({ db });
    await billfn.quotaProvider.recordUsage({ principalId: 'once_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_once_cancel', subscriptionId: 'sub_once', status: 'canceled', occurredAt: '2026-10-31T00:00:00.000Z' })
    ]);
    advance(1000);
    const bootstrap = subscriptionEvent({
      eventId: 'evt_once_bootstrap',
      subscriptionId: 'sub_once',
      status: 'active',
      occurredAt: '2026-10-30T00:00:00.000Z',
      billingAccountId: 'ba_user_once_user'
    });

    // The cancellation is applied, but marking its row finished fails, so the row keeps its claim.
    await expect(deliver(billfn, [bootstrap])).rejects.toThrow('injected replay finalization failure');
    advance(REPLAY_LEASE_MS);
    const redelivered = await deliver(billfn, [bootstrap]);

    expect(redelivered.ok && redelivered.data.processed).toBe(1);
    expect(await unlinked()).toEqual([expect.objectContaining({ providerEventId: 'evt_once_cancel', status: 'replayed' })]);
    expect((await billingEventTypes(db)).filter((type) => type === 'billfn.subscription.canceled')).toHaveLength(1);
  });

  it('stops a replay at an event that fails with an empty error message', async () => {
    const fault = { claimed: false, thrown: false };
    const db = interceptDb(memoryAdapter({ debug: false }), {
      updateMany: async (params, next) => {
        if (params.model === 'unlinkedWebhookEvents' && (params.data as { status?: string }).status === 'replaying') {
          fault.claimed = true;
        }
        return next();
      },
      findOne: async (params, next) => {
        if (fault.claimed && !fault.thrown && params.model === 'subscriptions') {
          fault.thrown = true;
          throw new Error('');
        }
        return next();
      }
    });
    const { billfn, db: store, subscriptions, unlinked, advance } = setup({ db });
    await billfn.quotaProvider.recordUsage({ principalId: 'empty_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_empty_1_failed', subscriptionId: 'sub_empty', status: 'past_due', occurredAt: '2026-10-30T12:00:00.000Z' })
    ]);
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_empty_2_canceled', subscriptionId: 'sub_empty', status: 'canceled', occurredAt: '2026-10-31T00:00:00.000Z' })
    ]);
    advance(1000);
    const bootstrap = subscriptionEvent({
      eventId: 'evt_empty_0_bootstrap',
      subscriptionId: 'sub_empty',
      status: 'active',
      occurredAt: '2026-10-30T00:00:00.000Z',
      billingAccountId: 'ba_user_empty_user'
    });

    await expect(deliver(billfn, [bootstrap])).rejects.toThrow();
    expect((await unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_empty_1_failed', 'unlinked'],
      ['evt_empty_2_canceled', 'unlinked']
    ]);
    expect(await subscriptions()).toEqual([expect.objectContaining({ status: 'active' })]);

    advance(1000);
    await deliver(billfn, [bootstrap]);

    expect((await unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_empty_1_failed', 'replayed'],
      ['evt_empty_2_canceled', 'replayed']
    ]);
    expect(await subscriptions()).toEqual([expect.objectContaining({ status: 'canceled' })]);
    expect(await billingEventTypes(store)).toContain('billfn.subscription.past_due');
  });
});

describe('committed mutation window and concurrent replay (PR #308 round 1 delta review)', () => {
  async function bootstrapped(principalId: string, subscriptionId: string, provider: BillFnProviderAdapter) {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-01T00:00:01.000Z') };
    const billfn = createBillFn({ db, catalog, now: () => clock.current, providers: { dodo: provider } });
    await billfn.quotaProvider.recordUsage({ principalId, bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({
        eventId: `evt_${principalId}_bootstrap`,
        subscriptionId,
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z',
        billingAccountId: `ba_user_${principalId}`
      })
    ]);
    const stored = async () =>
      (await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' }))[0];
    return { db, clock, billfn, stored };
  }

  it.each([
    ['changeSubscription', 'subscriptionChangeRequests'],
    ['refundCharge', 'refunds']
  ] as const)(
    'keeps an event that occurred after %s returned and was applied while its record was written',
    async (operation, recordModel) => {
      const clock = { current: new Date('2026-11-01T00:00:01.000Z') };
      let billfn!: ReturnType<typeof createBillFn>;
      // The provider call returns at t3; a cancellation occurring at t4 is applied while the mutation
      // writes its own record, before it applies the returned state at t5.
      const committed = async () => {
        clock.current = new Date('2026-11-01T00:00:03.000Z');
        return {
          operationStatus: 'applied' as const,
          providerRefundId: 're_window',
          billingState: { subscriptionStatus: 'active' as const, checkoutStatus: 'succeeded' as const, providerSubscriptionId: 'sub_record', autoRenew: true }
        };
      };
      const base = createProvider({});
      const provider: BillFnProviderAdapter = {
        ...base,
        capabilities: { ...base.capabilities, changeSubscription: true, refundCharge: true },
        changeSubscription: committed,
        refundCharge: committed
      };
      const inner = memoryAdapter({ debug: false });
      const db = interceptDb(inner, {
        create: async (params, next) => {
          const created = await next();
          if (params.model === recordModel) {
            clock.current = new Date('2026-11-01T00:00:04.000Z');
            await deliver(billfn, [
              subscriptionEvent({ eventId: `evt_record_${operation}`, subscriptionId: 'sub_record', status: 'canceled', occurredAt: clock.current.toISOString() })
            ]);
            clock.current = new Date('2026-11-01T00:00:05.000Z');
          }
          return created;
        }
      });
      billfn = createBillFn({ db, catalog, now: () => clock.current, providers: { dodo: provider } });
      await billfn.quotaProvider.recordUsage({ principalId: 'record_user', bytes: 0 });
      await deliver(billfn, [
        subscriptionEvent({
          eventId: 'evt_record_bootstrap',
          subscriptionId: 'sub_record',
          chargeId: 'pay_record',
          status: 'active',
          occurredAt: '2026-10-30T00:00:00.000Z',
          billingAccountId: 'ba_user_record_user'
        })
      ]);
      const subject = { principalId: 'record_user' };

      const response =
        operation === 'changeSubscription'
          ? await billfn.changeSubscription({ subject, targetPriceId: 'price_pro_dodo_month' })
          : await billfn.refundCharge({ subject });

      expect(response.ok && response.data.subscription).toMatchObject({ status: 'canceled' });
      const [stored] = await inner.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
      expect(stored).toMatchObject({
        status: 'canceled',
        metadata: expect.objectContaining({ billfnProviderEventOccurredAt: '2026-11-01T00:00:04.000Z' })
      });
      const entitlements = await billfn.getEntitlements(subject);
      expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('inactive');
    }
  );

  it('reconciles with a provider read when an event inside a committed mutation window arrives after it', async () => {
    const providerCalls: string[] = [];
    const base = createProvider({});
    const provider: BillFnProviderAdapter = {
      ...base,
      capabilities: { ...base.capabilities, resumeSubscription: true, syncSubscription: true },
      async resumeSubscription() {
        providerCalls.push('resumeSubscription');
        env.clock.current = new Date('2026-11-01T00:00:03.000Z');
        return {
          operationStatus: 'applied',
          billingState: { subscriptionStatus: 'active', checkoutStatus: 'succeeded', providerSubscriptionId: 'sub_window', autoRenew: true }
        };
      },
      async fetchSubscription(input: { subscription: BillFnSubscription }) {
        providerCalls.push('fetchSubscription');
        return {
          subscriptionStatus: 'past_due' as const,
          checkoutStatus: 'succeeded' as const,
          providerSubscriptionId: input.subscription.providerSubscriptionId,
          autoRenew: true,
          raw: { synced: true }
        };
      }
    };
    const env = await bootstrapped('window_user', 'sub_window', provider);

    const resumed = await env.billfn.resumeSubscription({ subject: { principalId: 'window_user' } });
    expect(resumed.ok && resumed.data.subscription).toMatchObject({ status: 'active' });

    // An event older than the call start is ordinary out-of-order delivery: skipped, no provider read.
    env.clock.current = new Date('2026-11-01T00:00:04.000Z');
    await deliver(env.billfn, [
      subscriptionEvent({ eventId: 'evt_window_before', subscriptionId: 'sub_window', status: 'canceled', occurredAt: '2026-11-01T00:00:00.500Z' })
    ]);
    expect(await env.stored()).toMatchObject({ status: 'active' });
    expect(providerCalls).toEqual(['resumeSubscription']);

    // An event between the call start (t1) and its return (t3) cannot be ordered against the resume.
    env.clock.current = new Date('2026-11-01T00:00:05.000Z');
    const delivered = await deliver(env.billfn, [
      subscriptionEvent({ eventId: 'evt_window_inside', subscriptionId: 'sub_window', status: 'past_due', occurredAt: '2026-11-01T00:00:02.000Z' })
    ]);

    expect(delivered.ok).toBe(true);
    expect(providerCalls).toEqual(['resumeSubscription', 'fetchSubscription']);
    expect(await env.stored()).toMatchObject({ status: 'past_due' });
    const entitlements = await env.billfn.getEntitlements({ principalId: 'window_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.status).toBe('grace');

    // The read closed the window: another in-window event is skipped without a second read.
    await deliver(env.billfn, [
      subscriptionEvent({ eventId: 'evt_window_inside_again', subscriptionId: 'sub_window', status: 'canceled', occurredAt: '2026-11-01T00:00:02.500Z' })
    ]);
    expect(providerCalls).toEqual(['resumeSubscription', 'fetchSubscription']);
    expect(await env.stored()).toMatchObject({ status: 'past_due' });
  });

  it('replays events for a reference another replay run linked before it finished', async () => {
    let interfered = false;
    const inner = memoryAdapter({ debug: false });
    const db = interceptDb(inner, {
      updateMany: async (params, next) => {
        const data = params.data as { status?: string };
        const id = params.where.find((clause) => clause.field === 'id')?.value;
        if (!interfered && params.model === 'unlinkedWebhookEvents' && data.status === 'replaying' && String(id).includes('ZXZ0X2NvbmN1cl8x')) {
          // Another run applies the first row, linking pay_concur, and stops before replaying that charge.
          interfered = true;
          await finishRowElsewhere(inner, String(id), 'pay_concur');
        }
        return next();
      }
    });
    const { billfn, subscriptions, unlinked, advance } = setup({ db });
    await billfn.quotaProvider.recordUsage({ principalId: 'concur_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_concur_1', subscriptionId: 'sub_concur', chargeId: 'pay_concur', status: 'active', occurredAt: '2026-10-31T00:00:00.000Z' })
    ]);
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_concur_2', chargeId: 'pay_concur', status: 'canceled', occurredAt: '2026-10-31T12:00:00.000Z' })
    ]);
    advance(1000);

    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_concur_0',
        subscriptionId: 'sub_concur',
        status: 'active',
        occurredAt: '2026-10-30T00:00:00.000Z',
        billingAccountId: 'ba_user_concur_user'
      })
    ]);

    expect(interfered).toBe(true);
    expect((await unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_concur_1', 'replayed'],
      ['evt_concur_2', 'replayed']
    ]);
    expect(await subscriptions()).toEqual([expect.objectContaining({ status: 'canceled', providerChargeId: 'pay_concur' })]);
  });
});

describe('mutation window reads, bootstrap lifecycle and replaced references (PR #308 round 1 delta review 2)', () => {
  async function lifecycleEntries(db: Db, type: string) {
    return db.findMany<{ id: string }>({ model: 'billingEvents', where: [{ field: 'type', operator: 'eq', value: type }], namespace: 'billfn' });
  }

  it('records a bootstrap event once when it is redelivered after its replay was held', async () => {
    const { billfn, db, subscriptions, advance } = setup();
    await billfn.quotaProvider.recordUsage({ principalId: 'boot_once_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_boot_once_old', subscriptionId: 'sub_boot_once', status: 'past_due', occurredAt: '2026-10-29T00:00:00.000Z' })
    ]);
    await db.updateMany({
      model: 'unlinkedWebhookEvents',
      where: [{ field: 'providerEventId', operator: 'eq', value: 'evt_boot_once_old' }],
      data: { status: 'replaying', replayClaimId: 'uwr_other', replayClaimedAt: '2026-11-01T00:00:00.000Z' },
      namespace: 'billfn'
    });
    const bootstrap = subscriptionEvent({
      eventId: 'evt_boot_once',
      subscriptionId: 'sub_boot_once',
      status: 'active',
      occurredAt: '2026-10-30T00:00:00.000Z',
      billingAccountId: 'ba_user_boot_once_user'
    });
    await expect(deliver(billfn, [bootstrap])).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
    advance(REPLAY_LEASE_MS);

    const redelivered = await deliver(billfn, [bootstrap]);

    expect(redelivered.ok).toBe(true);
    expect(await subscriptions()).toEqual([expect.objectContaining({ status: 'active' })]);
    expect(await lifecycleEntries(db, 'billfn.subscription.active')).toHaveLength(1);
  });

  it('retains an event with billing account metadata whose charge a replayed event replaced', async () => {
    const env = setup();
    const { billfn, subscriptions, unlinked } = env;
    await bootstrapWhileRenewalHeld(env, 'meta_stale');

    await deliver(billfn, [
      subscriptionEvent({
        eventId: 'evt_meta_stale_canceled',
        chargeId: 'pay_meta_stale_1',
        status: 'canceled',
        occurredAt: '2026-10-31T00:00:00.000Z',
        billingAccountId: 'ba_user_meta_stale_user'
      })
    ]);

    expect(await subscriptions()).toEqual([
      expect.objectContaining({ providerSubscriptionId: 'sub_meta_stale', providerChargeId: 'pay_meta_stale_2', status: 'active' })
    ]);
    expect(await entitlementStatus(billfn, 'meta_stale_user')).toBe('active');
    expect(await unlinked()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerEventId: 'evt_meta_stale_canceled', status: 'unlinked', reason: 'provider_reference_replaced' })
      ])
    );
  });

  it('retains a delivered event whose charge another replay run replaced', async () => {
    const armed = { value: false };
    const inner = memoryAdapter({ debug: false });
    const db = interceptDb(inner, {
      updateMany: async (params, next) => {
        const id = params.where.find((clause) => clause.field === 'id')?.value;
        if (armed.value && params.model === 'unlinkedWebhookEvents' && (params.data as { status?: string }).status === 'replaying') {
          // Another run applies the renewal, moving the subscription to the second charge, first.
          armed.value = false;
          await finishRowElsewhere(inner, String(id), 'pay_other_2');
        }
        return next();
      }
    });
    const env = setup({ db });
    const { billfn, subscriptions, unlinked } = env;
    await bootstrapWhileRenewalHeld(env, 'other');
    armed.value = true;

    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_other_canceled', chargeId: 'pay_other_1', status: 'canceled', occurredAt: '2026-10-31T00:00:00.000Z' })
    ]);

    expect(armed.value).toBe(false);
    expect(await subscriptions()).toEqual([
      expect.objectContaining({ providerSubscriptionId: 'sub_other', providerChargeId: 'pay_other_2', status: 'active' })
    ]);
    expect(await unlinked()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerEventId: 'evt_other_canceled', status: 'unlinked', reason: 'provider_reference_replaced' })
      ])
    );
  });
});

describe('mutation windows, replaced references and regained references (PR #308 round 2)', () => {
  const COMMITTED_AT = '2026-11-01T00:00:03.000Z';
  type Read = (input: { subscription: BillFnSubscription; price: { priceId: string } }) => Promise<BillFnVerifiedBillingState | null>;

  /**
   * Bootstraps sub_<name> (with charge pay_<name> unless `chargeless`) and commits `operation` with a
   * provider call that starts at t1 and returns at t3, so its window is (t1, t3]; the clock then reads t4.
   * `read` is the provider's subscription read; without it the provider cannot be read.
   */
  async function committedMutation(
    name: string,
    options: { operation?: Mutation; read?: Read; db?: Db; metrics?: Array<[string, unknown]>; chargeless?: boolean } = {}
  ) {
    const db = options.db ?? memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-01T00:00:01.000Z') };
    const committed = async () => {
      clock.current = new Date(COMMITTED_AT);
      return {
        operationStatus: 'applied' as const,
        providerRefundId: `re_${name}`,
        billingState: { subscriptionStatus: 'active' as const, checkoutStatus: 'succeeded' as const, providerSubscriptionId: `sub_${name}`, autoRenew: true }
      };
    };
    const base = createProvider({});
    const provider: BillFnProviderAdapter = {
      ...base,
      capabilities: { ...base.capabilities, cancelSubscription: true, changeSubscription: true, resumeSubscription: true, refundCharge: true, syncSubscription: Boolean(options.read) },
      cancelSubscription: committed,
      changeSubscription: committed,
      resumeSubscription: committed,
      refundCharge: committed,
      ...(options.read ? { fetchSubscription: options.read } : {})
    };
    const metrics = { track: (event: string, properties?: unknown) => options.metrics?.push([event, properties]) };
    const billfn = createBillFn({ db, catalog, metrics, now: () => clock.current, providers: { dodo: provider } });
    await billfn.quotaProvider.recordUsage({ principalId: `${name}_user`, bytes: 0 });
    await deliver(billfn, [bootstrapEvent(name, { chargeId: options.chargeless ? undefined : `pay_${name}` })]);
    await runMutation(billfn, options.operation ?? 'resumeSubscription', { principalId: `${name}_user` });
    clock.current = new Date('2026-11-01T00:00:04.000Z');
    const stored = async () => (await db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' }))[0];
    const watermark = async () => (await stored())?.metadata?.billfnProviderEventOccurredAt;
    const processed = async (eventId: string) =>
      Boolean((await db.findOne<BillFnWebhookReceipt>({ model: 'webhookReceipts', where: [{ field: 'providerEventId', operator: 'eq', value: eventId }], namespace: 'billfn' }))?.processedAt);
    return { db, clock, billfn, stored, watermark, processed };
  }

  function at(name: string, label: string, status: SubscriptionStatus, second: string, extra: { chargeId?: string; productId?: string; withSubscription?: boolean } = {}) {
    return subscriptionEvent({
      eventId: `evt_${name}_${label}`,
      subscriptionId: extra.withSubscription === false ? undefined : `sub_${name}`,
      chargeId: extra.chargeId,
      productId: extra.productId,
      status,
      occurredAt: `2026-11-01T00:00:${second}Z`
    });
  }

  /** A provider read that fails while `failing.value` is set (throwing, or returning nothing), then returns `status`. */
  function recoveringRead(failing: { value: boolean }, mode: 'throws' | 'returns nothing', status: SubscriptionStatus): Read {
    return async (input) => {
      if (failing.value && mode === 'throws') {
        throw new Error('provider read unavailable');
      }
      if (failing.value) {
        return null;
      }
      return { subscriptionStatus: status, checkoutStatus: 'succeeded', providerSubscriptionId: input.subscription.providerSubscriptionId, autoRenew: false, raw: { live: true } };
    };
  }

  it.each(['throws', 'returns nothing'] as const)(
    'fails an event inside a committed mutation window retryably, never applying it, when the provider read %s',
    async (mode) => {
      const failing = { value: true };
      const env = await committedMutation(`window_${mode === 'throws' ? 'throw' : 'null'}`, { read: recoveringRead(failing, mode, 'canceled') });
      const name = mode === 'throws' ? 'window_throw' : 'window_null';

      await expect(deliver(env.billfn, [at(name, 'inside', 'canceled', '02.000')])).rejects.toBeTruthy();
      await expect(deliver(env.billfn, [at(name, 'inside_later', 'past_due', '02.500')])).rejects.toBeTruthy();

      expect(await env.stored()).toMatchObject({ status: 'active' });
      expect(await env.watermark()).toBe(COMMITTED_AT);
      expect(await env.processed(`evt_${name}_inside`)).toBe(false);
      expect(await entitlementStatus(env.billfn, `${name}_user`)).toBe('active');

      // The provider redelivers once the read recovers, and the subscription takes the live state.
      failing.value = false;
      const redelivered = await deliver(env.billfn, [at(name, 'inside', 'canceled', '02.000')]);
      expect(redelivered.ok).toBe(true);
      expect(await env.stored()).toMatchObject({ status: 'canceled' });
      expect(await env.watermark()).toBe('2026-11-01T00:00:04.000Z');
      expect(await entitlementStatus(env.billfn, `${name}_user`)).toBe('inactive');
    }
  );

  it('keeps the committed state over events inside its window when the provider cannot be read', async () => {
    const env = await committedMutation('unread');

    const delivered = await deliver(env.billfn, [at('unread', 'inside', 'canceled', '02.000'), at('unread', 'inside_later', 'past_due', '02.500')]);

    expect(delivered.ok && delivered.data.processed).toBe(2);
    expect(await env.stored()).toMatchObject({ status: 'active', metadata: expect.objectContaining({ billfnProviderMutationStartedAt: '2026-11-01T00:00:01.000Z' }) });
    expect(await env.watermark()).toBe(COMMITTED_AT);
    const canceledEntries = await env.db.findMany({ model: 'billingEvents', where: [{ field: 'type', operator: 'eq', value: 'billfn.subscription.canceled' }], namespace: 'billfn' });
    expect(canceledEntries).toHaveLength(0);
    expect(await entitlementStatus(env.billfn, 'unread_user')).toBe('active');
  });

  it.each(['cancelSubscription', 'changeSubscription', 'resumeSubscription', 'refundCharge'] as const)(
    'never moves the provider-state time backwards after %s commits',
    async (operation) => {
      const env = await committedMutation(`mono_${operation}`, { operation });
      const name = `mono_${operation}`;
      const seen: unknown[] = [await env.watermark()];
      for (const [label, second] of [['inside', '02.000'], ['before', '00.500'], ['inside_later', '02.500'], ['after', '06.000'], ['between', '05.000']] as const) {
        await deliver(env.billfn, [at(name, label, 'past_due', second)]);
        seen.push(await env.watermark());
      }
      expect(seen).toEqual([COMMITTED_AT, COMMITTED_AT, COMMITTED_AT, COMMITTED_AT, '2026-11-01T00:00:06.000Z', '2026-11-01T00:00:06.000Z']);
      expect(await env.stored()).toMatchObject({ status: 'past_due' });
    }
  );

  it('fails a replayed event inside a committed mutation window retryably until the provider read recovers', async () => {
    const failing = { value: true };
    const env = await committedMutation('replay_window', { read: recoveringRead(failing, 'throws', 'canceled'), chargeless: true });
    // A cancellation inside the window that names only a charge no subscription carries yet is retained.
    await deliver(env.billfn, [at('replay_window', 'inside', 'canceled', '02.000', { chargeId: 'pay_replay_window_next', withSubscription: false })]);
    // An event older than the mutation links that charge without changing state; its replay meets the window.
    const linking = at('replay_window', 'linking', 'active', '00.500', { chargeId: 'pay_replay_window_next' });

    await expect(deliver(env.billfn, [linking])).rejects.toThrow('provider read unavailable');

    expect(await env.stored()).toMatchObject({ status: 'active', providerChargeId: 'pay_replay_window_next' });
    expect(await env.watermark()).toBe(COMMITTED_AT);
    const [retained] = await env.db.findMany<BillFnUnlinkedWebhookEvent>({ model: 'unlinkedWebhookEvents', where: [], namespace: 'billfn' });
    expect(retained).toMatchObject({ providerEventId: 'evt_replay_window_inside', status: 'unlinked', error: 'provider read unavailable' });

    failing.value = false;
    expect((await deliver(env.billfn, [linking])).ok).toBe(true);
    expect(await env.stored()).toMatchObject({ status: 'canceled' });
    const [finished] = await env.db.findMany<BillFnUnlinkedWebhookEvent>({ model: 'unlinkedWebhookEvents', where: [], namespace: 'billfn' });
    expect(finished).toMatchObject({ status: 'skipped' });
  });

  it.each([
    ['names the new product', { product_id: 'pdt_team_month' }],
    ['names no product', {}]
  ] as const)('reconciles an in-window renewal to the catalog selection when the live record %s', async (_label, liveRaw) => {
    const reads: string[] = [];
    const read: Read = async (input) => {
      reads.push(input.price.priceId);
      return { subscriptionStatus: 'active', checkoutStatus: 'succeeded', providerSubscriptionId: input.subscription.providerSubscriptionId, autoRenew: true, raw: { ...liveRaw } };
    };
    const env = await committedMutation('catalog', { read });

    await deliver(env.billfn, [at('catalog', 'renewed', 'active', '02.000', { productId: 'pdt_team_month' })]);

    expect(reads).toEqual(['price_team_dodo_month']);
    expect(await env.stored()).toMatchObject({ planKey: 'team', priceId: 'price_team_dodo_month', status: 'active' });
    const entitlements = await env.billfn.getEntitlements({ principalId: 'catalog_user' });
    expect(entitlements.ok && entitlements.data.entitlements?.limits).toMatchObject({ storage: 5000 });
  });

  it('fails the delivery when applying the reconcile read fails after the subscription was written', async () => {
    const fault = { armed: false };
    const db = interceptDb(memoryAdapter({ debug: false }), {
      create: async (params, next) => {
        if (fault.armed && params.model === 'billingEvents' && (params.data as { type: string }).type.startsWith('billfn.subscription.')) {
          fault.armed = false;
          throw new Error('injected lifecycle write failure');
        }
        return next();
      }
    });
    const env = await committedMutation('post_commit', { db, read: recoveringRead({ value: false }, 'throws', 'past_due') });
    fault.armed = true;

    await expect(deliver(env.billfn, [at('post_commit', 'inside', 'canceled', '02.000')])).rejects.toThrow('injected lifecycle write failure');

    expect(fault.armed).toBe(false);
    expect(await env.processed('evt_post_commit_inside')).toBe(false);
    expect(await env.stored()).toMatchObject({ status: 'past_due' });
  });

  it('never bootstraps another subscription from a redelivered event retained because its reference was replaced', async () => {
    const env = setup();
    await bootstrapWhileRenewalHeld(env, 'replaced');
    const canceled = subscriptionEvent({
      eventId: 'evt_replaced_canceled',
      chargeId: 'pay_replaced_1',
      status: 'canceled',
      occurredAt: '2026-10-31T00:00:00.000Z',
      billingAccountId: 'ba_user_replaced_user'
    });
    await deliver(env.billfn, [canceled]);
    expect(await env.unlinked()).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerEventId: 'evt_replaced_canceled', reason: 'provider_reference_replaced' })])
    );

    env.advance(1000);
    expect((await deliver(env.billfn, [canceled])).ok).toBe(true);
    const replay = await env.billfn.enqueueReconciliationJob({ kind: 'webhook-replay', provider: 'dodo', providerEventId: 'evt_replaced_canceled' });
    const run = replay.ok ? await env.billfn.runReconciliationJob({ jobId: replay.data.job.id }) : null;
    expect(run?.ok && run.data.job.status).toBe('succeeded');

    expect(await env.subscriptions()).toEqual([
      expect.objectContaining({ providerSubscriptionId: 'sub_replaced', providerChargeId: 'pay_replaced_2', status: 'active' })
    ]);
    expect(await entitlementStatus(env.billfn, 'replaced_user')).toBe('active');
    expect(await env.unlinked()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerEventId: 'evt_replaced_canceled', status: 'unlinked', reason: 'provider_reference_replaced' })
      ])
    );
  });

  it('replays an event stored for a charge while the subscription had replaced it, once a later replayed event regains it', async () => {
    const delivered = { value: false };
    let billfn!: ReturnType<typeof createBillFn>;
    const inner = memoryAdapter({ debug: false });
    const db = interceptDb(inner, {
      updateMany: async (params, next) => {
        const id = String(params.where.find((clause) => clause.field === 'id')?.value);
        if (!delivered.value && params.model === 'unlinkedWebhookEvents' && (params.data as { status?: string }).status === 'replaying' && id.includes(Buffer.from('evt_regain_back').toString('base64url'))) {
          // While the subscription holds pay_regain_2, a cancellation for pay_regain_1 arrives and is retained.
          delivered.value = true;
          await deliver(billfn, [subscriptionEvent({ eventId: 'evt_regain_late', chargeId: 'pay_regain_1', status: 'canceled', occurredAt: '2026-10-31T18:00:00.000Z' })]);
        }
        return next();
      }
    });
    const env = setup({ db });
    billfn = env.billfn;
    await billfn.quotaProvider.recordUsage({ principalId: 'regain_user', bytes: 0 });
    await deliver(billfn, [
      subscriptionEvent({ eventId: 'evt_regain_first', subscriptionId: 'sub_regain', chargeId: 'pay_regain_1', status: 'active', occurredAt: '2026-10-31T00:00:00.000Z' }),
      subscriptionEvent({ eventId: 'evt_regain_moved', subscriptionId: 'sub_regain', chargeId: 'pay_regain_2', status: 'active', occurredAt: '2026-10-31T06:00:00.000Z' }),
      subscriptionEvent({ eventId: 'evt_regain_back', subscriptionId: 'sub_regain', chargeId: 'pay_regain_1', status: 'active', occurredAt: '2026-10-31T12:00:00.000Z' })
    ]);
    env.advance(1000);

    await deliver(billfn, [bootstrapEvent('regain')]);

    expect(delivered.value).toBe(true);
    expect(await env.subscriptions()).toEqual([expect.objectContaining({ providerChargeId: 'pay_regain_1', status: 'canceled' })]);
    expect((await env.unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_regain_back', 'replayed'],
      ['evt_regain_first', 'replayed'],
      ['evt_regain_late', 'replayed'],
      ['evt_regain_moved', 'replayed']
    ]);
  });

  it('finishes an event left unlinked when a later replayed event regains its charge', async () => {
    const env = setup();
    await env.billfn.quotaProvider.recordUsage({ principalId: 'revisit_user', bytes: 0 });
    await deliver(env.billfn, [
      subscriptionEvent({ eventId: 'evt_revisit_a', subscriptionId: 'sub_revisit', chargeId: 'pay_revisit_1', status: 'active', occurredAt: '2026-10-31T00:00:00.000Z' }),
      subscriptionEvent({ eventId: 'evt_revisit_b', subscriptionId: 'sub_revisit', chargeId: 'pay_revisit_2', status: 'active', occurredAt: '2026-10-31T06:00:00.000Z' }),
      subscriptionEvent({ eventId: 'evt_revisit_c', chargeId: 'pay_revisit_1', status: 'past_due', occurredAt: '2026-10-31T09:00:00.000Z' }),
      subscriptionEvent({ eventId: 'evt_revisit_d', subscriptionId: 'sub_revisit', chargeId: 'pay_revisit_1', status: 'canceled', occurredAt: '2026-10-31T12:00:00.000Z' })
    ]);
    env.advance(1000);

    await deliver(env.billfn, [bootstrapEvent('revisit')]);

    // evt_revisit_c was visited while pay_revisit_1 was replaced and left unlinked; regaining the charge finishes it.
    expect((await env.unlinked()).map((row) => [row.providerEventId, row.status])).toEqual([
      ['evt_revisit_a', 'replayed'],
      ['evt_revisit_b', 'replayed'],
      ['evt_revisit_c', 'skipped'],
      ['evt_revisit_d', 'replayed']
    ]);
    expect(await env.subscriptions()).toEqual([expect.objectContaining({ providerChargeId: 'pay_revisit_1', status: 'canceled' })]);
  });

  it('reports a replay that reaches its bound as bounded, not held, and finishes it on a later run', async () => {
    const tracked: Array<[string, unknown]> = [];
    const env = await committedMutation('bound', { metrics: tracked, chargeless: true });
    const events = Array.from({ length: 1001 }, (_, index) =>
      subscriptionEvent({
        eventId: `evt_bound_${String(index).padStart(4, '0')}`,
        chargeId: 'pay_bound_next',
        status: 'active',
        occurredAt: new Date(Date.parse('2026-11-01T00:00:10.000Z') + index * 1000).toISOString()
      })
    );
    await deliver(env.billfn, events);
    const linking = at('bound', 'linking', 'active', '00.500', { chargeId: 'pay_bound_next' });

    await expect(deliver(env.billfn, [linking])).rejects.toThrow('reached its bound');
    await env.billfn.resumeSubscription({ subject: { principalId: 'bound_user' } });

    expect(tracked).toContainEqual(['billfn.webhook.unlinked.replay_deferred', expect.objectContaining({ reason: 'bounded' })]);
    expect((await deliver(env.billfn, [linking])).ok).toBe(true);
    const left = await env.db.findMany({ model: 'unlinkedWebhookEvents', where: [{ field: 'status', operator: 'eq', value: 'unlinked' }], namespace: 'billfn' });
    expect(left).toHaveLength(0);
  }, 60_000);
});
