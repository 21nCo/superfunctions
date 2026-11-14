import { DuplicateKeyError, type Adapter, type WhereClause } from '@superfunctions/db';
import { ok } from '@superfunctions/envelope';
import { createNamespacedEmitter, createMetricsEmitter, type MetricsEmitter } from '@superfunctions/metrics';
import { createBillFnError } from './errors.js';
import {
  createDefaultBillingAccountResolver,
  defaultIdFactory,
  resolvePlan,
  resolvePrice,
  toIsoString
} from './helpers.js';
import type {
  BillFnBillingAccount,
  BillFnBillingEvent,
  BillFnCancelSubscriptionRequest,
  BillFnCancelSubscriptionResponse,
  BillFnCatalog,
  BillFnChangeSubscriptionRequest,
  BillFnChangeSubscriptionResponse,
  BillFnCheckoutCreateRequest,
  BillFnCheckoutSession,
  BillFnConfig,
  BillFnCreateCheckoutResponse,
  BillFnCreateCheckoutResponseData,
  BillFnEnqueueReconciliationJobRequest,
  BillFnEntitlementSnapshot,
  BillFnEntitlementsResponse,
  BillFnEntitlementsResponseData,
  BillFnFetchNotificationHistoryInput,
  BillFnGetReconciliationJobRequest,
  BillFnPriceDefinition,
  BillFnProviderOperationResult,
  BillFnProviderAdapter,
  BillFnQueueAdapter,
  BillFnQueuedJob,
  BillFnReconciliationCursor,
  BillFnReconciliationJob,
  BillFnReconciliationJobKind,
  BillFnReconciliationJobResponse,
  BillFnRefund,
  BillFnRefundChargeRequest,
  BillFnRefundChargeResponse,
  BillFnRestorePurchasesRequest,
  BillFnRestorePurchasesResponse,
  BillFnRestorePurchasesResponseData,
  BillFnResumeSubscriptionRequest,
  BillFnResumeSubscriptionResponse,
  BillFnRunReconciliationJobRequest,
  BillFnSubscription,
  BillFnSubscriptionChangeRequest,
  BillFnSyncSubscriptionRequest,
  BillFnSyncSubscriptionResponse,
  BillFnSyncSubscriptionResponseData,
  BillFnReplacedProviderReference,
  BillFnUnlinkedWebhookEvent,
  BillFnUnlinkedWebhookEventReason,
  BillFnUsageLedgerEntry,
  BillFnUsageMeter,
  BillFnUsageResponse,
  BillFnUsageResponseData,
  BillFnVerifyCheckoutRequest,
  BillFnVerifyCheckoutResponse,
  BillFnWebhookReceipt,
  BillFnWebhookRequest,
  BillFnWebhookResponse,
  BillFnWebhookResponseData,
  BillableSubject,
  BillingAccountResolver,
  BillingProviderName,
  EntitlementStatus,
  SubscriptionStatus
} from './types.js';

const TABLES = {
  billingAccounts: 'billingAccounts',
  subscriptions: 'subscriptions',
  checkoutSessions: 'checkoutSessions',
  entitlementSnapshots: 'entitlementSnapshots',
  usageMeters: 'usageMeters',
  usageLedger: 'usageLedger',
  webhookReceipts: 'webhookReceipts',
  billingEvents: 'billingEvents',
  refunds: 'refunds',
  subscriptionChangeRequests: 'subscriptionChangeRequests',
  reconciliationJobs: 'reconciliationJobs',
  reconciliationCursors: 'reconciliationCursors',
  unlinkedWebhookEvents: 'unlinkedWebhookEvents',
  replacedProviderReferences: 'replacedProviderReferences'
} as const;

const PROVIDER_EVENT_OCCURRED_AT_METADATA_KEY = 'billfnProviderEventOccurredAt';
/** When the committed provider mutation that set the provider-state time started; it opens that mutation's window. */
const PROVIDER_MUTATION_STARTED_AT_METADATA_KEY = 'billfnProviderMutationStartedAt';
/** References a committed mutation's write dropped but could not record as replaced (`replacedReferencesPending`). */
const PENDING_REPLACED_REFERENCES_METADATA_KEY = 'billfnPendingReplacedReferences';
const WEBHOOK_RECEIPT_CLAIM_LEASE_MS = 15 * 60 * 1000;
const RECONCILIATION_JOB_CLAIM_LEASE_MS = 15 * 60 * 1000;
/** Unlinked webhook events are kept this long for a later link to replay them. */
const UNLINKED_WEBHOOK_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const UNLINKED_WEBHOOK_EVENT_REPLAY_LEASE_MS = 15 * 60 * 1000;
/** Bounds the events one replay run applies; the rest are left for the retried operation's next run. */
const UNLINKED_WEBHOOK_EVENT_REPLAY_MAX_EVENTS = 500;
/** Provider metadata key naming the billing account that owns a provider record. */
const BILLING_ACCOUNT_METADATA_KEY = 'billfn_billing_account_id';
/** Deliveries of one queue message refused by lease conflicts before it is dead-lettered. */
const RECONCILIATION_QUEUE_MAX_LEASE_CONFLICT_ATTEMPTS = 5;

/**
 * `BILLFN_CONFLICT` errors raised because another runner holds, or took over,
 * a reconciliation job's processing lease. Membership, not the error code,
 * separates them from domain conflicts raised while processing the job.
 */
const reconciliationLeaseConflicts = new WeakSet<object>();

function reconciliationLeaseConflict(message: string) {
  const error = createBillFnError({ code: 'BILLFN_CONFLICT', message });
  reconciliationLeaseConflicts.add(error);
  return error;
}

function isReconciliationLeaseConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reconciliationLeaseConflicts.has(error);
}
const DUPLICATE_RECORD_ERROR_CODES = new Set([
  'P2002',
  '23505',
  'ER_DUP_ENTRY',
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  '11000'
]);

type ServiceDeps = {
  db: Adapter;
  namespace: string;
  catalog: BillFnCatalog;
  providers: Partial<Record<BillingProviderName, BillFnProviderAdapter>>;
  resolveBillingAccount: BillingAccountResolver;
  now: () => Date;
  generateId: (prefix: string) => string;
  metrics: MetricsEmitter;
  queue?: BillFnQueueAdapter<BillFnQueuedJob>;
  /**
   * Reconciles an event inside a committed mutation's window with an inline
   * provider read. A failed read without a queue throws a window-read error.
   */
  reconcileProviderState?: (subscription: BillFnSubscription, event: WindowEvent) => Promise<void>;
};
type CatalogSelection = { plan: ReturnType<typeof requirePlan>; price: BillFnPriceDefinition };
/** An event inside a committed mutation's window: its lifecycle key and the catalog price it names. */
type WindowEvent = { providerEventId?: string; selection: CatalogSelection };

type VerifiedBillingState = NonNullable<Awaited<ReturnType<NonNullable<BillFnProviderAdapter['verifyCheckout']>>>>;
type ApplyVerificationStateInput = {
  billingAccount: BillFnBillingAccount;
  plan: ReturnType<typeof requirePlan>;
  price: BillFnPriceDefinition;
  checkoutSession?: BillFnCheckoutSession;
  subscription?: BillFnSubscription;
  state: VerifiedBillingState;
  occurredAt?: string;
  /**
   * When `state` comes from a live provider read or a provider mutation
   * response (verification, restore, sync, cancel, change, resume, refund),
   * the time that provider call started. A read saves it as the
   * subscription's provider-state time (a committed mutation saves
   * `committedAt`), never moving it backwards, so a later replay or delivery of
   * an event that occurred before it is skipped.
   */
  liveStateObservedAt?: string;
  /**
   * Set only for the state a committed provider mutation returned: when the
   * provider call returned. An event applied after the call started but not
   * after this time does not supersede the committed state, which is saved
   * with this provider-state time.
   */
  committedAt?: string;
  /** The applied provider event, which keys its lifecycle billing event so a redelivery or replay records it once. */
  providerEventId?: string;
  /** Keeps an open mutation window; the caller closes it once this write's effects are recorded. */
  keepMutationWindow?: boolean;
};
type ProjectionResult = {
  checkoutSession: BillFnCheckoutSession | undefined;
  subscription: BillFnSubscription;
  entitlements: BillFnEntitlementSnapshot;
  /** Set when a provider event was applied while a committed provider mutation was in flight: the price it had written. */
  providerStateRaced?: { priceId: string };
};
type ReconciliationLeaseGuard = () => Promise<void>;
type ParsedProviderEvent = {
  providerEventId: string;
  type: string;
  signatureVerified: boolean;
  occurredAt?: string;
  planKey?: string;
  priceId?: string;
  providerSubscriptionId?: string;
  providerChargeId?: string;
  checkoutReferenceId?: string;
  billingState?: VerifiedBillingState;
  raw: Record<string, unknown>;
};
type ProviderProjectionContext = NonNullable<Awaited<ReturnType<typeof resolveProjectionContextForProviderState>>>;

export function createBillFnService(config: BillFnConfig) {
  return createBillFnServiceWithInternals(config).service;
}

