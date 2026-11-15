import { describe, expect, it, vi } from 'vitest';
import type { Adapter, TransactionAdapter } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn } from '../index.js';
import { LIFECYCLE_INLINE_DELIVERY_MS } from '../lifecycle.js';
import type {
  BillFnCatalog,
  BillFnLifecycleEvent,
  BillFnLifecycleEventHandler,
  BillFnLifecycleEventRecord,
  BillFnProviderAdapter,
  SubscriptionStatus
} from '../types.js';

const catalog: BillFnCatalog = {
  plans: [
    {
      productKey: 'nucleus',
      planKey: 'nucleus',
      displayName: 'Nucleus',
      features: { memotron: true, pointron: true },
      limits: { storage: 5000 },
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
};

const PRINCIPAL = 'user_1';
const ACCOUNT = `ba_user_${PRINCIPAL}`;
const MINUTE = 60 * 1000;
const HOUR_MS = 60 * MINUTE;
const DAY = 24 * HOUR_MS;

type ProviderState = { status: SubscriptionStatus; periodEnd: string; autoRenew: boolean };

function createProvider(state: ProviderState): BillFnProviderAdapter {
  const billingState = (providerSubscriptionId: string) => ({
    subscriptionStatus: state.status,
    checkoutStatus: 'succeeded' as const,
    providerSubscriptionId,
    providerChargeId: `charge_${providerSubscriptionId}`,
    currentPeriodStart: '2026-11-10T00:00:00.000Z',
    currentPeriodEnd: state.periodEnd,
    autoRenew: state.autoRenew
  });
  return {
    provider: 'dodo',
    capabilities: {
      createCheckout: true,
      verifyCheckout: true,
      cancelSubscription: true,
      syncSubscription: true,
      restorePurchases: false,
      webhookIngestion: false
    },
    async createCheckout(input) {
      return { status: 'requires_action', providerCheckoutId: `checkout_${input.checkoutSessionId}` };
    },
    async verifyCheckout(input) {
      return billingState(`sub_${input.checkoutSession.checkoutSessionId}`);
    },
    async fetchSubscription(input) {
      return billingState(input.subscription.providerSubscriptionId!);
    },
    async cancelSubscription(input) {
      state.autoRenew = false;
      return { operationStatus: 'applied', billingState: billingState(input.subscription.providerSubscriptionId!) };
    }
  };
}

function setup(options: { db?: Adapter; onEvent?: BillFnLifecycleEventHandler | null; clock?: { current: Date } } = {}) {
  const db = options.db ?? memoryAdapter({ debug: false });
  const clock = options.clock ?? { current: new Date('2026-11-10T00:00:00.000Z') };
  const delivered: BillFnLifecycleEvent[] = [];
  const providerState: ProviderState = { status: 'active', periodEnd: '2026-12-10T00:00:00.000Z', autoRenew: true };
  const onEvent =
    options.onEvent === null
      ? undefined
      : (options.onEvent ??
        ((event: BillFnLifecycleEvent) => {
          delivered.push(event);
        }));
  const billfn = createBillFn({
    db,
    catalog,
    providers: { dodo: createProvider(providerState) },
    now: () => clock.current,
    onEvent
  });
  const subject = { principalId: PRINCIPAL };
  return {
    db,
    billfn,
    clock,
    subject,
    delivered,
    providerState,
    advance(ms: number) {
      clock.current = new Date(clock.current.getTime() + ms);
    },
    async subscribe() {
      const created = await billfn.createCheckout({ subject, planKey: 'nucleus', provider: 'dodo', interval: 'month' });
      if (!created.ok) throw new Error('expected checkout');
      const checkoutSessionId = created.data.checkoutSession.checkoutSessionId;
      const verified = await billfn.verifyCheckout({ subject, checkoutSessionId });
      if (!verified.ok) throw new Error('expected verification');
      return { checkoutSessionId, subscriptionId: verified.data.subscription!.id };
    },
    trial(expiresInMs: number) {
      return billfn.services.grants.create({
        billingAccountId: ACCOUNT,
        subject,
        planKey: 'nucleus',
        kind: 'trial',
        expiresAt: new Date(clock.current.getTime() + expiresInMs).toISOString()
      });
    },
    /** Syncs the subscription through a reconciliation job, which also reaches one that ended; its final status. */
    async syncJob(subscriptionId: string) {
      const enqueued = await billfn.enqueueReconciliationJob({ kind: 'subscription-sync', provider: 'dodo', subscriptionId });
      if (!enqueued.ok) throw new Error('expected job');
      try {
        const ran = await billfn.runReconciliationJob({ jobId: enqueued.data.job.id });
        return ran.ok ? ran.data.job.status : 'error';
      } catch {
        return 'error';
      }
    },
    async runLifecycleJob() {
      const enqueued = await billfn.enqueueReconciliationJob({ kind: 'lifecycle-events' });
      if (!enqueued.ok) throw new Error('expected job');
      const ran = await billfn.runReconciliationJob({ jobId: enqueued.data.job.id });
      if (!ran.ok) throw new Error('expected job run');
      return ran.data.job;
    },
    rows() {
      return db.findMany<BillFnLifecycleEventRecord>({ model: 'lifecycleEvents', namespace: 'billfn' });
    },
    ofType<T extends BillFnLifecycleEvent['type']>(type: T) {
      return delivered.filter((event): event is BillFnLifecycleEvent<T> => event.type === type);
    }
  };
}

/**
 * Throws on lifecycle event writes or claims, or on entitlement snapshot writes (a crash after the subscription
 * write committed), while the matching flag is on, also inside a transaction. `transactions: false` turns
 * transactions off, as Drizzle SQLite has none.
 */
function faultyLifecycleDb(base: Adapter = memoryAdapter({ debug: false }), options: { transactions?: boolean } = {}) {
  const faults = { create: false, update: false, settle: false, snapshot: false };
  const faulty = <A extends Pick<Adapter, 'create' | 'updateMany'>>(adapter: A): A => ({
    ...adapter,
    async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
      if (faults.create && params.model === 'lifecycleEvents') throw new Error('outbox write failed');
      if (faults.snapshot && params.model === 'entitlementSnapshots') throw new Error('process stopped');
      return adapter.create<T>(params);
    },
    async updateMany(params: Parameters<Adapter['updateMany']>[0]) {
      if (params.model === 'lifecycleEvents') {
        // A claim sets claimId; a settle filters on it.
        const settling = params.where?.some((clause) => clause.field === 'claimId');
        if ((faults.update && !settling) || (faults.settle && settling)) throw new Error('dispatcher crashed');
      }
      if (faults.snapshot && params.model === 'entitlementSnapshots') throw new Error('process stopped');
      return adapter.updateMany(params);
    }
  });
  const db: Adapter =
    options.transactions === false
      ? {
          ...faulty(base),
          capabilities: { ...base.capabilities, transactions: { ...base.capabilities.transactions, supported: false } },
          async transaction(): Promise<never> {
            throw new Error('transaction should not be called');
          }
        }
      : {
          ...faulty(base),
          transaction<R>(callback: (transaction: TransactionAdapter) => Promise<R>): Promise<R> {
            return base.transaction((transaction) => callback(faulty(transaction)));
          }
        };
  return { db, faults };
}


describe('lifecycle events: one per event type', () => {
  it('checkout.completed once per succeeded checkout session, delivered after the call', async () => {
    const env = setup();
    const { checkoutSessionId, subscriptionId } = await env.subscribe();
    expect(env.ofType('checkout.completed')).toEqual([
      expect.objectContaining({
        type: 'checkout.completed',
        billingAccountId: ACCOUNT,
        attempt: 1,
        data: { checkoutSessionId, subscriptionId, provider: 'dodo', planKey: 'nucleus', priceId: 'price_nucleus_month' }
      })
    ]);

    // Verifying again applies the same state: the event id derives from the session, so nothing new is recorded.
    env.advance(MINUTE);
    await env.billfn.verifyCheckout({ subject: env.subject, checkoutSessionId });
    expect(env.ofType('checkout.completed')).toHaveLength(1);
    expect((await env.rows()).filter((row) => row.type === 'checkout.completed')).toEqual([
      expect.objectContaining({ status: 'delivered', attempts: 1 })
    ]);
  });

  it('entitlement.changed when a subscription write changes the paid entitlements, not on an unchanged sync', async () => {
    const env = setup();
    const { subscriptionId } = await env.subscribe();
    expect(env.ofType('entitlement.changed')).toEqual([
      expect.objectContaining({
        data: {
          cause: 'subscription',
          subscriptionId,
          planKey: 'nucleus',
          status: 'active',
          previousPlanKey: null,
          previousStatus: null
        }
      })
    ]);

    env.advance(MINUTE);
    await env.billfn.syncSubscription({ subject: env.subject });
    expect(env.ofType('entitlement.changed')).toHaveLength(1);

    env.providerState.status = 'expired';
    env.providerState.autoRenew = false;
    env.advance(MINUTE);
    await env.billfn.syncSubscription({ subject: env.subject });
    expect(env.ofType('entitlement.changed').map((event) => event.data)).toEqual([
      expect.objectContaining({ status: 'active' }),
      expect.objectContaining({ status: 'inactive', previousStatus: 'active', previousPlanKey: 'nucleus' })
    ]);
    // An expiry is not a cancellation.
    expect(env.ofType('subscription.canceled')).toEqual([]);
  });

  it('entitlement.changed ignores the key order a jsonb column returns features and limits in', async () => {
    const base = memoryAdapter({ debug: false });
    const reorder = (value: unknown) =>
      Object.fromEntries(Object.entries((value ?? {}) as Record<string, unknown>).reverse());
    const db: Adapter = {
      ...base,
      async findOne<T>(params: Parameters<Adapter['findOne']>[0]): Promise<T | null> {
        const row = await base.findOne<Record<string, unknown>>(params);
        if (row && params.model === 'entitlementSnapshots') {
          return { ...row, features: reorder(row.features), limits: reorder(row.limits) } as T;
        }
        return row as T | null;
      }
    };
    const env = setup({ db });
    await env.subscribe();
    env.advance(MINUTE);
    await env.billfn.syncSubscription({ subject: env.subject });
    expect(env.ofType('entitlement.changed')).toHaveLength(1);
  });

  it('subscription.renewed once per new period end of an active subscription', async () => {
    const env = setup();
    const { subscriptionId } = await env.subscribe();
    expect(env.ofType('subscription.renewed')).toEqual([]);

    env.providerState.periodEnd = '2027-01-10T00:00:00.000Z';
    env.advance(MINUTE);
    await env.billfn.syncSubscription({ subject: env.subject });
    env.advance(MINUTE);
    await env.billfn.syncSubscription({ subject: env.subject });
    expect(env.ofType('subscription.renewed')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionId,
          currentPeriodEnd: '2027-01-10T00:00:00.000Z',
          previousPeriodEnd: '2026-12-10T00:00:00.000Z'
        })
      })
    ]);
  });

  it('subscription.canceled when a renewing subscription stops renewing, once', async () => {
    const env = setup();
    const { subscriptionId } = await env.subscribe();
    env.advance(MINUTE);
    const canceled = await env.billfn.cancelSubscription({ subject: env.subject });
    expect(canceled.ok).toBe(true);
    env.advance(MINUTE);
    await env.billfn.syncSubscription({ subject: env.subject });
    expect(env.ofType('subscription.canceled')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ subscriptionId, status: 'active', autoRenew: false, currentPeriodEnd: '2026-12-10T00:00:00.000Z' })
      })
    ]);
  });

  it('grant.started and its entitlement.changed when a grant is created', async () => {
    const env = setup();
    const created = await env.trial(14 * DAY);
    if (!created.ok) throw new Error('expected grant');
    const grantId = created.data.grant.id;
    expect(env.delivered.map((event) => [event.type, event.data])).toEqual([
      [
        'grant.started',
        { grantId, kind: 'trial', planKey: 'nucleus', startsAt: '2026-11-10T00:00:00.000Z', expiresAt: '2026-11-24T00:00:00.000Z' }
      ],
      ['entitlement.changed', { cause: 'grant.started', grantId, planKey: 'nucleus', status: 'trialing' }]
    ]);
  });

  it('grant.expiring from the lifecycle job 3 days before expiry, once, then entitlement.changed at expiry', async () => {
    const env = setup();
    const created = await env.trial(14 * DAY);
    if (!created.ok) throw new Error('expected grant');
    const grantId = created.data.grant.id;

    env.advance(10 * DAY);
    await env.runLifecycleJob();
    expect(env.ofType('grant.expiring')).toEqual([]);

    env.advance(DAY + MINUTE);
    const job = await env.runLifecycleJob();
    expect(job.status).toBe('succeeded');
    await env.runLifecycleJob();
    expect(env.ofType('grant.expiring')).toEqual([
      expect.objectContaining({
        billingAccountId: ACCOUNT,
        data: { grantId, kind: 'trial', planKey: 'nucleus', expiresAt: '2026-11-24T00:00:00.000Z' }
      })
    ]);

    env.advance(3 * DAY);
    await env.runLifecycleJob();
    await env.runLifecycleJob();
    expect(env.ofType('entitlement.changed').map((event) => event.data)).toEqual([
      expect.objectContaining({ cause: 'grant.started' }),
      { cause: 'grant.expired', grantId, planKey: 'nucleus', status: 'inactive' }
    ]);
  });
});

