import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import {
  BILLFN_IMPORTED_AT_METADATA_KEY,
  BILLFN_IMPORT_PENDING_METADATA_KEY,
  BILLFN_IMPORT_REPLAY_UNFINISHED_REASON,
  createBillFn
} from '../index.js';
import type {
  BillFnBillingEvent,
  BillFnCatalog,
  BillFnImportSubscriptionInput,
  BillFnImportSubscriptionRequest,
  BillFnParsedWebhookEvent,
  BillFnProviderAdapter,
  BillFnSubscription,
  BillFnUnlinkedWebhookEvent,
  BillFnVerifiedBillingState,
  SubscriptionStatus
} from '../types.js';

const catalog: BillFnCatalog = {
  plans: [
    {
      productKey: 'nucleus',
      planKey: 'nucleus',
      displayName: 'Nucleus',
      features: { memotron: true, pointron: true },
      limits: { storage: 1000 },
      prices: [
        {
          priceId: 'price_nucleus_dodo_month',
          provider: 'dodo',
          providerProductId: 'pdt_nucleus_month',
          currency: 'USD',
          amount: 12,
          kind: 'subscription',
          interval: 'month'
        },
        {
          priceId: 'price_nucleus_dodo_year',
          provider: 'dodo',
          providerProductId: 'pdt_nucleus_year',
          currency: 'USD',
          amount: 120,
          kind: 'subscription',
          interval: 'year'
        }
      ]
    },
    {
      productKey: 'nucleus',
      planKey: 'team',
      displayName: 'Team',
      features: { memotron: true },
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

const OPERATOR = { id: 'operator_1', type: 'user', requestId: 'request_1' };
const REPLAY_LEASE_MS = 15 * 60 * 1000;

/**
 * A legacy Dodo subscription created outside BillFn: its record carries no
 * billfn_* metadata. The adapter returns what Dodo's GET /subscriptions/:id does.
 */
function legacyRecord(subscriptionId: string, overrides: Partial<{ productId: string; status: string }> = {}) {
  return {
    subscription_id: subscriptionId,
    product_id: overrides.productId ?? 'pdt_nucleus_year',
    status: overrides.status ?? 'active',
    next_billing_date: '2027-01-01T00:00:00.000Z',
    metadata: { legacy_user_id: 'u_123' }
  };
}

type ProviderOptions = {
  record?: (reference: string) => Record<string, unknown> | null;
  /** Runs inside the provider read, before it returns. */
  duringRead?: (input: BillFnImportSubscriptionInput) => Promise<void>;
};

function createProvider(options: ProviderOptions = {}) {
  const importSubscription = vi.fn(async (input: BillFnImportSubscriptionInput): Promise<BillFnVerifiedBillingState | null> => {
    await options.duringRead?.(input);
    const record = (options.record ?? legacyRecord)(input.providerReference);
    if (!record) {
      return null;
    }
    const status = record.status as SubscriptionStatus;
    return {
      subscriptionStatus: status,
      checkoutStatus: 'succeeded',
      providerSubscriptionId: record.subscription_id as string,
      currentPeriodEnd: record.next_billing_date as string,
      autoRenew: status === 'active',
      raw: record
    };
  });
  const adapter: BillFnProviderAdapter = {
    provider: 'dodo',
    capabilities: {
      createCheckout: false,
      verifyCheckout: false,
      cancelSubscription: false,
      syncSubscription: false,
      restorePurchases: false,
      webhookIngestion: true,
      importSubscription: true
    },
    importSubscription,
    async parseWebhook(input) {
      return JSON.parse(input.rawBody) as BillFnParsedWebhookEvent[];
    }
  };
  return { adapter, importSubscription };
}

/** A verified Dodo event for a subscription BillFn has not seen, without billfn_* metadata. */
function legacyEvent(eventId: string, subscriptionId: string, status: SubscriptionStatus, occurredAt: string): BillFnParsedWebhookEvent {
  const data = { subscription_id: subscriptionId, product_id: 'pdt_nucleus_year', status };
  return {
    providerEventId: eventId,
    type: `subscription.${status}`,
    signatureVerified: true,
    occurredAt,
    priceId: 'pdt_nucleus_year',
    providerSubscriptionId: subscriptionId,
    billingState: {
      subscriptionStatus: status,
      checkoutStatus: 'succeeded',
      providerSubscriptionId: subscriptionId,
      autoRenew: status === 'active',
      raw: data
    },
    raw: { type: `subscription.${status}`, data }
  };
}

type Db = ReturnType<typeof memoryAdapter>;

/** Enforces the unique (provider, providerSubscriptionId) index the memory adapter does not. */
function withSubscriptionReferenceUniqueness(db: Db): Db {
  let lock: Promise<unknown> = Promise.resolve();
  return {
    ...db,
    async create<T>(params: Parameters<Db['create']>[0]): Promise<T> {
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
          throw new Error('duplicate key value violates unique constraint "subscriptions_provider_subscription_idx"');
        }
        return db.create<T>(params);
      });
      lock = run.catch(() => undefined);
      return run;
    }
  } as Db;
}

