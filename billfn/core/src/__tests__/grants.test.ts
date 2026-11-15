import { describe, expect, it } from 'vitest';
import type { Adapter, TransactionAdapter } from '@superfunctions/db';
import { memoryAdapter } from '@superfunctions/db/testing';
import { createBillFn } from '../index.js';
import type {
  BillFnBillingEvent,
  BillFnCatalog,
  BillFnCreateGrantRequest,
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
    },
    {
      productKey: 'memotron',
      planKey: 'memotron',
      displayName: 'Memotron',
      features: { memotron: true },
      limits: { storage: 1000 },
      prices: []
    }
  ]
};

const OPERATOR = { id: 'operator_1', type: 'user', requestId: 'request_1' };
const PRINCIPAL = 'user_1';
const ACCOUNT = `ba_user_${PRINCIPAL}`;

function createProvider(state: { status: SubscriptionStatus }): BillFnProviderAdapter {
  const billingState = (providerSubscriptionId: string, status: SubscriptionStatus) => ({
    subscriptionStatus: status,
    checkoutStatus: 'succeeded' as const,
    providerSubscriptionId,
    providerChargeId: `charge_${providerSubscriptionId}`,
    currentPeriodStart: '2026-11-10T00:00:00.000Z',
    currentPeriodEnd: '2026-12-10T00:00:00.000Z',
    autoRenew: status === 'active'
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
      return billingState(`sub_${input.checkoutSession.checkoutSessionId}`, state.status);
    },
    async fetchSubscription(input) {
      return billingState(input.subscription.providerSubscriptionId!, state.status);
    },
    async cancelSubscription(input) {
      return { operationStatus: 'applied', billingState: billingState(input.subscription.providerSubscriptionId!, 'canceled') };
    }
  };
}

/** Fails billing event writes while `failEvents.on`, inside transactions and, when `transactions` is false, directly. */
function failingEventDb(transactions: boolean) {
  const base = memoryAdapter({ debug: false });
  // `only` limits the failure to one event id, so the writes that repair other events succeed.
  const failEvents: { on: boolean; only?: string } = { on: false };
  const failing = <A extends Pick<Adapter, 'create'>>(adapter: A): A => ({
    ...adapter,
    async create<T>(params: Parameters<Adapter['create']>[0]): Promise<T> {
      const eventId = (params.data as { id?: unknown }).id;
      if (failEvents.on && params.model === 'billingEvents' && (!failEvents.only || failEvents.only === eventId)) {
        throw new Error('event write failed');
      }
      return adapter.create<T>(params);
    }
  });
  const db: Adapter = transactions
    ? {
        ...base,
        async transaction<R>(callback: (transaction: TransactionAdapter) => Promise<R>): Promise<R> {
          return base.transaction(async (transaction) => callback(failing(transaction)));
        }
      }
    : {
        ...failing(base),
        capabilities: { ...base.capabilities, transactions: { ...base.capabilities.transactions, supported: false } },
        async transaction(): Promise<never> {
          throw new Error('transaction should not be called');
        }
      };
  return { base, db, failEvents };
}

