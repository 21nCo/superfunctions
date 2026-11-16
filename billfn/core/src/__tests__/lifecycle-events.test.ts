import { describe, expect, it, vi } from 'vitest';
import type { Adapter, TransactionAdapter } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn } from '../index.js';
import { GRANT_SWEEP_RUN_LIMIT, LIFECYCLE_CLAIM_LEASE_MS, LIFECYCLE_INLINE_DELIVERY_MS } from '../lifecycle.js';
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

type ProviderState = { status: SubscriptionStatus; periodEnd: string; autoRenew: boolean; periodStart?: string };

function createProvider(state: ProviderState): BillFnProviderAdapter {
  const billingState = (providerSubscriptionId: string) => ({
    subscriptionStatus: state.status,
    checkoutStatus: 'succeeded' as const,
    providerSubscriptionId,
    providerChargeId: `charge_${providerSubscriptionId}`,
    currentPeriodStart: state.periodStart ?? '2026-11-10T00:00:00.000Z',
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
  const faults = {
    create: false,
    update: false,
    settle: false,
    snapshot: false,
    /** Deleting outbox rows fails (with a failed state write: the process stopped before it released them). */
    release: false,
    /** The next subscription update fails before it applies, or applies and then fails. */
    subscriptionWrite: null as 'before' | 'after' | null,
    /** Runs once before the next subscription or snapshot update, as another writer racing it. */
    raceSubscription: null as (() => Promise<void>) | null,
    raceSnapshot: null as (() => Promise<void>) | null,
    /** Awaited before the next snapshot update applies. */
    pauseSnapshot: null as Promise<void> | null,
    /** Writing a billing event fails (the process stopped after a grant change and its lifecycle events). */
    billingEvent: false,
    /** The next snapshot update applies and then fails. */
    snapshotWrite: null as 'after' | null,
    /** Runs once before the next outbox row is created, as another call racing this one. */
    raceStage: null as (() => Promise<void>) | null,
    /** Fails each create this matches. */
    failCreate: null as ((model: string, data: Record<string, any>) => boolean) | null
  };
  const faulty = <A extends Pick<Adapter, 'create' | 'updateMany' | 'deleteMany'>>(adapter: A): A => ({
    ...adapter,
    async deleteMany(params: Parameters<Adapter['deleteMany']>[0]) {
      if (faults.release && params.model === 'lifecycleEvents') throw new Error('process stopped');
      return adapter.deleteMany(params);
    },
    async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
      if (params.model === 'lifecycleEvents') {
        const race = faults.raceStage;
        faults.raceStage = null;
        await race?.();
      }
      if (faults.create && params.model === 'lifecycleEvents') throw new Error('outbox write failed');
      if (faults.snapshot && params.model === 'entitlementSnapshots') throw new Error('process stopped');
      if (faults.billingEvent && params.model === 'billingEvents') throw new Error('process stopped');
      if (faults.failCreate?.(params.model, params.data as Record<string, any>)) throw new Error('write failed');
      return adapter.create<T>(params);
    },
    async updateMany(params: Parameters<Adapter['updateMany']>[0]) {
      if (params.model === 'lifecycleEvents') {
        // A claim sets claimId; a settle filters on it.
        const settling = params.where?.some((clause) => clause.field === 'claimId');
        if ((faults.update && !settling) || (faults.settle && settling)) throw new Error('dispatcher crashed');
      }
      if (faults.snapshot && params.model === 'entitlementSnapshots') throw new Error('process stopped');
      if (params.model === 'subscriptions') {
        const race = faults.raceSubscription;
        faults.raceSubscription = null;
        await race?.();
        const write = faults.subscriptionWrite;
        faults.subscriptionWrite = null;
        if (write === 'before') throw new Error('subscription write failed');
        const updated = await adapter.updateMany(params);
        if (write === 'after') throw new Error('process stopped');
        return updated;
      }
      if (params.model === 'entitlementSnapshots') {
        const race = faults.raceSnapshot;
        faults.raceSnapshot = null;
        await race?.();
        const pause = faults.pauseSnapshot;
        faults.pauseSnapshot = null;
        await pause;
        const write = faults.snapshotWrite;
        faults.snapshotWrite = null;
        const updated = await adapter.updateMany(params);
        if (write === 'after') throw new Error('process stopped');
        return updated;
      }
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
          features: { memotron: true, pointron: true },
          limits: { storage: 5000 },
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

  it.each(['paused', 'past_due', 'pending'] as const)(
    'no subscription.canceled when a renewing subscription goes to %s and back, and one when it is canceled while held',
    async (held) => {
      const env = setup();
      await env.subscribe();
      const sync = async (status: SubscriptionStatus, autoRenew: boolean) => {
        Object.assign(env.providerState, { status, autoRenew });
        env.advance(MINUTE);
        await env.billfn.syncSubscription({ subject: env.subject });
        await env.billfn.services.events.dispatch();
      };
      // A hold keeps the renewal intent (autoRenew), as Dodo maps on_hold.
      await sync(held, true);
      await sync('active', true);
      expect(env.ofType('subscription.canceled')).toEqual([]);
      await sync(held, true);
      await sync('canceled', false);
      expect(env.ofType('subscription.canceled')).toEqual(
        held === 'pending' ? [] : [expect.objectContaining({ data: expect.objectContaining({ status: 'canceled', autoRenew: false }) })]
      );
    }
  );

  it.each([
    // Apple: a failed renewal, then AUTO_RENEW_DISABLED (active, autoRenew off), then EXPIRED.
    ['past_due', 'active', 'expired'],
    // Dodo: a cancel at the next billing date during on_hold, then the hold clears, then the period ends.
    ['paused', 'paused', 'canceled'],
    ['paused', 'active', 'canceled']
  ] as const)('subscription.canceled once when renewal is turned off during a %s hold (then %s, then %s)', async (held, off, end) => {
    const env = setup();
    await env.subscribe();
    const sync = async (status: SubscriptionStatus, autoRenew: boolean) => {
      Object.assign(env.providerState, { status, autoRenew });
      env.advance(MINUTE);
      await env.billfn.syncSubscription({ subject: env.subject });
      await env.billfn.services.events.dispatch();
    };
    await sync(held, true);
    await sync(off, false);
    expect(env.ofType('subscription.canceled')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ status: off, autoRenew: false }) })
    ]);
    await sync('active', false);
    await sync(end, false);
    expect(env.ofType('subscription.canceled')).toHaveLength(1);
  });

  it.each(['trialing', 'grace'] as const)('subscription.canceled when a %s subscription stops renewing', async (status) => {
    const env = setup();
    await env.subscribe();
    Object.assign(env.providerState, { status, autoRenew: true });
    env.advance(MINUTE);
    await env.billfn.syncSubscription({ subject: env.subject });
    env.providerState.autoRenew = false;
    env.advance(MINUTE);
    await env.billfn.syncSubscription({ subject: env.subject });
    expect(env.ofType('subscription.canceled')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ status, autoRenew: false }) })
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

describe('lifecycle events report changes, not stored state', () => {
  /** Billing state written before `onEvent` was configured (before the deploy), then BillFn with a handler. */
  async function beforeDeploy(before: (env: ReturnType<typeof setup>) => Promise<void>) {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    await before(setup({ db, clock, onEvent: null }));
    clock.current = new Date(clock.current.getTime() + MINUTE);
    const env = setup({ db, clock });
    expect(await env.rows()).toEqual([]);
    return env;
  }

  it('records no checkout.completed for a session that succeeded before, when a verification or sync rewrites it', async () => {
    let session = { checkoutSessionId: '', subscriptionId: '' };
    const env = await beforeDeploy(async (before) => {
      session = await before.subscribe();
    });
    await env.billfn.verifyCheckout({ subject: env.subject, checkoutSessionId: session.checkoutSessionId });
    env.providerState.periodEnd = '2027-01-10T00:00:00.000Z';
    expect(await env.syncJob(session.subscriptionId)).toBe('succeeded');
    await env.billfn.verifyCheckout({ subject: env.subject, checkoutSessionId: session.checkoutSessionId });

    expect(env.ofType('checkout.completed')).toEqual([]);
    expect(env.ofType('subscription.renewed')).toHaveLength(1);
  });

  it('records no grant event for a grant made before, when a second trial is refused or a revoke is repeated', async () => {
    let compId = '';
    const env = await beforeDeploy(async (before) => {
      expect((await before.trial(14 * DAY)).ok).toBe(true);
      const comp = await before.billfn.services.grants.create({
        billingAccountId: ACCOUNT,
        subject: before.subject,
        planKey: 'nucleus',
        kind: 'comp',
        expiresAt: new Date(before.clock.current.getTime() + 30 * DAY).toISOString()
      });
      if (!comp.ok) throw new Error('expected grant');
      compId = comp.data.grant.id;
      expect((await before.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: compId })).ok).toBe(true);
    });

    await expect(env.trial(14 * DAY)).rejects.toThrow('A trial was already granted');
    const revoked = await env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: compId });
    expect(revoked.ok).toBe(true);
    await env.billfn.getEntitlements(env.subject);
    await env.runLifecycleJob();

    expect(env.delivered).toEqual([]);
    expect(await env.rows()).toEqual([]);
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
    // Past the stage window, so a stage no applied write names (the stopped snapshot write) is gone too.
    env.advance(DAY + HOUR_MS);
    await env.billfn.services.events.dispatch();

    const after = env.delivered.slice(before);
    expect(after.map((event) => event.type).sort()).toEqual(expected);
    expect(new Set(after.map((event) => event.id)).size).toBe(after.length);
    const pending = (await env.rows()).filter((row) => row.status !== 'delivered');
    expect(pending).toEqual([]);
  });
});