describe.each([
  ['with transactions', true],
  ['without transactions', false]
])('lifecycle events of a subscription write that fails or stops (%s)', (_mode, transactions) => {
  const changes: Array<[string, (state: ProviderState) => void, BillFnLifecycleEvent['type'][]]> = [
    ['a renewal', (state) => void (state.periodEnd = '2027-01-10T00:00:00.000Z'), ['subscription.renewed']],
    ['a cancellation that stops renewal', (state) => void (state.autoRenew = false), ['subscription.canceled']],
    [
      'a cancellation to status canceled',
      (state) => void (state.status = 'canceled'),
      ['entitlement.changed', 'subscription.canceled']
    ],
    ['an expiry that changes entitlements', (state) => void (state.status = 'expired'), ['entitlement.changed']]
  ];

  it.each(changes)('delivers the events of %s once after a failed outbox write and a stop after the write', async (_change, apply, expected) => {
    const { db, faults } = faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions });
    const env = setup({ db });
    const { subscriptionId } = await env.subscribe();
    const before = env.delivered.length;
    apply(env.providerState);

    // The outbox write fails: the sync fails, and no state write that would hide the change from a retry stands.
    faults.create = true;
    env.advance(MINUTE);
    expect(await env.syncJob(subscriptionId)).not.toBe('succeeded');
    faults.create = false;

    // The process stops after the subscription write committed, before its entitlements are written.
    faults.snapshot = true;
    env.advance(MINUTE);
    expect(await env.syncJob(subscriptionId)).not.toBe('succeeded');
    faults.snapshot = false;

    // A retry and later syncs and dispatches add nothing twice.
    for (let call = 0; call < 2; call += 1) {
      env.advance(MINUTE);
      expect(await env.syncJob(subscriptionId)).toBe('succeeded');
    }
    env.advance(HOUR_MS);
    await env.billfn.services.events.dispatch();

    const after = env.delivered.slice(before);
    expect(after.map((event) => event.type).sort()).toEqual(expected);
    expect(new Set(after.map((event) => event.id)).size).toBe(after.length);
    const pending = (await env.rows()).filter((row) => row.status !== 'delivered');
    expect(pending).toEqual([]);
  });
});