function setup(db: Adapter = memoryAdapter({ debug: false })) {
  const clock = { current: new Date('2026-11-10T00:00:00.000Z') };
  const providerState = { status: 'active' as SubscriptionStatus };
  const billfn = createBillFn({
    db,
    catalog,
    providers: { dodo: createProvider(providerState) },
    now: () => clock.current,
    auth: { resolveSubject: async () => ({ principalId: PRINCIPAL }) }
  });
  const subject = { principalId: PRINCIPAL };
  const days = (count: number) => new Date(clock.current.getTime() + count * 24 * 60 * 60 * 1000).toISOString();
  return {
    db,
    billfn,
    clock,
    subject,
    days,
    advance(count: number) {
      clock.current = new Date(clock.current.getTime() + count * 24 * 60 * 60 * 1000);
    },
    grant(input: Partial<BillFnCreateGrantRequest> = {}) {
      return billfn.services.grants.create({
        billingAccountId: ACCOUNT,
        subject,
        planKey: 'nucleus',
        kind: 'trial',
        expiresAt: days(14),
        operator: OPERATOR,
        ...input
      });
    },
    async entitlements() {
      const response = await billfn.getEntitlements(subject);
      if (!response.ok) throw new Error('expected entitlements');
      return response.data;
    },
    async subscribe(status: SubscriptionStatus = 'active') {
      providerState.status = status;
      const created = await billfn.createCheckout({ subject, planKey: 'nucleus', provider: 'dodo', interval: 'month' });
      if (!created.ok) throw new Error('expected checkout');
      const verified = await billfn.verifyCheckout({ subject, checkoutSessionId: created.data.checkoutSession.checkoutSessionId });
      if (!verified.ok) throw new Error('expected verification');
      return verified.data;
    },
    events(type: string) {
      return db.findMany<BillFnBillingEvent>({
        model: 'billingEvents',
        where: [{ field: 'type', operator: 'eq', value: type }],
        namespace: 'billfn'
      });
    }
  };
}