function createBillFnServiceWithInternals(config: BillFnConfig) {
  const namespace = config.namespace ?? 'billfn';
  const now = config.now ?? (() => new Date());
  const generateId = config.generateId ?? defaultIdFactory;
  const resolveBillingAccount = config.billingAccountResolver ?? createDefaultBillingAccountResolver();
  const metrics = createNamespacedEmitter('billfn', config.metrics ?? createMetricsEmitter());

  const deps: ServiceDeps = {
    db: config.db,
    namespace,
    catalog: config.catalog,
    providers: config.providers ?? {},
    resolveBillingAccount,
    now,
    generateId,
    metrics,
    queue: config.queue
  };
  deps.reconcileProviderState = (subscription, event) => reconcileWindowEvent(subscription, event);

  const subscriptionProvider = {
    getActiveSubscription: async (subject: BillableSubject) => {
      const billingAccount = await findBillingAccountForSubject(deps, requireSubject(subject));
      if (!billingAccount) {
        return null;
      }
      return findActiveSubscription(deps, billingAccount.id);
    },
    getEntitlementSnapshot: async (subject: BillableSubject) => {
      const billingAccount = await findBillingAccountForSubject(deps, requireSubject(subject));
      if (!billingAccount) {
        return null;
      }
      return findEntitlementSnapshot(deps, billingAccount.id);
    },
    isActive: async (subject: BillableSubject) => {
      const snapshot = await subscriptionProvider.getEntitlementSnapshot(subject);
      return snapshot?.status === 'active' || snapshot?.status === 'trialing' || snapshot?.status === 'grace';
    },
    hasFeature: async (subject: BillableSubject, feature: string) => {
      const snapshot = await subscriptionProvider.getEntitlementSnapshot(subject);
      return Boolean(
        snapshot &&
        (snapshot.status === 'active' || snapshot.status === 'trialing' || snapshot.status === 'grace') &&
        snapshot.features[feature]
      );
    }
  };

  const quotaProvider = {
    checkQuota: async (input: {
      principalId?: string;
      tenantId?: string;
      requestedBytes: number;
      resource?: string;
    }) => {
      assertNonNegativeFiniteAmount(input.requestedBytes, 'requestedBytes');
      const subject = {
        principalId: input.principalId,
        tenantId: input.tenantId
      };
      const resource = input.resource ?? 'storage';
      const entitlements = await subscriptionProvider.getEntitlementSnapshot(subject);
      if (!entitlements || entitlements.status === 'inactive') {
        return {
          allowed: false,
          current: 0,
          limit: 0,
          reason: 'subscription_inactive'
        };
      }
      const usage = await quotaProvider.getUsage(input.principalId, input.tenantId, resource);
      const limit = usage.limit;
      if (limit >= 0 && usage.current + input.requestedBytes > limit) {
        return {
          allowed: false,
          current: usage.current,
          limit,
          reason: 'quota_exceeded'
        };
      }
      return {
        allowed: true,
        current: usage.current,
        limit
      };
    },
    recordUsage: async (input: {
      principalId?: string;
      tenantId?: string;
      bytes: number;
      resource?: string;
    }) => {
      const subject = {
        principalId: input.principalId,
        tenantId: input.tenantId
      };
      const { billingAccount } = await getOrCreateBillingAccount(deps, requireSubject(subject));
      await incrementUsage(deps, billingAccount.id, input.resource ?? 'storage', input.bytes);
    },
    getUsage: async (principalId?: string, tenantId?: string, resource = 'storage') => {
      const subject = {
        principalId,
        tenantId
      };
      const billingAccount = await findBillingAccountForSubject(deps, requireSubject(subject));
      const meter = billingAccount ? await findUsageMeter(deps, billingAccount.id, resource) : null;
      const entitlements = billingAccount ? await findEntitlementSnapshot(deps, billingAccount.id) : null;
      return {
        current: meter?.current ?? 0,
        limit: entitlements?.limits[resource] ?? 0
      };
    }
  };

  /** Reads the subscription from the provider (see `fetchLiveSubscription`). */
  async function readProviderSubscription(subscriptionId: string, candidate?: CatalogSelection) {
    const subscription = await getSubscriptionById(deps, subscriptionId);
    if (!subscription) {
      throw createBillFnError({
        code: 'BILLFN_NOT_FOUND',
        message: 'Subscription not found'
      });
    }
    const billingAccount = await getBillingAccountById(deps, subscription.billingAccountId);
    if (!billingAccount) {
      throw createBillFnError({
        code: 'BILLFN_NOT_FOUND',
        message: 'Billing account not found'
      });
    }
    const live = await fetchLiveSubscription(deps, subscription, candidate);
    if (!live) {
      throw createBillFnError({
        code: 'BILLFN_NOT_FOUND',
        message: 'Provider did not return subscription state'
      });
    }
    return { billingAccount, subscription, ...live };
  }

  async function syncSubscriptionById(subscriptionId: string): Promise<ProjectionResult> {
    return applyLiveProviderState(deps, await readProviderSubscription(subscriptionId));
  }

  /**
   * Reconciles an event inside a committed mutation's window with a provider
   * read for the committed plan and price, or for the event's price when that
   * fails and the live record confirms it (`fetchLiveSubscription`). When no
   * read succeeds, the committed state stands: with a queue a subscription-sync
   * job carrying the event's price is enqueued, otherwise a window-read error is
   * thrown so the delivery, job or replay trigger is retried. The window stays
   * open until the read's entitlements and its lifecycle entry, keyed by the
   * event, are written, so a retry after a failure there reconciles again.
   */
  async function reconcileWindowEvent(subscription: BillFnSubscription, event: WindowEvent) {
    let read: Awaited<ReturnType<typeof readProviderSubscription>>;
    try {
      read = await readProviderSubscription(subscription.id, event.selection);
    } catch (error_) {
      deps.metrics.track('subscription.mutation.window_event_unreconciled', {
        provider: subscription.provider,
        subscriptionId: subscription.id,
        reason: 'read_failed',
        error: error_ instanceof Error ? error_.message : String(error_)
      });
      if (!deps.queue) {
        throw windowReadFailed(error_);
      }
      await scheduleSubscriptionSync(subscription, event.selection);
      return;
    }
    await applyVerificationState(deps, {
      ...read,
      keepMutationWindow: true,
      providerEventId: event.providerEventId ? `${event.providerEventId}#window-read` : undefined
    });
    await closeMutationWindow(deps, subscription.id, readMutationStartedAt(subscription));
  }

  /**
   * Applies the provider state a committed provider mutation (cancel, change,
   * resume, refund) returned. `committedAt` is taken as soon as the provider
   * call returns, before any other write.
   * Retained events that cannot be replayed now do not fail the mutation; with a
   * queue and a provider that supports sync, a subscription-sync job is enqueued
   * to replay them. When a provider event was applied while the mutation was in
   * flight, the subscription is reconciled with an authoritative provider read.
   */
  async function applyMutationProviderState(
    input: ApplyVerificationStateInput & { occurredAt?: undefined; liveStateObservedAt: string; committedAt: string }
  ) {
    const projection = await applyLiveProviderState(deps, input, { onReplayDeferred: scheduleSubscriptionSync });
    if (!projection.providerStateRaced) {
      return projection;
    }
    deps.metrics.track('subscription.mutation.raced_event', {
      provider: projection.subscription.provider,
      subscriptionId: projection.subscription.id
    });
    return (await reconcileCommittedMutation(projection.subscription, projection.providerStateRaced.priceId)) ?? projection;
  }

  /**
   * Reads the subscription from the provider after a mutation an event raced:
   * a queued sync job when a queue is configured, otherwise an inline sync. It
   * never repeats the mutation and never fails it. Returns the inline result.
   * The price the raced event wrote is the read's candidate (`fetchLiveSubscription`).
   */
  async function reconcileCommittedMutation(subscription: BillFnSubscription, racedPriceId: string): Promise<ProjectionResult | null> {
    const candidate = findCatalogPriceReference(deps.catalog, subscription.provider, [racedPriceId]) ?? undefined;
    try {
      if (deps.queue) {
        await scheduleSubscriptionSync(subscription, candidate);
        return null;
      }
      if (typeof deps.providers[subscription.provider]?.fetchSubscription !== 'function') {
        return null;
      }
      return await applyLiveProviderState(deps, await readProviderSubscription(subscription.id, candidate));
    } catch (error) {
      deps.metrics.track('subscription.mutation.reconcile_failed', {
        provider: subscription.provider,
        subscriptionId: subscription.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /** Loads the caller's subscription, plan and price for a subscription mutation. */
  async function loadMutationSubscription(input: { subject?: BillableSubject; subscriptionId?: string }) {
    const subject = requireSubject(input.subject);
    const { billingAccount } = await getOrCreateBillingAccount(deps, subject);
    const subscription = await getSubscriptionForAccount(deps, billingAccount.id, input.subscriptionId);
    if (!subscription) {
      throw createBillFnError({
        code: 'BILLFN_NOT_FOUND',
        message: 'Subscription not found'
      });
    }
    const plan = requirePlan(deps.catalog, subscription.planKey);
    const price = requirePriceById(plan, subscription.priceId);
    return { billingAccount, subscription, plan, price };
  }

  /**
   * Completes a committed cancel, change or resume: applies the state the
   * provider returned (or keeps the stored subscription and entitlements when it
   * returned none) and records the requested billing event.
   */
  async function finishSubscriptionMutation(input: {
    billingAccount: BillFnBillingAccount;
    subscription: BillFnSubscription;
    plan: ReturnType<typeof requirePlan>;
    price: BillFnPriceDefinition;
    entitlementPlan: ReturnType<typeof requirePlan>;
    operation: Pick<BillFnProviderOperationResult, 'operationStatus' | 'billingState'> &
      Partial<Pick<BillFnProviderOperationResult, 'clientAction'>>;
    liveStateObservedAt: string;
    /** When the provider call returned, taken before any other write; the mutation's commit time. */
    timestamp: string;
    eventType: string;
    eventPayload: Record<string, unknown>;
  }) {
    const { billingAccount, subscription, operation } = input;
    const projection = operation.billingState
      ? await applyMutationProviderState({
          billingAccount,
          plan: input.plan,
          price: input.price,
          subscription,
          state: operation.billingState,
          liveStateObservedAt: input.liveStateObservedAt,
          committedAt: input.timestamp
        })
      : {
          subscription,
          entitlements:
            (await findEntitlementSnapshot(deps, billingAccount.id)) ??
            (await upsertEntitlements(deps, billingAccount.id, input.entitlementPlan, subscription, input.timestamp))
        };
    await recordBillingEvent(deps, {
      id: deps.generateId('evt'),
      billingAccountId: billingAccount.id,
      type: input.eventType,
      payload: { subscriptionId: subscription.id, ...input.eventPayload, operationStatus: operation.operationStatus },
      createdAt: input.timestamp
    });
    return {
      subscription: projection.subscription,
      entitlements: projection.entitlements,
      operationStatus: operation.operationStatus,
      clientAction: operation.clientAction
    };
  }

  /** `candidate` is the catalog price an unreconciled window event names; the job reads it if the stored one fails. */
  async function scheduleSubscriptionSync(subscription: BillFnSubscription, candidate?: CatalogSelection) {
    if (!deps.queue || typeof deps.providers[subscription.provider]?.fetchSubscription !== 'function') {
      return;
    }
    await enqueueReconciliationJobInternal({
      kind: 'subscription-sync',
      provider: subscription.provider,
      billingAccountId: subscription.billingAccountId,
      subscriptionId: subscription.id,
      payload: candidate ? { candidatePriceId: candidate.price.priceId } : undefined
    });
  }

  async function createReconciliationJobRecord(input: {
    jobId?: string;
    kind: BillFnReconciliationJobKind;
    provider?: BillingProviderName;
    billingAccountId?: string;
    subscriptionId?: string;
    providerEventId?: string;
    cursor?: string;
    payload?: Record<string, unknown>;
  }) {
    const timestamp = toIsoString(deps.now());
    const job: BillFnReconciliationJob = {
      id: input.jobId ?? deps.generateId('rcj'),
      kind: input.kind,
      status: 'pending',
      provider: input.provider,
      billingAccountId: input.billingAccountId,
      subscriptionId: input.subscriptionId,
      providerEventId: input.providerEventId,
      cursor: input.cursor,
      attempts: 0,
      payload: input.payload,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await deps.db.create({
      model: TABLES.reconciliationJobs,
      data: job,
      namespace: deps.namespace
    });
    return job;
  }

  async function enqueueReconciliationJobInternal(
    input: BillFnEnqueueReconciliationJobRequest & { jobId?: string }
  ) {
    const job = await createReconciliationJobRecord(input);
    const queuedJob = jobToQueuePayload(job);
    if (deps.queue) {
      await deps.queue.enqueue(RECONCILIATION_QUEUE, queuedJob);
    }
    await recordBillingEvent(deps, {
      id: deps.generateId('evt'),
      billingAccountId: input.billingAccountId ?? 'ops',
      type: `billfn.reconciliation.${job.kind}.queued`,
      payload: {
        jobId: job.id,
        provider: job.provider,
        subscriptionId: job.subscriptionId,
        providerEventId: job.providerEventId
      },
      createdAt: toIsoString(deps.now())
    });
    return job;
  }

  /** `onLeaseRenewed` runs after every renewal of the job's processing lease. */
  async function runReconciliationJobInternal(jobId: string, onLeaseRenewed?: ReconciliationLeaseGuard) {
    let job = await getReconciliationJobRecord(deps, jobId);
    if (!job) {
      throw createBillFnError({
        code: 'BILLFN_NOT_FOUND',
        message: 'Reconciliation job not found'
      });
    }
    if (job.status === 'succeeded') {
      return job;
    }
    const claimTime = deps.now();
    const previousUpdatedAt = Date.parse(job.updatedAt);
    const runningClaimIsFresh =
      job.status === 'running' &&
      Number.isFinite(previousUpdatedAt) &&
      claimTime.getTime() - previousUpdatedAt < RECONCILIATION_JOB_CLAIM_LEASE_MS;
    if (runningClaimIsFresh) {
      throw reconciliationLeaseConflict('Reconciliation job is already running');
    }

    const runningAt = toIsoString(claimTime);
    const attempts = job.attempts + 1;
    const claimed = await deps.db.updateMany({
      model: TABLES.reconciliationJobs,
      where: [
        { field: 'id', operator: 'eq', value: job.id },
        { field: 'status', operator: 'eq', value: job.status },
        { field: 'updatedAt', operator: 'eq', value: job.updatedAt }
      ],
      data: {
        status: 'running',
        attempts,
        error: undefined,
        updatedAt: runningAt
      },
      namespace: deps.namespace
    });
    if (claimed !== 1) {
      const current = await getReconciliationJobRecord(deps, job.id);
      if (current?.status === 'succeeded') {
        return current;
      }
      throw reconciliationLeaseConflict('Reconciliation job was claimed by another runner');
    }
    job = {
      ...job,
      status: 'running',
      attempts,
      error: undefined,
      updatedAt: runningAt
    };

    const assertLease = async () => {
      await renewReconciliationJobLease(deps, job.id, attempts);
      await onLeaseRenewed?.();
    };
    try {
      await assertLease();
      await processReconciliationJob(deps, job, assertLease);
      await assertLease();
      const completedAt = toIsoString(deps.now());
      const finalized = await deps.db.updateMany({
        model: TABLES.reconciliationJobs,
        where: [
          { field: 'id', operator: 'eq', value: job.id },
          { field: 'status', operator: 'eq', value: 'running' },
          { field: 'attempts', operator: 'eq', value: attempts }
        ],
        data: {
          status: 'succeeded',
          completedAt,
          updatedAt: completedAt
        },
        namespace: deps.namespace
      });
      if (finalized !== 1) {
        throw reconciliationLeaseConflict('Reconciliation job processing lease was lost before finalization');
      }
      const completedJob: BillFnReconciliationJob = {
        ...job,
        status: 'succeeded',
        completedAt,
        updatedAt: completedAt
      };
      return completedJob;
    } catch (error) {
      let failed = 0;
      try {
        failed = await deps.db.updateMany({
          model: TABLES.reconciliationJobs,
          where: [
            { field: 'id', operator: 'eq', value: job.id },
            { field: 'status', operator: 'eq', value: 'running' },
            { field: 'attempts', operator: 'eq', value: attempts }
          ],
          data: {
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
            updatedAt: toIsoString(deps.now())
          },
          namespace: deps.namespace
        });
      } finally {
        if (
          failed === 1 &&
          (job.kind === 'webhook-event' || job.kind === 'webhook-replay') &&
          job.provider &&
          job.providerEventId
        ) {
          await releaseWebhookReceiptClaim(
            deps,
            buildWebhookReceiptId(job.provider, job.providerEventId),
            buildReconciliationReceiptClaimId(job),
            { allowProcessed: job.kind === 'webhook-replay' }
          );
        }
      }
      throw error;
    }
  }

  const service = {
    namespace,
    async getCatalog() {
      return deps.catalog;
    },
    async createCheckout(input: BillFnCheckoutCreateRequest): Promise<BillFnCreateCheckoutResponse> {
      const subject = requireSubject(input.subject);
      const { billingAccount } = await getOrCreateBillingAccount(deps, subject);
      const plan = requirePlan(deps.catalog, input.planKey);
      const price = requirePrice(plan, input.provider, input.interval);
      const provider = requireProvider(deps, input.provider, 'createCheckout');
      const checkoutSessionId = deps.generateId('chk');
      const timestamp = toIsoString(deps.now());

      const created = await createCheckoutSessionRecord(deps, {
        checkoutSessionId,
        billingAccountId: billingAccount.id,
        planKey: plan.planKey,
        priceId: price.priceId,
        provider: price.provider,
        status: 'pending',
        metadata: input.metadata,
        createdAt: timestamp,
        updatedAt: timestamp
      });

      const providerResult = await provider.createCheckout({
        checkoutSessionId,
        billingAccount,
        plan,
        price,
        metadata: input.metadata,
        customer: input.customer,
        returnUrl: input.returnUrl,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl
      });

      const checkoutSession = await updateCheckoutSession(deps, checkoutSessionId, {
        providerCheckoutId: providerResult.providerCheckoutId,
        providerSubscriptionId: providerResult.providerSubscriptionId,
        providerChargeId: providerResult.providerChargeId,
        status: providerResult.status,
        checkoutUrl: providerResult.checkoutUrl,
        clientAction: providerResult.clientAction,
        metadata: mergeJson(created.metadata, providerResult.raw),
        updatedAt: timestamp
      });

      deps.metrics.track('checkout.created', {
        provider: input.provider,
        planKey: input.planKey
      });

      const response: BillFnCreateCheckoutResponseData = {
        checkoutSession,
        billingAccount,
        plan: {
          planKey: plan.planKey,
          productKey: plan.productKey,
          displayName: plan.displayName
        }
      };

      return ok(response);
    },
    async verifyCheckout(input: BillFnVerifyCheckoutRequest): Promise<BillFnVerifyCheckoutResponse> {
      const checkoutSession = await getCheckoutSession(deps, input.checkoutSessionId);
      if (!checkoutSession) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'Checkout session not found'
        });
      }

      const subject = requireSubject(input.subject);
      const { billingAccount } = await getOrCreateBillingAccount(deps, subject);
      if (billingAccount.id !== checkoutSession.billingAccountId) {
        throw createBillFnError({
          code: 'BILLFN_CONFLICT',
          message: 'Checkout session does not belong to the resolved billing account'
        });
      }

      const plan = requirePlan(deps.catalog, checkoutSession.planKey);
      const price = requirePriceById(plan, checkoutSession.priceId);
      const provider = requireProvider(deps, checkoutSession.provider, 'verifyCheckout');
      // Events that occurred before this live read are already reflected in its state.
      const verificationObservedAt = toIsoString(deps.now());
      const verification = await provider.verifyCheckout({
        checkoutSession,
        billingAccount,
        plan,
        price,
        payload: input.payload
      });

      const result = await applyLiveProviderState(deps, {
        billingAccount,
        plan,
        price,
        checkoutSession,
        state: verification,
        liveStateObservedAt: verificationObservedAt
      });

      if (!result.checkoutSession) {
        throw createBillFnError({
          code: 'BILLFN_INTERNAL_ERROR',
          message: 'Checkout verification completed without a checkout session snapshot'
        });
      }

      return ok({
        checkoutSession: result.checkoutSession,
        subscription: result.subscription,
        entitlements: result.entitlements
      });
    },
    async cancelSubscription(input: BillFnCancelSubscriptionRequest): Promise<BillFnCancelSubscriptionResponse> {
      const { billingAccount, subscription, plan, price } = await loadMutationSubscription(input);
      const provider = requireProvider(deps, subscription.provider, 'cancelSubscription');
      const liveStateObservedAt = toIsoString(deps.now());
      const operation = (await provider.cancelSubscription({
        subscription,
        reason: input.reason
      })) ?? {
        operationStatus: 'applied',
        billingState: {
          subscriptionStatus: 'canceled',
          checkoutStatus: 'succeeded',
          providerSubscriptionId: subscription.providerSubscriptionId,
          providerChargeId: subscription.providerChargeId,
          autoRenew: false,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd
        }
      };
      const committedAt = toIsoString(deps.now());

      return ok(
        await finishSubscriptionMutation({
          billingAccount,
          subscription,
          plan,
          price,
          entitlementPlan: plan,
          operation,
          liveStateObservedAt,
          timestamp: committedAt,
          eventType: 'billfn.subscription.cancel.requested',
          eventPayload: { reason: input.reason }
        })
      );
    },
    async changeSubscription(input: BillFnChangeSubscriptionRequest): Promise<BillFnChangeSubscriptionResponse> {
      const {
        billingAccount,
        subscription,
        plan: currentPlan,
        price: currentPrice
      } = await loadMutationSubscription(input);
      const target = requirePriceReference(deps.catalog, input.targetPriceId);
      if (target.price.provider !== subscription.provider) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Target price provider must match the active subscription provider',
          details: {
            subscriptionProvider: subscription.provider,
            targetProvider: target.price.provider,
            targetPriceId: target.price.priceId
          }
        });
      }
      const provider = requireProvider(deps, subscription.provider, 'changeSubscription');
      const effectiveAt = input.effectiveAt ?? 'immediate';
      const prorationBehavior = input.prorationBehavior ?? 'provider_default';
      const liveStateObservedAt = toIsoString(deps.now());
      const operation = await provider.changeSubscription({
        subscription,
        currentPlan,
        currentPrice,
        targetPlan: target.plan,
        targetPrice: target.price,
        effectiveAt,
        prorationBehavior,
        reason: input.reason
      });

      const timestamp = toIsoString(deps.now());
      const changeRequest = await createSubscriptionChangeRequestRecord(deps, {
        billingAccountId: billingAccount.id,
        subscriptionId: subscription.id,
        provider: subscription.provider,
        currentPriceId: subscription.priceId,
        targetPriceId: target.price.priceId,
        effectiveAt,
        prorationBehavior,
        status: operation.operationStatus === 'applied' ? 'applied' : 'requires_action',
        operationStatus: operation.operationStatus,
        clientAction: operation.clientAction,
        metadata: operation.raw,
        createdAt: timestamp,
        updatedAt: timestamp
      });

      const appliesTargetImmediately = operation.operationStatus === 'applied' && effectiveAt === 'immediate';
      const result = await finishSubscriptionMutation({
        billingAccount,
        subscription,
        plan: appliesTargetImmediately ? target.plan : currentPlan,
        price: appliesTargetImmediately ? target.price : currentPrice,
        entitlementPlan: currentPlan,
        operation,
        liveStateObservedAt,
        timestamp,
        eventType: 'billfn.subscription.change.requested',
        eventPayload: { currentPriceId: currentPrice.priceId, targetPriceId: target.price.priceId }
      });
      return ok({ ...result, changeRequest });
    },
    async resumeSubscription(input: BillFnResumeSubscriptionRequest): Promise<BillFnResumeSubscriptionResponse> {
      const { billingAccount, subscription, plan, price } = await loadMutationSubscription(input);
      const provider = requireProvider(deps, subscription.provider, 'resumeSubscription');
      const liveStateObservedAt = toIsoString(deps.now());
      const operation = await provider.resumeSubscription({
        subscription
      });
      const committedAt = toIsoString(deps.now());

      return ok(
        await finishSubscriptionMutation({
          billingAccount,
          subscription,
          plan,
          price,
          entitlementPlan: plan,
          operation,
          liveStateObservedAt,
          timestamp: committedAt,
          eventType: 'billfn.subscription.resume.requested',
          eventPayload: {}
        })
      );
    },
    async refundCharge(input: BillFnRefundChargeRequest): Promise<BillFnRefundChargeResponse> {
      const subject = requireSubject(input.subject);
      const { billingAccount } = await getOrCreateBillingAccount(deps, subject);
      const subscription = input.subscriptionId
        ? await getSubscriptionForAccount(deps, billingAccount.id, input.subscriptionId)
        : await findActiveSubscription(deps, billingAccount.id);
      if (!subscription) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'Subscription not found for refund'
        });
      }
      if (input.providerChargeId && input.providerChargeId !== subscription.providerChargeId) {
        throw createBillFnError({
          code: 'BILLFN_CONFLICT',
          message: 'Refund charge does not belong to the resolved subscription'
        });
      }
      const providerName = subscription.provider;
      const provider = requireProvider(deps, providerName, 'refundCharge');
      const mode = input.mode ?? 'full';
      const providerChargeId = input.providerChargeId ?? subscription.providerChargeId;
      const liveStateObservedAt = toIsoString(deps.now());
      const operation = await provider.refundCharge({
        subscription,
        billingAccount,
        providerChargeId,
        mode,
        amount: input.amount,
        reason: input.reason
      });

      const timestamp = toIsoString(deps.now());
      const refund = await createRefundRecord(deps, {
        billingAccountId: billingAccount.id,
        subscriptionId: subscription.id,
        provider: providerName,
        providerChargeId,
        providerRefundId: operation.providerRefundId,
        mode,
        amount: input.amount,
        currency: requirePriceById(requirePlan(deps.catalog, subscription.planKey), subscription.priceId).currency,
        reason: input.reason,
        status: operation.operationStatus === 'applied' ? 'succeeded' : 'requires_action',
        operationStatus: operation.operationStatus,
        metadata: operation.raw,
        createdAt: timestamp,
        updatedAt: timestamp
      });

      let projectedSubscription: BillFnSubscription | null = subscription;
      let projectedEntitlements = await findEntitlementSnapshot(deps, billingAccount.id);
      if (subscription && operation.billingState) {
        const plan = requirePlan(deps.catalog, subscription.planKey);
        const price = requirePriceById(plan, subscription.priceId);
        const projection = await applyMutationProviderState({
          billingAccount,
          plan,
          price,
          subscription,
          state: operation.billingState,
          liveStateObservedAt,
          committedAt: timestamp
        });
        projectedSubscription = projection.subscription;
        projectedEntitlements = projection.entitlements;
      }

      await recordBillingEvent(deps, {
        id: deps.generateId('evt'),
        billingAccountId: billingAccount.id,
        type: 'billfn.refund.requested',
        payload: {
          refundId: refund.id,
          subscriptionId: subscription?.id,
          operationStatus: operation.operationStatus,
          mode
        },
        createdAt: timestamp
      });

      return ok({
        refund,
        subscription: projectedSubscription,
        entitlements: projectedEntitlements,
        operationStatus: operation.operationStatus,
        clientAction: operation.clientAction
      });
    },
    async syncSubscription(input: BillFnSyncSubscriptionRequest): Promise<BillFnSyncSubscriptionResponse> {
      const subject = requireSubject(input.subject);
      const { billingAccount } = await getOrCreateBillingAccount(deps, subject);
      const subscription = await getSubscriptionForAccount(deps, billingAccount.id, input.subscriptionId);
      if (!subscription) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'Subscription not found'
        });
      }

      const applied = await syncSubscriptionById(subscription.id);

      const response: BillFnSyncSubscriptionResponseData = {
        subscription: applied.subscription,
        entitlements: applied.entitlements
      };
      return ok(response);
    },
    async restorePurchases(input: BillFnRestorePurchasesRequest): Promise<BillFnRestorePurchasesResponse> {
      const subject = requireSubject(input.subject);
      const { billingAccount } = await getOrCreateBillingAccount(deps, subject);
      const plan = requirePlan(deps.catalog, input.planKey);
      const checkoutSession = await findCheckoutSessionByProviderRef(
        deps,
        input.provider,
        undefined,
        undefined,
        input.purchaseReference
      );
      const matchingPrices = plan.prices.filter((candidate) => candidate.provider === input.provider);
      const price = input.priceId
        ? requirePriceById(plan, input.priceId)
        : checkoutSession
          ? requirePriceById(plan, checkoutSession.priceId)
          : matchingPrices.length === 1
            ? matchingPrices[0]
            : undefined;
      if (!price || price.provider !== input.provider) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Restore purchases requires a priceId when the provider has multiple matching prices',
          details: {
            provider: input.provider,
            priceId: input.priceId,
            matchingPriceIds: matchingPrices.map((candidate) => candidate.priceId)
          }
        });
      }
      const provider = requireProvider(deps, input.provider, 'restorePurchases');
      // Events that occurred before this live read are already reflected in its state.
      const restoreObservedAt = toIsoString(deps.now());
      const states = await provider.restorePurchases({
        billingAccount,
        plan,
        price,
        purchaseReference: input.purchaseReference,
        payload: input.payload
      });

      if (states.length === 0) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'No purchases were restored'
        });
      }

      for (const state of states) {
        const projection = await resolveProjectionContextForProviderState(deps, {
          provider: input.provider,
          state,
          checkoutReferenceId: input.purchaseReference
        });

        if (!projection) {
          const applied = await applyLiveProviderState(deps, {
            billingAccount,
            plan,
            price,
            state,
            liveStateObservedAt: restoreObservedAt
          });
          const response: BillFnRestorePurchasesResponseData = {
            subscription: applied.subscription,
            entitlements: applied.entitlements
          };
          return ok(response);
        }

        if (projection.billingAccount.id !== billingAccount.id) {
          continue;
        }

        const applied = await applyLiveProviderState(deps, {
          billingAccount: projection.billingAccount,
          plan: projection.plan,
          price: projection.price,
          checkoutSession: projection.checkoutSession ?? undefined,
          subscription: projection.subscription ?? undefined,
          state,
          liveStateObservedAt: restoreObservedAt
        });

        const response: BillFnRestorePurchasesResponseData = {
          subscription: applied.subscription,
          entitlements: applied.entitlements
        };
        return ok(response);
      }

      throw createBillFnError({
        code: 'BILLFN_CONFLICT',
        message: 'No restored purchase could be linked to the resolved billing account'
      });
    },
    async getEntitlements(subject: BillableSubject): Promise<BillFnEntitlementsResponse> {
      const resolved = await resolveBillingAccountReference(deps, requireSubject(subject));
      const billingAccount = await getBillingAccountById(deps, resolved.billingAccountId);
      if (!billingAccount) {
        return ok({
          billingAccount: buildVirtualBillingAccount(resolved, deps),
          entitlements: null,
          subscription: null
        });
      }
      const entitlements = await findEntitlementSnapshot(deps, billingAccount.id);
      const subscription = await findActiveSubscription(deps, billingAccount.id);
      const response: BillFnEntitlementsResponseData = {
        billingAccount,
        entitlements,
        subscription
      };
      return ok(response);
    },
    async getUsage(subject: BillableSubject, resource?: string): Promise<BillFnUsageResponse> {
      const resolved = await resolveBillingAccountReference(deps, requireSubject(subject));
      const billingAccount = await getBillingAccountById(deps, resolved.billingAccountId);
      const entitlements = billingAccount ? await findEntitlementSnapshot(deps, billingAccount.id) : null;
      const meters = billingAccount
        ? resource
          ? await findUsageMeters(deps, billingAccount.id, resource)
          : await deps.db.findMany<BillFnUsageMeter>({
              model: TABLES.usageMeters,
              where: [{ field: 'billingAccountId', operator: 'eq', value: billingAccount.id }],
              namespace: deps.namespace
            })
        : [];
      const usage = meters.map((meter) => ({
        resource: meter.resource,
        current: meter.current,
        limit: entitlements?.limits[meter.resource] ?? 0
      }));
      const response: BillFnUsageResponseData = {
        billingAccount: billingAccount ?? buildVirtualBillingAccount(resolved, deps),
        usage
      };
      return ok(response);
    },
    async handleWebhook(input: BillFnWebhookRequest): Promise<BillFnWebhookResponse> {
      const provider = requireProvider(deps, input.provider, 'parseWebhook');
      const events = await provider.parseWebhook({
        headers: input.headers,
        rawBody: input.rawBody
      });
      let processed = 0;

      for (const event of events) {
        if (!event.signatureVerified) {
          deps.metrics.track('webhook.signature.invalid', {
            provider: input.provider
          });
          throw createBillFnError({
            code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID',
            message: 'Webhook signature verification failed'
          });
        }

        const receiptId = buildWebhookReceiptId(input.provider, event.providerEventId);
        const receipt: BillFnWebhookReceipt = {
          id: receiptId,
          provider: input.provider,
          providerEventId: event.providerEventId,
          eventType: event.type,
          signatureVerified: event.signatureVerified,
          rawPayload: {
            raw: event.raw,
            parsed: serializeParsedWebhookEvent(event)
          },
          createdAt: toIsoString(deps.now()),
          processingJobId: null,
          processingClaimedAt: null,
          processedAt: null
        };
        let existingReceipt: BillFnWebhookReceipt | null = null;
        try {
          await deps.db.create({
            model: TABLES.webhookReceipts,
            data: receipt,
            namespace: deps.namespace
          });
        } catch (error) {
          if (!isDuplicateRecordError(error)) {
            throw error;
          }
          existingReceipt = await deps.db.findOne<BillFnWebhookReceipt>({
            model: TABLES.webhookReceipts,
            where: [{ field: 'id', operator: 'eq', value: receiptId }],
            namespace: deps.namespace
          });
          if (!existingReceipt) {
            throw error;
          }
          if (existingReceipt.processedAt) {
            continue;
          }
        }

        const jobId = deps.generateId('rcj');
        if (!(await claimWebhookReceipt(deps, receiptId, jobId))) {
          continue;
        }

        if (existingReceipt) {
          await deps.db.update({
            model: TABLES.webhookReceipts,
            where: [
              { field: 'id', operator: 'eq', value: receiptId },
              { field: 'processingJobId', operator: 'eq', value: jobId }
            ],
            data: {
              eventType: receipt.eventType,
              signatureVerified: receipt.signatureVerified,
              rawPayload: receipt.rawPayload
            },
            namespace: deps.namespace
          });
        }

        try {
          const job = await enqueueReconciliationJobInternal({
            jobId,
            kind: 'webhook-event',
            provider: input.provider,
            providerEventId: event.providerEventId,
            payload: {
              parsedEvent: serializeParsedWebhookEvent(event)
            }
          });

          if (!deps.queue) {
            await runReconciliationJobInternal(job.id);
          }
        } catch (error) {
          await deps.db.updateMany({
            model: TABLES.reconciliationJobs,
            where: [{ field: 'id', operator: 'eq', value: jobId }],
            data: {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
              updatedAt: toIsoString(deps.now())
            },
            namespace: deps.namespace
          });
          await releaseWebhookReceiptClaim(deps, receiptId, jobId);
          throw error;
        }

        processed += 1;
      }

      const response: BillFnWebhookResponseData = {
        accepted: true,
        processed
      };
      return ok(response);
    },
    async enqueueReconciliationJob(input: BillFnEnqueueReconciliationJobRequest): Promise<BillFnReconciliationJobResponse> {
      if (input.kind === 'webhook-event') {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'webhook-event jobs are created by webhook ingestion; use webhook-replay for operations reprocessing'
        });
      }
      const job = await enqueueReconciliationJobInternal(input);
      return ok({ job });
    },
    async getReconciliationJob(input: BillFnGetReconciliationJobRequest): Promise<BillFnReconciliationJobResponse> {
      const job = await getReconciliationJobRecord(deps, input.jobId);
      if (!job) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'Reconciliation job not found'
        });
      }
      return ok({ job });
    },
    async runReconciliationJob(input: BillFnRunReconciliationJobRequest): Promise<BillFnReconciliationJobResponse> {
      const job = await runReconciliationJobInternal(input.jobId);
      return ok({ job });
    },
    subscriptionProvider,
    quotaProvider
  };
  return { service, now, runReconciliationJob: runReconciliationJobInternal };
}

