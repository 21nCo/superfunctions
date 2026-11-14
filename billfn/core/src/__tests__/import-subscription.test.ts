import { describe, expect, it, vi } from 'vitest';
import { memoryAdapter } from '@superfunctions/db/testing';
import { BILLFN_IMPORTED_AT_METADATA_KEY, createBillFn } from '../index.js';
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

function setup(options: ProviderOptions = {}) {
  const base = memoryAdapter({ debug: false });
  const db = withSubscriptionReferenceUniqueness(base);
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

    await expect(env.import({ billingAccountId })).rejects.toMatchObject({ code: 'BILLFN_CONFLICT' });
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
  });

  it('refuses a reference bound to another billing account without reading the provider or writing', async () => {
    const env = setup();
    const alice = await env.account('alice');
    const bob = await env.account('bob');
    const bound = unwrap(await env.import({ billingAccountId: alice }));
    env.importSubscription.mockClear();

    await expect(env.import({ billingAccountId: bob })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
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

  it('creates the billing account of a given subject that has none yet, only for an import it accepts', async () => {
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