function setup(options: ProviderOptions & { wrapDb?: (db: Db) => Db } = {}) {
  const base = memoryAdapter({ debug: false });
  const unique = withSubscriptionReferenceUniqueness(base);
  const db = options.wrapDb ? options.wrapDb(unique) : unique;
  const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
  const provider = createProvider(options);
  const billfn = createBillFn({
    db,
    catalog,
    providers: { dodo: provider.adapter },
    now: () => clock.current
  });
  return {
    db,
    billfn,
    clock,
    importSubscription: provider.importSubscription,
    async account(principalId: string) {
      // Recording usage is the existing way a subject's billing account is created.
      await billfn.quotaProvider.recordUsage({ principalId, bytes: 0 });
      return `ba_user_${principalId}`;
    },
    import(input: Partial<BillFnImportSubscriptionRequest> & { billingAccountId: string }) {
      return billfn.services.subscriptions.import({
        provider: 'dodo',
        providerSubscriptionId: 'sub_legacy',
        planKey: 'nucleus',
        operator: OPERATOR,
        ...input
      });
    },
    deliver(events: BillFnParsedWebhookEvent[]) {
      return billfn.handleWebhook({ provider: 'dodo', rawBody: JSON.stringify(events), headers: new Headers() });
    },
    subscriptions() {
      return db.findMany<BillFnSubscription>({ model: 'subscriptions', where: [], namespace: 'billfn' });
    },
    importEvents() {
      return db.findMany<BillFnBillingEvent>({
        model: 'billingEvents',
        where: [{ field: 'type', operator: 'eq', value: 'billfn.subscription.imported' }],
        namespace: 'billfn'
      });
    },
    unlinked() {
      return db.findMany<BillFnUnlinkedWebhookEvent>({
        model: 'unlinkedWebhookEvents',
        where: [],
        orderBy: [{ field: 'providerEventId', direction: 'asc' }],
        namespace: 'billfn'
      });
    }
  };
}

/**
 * A subscription write that replaces `sub_legacy` on its row with
 * `sub_replacement`, as a plan change does: it records the dropped reference
 * before the write, or (a committed provider mutation that could not record it)
 * saves it pending in that same write.
 */
async function replaceLegacyReference(db: Db, subscriptionId: string, mode: 'recorded' | 'pending') {
  const row = await db.findOne<BillFnSubscription>({
    model: 'subscriptions',
    where: [{ field: 'id', operator: 'eq', value: subscriptionId }],
    namespace: 'billfn'
  });
  if (!row) {
    throw new Error(`no subscription ${subscriptionId}`);
  }
  const at = new Date(Date.parse(row.updatedAt) + 1000).toISOString();
  if (mode === 'recorded') {
    await db.create({
      model: 'replacedProviderReferences',
      data: {
        id: 'rpr_dodo_legacy',
        provider: 'dodo',
        providerReference: 'sub_legacy',
        subscriptionId: row.id,
        billingAccountId: row.billingAccountId,
        replacedAt: at,
        createdAt: at,
        updatedAt: at
      },
      namespace: 'billfn'
    });
  }
  await db.updateMany({
    model: 'subscriptions',
    where: [{ field: 'id', operator: 'eq', value: row.id }],
    data: {
      providerSubscriptionId: 'sub_replacement',
      updatedAt: at,
      ...(mode === 'pending'
        ? { replacedReferencesPending: true, metadata: { ...row.metadata, billfnPendingReplacedReferences: ['sub_legacy'] } }
        : {})
    },
    namespace: 'billfn'
  });
}

/** Fails the first armed subscriptions delete, as a process stopped between an import's create and its cleanup would. */
function interruptFirstSubscriptionDelete(control: { armed: boolean }) {
  return (db: Db): Db =>
    ({
      ...db,
      async deleteMany(params: Parameters<Db['deleteMany']>[0]) {
        if (control.armed && params.model === 'subscriptions') {
          control.armed = false;
          throw new Error('process interrupted');
        }
        return db.deleteMany(params);
      }
    }) as Db;
}

function entitlementsOf(db: Db, billingAccountId: string) {
  return db.findMany({
    model: 'entitlementSnapshots',
    where: [{ field: 'billingAccountId', operator: 'eq', value: billingAccountId }],
    namespace: 'billfn'
  });
}

function billingEventsOf(db: Db, billingAccountId: string) {
  return db.findMany<BillFnBillingEvent>({
    model: 'billingEvents',
    where: [{ field: 'billingAccountId', operator: 'eq', value: billingAccountId }],
    namespace: 'billfn'
  });
}

/**
 * Holds the subscriptions updates whose 1-based call numbers are in `holds`
 * until released: `reached(n)` resolves once call n is held, `release(n)` lets
 * it run (with the where clause it was issued with, so a stale ordered write
 * then loses). Other updates run at once.
 */
function holdSubscriptionUpdates(holds: number[]) {
  let calls = 0;
  const gates = new Map(
    holds.map((call) => {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const releasePromise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return [call, { reached, release, reachedPromise, releasePromise }] as const;
    })
  );
  const control = {
    armed: false,
    reached: (call: number) => gates.get(call)!.reachedPromise,
    release: (call: number) => gates.get(call)!.release(),
    wrap: (db: Db): Db =>
      ({
        ...db,
        async updateMany(params: Parameters<Db['updateMany']>[0]) {
          if (control.armed && params.model === 'subscriptions') {
            calls += 1;
            const gate = gates.get(calls);
            if (gate) {
              gate.reached();
              await gate.releasePromise;
            }
          }
          return db.updateMany(params);
        }
      }) as Db
  };
  return control;
}

function lifecycleEventsOf(db: Db, billingAccountId: string) {
  return billingEventsOf(db, billingAccountId).then((events) =>
    events.filter((event) => event.type.startsWith('billfn.subscription.') && event.type !== 'billfn.subscription.imported')
  );
}

function unwrap<T>(response: { ok: true; data: T } | { ok: false }): T {
  if (!response.ok) {
    throw new Error('expected an ok envelope');
  }
  return response.data;
}