const RECONCILIATION_QUEUE = 'billfn-reconciliation';

function hasErrorCode(error: unknown, code: string): boolean {
  return (error as { code?: unknown } | null)?.code === code;
}

function isQueueLeaseLost(error: unknown): boolean {
  return hasErrorCode(error, 'FLOWFN_QUEUE_JOB_NOT_LEASED');
}

export function createBillFnReconciliationWorker(config: BillFnConfig) {
  const { service, now, runReconciliationJob } = createBillFnServiceWithInternals(config);
  const queue = config.queue;

  async function runQueuedJob(job: BillFnQueuedJob, onLeaseRenewed?: ReconciliationLeaseGuard) {
    if (job.jobId) {
      return runReconciliationJob(job.jobId, onLeaseRenewed);
    }

    const enqueued = await service.enqueueReconciliationJob({
      kind: job.type,
      provider: 'provider' in job ? job.provider : undefined,
      billingAccountId: 'billingAccountId' in job ? job.billingAccountId : undefined,
      subscriptionId: 'subscriptionId' in job ? job.subscriptionId : undefined,
      providerEventId: 'providerEventId' in job ? job.providerEventId : undefined,
      cursor: 'cursor' in job ? job.cursor : undefined
    });
    if (!enqueued.ok) {
      return null;
    }
    return runReconciliationJob(enqueued.data.job.id, onLeaseRenewed);
  }

  return {
    async run(job: BillFnQueuedJob) {
      return runQueuedJob(job);
    },
    async runNext() {
      if (!queue) {
        return null;
      }
      const claimed = await queue.claim(RECONCILIATION_QUEUE, { leaseMs: RECONCILIATION_JOB_CLAIM_LEASE_MS });
      if (!claimed) {
        return null;
      }
      const fence = { attempt: claimed.attempt };
      // Every renewal of the job's processing lease also extends the queue
      // lease, so the message stays leased at least as long as the job is.
      const extendQueueLease = async () => {
        try {
          await queue.extendLease(claimed.id, RECONCILIATION_JOB_CLAIM_LEASE_MS, fence);
        } catch (error) {
          // Another worker reclaimed the message; it retries until this run ends.
          if (!isQueueLeaseLost(error)) {
            throw error;
          }
        }
      };

      let result: BillFnReconciliationJob | null;
      try {
        result = await runQueuedJob(claimed.payload, extendQueueLease);
      } catch (error) {
        // The queue rejects an empty dead-letter reason, which would mask the run's error.
        const reason =
          (error instanceof Error ? error.message || error.name : String(error)) || 'reconciliation run failed';
        try {
          if (isProductiveReplayBound(error)) {
            // A replay that finished events before its bound continues in a fresh message, so a long
            // backlog never uses up the lease-conflict budget; one that finished none counts against it.
            await queue.enqueue(RECONCILIATION_QUEUE, claimed.payload);
            await queue.ack(claimed.id, fence);
          } else if (
            isReconciliationLeaseConflict(error) &&
            claimed.attempt < RECONCILIATION_QUEUE_MAX_LEASE_CONFLICT_ATTEMPTS
          ) {
            // Another runner holds or took over the job's processing lease; retry once it has finished or expired.
            await queue.fail(claimed.id, {
              retryAt: now().getTime() + RECONCILIATION_JOB_CLAIM_LEASE_MS,
              reason,
              ...fence
            });
          } else {
            // Failed runs, including domain conflicts, are not redelivered; the
            // reconciliation job record keeps its own status.
            await queue.fail(claimed.id, { deadLetter: true, reason, ...fence });
          }
        } catch (queueError) {
          // A lost lease means another worker owns the message; report the run's own error.
          if (!isQueueLeaseLost(queueError)) {
            throw queueError;
          }
        }
        throw error;
      }

      try {
        await queue.ack(claimed.id, fence);
      } catch (error) {
        // The run finished; a worker that reclaimed the message finds the job done and acks it.
        if (!isQueueLeaseLost(error)) {
          throw error;
        }
      }
      return result;
    }
  };
}

async function processReconciliationJob(
  deps: ServiceDeps,
  job: BillFnReconciliationJob,
  assertLease: ReconciliationLeaseGuard
) {
  switch (job.kind) {
    case 'webhook-event':
    case 'webhook-replay': {
      if (!job.provider || !job.providerEventId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Webhook reconciliation requires provider and providerEventId'
        });
      }
      const receipt = await deps.db.findOne<BillFnWebhookReceipt>({
        model: TABLES.webhookReceipts,
        where: [
          { field: 'provider', operator: 'eq', value: job.provider },
          { field: 'providerEventId', operator: 'eq', value: job.providerEventId }
        ],
        namespace: deps.namespace
      });
      if (!receipt) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'Webhook receipt not found'
        });
      }
      if (receipt.processedAt && job.kind === 'webhook-event') {
        return;
      }
      await assertLease();
      const receiptClaimId = buildReconciliationReceiptClaimId(job);
      const claimedReceipt = await claimWebhookReceipt(deps, receipt.id, receiptClaimId, {
        allowProcessed: job.kind === 'webhook-replay',
        currentOwnerId: job.kind === 'webhook-event' ? job.id : undefined
      });
      if (!claimedReceipt) {
        return;
      }
      const parsed = deserializeParsedWebhookEvent(asRecord(receipt.rawPayload)?.parsed);
      if (parsed?.billingState) {
        await assertLease();
        await processParsedWebhookEvent(deps, job.provider, parsed);
      }
      await assertLease();
      const finalized = await deps.db.updateMany({
        model: TABLES.webhookReceipts,
        where: [
          { field: 'id', operator: 'eq', value: receipt.id },
          { field: 'processingJobId', operator: 'eq', value: receiptClaimId }
        ],
        data: {
          processingJobId: null,
          processingClaimedAt: null,
          processedAt: toIsoString(deps.now())
        },
        namespace: deps.namespace
      });
      if (finalized !== 1) {
        throw createBillFnError({
          code: 'BILLFN_CONFLICT',
          message: 'Webhook receipt processing lease was lost before finalization'
        });
      }
      return;
    }
    case 'subscription-sync': {
      if (!job.subscriptionId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Subscription sync job requires subscriptionId'
        });
      }
      const candidatePriceId = readString(job.payload ?? {}, 'candidatePriceId');
      await syncSubscriptionByIdForJob(deps, job.subscriptionId, assertLease, candidatePriceId);
      return;
    }
    case 'account-scan': {
      if (!job.billingAccountId) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Account scan job requires billingAccountId'
        });
      }
      const where: WhereClause[] = [{ field: 'billingAccountId', operator: 'eq', value: job.billingAccountId }];
      if (job.provider) {
        where.push({ field: 'provider', operator: 'eq', value: job.provider });
      }
      const subscriptions = await deps.db.findMany<BillFnSubscription>({
        model: TABLES.subscriptions,
        where,
        orderBy: [{ field: 'updatedAt', direction: 'desc' }],
        namespace: deps.namespace
      });
      for (const subscription of subscriptions) {
        await syncSubscriptionByIdForJob(deps, subscription.id, assertLease);
      }
      return;
    }
    case 'notification-history-backfill': {
      if (!job.provider) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: 'Notification history backfill requires provider'
        });
      }
      const provider = requireProvider(deps, job.provider, 'fetchNotificationHistory');
      const cursorKey = 'default';
      const cursorRecord = await findReconciliationCursor(deps, job.provider, cursorKey);
      const history = await provider.fetchNotificationHistory({
        cursor: job.cursor ?? cursorRecord?.cursor,
        limit: 20
      } satisfies BillFnFetchNotificationHistoryInput);
      await assertLease();
      const receiptClaimId = buildReconciliationReceiptClaimId(job);

      for (const event of history.events) {
        await assertLease();
        const receiptId = buildWebhookReceiptId(job.provider, event.providerEventId);
        const receipt: BillFnWebhookReceipt = {
          id: receiptId,
          provider: job.provider,
          providerEventId: event.providerEventId,
          eventType: event.type,
          signatureVerified: event.signatureVerified,
          rawPayload: {
            raw: event.raw,
            parsed: serializeParsedWebhookEvent(event)
          },
          createdAt: toIsoString(deps.now()),
          processingJobId: null,
          processingClaimedAt: null,
          processedAt: null
        };
        if (!event.signatureVerified) {
          throw createBillFnError({
            code: 'BILLFN_WEBHOOK_SIGNATURE_INVALID',
            message: 'Notification history event signature verification failed'
          });
        }
        let existingReceipt = await deps.db.findOne<BillFnWebhookReceipt>({
          model: TABLES.webhookReceipts,
          where: [{ field: 'id', operator: 'eq', value: receiptId }],
          namespace: deps.namespace
        });
        if (existingReceipt?.processedAt) {
          continue;
        }
        if (!existingReceipt) {
          try {
            await deps.db.create({
              model: TABLES.webhookReceipts,
              data: receipt,
              namespace: deps.namespace
            });
          } catch (error) {
            if (!isDuplicateRecordError(error)) {
              throw error;
            }
            existingReceipt = await deps.db.findOne<BillFnWebhookReceipt>({
              model: TABLES.webhookReceipts,
              where: [{ field: 'id', operator: 'eq', value: receiptId }],
              namespace: deps.namespace
            });
            if (!existingReceipt) {
              throw error;
            }
            if (existingReceipt.processedAt) {
              continue;
            }
          }
        }
        if (!(await claimWebhookReceipt(deps, receiptId, receiptClaimId))) {
          continue;
        }
        let receiptCompleted = false;
        try {
          await deps.db.update({
            model: TABLES.webhookReceipts,
            where: [
              { field: 'id', operator: 'eq', value: receiptId },
              { field: 'processingJobId', operator: 'eq', value: receiptClaimId }
            ],
            data: {
              eventType: receipt.eventType,
              signatureVerified: receipt.signatureVerified,
              rawPayload: receipt.rawPayload
            },
            namespace: deps.namespace
          });
          try {
            await assertLease();
            await processParsedWebhookEvent(deps, job.provider, event);
          } catch (error) {
            if (!isBillFnNotFoundError(error)) {
              throw error;
            }
            deps.metrics.track('reconciliation.event.skipped', {
              provider: job.provider,
              providerEventId: event.providerEventId,
              reason: 'billing_account_not_found'
            });
          }
          await assertLease();
          const finalized = await deps.db.updateMany({
            model: TABLES.webhookReceipts,
            where: [
              { field: 'id', operator: 'eq', value: receiptId },
              { field: 'processingJobId', operator: 'eq', value: receiptClaimId }
            ],
            data: {
              processingJobId: null,
              processingClaimedAt: null,
              processedAt: toIsoString(deps.now())
            },
            namespace: deps.namespace
          });
          if (finalized !== 1) {
            throw createBillFnError({
              code: 'BILLFN_CONFLICT',
              message: 'Notification history receipt claim changed before processing completed'
            });
          }
          receiptCompleted = true;
        } finally {
          if (!receiptCompleted) {
            await releaseWebhookReceiptClaim(deps, receiptId, receiptClaimId);
          }
        }
      }

      await assertLease();
      await upsertReconciliationCursor(deps, {
        provider: job.provider,
        cursorKey,
        cursor: history.nextCursor,
        metadata: {
          jobId: job.id
        }
      });
      return;
    }
  }
}

async function syncSubscriptionByIdForJob(
  deps: ServiceDeps,
  subscriptionId: string,
  assertLease: ReconciliationLeaseGuard,
  candidatePriceId?: string | null
) {
  const subscription = await getSubscriptionById(deps, subscriptionId);
  if (!subscription) {
    return;
  }
  const billingAccount = await getBillingAccountById(deps, subscription.billingAccountId);
  if (!billingAccount) {
    return;
  }
  const candidate = candidatePriceId
    ? findCatalogPriceReference(deps.catalog, subscription.provider, [candidatePriceId])
    : null;
  const live = await fetchLiveSubscription(deps, subscription, candidate ?? undefined);
  if (!live) {
    return;
  }
  await assertLease();
  await applyLiveProviderState(deps, { billingAccount, subscription, ...live });
}

/**
 * Reads the subscription from the provider for its stored plan and price. If
 * that read fails or returns no state and `candidate` names another catalog
 * price, it reads for that price (a provider such as Apple reads only the live
 * product); such a read counts only when the state it returns names a catalog
 * price (`providerProductId` or the raw record), whatever the stored read's
 * failure was, else it counts as failed. The catalog price the live record
 * names is the selection applied. Returns null when every read returned no
 * state, and otherwise throws the first failure.
 */