describe('entitlement grants', () => {
  it('sets the entitlements to trialing for the trial plan until its expiry and lists the grant', async () => {
    const env = setup();
    const created = await env.grant();
    if (!created.ok) throw new Error('expected grant');
    expect(created.data.grant).toMatchObject({
      billingAccountId: ACCOUNT,
      planKey: 'nucleus',
      kind: 'trial',
      status: 'active',
      startsAt: '2026-11-10T00:00:00.000Z',
      expiresAt: '2026-11-24T00:00:00.000Z',
      operator: OPERATOR
    });
    expect(created.data.entitlements).toMatchObject({ status: 'trialing', planKey: 'nucleus' });

    const data = await env.entitlements();
    expect(data.subscription).toBeNull();
    expect(data.entitlements).toMatchObject({
      billingAccountId: ACCOUNT,
      planKey: 'nucleus',
      status: 'trialing',
      features: { memotron: true, pointron: true },
      limits: { storage: 5000 },
      expiresAt: '2026-11-24T00:00:00.000Z',
      grant: { id: created.data.grant.id, kind: 'trial', expiresAt: '2026-11-24T00:00:00.000Z' }
    });
    expect(data.grants).toEqual([
      expect.objectContaining({ id: created.data.grant.id, kind: 'trial', status: 'active', expiresAt: '2026-11-24T00:00:00.000Z' })
    ]);
    await expect(env.billfn.subscriptionProvider.hasFeature(env.subject, 'pointron')).resolves.toBe(true);
    await expect(
      env.billfn.quotaProvider.checkQuota({ principalId: PRINCIPAL, requestedBytes: 100 })
    ).resolves.toMatchObject({ allowed: true, limit: 5000 });
    expect(await env.events('billfn.grant.created')).toEqual([
      expect.objectContaining({
        billingAccountId: ACCOUNT,
        payload: expect.objectContaining({ grantId: created.data.grant.id, kind: 'trial', operator: OPERATOR })
      })
    ]);
  });

  it('refuses a second trial for a billing account, also after the first expired and when two race', async () => {
    const env = setup();
    const [first, second] = await Promise.allSettled([env.grant(), env.grant({ planKey: 'memotron' })]);
    const outcomes = [first, second].map((outcome) => outcome.status);
    expect(outcomes.sort()).toEqual(['fulfilled', 'rejected']);
    const refused = [first, second].find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'BILLFN_CONFLICT', details: { reason: 'trial_already_granted' } });

    env.advance(30);
    await expect(env.grant()).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      details: { reason: 'trial_already_granted' }
    });
    expect((await env.entitlements()).grants).toEqual([expect.objectContaining({ kind: 'trial', status: 'expired' })]);
    expect(await env.events('billfn.grant.created')).toHaveLength(1);
  });

  it('lets a paid subscription supersede a grant while it entitles the account', async () => {
    const env = setup();
    await env.grant({ planKey: 'memotron' });

    const paid = await env.subscribe('active');
    expect(paid.entitlements).toMatchObject({ planKey: 'nucleus', status: 'active' });
    expect(paid.entitlements.grant).toBeUndefined();
    const data = await env.entitlements();
    expect(data.entitlements).toMatchObject({ planKey: 'nucleus', status: 'active', limits: { storage: 5000 } });
    expect(data.entitlements?.grant).toBeUndefined();
    expect(data.grants).toEqual([expect.objectContaining({ kind: 'trial', status: 'active' })]);

    // Once the paid subscription stops entitling the account, the unexpired grant applies again,
    // including in the cancellation's own response.
    const canceled = await env.billfn.cancelSubscription({ subject: env.subject });
    if (!canceled.ok) throw new Error('expected cancellation');
    expect(canceled.data.subscription.status).toBe('canceled');
    expect(canceled.data.entitlements).toMatchObject({ planKey: 'memotron', status: 'trialing' });
  });

  it('falls back to inactive or to the paid state once a grant expires', async () => {
    const env = setup();
    await env.grant({ expiresAt: env.days(14) });
    env.advance(14);

    const lapsed = await env.entitlements();
    expect(lapsed.entitlements).toMatchObject({ status: 'inactive', planKey: 'nucleus', features: {}, limits: {} });
    expect(lapsed.entitlements?.grant).toBeUndefined();
    await expect(env.billfn.subscriptionProvider.isActive(env.subject)).resolves.toBe(false);
    await expect(env.billfn.subscriptionProvider.hasFeature(env.subject, 'memotron')).resolves.toBe(false);
    await expect(
      env.billfn.quotaProvider.checkQuota({ principalId: PRINCIPAL, requestedBytes: 1 })
    ).resolves.toMatchObject({ allowed: false, reason: 'subscription_inactive' });

    // A comp over an inactive paid subscription falls back to that paid state.
    const other = setup();
    await other.subscribe('expired');
    await other.billfn.services.grants.create({
      billingAccountId: ACCOUNT,
      planKey: 'memotron',
      kind: 'comp',
      expiresAt: other.days(7)
    });
    expect((await other.entitlements()).entitlements).toMatchObject({ planKey: 'memotron', status: 'active' });
    other.advance(8);
    const fallback = await other.entitlements();
    expect(fallback.entitlements).toMatchObject({ planKey: 'nucleus', status: 'inactive', limits: { storage: 5000 } });
    expect(fallback.entitlements?.sourceEventId).not.toMatch(/^grant:/);
  });

  it('revokes a comp, refuses to revoke a trial, and keeps one active comp at a time', async () => {
    const env = setup();
    const trial = await env.grant({ planKey: 'memotron' });
    const comp = await env.grant({ kind: 'comp', planKey: 'nucleus', expiresAt: env.days(365) });
    if (!trial.ok || !comp.ok) throw new Error('expected grants');
    // A comp is preferred over a concurrent trial.
    expect(comp.data.entitlements).toMatchObject({ planKey: 'nucleus', status: 'active', grant: { kind: 'comp' } });
    await expect(env.grant({ kind: 'comp', planKey: 'memotron' })).rejects.toMatchObject({
      code: 'BILLFN_CONFLICT',
      details: { reason: 'active_comp_exists', grantId: comp.data.grant.id }
    });
    await expect(
      env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: trial.data.grant.id })
    ).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR', details: { reason: 'grant_not_revocable' } });
    await expect(
      env.billfn.services.grants.revoke({ billingAccountId: 'ba_user_other', grantId: comp.data.grant.id })
    ).rejects.toMatchObject({ code: 'BILLFN_NOT_FOUND' });

    env.advance(1);
    const revoked = await env.billfn.services.grants.revoke({
      billingAccountId: ACCOUNT,
      grantId: comp.data.grant.id,
      operator: OPERATOR,
      reason: 'goodwill ended'
    });
    if (!revoked.ok) throw new Error('expected revoke');
    expect(revoked.data.grant).toMatchObject({
      status: 'revoked',
      revokedAt: '2026-11-11T00:00:00.000Z',
      revokedBy: OPERATOR,
      revokeReason: 'goodwill ended'
    });
    // The unexpired trial applies again.
    expect(revoked.data.entitlements).toMatchObject({ planKey: 'memotron', status: 'trialing' });

    const again = await env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: comp.data.grant.id });
    if (!again.ok) throw new Error('expected revoke');
    expect(again.data.grant).toEqual(revoked.data.grant);
    expect(await env.events('billfn.grant.revoked')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ grantId: comp.data.grant.id, operator: OPERATOR }) })
    ]);
    // A revoked comp no longer blocks a new one.
    await expect(env.grant({ kind: 'comp', planKey: 'memotron' })).resolves.toMatchObject({ ok: true });
  });

  it('revokes a comp once when two revokes race', async () => {
    const env = setup();
    const comp = await env.grant({ kind: 'comp' });
    if (!comp.ok) throw new Error('expected grant');
    const revoke = (reason: string) =>
      env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: comp.data.grant.id, reason });
    const [first, second] = await Promise.all([revoke('first'), revoke('second')]);
    if (!first.ok || !second.ok) throw new Error('expected revokes');
    // The losing revoke returns the winner's revocation instead of overwriting it.
    expect(second.data.grant).toEqual(first.data.grant);
    expect(first.data.grant.revokeReason).toBe('first');
    expect(await env.events('billfn.grant.revoked')).toHaveLength(1);
    expect((await env.entitlements()).entitlements).toMatchObject({ status: 'inactive' });
  });

  it('stores one of two racing comps, and the account falls back once the stored comp is revoked', async () => {
    const env = setup();
    const outcomes = await Promise.allSettled([
      env.grant({ kind: 'comp', planKey: 'nucleus', expiresAt: env.days(365) }),
      env.grant({ kind: 'comp', planKey: 'memotron', expiresAt: env.days(30) })
    ]);
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected') as PromiseRejectedResult[];
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toMatchObject({ code: 'BILLFN_CONFLICT', details: { reason: 'active_comp_exists' } });
    const stored = await env.db.findMany<{ id: string }>({ model: 'entitlementGrants', where: [], namespace: 'billfn' });
    expect(stored).toHaveLength(1);
    expect(await env.events('billfn.grant.created')).toHaveLength(1);

    await env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: stored[0]!.id });
    expect((await env.entitlements()).entitlements).toMatchObject({ status: 'inactive', features: {}, limits: {} });
    await expect(env.billfn.subscriptionProvider.hasFeature(env.subject, 'memotron')).resolves.toBe(false);
  });

  it('returns grants on GET /entitlements without the operator or reasons', async () => {
    const env = setup();
    const comp = await env.grant({ kind: 'comp', reason: 'internal note: VIP escalation' });
    if (!comp.ok) throw new Error('expected grant');
    await env.billfn.services.grants.revoke({
      billingAccountId: ACCOUNT,
      grantId: comp.data.grant.id,
      operator: OPERATOR,
      reason: 'internal note: revoked'
    });
    const response = await env.billfn.router.handle(new Request('https://billfn.example.test/billfn/entitlements'));
    const payload = (await response.json()) as { ok: boolean; data: { grants: Record<string, unknown>[] } };
    expect(payload.ok).toBe(true);
    expect(payload.data.grants).toEqual([
      {
        id: comp.data.grant.id,
        kind: 'comp',
        planKey: 'nucleus',
        status: 'revoked',
        startsAt: '2026-11-10T00:00:00.000Z',
        expiresAt: '2026-11-24T00:00:00.000Z',
        revokedAt: '2026-11-10T00:00:00.000Z'
      }
    ]);
    expect(JSON.stringify(payload)).not.toMatch(/operator_1|request_1|internal note/);
  });

  it('validates a grant before writing anything', async () => {
    const env = setup();
    await expect(env.grant({ expiresAt: '2026-11-09T00:00:00.000Z' })).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    await expect(env.grant({ expiresAt: 'soon' })).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    await expect(env.grant({ kind: 'gift' as never })).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    await expect(env.grant({ planKey: 'missing' })).rejects.toMatchObject({ code: 'BILLFN_NOT_FOUND' });
    await expect(env.grant({ subject: undefined })).rejects.toMatchObject({ code: 'BILLFN_NOT_FOUND' });
    await expect(env.grant({ billingAccountId: 'ba_user_other' })).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(await env.db.findMany({ model: 'billingAccounts', where: [], namespace: 'billfn' })).toEqual([]);
    expect(await env.db.findMany({ model: 'entitlementGrants', where: [], namespace: 'billfn' })).toEqual([]);

    // With a subject, the billing account is created for the grant.
    await expect(env.grant()).resolves.toMatchObject({ ok: true });
    expect((await env.entitlements()).billingAccount.metadata?.virtual).toBeUndefined();
  });

  it('persists no grant or revoke whose billing event fails to write in a transaction', async () => {
    const { db, failEvents } = failingEventDb(true);
    const env = setup(db);

    failEvents.on = true;
    await expect(env.grant({ kind: 'comp' })).rejects.toThrow('event write failed');
    expect((await env.entitlements()).grants).toEqual([]);
    expect((await env.entitlements()).entitlements).toBeNull();

    failEvents.on = false;
    const created = await env.grant({ kind: 'comp' });
    if (!created.ok) throw new Error('expected a comp');
    expect(await env.events('billfn.grant.created')).toHaveLength(1);

    failEvents.on = true;
    const revoke = () =>
      env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: created.data.grant.id, operator: OPERATOR });
    await expect(revoke()).rejects.toThrow('event write failed');
    expect((await env.entitlements()).grants).toMatchObject([{ id: created.data.grant.id, status: 'active', revokedAt: null }]);
    expect((await env.entitlements()).entitlements).toMatchObject({ status: 'active' });

    failEvents.on = false;
    await expect(revoke()).resolves.toMatchObject({ ok: true, data: { grant: { status: 'revoked' } } });
    expect(await env.events('billfn.grant.revoked')).toHaveLength(1);
  });

  it('keeps a grant or revoke whose event fails to write without transactions and records the event on the next read', async () => {
    const { db, failEvents } = failingEventDb(false);
    const env = setup(db);

    // The committed trial is the outcome; its event is recorded by the account's next entitlements read, once.
    failEvents.on = true;
    await expect(env.grant()).resolves.toMatchObject({ ok: true, data: { grant: { kind: 'trial', status: 'active' } } });
    expect(await env.events('billfn.grant.created')).toEqual([]);
    failEvents.on = false;
    expect((await env.entitlements()).entitlements).toMatchObject({ status: 'trialing' });
    expect((await env.entitlements()).grants).toHaveLength(1);
    expect(await env.events('billfn.grant.created')).toMatchObject([{ payload: { kind: 'trial', operator: OPERATOR } }]);
    await expect(env.grant()).rejects.toMatchObject({ code: 'BILLFN_CONFLICT', details: { reason: 'trial_already_granted' } });

    const comp = await env.grant({ kind: 'comp' });
    if (!comp.ok) throw new Error('expected a comp');
    const revoke = () =>
      env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: comp.data.grant.id, operator: OPERATOR });
    failEvents.on = true;
    await expect(revoke()).resolves.toMatchObject({ ok: true, data: { grant: { status: 'revoked' } } });
    failEvents.on = false;
    expect(await env.events('billfn.grant.revoked')).toEqual([]);
    expect((await env.entitlements()).grants).toContainEqual(expect.objectContaining({ id: comp.data.grant.id, status: 'revoked' }));
    await expect(revoke()).resolves.toMatchObject({ ok: true, data: { grant: { status: 'revoked' } } });
    expect(await env.events('billfn.grant.revoked')).toMatchObject([{ payload: { grantId: comp.data.grant.id, operator: OPERATOR } }]);
  });

  it('records an unrecorded grant event on the account\'s next grant operation without transactions, also after expiry', async () => {
    const { db, failEvents } = failingEventDb(false);
    const env = setup(db);
    const created = async () => (await env.events('billfn.grant.created')).map((event) => event.payload.grantId).sort();

    // The trial commits without its event and expires; a later trial request is refused but records the event.
    failEvents.on = true;
    await expect(env.grant({ expiresAt: env.days(3) })).resolves.toMatchObject({ ok: true });
    env.advance(4);
    failEvents.on = false;
    await expect(env.grant({ expiresAt: env.days(-1) })).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    expect(await created()).toEqual([`grant_trial_${ACCOUNT}`]);

    // comp 1 commits without its event and expires; creating comp 2 records both creation events once.
    failEvents.on = true;
    failEvents.only = `evt_grant_created_grant_comp_${ACCOUNT}_1`;
    await expect(env.grant({ kind: 'comp', expiresAt: env.days(2) })).resolves.toMatchObject({ ok: true });
    env.advance(3);
    failEvents.on = false;
    const comp = await env.grant({ kind: 'comp' });
    if (!comp.ok) throw new Error('expected a comp');
    expect(comp.data.grant.id).toBe(`grant_comp_${ACCOUNT}_2`);
    expect(await created()).toEqual([`grant_comp_${ACCOUNT}_1`, `grant_comp_${ACCOUNT}_2`, `grant_trial_${ACCOUNT}`]);

    // A revoke commits without its event; a later grant request on the account records it once.
    failEvents.on = true;
    failEvents.only = `evt_grant_revoked_grant_comp_${ACCOUNT}_2`;
    await expect(
      env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: comp.data.grant.id, operator: OPERATOR })
    ).resolves.toMatchObject({ ok: true, data: { grant: { status: 'revoked' } } });
    failEvents.on = false;
    await expect(env.grant({ kind: 'comp', expiresAt: env.days(-1) })).rejects.toMatchObject({ code: 'BILLFN_VALIDATION_ERROR' });
    await expect(
      env.billfn.services.grants.revoke({ billingAccountId: ACCOUNT, grantId: 'grant_unknown', operator: OPERATOR })
    ).rejects.toMatchObject({ code: 'BILLFN_NOT_FOUND' });
    expect(await env.events('billfn.grant.revoked')).toMatchObject([{ payload: { grantId: comp.data.grant.id, operator: OPERATOR } }]);
    expect(await created()).toHaveLength(3);
  });

  it('checks a quota against the status and limit of one entitlements read', async () => {
    const base = memoryAdapter({ debug: false });
    const grantReads = { count: 0, armed: false };
    let env: ReturnType<typeof setup> | undefined;
    const db: Adapter = {
      ...base,
      async findMany<T>(params: Parameters<Adapter['findMany']>[0]): Promise<T[]> {
        // The comp expires between a first and a second read of the account's grants.
        if (grantReads.armed && params.model === 'entitlementGrants' && ++grantReads.count === 2) {
          env!.advance(8);
        }
        return base.findMany<T>(params);
      }
    };
    env = setup(db);
    await env.subscribe('expired');
    await env.grant({ kind: 'comp', planKey: 'memotron', expiresAt: env.days(7) });

    grantReads.armed = true;
    // The comp's memotron limit (1000) decides, not the inactive paid nucleus limit (5000).
    await expect(
      env.billfn.quotaProvider.checkQuota({ principalId: PRINCIPAL, requestedBytes: 3000 })
    ).resolves.toEqual({ allowed: false, current: 0, limit: 1000, reason: 'quota_exceeded' });
  });
});