describe('lifecycle events of a write without transactions', () => {
  const LEASE = 5 * MINUTE;

  function staging() {
    const base = memoryAdapter({ debug: false });
    const { db, faults } = faultyLifecycleDb(base, { transactions: false });
    return { base, db, faults };
  }

  /** Whether a call succeeded; a call that throws counts as failed. */
  function succeeded(call: Promise<{ ok: boolean }>) {
    return call.then(
      (result) => result.ok,
      () => false
    );
  }

  it('delivers entitlement.changed only once its snapshot write committed, so the handler reads the committed state', async () => {
    const { db, faults } = staging();
    const read: string[] = [];
    const env = setup({
      db,
      onEvent: async (event) => {
        if (event.type === 'entitlement.changed') {
          const snapshot = await db.findOne<{ status: string }>({
            model: 'entitlementSnapshots',
            where: [{ field: 'billingAccountId', operator: 'eq', value: ACCOUNT }],
            namespace: 'billfn'
          });
          read.push(snapshot!.status);
        }
      }
    });
    await env.subscribe();
    expect(read).toEqual(['active']);

    let resume!: () => void;
    faults.pauseSnapshot = new Promise<void>((resolve) => (resume = resolve));
    env.providerState.status = 'expired';
    env.advance(MINUTE);
    const sync = succeeded(env.billfn.syncSubscription({ subject: env.subject }));
    await vi.waitFor(() => expect(faults.pauseSnapshot).toBeNull());

    // Other dispatchers run while the snapshot write is paused, also once its stage lapsed.
    await env.billfn.services.events.dispatch();
    env.advance(LEASE + MINUTE);
    await env.billfn.services.events.dispatch();
    expect(read).toEqual(['active']);

    resume();
    expect(await sync).toBe(true);
    await env.billfn.services.events.dispatch();
    expect(read).toEqual(['active', 'inactive']);
    expect((await env.rows()).filter((row) => row.status !== 'delivered')).toEqual([]);
  });

  it.each([
    ['subscription.canceled', 'a subscription', (env: ReturnType<typeof setup>) => void (env.providerState.autoRenew = false)],
    ['entitlement.changed', 'a snapshot', (env: ReturnType<typeof setup>) => void (env.providerState.status = 'expired')]
  ] as const)('delivers %s once under one id when %s write loses its race and is retried', async (type, _write, apply) => {
    const { base, db, faults } = staging();
    const env = setup({ db });
    const { subscriptionId } = await env.subscribe();
    const before = env.ofType(type).length;
    const bump = (model: string, field: string, value: string) => async () => {
      const row = await base.findOne<{ updatedAt: string }>({
        model,
        where: [{ field, operator: 'eq', value }],
        namespace: 'billfn'
      });
      // Another writer rewrites the row between this call's read and its write, keeping its state.
      await base.updateMany({
        model,
        where: [{ field, operator: 'eq', value }],
        data: {
          updatedAt: new Date(Date.parse(row!.updatedAt) + 1).toISOString(),
          ...(model === 'entitlementSnapshots' ? { sourceEventId: `${subscriptionId}@2026-11-01T00:00:00.000Z` } : {})
        },
        namespace: 'billfn'
      });
    };
    if (type === 'subscription.canceled') {
      faults.raceSubscription = bump('subscriptions', 'id', subscriptionId);
    } else {
      faults.raceSnapshot = bump('entitlementSnapshots', 'billingAccountId', ACCOUNT);
    }
    apply(env);
    env.advance(MINUTE);
    expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(true);
    expect(faults.raceSubscription ?? faults.raceSnapshot).toBeNull();

    env.advance(LEASE + MINUTE);
    await env.billfn.services.events.dispatch();
    expect(env.ofType(type).slice(before)).toHaveLength(1);
    const rows = (await env.rows()).filter((row) => row.type === type);
    expect(rows).toHaveLength(before + 1);
    expect(rows.every((row) => row.status === 'delivered')).toBe(true);
  });

  it('delivers nothing for a subscription write that failed, and the change once its retry applies', async () => {
    const { db, faults } = staging();
    const env = setup({ db });
    await env.subscribe();
    env.providerState.autoRenew = false;
    faults.subscriptionWrite = 'before';
    env.advance(MINUTE);
    expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(false);
    env.advance(LEASE + MINUTE);
    await env.billfn.services.events.dispatch();
    expect(env.ofType('subscription.canceled')).toEqual([]);
    expect((await env.rows()).filter((row) => row.type === 'subscription.canceled').map((row) => row.status)).toEqual(['staged']);

    expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(true);
    expect(env.ofType('subscription.canceled')).toHaveLength(1);
  });

  it.each([
    ['before', 'never delivers the staged event of a write a stop interrupted before it applied, and deletes it a day later', 0],
    ['after', 'delivers the staged event of a write a stop interrupted after it applied, once', 1]
  ] as const)('%s: %s', async (stop, _title, deliveries) => {
    const { db, faults } = staging();
    const env = setup({ db });
    const { subscriptionId } = await env.subscribe();
    env.providerState.autoRenew = false;
    faults.subscriptionWrite = stop;
    faults.release = true;
    env.advance(MINUTE);
    expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(false);
    faults.release = false;
    expect((await env.rows()).filter((row) => row.status === 'staged')).toEqual([
      expect.objectContaining({ type: 'subscription.canceled' })
    ]);

    // A staged event is not delivered while its write may still apply.
    await env.billfn.services.events.dispatch();
    expect(env.ofType('subscription.canceled')).toEqual([]);

    // Once its stage lapsed, a dispatch checks it against the stored subscription.
    env.advance(LEASE + MINUTE);
    await env.billfn.services.events.dispatch();
    expect(env.ofType('subscription.canceled')).toHaveLength(deliveries);
    // One no write names stays staged, undelivered, while its write may still apply, then is deleted.
    expect((await env.rows()).filter((row) => row.status === 'staged')).toHaveLength(1 - deliveries);
    env.advance(DAY);
    await env.billfn.services.events.dispatch();
    expect(env.ofType('subscription.canceled')).toHaveLength(deliveries);
    expect((await env.rows()).filter((row) => row.status === 'staged')).toEqual([]);

    // A later sync applies a change the stop left out, and adds nothing twice.
    env.advance(MINUTE);
    expect(await env.syncJob(subscriptionId)).toBe('succeeded');
    env.advance(LEASE + MINUTE);
    await env.billfn.services.events.dispatch();
    expect(env.ofType('subscription.canceled')).toHaveLength(1);
  });

  describe('the lifecycle-events job records the missing events of a committed grant change without account traffic', () => {
    const grantEvents = (env: ReturnType<typeof setup>) =>
      env.delivered.filter((event) => event.type === 'grant.started' || event.data.cause !== 'subscription');

    it.each([
      ['its lifecycle event writes fail', ['create']],
      ['process stops right after the grant write', ['create', 'billingEvent']]
    ] as const)('a trial whose %s: grant.started and entitlement.changed once each', async (_name, faulted) => {
      const { db, faults } = staging();
      const env = setup({ db });
      for (const fault of faulted) faults[fault] = true;
      const created = await env.trial(14 * DAY);
      for (const fault of faulted) faults[fault] = false;
      if (!created.ok) throw new Error('expected the grant to commit');
      const grantId = created.data.grant.id;
      expect(grantEvents(env)).toEqual([]);

      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(grantEvents(env).map((event) => [event.type, event.data.grantId])).toEqual([
        ['grant.started', grantId],
        ['entitlement.changed', grantId]
      ]);
      const billing = await db.findMany<{ type: string }>({ model: 'billingEvents', namespace: 'billfn' });
      expect(billing.filter((event) => event.type === 'billfn.grant.created')).toHaveLength(1);

      // A second run adds nothing.
      const rows = (await env.rows()).length;
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(grantEvents(env)).toHaveLength(2);
      expect(await env.rows()).toHaveLength(rows);
    });

    it("a comp revocation whose lifecycle event write fails: its entitlement.changed once", async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      const comp = await env.billfn.services.grants.create({
        billingAccountId: ACCOUNT,
        subject: env.subject,
        planKey: 'nucleus',
        kind: 'comp',
        expiresAt: new Date(env.clock.current.getTime() + 30 * DAY).toISOString()
      });
      if (!comp.ok) throw new Error('expected grant');
      env.advance(MINUTE);
      faults.create = true;
      const revoked = await env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: comp.data.grant.id });
      faults.create = false;
      expect(revoked.ok).toBe(true);
      const revocations = () => env.ofType('entitlement.changed').filter((event) => event.data.cause === 'grant.revoked');
      expect(revocations()).toEqual([]);

      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(revocations()).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ grantId: comp.data.grant.id, status: 'inactive' }) })
      ]);
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(revocations()).toHaveLength(1);
    });

    /** Counts grant and billing event reads, and fails a grant query on neither account nor expiry while `failScan` is on. */
    function countingGrantReads(db: Adapter) {
      const reads = { count: 0, failScan: false, failExpiry: false, hangExpiry: false, maxIn: 0, onExpiry: () => {} };
      const counting: Adapter = {
        ...db,
        async findMany<T>(params: Parameters<Adapter['findMany']>[0]) {
          if (params.model === 'entitlementGrants' || params.model === 'billingEvents') reads.count += 1;
          for (const clause of params.where ?? []) {
            if (clause.operator === 'in') reads.maxIn = Math.max(reads.maxIn, (clause.value as unknown[]).length);
          }
          const expiry = params.where?.some((clause) => clause.field === 'expiresAt');
          const scan = !expiry && !params.where?.some((clause) => clause.field === 'billingAccountId');
          if (reads.failScan && params.model === 'entitlementGrants' && scan) throw new Error('query limit');
          if (params.model === 'entitlementGrants' && expiry && (reads.failExpiry || reads.hangExpiry)) {
            reads.onExpiry();
            if (reads.hangExpiry) return new Promise<T[]>(() => {});
            throw new Error('query limit');
          }
          return db.findMany<T>(params);
        }
      };
      return { counting, reads };
    }
    const signup = (env: ReturnType<typeof setup>, n: number, expiresInMs = 14 * DAY) =>
      env.billfn.services.grants.create({
        billingAccountId: `ba_user_signup_${n}`,
        subject: { principalId: `signup_${n}` },
        planKey: 'nucleus',
        kind: 'trial',
        expiresAt: new Date(env.clock.current.getTime() + expiresInMs).toISOString()
      });
    const started = (env: ReturnType<typeof setup>) => env.ofType('grant.started').map((event) => event.data.grantId);

    it('reads only the grant changes that lack events, also one made more than 7 days earlier', async () => {
      const { db, faults } = staging();
      const { counting, reads } = countingGrantReads(db);
      const env = setup({ db: counting });
      faults.create = true;
      const lost = await env.trial(14 * DAY);
      faults.create = false;
      if (!lost.ok) throw new Error('expected the grant to commit');
      expect(lost.data.grant).not.toHaveProperty('eventsPending');
      env.advance(8 * DAY);
      for (let n = 0; n < 60; n += 1) expect((await signup(env, n)).ok).toBe(true);
      expect(started(env)).toHaveLength(60);

      reads.count = 0;
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(started(env).filter((grantId) => grantId === lost.data.grant.id)).toHaveLength(1);
      // The pending-grant query, the expiry query and one account's repair, not a read per recent signup.
      expect(reads.count).toBeLessThanOrEqual(5);
      reads.count = 0;
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(started(env)).toHaveLength(61);
      // The pending-grant query and one query per expiry sweep (expired, expiring), each finding nothing.
      expect(reads.count).toBeLessThanOrEqual(3);
    });

    it('a failed expiry sweep still lets the run deliver a due event, and a later run records grant.expiring', async () => {
      const { db } = staging();
      const { counting, reads } = countingGrantReads(db);
      let failing = true;
      const env = setup({
        db: counting,
        onEvent: (event) => {
          if (failing) throw new Error('mail provider down');
          env.delivered.push(event);
        }
      });
      // Not within 3 days at creation (that grant gets grant.expiring with it), but within the first run's sweep.
      expect((await env.trial(3 * DAY + 30 * MINUTE)).ok).toBe(true);
      failing = false;
      reads.failExpiry = true;
      env.advance(HOUR_MS);
      expect((await env.runLifecycleJob()).status).toBe('succeeded');
      expect(started(env)).toHaveLength(1);
      expect(env.ofType('grant.expiring')).toEqual([]);
      reads.failExpiry = false;
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(env.ofType('grant.expiring')).toHaveLength(1);
    });

    // A trial whose grant.started delivery failed once and is due again an hour later.
    async function dueRetry(adapter: (counting: Adapter) => Adapter = (counting) => counting) {
      const { db } = staging();
      const { counting, reads } = countingGrantReads(db);
      let failing = true;
      const env = setup({
        db: adapter(counting),
        onEvent: (event) => {
          if (failing) throw new Error('mail provider down');
          env.delivered.push(event);
        }
      });
      expect((await env.trial(2 * DAY)).ok).toBe(true);
      failing = false;
      env.advance(HOUR_MS);
      return { env, reads };
    }

    it('a sweep whose query never settles: the run has delivered the due event before it', async () => {
      const { env, reads } = await dueRetry();
      reads.hangExpiry = true;
      const sweepStarted = new Promise<void>((resolve) => {
        reads.onExpiry = resolve;
      });
      void env.runLifecycleJob().catch(() => undefined);
      await sweepStarted;
      expect(started(env)).toHaveLength(1);
    });

    it('a sweep that uses up the query budget, failing every later call: the run has delivered the due event', async () => {
      const budget = { exhausted: false };
      const limited = (counting: Adapter) =>
        new Proxy(counting, {
          get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) =>
              budget.exhausted ? Promise.reject(new Error('too many queries')) : value.apply(target, args);
          }
        });
      const { env, reads } = await dueRetry(limited);
      reads.failExpiry = true;
      reads.onExpiry = () => {
        budget.exhausted = true;
      };
      await env.runLifecycleJob().catch(() => undefined);
      expect(started(env)).toHaveLength(1);
    });

    it('a revoke whose repair cannot record the comp creation keeps the flag, so the job records it once', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      faults.create = true;
      faults.billingEvent = true;
      const comp = await env.billfn.services.grants.create({
        billingAccountId: ACCOUNT,
        subject: env.subject,
        planKey: 'nucleus',
        kind: 'comp',
        expiresAt: new Date(env.clock.current.getTime() + 30 * DAY).toISOString()
      });
      faults.create = false;
      faults.billingEvent = false;
      if (!comp.ok) throw new Error('expected the grant to commit');
      const grantId = comp.data.grant.id;
      // Only the creation's writes fail during the revoke; its revocation event is recorded.
      faults.failCreate = (model, data) =>
        (model === 'billingEvents' && data.type === 'billfn.grant.created') ||
        (model === 'lifecycleEvents' && (data.type === 'grant.started' || data.data?.cause === 'grant.started'));
      env.advance(MINUTE);
      expect((await env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId })).ok).toBe(true);
      faults.failCreate = null;
      const [stored] = await db.findMany<{ eventsPending?: boolean }>({ model: 'entitlementGrants', namespace: 'billfn' });
      expect(stored?.eventsPending).toBe(true);
      expect(started(env)).toEqual([]);

      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(env.delivered.map((event) => [event.type, event.data.grantId, (event.data as { cause?: string }).cause])).toEqual([
        ['entitlement.changed', grantId, 'grant.revoked'],
        ['grant.started', grantId, undefined],
        ['entitlement.changed', grantId, 'grant.started']
      ]);
      const [cleared] = await db.findMany<{ eventsPending?: boolean }>({ model: 'entitlementGrants', namespace: 'billfn' });
      expect(cleared?.eventsPending).toBe(false);
    });

    it('without onEvent, a grant write leaves eventsPending unset (a schema 5 table still takes it)', async () => {
      const { db } = staging();
      const env = setup({ db, onEvent: null });
      expect((await env.trial(14 * DAY)).ok).toBe(true);
      const [stored] = await db.findMany({ model: 'entitlementGrants', namespace: 'billfn' });
      expect(stored).not.toHaveProperty('eventsPending');
    });

    it('repairs a bounded batch per run, and a failed repair still records grant.expiring and dispatches', async () => {
      const { db, faults } = staging();
      const { counting, reads } = countingGrantReads(db);
      const env = setup({ db: counting });
      faults.create = true;
      for (let n = 0; n < 60; n += 1) expect((await signup(env, n, 2 * DAY)).ok).toBe(true);
      faults.create = false;
      expect(env.delivered).toEqual([]);

      reads.failScan = true;
      env.advance(HOUR_MS);
      expect((await env.runLifecycleJob()).status).toBe('succeeded');
      expect(env.ofType('grant.expiring')).toHaveLength(60);
      expect(started(env)).toEqual([]);
      // No id list over 50 values (D1 binds at most 100 parameters).
      expect(reads.maxIn).toBeGreaterThan(0);
      expect(reads.maxIn).toBeLessThanOrEqual(50);

      reads.failScan = false;
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(started(env)).toHaveLength(50);
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(new Set(started(env)).size).toBe(60);
      expect(started(env)).toHaveLength(60);
    });
  });

  it('gives an event promoted late in its stage window the full 24-hour delivery window', async () => {
    const { db, faults } = staging();
    const delivered: BillFnLifecycleEvent[] = [];
    let failing = false;
    const env = setup({
      db,
      onEvent: (event) => {
        if (failing) throw new Error('handler down');
        delivered.push(event);
      }
    });
    const { subscriptionId } = await env.subscribe();
    let resume!: () => void;
    faults.pauseSnapshot = new Promise<void>((resolve) => (resume = resolve));
    faults.snapshotWrite = 'after';
    env.providerState.status = 'expired';
    env.advance(MINUTE);
    const sync = env.syncJob(subscriptionId);
    await vi.waitFor(() => expect(faults.pauseSnapshot).toBeNull());

    // The write applies 23 hours into its stage window, and is promoted by a dispatch while the handler is down.
    env.advance(23 * HOUR_MS);
    resume();
    expect(await sync).not.toBe('succeeded');
    failing = true;
    env.advance(2 * HOUR_MS);
    await env.billfn.services.events.dispatch();
    const [promoted] = (await env.rows()).filter((row) => row.type === 'entitlement.changed' && row.status !== 'delivered');
    expect(promoted).toMatchObject({ status: 'pending', attempts: 1 });

    failing = false;
    env.advance(HOUR_MS);
    await env.billfn.services.events.dispatch();
    expect(delivered.filter((event) => event.id === promoted!.id)).toHaveLength(1);
  });

  describe('a staged event is settled by whether a write naming it applied, not by the state a later write left', () => {
    /** Runs a sync whose subscription write fails `stop` it applies, with the process stopped before it settles its events. */
    async function interruptedSync(env: ReturnType<typeof setup>, faults: ReturnType<typeof staging>['faults'], stop: 'before' | 'after') {
      faults.subscriptionWrite = stop;
      faults.release = true;
      env.advance(MINUTE);
      const ok = await succeeded(env.billfn.syncSubscription({ subject: env.subject }));
      faults.release = false;
      expect(ok).toBe(false);
    }

    /** Dispatches once the stages lapsed, then once those no write names were dropped, a day later. */
    async function afterLease(env: ReturnType<typeof setup>) {
      env.advance(LEASE + MINUTE);
      await env.billfn.services.events.dispatch();
      expect((await env.rows()).filter((row) => row.status === 'pending' || row.status === 'failed')).toEqual([]);
      env.advance(DAY);
      await env.billfn.services.events.dispatch();
      expect((await env.rows()).filter((row) => row.status !== 'delivered')).toEqual([]);
    }

    it('delivers an entitlement change once under its id when its write stalls past the lease, then applies and fails', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      const { subscriptionId } = await env.subscribe();
      let resume!: () => void;
      faults.pauseSnapshot = new Promise<void>((resolve) => (resume = resolve));
      faults.snapshotWrite = 'after';
      env.providerState.status = 'expired';
      env.advance(MINUTE);
      const sync = env.syncJob(subscriptionId);
      await vi.waitFor(() => expect(faults.pauseSnapshot).toBeNull());

      // A dispatch checks the lapsed stage while the write stalls: no row names it yet, so it is kept, not delivered.
      env.advance(LEASE + MINUTE);
      await env.billfn.services.events.dispatch();
      const [staged] = (await env.rows()).filter((row) => row.status === 'staged');
      expect(staged).toMatchObject({ type: 'entitlement.changed' });
      expect(env.ofType('entitlement.changed').map((event) => event.data.status)).toEqual(['active']);

      // The write applies and then fails, so nothing confirms its event; a later dispatch finds the marker.
      resume();
      expect(await sync).not.toBe('succeeded');
      env.advance(LEASE + MINUTE);
      await env.billfn.services.events.dispatch();
      expect(env.ofType('entitlement.changed').slice(1)).toEqual([
        expect.objectContaining({ id: staged!.id, data: expect.objectContaining({ status: 'inactive' }) })
      ]);
      await afterLease(env);
      expect(env.ofType('entitlement.changed')).toHaveLength(2);
    });

    it('delivers a cancellation whose write applied and then failed, once, after its retry found nothing to change', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      await env.subscribe();
      expect(env.ofType('checkout.completed')).toHaveLength(1);
      env.providerState.autoRenew = false;
      faults.subscriptionWrite = 'after';
      env.advance(MINUTE);
      expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(false);
      env.advance(MINUTE);
      expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(true);
      await afterLease(env);
      expect(env.ofType('subscription.canceled')).toHaveLength(1);
      expect(env.ofType('checkout.completed')).toHaveLength(1);
    });

    it('delivers a cancellation that applied before a stop, though a resume within the lease renews again', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      await env.subscribe();
      env.providerState.autoRenew = false;
      await interruptedSync(env, faults, 'after');
      env.providerState.autoRenew = true;
      env.advance(MINUTE);
      expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(true);
      await afterLease(env);
      expect(env.ofType('subscription.canceled')).toHaveLength(1);
    });

    it('delivers no cancellation a stop kept from applying, though the subscription then stops renewing by expiring', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      await env.subscribe();
      env.providerState.autoRenew = false;
      await interruptedSync(env, faults, 'before');
      env.providerState.status = 'expired';
      env.advance(MINUTE);
      expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(true);
      await afterLease(env);
      expect(env.ofType('subscription.canceled')).toEqual([]);
      expect(env.ofType('entitlement.changed').map((event) => event.data.status)).toEqual(['active', 'inactive']);
    });

    it('delivers a cancellation once under one id when a failed write left its stage and a later call applies it', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      await env.subscribe();
      env.providerState.autoRenew = false;
      await interruptedSync(env, faults, 'before');
      env.advance(MINUTE);
      expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(true);
      await afterLease(env);
      expect(env.ofType('subscription.canceled')).toHaveLength(1);
      expect((await env.rows()).filter((row) => row.type === 'subscription.canceled')).toHaveLength(1);
    });

    it('delivers each entitlement change once when a later change replaces a snapshot whose write applied before a stop', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      const { subscriptionId } = await env.subscribe();
      env.providerState.status = 'expired';
      faults.snapshotWrite = 'after';
      faults.release = true;
      env.advance(MINUTE);
      expect(await env.syncJob(subscriptionId)).not.toBe('succeeded');
      faults.release = false;
      env.providerState.status = 'active';
      env.providerState.periodEnd = '2027-01-10T00:00:00.000Z';
      env.advance(MINUTE);
      expect(await env.syncJob(subscriptionId)).toBe('succeeded');
      await afterLease(env);
      expect(env.ofType('entitlement.changed').map((event) => event.data.status)).toEqual(['active', 'inactive', 'active']);
    });

    it('delivers an entitlement change once under one id when a failed snapshot write left its stage and a later call applies it', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      const { subscriptionId } = await env.subscribe();
      env.providerState.status = 'expired';
      faults.snapshot = true;
      faults.release = true;
      env.advance(MINUTE);
      expect(await env.syncJob(subscriptionId)).not.toBe('succeeded');
      faults.snapshot = false;
      faults.release = false;
      env.advance(MINUTE);
      expect(await env.syncJob(subscriptionId)).toBe('succeeded');
      await afterLease(env);
      expect(env.ofType('entitlement.changed').map((event) => event.data.status)).toEqual(['active', 'inactive']);
      expect((await env.rows()).filter((row) => row.type === 'entitlement.changed')).toHaveLength(2);
    });

    it('delivers a cancellation once when a racing call stages it again and loses to the write that applied it before a stop', async () => {
      const { db, faults } = staging();
      const env = setup({ db });
      await env.subscribe();
      env.providerState.autoRenew = false;
      env.advance(MINUTE);
      // Between this call's read and its stage, another call at the same instant applies the same change and stops.
      faults.raceStage = async () => {
        faults.subscriptionWrite = 'after';
        faults.release = true;
        expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(false);
        faults.release = false;
      };
      expect(await succeeded(env.billfn.syncSubscription({ subject: env.subject }))).toBe(true);
      expect(faults.raceStage).toBeNull();
      await afterLease(env);
      expect(env.ofType('subscription.canceled')).toHaveLength(1);
    });
  });

  it('delivers the payload of the write that applied when a racing write of the same change with another payload loses', async () => {
    const { db, faults } = staging();
    const env = setup({ db });
    const { subscriptionId } = await env.subscribe();
    env.providerState.periodEnd = '2027-01-10T00:00:00.000Z';
    env.providerState.periodStart = '2026-12-10T00:00:00.000Z';
    let finishWinner = () => {};
    const winnerDone = new Promise<void>((resolve) => (finishWinner = resolve));
    let loser: Promise<string> | undefined;
    // After the winner staged its renewal and before it writes, the loser (whose provider read saw another period
    // start) reads the same row and stages the same renewal; its write waits until the winner's call is done.
    faults.raceSubscription = async () => {
      env.providerState.periodStart = '2026-12-09T00:00:00.000Z';
      let reachedWrite = () => {};
      const atWrite = new Promise<void>((resolve) => (reachedWrite = resolve));
      faults.raceSubscription = async () => {
        reachedWrite();
        await winnerDone;
      };
      loser = env.syncJob(subscriptionId);
      await atWrite;
    };
    const winner = await env.syncJob(subscriptionId);
    finishWinner();
    await loser;
    expect(winner).toBe('succeeded');

    expect(env.ofType('subscription.renewed').map((event) => event.data)).toEqual([
      expect.objectContaining({ currentPeriodStart: '2026-12-10T00:00:00.000Z', currentPeriodEnd: '2027-01-10T00:00:00.000Z' })
    ]);
    env.advance(DAY + HOUR_MS);
    await env.runLifecycleJob();
    expect(env.ofType('subscription.renewed')).toHaveLength(1);
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

  it('marks an event failed once its delivery never completed for 24 hours, without calling the handler again', async () => {
    const { db, faults } = faultyLifecycleDb();
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    const calls: { id: string; at: number }[] = [];
    const env = setup({
      db,
      clock,
      onEvent: (event) => {
        calls.push({ id: event.id, at: clock.current.getTime() });
      }
    });
    // Every dispatcher stops after calling the handler and before settling, so each claim lapses.
    faults.settle = true;
    await env.trial(14 * DAY);
    const recorded = await env.rows();
    expect(recorded).toHaveLength(2);
    const deadline = Date.parse(recorded[0]!.createdAt) + DAY;
    for (let pass = 0; pass < 320; pass += 1) {
      env.advance(LIFECYCLE_CLAIM_LEASE_MS);
      await env.billfn.services.events.dispatch().catch(() => undefined);
      if (clock.current.getTime() < deadline) {
        expect((await env.rows()).map((row) => row.status)).toEqual(['pending', 'pending']);
      }
    }
    const failed = await env.billfn.services.events.list({ status: 'failed' });
    expect(failed).toHaveLength(2);
    for (const row of failed) {
      expect(row.lastError).toBe('delivery did not complete');
      expect(Date.parse(row.failedAt!)).toBeGreaterThanOrEqual(deadline);
      // The last retry slot is the deadline, where the dispatch marks it failed instead of calling the handler.
      expect(Date.parse(row.failedAt!)).toBeLessThanOrEqual(deadline + 3 * LIFECYCLE_CLAIM_LEASE_MS);
      const own = calls.filter((call) => call.id === row.id);
      expect(own.filter((call) => call.at >= deadline)).toEqual([]);
      // A lapsed claim is a failed attempt, so retries back off instead of running every lease.
      expect(own.length).toBeLessThan(40);
    }
  });

  it('bounds a handler that never settles by the claim lease, so a job run completes and the event ends failed', async () => {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    const writer = setup({
      db,
      clock,
      onEvent: () => {
        throw new Error('not yet');
      }
    });
    await writer.trial(14 * DAY);
    const deadline = Date.parse((await writer.rows())[0]!.createdAt) + DAY;
    const calls: number[] = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const hanging = setup({
        db,
        clock,
        onEvent: () => {
          calls.push(clock.current.getTime());
          return new Promise<void>(() => undefined);
        }
      });
      hanging.advance(MINUTE);
      const job = hanging.runLifecycleJob();
      await vi.advanceTimersByTimeAsync(3 * LIFECYCLE_CLAIM_LEASE_MS);
      expect((await job).status).toBe('succeeded');
      expect(calls).toHaveLength(2);
      for (let pass = 0; pass < 300; pass += 1) {
        hanging.advance(LIFECYCLE_CLAIM_LEASE_MS);
        const run = hanging.billfn.services.events.dispatch();
        await vi.advanceTimersByTimeAsync(3 * LIFECYCLE_CLAIM_LEASE_MS);
        await run;
      }
      const failed = await hanging.billfn.services.events.list({ status: 'failed' });
      expect(failed).toHaveLength(2);
      for (const row of failed) {
        expect(row.lastError).toBe('handler did not settle within the claim lease');
        expect(Date.parse(row.failedAt!) - deadline).toBeLessThanOrEqual(LIFECYCLE_CLAIM_LEASE_MS);
      }
      expect(calls.filter((at) => at >= deadline)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks an event whose claim lapsed after the delivery window failed once when two dispatchers race on it', async () => {
    const { db, faults } = faultyLifecycleDb();
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    const stopped = setup({ db, clock });
    faults.settle = true;
    await stopped.trial(14 * DAY);
    expect(stopped.delivered).toHaveLength(2);
    faults.settle = false;

    clock.current = new Date(clock.current.getTime() + DAY + MINUTE);
    const first = setup({ db, clock });
    const second = setup({ db, clock });
    const [left, right] = await Promise.all([first.billfn.services.events.dispatch(), second.billfn.services.events.dispatch()]);
    expect(left.failed + right.failed).toBe(2);
    expect(left.delivered + right.delivered).toBe(0);
    expect([...first.delivered, ...second.delivered]).toEqual([]);
    const rows = await first.rows();
    expect(rows.map((row) => [row.status, row.lastError, row.attempts, row.claimId])).toEqual([
      ['failed', 'delivery did not complete', 1, null],
      ['failed', 'delivery did not complete', 1, null]
    ]);
  });

  it.each([
    ['just before', -1, { delivered: 2, retrying: 0, failed: 0 }],
    ['at', 0, { delivered: 0, retrying: 0, failed: 2 }],
    ['after', MINUTE, { delivered: 0, retrying: 0, failed: 2 }]
  ])('settles a pending unclaimed event due %s its delivery deadline without calling the handler after it', async (_when, offset, outcome) => {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    const writer = setup({
      db,
      clock,
      onEvent: () => {
        throw new Error('not yet');
      }
    });
    await writer.trial(14 * DAY);
    const recorded = await writer.rows();
    expect(recorded.map((row) => [row.status, row.attempts, row.claimId])).toEqual([
      ['pending', 1, null],
      ['pending', 1, null]
    ]);
    clock.current = new Date(Date.parse(recorded[0]!.createdAt) + DAY + offset);
    const env = setup({ db, clock });
    await expect(env.billfn.services.events.dispatch()).resolves.toEqual(outcome);
    if (outcome.delivered > 0) {
      expect(env.delivered).toHaveLength(2);
      return;
    }
    expect(env.delivered).toEqual([]);
    const failed = await env.billfn.services.events.list({ status: 'failed' });
    expect(failed.map((row) => [row.lastError, row.attempts, row.claimId, row.failedAt])).toEqual([
      ['not yet', 1, null, clock.current.toISOString()],
      ['not yet', 1, null, clock.current.toISOString()]
    ]);
    await expect(env.billfn.services.events.dispatch()).resolves.toEqual({ delivered: 0, retrying: 0, failed: 0 });
  });

  it.each([
    ['delivers', false, { delivered: 2, retrying: 0, failed: 0 }, 'delivered'],
    ['marks failed after one failed attempt', true, { delivered: 0, retrying: 0, failed: 2 }, 'failed']
  ])('%s an event never attempted (a crash before its dispatch) first dispatched after its delivery deadline', async (_label, failing, outcome, status) => {
    const { db, faults } = faultyLifecycleDb();
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    const crashed = setup({ db, clock });
    faults.update = true;
    await crashed.trial(14 * DAY);
    expect((await crashed.rows()).map((row) => [row.status, row.attempts])).toEqual([
      ['pending', 0],
      ['pending', 0]
    ]);
    faults.update = false;
    clock.current = new Date(clock.current.getTime() + DAY + MINUTE);
    const calls: string[] = [];
    const restarted = setup({
      db,
      clock,
      onEvent: (event) => {
        calls.push(event.id);
        if (failing) {
          throw new Error('handler down');
        }
      }
    });
    await expect(restarted.billfn.services.events.dispatch()).resolves.toEqual(outcome);
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
    expect((await restarted.rows()).map((row) => [row.status, row.attempts])).toEqual([
      [status, 1],
      [status, 1]
    ]);
  });

  it('marks an unclaimed event past its delivery deadline failed once when two dispatchers race on it', async () => {
    const db = memoryAdapter({ debug: false });
    const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
    const writer = setup({
      db,
      clock,
      onEvent: () => {
        throw new Error('not yet');
      }
    });
    await writer.trial(14 * DAY);
    clock.current = new Date(clock.current.getTime() + DAY + MINUTE);
    const first = setup({ db, clock });
    const second = setup({ db, clock });
    const [left, right] = await Promise.all([first.billfn.services.events.dispatch(), second.billfn.services.events.dispatch()]);
    expect(left.failed + right.failed).toBe(2);
    expect(left.delivered + right.delivered + left.retrying + right.retrying).toBe(0);
    expect([...first.delivered, ...second.delivered]).toEqual([]);
    expect((await first.rows()).map((row) => [row.status, row.lastError, row.attempts])).toEqual([
      ['failed', 'not yet', 1],
      ['failed', 'not yet', 1]
    ]);
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


describe('the lifecycle-events job does bounded work that resumes where the previous run stopped', () => {
  const T0 = '2026-11-10T00:00:00.000Z';

  /** A comp stored directly (as an earlier BillFn write left it), one per account. */
  function grantRow(n: number, expiresAt: string, extra: Record<string, unknown> = {}) {
    return {
      id: `grant_comp_ba_bulk_${String(n).padStart(5, '0')}_1`,
      billingAccountId: `ba_bulk_${n}`,
      planKey: 'nucleus',
      kind: 'comp',
      startsAt: T0,
      expiresAt,
      revokedAt: null,
      operator: null,
      reason: null,
      revokedBy: null,
      revokeReason: null,
      createdAt: T0,
      updatedAt: T0,
      ...extra
    };
  }

  async function insertGrants(db: Adapter, rows: Record<string, unknown>[]) {
    for (const data of rows) await db.create({ model: 'entitlementGrants', data, namespace: 'billfn' });
  }

  /** Records the ids of the grants each expiry query returns. */
  function trackingSweepReads(db: Adapter) {
    const reads: string[] = [];
    const tracking: Adapter = {
      ...db,
      async findMany<T>(params: Parameters<Adapter['findMany']>[0]) {
        const rows = await db.findMany<T>(params);
        if (params.model === 'entitlementGrants' && params.where?.some((clause) => clause.field === 'expiresAt')) {
          reads.push(...rows.map((row) => (row as { id: string }).id));
        }
        return rows;
      }
    };
    return { tracking, reads };
  }

  const adapters = [
    ['with transactions', () => faultyLifecycleDb()],
    ['without transactions', () => faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions: false })]
  ] as const;

  describe.each(adapters)('%s', (_name, makeDb) => {
    // Ties on expiresAt cross page boundaries, so the position must hold the id as well as the time.
    it.each([
      ['grant.expiring', DAY, (event: BillFnLifecycleEvent) => event.type === 'grant.expiring'],
      [
        'entitlement.changed (grant.expired)',
        -DAY,
        (event: BillFnLifecycleEvent) => event.type === 'entitlement.changed' && event.data.cause === 'grant.expired'
      ]
    ] as const)(
      '%s: consecutive runs each read new grants past the per-run cap, never one a run finished, and dispatch every run',
      async (_type, offset, matches) => {
        const { db } = makeDb();
        const { tracking, reads } = trackingSweepReads(db);
        const env = setup({ db: tracking });
        const count = GRANT_SWEEP_RUN_LIMIT + 30;
        const at = (n: number) => new Date(env.clock.current.getTime() + offset + (n % 7) * MINUTE).toISOString();
        await insertGrants(db, Array.from({ length: count }, (_, n) => grantRow(n, at(n))));
        const deliveredGrants = () => env.delivered.filter(matches).map((event) => event.data.grantId);

        const runs: string[][] = [];
        for (let run = 0; run < 3; run += 1) {
          reads.length = 0;
          env.advance(MINUTE);
          expect((await env.runLifecycleJob()).status).toBe('succeeded');
          runs.push([...reads]);
        }
        // A run reads its own pages again once past them (for writes landing late), never another run's: at most
        // twice the cap.
        expect(runs.map((ids) => ids.length)).toEqual([2 * GRANT_SWEEP_RUN_LIMIT, 60, 0]);
        expect(runs.map((ids) => new Set(ids).size)).toEqual([GRANT_SWEEP_RUN_LIMIT, 30, 0]);
        expect(runs[1]!.filter((id) => runs[0]!.includes(id))).toEqual([]);
        expect(new Set([...runs[0]!, ...runs[1]!]).size).toBe(count);
        // Each run's events were delivered by that run's dispatch, each grant's once.
        expect(deliveredGrants()).toHaveLength(count);
        expect(new Set(deliveredGrants()).size).toBe(count);
      }
    );

    it('a run that stops mid-sweep: the next resumes after the last page it finished, recording each event once', async () => {
      const { db, faults } = makeDb();
      const { tracking, reads } = trackingSweepReads(db);
      const env = setup({ db: tracking });
      const at = (n: number) => new Date(env.clock.current.getTime() + DAY + (n % 3) * MINUTE).toISOString();
      const rows = Array.from({ length: 120 }, (_, n) => grantRow(n, at(n)));
      await insertGrants(db, rows);
      let created = 0;
      // The outbox write of the 60th event fails: the second page stops after 9 of its events.
      faults.failCreate = (model) => model === 'lifecycleEvents' && ++created === 60;
      expect((await env.runLifecycleJob()).status).toBe('succeeded');
      faults.failCreate = null;
      const firstPage = reads.slice(0, 50);
      expect(env.ofType('grant.expiring')).toHaveLength(59);

      reads.length = 0;
      env.advance(MINUTE);
      await env.runLifecycleJob();
      expect(reads.filter((id) => firstPage.includes(id))).toEqual([]);
      const expiring = env.ofType('grant.expiring').map((event) => event.data.grantId);
      expect(expiring).toHaveLength(120);
      expect(new Set(expiring)).toEqual(new Set(rows.map((row) => row.id)));
    });

    it('two runs racing over the same position record each event once, and a later run resumes after both', async () => {
      const { db } = makeDb();
      const { tracking, reads } = trackingSweepReads(db);
      const env = setup({ db: tracking });
      const at = (n: number) => new Date(env.clock.current.getTime() + DAY + (n % 5) * MINUTE).toISOString();
      await insertGrants(db, Array.from({ length: 120 }, (_, n) => grantRow(n, at(n))));
      const enqueue = async () => {
        const enqueued = await env.billfn.enqueueReconciliationJob({ kind: 'lifecycle-events' });
        if (!enqueued.ok) throw new Error('expected job');
        return env.billfn.runReconciliationJob({ jobId: enqueued.data.job.id });
      };
      await Promise.all([enqueue(), enqueue()]);
      reads.length = 0;
      env.advance(MINUTE);
      await env.runLifecycleJob();
      const expiring = env.ofType('grant.expiring').map((event) => event.data.grantId);
      expect(expiring).toHaveLength(120);
      expect(new Set(expiring).size).toBe(120);
      expect(reads).toEqual([]);
    });

    it('a grant created already within 3 days of expiry gets grant.expiring with its creation, behind the sweep', async () => {
      const { db } = makeDb();
      const env = setup({ db });
      await insertGrants(db, [grantRow(1, new Date(env.clock.current.getTime() + 2 * DAY).toISOString())]);
      await env.runLifecycleJob();
      expect(env.ofType('grant.expiring')).toHaveLength(1);

      // Expires before the sweep's stored position, so no later run reads it.
      const trial = await env.trial(DAY);
      if (!trial.ok) throw new Error('expected grant');
      expect(env.ofType('grant.expiring').map((event) => event.data.grantId)).toEqual([
        'grant_comp_ba_bulk_00001_1',
        trial.data.grant.id
      ]);
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      expect(env.ofType('grant.expiring')).toHaveLength(2);
    });
  });

  describe('grant event repair without transactions', () => {
    function flaggedAccount(env: ReturnType<typeof setup>, pending: number, history: number) {
      const far = (days: number) => new Date(env.clock.current.getTime() + days * DAY).toISOString();
      return [
        // Ended long ago, outside both sweep windows, with nothing pending.
        ...Array.from({ length: history }, (_, n) => ({ ...grantRow(n, far(-30)), billingAccountId: ACCOUNT, eventsPending: false })),
        ...Array.from({ length: pending }, (_, n) => ({
          ...grantRow(history + n, far(60)),
          billingAccountId: ACCOUNT,
          eventsPending: true
        }))
      ];
    }

    it('with one account holding 5,000 grants and 3 pending, the job reads only the 3 pending grants', async () => {
      const { db } = faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions: false });
      let grantRows = 0;
      const counting: Adapter = {
        ...db,
        async findMany<T>(params: Parameters<Adapter['findMany']>[0]) {
          const rows = await db.findMany<T>(params);
          if (params.model === 'entitlementGrants') grantRows += rows.length;
          return rows;
        }
      };
      const env = setup({ db: counting });
      const rows = flaggedAccount(env, 3, 5000);
      await insertGrants(db, rows);
      await env.runLifecycleJob();
      expect(grantRows).toBe(3);
      expect(env.ofType('grant.started').map((event) => event.data.grantId).sort()).toEqual(
        rows.slice(5000).map((row) => row.id)
      );
      const flagged = await db.findMany({
        model: 'entitlementGrants',
        where: [{ field: 'eventsPending', operator: 'eq', value: true }],
        namespace: 'billfn'
      });
      expect(flagged).toEqual([]);
    });

    it('a short grant whose events a repair records only after it expired gets no grant.expiring', async () => {
      const { db, faults } = faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions: false });
      const env = setup({ db });
      faults.create = true;
      const trial = await env.trial(DAY);
      faults.create = false;
      if (!trial.ok) throw new Error('expected the grant to commit');
      env.advance(2 * DAY);
      await env.runLifecycleJob();
      expect(env.ofType('grant.started').map((event) => event.data.grantId)).toEqual([trial.data.grant.id]);
      expect(env.ofType('grant.expiring')).toEqual([]);
      expect(env.ofType('entitlement.changed').map((event) => event.data.cause)).toEqual(['grant.expired', 'grant.started']);
    });

    it.each([
      ['its first billing event', 'billingEvents'],
      // Mid-event: the grant.started row is written, its entitlement.changed and billing event are not yet.
      ['the first lifecycle row of its first event', 'lifecycleEvents']
    ])('of two concurrent repair runs, the one that lost its lease after %s writes nothing after the loss', async (_, stallModel) => {
      const { db } = faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions: false });
      const hooks = { afterFirstWrite: null as (() => Promise<void>) | null, lost: false };
      const writesAfterLoss: string[] = [];
      const note = (kind: string, model: string) => {
        if (hooks.lost && model !== 'reconciliationJobs') writesAfterLoss.push(`${kind} ${model}`);
      };
      const watched: Adapter = {
        ...db,
        async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
          note('create', params.model);
          const created = await db.create<T>(params);
          if (params.model === stallModel) {
            const hook = hooks.afterFirstWrite;
            hooks.afterFirstWrite = null;
            await hook?.();
          }
          return created;
        },
        async updateMany(params: Parameters<Adapter['updateMany']>[0]) {
          note('update', params.model);
          return db.updateMany(params);
        },
        async deleteMany(params: Parameters<Adapter['deleteMany']>[0]) {
          note('delete', params.model);
          return db.deleteMany(params);
        }
      };
      const env = setup({ db: watched });
      const rows = flaggedAccount(env, 3, 0);
      await insertGrants(db, rows);
      const enqueued = await env.billfn.enqueueReconciliationJob({ kind: 'lifecycle-events' });
      if (!enqueued.ok) throw new Error('expected job');
      const jobId = enqueued.data.job.id;
      // Run A stalls after its first repair write until its lease lapsed; run B takes the job over and completes it.
      let runB: Awaited<ReturnType<typeof env.billfn.runReconciliationJob>> | undefined;
      hooks.afterFirstWrite = async () => {
        env.advance(16 * MINUTE);
        runB = await env.billfn.runReconciliationJob({ jobId });
        hooks.lost = true;
      };
      const runA = await env.billfn.runReconciliationJob({ jobId }).catch((error: unknown) => error);
      expect(runB).toMatchObject({ ok: true, data: { job: { status: 'succeeded' } } });
      expect(runA).not.toMatchObject({ ok: true });
      expect(writesAfterLoss).toEqual([]);
      // B recorded what A left: each grant's events once.
      const started = env.ofType('grant.started').map((event) => event.data.grantId).sort();
      expect(started).toEqual(rows.map((row) => row.id));
      const billing = await db.findMany<{ type: string }>({ model: 'billingEvents', namespace: 'billfn' });
      expect(billing.filter((event) => event.type === 'billfn.grant.created')).toHaveLength(3);
      const lifecycle = await env.rows();
      expect(lifecycle.filter((event) => event.type === 'grant.started')).toHaveLength(3);
      expect(lifecycle.filter((event) => event.type === 'entitlement.changed')).toHaveLength(3);
    });

    const isCreationWrite = (model: string, data: Record<string, any>) =>
      (model === 'billingEvents' && data.type === 'billfn.grant.created') ||
      (model === 'lifecycleEvents' &&
        (data.type === 'grant.started' || data.type === 'grant.expiring' || data.data?.cause === 'grant.started'));

    it.each([
      [
        'the revoke itself, once its repair failed',
        (faults: ReturnType<typeof faultyLifecycleDb>['faults']) => {
          // Only the repair the revoke runs first fails; the creation event the revoke records after it commits applies.
          let failures = 1;
          faults.failCreate = (model, data) => isCreationWrite(model, data) && failures-- > 0;
        },
        async () => undefined
      ],
      [
        'the job',
        (faults: ReturnType<typeof faultyLifecycleDb>['faults']) => {
          faults.failCreate = isCreationWrite;
        },
        async (env: ReturnType<typeof setup>) => {
          await env.runLifecycleJob();
        }
      ],
      [
        'an entitlements read',
        (faults: ReturnType<typeof faultyLifecycleDb>['faults']) => {
          faults.failCreate = isCreationWrite;
        },
        async (env: ReturnType<typeof setup>) => {
          await env.billfn.getEntitlements(env.subject);
        }
      ]
    ])('a short comp revoked before its creation event was recorded gets no grant.expiring when %s records it', async (_, failDuringRevoke, repair) => {
      const { db, faults } = faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions: false });
      const env = setup({ db });
      faults.create = true;
      faults.billingEvent = true;
      const comp = await env.billfn.services.grants.create({
        billingAccountId: ACCOUNT,
        subject: env.subject,
        planKey: 'nucleus',
        kind: 'comp',
        expiresAt: new Date(env.clock.current.getTime() + 2 * DAY).toISOString()
      });
      faults.create = false;
      faults.billingEvent = false;
      if (!comp.ok) throw new Error('expected the grant to commit');
      const grantId = comp.data.grant.id;
      env.advance(MINUTE);
      failDuringRevoke(faults);
      expect((await env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId })).ok).toBe(true);
      faults.failCreate = null;
      await repair(env);
      env.advance(HOUR_MS);
      await env.runLifecycleJob();

      const rows = await env.rows();
      const summary = rows
        .filter((event) => event.billingAccountId === ACCOUNT)
        .map((event) => [event.type, (event.data as { cause?: string }).cause ?? null])
        .sort();
      expect(summary).toEqual([
        ['entitlement.changed', 'grant.revoked'],
        ['entitlement.changed', 'grant.started'],
        ['grant.started', null]
      ]);
      const [stored] = await db.findMany<{ eventsPending?: boolean }>({ model: 'entitlementGrants', namespace: 'billfn' });
      expect(stored?.eventsPending).toBe(false);
    });
  });
});