async function fetchLiveSubscription(deps: ServiceDeps, subscription: BillFnSubscription, candidate?: CatalogSelection) {
  const plan = requirePlan(deps.catalog, subscription.planKey);
  const stored: CatalogSelection = { plan, price: requirePriceById(plan, subscription.priceId) };
  const provider = requireProvider(deps, subscription.provider, 'fetchSubscription');
  const selections = candidate?.price.priceId && candidate.price.priceId !== stored.price.priceId ? [stored, candidate] : [stored];
  const failures: unknown[] = [];
  for (const selection of selections) {
    const liveStateObservedAt = toIsoString(deps.now());
    try {
      const state = await provider.fetchSubscription({ subscription, plan: selection.plan, price: selection.price });
      const live = state
        ? await resolveProviderEventPriceReference(deps, subscription.provider, { type: 'subscription.read', billingState: state }, subscription)
        : null;
      // A read for another price counts only when the provider confirms that price.
      if (state && (live || selection === stored)) {
        return { ...(live ?? selection), state, liveStateObservedAt };
      }
      if (state) {
        failures.push(
          createBillFnError({
            code: 'BILLFN_PROVIDER_ERROR',
            message: 'The live provider record does not confirm the requested catalog price'
          })
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw failures[0];
  }
  return null;
}

async function getOrCreateBillingAccount(
  deps: ServiceDeps,
  subject: BillableSubject
): Promise<{ billingAccount: BillFnBillingAccount; existed: boolean }> {
  const resolved = await resolveBillingAccountReference(deps, subject);
  const existing = await deps.db.findOne<BillFnBillingAccount>({
    model: TABLES.billingAccounts,
    where: [{ field: 'id', operator: 'eq', value: resolved.billingAccountId }],
    namespace: deps.namespace
  });
  if (existing) {
    return {
      billingAccount: existing,
      existed: true
    };
  }

  const timestamp = toIsoString(deps.now());
  const created: BillFnBillingAccount = {
    id: resolved.billingAccountId,
    ownerType: resolved.ownerType,
    ownerId: resolved.ownerId,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  try {
    await deps.db.create({
      model: TABLES.billingAccounts,
      data: created,
      namespace: deps.namespace
    });
  } catch (error) {
    if (!isDuplicateRecordError(error)) {
      throw error;
    }
    const duplicate = await deps.db.findOne<BillFnBillingAccount>({
      model: TABLES.billingAccounts,
      where: [{ field: 'id', operator: 'eq', value: resolved.billingAccountId }],
      namespace: deps.namespace
    });
    if (duplicate) {
      return {
        billingAccount: duplicate,
        existed: true
      };
    }
    throw error;
  }

  return {
    billingAccount: created,
    existed: false
  };
}

async function resolveBillingAccountReference(deps: ServiceDeps, subject: BillableSubject) {
  const resolved = await deps.resolveBillingAccount.resolve(subject);
  if (!resolved) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'Unable to resolve a billing account from the provided subject'
    });
  }
  return resolved;
}

async function findBillingAccountForSubject(deps: ServiceDeps, subject: BillableSubject) {
  const resolved = await resolveBillingAccountReference(deps, subject);
  return getBillingAccountById(deps, resolved.billingAccountId);
}

function buildVirtualBillingAccount(
  resolved: Awaited<ReturnType<BillingAccountResolver['resolve']>> extends infer T ? Exclude<T, null> : never,
  deps: ServiceDeps
): BillFnBillingAccount {
  const timestamp = toIsoString(deps.now());
  return {
    id: resolved.billingAccountId,
    ownerType: resolved.ownerType,
    ownerId: resolved.ownerId,
    metadata: {
      virtual: true
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function requirePlan(catalog: BillFnCatalog, planKey: string) {
  const plan = resolvePlan(catalog, planKey);
  if (!plan) {
    throw createBillFnError({
      code: 'BILLFN_NOT_FOUND',
      message: `Plan not found: ${planKey}`
    });
  }
  return plan;
}

function requirePrice(
  plan: ReturnType<typeof requirePlan>,
  provider: BillingProviderName,
  interval: BillFnPriceDefinition['interval'] | undefined
) {
  const price = resolvePrice(plan, provider, interval);
  if (!price) {
    throw createBillFnError({
      code: 'BILLFN_CATALOG_PRICE_NOT_FOUND',
      message: `No configured price for ${plan.planKey} on ${provider}${interval ? ` (${interval})` : ''}`
    });
  }
  return price;
}

function requirePriceById(plan: ReturnType<typeof requirePlan>, priceId: string) {
  const price = plan.prices.find((candidate) => candidate.priceId === priceId);
  if (!price) {
    throw createBillFnError({
      code: 'BILLFN_CATALOG_PRICE_NOT_FOUND',
      message: `No configured price found for ${priceId}`
    });
  }
  return price;
}

function requirePriceReference(catalog: BillFnCatalog, priceId: string) {
  for (const plan of catalog.plans) {
    const price = plan.prices.find((candidate) => candidate.priceId === priceId);
    if (price) {
      return { plan, price };
    }
  }
  throw createBillFnError({
    code: 'BILLFN_CATALOG_PRICE_NOT_FOUND',
    message: `No configured price found for ${priceId}`
  });
}

function requireProvider<
  TCapability extends keyof BillFnProviderAdapter
>(deps: ServiceDeps, providerName: BillingProviderName, capability: TCapability) {
  const provider = deps.providers[providerName];
  if (!provider) {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_UNSUPPORTED',
      message: `Provider is not configured: ${providerName}`
    });
  }
  const capabilityValue = provider[capability];
  if (typeof capabilityValue !== 'function') {
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_UNSUPPORTED',
      message: `Provider does not support ${String(capability)}: ${providerName}`
    });
  }
  return provider as BillFnProviderAdapter & Required<Pick<BillFnProviderAdapter, TCapability>>;
}

function requireSubject(subject: BillableSubject | undefined): BillableSubject {
  if (!subject) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'A billing subject is required'
    });
  }

  const hasIdentifier = Boolean(subject.actorId || subject.principalId || subject.organizationId || subject.tenantId);

  if (!hasIdentifier) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'A billing subject must include an actor, principal, tenant, or organization identifier'
    });
  }

  return subject;
}

async function createCheckoutSessionRecord(
  deps: ServiceDeps,
  session: BillFnCheckoutSession
): Promise<BillFnCheckoutSession> {
  await deps.db.create({
    model: TABLES.checkoutSessions,
    data: session,
    namespace: deps.namespace
  });
  return session;
}

async function updateCheckoutSession(
  deps: ServiceDeps,
  checkoutSessionId: string,
  patch: Partial<BillFnCheckoutSession>
): Promise<BillFnCheckoutSession> {
  return deps.db.update<BillFnCheckoutSession>({
    model: TABLES.checkoutSessions,
    where: [{ field: 'checkoutSessionId', operator: 'eq', value: checkoutSessionId }],
    data: patch,
    namespace: deps.namespace
  });
}

async function getCheckoutSession(deps: ServiceDeps, checkoutSessionId: string) {
  return deps.db.findOne<BillFnCheckoutSession>({
    model: TABLES.checkoutSessions,
    where: [{ field: 'checkoutSessionId', operator: 'eq', value: checkoutSessionId }],
    namespace: deps.namespace
  });
}

async function getBillingAccountById(deps: ServiceDeps, id: string) {
  return deps.db.findOne<BillFnBillingAccount>({
    model: TABLES.billingAccounts,
    where: [{ field: 'id', operator: 'eq', value: id }],
    namespace: deps.namespace
  });
}

async function getSubscriptionById(deps: ServiceDeps, id: string) {
  return deps.db.findOne<BillFnSubscription>({
    model: TABLES.subscriptions,
    where: [{ field: 'id', operator: 'eq', value: id }],
    namespace: deps.namespace
  });
}

async function getSubscriptionForAccount(deps: ServiceDeps, billingAccountId: string, subscriptionId?: string) {
  if (subscriptionId) {
    return deps.db.findOne<BillFnSubscription>({
      model: TABLES.subscriptions,
      where: [
        { field: 'id', operator: 'eq', value: subscriptionId },
        { field: 'billingAccountId', operator: 'eq', value: billingAccountId }
      ],
      namespace: deps.namespace
    });
  }
  return findActiveSubscription(deps, billingAccountId);
}

async function findActiveSubscription(deps: ServiceDeps, billingAccountId: string) {
  const candidates = await deps.db.findMany<BillFnSubscription>({
    model: TABLES.subscriptions,
    where: [
      { field: 'billingAccountId', operator: 'eq', value: billingAccountId },
      { field: 'status', operator: 'in', value: ['trialing', 'active', 'grace', 'past_due', 'pending', 'paused'] }
    ],
    orderBy: [{ field: 'updatedAt', direction: 'desc' }],
    namespace: deps.namespace
  });
  return candidates[0] ?? null;
}

async function findSubscriptionByProviderRef(
  deps: ServiceDeps,
  provider: BillingProviderName,
  providerSubscriptionId?: string,
  providerChargeId?: string,
  checkoutReferenceId?: string
) {
  const whereSets: WhereClause[][] = [];
  if (providerSubscriptionId) {
    whereSets.push([
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'providerSubscriptionId', operator: 'eq', value: providerSubscriptionId }
    ]);
  }
  if (providerChargeId) {
    whereSets.push([
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'providerChargeId', operator: 'eq', value: providerChargeId }
    ]);
  }
  if (checkoutReferenceId) {
    const session = await deps.db.findOne<BillFnCheckoutSession>({
      model: TABLES.checkoutSessions,
      where: [{ field: 'checkoutSessionId', operator: 'eq', value: checkoutReferenceId }],
      namespace: deps.namespace
    });
    if (session?.providerSubscriptionId) {
      whereSets.push([
        { field: 'provider', operator: 'eq', value: provider },
        { field: 'providerSubscriptionId', operator: 'eq', value: session.providerSubscriptionId }
      ]);
    }
  }

  for (const where of whereSets) {
    const found = await deps.db.findOne<BillFnSubscription>({
      model: TABLES.subscriptions,
      where,
      namespace: deps.namespace
    });
    if (found) {
      return found;
    }
  }
  return null;
}

async function findCheckoutSessionByProviderRef(
  deps: ServiceDeps,
  provider: BillingProviderName,
  providerSubscriptionId?: string,
  providerChargeId?: string,
  checkoutReferenceId?: string
) {
  const whereSets: WhereClause[][] = [];

  if (checkoutReferenceId) {
    whereSets.push([{ field: 'checkoutSessionId', operator: 'eq', value: checkoutReferenceId }]);
    whereSets.push([
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'providerCheckoutId', operator: 'eq', value: checkoutReferenceId }
    ]);
  }

  if (providerSubscriptionId) {
    whereSets.push([
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'providerSubscriptionId', operator: 'eq', value: providerSubscriptionId }
    ]);
  }

  if (providerChargeId) {
    whereSets.push([
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'providerChargeId', operator: 'eq', value: providerChargeId }
    ]);
  }

  for (const where of whereSets) {
    const found = await deps.db.findOne<BillFnCheckoutSession>({
      model: TABLES.checkoutSessions,
      where,
      namespace: deps.namespace
    });
    if (found) {
      return found;
    }
  }

  return null;
}

async function findEntitlementSnapshot(deps: ServiceDeps, billingAccountId: string) {
  return deps.db.findOne<BillFnEntitlementSnapshot>({
    model: TABLES.entitlementSnapshots,
    where: [{ field: 'billingAccountId', operator: 'eq', value: billingAccountId }],
    namespace: deps.namespace
  });
}

async function findUsageMeter(deps: ServiceDeps, billingAccountId: string, resource: string) {
  return deps.db.findOne<BillFnUsageMeter>({
    model: TABLES.usageMeters,
    where: [
      { field: 'billingAccountId', operator: 'eq', value: billingAccountId },
      { field: 'resource', operator: 'eq', value: resource }
    ],
    namespace: deps.namespace
  });
}

async function findUsageMeters(deps: ServiceDeps, billingAccountId: string, resource: string) {
  return deps.db.findMany<BillFnUsageMeter>({
    model: TABLES.usageMeters,
    where: [
      { field: 'billingAccountId', operator: 'eq', value: billingAccountId },
      { field: 'resource', operator: 'eq', value: resource }
    ],
    namespace: deps.namespace
  });
}

async function getReconciliationJobRecord(deps: ServiceDeps, id: string) {
  return deps.db.findOne<BillFnReconciliationJob>({
    model: TABLES.reconciliationJobs,
    where: [{ field: 'id', operator: 'eq', value: id }],
    namespace: deps.namespace
  });
}

async function renewReconciliationJobLease(deps: ServiceDeps, id: string, attempts: number) {
  const renewed = await deps.db.updateMany({
    model: TABLES.reconciliationJobs,
    where: [
      { field: 'id', operator: 'eq', value: id },
      { field: 'status', operator: 'eq', value: 'running' },
      { field: 'attempts', operator: 'eq', value: attempts }
    ],
    data: {
      updatedAt: toIsoString(deps.now())
    },
    namespace: deps.namespace
  });
  if (renewed !== 1) {
    throw reconciliationLeaseConflict('Reconciliation job processing lease is no longer active');
  }
}

async function claimWebhookReceipt(
  deps: ServiceDeps,
  receiptId: string,
  jobId: string,
  options: { allowProcessed?: boolean; currentOwnerId?: string } = {}
) {
  const claimTime = deps.now();
  const claimedAt = toIsoString(claimTime);
  if (options.currentOwnerId) {
    const currentOwnerWhere: WhereClause[] = [
      { field: 'id', operator: 'eq', value: receiptId },
      { field: 'processingJobId', operator: 'eq', value: options.currentOwnerId }
    ];
    if (!options.allowProcessed) {
      currentOwnerWhere.push({ field: 'processedAt', operator: 'eq', value: null });
    }
    const transferred = await deps.db.updateMany({
      model: TABLES.webhookReceipts,
      where: currentOwnerWhere,
      data: {
        processingJobId: jobId,
        processingClaimedAt: claimedAt
      },
      namespace: deps.namespace
    });
    if (transferred === 1) {
      return true;
    }
  }
  const unclaimedWhere: WhereClause[] = [
    { field: 'id', operator: 'eq', value: receiptId },
    { field: 'processingJobId', operator: 'eq', value: null }
  ];
  if (!options.allowProcessed) {
    unclaimedWhere.push({ field: 'processedAt', operator: 'eq', value: null });
  }
  const claimed = await deps.db.updateMany({
    model: TABLES.webhookReceipts,
    where: unclaimedWhere,
    data: {
      processingJobId: jobId,
      processingClaimedAt: claimedAt
    },
    namespace: deps.namespace
  });
  if (claimed === 1) {
    return true;
  }

  const existing = await deps.db.findOne<BillFnWebhookReceipt>({
    model: TABLES.webhookReceipts,
    where: [{ field: 'id', operator: 'eq', value: receiptId }],
    namespace: deps.namespace
  });
  if (!existing || (existing.processedAt && !options.allowProcessed) || !existing.processingJobId) {
    return false;
  }
  const previousClaimedAt = existing.processingClaimedAt
    ? Date.parse(existing.processingClaimedAt)
    : Number.NaN;
  const claimIsStale =
    !Number.isFinite(previousClaimedAt) ||
    claimTime.getTime() - previousClaimedAt >= WEBHOOK_RECEIPT_CLAIM_LEASE_MS;
  if (!claimIsStale) {
    return false;
  }

  const where: WhereClause[] = [
    { field: 'id', operator: 'eq', value: receiptId },
    { field: 'processingJobId', operator: 'eq', value: existing.processingJobId }
  ];
  if (existing.processingClaimedAt) {
    where.push({ field: 'processingClaimedAt', operator: 'eq', value: existing.processingClaimedAt });
  }
  const reclaimed = await deps.db.updateMany({
    model: TABLES.webhookReceipts,
    where,
    data: {
      processingJobId: jobId,
      processingClaimedAt: claimedAt
    },
    namespace: deps.namespace
  });
  return reclaimed === 1;
}

async function releaseWebhookReceiptClaim(
  deps: ServiceDeps,
  receiptId: string,
  jobId: string,
  options: { allowProcessed?: boolean } = {}
) {
  const where: WhereClause[] = [
    { field: 'id', operator: 'eq', value: receiptId },
    { field: 'processingJobId', operator: 'eq', value: jobId }
  ];
  if (!options.allowProcessed) {
    where.push({ field: 'processedAt', operator: 'eq', value: null });
  }
  await deps.db.updateMany({
    model: TABLES.webhookReceipts,
    where,
    data: {
      processingJobId: null,
      processingClaimedAt: null
    },
    namespace: deps.namespace
  });
}

function buildReconciliationReceiptClaimId(job: BillFnReconciliationJob) {
  return `${job.id}:attempt:${job.attempts}`;
}

async function findReconciliationCursor(deps: ServiceDeps, provider: BillingProviderName, cursorKey: string) {
  return deps.db.findOne<BillFnReconciliationCursor>({
    model: TABLES.reconciliationCursors,
    where: [
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'cursorKey', operator: 'eq', value: cursorKey }
    ],
    namespace: deps.namespace
  });
}

async function upsertReconciliationCursor(
  deps: ServiceDeps,
  input: Omit<BillFnReconciliationCursor, 'id' | 'updatedAt'> & { id?: string; updatedAt?: string }
) {
  const existing = await findReconciliationCursor(deps, input.provider, input.cursorKey);
  const record: BillFnReconciliationCursor = {
    id: existing?.id ?? input.id ?? deps.generateId('rcc'),
    provider: input.provider,
    cursorKey: input.cursorKey,
    cursor: input.cursor,
    metadata: input.metadata,
    updatedAt: input.updatedAt ?? toIsoString(deps.now())
  };
  if (existing) {
    return deps.db.update<BillFnReconciliationCursor>({
      model: TABLES.reconciliationCursors,
      where: [{ field: 'id', operator: 'eq', value: existing.id }],
      data: record,
      namespace: deps.namespace
    });
  }
  try {
    return await deps.db.create<BillFnReconciliationCursor>({
      model: TABLES.reconciliationCursors,
      data: record,
      namespace: deps.namespace
    });
  } catch (error) {
    if (!isDuplicateRecordError(error)) {
      throw error;
    }
    const duplicate = await findReconciliationCursor(deps, input.provider, input.cursorKey);
    if (!duplicate) {
      throw error;
    }
    return deps.db.update<BillFnReconciliationCursor>({
      model: TABLES.reconciliationCursors,
      where: [{ field: 'id', operator: 'eq', value: duplicate.id }],
      data: {
        ...record,
        id: duplicate.id
      },
      namespace: deps.namespace
    });
  }
}

function mapSubscriptionToEntitlementStatus(status: SubscriptionStatus): EntitlementStatus {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'grace':
    case 'past_due':
      return 'grace';
    default:
      return 'inactive';
  }
}