describe('lifecycle events: delivery', () => {
  it('records nothing without an onEvent handler', async () => {
    const env = setup({ onEvent: null });
    await env.subscribe();
    await env.trial(DAY);
    expect(await env.rows()).toEqual([]);
    await expect(env.billfn.services.events.dispatch()).resolves.toEqual({ delivered: 0, retrying: 0, failed: 0 });
  });

  it('retries a failing handler with backoff and delivers the same event id once it succeeds', async () => {
    let failing = true;
    const calls: BillFnLifecycleEvent[] = [];
    const env = setup({
      onEvent: (event) => {
        calls.push(event);
        if (failing) throw new Error('mail provider down');
      }
    });
    // The request succeeds although its event's delivery failed.
    const created = await env.trial(14 * DAY);
    expect(created.ok).toBe(true);
    const [started] = (await env.rows()).filter((row) => row.type === 'grant.started');
    expect(started).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastError: 'mail provider down',
      nextAttemptAt: '2026-11-10T00:00:30.000Z'
    });

    // Not due before its backoff.
    await expect(env.billfn.services.events.dispatch()).resolves.toEqual({ delivered: 0, retrying: 0, failed: 0 });
    env.advance(30 * 1000);
    await expect(env.billfn.services.events.dispatch()).resolves.toEqual({ delivered: 0, retrying: 2, failed: 0 });
    // The backoff doubles.
    expect((await env.billfn.services.events.list()).map((row) => row.nextAttemptAt)).toEqual([
      '2026-11-10T00:01:30.000Z',
      '2026-11-10T00:01:30.000Z'
    ]);

    failing = false;
    env.advance(MINUTE);
    await expect(env.billfn.services.events.dispatch()).resolves.toEqual({ delivered: 2, retrying: 0, failed: 0 });
    const deliveries = calls.filter((event) => event.type === 'grant.started');
    expect(deliveries.map((event) => event.attempt)).toEqual([1, 2, 3]);
    expect(new Set(deliveries.map((event) => event.id)).size).toBe(1);
    expect(await env.billfn.services.events.list({ status: 'delivered' })).toHaveLength(2);
  });

  it('marks an event failed after 24 hours of handler failures and lists it for ops', async () => {
    const env = setup({
      onEvent: () => {
        throw new Error('handler down');
      }
    });
    await env.trial(14 * DAY);
    // Each pass retries whatever is due; the last retry lands on the 24-hour mark.
    for (let pass = 0; pass < 60; pass += 1) {
      env.advance(HOUR_MS);
      await env.billfn.services.events.dispatch();
    }
    const failed = await env.billfn.services.events.list({ status: 'failed' });
    expect(failed.map((row) => row.type).sort()).toEqual(['entitlement.changed', 'grant.started']);
    for (const row of failed) {
      expect(Date.parse(row.failedAt!) - Date.parse(row.createdAt)).toBeGreaterThanOrEqual(DAY);
      expect(Date.parse(row.failedAt!) - Date.parse(row.createdAt)).toBeLessThan(DAY + HOUR_MS);
      expect(row.lastError).toBe('handler down');
    }
    expect(await env.billfn.services.events.list({ status: 'pending' })).toEqual([]);
  });

  it('delivers an event once when two dispatchers race on it', async () => {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    // The recording instance has a failing handler, so the event waits in the outbox.
    const writer = setup({
      db,
      clock,
      onEvent: () => {
        throw new Error('not yet');
      }
    });
    await writer.trial(14 * DAY);
    clock.current = new Date(clock.current.getTime() + MINUTE);

    const handler = async (event: BillFnLifecycleEvent) => {
      calls.push(event.id);
      await gate;
    };
    const first = setup({ db, clock, onEvent: handler });
    const second = setup({ db, clock, onEvent: handler });
    const racing = Promise.all([first.billfn.services.events.dispatch(), second.billfn.services.events.dispatch()]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const [left, right] = await racing;
    expect(left.delivered + right.delivered).toBe(2);
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
  });

  it('delivers an event committed before a crash that prevented its dispatch', async () => {
    const { db, faults } = faultyLifecycleDb();
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    const crashed = setup({ db, clock });
    // The event commits; the dispatch after it fails (the process died before claiming it).
    faults.update = true;
    await crashed.trial(14 * DAY);
    expect(crashed.delivered).toEqual([]);
    expect(await crashed.rows()).toHaveLength(2);

    faults.update = false;
    const restarted = setup({ db, clock });
    await expect(restarted.billfn.services.events.dispatch()).resolves.toEqual({ delivered: 2, retrying: 0, failed: 0 });
    expect(restarted.delivered.map((event) => event.type).sort()).toEqual(['entitlement.changed', 'grant.started']);
  });

  it('redelivers an event whose dispatcher crashed after calling the handler once its claim lapses', async () => {
    const { db, faults } = faultyLifecycleDb();
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    const crashed = setup({ db, clock });
    faults.settle = true;
    await crashed.trial(14 * DAY);
    const firstIds = crashed.delivered.map((event) => event.id);
    expect(firstIds).toHaveLength(2);
    faults.settle = false;

    const restarted = setup({ db, clock });
    clock.current = new Date(clock.current.getTime() + 4 * MINUTE);
    await expect(restarted.billfn.services.events.dispatch()).resolves.toEqual({ delivered: 0, retrying: 0, failed: 0 });
    clock.current = new Date(clock.current.getTime() + 2 * MINUTE);
    await expect(restarted.billfn.services.events.dispatch()).resolves.toEqual({ delivered: 2, retrying: 0, failed: 0 });
    expect(restarted.delivered.map((event) => [event.id, event.attempt])).toEqual(firstIds.map((id) => [id, 2]));
  });

  it.each([
    ['an entitlements read', (env: ReturnType<typeof setup>) => env.billfn.getEntitlements(env.subject)],
    [
      'a subscription provider read',
      (env: ReturnType<typeof setup>) => env.billfn.subscriptionProvider.getEntitlementSnapshot(env.subject)
    ]
  ])('records and delivers a grant event a failed outbox write left out once %s repairs it (no transactions)', async (_read, read) => {
    const { db, faults } = faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions: false });
    const env = setup({ db });
    faults.create = true;
    const created = await env.trial(14 * DAY);
    expect(created.ok).toBe(true);
    expect(await env.rows()).toEqual([]);

    faults.create = false;
    await read(env);
    expect(env.delivered.map((event) => event.type)).toEqual(['grant.started', 'entitlement.changed']);
  });

  it('returns a call whose handler hangs once the inline delivery time is up, leaving the event pending', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const env = setup({ onEvent: () => new Promise<void>(() => undefined) });
      let settled = false;
      const created = env.trial(14 * DAY).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(LIFECYCLE_INLINE_DELIVERY_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await created).ok).toBe(true);
      // The claimed events stay pending, due again once the claim lapses.
      expect((await env.rows()).map((row) => row.status)).toEqual(['pending', 'pending']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rolls a grant back with its lifecycle events when the outbox write fails in its transaction', async () => {
    const base = memoryAdapter({ debug: false });
    const faults = { create: false };
    const db: Adapter = {
      ...base,
      async transaction<R>(callback: (transaction: TransactionAdapter) => Promise<R>): Promise<R> {
        return base.transaction(async (transaction) =>
          callback({
            ...transaction,
            async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
              if (faults.create && params.model === 'lifecycleEvents') throw new Error('outbox write failed');
              return transaction.create<T>(params);
            }
          })
        );
      }
    };
    const env = setup({ db });
    faults.create = true;
    await expect(env.trial(14 * DAY)).rejects.toThrow('outbox write failed');
    expect(await db.findMany({ model: 'entitlementGrants', namespace: 'billfn' })).toEqual([]);
  });
});