describe('a grant write landing after an expiry sweep passed it, or racing a revoke', () => {
  /**
   * Runs `beforeGrantInsert` before the next grant row is inserted (with transactions: before the next transaction
   * starts): the insert becomes visible only after it, as a write that lands late relative to its timestamp.
   */
  function delayedGrantDb(db: Adapter) {
    const hooks = { beforeGrantInsert: null as (() => Promise<void>) | null, failPositionCheck: false };
    const delay = <A extends Pick<Adapter, 'create'>>(adapter: A): A => ({
      ...adapter,
      async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
        if (params.model === 'entitlementGrants') {
          const hook = hooks.beforeGrantInsert;
          hooks.beforeGrantInsert = null;
          await hook?.();
        }
        return adapter.create<T>(params);
      }
    });
    const wrapped: Adapter = {
      ...delay(db),
      async findMany<T>(params: Parameters<Adapter['findMany']>[0]) {
        if (hooks.failPositionCheck && params.model === 'reconciliationCursors') {
          hooks.failPositionCheck = false;
          throw new Error('process stopped');
        }
        return db.findMany<T>(params);
      },
      // With transactions the grant's transaction starts only after the hook (its timestamp was taken before).
      async transaction<R>(callback: (transaction: TransactionAdapter) => Promise<R>): Promise<R> {
        const hook = hooks.beforeGrantInsert;
        hooks.beforeGrantInsert = null;
        await hook?.();
        return db.transaction((transaction) => callback(delay(transaction)));
      }
    };
    return { db: wrapped, hooks };
  }

  const otherRow = (id: string, expiresAt: string) => ({
    id,
    billingAccountId: 'ba_other',
    planKey: 'nucleus',
    kind: 'comp',
    startsAt: '2026-11-10T00:00:00.000Z',
    expiresAt,
    revokedAt: null,
    operator: null,
    reason: null,
    revokedBy: null,
    revokeReason: null,
    createdAt: '2026-11-10T00:00:00.000Z',
    updatedAt: '2026-11-10T00:00:00.000Z'
  });

  const adapters = [
    ['with transactions', () => faultyLifecycleDb()],
    ['without transactions', () => faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions: false })]
  ] as const;

  describe.each(adapters)('%s', (_name, makeDb) => {
    it('a trial whose insert lands after the expired sweep passed its expiry gets entitlement.changed (grant.expired)', async () => {
      const { db: base } = makeDb();
      const { db, hooks } = delayedGrantDb(base);
      const env = setup({ db });
      const t0 = env.clock.current.getTime();
      await base.create({ model: 'entitlementGrants', data: otherRow('grant_other_1', new Date(t0 + 5 * MINUTE).toISOString()), namespace: 'billfn' });
      hooks.beforeGrantInsert = async () => {
        env.advance(10 * MINUTE);
        await env.runLifecycleJob();
      };
      const trial = await env.trial(2 * MINUTE);
      if (!trial.ok) throw new Error('expected grant');
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      const expired = env
        .ofType('entitlement.changed')
        .filter((event) => event.data.cause === 'grant.expired')
        .map((event) => event.data.grantId);
      expect(expired.sort()).toEqual(['grant_other_1', trial.data.grant.id].sort());
    });

    it('a trial whose insert lands after the expiring sweep passed its expiry gets grant.expiring once', async () => {
      const { db: base } = makeDb();
      const { db, hooks } = delayedGrantDb(base);
      const env = setup({ db });
      const t0 = env.clock.current.getTime();
      await base.create({ model: 'entitlementGrants', data: otherRow('grant_other_1', new Date(t0 + 4 * DAY + HOUR_MS).toISOString()), namespace: 'billfn' });
      hooks.beforeGrantInsert = async () => {
        env.advance(2 * DAY);
        await env.runLifecycleJob();
      };
      const trial = await env.trial(4 * DAY);
      if (!trial.ok) throw new Error('expected grant');
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      const expiring = env.ofType('grant.expiring').map((event) => event.data.grantId);
      expect(expiring.sort()).toEqual(['grant_other_1', trial.data.grant.id].sort());
    });

    it('a trial whose check of the sweep positions fails after it committed gets grant.expiring from the next job run', async () => {
      const { db: base } = makeDb();
      const { db, hooks } = delayedGrantDb(base);
      const env = setup({ db });
      const t0 = env.clock.current.getTime();
      await base.create({ model: 'entitlementGrants', data: otherRow('grant_other_1', new Date(t0 + 4 * DAY + HOUR_MS).toISOString()), namespace: 'billfn' });
      hooks.beforeGrantInsert = async () => {
        env.advance(2 * DAY);
        await env.runLifecycleJob();
        hooks.failPositionCheck = true;
      };
      const trial = await env.trial(4 * DAY);
      if (!trial.ok) throw new Error('expected grant');
      expect(hooks.failPositionCheck).toBe(false);
      env.advance(HOUR_MS);
      await env.runLifecycleJob();
      await env.runLifecycleJob();
      expect(env.ofType('grant.expiring').map((event) => event.data.grantId).sort()).toEqual(['grant_other_1', trial.data.grant.id].sort());
      const stored = await base.findOne<{ eventsPending?: boolean }>({
        model: 'entitlementGrants',
        where: [{ field: 'id', operator: 'eq', value: trial.data.grant.id }],
        namespace: 'billfn'
      });
      expect(stored?.eventsPending).toBe(false);
    });

    it('an instance whose clock runs 2 days behind the job: its new trial still gets grant.expiring', async () => {
      const { db } = makeDb();
      const job = setup({ db, clock: { current: new Date('2026-11-12T00:00:00.000Z') } });
      const api = setup({ db, clock: { current: new Date('2026-11-10T00:00:00.000Z') } });
      await db.create({ model: 'entitlementGrants', data: otherRow('grant_other_1', '2026-11-14T01:00:00.000Z'), namespace: 'billfn' });
      await job.runLifecycleJob();
      const trial = await api.trial(4 * DAY);
      if (!trial.ok) throw new Error('expected grant');
      job.advance(HOUR_MS);
      await job.runLifecycleJob();
      const expiring = [...job.ofType('grant.expiring'), ...api.ofType('grant.expiring')].map((event) => event.data.grantId);
      expect(expiring.sort()).toEqual(['grant_other_1', trial.data.grant.id].sort());
    });

    it.each([
      ['', false],
      [', also when that run stops before reading the page again', true]
    ])('a trial written while a sweep that read its page before it moves the position past it gets grant.expiring once%s', async (_, stop) => {
      const { db: base } = makeDb();
      const hooks = { beforeMove: null as (() => Promise<void>) | null, failSweepRead: false };
      const runHook = async () => {
        const hook = hooks.beforeMove;
        hooks.beforeMove = null;
        await hook?.();
      };
      // The hook runs after the sweep read its page and before it stores the position past it.
      const db: Adapter = {
        ...base,
        async findMany<T>(params: Parameters<Adapter['findMany']>[0]) {
          if (hooks.failSweepRead && params.model === 'entitlementGrants' && params.where?.some((clause) => clause.field === 'expiresAt')) {
            hooks.failSweepRead = false;
            throw new Error('process stopped');
          }
          return base.findMany<T>(params);
        },
        async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
          if (params.model === 'reconciliationCursors') await runHook();
          return base.create<T>(params);
        },
        async updateMany(params: Parameters<Adapter['updateMany']>[0]) {
          if (params.model === 'reconciliationCursors') await runHook();
          return base.updateMany(params);
        }
      };
      const job = setup({ db, clock: { current: new Date('2026-11-12T00:00:00.000Z') } });
      const api = setup({ db, clock: { current: new Date('2026-11-10T00:00:00.000Z') } });
      await base.create({ model: 'entitlementGrants', data: otherRow('grant_other_1', '2026-11-14T01:00:00.000Z'), namespace: 'billfn' });
      let trialId: string | undefined;
      hooks.beforeMove = async () => {
        // Its creation reads the positions before this sweep stores its own, so it leaves the grant to the sweep.
        const trial = await api.trial(4 * DAY);
        if (!trial.ok) throw new Error('expected grant');
        trialId = trial.data.grant.id;
        hooks.failSweepRead = stop;
      };
      await job.runLifecycleJob();
      job.advance(HOUR_MS);
      await job.runLifecycleJob();
      const expiring = [...job.ofType('grant.expiring'), ...api.ofType('grant.expiring')].map((event) => event.data.grantId);
      expect(expiring.sort()).toEqual(['grant_other_1', trialId!].sort());
    });

    it('rereads a page past which many grants landed late within the per-run bound, finishing in the next run', async () => {
      const { db: base } = makeDb();
      let reads = 0;
      let beforeMove: (() => Promise<void>) | null = null;
      const db: Adapter = {
        ...base,
        async findMany<T>(params: Parameters<Adapter['findMany']>[0]) {
          const rows = await base.findMany<T>(params);
          if (params.model === 'entitlementGrants' && params.where?.some((clause) => clause.field === 'expiresAt')) reads += rows.length;
          return rows;
        },
        async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
          if (params.model === 'reconciliationCursors') {
            const hook = beforeMove;
            beforeMove = null;
            await hook?.();
          }
          return base.create<T>(params);
        }
      };
      const env = setup({ db });
      const at = (minutes: number) => new Date(env.clock.current.getTime() + DAY + minutes * MINUTE).toISOString();
      const row = (id: string, minutes: number) => ({ ...otherRow(id, at(minutes)), billingAccountId: `ba_${id}` });
      const rows = Array.from({ length: 50 }, (_, n) => row(`grant_page_${String(n).padStart(3, '0')}`, n % 2 === 0 ? 0 : 2));
      for (const data of rows) await base.create({ model: 'entitlementGrants', data, namespace: 'billfn' });
      const late = Array.from({ length: GRANT_SWEEP_RUN_LIMIT + 60 }, (_, n) => row(`grant_late_${String(n).padStart(3, '0')}`, 1));
      beforeMove = async () => {
        for (const data of late) await base.create({ model: 'entitlementGrants', data, namespace: 'billfn' });
      };
      expect((await env.runLifecycleJob()).status).toBe('succeeded');
      // The page and at most the per-run bound read again; the rest is left to the next run.
      expect(reads).toBe(50 + GRANT_SWEEP_RUN_LIMIT);
      // Read again in order: the 25 page grants expiring first, then the first late ones.
      expect(env.ofType('grant.expiring')).toHaveLength(50 + GRANT_SWEEP_RUN_LIMIT - 25);
      reads = 0;
      env.advance(MINUTE);
      await env.runLifecycleJob();
      expect(reads).toBeLessThanOrEqual(GRANT_SWEEP_RUN_LIMIT);
      const expiring = env.ofType('grant.expiring').map((event) => event.data.grantId);
      expect(expiring).toHaveLength(rows.length + late.length);
      expect(new Set(expiring).size).toBe(rows.length + late.length);
    });
  });

  describe('without transactions, a revoke that commits while a creation event is being recorded', () => {
    /**
     * Runs `afterGrantStarted` once, right after the next `grant.started` row is written; `failSweep` fails the
     * expiry sweeps' grant reads (so only the repair can record a creation's events).
     */
    function pausingDb() {
      const { db: base, faults } = faultyLifecycleDb(memoryAdapter({ debug: false }), { transactions: false });
      const hooks = { afterGrantStarted: null as ((grantId: string) => Promise<void>) | null, failSweep: false };
      const db: Adapter = {
        ...base,
        async findMany<T>(params: Parameters<Adapter['findMany']>[0]) {
          const sweep = params.model === 'entitlementGrants' && params.where?.some((clause) => clause.field === 'expiresAt');
          if (hooks.failSweep && sweep) throw new Error('sweep read failed');
          return base.findMany<T>(params);
        },
        async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
          const created = await base.create<T>(params);
          const data = params.data as { type?: string; data?: { grantId?: string } };
          if (params.model === 'lifecycleEvents' && data.type === 'grant.started' && hooks.afterGrantStarted) {
            const hook = hooks.afterGrantStarted;
            hooks.afterGrantStarted = null;
            await hook(data.data!.grantId!);
          }
          return created;
        }
      };
      return { db, faults, hooks };
    }

    const createComp = (env: ReturnType<typeof setup>) =>
      env.billfn.services.grants.create({
        billingAccountId: ACCOUNT,
        subject: env.subject,
        planKey: 'nucleus',
        kind: 'comp',
        expiresAt: new Date(env.clock.current.getTime() + 2 * DAY).toISOString()
      });

    it.each([
      ['the creation itself', false, async () => undefined],
      [
        'the job',
        true,
        async (env: ReturnType<typeof setup>, hooks: ReturnType<typeof pausingDb>['hooks']) => {
          // Its sweep fails, so the repair records the creation (a working sweep would warn before the revoke).
          hooks.failSweep = true;
          await env.runLifecycleJob();
          hooks.failSweep = false;
        }
      ],
      ['an entitlements read', true, async (env: ReturnType<typeof setup>) => void (await env.billfn.getEntitlements(env.subject))]
    ] as const)('records no grant.expiring after the revoke when %s records it', async (_, repaired, record) => {
      const { db, faults, hooks } = pausingDb();
      const env = setup({ db });
      const arm = () => {
        hooks.afterGrantStarted = async (grantId) => {
          env.advance(MINUTE);
          // The revoke's own repair cannot write the warning (it would be before the revoke, so allowed), so
          // only the paused write could add one.
          faults.failCreate = (model, data) => model === 'lifecycleEvents' && data.type === 'grant.expiring';
          const revoked = await env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId });
          faults.failCreate = null;
          if (!revoked.ok) throw new Error('expected the revoke');
        };
      };
      if (repaired) {
        // The creation's events fail, so a later repair records them.
        faults.create = true;
        faults.billingEvent = true;
        expect((await createComp(env)).ok).toBe(true);
        faults.create = false;
        faults.billingEvent = false;
        arm();
        await record(env, hooks);
      } else {
        arm();
        expect((await createComp(env)).ok).toBe(true);
      }
      expect(hooks.afterGrantStarted).toBeNull();
      env.advance(HOUR_MS);
      await env.runLifecycleJob();

      const rows = await env.rows();
      const summary = rows
        .filter((event) => event.billingAccountId === ACCOUNT)
        .map((event) => [event.type, (event.data as { cause?: string }).cause ?? null])
        .sort();
      expect(summary).toEqual([
        ['entitlement.changed', 'grant.revoked'],
        ['entitlement.changed', 'grant.started'],
        ['grant.started', null]
      ]);
      const [stored] = await db.findMany<{ eventsPending?: boolean }>({ model: 'entitlementGrants', namespace: 'billfn' });
      expect(stored?.eventsPending).toBe(false);
    });
  });
});