function applyVerificationState(
  deps: ServiceDeps,
  input: ApplyVerificationStateInput & { occurredAt: string }
): Promise<ProjectionResult | null>;
function applyVerificationState(
  deps: ServiceDeps,
  input: ApplyVerificationStateInput & { occurredAt?: undefined }
): Promise<ProjectionResult>;
function applyVerificationState(
  deps: ServiceDeps,
  input: ApplyVerificationStateInput
): Promise<ProjectionResult | null>;
async function applyVerificationState(
  deps: ServiceDeps,
  input: ApplyVerificationStateInput
): Promise<ProjectionResult | null> {
  let baseSubscription =
    input.subscription ??
    (await findSubscriptionByProviderRef(
      deps,
      input.price.provider,
      input.state.providerSubscriptionId,
      input.state.providerChargeId,
      input.checkoutSession?.checkoutSessionId
    ));
  let subscription: BillFnSubscription | null = null;
  let timestamp = toIsoString(deps.now());
  let liveStateSuperseded = false;
  let providerStateRaced: { priceId: string } | undefined;
  // A read is superseded by an event newer than its start; a committed mutation only by one after its commit.
  const supersededBefore = input.committedAt ?? input.liveStateObservedAt;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (baseSubscription && baseSubscription.billingAccountId !== input.billingAccount.id) {
      throw createBillFnError({
        code: 'BILLFN_CONFLICT',
        message: 'Provider billing reference belongs to a different billing account'
      });
    }
    const order = baseSubscription && input.occurredAt ? orderProviderEvent(baseSubscription, input.occurredAt) : 'apply';
    if (baseSubscription && order === 'skip') {
      // The older event's state is skipped, but a reference it adds still belongs to this subscription.
      await linkSkippedEventReferences(deps, baseSubscription, input.state);
      return null;
    }
    if (baseSubscription && order === 'reconcile') {
      // Never applied over the committed mutation; without a queue a failed read fails this call, so it is retried.
      await reconcileMutationWindowEvent(deps, baseSubscription, input);
      return null;
    }

    // An event applied after a live read started is newer than what the read returned: the read
    // only links its references and the subscription keeps the event's state.
    liveStateSuperseded = Boolean(
      baseSubscription &&
        !input.occurredAt &&
        supersededBefore &&
        isProviderEventOlderThanSubscription(baseSubscription, supersededBefore)
    );
    // An event applied while a committed mutation was in flight is reconciled by the caller.
    providerStateRaced =
      baseSubscription &&
      input.committedAt &&
      input.liveStateObservedAt &&
      isProviderEventOlderThanSubscription(baseSubscription, input.liveStateObservedAt)
        ? { priceId: baseSubscription.priceId }
        : undefined;
    timestamp = nextSubscriptionUpdatedAt(deps.now(), baseSubscription?.updatedAt);
    if (baseSubscription && liveStateSuperseded) {
      const linked = linkLiveReadReferences(baseSubscription, input, timestamp);
      if (!linked) {
        subscription = baseSubscription;
        break;
      }
      const updated = await deps.db.updateMany({
        model: TABLES.subscriptions,
        where: [
          { field: 'id', operator: 'eq', value: baseSubscription.id },
          { field: 'updatedAt', operator: 'eq', value: baseSubscription.updatedAt }
        ],
        data: linked,
        namespace: deps.namespace
      });
      if (updated === 1) {
        subscription = linked;
        break;
      }
      const current = await getSubscriptionById(deps, baseSubscription.id);
      if (!current) {
        throw createBillFnError({
          code: 'BILLFN_CONFLICT',
          message: 'Subscription changed while applying provider state'
        });
      }
      baseSubscription = current;
      await Promise.resolve();
      continue;
    }
    // A state write closes the window of an earlier committed mutation; a committed mutation opens its own.
    const merged = mergeJson(baseSubscription?.metadata, input.state.raw);
    const mergedMetadata = input.keepMutationWindow ? merged : withoutMutationWindow(merged);
    const providerStateAt = providerStateTimeFor(input.occurredAt, supersededBefore, baseSubscription);
    const metadata = providerStateAt
      ? {
          ...mergedMetadata,
          [PROVIDER_EVENT_OCCURRED_AT_METADATA_KEY]: providerStateAt,
          ...(input.committedAt ? { [PROVIDER_MUTATION_STARTED_AT_METADATA_KEY]: input.liveStateObservedAt } : {})
        }
      : mergedMetadata;

    const subscriptionId = baseSubscription?.id ?? deps.generateId('sub');
    const record: BillFnSubscription = {
      id: subscriptionId,
      billingAccountId: input.billingAccount.id,
      planKey: input.plan.planKey,
      priceId: input.price.priceId,
      provider: input.price.provider,
      providerSubscriptionId: input.state.providerSubscriptionId ?? baseSubscription?.providerSubscriptionId,
      providerCheckoutId: input.checkoutSession?.providerCheckoutId ?? baseSubscription?.providerCheckoutId,
      providerChargeId: input.state.providerChargeId ?? baseSubscription?.providerChargeId,
      status: input.state.subscriptionStatus,
      currentPeriodStart: input.state.currentPeriodStart ?? baseSubscription?.currentPeriodStart,
      currentPeriodEnd: input.state.currentPeriodEnd ?? baseSubscription?.currentPeriodEnd,
      autoRenew: input.state.autoRenew ?? baseSubscription?.autoRenew ?? false,
      metadata,
      createdAt: baseSubscription?.createdAt ?? timestamp,
      updatedAt: timestamp,
      cancelAt: baseSubscription?.cancelAt,
      canceledAt: input.state.subscriptionStatus === 'canceled' ? timestamp : baseSubscription?.canceledAt,
      trialEnd: baseSubscription?.trialEnd
    };

    if (baseSubscription) {
      // A reference this write drops is recorded as replaced before it, so no failure or interruption
      // after the write lets an event on it bootstrap another subscription; one a committed mutation
      // cannot record is saved pending with the write. A pending one is recorded before this write
      // clears it, the order `namesReplacedReference` reads against.
      const pending = await recordDroppedReferences(deps, baseSubscription, record, Boolean(input.committedAt));
      Object.assign(record, withPendingReplacements(record.metadata, pending));
      // A provider-state time is only written by an update ordered against the row it was computed from.
      if (providerStateAt) {
        const updated = await deps.db.updateMany({
          model: TABLES.subscriptions,
          where: [
            { field: 'id', operator: 'eq', value: baseSubscription.id },
            { field: 'updatedAt', operator: 'eq', value: baseSubscription.updatedAt }
          ],
          data: record,
          namespace: deps.namespace
        });
        if (updated === 1) {
          subscription = record;
          break;
        }
        // A lost race leaves its records: a reference the winner keeps is held, so its events still link to it.
        const current = await getSubscriptionById(deps, baseSubscription.id);
        if (!current) {
          throw createBillFnError({
            code: 'BILLFN_CONFLICT',
            message: 'Subscription changed while applying provider event state'
          });
        }
        baseSubscription = current;
        await Promise.resolve();
        continue;
      }
      subscription = await deps.db.update<BillFnSubscription>({
        model: TABLES.subscriptions,
        where: [{ field: 'id', operator: 'eq', value: baseSubscription.id }],
        data: record,
        namespace: deps.namespace
      });
      break;
    }

    try {
      subscription = await deps.db.create<BillFnSubscription>({
        model: TABLES.subscriptions,
        data: record,
        namespace: deps.namespace
      });
      break;
    } catch (error) {
      if (!isDuplicateRecordError(error)) {
        throw error;
      }
      const duplicate = await findSubscriptionByProviderRef(
        deps,
        input.price.provider,
        input.state.providerSubscriptionId,
        input.state.providerChargeId,
        input.checkoutSession?.checkoutSessionId
      );
      if (!duplicate) {
        throw error;
      }
      baseSubscription = duplicate;
      await Promise.resolve();
    }
  }

  if (!subscription) {
    throw createBillFnError({
      code: 'BILLFN_CONFLICT',
      message: 'Unable to apply provider event state after multiple retries'
    });
  }

  const checkoutSession = input.checkoutSession
    ? await updateCheckoutSession(deps, input.checkoutSession.checkoutSessionId, {
        status: input.state.checkoutStatus,
        providerSubscriptionId: input.state.providerSubscriptionId ?? input.checkoutSession.providerSubscriptionId,
        providerChargeId: input.state.providerChargeId ?? input.checkoutSession.providerChargeId,
        updatedAt: timestamp,
        metadata: mergeJson(input.checkoutSession.metadata, input.state.raw)
      })
    : input.checkoutSession;

  if (liveStateSuperseded) {
    // The subscription's state did not change, so its entitlements stand and no lifecycle event is recorded.
    const entitlements = await upsertEntitlements(
      deps,
      input.billingAccount.id,
      requirePlan(deps.catalog, subscription.planKey),
      subscription,
      timestamp
    );
    return {
      checkoutSession: checkoutSession ?? input.checkoutSession,
      subscription,
      entitlements,
      providerStateRaced
    };
  }

  const entitlements = await upsertEntitlements(deps, input.billingAccount.id, input.plan, subscription, timestamp);

  await recordBillingEvent(deps, {
    // A provider event keys its lifecycle entry, so applying it again (a reclaimed replay) records it once.
    id: input.providerEventId
      ? buildProviderEventBillingEventId(subscription.provider, input.providerEventId)
      : deps.generateId('evt'),
    billingAccountId: input.billingAccount.id,
    type: `billfn.subscription.${subscription.status}`,
    payload: {
      subscriptionId: subscription.id,
      provider: subscription.provider,
      priceId: subscription.priceId
    },
    createdAt: timestamp
  });

  deps.metrics.track('subscription.updated', {
    provider: subscription.provider,
    status: subscription.status
  });

  return {
    checkoutSession: checkoutSession ?? input.checkoutSession,
    subscription,
    entitlements,
    providerStateRaced
  };
}

/**
 * The provider-state time a write saves: the event's time, or for live state
 * the read start (a committed mutation: its commit), never moving the stored
 * time backwards on any path. Null when the state carries no time.
 */
function providerStateTimeFor(
  occurredAt: string | undefined,
  liveStateAt: string | undefined,
  subscription: BillFnSubscription | null
) {
  const stateAt = occurredAt ?? liveStateAt;
  return stateAt ? laterProviderEventTime(readProviderStateOccurredAt(subscription), stateAt) : null;
}

/**
 * The subscription row after a live provider read that an applied event has
 * superseded: missing provider references from the read are added and every
 * state field is kept. Returns null when the read adds no reference.
 */
function linkLiveReadReferences(
  subscription: BillFnSubscription,
  input: ApplyVerificationStateInput,
  timestamp: string
): BillFnSubscription | null {
  const providerSubscriptionId = subscription.providerSubscriptionId ?? input.state.providerSubscriptionId;
  const providerCheckoutId = subscription.providerCheckoutId ?? input.checkoutSession?.providerCheckoutId;
  const providerChargeId = subscription.providerChargeId ?? input.state.providerChargeId;
  if (
    providerSubscriptionId === subscription.providerSubscriptionId &&
    providerCheckoutId === subscription.providerCheckoutId &&
    providerChargeId === subscription.providerChargeId
  ) {
    return null;
  }
  return { ...subscription, providerSubscriptionId, providerCheckoutId, providerChargeId, updatedAt: timestamp };
}

/**
 * Links the provider references of an event skipped as older than the
 * subscription's provider state (the last applied event or a live provider
 * read). The state, entitlements and provider-state time are kept; only a
 * missing provider subscription or charge id is filled, never replaced, and a
 * reference another subscription already holds is left alone. The write is
 * ordered against the row it was computed from. Returns the subscription after
 * the write, or the current row when nothing was added; the caller replays the
 * events retained for an added reference.
 */
async function linkSkippedEventReferences(
  deps: ServiceDeps,
  subscription: BillFnSubscription,
  state: Pick<VerifiedBillingState, 'providerSubscriptionId' | 'providerChargeId'>
): Promise<BillFnSubscription> {
  let current = subscription;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const data = await linkableMissingReferences(deps, current, state);
    if (Object.keys(data).length === 0) {
      return current;
    }
    const linked: BillFnSubscription = {
      ...current,
      ...data,
      updatedAt: nextSubscriptionUpdatedAt(deps.now(), current.updatedAt)
    };
    if (await writeOrderedSubscription(deps, current, linked)) {
      deps.metrics.track('reconciliation.event.references_linked', {
        provider: current.provider,
        subscriptionId: current.id
      });
      return linked;
    }
    const reread = await getSubscriptionById(deps, current.id);
    if (!reread) {
      return current;
    }
    current = reread;
    await Promise.resolve();
  }
  throw createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'Unable to link provider references after multiple retries'
  });
}

/** The references the subscription lacks that the state names and no other subscription holds. */
async function linkableMissingReferences(
  deps: ServiceDeps,
  subscription: BillFnSubscription,
  state: Pick<VerifiedBillingState, 'providerSubscriptionId' | 'providerChargeId'>
) {
  const data: Partial<Pick<BillFnSubscription, 'providerSubscriptionId' | 'providerChargeId'>> = {};
  for (const field of ['providerSubscriptionId', 'providerChargeId'] as const) {
    if (await isMissingReferenceLinkable(deps, subscription, field, state[field])) {
      data[field] = state[field];
    }
  }
  return data;
}

/** Writes a subscription row ordered against the row it was computed from; false when that row changed. */
async function writeOrderedSubscription(deps: ServiceDeps, current: BillFnSubscription, next: BillFnSubscription) {
  try {
    const updated = await deps.db.updateMany({
      model: TABLES.subscriptions,
      where: [
        { field: 'id', operator: 'eq', value: current.id },
        { field: 'updatedAt', operator: 'eq', value: current.updatedAt }
      ],
      data: next,
      namespace: deps.namespace
    });
    return updated === 1;
  } catch (error) {
    // Another subscription took the reference between the check and the write: re-check it.
    if (!isDuplicateRecordError(error)) {
      throw error;
    }
    return false;
  }
}

/** Whether the subscription lacks this reference and no other subscription holds it. */
async function isMissingReferenceLinkable(
  deps: ServiceDeps,
  subscription: BillFnSubscription,
  field: 'providerSubscriptionId' | 'providerChargeId',
  reference: string | undefined
) {
  return Boolean(
    !subscription[field] && reference && !(await isProviderReferenceHeldElsewhere(deps, subscription, field, reference))
  );
}

async function isProviderReferenceHeldElsewhere(
  deps: ServiceDeps,
  subscription: BillFnSubscription,
  field: 'providerSubscriptionId' | 'providerChargeId',
  reference: string
) {
  const holder = await deps.db.findOne<BillFnSubscription>({
    model: TABLES.subscriptions,
    where: [
      { field: 'provider', operator: 'eq', value: subscription.provider },
      { field, operator: 'eq', value: reference }
    ],
    namespace: deps.namespace
  });
  return Boolean(holder && holder.id !== subscription.id);
}

async function upsertEntitlements(
  deps: ServiceDeps,
  billingAccountId: string,
  plan: ReturnType<typeof requirePlan>,
  subscription: BillFnSubscription,
  timestamp: string
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const existing = await findEntitlementSnapshot(deps, billingAccountId);
    if (existing && isEntitlementFromNewerSubscription(existing, subscription)) {
      return existing;
    }
    const snapshot: BillFnEntitlementSnapshot = {
      id: existing?.id ?? `ent_${billingAccountId}`,
      billingAccountId,
      planKey: plan.planKey,
      status: mapSubscriptionToEntitlementStatus(subscription.status),
      features: { ...plan.features },
      limits: { ...plan.limits },
      effectiveAt: timestamp,
      expiresAt: subscription.currentPeriodEnd,
      sourceEventId: buildEntitlementSourceEventId(subscription),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    };

    if (existing) {
      const updated = await deps.db.updateMany({
        model: TABLES.entitlementSnapshots,
        where: [
          { field: 'billingAccountId', operator: 'eq', value: billingAccountId },
          existing.sourceEventId
            ? { field: 'sourceEventId', operator: 'eq', value: existing.sourceEventId }
            : { field: 'updatedAt', operator: 'eq', value: existing.updatedAt }
        ],
        data: snapshot,
        namespace: deps.namespace
      });
      if (updated === 1) {
        return snapshot;
      }
      await Promise.resolve();
      continue;
    }

    try {
      return await deps.db.create<BillFnEntitlementSnapshot>({
        model: TABLES.entitlementSnapshots,
        data: snapshot,
        namespace: deps.namespace
      });
    } catch (error) {
      if (!isDuplicateRecordError(error)) {
        throw error;
      }
      await Promise.resolve();
    }
  }

  throw createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'Unable to update entitlements after multiple retries'
  });
}

async function recordBillingEvent(deps: ServiceDeps, event: BillFnBillingEvent) {
  try {
    await deps.db.create({
      model: TABLES.billingEvents,
      data: event,
      namespace: deps.namespace
    });
  } catch (error) {
    // A provider-event-keyed entry already recorded by an earlier apply of the same event.
    if (!isDuplicateRecordError(error)) {
      throw error;
    }
  }
}

function buildProviderEventBillingEventId(provider: BillingProviderName, providerEventId: string) {
  return `evt_${provider}_${Buffer.from(providerEventId).toString('base64url')}`;
}

async function createRefundRecord(
  deps: ServiceDeps,
  input: Omit<BillFnRefund, 'id'>
) {
  const refund: BillFnRefund = {
    id: deps.generateId('rfd'),
    ...input
  };
  await deps.db.create({
    model: TABLES.refunds,
    data: refund,
    namespace: deps.namespace
  });
  return refund;
}

async function createSubscriptionChangeRequestRecord(
  deps: ServiceDeps,
  input: Omit<BillFnSubscriptionChangeRequest, 'id'>
) {
  const changeRequest: BillFnSubscriptionChangeRequest = {
    id: deps.generateId('scr'),
    ...input
  };
  await deps.db.create({
    model: TABLES.subscriptionChangeRequests,
    data: changeRequest,
    namespace: deps.namespace
  });
  return changeRequest;
}

async function incrementUsage(deps: ServiceDeps, billingAccountId: string, resource: string, amount: number) {
  assertFiniteAmount(amount, 'bytes');
  if (amount === 0) {
    return;
  }

  if (deps.db.capabilities.transactions.supported) {
    await deps.db.transaction(async (transaction) => {
      await incrementUsageInTransaction(
        {
          ...deps,
          db: transaction as unknown as Adapter
        },
        billingAccountId,
        resource,
        amount
      );
    });
    return;
  }

  const appliedAmount = await updateUsageMeter(deps, billingAccountId, resource, amount);
  if (appliedAmount === 0) {
    return;
  }
  try {
    await appendUsageLedgerEntry(deps, billingAccountId, resource, appliedAmount);
  } catch (error) {
    try {
      await updateUsageMeter(deps, billingAccountId, resource, -appliedAmount);
    } catch (compensationError) {
      throw createBillFnError({
        code: 'BILLFN_INTERNAL_ERROR',
        message: `Usage ledger write failed and the ${resource} meter could not be compensated`,
        details: {
          ledgerError: error instanceof Error ? error.message : String(error),
          compensationError: compensationError instanceof Error ? compensationError.message : String(compensationError)
        }
      });
    }
    throw error;
  }
}

async function incrementUsageInTransaction(
  deps: ServiceDeps,
  billingAccountId: string,
  resource: string,
  amount: number
) {
  const appliedAmount = await updateUsageMeter(deps, billingAccountId, resource, amount);
  if (appliedAmount === 0) {
    return;
  }
  await appendUsageLedgerEntry(deps, billingAccountId, resource, appliedAmount);
}