describe('billfn.services.subscriptions.import', () => {
  it('binds a legacy provider subscription without BillFn metadata, syncs it and records the operator', async () => {
    const env = setup();
    const billingAccountId = await env.account('alice');

    const data = unwrap(await env.import({ billingAccountId, reason: 'TIDY-558 cutover' }));

    expect(env.importSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ providerReference: 'sub_legacy', billingAccount: expect.objectContaining({ id: billingAccountId }) })
    );
    // The product the provider record names selects the plan's price; the state is the provider's.
    expect(data.subscription).toMatchObject({
      billingAccountId,
      planKey: 'nucleus',
      priceId: 'price_nucleus_dodo_year',
      provider: 'dodo',
      providerSubscriptionId: 'sub_legacy',
      status: 'active',
      currentPeriodEnd: '2027-01-01T00:00:00.000Z',
      metadata: expect.objectContaining({ [BILLFN_IMPORTED_AT_METADATA_KEY]: '2026-11-10T00:00:00.000Z' })
    });
    expect(data.entitlements).toMatchObject({ billingAccountId, planKey: 'nucleus', status: 'active', features: { memotron: true, pointron: true } });
    // Accepted: the pending marker the row was created with is cleared before entitlements are written.
    expect((await env.subscriptions())[0]?.metadata).not.toHaveProperty(BILLFN_IMPORT_PENDING_METADATA_KEY);
    expect(await env.billfn.subscriptionProvider.hasFeature({ principalId: 'alice' }, 'pointron')).toBe(true);
    expect(await env.importEvents()).toEqual([
      expect.objectContaining({
        id: data.billingEvent.id,
        billingAccountId,
        payload: {
          subscriptionId: data.subscription.id,
          provider: 'dodo',
          providerReference: 'sub_legacy',
          planKey: 'nucleus',
          priceId: 'price_nucleus_dodo_year',
          status: 'active',
          operator: OPERATOR,
          reason: 'TIDY-558 cutover'
        }
      })
    ]);
  });

  it('replays the unlinked events stored for the reference: newer ones are applied, older ones skipped', async () => {
    const env = setup();
    const billingAccountId = await env.account('alice');
    // Delivered before the import: no metadata, so BillFn stored them unlinked.
    await env.deliver([
      legacyEvent('evt_old_renewal', 'sub_legacy', 'active', '2026-11-01T00:00:00.000Z'),
      legacyEvent('evt_new_cancel', 'sub_legacy', 'canceled', '2026-11-10T00:00:05.000Z')
    ]);
    expect((await env.unlinked()).map((row) => [row.providerEventId, row.status, row.reason])).toEqual([
      ['evt_new_cancel', 'unlinked', 'billing_account_metadata_missing'],
      ['evt_old_renewal', 'unlinked', 'billing_account_metadata_missing']
    ]);

    const data = unwrap(await env.import({ billingAccountId }));

    // The cancellation occurred after the import's provider read started, so it is applied over the read.
    expect(data.subscription).toMatchObject({ providerSubscriptionId: 'sub_legacy', status: 'canceled' });
    expect(data.entitlements.status).toBe('inactive');
    expect((await env.unlinked()).map((row) => [row.providerEventId, row.status, row.subscriptionId])).toEqual([
      ['evt_new_cancel', 'replayed', data.subscription.id],
      ['evt_old_renewal', 'skipped', data.subscription.id]
    ]);
    // Later events for the reference apply to the imported subscription.
    env.clock.current = new Date('2026-11-11T00:00:00.000Z');
    await env.deliver([legacyEvent('evt_reactivated', 'sub_legacy', 'active', '2026-11-11T00:00:00.000Z')]);
    expect(await env.subscriptions()).toEqual([expect.objectContaining({ id: data.subscription.id, status: 'active' })]);
  });

  it('is idempotent per provider reference and records every import', async () => {
    const env = setup();
    const billingAccountId = await env.account('alice');
    const first = unwrap(await env.import({ billingAccountId }));
    env.clock.current = new Date('2026-11-12T00:00:00.000Z');

    const second = unwrap(await env.import({ billingAccountId, operator: { id: 'operator_2' } }));

    expect(second.subscription.id).toBe(first.subscription.id);
    expect(await env.subscriptions()).toHaveLength(1);
    // The first import time is kept; each run syncs from the provider and records its operator.
    expect(second.subscription.metadata?.[BILLFN_IMPORTED_AT_METADATA_KEY]).toBe('2026-11-10T00:00:00.000Z');
    expect(env.importSubscription).toHaveBeenCalledTimes(2);
    expect((await env.importEvents()).map((event) => (event.payload.operator as { id: string }).id).sort()).toEqual([
      'operator_1',
      'operator_2'
    ]);
  });

  it('completes on a rerun after an import interrupted before its replay finished', async () => {
    const env = setup();
    const billingAccountId = await env.account('alice');
    // Occurs after both imports' provider reads start, so the rerun applies it over its read.
    await env.deliver([legacyEvent('evt_cancel', 'sub_legacy', 'canceled', '2026-11-10T00:30:00.000Z')]);
    // An interrupted replay run still holds the retained event.
    await env.db.updateMany({
      model: 'unlinkedWebhookEvents',
      where: [{ field: 'providerEventId', operator: 'eq', value: 'evt_cancel' }],
      data: { status: 'replaying', replayClaimId: 'uwr_interrupted', replayClaimedAt: env.clock.current.toISOString() },
      namespace: 'billfn'
    });

    // Unlike a reference bound elsewhere, the operator can retry it.
    await expect(env.import({ billingAccountId })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      retryable: true,
      details: { reason: BILLFN_IMPORT_REPLAY_UNFINISHED_REASON }
    });
    // The binding and its audit record committed before the replay stopped.
    expect(await env.subscriptions()).toEqual([expect.objectContaining({ billingAccountId, status: 'active' })]);
    expect(await env.importEvents()).toHaveLength(1);

    env.clock.current = new Date(env.clock.current.getTime() + REPLAY_LEASE_MS + 1000);
    const rerun = unwrap(await env.import({ billingAccountId }));

    expect(rerun.subscription).toMatchObject({ status: 'canceled' });
    expect(await env.subscriptions()).toHaveLength(1);
    expect(await env.unlinked()).toEqual([expect.objectContaining({ providerEventId: 'evt_cancel', status: 'replayed' })]);
    expect(await env.importEvents()).toHaveLength(2);
  });

  it('ends two racing imports of one reference into one billing account with one subscription', async () => {
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = setup({
      async duringRead() {
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await bothRead;
      }
    });
    const billingAccountId = await env.account('alice');

    const [left, right] = await Promise.all([env.import({ billingAccountId }), env.import({ billingAccountId })]);

    expect(unwrap(left).subscription.id).toBe(unwrap(right).subscription.id);
    expect(await env.subscriptions()).toHaveLength(1);
    expect(await env.importEvents()).toHaveLength(2);
  });

  it('publishes the plan of the state that wins when another import writes and accepts the row before its acceptance', async () => {
    const holds = holdSubscriptionUpdates([1]);
    let productId = 'pdt_nucleus_year';
    const env = setup({ wrapDb: holds.wrap, record: (reference) => legacyRecord(reference, { productId }) });
    const billingAccountId = await env.account('alice');
    holds.armed = true;

    // A creates its pending row with the nucleus state and is held at its acceptance write.
    const first = env.import({ billingAccountId, planKey: 'nucleus' });
    await holds.reached(1);
    // B reads the product moved to team, writes that state onto the row and accepts it.
    productId = 'pdt_team_month';
    env.clock.current = new Date('2026-11-10T00:00:01.000Z');
    const second = unwrap(await env.import({ billingAccountId, planKey: 'team' }));
    holds.release(1);
    const firstResult = unwrap(await first);

    const [subscription] = await env.subscriptions();
    expect(await env.subscriptions()).toHaveLength(1);
    expect(subscription).toMatchObject({ planKey: 'team', priceId: 'price_team_dodo_month' });
    expect(subscription.metadata?.[BILLFN_IMPORT_PENDING_METADATA_KEY]).toBeUndefined();
    const team = { planKey: 'team', features: { memotron: true }, limits: { storage: 5000 } };
    expect(await entitlementsOf(env.db, billingAccountId)).toEqual([expect.objectContaining(team)]);
    for (const result of [firstResult, second]) {
      expect(result.subscription).toMatchObject({ id: subscription.id, planKey: 'team' });
      expect(result.entitlements).toMatchObject(team);
      expect(result.billingEvent.payload).toMatchObject({ planKey: 'team' });
    }
    // Only the import whose state the row accepted records its lifecycle event.
    expect(await lifecycleEventsOf(env.db, billingAccountId)).toEqual([
      expect.objectContaining({ type: 'billfn.subscription.active', payload: expect.objectContaining({ priceId: 'price_team_dodo_month' }) })
    ]);
    expect(await env.importEvents()).toHaveLength(2);
  });

  it('publishes the plan of the state that wins when it accepts another import\'s state written before its acceptance', async () => {
    // Update 1: A's acceptance write (held). 2: B's state write. 3: B's acceptance write (held). 4: A accepts B's state.
    const holds = holdSubscriptionUpdates([1, 3]);
    let productId = 'pdt_nucleus_year';
    const env = setup({ wrapDb: holds.wrap, record: (reference) => legacyRecord(reference, { productId }) });
    const billingAccountId = await env.account('alice');
    holds.armed = true;

    const first = env.import({ billingAccountId, planKey: 'nucleus' });
    await holds.reached(1);
    productId = 'pdt_team_month';
    env.clock.current = new Date('2026-11-10T00:00:01.000Z');
    const second = env.import({ billingAccountId, planKey: 'team' });
    await holds.reached(3);
    // A's acceptance write loses to B's state write, so A re-finds the row pending with B's state and accepts it.
    env.clock.current = new Date('2026-11-10T00:00:02.000Z');
    holds.release(1);
    const firstResult = unwrap(await first);
    // B's acceptance write then loses to A's, and B returns the row A accepted.
    holds.release(3);
    const secondResult = unwrap(await second);

    const [subscription] = await env.subscriptions();
    expect(await env.subscriptions()).toHaveLength(1);
    expect(subscription).toMatchObject({ planKey: 'team', priceId: 'price_team_dodo_month' });
    expect(subscription.metadata?.[BILLFN_IMPORT_PENDING_METADATA_KEY]).toBeUndefined();
    const team = { planKey: 'team', features: { memotron: true }, limits: { storage: 5000 } };
    expect(await entitlementsOf(env.db, billingAccountId)).toEqual([expect.objectContaining(team)]);
    for (const result of [firstResult, secondResult]) {
      expect(result.subscription).toMatchObject({ id: subscription.id, planKey: 'team' });
      expect(result.entitlements).toMatchObject(team);
      expect(result.billingEvent.payload).toMatchObject({ planKey: 'team' });
    }
    // The import that accepted the row records its lifecycle event once.
    expect(await lifecycleEventsOf(env.db, billingAccountId)).toEqual([
      expect.objectContaining({ type: 'billfn.subscription.active', payload: expect.objectContaining({ priceId: 'price_team_dodo_month' }) })
    ]);
    expect(await env.billfn.subscriptionProvider.isActive({ principalId: 'alice' })).toBe(true);
  });

  it('lets only one of two imports racing one reference into different billing accounts bind it', async () => {
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = setup({
      async duringRead() {
        arrived += 1;
        if (arrived === 2) {
          release();
        }
        await bothRead;
      }
    });
    const alice = await env.account('alice');
    const bob = await env.account('bob');

    const results = await Promise.allSettled([env.import({ billingAccountId: alice }), env.import({ billingAccountId: bob })]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: 'BILLFN_CONFLICT',
      message: expect.stringContaining('already bound to a different billing account')
    });
    const [subscription] = await env.subscriptions();
    expect(await env.subscriptions()).toHaveLength(1);
    expect(await env.importEvents()).toEqual([expect.objectContaining({ billingAccountId: subscription.billingAccountId })]);
    // The loser's billing account gets no entitlements from the reference.
    expect(await env.db.findMany({ model: 'entitlementSnapshots', where: [], namespace: 'billfn' })).toEqual([
      expect.objectContaining({ billingAccountId: subscription.billingAccountId })
    ]);
    expect(rejected[0].reason).toMatchObject({ retryable: false });
  });

  it('refuses a reference bound to another billing account without reading the provider or writing', async () => {
    const env = setup();
    const alice = await env.account('alice');
    const bob = await env.account('bob');
    const bound = unwrap(await env.import({ billingAccountId: alice }));
    env.importSubscription.mockClear();

    await expect(env.import({ billingAccountId: bob })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      retryable: false,
      message: expect.stringContaining('already bound to a different billing account')
    });

    expect(env.importSubscription).not.toHaveBeenCalled();
    expect(await env.subscriptions()).toEqual([expect.objectContaining({ id: bound.subscription.id, billingAccountId: alice })]);
    expect(await env.importEvents()).toEqual([expect.objectContaining({ billingAccountId: alice })]);
    expect(await env.billfn.subscriptionProvider.isActive({ principalId: 'bob' })).toBe(false);
  });

  it('refuses a reference a subscription write replaced', async () => {
    const env = setup();
    const billingAccountId = await env.account('alice');
    await env.db.create({
      model: 'replacedProviderReferences',
      data: {
        id: 'rpr_1',
        provider: 'dodo',
        providerReference: 'sub_legacy',
        subscriptionId: 'sub_other',
        billingAccountId: 'ba_user_other',
        replacedAt: '2026-11-01T00:00:00.000Z',
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z'
      },
      namespace: 'billfn'
    });

    await expect(env.import({ billingAccountId })).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
    expect(env.importSubscription).not.toHaveBeenCalled();
    expect(await env.subscriptions()).toEqual([]);
  });

  it('refuses a reference whose replacement a writer records and clears from pending between its reads', async () => {
    let armed = false;
    const replacedRead = (params: { model: string; where?: Array<{ field: string }> }) =>
      params.model === 'replacedProviderReferences' || Boolean(params.where?.some((clause) => clause.field === 'replacedReferencesPending'));
    // After the import's first replaced-reference read returns, the writer that dropped `sub_legacy` records it and clears pending.
    const writerFinishes = async (db: Db, params: { model: string; where?: Array<{ field: string }> }) => {
      if (!armed || !replacedRead(params)) {
        return;
      }
      armed = false;
      await db.create({
        model: 'replacedProviderReferences',
        data: {
          id: 'rpr_1',
          provider: 'dodo',
          providerReference: 'sub_legacy',
          subscriptionId: 'sub_row_other',
          billingAccountId: 'ba_user_other',
          replacedAt: '2026-11-09T00:00:00.000Z',
          createdAt: '2026-11-09T00:00:00.000Z',
          updatedAt: '2026-11-09T00:00:00.000Z'
        },
        namespace: 'billfn'
      });
      await db.updateMany({
        model: 'subscriptions',
        where: [{ field: 'id', operator: 'eq', value: 'sub_row_other' }],
        data: { replacedReferencesPending: null, metadata: {} },
        namespace: 'billfn'
      });
    };
    const env = setup({
      wrapDb: (db) =>
        ({
          ...db,
          async findOne<T>(params: Parameters<Db['findOne']>[0]) {
            const result = await db.findOne<T>(params);
            await writerFinishes(db, params);
            return result;
          },
          async findMany<T>(params: Parameters<Db['findMany']>[0]) {
            const result = await db.findMany<T>(params);
            await writerFinishes(db, params);
            return result;
          }
        }) as Db
    });
    const billingAccountId = await env.account('alice');
    // Another account's subscription dropped `sub_legacy` and has not recorded it yet.
    await env.db.create({
      model: 'subscriptions',
      data: {
        id: 'sub_row_other',
        billingAccountId: 'ba_user_other',
        planKey: 'nucleus',
        priceId: 'price_nucleus_dodo_year',
        provider: 'dodo',
        providerSubscriptionId: 'sub_new',
        status: 'active',
        replacedReferencesPending: true,
        metadata: { billfnPendingReplacedReferences: ['sub_legacy'] },
        createdAt: '2026-11-09T00:00:00.000Z',
        updatedAt: '2026-11-09T00:00:00.000Z'
      },
      namespace: 'billfn'
    });
    armed = true;

    await expect(env.import({ billingAccountId })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      message: expect.stringContaining('replaced')
    });

    expect(armed).toBe(false);
    expect(env.importSubscription).not.toHaveBeenCalled();
    expect(await env.subscriptions()).toEqual([expect.objectContaining({ id: 'sub_row_other' })]);
    expect(await env.importEvents()).toEqual([]);
  });

  it.each(['recorded', 'pending'] as const)(
    'refuses a rerun whose bound reference a write retires during the provider read (%s)',
    async (mode) => {
      let duringRead: (() => Promise<void>) | undefined;
      const env = setup({
        async duringRead() {
          const run = duringRead;
          duringRead = undefined;
          await run?.();
        }
      });
      const billingAccountId = await env.account('alice');
      const first = unwrap(await env.import({ billingAccountId }));
      const entitlementsBefore = await env.db.findMany({ model: 'entitlementSnapshots', where: [], namespace: 'billfn' });
      env.clock.current = new Date('2026-11-12T00:00:00.000Z');
      // The rerun finds `sub_legacy` bound, so no check runs before its read; the plan change lands during it.
      duringRead = () => replaceLegacyReference(env.db, first.subscription.id, mode);
      const eventsBefore = await env.db.findMany({ model: 'billingEvents', where: [], namespace: 'billfn' });

      await expect(env.import({ billingAccountId })).rejects.toMatchObject({
        code: 'BILLFN_CONFLICT',
        retryable: false,
        message: expect.stringContaining('replaced')
      });

      expect(duringRead).toBeUndefined();
      // Only the replacement row remains: no row on the retired reference, and no event or entitlement change for it.
      expect(await env.subscriptions()).toEqual([
        expect.objectContaining({ id: first.subscription.id, providerSubscriptionId: 'sub_replacement' })
      ]);
      expect(await env.db.findMany({ model: 'billingEvents', where: [], namespace: 'billfn' })).toEqual(eventsBefore);
      expect(await env.importEvents()).toHaveLength(1);
      expect(await env.db.findMany({ model: 'entitlementSnapshots', where: [], namespace: 'billfn' })).toEqual(entitlementsBefore);
    }
  );

  it('refuses an import whose reference another account imports and a write retires during its provider read', async () => {
    let alice = '';
    let reads = 0;
    const env = setup({
      async duringRead() {
        reads += 1;
        if (reads !== 1) {
          return;
        }
        // Bob's check found `sub_legacy` unbound; while Bob's read runs, Alice imports it and a plan change retires it.
        const imported = unwrap(await env.import({ billingAccountId: alice }));
        await replaceLegacyReference(env.db, imported.subscription.id, 'recorded');
      }
    });
    alice = await env.account('alice');
    const bob = await env.account('bob');

    await expect(env.import({ billingAccountId: bob })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      retryable: false,
      message: expect.stringContaining('replaced')
    });

    expect(reads).toBe(2);
    expect(await env.subscriptions()).toEqual([
      expect.objectContaining({ billingAccountId: alice, providerSubscriptionId: 'sub_replacement' })
    ]);
    expect(await env.importEvents()).toEqual([expect.objectContaining({ billingAccountId: alice })]);
    expect(await env.db.findMany({ model: 'entitlementSnapshots', where: [], namespace: 'billfn' })).toEqual([
      expect.objectContaining({ billingAccountId: alice })
    ]);
    expect(await env.billfn.subscriptionProvider.isActive({ principalId: 'bob' })).toBe(false);
  });

  it('never writes the reference back onto a row a write took it from while the import was writing', async () => {
    let armed = false;
    const env = setup({
      wrapDb: (db) =>
        ({
          ...db,
          async updateMany(params: Parameters<Db['updateMany']>[0]) {
            const data = params.data as Partial<BillFnSubscription>;
            const target = params.where?.find((clause) => clause.field === 'id')?.value;
            if (armed && params.model === 'subscriptions' && data.providerSubscriptionId === 'sub_legacy' && typeof target === 'string') {
              armed = false;
              // The plan change commits between the import's lookup and its ordered write, so that write is lost.
              await replaceLegacyReference(db, target, 'recorded');
            }
            return db.updateMany(params);
          }
        }) as Db
    });
    const billingAccountId = await env.account('alice');
    const first = unwrap(await env.import({ billingAccountId }));
    env.clock.current = new Date('2026-11-12T00:00:00.000Z');
    armed = true;

    await expect(env.import({ billingAccountId })).rejects.toMatchObject({ code: 'BILLFN_CONFLICT', retryable: false });

    expect(armed).toBe(false);
    expect(await env.subscriptions()).toEqual([
      expect.objectContaining({ id: first.subscription.id, providerSubscriptionId: 'sub_replacement' })
    ]);
    // The replacement reference stays held, never recorded as replaced by the import.
    expect(
      await env.db.findMany({ model: 'replacedProviderReferences', where: [], namespace: 'billfn' })
    ).toEqual([expect.objectContaining({ providerReference: 'sub_legacy' })]);
    expect(await env.importEvents()).toHaveLength(1);
  });

  it('removes a refused binding an interrupted import left, on the rerun, and never lets it grant entitlements', async () => {
    let alice = '';
    let reads = 0;
    const interrupt = { armed: false };
    const env = setup({
      wrapDb: interruptFirstSubscriptionDelete(interrupt),
      async duringRead() {
        reads += 1;
        if (reads !== 1) {
          return;
        }
        // Bob's check found `sub_legacy` unbound; while Bob's read runs, Alice imports it and a plan change retires it.
        const imported = unwrap(await env.import({ billingAccountId: alice }));
        await replaceLegacyReference(env.db, imported.subscription.id, 'recorded');
        // Bob's import then stops before it removes the row it created on the retired reference.
        interrupt.armed = true;
      }
    });
    alice = await env.account('alice');
    const bob = await env.account('bob');

    await expect(env.import({ billingAccountId: bob })).rejects.toThrow('process interrupted');

    // The interrupted run left Bob's row pending: no lookup, webhook or entitlement uses it.
    expect(await env.subscriptions()).toEqual([
      expect.objectContaining({ billingAccountId: alice, providerSubscriptionId: 'sub_replacement' }),
      expect.objectContaining({
        billingAccountId: bob,
        providerSubscriptionId: 'sub_legacy',
        metadata: expect.objectContaining({ [BILLFN_IMPORT_PENDING_METADATA_KEY]: true })
      })
    ]);
    env.clock.current = new Date('2026-11-11T00:00:00.000Z');
    await env.deliver([legacyEvent('evt_while_pending', 'sub_legacy', 'active', '2026-11-11T00:00:00.000Z')]);
    expect(await env.billfn.subscriptionProvider.isActive({ principalId: 'bob' })).toBe(false);
    expect(await env.billfn.subscriptionProvider.getActiveSubscription({ principalId: 'bob' })).toBeNull();
    expect(await env.unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_while_pending', status: 'unlinked', reason: 'subscription_import_pending' })
    ]);

    // The rerun removes the pending row and fails as replaced, without reading the provider again.
    await expect(env.import({ billingAccountId: bob })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      retryable: false,
      message: expect.stringContaining('replaced')
    });
    expect(reads).toBe(2);
    expect(await env.subscriptions()).toEqual([
      expect.objectContaining({ billingAccountId: alice, providerSubscriptionId: 'sub_replacement' })
    ]);
    expect(await entitlementsOf(env.db, bob)).toEqual([]);
    expect(await billingEventsOf(env.db, bob)).toEqual([]);
    expect(await env.importEvents()).toEqual([expect.objectContaining({ billingAccountId: alice })]);

    // A later event on the retired reference reaches no one.
    env.clock.current = new Date('2026-11-12T00:00:00.000Z');
    await env.deliver([legacyEvent('evt_after', 'sub_legacy', 'active', '2026-11-12T00:00:00.000Z')]);
    expect(await env.billfn.subscriptionProvider.isActive({ principalId: 'bob' })).toBe(false);
    expect(await env.subscriptions()).toHaveLength(1);
  });

  it('stores an event delivered while a refused import holds its row unlinked, never applying it to the row', async () => {
    let alice = '';
    let bob = '';
    let reads = 0;
    let deliverDuringCreate: (() => Promise<unknown>) | undefined;
    const env = setup({
      wrapDb: (db) =>
        ({
          ...db,
          async create<T>(params: Parameters<Db['create']>[0]): Promise<T> {
            const created = await db.create<T>(params);
            const data = params.data as Partial<BillFnSubscription>;
            if (params.model === 'subscriptions' && data.billingAccountId === bob && deliverDuringCreate) {
              const deliver = deliverDuringCreate;
              deliverDuringCreate = undefined;
              // Between Bob's create and his import's retirement check, a webhook for the reference arrives.
              await deliver();
            }
            return created;
          }
        }) as Db,
      async duringRead() {
        reads += 1;
        if (reads !== 1) {
          return;
        }
        const imported = unwrap(await env.import({ billingAccountId: alice }));
        await replaceLegacyReference(env.db, imported.subscription.id, 'recorded');
      }
    });
    alice = await env.account('alice');
    bob = await env.account('bob');
    deliverDuringCreate = () =>
      env.deliver([legacyEvent('evt_window', 'sub_legacy', 'active', '2026-11-10T00:00:05.000Z')]);

    await expect(env.import({ billingAccountId: bob })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      retryable: false,
      message: expect.stringContaining('replaced')
    });

    expect(deliverDuringCreate).toBeUndefined();
    expect(await env.subscriptions()).toEqual([
      expect.objectContaining({ billingAccountId: alice, providerSubscriptionId: 'sub_replacement' })
    ]);
    expect(await env.billfn.subscriptionProvider.isActive({ principalId: 'bob' })).toBe(false);
    expect(await entitlementsOf(env.db, bob)).toEqual([]);
    // No lifecycle event was recorded for the retired reference: the event stays unlinked.
    expect(await billingEventsOf(env.db, bob)).toEqual([]);
    expect(await env.unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_window', status: 'unlinked', reason: 'subscription_import_pending' })
    ]);
  });

  it('replays an event delivered while its import holds the row pending, once the import accepts it', async () => {
    let billingAccountId = '';
    let deliverDuringCreate: (() => Promise<unknown>) | undefined;
    const env = setup({
      wrapDb: (db) =>
        ({
          ...db,
          async create<T>(params: Parameters<Db['create']>[0]): Promise<T> {
            const created = await db.create<T>(params);
            if (params.model === 'subscriptions' && deliverDuringCreate) {
              const deliver = deliverDuringCreate;
              deliverDuringCreate = undefined;
              await deliver();
            }
            return created;
          }
        }) as Db
    });
    billingAccountId = await env.account('alice');
    deliverDuringCreate = () =>
      env.deliver([legacyEvent('evt_window_cancel', 'sub_legacy', 'canceled', '2026-11-10T00:00:05.000Z')]);

    const data = unwrap(await env.import({ billingAccountId }));

    expect(deliverDuringCreate).toBeUndefined();
    // The cancellation, newer than the import's read, was held unlinked while the row was pending and applied after.
    expect(data.subscription).toMatchObject({ providerSubscriptionId: 'sub_legacy', status: 'canceled' });
    expect(data.subscription.metadata).not.toHaveProperty(BILLFN_IMPORT_PENDING_METADATA_KEY);
    expect(await env.unlinked()).toEqual([
      expect.objectContaining({ providerEventId: 'evt_window_cancel', status: 'replayed', subscriptionId: data.subscription.id })
    ]);
    expect(await env.billfn.subscriptionProvider.isActive({ principalId: 'alice' })).toBe(false);
  });

  it.each(['recorded', 'pending'] as const)(
    'converges a same-account rerun interrupted after a write retired its reference (%s)',
    async (mode) => {
      let duringRead: (() => Promise<void>) | undefined;
      const interrupt = { armed: false };
      const env = setup({
        wrapDb: interruptFirstSubscriptionDelete(interrupt),
        async duringRead() {
          const run = duringRead;
          duringRead = undefined;
          await run?.();
        }
      });
      const billingAccountId = await env.account('alice');
      const first = unwrap(await env.import({ billingAccountId }));
      const entitlementsBefore = await entitlementsOf(env.db, billingAccountId);
      const eventsBefore = await billingEventsOf(env.db, billingAccountId);
      env.clock.current = new Date('2026-11-12T00:00:00.000Z');
      duringRead = async () => {
        await replaceLegacyReference(env.db, first.subscription.id, mode);
        interrupt.armed = true;
      };

      await expect(env.import({ billingAccountId })).rejects.toThrow('process interrupted');
      // The pending row the interrupted rerun left is not the account's subscription.
      expect(await env.billfn.subscriptionProvider.getActiveSubscription({ principalId: 'alice' })).toMatchObject({
        id: first.subscription.id,
        providerSubscriptionId: 'sub_replacement'
      });

      await expect(env.import({ billingAccountId })).rejects.toMatchObject({
        code: 'BILLFN_CONFLICT',
        retryable: false,
        message: expect.stringContaining('replaced')
      });
      expect(await env.subscriptions()).toEqual([
        expect.objectContaining({ id: first.subscription.id, providerSubscriptionId: 'sub_replacement' })
      ]);
      expect(await billingEventsOf(env.db, billingAccountId)).toEqual(eventsBefore);
      expect(await entitlementsOf(env.db, billingAccountId)).toEqual(entitlementsBefore);
    }
  );

  it('refuses a provider record whose product is not a subscription price of the plan', async () => {
    const env = setup({ record: (reference) => legacyRecord(reference, { productId: 'pdt_team_month' }) });
    const billingAccountId = await env.account('alice');

    await expect(env.import({ billingAccountId })).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(await env.subscriptions()).toEqual([]);
    expect(await env.importEvents()).toEqual([]);
  });

  it('refuses a provider record for another reference and a missing record', async () => {
    const env = setup({ record: (reference) => (reference === 'sub_missing' ? null : legacyRecord('sub_other')) });
    const billingAccountId = await env.account('alice');

    await expect(env.import({ billingAccountId })).rejects.toMatchObject({ code: 'BILLFN_PROVIDER_ERROR' });
    await expect(env.import({ billingAccountId, providerSubscriptionId: 'sub_missing' })).rejects.toMatchObject({
      code: 'BILLFN_NOT_FOUND'
    });
    expect(await env.subscriptions()).toEqual([]);
  });

  it('validates the request before reading the provider', async () => {
    const env = setup();
    const billingAccountId = await env.account('alice');
    const invalid: Array<[Partial<BillFnImportSubscriptionRequest> & { billingAccountId: string }, string]> = [
      [{ billingAccountId, providerSubscriptionId: undefined }, 'BILLFN_VALIDATION_ERROR'],
      [{ billingAccountId, providerSubscriptionId: ' sub_legacy' }, 'BILLFN_VALIDATION_ERROR'],
      [{ billingAccountId, originalTransactionId: '2000000123' }, 'BILLFN_VALIDATION_ERROR'],
      [{ billingAccountId, operator: { id: '' } }, 'BILLFN_VALIDATION_ERROR'],
      [{ billingAccountId: 'ba_user_nobody' }, 'BILLFN_NOT_FOUND'],
      [{ billingAccountId, planKey: 'unknown' }, 'BILLFN_NOT_FOUND'],
      [{ billingAccountId, provider: 'apple', originalTransactionId: '2000000123', providerSubscriptionId: undefined }, 'BILLFN_VALIDATION_ERROR'],
      [{ billingAccountId, subject: { principalId: 'bob' } }, 'BILLFN_VALIDATION_ERROR']
    ];
    for (const [input, code] of invalid) {
      await expect(env.import(input)).rejects.toMatchObject({ code });
    }
    expect(env.importSubscription).not.toHaveBeenCalled();
    expect(await env.subscriptions()).toEqual([]);
  });

  it('creates the billing account of a given subject that has none yet, never for an import refused before the provider read', async () => {
    const env = setup();
    await expect(env.import({ billingAccountId: 'ba_user_carol', subject: { principalId: 'carol' }, planKey: 'unknown' })).rejects.toMatchObject({
      code: 'BILLFN_NOT_FOUND'
    });
    expect(await env.db.findMany({ model: 'billingAccounts', where: [], namespace: 'billfn' })).toEqual([]);

    const data = unwrap(await env.import({ billingAccountId: 'ba_user_carol', subject: { principalId: 'carol' } }));

    expect(data.subscription.billingAccountId).toBe('ba_user_carol');
    expect(await env.billfn.subscriptionProvider.isActive({ principalId: 'carol' })).toBe(true);
  });

  it('is not exposed as a public route', async () => {
    const env = setup();
    const billingAccountId = await env.account('alice');
    for (const path of ['/billfn/subscriptions/import', '/billfn/import-subscription', '/billfn/subscriptions/import-subscription']) {
      const response = await env.billfn.router.handle(
        new Request(`https://billing.example.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider: 'dodo', providerSubscriptionId: 'sub_legacy', billingAccountId, planKey: 'nucleus', operator: OPERATOR })
        })
      );
      // No route matches (BillFn's router answers an unmatched path with an error response).
      expect(response.ok).toBe(false);
    }
    expect(env.importSubscription).not.toHaveBeenCalled();
    expect(await env.subscriptions()).toEqual([]);
  });
});