async function updateUsageMeter(
  deps: ServiceDeps,
  billingAccountId: string,
  resource: string,
  amount: number
): Promise<number> {
  const timestamp = toIsoString(deps.now());
  const meterId = `${billingAccountId}:${resource}`;
  let updated = false;
  let appliedAmount = amount;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const existing = await findUsageMeter(deps, billingAccountId, resource);

    if (!existing) {
      if (amount < 0) {
        return 0;
      }
      try {
        await deps.db.create({
          model: TABLES.usageMeters,
          data: {
            id: meterId,
            billingAccountId,
            resource,
            current: amount,
            updatedAt: timestamp
          } satisfies BillFnUsageMeter,
          namespace: deps.namespace
        });
        updated = true;
        break;
      } catch (error) {
        if (isDuplicateRecordError(error)) {
          await Promise.resolve();
          continue;
        }
        throw error;
      }
    }

    const nextCurrent = Math.max(0, existing.current + amount);
    const nextAppliedAmount = nextCurrent - existing.current;
    if (nextAppliedAmount === 0) {
      return 0;
    }
    const affected = await deps.db.updateMany({
      model: TABLES.usageMeters,
      where: [
        { field: 'id', operator: 'eq', value: existing.id },
        { field: 'current', operator: 'eq', value: existing.current }
      ],
      data: {
        current: nextCurrent,
        updatedAt: timestamp
      },
      namespace: deps.namespace
    });
    if (affected === 1) {
      appliedAmount = nextAppliedAmount;
      updated = true;
      break;
    }
    await Promise.resolve();
  }

  if (!updated) {
    throw createBillFnError({
      code: 'BILLFN_CONFLICT',
      message: `Unable to update usage for ${resource} after multiple retries`
    });
  }

  return appliedAmount;
}

async function appendUsageLedgerEntry(
  deps: ServiceDeps,
  billingAccountId: string,
  resource: string,
  amount: number
) {
  const ledger: BillFnUsageLedgerEntry = {
    id: deps.generateId('ulg'),
    billingAccountId,
    resource,
    amount,
    createdAt: toIsoString(deps.now())
  };
  await deps.db.create({
    model: TABLES.usageLedger,
    data: ledger,
    namespace: deps.namespace
  });
}

async function resolveProjectionContextForProviderState(
  deps: ServiceDeps,
  input: {
    provider: BillingProviderName;
    state: NonNullable<Awaited<ReturnType<NonNullable<BillFnProviderAdapter['verifyCheckout']>>>>;
    checkoutReferenceId?: string;
  }
) {
  const subscription = await findSubscriptionByProviderRef(
    deps,
    input.provider,
    input.state.providerSubscriptionId,
    input.state.providerChargeId,
    input.checkoutReferenceId
  );

  if (subscription) {
    const billingAccount = await getBillingAccountById(deps, subscription.billingAccountId);
    if (!billingAccount) {
      return null;
    }

    const plan = requirePlan(deps.catalog, subscription.planKey);
    const price = requirePriceById(plan, subscription.priceId);
    const checkoutSession = await findCheckoutSessionByProviderRef(
      deps,
      input.provider,
      input.state.providerSubscriptionId,
      input.state.providerChargeId,
      input.checkoutReferenceId
    );

    return {
      billingAccount,
      subscription,
      checkoutSession,
      plan,
      price
    };
  }

  const checkoutSession = await findCheckoutSessionByProviderRef(
    deps,
    input.provider,
    input.state.providerSubscriptionId,
    input.state.providerChargeId,
    input.checkoutReferenceId
  );

  if (!checkoutSession) {
    return null;
  }

  const billingAccount = await getBillingAccountById(deps, checkoutSession.billingAccountId);
  if (!billingAccount) {
    return null;
  }

  const plan = requirePlan(deps.catalog, checkoutSession.planKey);
  const price = requirePriceById(plan, checkoutSession.priceId);

  return {
    billingAccount,
    subscription: null,
    checkoutSession,
    plan,
    price
  };
}

async function processParsedWebhookEvent(
  deps: ServiceDeps,
  providerName: BillingProviderName,
  event: ParsedProviderEvent
) {
  const state = event.billingState;
  if (!state) {
    return null;
  }
  let projection = await resolveProjectionContextForProviderState(deps, {
    provider: providerName,
    state,
    checkoutReferenceId: event.checkoutReferenceId
  });
  if (!projection) {
    const outcome = await bootstrapOrStoreUnlinkedWebhookEvent(deps, providerName, event, state);
    if (!('linked' in outcome)) {
      return outcome.handled;
    }
    projection = outcome.linked;
  }
  if (projection.subscription) {
    return applyEventToLinkedSubscription(deps, providerName, { ...event, billingState: state }, projection.subscription);
  }
  // The event resolved only through a checkout session, so applying it links the reference:
  // events stored for it before now are replayed after it, newer ones applied and older ones skipped.
  const applied = await applyParsedWebhookEvent(deps, providerName, { ...event, billingState: state }, projection);
  const linked =
    applied?.subscription ??
    (await findSubscriptionByProviderRef(
      deps,
      providerName,
      state.providerSubscriptionId,
      state.providerChargeId,
      event.checkoutReferenceId
    ));
  if (linked) {
    await replayUnlinkedWebhookEventsOrThrow(deps, linked);
  }
  return applied;
}

/**
 * Applies an event that resolved to a subscription. Events stored before its
 * reference was linked go first, so provider event-time order holds; an unread
 * window event does not hold this event back and is retried after it.
 */
async function applyEventToLinkedSubscription(
  deps: ServiceDeps,
  providerName: BillingProviderName,
  event: ParsedProviderEvent & { billingState: VerifiedBillingState },
  subscription: BillFnSubscription
) {
  const state = event.billingState;
  const { windowUnread } = await replayUnlinkedWebhookEventsOrThrow(deps, subscription, { deferWindowUnread: true });
  // This run's replay, or one another run finished, may have replaced the reference this event matched.
  const refreshed = await resolveProjectionContextForProviderState(deps, {
    provider: providerName,
    state,
    checkoutReferenceId: event.checkoutReferenceId
  });
  if (!refreshed) {
    // The event is retained, never applied to the subscription it matched nor used to bootstrap another.
    await storeUnlinkedWebhookEvent(deps, providerName, event, {
      providerReference: (state.providerSubscriptionId ?? state.providerChargeId) as string,
      reason: 'provider_reference_replaced',
      metadataBillingAccountId: readBillingAccountMetadata(event, state)
    });
    if (windowUnread) {
      // The replay that replaced the reference closed the window, so the unread event is now skipped;
      // this delivery's redelivery would no longer reach the subscription, so it is replayed here.
      await replayUnlinkedWebhookEventsOrThrow(deps, subscription);
    }
    return null;
  }
  const linkedBefore = refreshed.subscription;
  const applied = await applyParsedWebhookEvent(deps, providerName, event, refreshed);
  // An event that adds a provider reference links the events stored for it, including an event
  // skipped as older than the subscription's state, which still links its missing references.
  const linkedAfter =
    applied?.subscription ?? (linkedBefore ? await getSubscriptionById(deps, linkedBefore.id) : null);
  const replayAgain = linkedAfter ?? linkedBefore;
  // A newer event closes the window, so the unread event is then skipped; one still unread fails this
  // delivery. One on a reference this event replaced was recorded as replaced by its write.
  if (replayAgain && (windowUnread || (linkedAfter && addsProviderReference(linkedBefore, linkedAfter)))) {
    await replayUnlinkedWebhookEventsOrThrow(deps, replayAgain);
  }
  return applied;
}

async function applyParsedWebhookEvent(
  deps: ServiceDeps,
  providerName: BillingProviderName,
  event: ParsedProviderEvent & { billingState: VerifiedBillingState },
  projection: ProviderProjectionContext
) {
  if (
    projection.subscription &&
    event.occurredAt &&
    orderProviderEvent(projection.subscription, event.occurredAt) === 'skip'
  ) {
    await linkSkippedEventReferences(deps, projection.subscription, event.billingState);
    deps.metrics.track('reconciliation.event.skipped', {
      provider: providerName,
      providerEventId: event.providerEventId,
      reason: 'out_of_order'
    });
    return null;
  }
  const eventPrice = await resolveProviderEventPriceReference(deps, providerName, event, projection.subscription);
  const applied = await applyVerificationState(deps, {
    billingAccount: projection.billingAccount,
    plan: eventPrice?.plan ?? projection.plan,
    price: eventPrice?.price ?? projection.price,
    checkoutSession: projection.checkoutSession ?? undefined,
    subscription: projection.subscription ?? undefined,
    state: event.billingState,
    occurredAt: event.occurredAt,
    // The provider event keys its lifecycle entry, so a delivery and a replay of it record it once.
    providerEventId: event.providerEventId
  });
  if (!applied) {
    deps.metrics.track('reconciliation.event.skipped', {
      provider: providerName,
      providerEventId: event.providerEventId,
      reason: 'out_of_order'
    });
  }
  return applied;
}

/**
 * Handles a verified event whose provider reference matches no local
 * subscription or checkout. Provider metadata naming an existing billing
 * account bootstraps the subscription from the provider record; any other
 * event is stored as unlinked, so the webhook is acknowledged and the event is
 * replayed once the reference is linked.
 */
async function bootstrapOrStoreUnlinkedWebhookEvent(
  deps: ServiceDeps,
  providerName: BillingProviderName,
  event: ParsedProviderEvent,
  state: VerifiedBillingState
): Promise<{ linked: ProviderProjectionContext } | { handled: ProjectionResult | null }> {
  const providerReference = state.providerSubscriptionId ?? state.providerChargeId;
  if (!providerReference) {
    deps.metrics.track('reconciliation.event.skipped', {
      provider: providerName,
      providerEventId: event.providerEventId,
      reason: 'provider_reference_missing'
    });
    return { handled: null };
  }
  const metadataBillingAccountId = readBillingAccountMetadata(event, state);
  const existing = await findSubscriptionByProviderRef(
    deps,
    providerName,
    state.providerSubscriptionId,
    state.providerChargeId,
    event.checkoutReferenceId
  );
  let reason: BillFnUnlinkedWebhookEventReason;
  if (existing) {
    // A link that committed after this event's first lookup is applied to like any linked reference.
    const projection = await resolveProjectionContextForProviderState(deps, {
      provider: providerName,
      state,
      checkoutReferenceId: event.checkoutReferenceId
    });
    if (projection) {
      return { linked: projection };
    }
    // The subscription's billing account is gone; the reference must not be rebound to another one.
    reason = 'billing_account_unavailable';
  } else if (await namesReplacedReference(deps, providerName, event, state)) {
    // No subscription holds a reference a write replaced: the event never bootstraps another one.
    reason = 'provider_reference_replaced';
  } else if (metadataBillingAccountId) {
    const bootstrap = await bootstrapFromMetadata(deps, providerName, event, state, metadataBillingAccountId);
    if (typeof bootstrap !== 'string') {
      return bootstrap;
    }
    reason = bootstrap;
  } else {
    reason = 'billing_account_metadata_missing';
  }

  await storeUnlinkedWebhookEvent(deps, providerName, event, {
    providerReference,
    reason,
    metadataBillingAccountId
  });
  if (existing) {
    return { handled: null };
  }
  // A link that committed while this event was being stored would have missed it; replay it now.
  const linked = await findSubscriptionByProviderRef(
    deps,
    providerName,
    state.providerSubscriptionId,
    state.providerChargeId,
    event.checkoutReferenceId
  );
  if (linked) {
    await replayUnlinkedWebhookEventsOrThrow(deps, linked);
  }
  return { handled: null };
}

/** Bootstraps the subscription for the account the metadata names, or returns why the event is stored unlinked. */
async function bootstrapFromMetadata(
  deps: ServiceDeps,
  providerName: BillingProviderName,
  event: ParsedProviderEvent,
  state: VerifiedBillingState,
  billingAccountId: string
): Promise<{ handled: ProjectionResult | null } | BillFnUnlinkedWebhookEventReason> {
  const billingAccount = await getBillingAccountById(deps, billingAccountId);
  if (!billingAccount) {
    return 'billing_account_not_found';
  }
  const eventPrice = await resolveProviderEventPriceReference(deps, providerName, event, null);
  if (!eventPrice) {
    return 'price_not_found';
  }
  return {
    handled: await bootstrapSubscriptionFromWebhookEvent(deps, providerName, event, {
      billingAccount,
      plan: eventPrice.plan,
      price: eventPrice.price,
      state
    })
  };
}

async function bootstrapSubscriptionFromWebhookEvent(
  deps: ServiceDeps,
  providerName: BillingProviderName,
  event: ParsedProviderEvent,
  input: {
    billingAccount: BillFnBillingAccount;
    plan: ReturnType<typeof requirePlan>;
    price: BillFnPriceDefinition;
    state: VerifiedBillingState;
  }
) {
  // A concurrent delivery that creates the same reference first makes this an ordered update.
  const applied = await applyVerificationState(deps, {
    billingAccount: input.billingAccount,
    plan: input.plan,
    price: input.price,
    state: input.state,
    occurredAt: event.occurredAt,
    providerEventId: event.providerEventId
  });
  deps.metrics.track('webhook.subscription.bootstrapped', {
    provider: providerName,
    applied: Boolean(applied)
  });
  if (!applied) {
    deps.metrics.track('reconciliation.event.skipped', {
      provider: providerName,
      providerEventId: event.providerEventId,
      reason: 'out_of_order'
    });
  }
  const subscription =
    applied?.subscription ??
    (await findSubscriptionByProviderRef(
      deps,
      providerName,
      input.state.providerSubscriptionId,
      input.state.providerChargeId
    ));
  if (subscription) {
    await replayUnlinkedWebhookEventsOrThrow(deps, subscription);
  }
  return applied;
}

async function storeUnlinkedWebhookEvent(
  deps: ServiceDeps,
  providerName: BillingProviderName,
  event: ParsedProviderEvent,
  input: {
    providerReference: string;
    reason: BillFnUnlinkedWebhookEventReason;
    metadataBillingAccountId: string | null;
  }
) {
  const now = deps.now();
  const timestamp = toIsoString(now);
  const record: BillFnUnlinkedWebhookEvent = {
    id: buildUnlinkedWebhookEventId(providerName, event.providerEventId),
    provider: providerName,
    providerEventId: event.providerEventId,
    providerReference: input.providerReference,
    // The charge of an event that also names its subscription, so linking either reference finds it.
    providerSecondaryReference:
      event.billingState?.providerChargeId && event.billingState.providerChargeId !== input.providerReference
        ? event.billingState.providerChargeId
        : null,
    eventType: event.type,
    occurredAt: event.occurredAt ?? null,
    reason: input.reason,
    metadataBillingAccountId: input.metadataBillingAccountId,
    status: 'unlinked',
    event: serializeParsedWebhookEvent(event),
    replayClaimId: null,
    replayClaimedAt: null,
    replayedAt: null,
    subscriptionId: null,
    error: null,
    expiresAt: toIsoString(new Date(now.getTime() + UNLINKED_WEBHOOK_EVENT_RETENTION_MS)),
    createdAt: timestamp,
    updatedAt: timestamp
  };
  try {
    await deps.db.create({
      model: TABLES.unlinkedWebhookEvents,
      data: record,
      namespace: deps.namespace
    });
  } catch (error) {
    // A redelivered or replayed event keeps the row it already has, but a replaced reference is recorded
    // on it, so the event never bootstraps a subscription later.
    if (!isDuplicateRecordError(error)) {
      throw error;
    }
    if (input.reason === 'provider_reference_replaced') {
      await deps.db.updateMany({
        model: TABLES.unlinkedWebhookEvents,
        where: [{ field: 'id', operator: 'eq', value: record.id }],
        data: { reason: input.reason, updatedAt: timestamp },
        namespace: deps.namespace
      });
    }
    return;
  }
  deps.metrics.track('webhook.event.unlinked', {
    provider: providerName,
    reason: input.reason
  });
  await purgeExpiredUnlinkedWebhookEvents(deps, timestamp);
}

async function purgeExpiredUnlinkedWebhookEvents(deps: ServiceDeps, timestamp: string) {
  try {
    await deps.db.deleteMany({
      model: TABLES.unlinkedWebhookEvents,
      where: [{ field: 'expiresAt', operator: 'lt', value: timestamp }],
      namespace: deps.namespace
    });
  } catch (error) {
    // Retention cleanup must not make the provider redeliver an event that is already stored.
    deps.metrics.track('webhook.unlinked.purge_failed', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

type UnlinkedReplayResult = {
  applied: number;
  skipped: number;
  /** Events left for a later replay, counted from the one the replay stopped at. */
  pending: number;
  /** Set when the replay stopped at an event another, unexpired replay run holds. */
  held?: boolean;
  /** Set when the replay reached its per-run bound with events left. */
  bounded?: boolean;
  /** Set when the replay stopped because applying an event failed. */
  failure?: { error: unknown };
  /** The first window-read failure of an event left retained so the operation is retried. */
  windowUnread?: { error: unknown };
  /** Every event this pass left window-unread; one whose reference was then lost no longer counts. */
  unreadRows?: Array<{ row: BillFnUnlinkedWebhookEvent; error: unknown }>;
};

/**
 * What replaying one retained event did. `displaced`: an event replayed before
 * it replaced the reference it matched; `window_unread`: it is inside a
 * committed mutation's window and the provider read failed with no queue.
 */
type UnlinkedReplayOutcome =
  | { kind: 'replayed' | 'skipped'; subscriptionId: string }
  | { kind: 'displaced' | 'unresolved' }
  | { kind: 'window_unread'; error: unknown };

/**
 * Applies unexpired unlinked events for the subscription's provider references
 * in provider event-time order, as one ordered queue. When an applied or
 * skipped event gives the subscription a provider reference, including one it
 * held earlier in the run, the events stored for that reference (as primary or
 * secondary reference) are merged into the queue in order before the next
 * event, so an event naming a reference the subscription held only between two
 * replayed events is still found. An event
 * older than the subscription's current provider state (the last applied
 * event, or a live provider read) is marked skipped. An event that no longer
 * resolves to a subscription, because an earlier replayed event replaced its
 * reference, stays unlinked with reason `provider_reference_replaced` and the
 * replay continues past it. Every write that drops a reference records it as
 * replaced (`recordReplacedProviderReferences`) and marks the events still
 * unlinked on it, as does the end of the pass for one held during it and lost
 * since; they no longer count as left at the bound. An event inside a
 * committed mutation's window whose provider read fails (no queue) stays
 * unlinked with the error, the replay continues, and the operation fails
 * afterwards so it is retried. A
 * replay stops at the first event another replay holds or that fails to apply,
 * leaving it and later events for the next replay, so the order is kept.
 */
async function replayUnlinkedWebhookEvents(
  deps: ServiceDeps,
  subscription: BillFnSubscription
): Promise<UnlinkedReplayResult> {
  const result: UnlinkedReplayResult = { applied: 0, skipped: 0, pending: 0 };
  const queue = createUnlinkedReplayQueue(deps, subscription.provider);
  let latest = subscription;
  await queue.discover(subscription);
  for (let processed = 0; processed < UNLINKED_WEBHOOK_EVENT_REPLAY_MAX_EVENTS; processed += 1) {
    const candidate = queue.next();
    if (!candidate) {
      break;
    }
    const step = await replayUnlinkedWebhookEvent(deps, candidate, result);
    if (step === 'stopped') {
      result.pending = queue.remaining() + 1;
      break;
    }
    if (step === 'continue') {
      // Left unlinked (or finished elsewhere): it is queued again if its reference is regained.
      queue.release(candidate);
    }
    // Applied events, skipped ones that linked a missing reference, and events another run finished
    // (which may have stopped before replaying what they linked) can add a reference.
    const current = await getSubscriptionById(deps, subscription.id);
    if (current) {
      latest = current;
      await queue.discover(current);
    }
  }
  // Events on a reference held earlier in the pass and lost since (including to another run) are
  // marked replaced; they are no longer replayable.
  const latestReferences = providerReferencesOf(latest);
  const lost = queue.heldReferences().filter((reference) => !latestReferences.includes(reference));
  await recordReplacedReferenceEvents(deps, subscription.provider, lost, latestReferences);
  // An unread event on a reference the subscription no longer holds is recorded as replaced, not retried.
  result.windowUnread = result.unreadRows?.find((unread) => namesAnyReference(unread.row, latestReferences));
  const remaining = queue.remaining(latestReferences);
  if (!result.held && !result.failure && remaining > 0) {
    // The bound was reached with replayable events left: the replay is unfinished, so the operation is retried.
    result.pending = remaining;
    result.bounded = true;
  }

  if (result.applied > 0 || result.skipped > 0) {
    deps.metrics.track('webhook.unlinked.replayed', {
      provider: subscription.provider,
      applied: result.applied,
      skipped: result.skipped
    });
  }
  return result;
}

/**
 * The ordered replay queue. `discover` merges the unexpired events stored for
 * every reference the subscription gained since the previous discovery (a
 * first gain or a regain); `release` lets a visited event that stayed unlinked
 * be queued again. `heldReferences` lists every reference seen in the pass.
 */
function createUnlinkedReplayQueue(deps: ServiceDeps, provider: BillingProviderName) {
  const timestamp = toIsoString(deps.now());
  let observed = new Set<string>();
  const held = new Set<string>();
  const queued = new Set<string>();
  let pending: BillFnUnlinkedWebhookEvent[] = [];
  return {
    async discover(subscription: BillFnSubscription) {
      const current = providerReferencesOf(subscription);
      const gained = current.filter((reference) => !observed.has(reference));
      observed = new Set(current);
      current.forEach((reference) => held.add(reference));
      if (gained.length === 0) {
        return;
      }
      const found = await findUnlinkedWebhookEventsForReferences(deps, provider, gained, timestamp);
      const added = found.filter((row) => !queued.has(row.id));
      added.forEach((row) => queued.add(row.id));
      pending = [...pending, ...added].sort(compareUnlinkedWebhookEvents);
    },
    release: (row: BillFnUnlinkedWebhookEvent) => queued.delete(row.id),
    /** Every reference the subscription held during the pass. */
    heldReferences: () => [...held],
    next: () => pending.shift(),
    /** Queued events, or with `references` only those naming one: the ones a later replay still finds. */
    remaining: (references?: string[]) =>
      references ? pending.filter((row) => namesAnyReference(row, references)).length : pending.length
  };
}

/**
 * Marks every unfinished event stored for a reference a subscription dropped,
 * and naming none it kept, with reason `provider_reference_replaced`, whatever
 * it was left as (window-unread, unresolved, not visited, or claimed by a
 * replay run that may never release it). The recorded reference, not this
 * reason, keeps such an event from bootstrapping. Only the reason (and an
 * unclaimed event's last error) is written, never on an event another run
 * finished, so a run holding the event
 * keeps its claim. A regain still replays it, since discovery ignores the
 * reason, as does the subscription that holds a reference it names.
 */
async function recordReplacedReferenceEvents(deps: ServiceDeps, provider: BillingProviderName, dropped: string[], kept: string[]) {
  if (dropped.length === 0) {
    return;
  }
  const timestamp = toIsoString(deps.now());
  const rows = await findUnlinkedWebhookEventsForReferences(deps, provider, dropped, timestamp);
  const stale = rows.filter((row) => row.reason !== 'provider_reference_replaced' && !namesAnyReference(row, kept));
  const replaced = { reason: 'provider_reference_replaced', updatedAt: timestamp };
  const record = (row: BillFnUnlinkedWebhookEvent, statuses: string[], data: Record<string, unknown>) =>
    deps.db.updateMany({
      model: TABLES.unlinkedWebhookEvents,
      where: [
        { field: 'id', operator: 'eq', value: row.id },
        { field: 'status', operator: 'in', value: statuses }
      ],
      data,
      namespace: deps.namespace
    });
  // An unclaimed event also drops its last replay error; a claimed one gets only the reason.
  await Promise.all(
    stale.map(async (row) => {
      if ((await record(row, ['unlinked'], { ...replaced, error: null })) === 0) {
        await record(row, ['unlinked', 'replaying'], replaced);
      }
    })
  );
}

/**
 * Before a write from `before` to `after`, records each reference it drops, and
 * each one `before` has pending that `after` does not hold, as replaced
 * (`recordReplacedProviderReferences`), then marks the retained events on them.
 * A failure throws, except during a committed provider mutation, which is never
 * failed by it: the references it could not record are returned, and its write
 * saves them pending (`withPendingReplacements`). Pending references are
 * recorded here before the caller's write clears them, so a guard that reads
 * pending and then recorded references never misses one
 * (`namesReplacedReference`).
 */
async function recordDroppedReferences(
  deps: ServiceDeps,
  before: BillFnSubscription,
  after: BillFnSubscription,
  committed: boolean
): Promise<string[]> {
  const kept = providerReferencesOf(after);
  const dropped = [...new Set([...providerReferencesOf(before), ...pendingReplacedReferencesOf(before)])].filter(
    (reference) => !kept.includes(reference)
  );
  if (dropped.length === 0) {
    return [];
  }
  try {
    await recordReplacedProviderReferences(deps, before, dropped);
  } catch (error) {
    if (!committed) {
      throw error;
    }
    return dropped;
  }
  try {
    await recordReplacedReferenceEvents(deps, before.provider, dropped, kept);
  } catch (error) {
    // Once the reference is recorded, the events' reason is informational.
    if (!committed) {
      throw error;
    }
  }
  return [];
}

/**
 * Records references a subscription dropped in `replacedProviderReferences`,
 * one row per provider and reference, naming the subscription that dropped it
 * last. While no subscription holds the reference, no event naming it, with
 * any event id or billing account metadata, bootstraps a subscription.
 */
async function recordReplacedProviderReferences(
  deps: ServiceDeps,
  subscription: Pick<BillFnSubscription, 'id' | 'billingAccountId' | 'provider'>,
  references: string[]
) {
  const timestamp = toIsoString(deps.now());
  const data = { subscriptionId: subscription.id, billingAccountId: subscription.billingAccountId, replacedAt: timestamp, updatedAt: timestamp };
  await Promise.all(
    references.map(async (providerReference) => {
      const id = `rpr_${subscription.provider}_${Buffer.from(providerReference).toString('base64url')}`;
      const update = () =>
        deps.db.updateMany({
          model: TABLES.replacedProviderReferences,
          where: [{ field: 'id', operator: 'eq', value: id }],
          data,
          namespace: deps.namespace
        });
      if ((await update()) > 0) {
        return;
      }
      try {
        await deps.db.create<BillFnReplacedProviderReference>({
          model: TABLES.replacedProviderReferences,
          data: { id, provider: subscription.provider, providerReference, ...data, createdAt: timestamp },
          namespace: deps.namespace
        });
      } catch (error) {
        // A concurrent write recorded it first.
        if (!isDuplicateRecordError(error)) {
          throw error;
        }
        await update();
      }
    })
  );
}

/** The references a subscription's write saved pending, without any it holds again. */
function pendingReplacedReferencesOf(subscription: BillFnSubscription) {
  const pending = subscription.metadata?.[PENDING_REPLACED_REFERENCES_METADATA_KEY];
  const held = new Set(providerReferencesOf(subscription));
  return Array.isArray(pending)
    ? pending.filter((reference): reference is string => typeof reference === 'string' && !held.has(reference))
    : [];
}

/** A write's metadata and flag for the references it saves pending; both are cleared once none are. */
function withPendingReplacements(metadata: Record<string, unknown> | undefined, pending: string[]) {
  const { [PENDING_REPLACED_REFERENCES_METADATA_KEY]: _previous, ...rest } = metadata ?? {};
  return pending.length > 0
    ? { metadata: { ...rest, [PENDING_REPLACED_REFERENCES_METADATA_KEY]: pending }, replacedReferencesPending: true }
    : { metadata: rest, replacedReferencesPending: null };
}

/**
 * Whether an event that resolves to no subscription names a replaced
 * reference, whatever its event id or the account its metadata names: one a
 * subscription write dropped and recorded, one a committed mutation's write
 * saved pending (any subscription of the provider), or the one it was
 * retained on when a replay replaced it. A reference a subscription holds
 * again resolves to it first. Only bootstrap is gated by it.
 *
 * Linearization contract with the writers: a write that drops a held
 * reference either records it (`recordDroppedReferences`) before the write or
 * saves it pending in that same write; a later write records a pending
 * reference before its write clears the pending flag; recorded references are
 * never deleted. The reads therefore run one after another in the opposite
 * order, after the caller found no holder: pending, then recorded, then the
 * retained event. A writer that clears pending between them has already
 * recorded the reference, so one of the reads sees it.
 */
async function namesReplacedReference(
  deps: ServiceDeps,
  provider: BillingProviderName,
  event: ParsedProviderEvent,
  state: VerifiedBillingState
) {
  const references = [state.providerSubscriptionId, state.providerChargeId].filter(
    (reference): reference is string => typeof reference === 'string' && reference.length > 0
  );
  const named = new Set(references);
  if (named.size > 0) {
    const pending = await deps.db.findMany<BillFnSubscription>({
      model: TABLES.subscriptions,
      where: [
        { field: 'provider', operator: 'eq', value: provider },
        { field: 'replacedReferencesPending', operator: 'eq', value: true }
      ],
      namespace: deps.namespace
    });
    if (pending.some((subscription) => pendingReplacedReferencesOf(subscription).some((reference) => named.has(reference)))) {
      return true;
    }
    const replaced = await deps.db.findMany<BillFnReplacedProviderReference>({
      model: TABLES.replacedProviderReferences,
      where: [
        { field: 'provider', operator: 'eq', value: provider },
        { field: 'providerReference', operator: 'in', value: references }
      ],
      namespace: deps.namespace
    });
    if (replaced.length > 0) {
      return true;
    }
  }
  const retained = await deps.db.findOne<BillFnUnlinkedWebhookEvent>({
    model: TABLES.unlinkedWebhookEvents,
    where: [{ field: 'id', operator: 'eq', value: buildUnlinkedWebhookEventId(provider, event.providerEventId) }],
    namespace: deps.namespace
  });
  return retained?.reason === 'provider_reference_replaced';
}

function namesAnyReference(row: BillFnUnlinkedWebhookEvent, references: string[]) {
  return [row.providerReference, row.providerSecondaryReference].some(
    (reference) => typeof reference === 'string' && references.includes(reference)
  );
}

async function findUnlinkedWebhookEventsForReferences(
  deps: ServiceDeps,
  provider: BillingProviderName,
  references: string[],
  timestamp: string
) {
  const byField = await Promise.all(
    (['providerReference', 'providerSecondaryReference'] as const).map((field) =>
      deps.db.findMany<BillFnUnlinkedWebhookEvent>({
        model: TABLES.unlinkedWebhookEvents,
        where: [
          { field: 'provider', operator: 'eq', value: provider },
          { field, operator: 'in', value: references },
          { field: 'status', operator: 'in', value: ['unlinked', 'replaying'] }
        ],
        namespace: deps.namespace
      })
    )
  );
  const rows = new Map(byField.flat().map((row) => [row.id, row]));
  return [...rows.values()].filter((row) => row.expiresAt > timestamp);
}

/**
 * Claims and applies one retained event, then finishes or releases its row.
 * `finished`: applied or skipped; `continue`: finished by another run, or
 * displaced, unresolved or window-unread and left unlinked; `stopped`: held by
 * another run or failed.
 * The caller looks for newly linked references after every step but `stopped`.
 */
async function replayUnlinkedWebhookEvent(
  deps: ServiceDeps,
  candidate: BillFnUnlinkedWebhookEvent,
  result: UnlinkedReplayResult
): Promise<'finished' | 'continue' | 'stopped'> {
  const claimId = deps.generateId('uwr');
  const claim = await claimUnlinkedWebhookEvent(deps, candidate, claimId);
  if (claim === 'finished') {
    return 'continue';
  }
  if (claim === 'held') {
    result.held = true;
    return 'stopped';
  }
  let outcome: UnlinkedReplayOutcome | null = null;
  let failure: string | null = null;
  try {
    outcome = await applyUnlinkedWebhookEvent(deps, candidate);
  } catch (error) {
    // Stop on any failure, whatever its message: a later event must not advance past this one.
    failure = errorMessage(error);
    result.failure = { error };
  }
  const finishedAt = toIsoString(deps.now());
  await deps.db.updateMany({
    model: TABLES.unlinkedWebhookEvents,
    where: [
      { field: 'id', operator: 'eq', value: candidate.id },
      { field: 'replayClaimId', operator: 'eq', value: claimId }
    ],
    data: unlinkedReplayRowUpdate(outcome, failure, finishedAt),
    namespace: deps.namespace
  });
  if (!outcome) {
    deps.metrics.track('webhook.unlinked.replay_stopped', {
      provider: candidate.provider,
      providerEventId: candidate.providerEventId,
      reason: 'error'
    });
    return 'stopped';
  }
  if (outcome.kind === 'replayed' || outcome.kind === 'skipped') {
    result[outcome.kind === 'replayed' ? 'applied' : 'skipped'] += 1;
    return 'finished';
  }
  if (outcome.kind === 'window_unread') {
    // Retained with its error; the operation fails after the pass, so its retry reads the provider again.
    result.unreadRows = [...(result.unreadRows ?? []), { row: candidate, error: outcome.error }];
  }
  // A displaced event, delivered in order, would have been stored unlinked as well, so it stays
  // unlinked (and replays if its reference is linked again) and does not hold back later events.
  deps.metrics.track('webhook.unlinked.replay_unresolved', {
    provider: candidate.provider,
    providerEventId: candidate.providerEventId,
    reason: outcome.kind
  });
  return 'continue';
}

/** Finishes a replayed or skipped row, or releases it as unlinked with its error and, if displaced, reason. */
function unlinkedReplayRowUpdate(outcome: UnlinkedReplayOutcome | null, failure: string | null, finishedAt: string) {
  const released = { replayClaimId: null, replayClaimedAt: null, updatedAt: finishedAt };
  if (outcome?.kind === 'replayed' || outcome?.kind === 'skipped') {
    return { ...released, status: outcome.kind, subscriptionId: outcome.subscriptionId, replayedAt: finishedAt, error: null };
  }
  return {
    ...released,
    status: 'unlinked',
    error: outcome?.kind === 'window_unread' ? errorMessage(outcome.error) : failure,
    // A replaced reference is recorded, so the event never bootstraps another subscription later.
    ...(outcome?.kind === 'displaced' ? { reason: 'provider_reference_replaced' } : {})
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function providerReferencesOf(subscription: BillFnSubscription) {
  return [...new Set([subscription.providerSubscriptionId, subscription.providerChargeId])].filter(
    (reference): reference is string => typeof reference === 'string' && reference.length > 0
  );
}

/** Whether a write gave the subscription a provider reference it did not have, linking events stored for it. */
function addsProviderReference(before: BillFnSubscription | null | undefined, after: BillFnSubscription) {
  const previous = before ? providerReferencesOf(before) : [];
  return providerReferencesOf(after).some((reference) => !previous.includes(reference));
}

async function applyUnlinkedWebhookEvent(
  deps: ServiceDeps,
  row: BillFnUnlinkedWebhookEvent
): Promise<UnlinkedReplayOutcome> {
  const event = deserializeParsedWebhookEvent(row.event);
  const state = event?.billingState;
  if (!event || !state) {
    return { kind: 'unresolved' };
  }
  const projection = await resolveProjectionContextForProviderState(deps, {
    provider: row.provider,
    state,
    checkoutReferenceId: event.checkoutReferenceId
  });
  if (!projection?.subscription) {
    // The row was found by a reference of the subscription, which an event replayed before it replaced.
    return { kind: 'displaced' };
  }
  // An event without a provider time is ordered by when it was stored, through the same ordered write.
  const occurredAt = event.occurredAt ?? row.createdAt;
  let applied: ProjectionResult | null;
  try {
    applied = await applyParsedWebhookEvent(deps, row.provider, { ...event, occurredAt, billingState: state }, projection);
  } catch (error) {
    // An unread event inside a mutation window stays retained without holding back the events after it.
    if (isWindowReadFailure(error)) {
      return { kind: 'window_unread', error };
    }
    throw error;
  }
  return applied
    ? { kind: 'replayed', subscriptionId: applied.subscription.id }
    : { kind: 'skipped', subscriptionId: projection.subscription.id };
}

/**
 * Claims a row for this replay run. `finished` means another run completed it
 * since it was read; `held` means another run holds an unexpired claim on it,
 * or released it after a failure, so it is not finished.
 */
async function claimUnlinkedWebhookEvent(
  deps: ServiceDeps,
  row: BillFnUnlinkedWebhookEvent,
  claimId: string
): Promise<'claimed' | 'held' | 'finished'> {
  const claimTime = deps.now();
  const where: WhereClause[] = [
    { field: 'id', operator: 'eq', value: row.id },
    { field: 'status', operator: 'eq', value: row.status }
  ];
  if (row.status === 'replaying') {
    const previousClaimedAt = row.replayClaimedAt ? Date.parse(row.replayClaimedAt) : Number.NaN;
    if (
      Number.isFinite(previousClaimedAt) &&
      claimTime.getTime() - previousClaimedAt < UNLINKED_WEBHOOK_EVENT_REPLAY_LEASE_MS
    ) {
      return 'held';
    }
    where.push({ field: 'replayClaimId', operator: 'eq', value: row.replayClaimId ?? null });
  }
  const claimed = await deps.db.updateMany({
    model: TABLES.unlinkedWebhookEvents,
    where,
    data: {
      status: 'replaying',
      replayClaimId: claimId,
      replayClaimedAt: toIsoString(claimTime),
      updatedAt: toIsoString(claimTime)
    },
    namespace: deps.namespace
  });
  if (claimed === 1) {
    return 'claimed';
  }
  const current = await deps.db.findOne<BillFnUnlinkedWebhookEvent>({
    model: TABLES.unlinkedWebhookEvents,
    where: [{ field: 'id', operator: 'eq', value: row.id }],
    namespace: deps.namespace
  });
  return !current || current.status === 'replayed' || current.status === 'skipped' ? 'finished' : 'held';
}

function compareUnlinkedWebhookEvents(left: BillFnUnlinkedWebhookEvent, right: BillFnUnlinkedWebhookEvent) {
  const leftTime = left.occurredAt ? parseProviderEventTime(left.occurredAt) : null;
  const rightTime = right.occurredAt ? parseProviderEventTime(right.occurredAt) : null;
  if (leftTime !== rightTime) {
    // Events without a provider time cannot be ordered against timed ones and go last.
    if (leftTime === null) {
      return 1;
    }
    if (rightTime === null) {
      return -1;
    }
    return leftTime - rightTime;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/**
 * Replays and fails the operation that linked the reference unless every
 * retained event for it is finished, so that operation is retried (a webhook
 * receipt stays unprocessed and the provider redelivers it, a queued webhook
 * job is retried after the replay lease expires, and checkout verification or
 * restore can be called again). An event that could not be applied is
 * released first and its error rethrown; an event another replay run still
 * holds, including a run interrupted before it released the event, raises a
 * lease conflict. An event inside a mutation window whose read failed raises
 * that window-read error once the rest of the replay is done, unless its
 * reference was replaced meanwhile or `deferWindowUnread` returns it for the
 * caller to raise later.
 */
async function replayUnlinkedWebhookEventsOrThrow(
  deps: ServiceDeps,
  subscription: BillFnSubscription,
  options: { deferWindowUnread?: boolean } = {}
) {
  const result = await replayUnlinkedWebhookEvents(deps, subscription);
  if (result.failure) {
    throw result.failure.error;
  }
  if (result.held) {
    throw reconciliationLeaseConflict('Unlinked webhook events for this provider reference are being replayed');
  }
  if (result.bounded) {
    throw unlinkedReplayBounded(result.applied + result.skipped > 0);
  }
  if (result.windowUnread && !options.deferWindowUnread) {
    throw result.windowUnread.error;
  }
  return result;
}

const unlinkedReplayBoundErrors = new WeakSet<object>();
const productiveReplayBoundErrors = new WeakSet<object>();

/**
 * An unfinished replay that reached its bound, reported as `bounded`. One that
 * finished events (`productive`) is continued by a queue worker in a fresh
 * message; otherwise, and without a queue, it is retried like a lease conflict.
 */
function unlinkedReplayBounded(productive: boolean) {
  const error = reconciliationLeaseConflict('Unlinked webhook event replay reached its bound with events left');
  unlinkedReplayBoundErrors.add(error);
  if (productive) {
    productiveReplayBoundErrors.add(error);
  }
  return error;
}

function isProductiveReplayBound(error: unknown) {
  return typeof error === 'object' && error !== null && productiveReplayBoundErrors.has(error);
}

function replayDeferredReason(error: unknown) {
  if (typeof error === 'object' && error !== null && unlinkedReplayBoundErrors.has(error)) {
    return 'bounded';
  }
  return isReconciliationLeaseConflict(error) ? 'held' : 'error';
}

/**
 * Applies state from a live provider read or a provider mutation response
 * (checkout verification, restore, sync, cancel, change, resume, refund).
 * `liveStateObservedAt` is when the provider call started: a read saves it as
 * the subscription's provider-state time, and a state an event newer than it
 * has superseded only links its references. A committed mutation is ordered by
 * `committedAt`, when the provider call returned, instead. The retained unlinked events for the
 * resulting reference set are then replayed every time, not only when this
 * call added a reference, so a retry after an interrupted replay applies them;
 * events older than the read are skipped. Returns the projection after replay.
 *
 * A read (verification, restore, sync) fails when the replay does not finish,
 * so the read is retried. After a provider mutation has committed, the replay
 * is best-effort (`onReplayDeferred` set): an unfinished replay is recorded and
 * handed to `onReplayDeferred`, its events stay retained for the next webhook,
 * sync or live read, and the mutation still returns its result, because
 * retrying it would repeat the provider mutation.
 */
async function applyLiveProviderState(
  deps: ServiceDeps,
  input: ApplyVerificationStateInput & { occurredAt?: undefined; liveStateObservedAt: string },
  options: { onReplayDeferred?: (subscription: BillFnSubscription) => Promise<void> } = {}
): Promise<ProjectionResult> {
  const result = await applyVerificationState(deps, input);
  if (!options.onReplayDeferred) {
    await replayUnlinkedWebhookEventsOrThrow(deps, result.subscription);
    return refreshProjectionAfterReplay(deps, result);
  }
  await replayAfterCommittedMutation(deps, result, options.onReplayDeferred);
  try {
    return { ...(await refreshProjectionAfterReplay(deps, result)), providerStateRaced: result.providerStateRaced };
  } catch (error) {
    // The provider mutation and its state are committed; a failed re-read returns the written state.
    deps.metrics.track('webhook.unlinked.replay_refresh_failed', {
      provider: result.subscription.provider,
      subscriptionId: result.subscription.id,
      error: error instanceof Error ? error.message : String(error)
    });
    return result;
  }
}

/** A replay after a committed provider mutation that cannot finish now is deferred, never failing the mutation. */
async function replayAfterCommittedMutation(
  deps: ServiceDeps,
  { subscription }: ProjectionResult,
  onReplayDeferred: (subscription: BillFnSubscription) => Promise<void>
) {
  try {
    await replayUnlinkedWebhookEventsOrThrow(deps, subscription);
  } catch (error) {
    deps.metrics.track('webhook.unlinked.replay_deferred', {
      provider: subscription.provider,
      subscriptionId: subscription.id,
      reason: replayDeferredReason(error),
      error: error instanceof Error ? error.message : String(error)
    });
    try {
      await onReplayDeferred(subscription);
    } catch (deferError) {
      deps.metrics.track('webhook.unlinked.replay_defer_failed', {
        provider: subscription.provider,
        subscriptionId: subscription.id,
        error: deferError instanceof Error ? deferError.message : String(deferError)
      });
    }
  }
}

/** Another run may have replayed events for these references since the write, so the state is read again. */
async function refreshProjectionAfterReplay(deps: ServiceDeps, result: ProjectionResult): Promise<ProjectionResult> {
  const subscription = (await getSubscriptionById(deps, result.subscription.id)) ?? result.subscription;
  const entitlements = (await findEntitlementSnapshot(deps, subscription.billingAccountId)) ?? result.entitlements;
  const checkoutSession = result.checkoutSession
    ? ((await getCheckoutSession(deps, result.checkoutSession.checkoutSessionId)) ?? result.checkoutSession)
    : undefined;
  return { checkoutSession, subscription, entitlements };
}

function readBillingAccountMetadata(event: ParsedProviderEvent, state: VerifiedBillingState) {
  const stateRaw = asRecord(state.raw);
  const candidates = [
    asRecord(stateRaw?.metadata),
    asRecord(event.raw.metadata),
    asRecord(asRecord(event.raw.data)?.metadata)
  ];
  for (const metadata of candidates) {
    const value = metadata ? readString(metadata, BILLING_ACCOUNT_METADATA_KEY) : null;
    if (value) {
      return value;
    }
  }
  return null;
}

function buildUnlinkedWebhookEventId(provider: BillingProviderName, providerEventId: string) {
  return `uwe_${provider}_${Buffer.from(providerEventId).toString('base64url')}`;
}

async function resolveProviderEventPriceReference(
  deps: ServiceDeps,
  provider: BillingProviderName,
  event: {
    type: string;
    priceId?: string;
    billingState?: NonNullable<Awaited<ReturnType<NonNullable<BillFnProviderAdapter['verifyCheckout']>>>>;
  },
  subscription: BillFnSubscription | null
) {
  const normalizedType = event.type.toLowerCase();
  const schedulingOnly = normalizedType.includes('change_renewal_pref');
  if (!schedulingOnly) {
    const raw = asRecord(event.billingState?.raw);
    // A provider record may carry its product on the transaction it describes (Apple).
    const records = [raw, asRecord(raw?.transaction)];
    const references = [
      event.billingState?.providerProductId,
      event.priceId,
      ...records.flatMap((record) =>
        record ? ['product_id', 'productId', 'price_id', 'priceId'].map((key) => readString(record, key)) : []
      )
    ];
    const resolved = findCatalogPriceReference(deps.catalog, provider, references, subscription?.priceId);
    if (resolved) {
      return resolved;
    }
  }

  if (!subscription || (!normalizedType.includes('renew') && !normalizedType.includes('plan_changed'))) {
    return null;
  }
  const changeRequests = await deps.db.findMany<BillFnSubscriptionChangeRequest>({
    model: TABLES.subscriptionChangeRequests,
    where: [
      { field: 'subscriptionId', operator: 'eq', value: subscription.id },
      { field: 'effectiveAt', operator: 'eq', value: 'next_renewal' },
      { field: 'status', operator: 'eq', value: 'applied' }
    ],
    orderBy: [{ field: 'updatedAt', direction: 'desc' }],
    namespace: deps.namespace
  });
  const latest = changeRequests[0];
  return latest ? requirePriceReference(deps.catalog, latest.targetPriceId) : null;
}

/**
 * The catalog price the references name: an exact catalog price id first, then
 * a provider product id. A product several prices share names the current
 * price if it is one of them, else the first of them when they are all in one
 * plan; across plans it names none, so the caller keeps its stored selection.
 */
function findCatalogPriceReference(
  catalog: BillFnCatalog,
  provider: BillingProviderName,
  references: Array<string | null | undefined>,
  currentPriceId?: string
): CatalogSelection | null {
  const prices = catalog.plans.flatMap((plan) =>
    plan.prices.filter((price) => price.provider === provider).map((price) => ({ plan, price }))
  );
  const named = references.filter((reference): reference is string => Boolean(reference));
  for (const reference of named) {
    const exact = prices.find((candidate) => candidate.price.priceId === reference);
    if (exact) {
      return exact;
    }
  }
  for (const reference of named) {
    const products = prices.filter((candidate) => candidate.price.providerProductId === reference);
    const current = products.find((candidate) => candidate.price.priceId === currentPriceId);
    if (current || new Set(products.map((candidate) => candidate.plan.planKey)).size === 1) {
      return current ?? products[0];
    }
  }
  return null;
}

function jobToQueuePayload(job: BillFnReconciliationJob): BillFnQueuedJob {
  switch (job.kind) {
    case 'webhook-event':
      return {
        type: 'webhook-event',
        jobId: job.id,
        provider: job.provider as BillingProviderName,
        providerEventId: job.providerEventId as string
      };
    case 'subscription-sync':
      return {
        type: 'subscription-sync',
        jobId: job.id,
        provider: job.provider as BillingProviderName,
        subscriptionId: job.subscriptionId as string
      };
    case 'account-scan':
      return {
        type: 'account-scan',
        jobId: job.id,
        provider: job.provider,
        billingAccountId: job.billingAccountId as string
      };
    case 'notification-history-backfill':
      return {
        type: 'notification-history-backfill',
        jobId: job.id,
        provider: job.provider as BillingProviderName,
        cursor: job.cursor
      };
    case 'webhook-replay':
      return {
        type: 'webhook-replay',
        jobId: job.id,
        provider: job.provider as BillingProviderName,
        providerEventId: job.providerEventId as string
      };
  }
}

function buildWebhookReceiptId(provider: BillingProviderName, providerEventId: string) {
  return `whr_${provider}_${Buffer.from(providerEventId).toString('base64url')}`;
}

function serializeParsedWebhookEvent(event: {
  providerEventId: string;
  type: string;
  signatureVerified: boolean;
  occurredAt?: string;
  planKey?: string;
  priceId?: string;
  providerSubscriptionId?: string;
  providerChargeId?: string;
  checkoutReferenceId?: string;
  billingState?: NonNullable<Awaited<ReturnType<NonNullable<BillFnProviderAdapter['verifyCheckout']>>>>;
  raw: Record<string, unknown>;
}) {
  return {
    providerEventId: event.providerEventId,
    type: event.type,
    signatureVerified: event.signatureVerified,
    occurredAt: event.occurredAt,
    planKey: event.planKey,
    priceId: event.priceId,
    providerSubscriptionId: event.providerSubscriptionId,
    providerChargeId: event.providerChargeId,
    checkoutReferenceId: event.checkoutReferenceId,
    billingState: event.billingState,
    raw: event.raw
  };
}

function deserializeParsedWebhookEvent(value: unknown) {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  return {
    providerEventId: readString(record, 'providerEventId') ?? 'unknown',
    type: readString(record, 'type') ?? 'unknown',
    signatureVerified: record.signatureVerified === true,
    occurredAt: readString(record, 'occurredAt') ?? undefined,
    planKey: readString(record, 'planKey') ?? undefined,
    priceId: readString(record, 'priceId') ?? undefined,
    providerSubscriptionId: readString(record, 'providerSubscriptionId') ?? undefined,
    providerChargeId: readString(record, 'providerChargeId') ?? undefined,
    checkoutReferenceId: readString(record, 'checkoutReferenceId') ?? undefined,
    billingState: asRecord(record.billingState) as unknown as NonNullable<
      Awaited<ReturnType<NonNullable<BillFnProviderAdapter['verifyCheckout']>>>
    > | undefined,
    raw: asRecord(record.raw) ?? {}
  };
}

function readString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readProviderStateOccurredAt(subscription: BillFnSubscription | null | undefined) {
  const metadata = asRecord(subscription?.metadata);
  return metadata ? readString(metadata, PROVIDER_EVENT_OCCURRED_AT_METADATA_KEY) : null;
}

/** The later of two provider-state times; an unparsable current time is replaced. */
function laterProviderEventTime(current: string | null, candidate: string) {
  const currentTime = current ? parseProviderEventTime(current) : null;
  const candidateTime = parseProviderEventTime(candidate);
  if (currentTime === null || candidateTime === null) {
    return currentTime === null ? candidate : (current as string);
  }
  return candidateTime > currentTime ? candidate : (current as string);
}

function isProviderEventOlderThanSubscription(subscription: BillFnSubscription, occurredAt: string) {
  const lastOccurredAt = readProviderStateOccurredAt(subscription);
  if (!lastOccurredAt) {
    return false;
  }
  const incomingTime = parseProviderEventTime(occurredAt);
  const currentTime = parseProviderEventTime(lastOccurredAt);
  return incomingTime !== null && currentTime !== null && incomingTime < currentTime;
}

/**
 * Orders an event against the subscription's provider state. A newer event is
 * applied and an older one skipped; one at the same time is applied. An event
 * inside the open window of the committed provider mutation that set that
 * state (after the provider call started, up to and including when it
 * returned) cannot be ordered against the mutation and is never applied over
 * it: the subscription is reconciled with a provider read instead.
 */
function orderProviderEvent(subscription: BillFnSubscription, occurredAt: string): 'apply' | 'skip' | 'reconcile' {
  const startedAt = readMutationStartedAt(subscription);
  const stateAt = readProviderStateOccurredAt(subscription);
  const startTime = startedAt ? parseProviderEventTime(startedAt) : null;
  const stateTime = stateAt ? parseProviderEventTime(stateAt) : null;
  const incomingTime = parseProviderEventTime(occurredAt);
  if (startTime !== null && stateTime !== null && incomingTime !== null && incomingTime > startTime && incomingTime <= stateTime) {
    return 'reconcile';
  }
  return isProviderEventOlderThanSubscription(subscription, occurredAt) ? 'skip' : 'apply';
}

function readMutationStartedAt(subscription: BillFnSubscription) {
  const metadata = asRecord(subscription.metadata);
  return metadata ? readString(metadata, PROVIDER_MUTATION_STARTED_AT_METADATA_KEY) : null;
}

const windowReadFailures = new WeakSet<object>();

/** No provider read succeeded for an event inside a committed mutation's window and no sync could be queued. */
function windowReadFailed(cause: unknown) {
  const error = createBillFnError({
    code: 'BILLFN_PROVIDER_ERROR',
    message: `Provider read for an event inside a committed mutation window failed: ${
      cause instanceof Error ? cause.message : String(cause)
    }`
  });
  windowReadFailures.add(error);
  return error;
}

function isWindowReadFailure(error: unknown) {
  return typeof error === 'object' && error !== null && windowReadFailures.has(error);
}

function withoutMutationWindow(metadata: Record<string, unknown> | undefined) {
  if (!metadata || !(PROVIDER_MUTATION_STARTED_AT_METADATA_KEY in metadata)) {
    return metadata;
  }
  const { [PROVIDER_MUTATION_STARTED_AT_METADATA_KEY]: _closed, ...rest } = metadata;
  return rest;
}

/**
 * Handles an event inside a committed mutation's window: links its missing
 * references and reconciles the subscription with an inline provider read
 * (`reconcileProviderState`). When the provider cannot be read, the committed
 * mutation's state stands. The event is never applied over the mutation.
 */
async function reconcileMutationWindowEvent(
  deps: ServiceDeps,
  subscription: BillFnSubscription,
  input: Pick<ApplyVerificationStateInput, 'state' | 'providerEventId' | 'plan' | 'price'>
) {
  const linked = await linkSkippedEventReferences(deps, subscription, input.state);
  const readable = Boolean(deps.reconcileProviderState) && typeof deps.providers[linked.provider]?.fetchSubscription === 'function';
  deps.metrics.track(readable ? 'subscription.mutation.window_event' : 'subscription.mutation.window_event_unreconciled', {
    provider: linked.provider,
    subscriptionId: linked.id
  });
  if (readable) {
    await deps.reconcileProviderState?.(linked, {
      providerEventId: input.providerEventId,
      selection: { plan: input.plan, price: input.price }
    });
  }
}

/**
 * Closes the committed mutation window a reconcile read covered, once its
 * effects are recorded; a newer mutation's window is left open.
 */
async function closeMutationWindow(deps: ServiceDeps, subscriptionId: string, startedAt: string | null) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const current = await getSubscriptionById(deps, subscriptionId);
    const metadata = asRecord(current?.metadata);
    if (!current || !metadata || !startedAt || readMutationStartedAt(current) !== startedAt) {
      return;
    }
    const closed = {
      ...current,
      metadata: withoutMutationWindow(metadata),
      updatedAt: nextSubscriptionUpdatedAt(deps.now(), current.updatedAt)
    };
    if (await writeOrderedSubscription(deps, current, closed)) {
      return;
    }
  }
  throw createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'Unable to close the mutation window after multiple retries'
  });
}

function nextSubscriptionUpdatedAt(now: Date, previous?: string) {
  const currentTime = now.getTime();
  const previousTime = previous ? Date.parse(previous) : Number.NaN;
  return toIsoString(new Date(Number.isFinite(previousTime) && currentTime <= previousTime ? previousTime + 1 : currentTime));
}

function buildEntitlementSourceEventId(subscription: BillFnSubscription) {
  return `${subscription.id}@${subscription.updatedAt}`;
}

function isEntitlementFromNewerSubscription(
  snapshot: BillFnEntitlementSnapshot,
  subscription: BillFnSubscription
) {
  const prefix = `${subscription.id}@`;
  if (!snapshot.sourceEventId?.startsWith(prefix)) {
    return false;
  }
  const snapshotTime = Date.parse(snapshot.sourceEventId.slice(prefix.length));
  const subscriptionTime = Date.parse(subscription.updatedAt);
  return Number.isFinite(snapshotTime) && Number.isFinite(subscriptionTime) && snapshotTime > subscriptionTime;
}

function parseProviderEventTime(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    }
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function assertNonNegativeFiniteAmount(value: number, fieldName: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: `${fieldName} must be a non-negative finite number`
    });
  }
}

function assertFiniteAmount(value: number, fieldName: string) {
  if (!Number.isFinite(value)) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: `${fieldName} must be a finite number`
    });
  }
}

function isDuplicateRecordError(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    if (current instanceof DuplicateKeyError) {
      return true;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    const code = record.code;
    const errno = record.errno;
    if (
      ((typeof code === 'string' || typeof code === 'number') && DUPLICATE_RECORD_ERROR_CODES.has(String(code))) ||
      errno === 1062
    ) {
      return true;
    }
    const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
    if (
      message.includes('unique constraint failed') ||
      message.includes('duplicate key value violates unique constraint') ||
      message.includes('duplicate entry') ||
      message.includes('e11000 duplicate key')
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

function isBillFnNotFoundError(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: string }).code === 'BILLFN_NOT_FOUND'
  );
}

function mergeJson(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!existing && !incoming) {
    return undefined;
  }
  return {
    ...(existing ?? {}),
    ...(incoming ?? {})
  };
}
