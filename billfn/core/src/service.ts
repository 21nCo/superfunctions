import { createHash } from 'node:crypto';
import { DuplicateKeyError, type Adapter, type WhereClause } from '@superfunctions/db';
import { ok } from '@superfunctions/envelope';
import { createNamespacedEmitter, createMetricsEmitter, type MetricsEmitter } from '@superfunctions/metrics';
import { createBillFnError } from './errors.js';
import { BILLFN_REGION_METADATA_KEY } from './ingress.js';
import {
  applyGrants,
  insertGrant,
  listRepairedGrants,
  readCreateGrantInput,
  repairGrantEvents,
  repairPendingGrantEvents,
  requireFutureExpiry,
  revokeGrant,
  toGrantSummary,
  type GrantDeps
} from './grants.js';
import {
  createLifecycleEvents,
  grantLifecycleEvents,
  lifecycleEventId,
  type LifecycleEventInput,
  type LifecycleEvents
} from './lifecycle.js';
import {
  createDefaultBillingAccountResolver,
  defaultIdFactory,
  resolvePlan,
  isRestrictedPrice,
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
  BillFnCheckoutMetadata,
  BillFnCheckoutCreateRequest,
  BillFnCheckoutSession,
  BillFnLifecycleEventType,
  BillFnDispatchEventsRequest,
  BillFnConfig,
  BillFnCreateCheckoutResponse,
  BillFnCreateCheckoutResponseData,
  BillFnCreateGrantRequest,
  BillFnEnqueueReconciliationJobRequest,
  BillFnEntitlementSnapshot,
  BillFnLifecycleEventRecord,
  BillFnEntitlementsResponse,
  BillFnEntitlementsResponseData,
  BillFnFetchNotificationHistoryInput,
  BillFnGetReconciliationJobRequest,
  BillFnGrantResponse,
  BillFnImportSubscriptionInput,
  BillFnImportSubscriptionRequest,
  BillFnImportSubscriptionResponse,
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
  BillFnRefundAuthorizationInput,
  BillFnRefundChargeRequest,
  BillFnRefundMode,
  BillFnRefundChargeResponse,
  BillFnRestorePurchasesRequest,
  BillFnRestorePurchasesResponse,
  BillFnRestorePurchasesResponseData,
  BillFnResumeSubscriptionRequest,
  BillFnResumeSubscriptionResponse,
  BillFnRevokeGrantRequest,
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
/**
 * Subscription metadata key set when an operator imported the subscription:
 * when it was first imported. Its binding to the billing account is the
 * operator's, so a provider adapter does not expect the BillFn ownership
 * metadata a subscription created outside BillFn lacks.
 */
export const BILLFN_IMPORTED_AT_METADATA_KEY = 'billfnImportedAt';
/**
 * Subscription metadata key set on the row an import creates until its
 * binding is accepted (`settleImportBinding`). A pending row is not usable:
 * webhooks and replays leave events for it unlinked, other writes refuse it
 * (retryably) and subject, account and sync lookups skip it. A refusal deletes
 * it, on the import's first run or on any rerun, so it never becomes durable.
 */
export const BILLFN_IMPORT_PENDING_METADATA_KEY = 'billfnImportPending';
/** `details.reason` of the retryable `BILLFN_CONFLICT` an import raises when its replay did not finish. */
export const BILLFN_IMPORT_REPLAY_UNFINISHED_REASON = 'import_replay_unfinished';
/** Deliveries of one queue message refused by lease conflicts before it is dead-lettered. */
const RECONCILIATION_QUEUE_MAX_LEASE_CONFLICT_ATTEMPTS = 5;
const CHECKOUT_WRITE_ATTEMPTS = 3;

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
  isPriceEligible?: NonNullable<BillFnConfig['checkout']>['isPriceEligible'];
  /** The lifecycle event outbox; records nothing without an `onEvent` handler. */
  lifecycle: LifecycleEvents;
  /**
   * Reconciles an event inside a committed mutation's window with an inline
   * provider read. A failed read without a queue throws a window-read error.
   */
  reconcileProviderState?: (subscription: BillFnSubscription, event: WindowEvent) => Promise<void>;
  /** Records the missing events of grant changes flagged pending (`repairPendingGrantEvents`), for the `lifecycle-events` job. */
  repairPendingGrantEvents?: (beforeWrite?: () => Promise<void>) => Promise<void>;
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
  /** Metadata keys written only when the subscription lacks them (the provider record's keys still win). */
  metadataDefaults?: Record<string, unknown>;
  /**
   * Set by an import: the provider subscription reference it binds. The write
   * only ever lands on a row that holds the reference (a lost ordered write
   * looks the reference up again rather than rereading the row, so it never
   * moves the reference back onto a row a writer took it from), and after the
   * write the reference is checked against the ones subscription writes
   * retired (`settleImportBinding`), before any entitlement or event. A row the
   * import creates is pending until that check accepts it.
   */
  importReference?: string;
  /**
   * With `importReference`: the import run's audit event for a row state, recorded before every write that
   * leaves the row usable (`updateSubscriptionAfterImportAudit`).
   */
  importAudit?: (subscription: BillFnSubscription) => BillFnBillingEvent;
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
  checkoutReferenceSource?: 'provider' | 'metadata';
  billingState?: VerifiedBillingState;
  raw: Record<string, unknown>;
};
type ProviderProjectionContext = NonNullable<Awaited<ReturnType<typeof resolveProjectionContextForProviderState>>>;

const REFUND_MODES: ReadonlySet<string> = new Set<BillFnRefundMode>(['full', 'prorated_remaining_period', 'custom']);

/**
 * A full refund takes no amount; a partial one (`custom`, or `prorated_remaining_period` with the amount the
 * host computed) needs a positive integer amount in the currency minor unit. Checked before any provider call,
 * so a partial request is never sent as a full refund.
 */
function assertRefundModeAndAmount(mode: unknown, amount: unknown): asserts mode is BillFnRefundMode {
  if (typeof mode !== 'string' || !REFUND_MODES.has(mode)) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: "Refund mode must be 'full', 'prorated_remaining_period' or 'custom'"
    });
  }
  if (mode === 'full') {
    if (amount !== undefined) {
      throw createBillFnError({
        code: 'BILLFN_VALIDATION_ERROR',
        message: 'A full refund takes no amount'
      });
    }
    return;
  }
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'A partial refund needs a positive integer amount in the currency minor unit'
    });
  }
}

/** Internal options for `refundCharge`; the public instance method takes none. */
export interface RefundChargeOptions {
  /** Runs once the refund target is resolved and before the provider is called; throws to refuse. */
  authorize?: (target: Omit<BillFnRefundAuthorizationInput, 'request'>) => Promise<void>;
}

export function createBillFnService(config: BillFnConfig) {
  return createBillFnServiceWithInternals(config).service;
}

/** Limits on caller checkout metadata, which is stored and sent to the provider. */
const MAX_CHECKOUT_METADATA_KEYS = 20;
const MAX_CHECKOUT_METADATA_KEY_LENGTH = 40;
const MAX_CHECKOUT_METADATA_VALUE_LENGTH = 500;

/** Throws unless `metadata` is absent or valid checkout metadata; narrows it to that type. */
export function assertCheckoutMetadata(metadata: unknown): asserts metadata is BillFnCheckoutMetadata | undefined {
  if (metadata === undefined) {
    return;
  }
  const entries = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata) ? Object.entries(metadata) : null;
  const valid =
    entries !== null &&
    entries.length <= MAX_CHECKOUT_METADATA_KEYS &&
    entries.every(
      ([key, value]) =>
        key.length > 0 &&
        key.length <= MAX_CHECKOUT_METADATA_KEY_LENGTH &&
        (typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && value.length <= MAX_CHECKOUT_METADATA_VALUE_LENGTH))
    );
  if (!valid) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: `Checkout metadata must be an object of at most ${MAX_CHECKOUT_METADATA_KEYS} keys (each up to ${MAX_CHECKOUT_METADATA_KEY_LENGTH} characters) with string, number or boolean values (strings up to ${MAX_CHECKOUT_METADATA_VALUE_LENGTH} characters)`
    });
  }
}

function createBillFnServiceWithInternals(config: BillFnConfig) {
  const namespace = config.namespace ?? 'billfn';
  const now = config.now ?? (() => new Date());
  const generateId = config.generateId ?? defaultIdFactory;
  const resolveBillingAccount = config.billingAccountResolver ?? createDefaultBillingAccountResolver();
  const metrics = createNamespacedEmitter('billfn', config.metrics ?? createMetricsEmitter());
  const regionId = config.region?.id;

  const deps: ServiceDeps = {
    db: config.db,
    namespace,
    catalog: config.catalog,
    providers: config.providers ?? {},
    resolveBillingAccount,
    now,
    generateId,
    metrics,
    queue: config.queue,
    isPriceEligible: config.checkout?.isPriceEligible,
    lifecycle: createLifecycleEvents({
      db: config.db,
      namespace,
      now,
      generateId,
      metrics,
      onEvent: config.onEvent,
      isDuplicateRecordError,
      isStagedEventApplied: (event) => isStagedEventApplied(deps, event)
    })
  };
  deps.reconcileProviderState = (subscription, event) => reconcileWindowEvent(subscription, event);
  const grantDeps: GrantDeps = {
    ...deps,
    // A grant's lifecycle events are stored before its billing event, so a repair that finds the billing event
    // missing records them too (once: their ids derive from the grant). A grant change whose billing event is
    // stored already (a refused duplicate create or a repeated revoke finding it, also one made before lifecycle
    // events existed) records none.
    // A repair passes the job's lease check, which runs before each lifecycle row and before the billing event.
    // A creation's `grant.expiring` is written only while the stored grant, read again right before that row, is
    // not revoked; one whose grant a racing revoke ends after that read is dropped at delivery.
    recordBillingEvent: async (event, { db, revoked, beforeWrite } = {}) => {
      const eventDb = db ?? deps.db;
      if (deps.lifecycle.enabled && !(await findBillingEvent(eventDb, deps.namespace, event.id))) {
        const events = grantLifecycleEvents(event, deps.now(), revoked);
        const expiring = events.filter((lifecycleEvent) => lifecycleEvent.type === 'grant.expiring');
        await deps.lifecycle.record(
          events.filter((lifecycleEvent) => lifecycleEvent.type !== 'grant.expiring'),
          db,
          beforeWrite
        );
        await deps.lifecycle.recordForUnrevokedGrant(expiring, event.payload.grantId as string, eventDb, beforeWrite);
      }
      await beforeWrite?.();
      await recordBillingEvent(db ? { ...deps, db } : deps, event);
    },
    recordPassedGrantExpiry: (grant, beforeWrite) => deps.lifecycle.recordPassedGrantExpiry(grant, beforeWrite),
    isDuplicateRecordError,
    flagsPendingEvents: deps.lifecycle.enabled
  };
  deps.repairPendingGrantEvents = (beforeWrite) => repairPendingGrantEvents(grantDeps, beforeWrite);
  /**
   * The account's entitlements: its paid snapshot, or an active grant while that snapshot is `inactive`, and the
   * grants they were derived from. The grants' missing events are repaired on every read (see
   * `repairGrantEvents`). While the paid snapshot decides and the grants are not asked for, that repair is all
   * that reads them, and it never fails the read; otherwise their status is derived after the paid snapshot read
   * and the repair (see `listRepairedGrants`).
   */
  async function readEntitlements(billingAccountId: string, withGrantList = false) {
    const paid = await findEntitlementSnapshot(deps, billingAccountId);
    if (!withGrantList && paid && paid.status !== 'inactive') {
      await repairGrantEvents(grantDeps, billingAccountId);
      return { entitlements: paid, grants: [] };
    }
    const grants = await listRepairedGrants(grantDeps, billingAccountId);
    return { entitlements: await applyGrants(grantDeps, billingAccountId, paid, grants), grants };
  }
  async function findEffectiveEntitlements(billingAccountId: string) {
    return (await readEntitlements(billingAccountId)).entitlements;
  }
  /** A write's paid snapshot as the account's entitlements (see `applyGrants`). */
  async function withGrants(billingAccountId: string, paid: BillFnEntitlementSnapshot) {
    return (await applyGrants(grantDeps, billingAccountId, paid)) ?? paid;
  }

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
      return findEffectiveEntitlements(billingAccount.id);
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
      // Status and limit come from one entitlements read, so a grant ending between reads cannot mix them.
      const billingAccount = await findBillingAccountForSubject(deps, requireSubject(subject));
      const entitlements = billingAccount ? await findEffectiveEntitlements(billingAccount.id) : null;
      if (!billingAccount || !entitlements || entitlements.status === 'inactive') {
        return {
          allowed: false,
          current: 0,
          limit: 0,
          reason: 'subscription_inactive'
        };
      }
      const meter = await findUsageMeter(deps, billingAccount.id, resource);
      const current = meter?.current ?? 0;
      const limit = entitlements.limits[resource] ?? 0;
      if (limit >= 0 && current + input.requestedBytes > limit) {
        return {
          allowed: false,
          current,
          limit,
          reason: 'quota_exceeded'
        };
      }
      return {
        allowed: true,
        current,
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
      const entitlements = billingAccount ? await findEffectiveEntitlements(billingAccount.id) : null;
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
   * Reads the subscription from the provider when a committed mutation needs reconciliation:
   * a queued sync job when a queue is configured, otherwise an inline sync. It
   * never repeats the mutation and never fails it. Returns the inline result.
   * The supplied price is the read's candidate (`fetchLiveSubscription`).
   */
  async function reconcileCommittedMutation(subscription: BillFnSubscription, candidatePriceId: string): Promise<ProjectionResult | null> {
    const candidate = findCatalogPriceReference(deps.catalog, subscription.provider, [candidatePriceId]) ?? undefined;
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
    // A mutation never creates a billing account: an account without one has no subscription to change.
    const billingAccount = await findBillingAccountForSubject(deps, subject);
    const subscription = billingAccount ? await getSubscriptionForAccount(deps, billingAccount.id, input.subscriptionId) : null;
    if (!billingAccount || !subscription) {
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
   * Completes a committed cancel, change or resume using the returned provider
   * state, an optional live sync or the stored projection, then records the
   * requested billing event.
   */
  async function finishSubscriptionMutation(input: {
    billingAccount: BillFnBillingAccount;
    subscription: BillFnSubscription;
    plan: ReturnType<typeof requirePlan>;
    price: BillFnPriceDefinition;
    entitlementPlan: ReturnType<typeof requirePlan>;
    operation: Pick<BillFnProviderOperationResult, 'operationStatus' | 'billingState'> &
      Partial<Pick<BillFnProviderOperationResult, 'clientAction'>>;
    reconcileWithoutState?: boolean;
    liveStateObservedAt: string;
    /** When the provider call returned, taken before any other write; the mutation's commit time. */
    timestamp: string;
    eventType: string;
    eventPayload: Record<string, unknown>;
  }) {
    const { billingAccount, subscription, operation } = input;
    const reconciled = input.reconcileWithoutState && operation.operationStatus === 'applied' && !operation.billingState
      ? await reconcileCommittedMutation(subscription, subscription.priceId)
      : null;
    const projection = reconciled ?? (operation.billingState
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
        });
    await recordBillingEvent(deps, {
      id: deps.generateId('evt'),
      billingAccountId: billingAccount.id,
      type: input.eventType,
      payload: { subscriptionId: subscription.id, ...input.eventPayload, operationStatus: operation.operationStatus },
      createdAt: input.timestamp
    });
    return {
      subscription: projection.subscription,
      entitlements: await withGrants(billingAccount.id, projection.entitlements),
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
      assertCheckoutMetadata(input.metadata);
      const { billingAccount } = await getOrCreateBillingAccount(deps, subject);
      const plan = requirePlan(deps.catalog, input.planKey);
      const price = requireCheckoutPrice(plan, input);
      const provider = requireProvider(deps, input.provider, 'createCheckout');
      await requirePriceEligible(deps, billingAccount.id, plan, price);
      const checkoutSessionId = deps.generateId('chk');
      const timestamp = toIsoString(deps.now());
      const metadata = withRegionMetadata(input.metadata, regionId);

      const created = await createCheckoutSessionRecord(deps, {
        checkoutSessionId,
        billingAccountId: billingAccount.id,
        planKey: plan.planKey,
        priceId: price.priceId,
        provider: price.provider,
        status: 'pending',
        metadata,
        createdAt: timestamp,
        updatedAt: timestamp
      });

      const providerResult = await provider.createCheckout({
        checkoutSessionId,
        billingAccount,
        plan,
        price,
        metadata,
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
        entitlements: await withGrants(billingAccount.id, result.entitlements)
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
          reconcileWithoutState: subscription.provider === 'apple',
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
      // A plan change sells the target price just as checkout does, so a tagged target needs the host's approval
      // before the provider is asked or a change request is written. The admin operator path calls this same method
      // and is gated the same way; there is no operator override.
      await requirePriceEligible(deps, billingAccount.id, target.plan, target.price);
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
    async refundCharge(
      input: BillFnRefundChargeRequest,
      options: RefundChargeOptions = {}
    ): Promise<BillFnRefundChargeResponse> {
      const subject = requireSubject(input.subject);
      // Read the caller's input once: the validated values are the ones dispatched and recorded, even if the
      // caller's object changes while the refund awaits.
      const { amount, reason } = input;
      const requestedChargeId = input.providerChargeId;
      const requestedSubscriptionId = input.subscriptionId;
      // Only an absent mode means a full refund; an explicit null or other value is refused below.
      const mode = input.mode === undefined ? 'full' : input.mode;
      assertRefundModeAndAmount(mode, amount);
      // A refund never creates a billing account: an account without one has nothing to refund.
      const billingAccount = await findBillingAccountForSubject(deps, subject);
      const subscription = billingAccount
        ? requestedSubscriptionId
          ? await getSubscriptionForAccount(deps, billingAccount.id, requestedSubscriptionId)
          : await findActiveSubscription(deps, billingAccount.id)
        : null;
      if (!billingAccount || !subscription) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'Subscription not found for refund'
        });
      }
      if (requestedChargeId && requestedChargeId !== subscription.providerChargeId) {
        throw createBillFnError({
          code: 'BILLFN_CONFLICT',
          message: 'Refund charge does not belong to the resolved subscription'
        });
      }
      const providerName = subscription.provider;
      const providerChargeId = requestedChargeId ?? subscription.providerChargeId;
      const currency = requirePriceById(requirePlan(deps.catalog, subscription.planKey), subscription.priceId).currency;
      let liveStateObservedAt = toIsoString(deps.now());
      if (options.authorize) {
        // The router's host check sees the exact account, subscription and charge this call refunds.
        await options.authorize({
          subject,
          billingAccountId: billingAccount.id,
          subscriptionId: subscription.id,
          providerSubscriptionId: subscription.providerSubscriptionId,
          providerChargeId,
          mode,
          amount,
          currency,
          reason
        });
        // The approval covers the subscription as it was read; one that changed meanwhile (a renewal, a
        // cancellation) is refused rather than refunded from a stale snapshot. The provider-state clock restarts
        // before the re-read, so a write that lands after it is newer than the refund's projection.
        liveStateObservedAt = toIsoString(deps.now());
        const current = await getSubscriptionForAccount(deps, billingAccount.id, subscription.id);
        if (
          !current ||
          current.updatedAt !== subscription.updatedAt ||
          current.providerChargeId !== subscription.providerChargeId ||
          current.status !== subscription.status
        ) {
          throw createBillFnError({
            code: 'BILLFN_CONFLICT',
            message: 'The subscription changed while the refund was being authorized; retry the refund'
          });
        }
      }
      const provider = requireProvider(deps, providerName, 'refundCharge');
      const operation = await provider.refundCharge({
        subscription,
        billingAccount,
        providerChargeId,
        mode,
        amount,
        currency,
        reason
      });

      const timestamp = toIsoString(deps.now());
      const refund = await createRefundRecord(deps, {
        billingAccountId: billingAccount.id,
        subscriptionId: subscription.id,
        provider: providerName,
        providerChargeId,
        providerRefundId: operation.providerRefundId,
        mode,
        amount,
        currency,
        reason,
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
        entitlements: await applyGrants(grantDeps, billingAccount.id, projectedEntitlements),
        operationStatus: operation.operationStatus,
        clientAction: operation.clientAction
      });
    },
    async syncSubscription(input: BillFnSyncSubscriptionRequest): Promise<BillFnSyncSubscriptionResponse> {
      const subject = requireSubject(input.subject);
      const billingAccount = await findBillingAccountForSubject(deps, subject);
      const subscription = billingAccount ? await getSubscriptionForAccount(deps, billingAccount.id, input.subscriptionId) : null;
      if (!billingAccount || !subscription) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'Subscription not found'
        });
      }

      const applied = await syncSubscriptionById(subscription.id);

      const response: BillFnSyncSubscriptionResponseData = {
        subscription: applied.subscription,
        entitlements: await withGrants(billingAccount.id, applied.entitlements)
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
            entitlements: await withGrants(billingAccount.id, applied.entitlements)
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
          entitlements: await withGrants(billingAccount.id, applied.entitlements)
        };
        return ok(response);
      }

      throw createBillFnError({
        code: 'BILLFN_CONFLICT',
        message: 'No restored purchase could be linked to the resolved billing account'
      });
    },
    async importSubscription(input: BillFnImportSubscriptionRequest): Promise<BillFnImportSubscriptionResponse> {
      const { provider: providerName, reference, operator } = readImportRequest(input);
      const plan = requirePlan(deps.catalog, input.planKey);
      if (!plan.prices.some((price) => price.provider === providerName && price.kind === 'subscription')) {
        throw createBillFnError({
          code: 'BILLFN_VALIDATION_ERROR',
          message: `Plan ${plan.planKey} has no ${providerName} subscription price`
        });
      }
      const provider = requireProvider(deps, providerName, 'importSubscription');
      // A reference replaced by a subscription write, or bound to another billing account, fails before the provider is read.
      // A pending row (an import not yet accepted, perhaps interrupted) is checked like an unbound reference and
      // removed when the reference is retired, so a rerun of a refused import converges to no binding.
      const bound = await findSubscriptionByProviderRef(deps, providerName, reference);
      if (!bound || isImportPending(bound)) {
        await refuseRetiredImportReference(deps, providerName, reference, bound);
      }
      if (bound && bound.billingAccountId !== input.billingAccountId) {
        throw importBoundElsewhere(providerName);
      }
      // Resolved after the checks above, so an import they refuse never creates the subject's billing account;
      // one refused after the provider read keeps it.
      const billingAccount = await resolveOperatorBillingAccount(deps, input);

      // Events that occurred before this live read are already reflected in its state.
      const importObservedAt = toIsoString(deps.now());
      const state = await readImportState(provider, providerName, { providerReference: reference, billingAccount, plan });
      if (!state) {
        throw createBillFnError({
          code: 'BILLFN_NOT_FOUND',
          message: 'Provider did not return the subscription to import'
        });
      }
      if (state.providerSubscriptionId !== reference) {
        throw createBillFnError({
          code: 'BILLFN_PROVIDER_ERROR',
          message: 'The provider record does not match the imported reference'
        });
      }
      const selection = requireImportPrice(plan, providerName, state);
      // One audit event per import run and state it records, never changed once written. The run is the operator's
      // request (a rerun of it that records a state it already recorded adds none, even after another state) or,
      // without a requestId, this call. The state is every field the event shows and whether the row carries the
      // import marker (not its value, which a rerun that adds it sets to its own read time).
      const run = operator.requestId ? ['request', operator.requestId] : ['call', deps.generateId('run')];
      const importAudit = (subscription: BillFnSubscription): BillFnBillingEvent => ({
        id: `evt_import_${createHash('sha256')
          .update(
            JSON.stringify([
              providerName,
              reference,
              billingAccount.id,
              operator.id,
              operator.type ?? null,
              ...run,
              plan.planKey,
              input.reason ?? null,
              subscription.id,
              subscription.planKey,
              subscription.priceId,
              subscription.status,
              subscription.currentPeriodStart ?? null,
              subscription.currentPeriodEnd ?? null,
              subscription.autoRenew,
              subscription.metadata?.[BILLFN_IMPORTED_AT_METADATA_KEY] !== undefined
            ])
          )
          .digest('base64url')}`,
        billingAccountId: billingAccount.id,
        type: 'billfn.subscription.imported',
        payload: {
          subscriptionId: subscription.id,
          provider: providerName,
          providerReference: reference,
          planKey: subscription.planKey,
          priceId: subscription.priceId,
          status: subscription.status,
          currentPeriodStart: subscription.currentPeriodStart ?? null,
          currentPeriodEnd: subscription.currentPeriodEnd ?? null,
          autoRenew: subscription.autoRenew,
          operator,
          ...(input.reason ? { reason: input.reason } : {})
        },
        createdAt: toIsoString(deps.now())
      });
      let applied: ProjectionResult;
      try {
        // Racing imports end with one row: the loser of the unique reference insert applies an ordered update,
        // or fails as bound elsewhere when the winner bound another billing account.
        applied = await applyVerificationState(deps, {
          billingAccount,
          plan: selection.plan,
          price: selection.price,
          state,
          liveStateObservedAt: importObservedAt,
          // A rerun or a racing import keeps the first import's time.
          metadataDefaults: { [BILLFN_IMPORTED_AT_METADATA_KEY]: importObservedAt },
          // A write may retire the reference while the provider is read (the check above ran before the read).
          importReference: reference,
          importAudit
        });
      } catch (error) {
        if (hasErrorCode(error, 'BILLFN_CONFLICT') && (await isBoundElsewhere(deps, providerName, state, billingAccount.id))) {
          throw importBoundElsewhere(providerName);
        }
        throw error;
      }

      // Each write that left the row usable recorded its state's audit first. A run that wrote nothing (a read an
      // event superseded, or another run's accepted row) records the state it applied here, before the replay
      // changes anything, so a replay that does not finish still leaves this operator's event.
      await recordBillingEvent(deps, importAudit(applied.subscription));
      // A replay that does not finish fails the import; calling it again finishes the replay.
      try {
        await replayUnlinkedWebhookEventsOrThrow(deps, applied.subscription);
      } catch (error) {
        if (isReconciliationLeaseConflict(error)) {
          throw importReplayUnfinished();
        }
        throw error;
      }
      const refreshed = await refreshProjectionAfterReplay(deps, applied);
      // The event returned is the one for the state returned (after the replay), recorded here when the replay
      // changed it. The first write wins, so a rerun returns it as recorded.
      const recorded = importAudit(refreshed.subscription);
      await recordBillingEvent(deps, recorded);
      const billingEvent =
        (await deps.db.findOne<BillFnBillingEvent>({
          model: TABLES.billingEvents,
          where: [{ field: 'id', operator: 'eq', value: recorded.id }],
          namespace: deps.namespace
        })) ?? recorded;
      deps.metrics.track('subscription.imported', { provider: providerName });
      return ok({
        subscription: refreshed.subscription,
        entitlements: await withGrants(refreshed.subscription.billingAccountId, refreshed.entitlements),
        billingEvent
      });
    },
    async createGrant(input: BillFnCreateGrantRequest): Promise<BillFnGrantResponse> {
      const grantInput = readCreateGrantInput(grantDeps, input);
      // Before the expiry check, so a refused request still records events an interrupted call left unrecorded.
      await repairGrantEvents(grantDeps, input.billingAccountId);
      requireFutureExpiry(grantDeps, grantInput);
      const billingAccount = await resolveOperatorBillingAccount(deps, input);
      const grant = await insertGrant(grantDeps, billingAccount.id, grantInput);
      return ok({ grant, entitlements: await findEffectiveEntitlements(billingAccount.id) });
    },
    async revokeGrant(input: BillFnRevokeGrantRequest): Promise<BillFnGrantResponse> {
      const grant = await revokeGrant(grantDeps, input);
      return ok({ grant, entitlements: await findEffectiveEntitlements(grant.billingAccountId) });
    },
    async getEntitlements(subject: BillableSubject): Promise<BillFnEntitlementsResponse> {
      const resolved = await resolveBillingAccountReference(deps, requireSubject(subject));
      const billingAccount = await getBillingAccountById(deps, resolved.billingAccountId);
      if (!billingAccount) {
        return ok({
          billingAccount: buildVirtualBillingAccount(resolved, deps),
          entitlements: null,
          subscription: null,
          grants: []
        });
      }
      const { entitlements, grants } = await readEntitlements(billingAccount.id, true);
      const subscription = await findActiveSubscription(deps, billingAccount.id);
      const response: BillFnEntitlementsResponseData = {
        billingAccount,
        entitlements,
        subscription,
        grants: grants.map(toGrantSummary)
      };
      return ok(response);
    },
    async getUsage(subject: BillableSubject, resource?: string): Promise<BillFnUsageResponse> {
      const resolved = await resolveBillingAccountReference(deps, requireSubject(subject));
      const billingAccount = await getBillingAccountById(deps, resolved.billingAccountId);
      const entitlements = billingAccount ? await findEffectiveEntitlements(billingAccount.id) : null;
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
    /** Whether a subscription, checkout session or replaced-reference row here holds the provider reference. */
    async ownsProviderReference(provider: BillingProviderName, reference: string): Promise<boolean> {
      return ownsProviderReference(deps, provider, reference);
    },
    dispatchEvents: (input?: BillFnDispatchEventsRequest) => deps.lifecycle.dispatch(input),
    listEvents: deps.lifecycle.list,
    subscriptionProvider,
    quotaProvider
  };
  return {
    service: deliveringLifecycleEvents(deps.lifecycle, service),
    now,
    runReconciliationJob: (jobId: string, onLeaseRenewed?: ReconciliationLeaseGuard) =>
      deps.lifecycle.deliverAfter(() => runReconciliationJobInternal(jobId, onLeaseRenewed))
  };
}

/**
 * Wraps each of the service's methods, and those of the provider objects it holds, so that once a call settles
 * the lifecycle events it recorded are delivered (see `deliverAfter`). A delivery failure never fails the call:
 * the event stays in the outbox for a later dispatch.
 */
function deliveringLifecycleEvents<T extends object>(lifecycle: LifecycleEvents, target: T): T {
  return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, deliveringMember(lifecycle, value)])) as T;
}

/** A method delivers once its call settles, a plain object of methods is wrapped in turn, and any other value is kept. */
function deliveringMember(lifecycle: LifecycleEvents, value: unknown): unknown {
  if (typeof value === 'function') {
    return (...args: unknown[]) => lifecycle.deliverAfter(async () => (value as (...args: unknown[]) => unknown)(...args));
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return deliveringLifecycleEvents(lifecycle, value);
  }
  return value;
}

/** Thrown inside a transaction to roll back a write that lost its ordering race. */
const LOST_WRITE = Symbol('billfn.lostWrite');

/**
 * What a write without transactions adds to its row update: the `lifecycleEventIds` marker naming the events it
 * causes, and a condition that the marker it replaces is still the one it read.
 */
type LifecycleMarker = { where: WhereClause[]; data: { lifecycleEventIds?: string } };
const NO_LIFECYCLE_MARKER: LifecycleMarker = { where: [], data: {} };

/**
 * Applies a state write together with the lifecycle events it causes, so a committed write always has its
 * events and a write that does not apply has none. Where the adapter supports transactions both commit in one,
 * and a write that loses its race (`write` returns false) or fails records none. Without transactions the events
 * are first staged, so no dispatcher delivers them yet, and the write stores their ids on its row in the same
 * single-row update; once it applied they become pending. A write that failed (perhaps after it applied), lost
 * its race or was stopped leaves them staged: a dispatch after the stage lapsed delivers each only while its row
 * names it. Before a write replaces a marker it makes the events that marker names pending, as the row proves
 * their write applied, and its update applies only over the marker it read. An event's id derives from the
 * change it reports, so a retry of the write, also after a lost race, records the same id. Returns whether
 * `write` applied.
 */
async function writeWithLifecycleEvents(
  deps: ServiceDeps,
  events: LifecycleEventInput[],
  previous: { lifecycleEventIds?: string | null } | null,
  write: (db: Adapter, marker: LifecycleMarker) => Promise<boolean>
): Promise<boolean> {
  if (events.length === 0 || !deps.lifecycle.enabled) {
    return write(deps.db, NO_LIFECYCLE_MARKER);
  }
  if (!deps.db.capabilities.transactions.supported) {
    await deps.lifecycle.promote(previous?.lifecycleEventIds?.split(' ') ?? []);
    await deps.lifecycle.stage(events);
    const applied = await write(deps.db, {
      where: [{ field: 'lifecycleEventIds', operator: 'eq', value: previous?.lifecycleEventIds ?? null }],
      data: { lifecycleEventIds: events.map((event) => event.id).join(' ') }
    });
    if (applied) {
      // Events left staged by a failure here are settled by a later dispatch.
      await deps.lifecycle.confirm(events).catch(() => deps.metrics.track('event.stage_unsettled', {}));
    }
    return applied;
  }
  try {
    return await deps.db.transaction(async (transaction) => {
      const db = transaction as unknown as Adapter;
      if (!(await write(db, NO_LIFECYCLE_MARKER))) {
        throw LOST_WRITE;
      }
      await deps.lifecycle.record(events, db);
      return true;
    });
  } catch (error) {
    if (error === LOST_WRITE) {
      return false;
    }
    throw error;
  }
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
    case 'lifecycle-events': {
      // Dispatch runs first, so no other step can stop or delay delivery and the 24h failed marking. The lease is
      // renewed before each delivery, sweep page and repair write, so a job whose lease lapsed stops.
      await deps.lifecycle.dispatch({}, assertLease);
      // The expiry sweeps, each resuming after the grants earlier runs finished and reading a bounded number per run,
      // and the bounded repair of grant changes whose events a failed write or a stop left unrecorded, which reads
      // only those flagged grants. A failed step is left to the next run; a lost lease ends the run.
      let leaseError: { error: unknown } | undefined;
      const guard = () =>
        assertLease().catch((error: unknown) => {
          leaseError = { error };
          throw error;
        });
      const steps = { expiry: deps.lifecycle.recordGrantExpiry, repair: deps.repairPendingGrantEvents };
      for (const [type, step] of Object.entries(steps)) {
        try {
          await step?.(guard);
        } catch {
          if (leaseError) {
            throw leaseError.error;
          }
          deps.metrics.track('grant.event_deferred', { type });
        }
      }
      // Delivers what the steps recorded in this run; a later run delivers it otherwise.
      await deps.lifecycle.dispatch({}, assertLease);
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
  if (!subscription || isImportPending(subscription)) {
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

/**
 * The checkout's price: the requested `priceId`, which must be a price of the
 * plan for the requested provider and interval, or the plan's default price.
 */
function requireCheckoutPrice(
  plan: ReturnType<typeof requirePlan>,
  input: Pick<BillFnCheckoutCreateRequest, 'provider' | 'interval' | 'priceId'>
) {
  if (input.priceId === undefined) {
    return requirePrice(plan, input.provider, input.interval);
  }
  if (typeof input.priceId !== 'string' || input.priceId.trim() === '') {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: 'priceId must be a non-empty string'
    });
  }
  const price = plan.prices.find((candidate) => candidate.priceId === input.priceId);
  if (!price || price.provider !== input.provider || (input.interval !== undefined && price.interval !== input.interval)) {
    throw createBillFnError({
      code: 'BILLFN_VALIDATION_ERROR',
      message: `Price ${input.priceId} is not a ${input.provider}${input.interval ? ` ${input.interval}` : ''} price of plan ${plan.planKey}`,
      details: {
        priceId: input.priceId,
        planKey: plan.planKey,
        provider: input.provider,
        ...(input.interval !== undefined ? { interval: input.interval } : {})
      }
    });
  }
  return price;
}

/** Rejects a price with an `eligibility` tag unless the host hook approves it for the billing account. */
async function requirePriceEligible(
  deps: ServiceDeps,
  billingAccountId: string,
  plan: ReturnType<typeof requirePlan>,
  price: BillFnPriceDefinition
) {
  if (!isRestrictedPrice(price)) {
    return;
  }
  const eligible = deps.isPriceEligible
    ? (await deps.isPriceEligible({ billingAccountId, planKey: plan.planKey, price })) === true
    : false;
  if (!eligible) {
    throw createBillFnError({
      code: 'BILLFN_PRICE_NOT_ELIGIBLE',
      message: `Price ${price.priceId} is not available to this billing account`,
      details: {
        priceId: price.priceId,
        planKey: plan.planKey,
        eligibility: price.eligibility
      }
    });
  }
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

function readImportRequest(input: BillFnImportSubscriptionRequest) {
  const invalid = (message: string) => createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message });
  const optionalReference = (value: unknown, name: string) => {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
      throw invalid(`${name} must be a non-empty string without surrounding whitespace`);
    }
    return value;
  };
  const providerSubscriptionId = optionalReference(input.providerSubscriptionId, 'providerSubscriptionId');
  const originalTransactionId = optionalReference(input.originalTransactionId, 'originalTransactionId');
  if (originalTransactionId !== undefined && input.provider !== 'apple') {
    throw invalid('originalTransactionId identifies Apple subscriptions only');
  }
  if (providerSubscriptionId !== undefined && originalTransactionId !== undefined && providerSubscriptionId !== originalTransactionId) {
    throw invalid('providerSubscriptionId and originalTransactionId name different subscriptions');
  }
  const reference = providerSubscriptionId ?? originalTransactionId;
  if (reference === undefined) {
    throw invalid('Importing a subscription requires providerSubscriptionId or originalTransactionId');
  }
  if (typeof input.billingAccountId !== 'string' || input.billingAccountId.length === 0) {
    throw invalid('billingAccountId must be a non-empty string');
  }
  if (typeof input.planKey !== 'string' || input.planKey.length === 0) {
    throw invalid('planKey must be a non-empty string');
  }
  const operator = input.operator;
  if (!operator || typeof operator.id !== 'string' || operator.id.length === 0) {
    throw invalid('Importing a subscription requires the operator identity');
  }
  if (input.reason !== undefined && typeof input.reason !== 'string') {
    throw invalid('reason must be a string');
  }
  return {
    provider: input.provider,
    reference,
    operator: {
      id: operator.id,
      ...(typeof operator.type === 'string' ? { type: operator.type } : {}),
      ...(typeof operator.requestId === 'string' ? { requestId: operator.requestId } : {})
    }
  };
}

/**
 * Reads the provider record to import. A BillFn error from the adapter keeps its classification; any other failure
 * (the provider was not reached, or the adapter failed without classifying it) is a retryable provider error whose
 * message names only the provider, so no raw error text reaches the operator.
 */
async function readImportState(
  provider: Required<Pick<BillFnProviderAdapter, 'importSubscription'>>,
  providerName: BillingProviderName,
  input: BillFnImportSubscriptionInput
) {
  try {
    return await provider.importSubscription(input);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code.startsWith('BILLFN_')) {
      throw error;
    }
    throw createBillFnError({
      code: 'BILLFN_PROVIDER_ERROR',
      message: `Provider ${providerName} could not be read for the imported subscription`
    });
  }
}

/** The billing account an import or grant binds to: created for the subject when one is given, otherwise existing. */
async function resolveOperatorBillingAccount(
  deps: ServiceDeps,
  input: { billingAccountId: string; subject?: BillableSubject }
) {
  if (input.subject) {
    const subject = requireSubject(input.subject);
    const resolved = await resolveBillingAccountReference(deps, subject);
    if (resolved.billingAccountId !== input.billingAccountId) {
      throw createBillFnError({
        code: 'BILLFN_VALIDATION_ERROR',
        message: 'The subject resolves to a different billing account'
      });
    }
    return (await getOrCreateBillingAccount(deps, subject)).billingAccount;
  }
  const billingAccount = await getBillingAccountById(deps, input.billingAccountId);
  if (!billingAccount) {
    throw createBillFnError({
      code: 'BILLFN_NOT_FOUND',
      message: 'Billing account not found'
    });
  }
  return billingAccount;
}

/**
 * The plan's subscription price the provider record's product names. Every reference (the adapter's
 * `providerProductId`, then the record's `product_id`/`productId`) is a provider product id here, so it is matched
 * only against `providerProductId`, never against a catalog `priceId` another plan's product could equal.
 */
function requireImportPrice(
  plan: ReturnType<typeof requirePlan>,
  provider: BillingProviderName,
  state: VerifiedBillingState
): CatalogSelection {
  const raw = asRecord(state.raw);
  const records = [raw, asRecord(raw?.transaction)];
  const references = [
    state.providerProductId,
    ...records.flatMap((record) => (record ? ['product_id', 'productId'].map((key) => readString(record, key)) : []))
  ].filter((reference): reference is string => Boolean(reference));
  const prices = plan.prices.filter((price) => price.provider === provider && price.kind === 'subscription');
  for (const reference of references) {
    const price = prices.find((candidate) => candidate.providerProductId === reference);
    if (price) {
      return { plan, price };
    }
  }
  throw createBillFnError({
    code: 'BILLFN_VALIDATION_ERROR',
    message: `The provider subscription's product is not a ${provider} subscription price of plan ${plan.planKey}`,
    details: { planKey: plan.planKey, providerProductIds: references }
  });
}

function importBoundElsewhere(provider: BillingProviderName) {
  return createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: `The ${provider} subscription is already bound to a different billing account`
  });
}

/** Whether a subscription of another billing account holds a reference the provider record names. */
async function isBoundElsewhere(
  deps: ServiceDeps,
  provider: BillingProviderName,
  state: VerifiedBillingState,
  billingAccountId: string
) {
  const holder = await findSubscriptionByProviderRef(deps, provider, state.providerSubscriptionId, state.providerChargeId);
  return Boolean(holder && holder.billingAccountId !== billingAccountId);
}

/**
 * The import is bound and recorded, but another run holds the reference's
 * unlinked events (including a run interrupted before it released them) or the
 * replay reached its bound. Unlike a bound-elsewhere conflict it is retryable:
 * calling import again, after the holder's lease expires, finishes the replay.
 */
function importReplayUnfinished() {
  return createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'The import is recorded but replaying its unlinked webhook events did not finish; import again to finish it',
    details: { reason: BILLFN_IMPORT_REPLAY_UNFINISHED_REASON },
    retryable: true
  });
}

function importReferenceReplaced() {
  return createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'The provider reference was replaced by another subscription and cannot be imported'
  });
}

/**
 * Refuses an import of a reference a subscription write retired: deletes
 * `holder` when it is a pending import row holding the reference (whichever
 * import run created it), then fails with a non-retryable `BILLFN_CONFLICT`.
 * An accepted row is never deleted: the delete is ordered against a fresh
 * read that is still pending, so a stale `holder` another run has accepted
 * since survives.
 */
async function refuseRetiredImportReference(
  deps: ServiceDeps,
  provider: BillingProviderName,
  reference: string,
  holder: BillFnSubscription | null
) {
  if (!(await isReplacedProviderReference(deps, provider, reference, holder?.id))) {
    return;
  }
  const stored = holder && isImportPending(holder) ? await getSubscriptionById(deps, holder.id) : null;
  if (stored && isImportPending(stored) && stored.providerSubscriptionId === reference) {
    await deps.db.deleteMany({
      model: TABLES.subscriptions,
      where: [
        { field: 'id', operator: 'eq', value: stored.id },
        { field: 'providerSubscriptionId', operator: 'eq', value: reference },
        { field: 'updatedAt', operator: 'eq', value: stored.updatedAt }
      ],
      namespace: deps.namespace
    });
  }
  deps.metrics.track('subscription.import.replaced_reference_refused', { provider });
  throw importReferenceReplaced();
}

/**
 * After an import's write to `subscription`, which holds `reference`: refuses
 * the binding when a write of another subscription retired the reference, or
 * accepts it by clearing the pending marker, and returns the accepted row:
 * `ownState` when that row carries this write's state, and `acceptedHere` when
 * this call cleared its pending marker. A lost acceptance write re-finds the
 * row, which then carries another run's state (accepted by it or here), so the
 * caller publishes that row's plan, never its own. Every row, the first and
 * each reload, is checked the same way before it is accepted or returned: it
 * holds the reference, belongs to `billingAccountId` (another account's row
 * fails as bound elsewhere, untouched) and its reference is not retired.
 * Nothing uses a pending row, so no entitlement or lifecycle event exists for
 * it until this accepts it. The import's audit event (`audit`) for the row it
 * accepts is recorded just before each acceptance write, so an accepted
 * binding always has it (an event for a write that then does not land stays);
 * a refusal deletes the row, and an interrupted run leaves it pending for the
 * rerun to settle.
 *
 * Why the check after the write is enough: a reference is held by at most one
 * row (unique index), so a writer that retired it took it off its row before
 * this write held it, and recorded it before that, or saved it pending in that
 * same write. Read pending, then recorded, now, one of the reads sees it. Every
 * import that holds the row therefore reaches the same answer.
 */
async function settleImportBinding(
  deps: ServiceDeps,
  subscription: BillFnSubscription,
  reference: string,
  billingAccountId: string,
  audit?: (subscription: BillFnSubscription) => BillFnBillingEvent
): Promise<{ subscription: BillFnSubscription; ownState: boolean; acceptedHere: boolean }> {
  let current: BillFnSubscription | null = subscription;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // Only the first attempt holds this run's write; a reload holds whatever wrote the row after it.
    const ownState = attempt === 0;
    if (current?.providerSubscriptionId !== reference) {
      throw createBillFnError({
        code: 'BILLFN_CONFLICT',
        message: 'The imported subscription changed while its import was accepted',
        retryable: true
      });
    }
    if (current.billingAccountId !== billingAccountId) {
      throw importBoundElsewhere(current.provider);
    }
    await refuseRetiredImportReference(deps, current.provider, reference, current);
    if (!isImportPending(current)) {
      return { subscription: current, ownState, acceptedHere: false };
    }
    const accepted: BillFnSubscription = {
      ...current,
      metadata: withoutImportPending(current.metadata),
      updatedAt: nextSubscriptionUpdatedAt(deps.now(), current.updatedAt)
    };
    if (await updateSubscriptionAfterImportAudit(deps, current, accepted, audit)) {
      return { subscription: accepted, ownState, acceptedHere: true };
    }
    current = await findSubscriptionByProviderRef(deps, subscription.provider, reference);
    await Promise.resolve();
  }
  throw createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'Unable to accept the imported subscription after multiple retries',
    retryable: true
  });
}

/** Whether the row is an import's binding not yet accepted (see `BILLFN_IMPORT_PENDING_METADATA_KEY`). */
function isImportPending(subscription: BillFnSubscription | null | undefined) {
  return subscription?.metadata?.[BILLFN_IMPORT_PENDING_METADATA_KEY] === true;
}

function withoutImportPending(metadata: BillFnSubscription['metadata']) {
  if (!metadata) {
    return metadata;
  }
  const { [BILLFN_IMPORT_PENDING_METADATA_KEY]: _pending, ...rest } = metadata;
  return rest;
}

/** A write other than an import's reached a pending import row: retried once the import settles it. */
function importPendingConflict() {
  return createBillFnError({
    code: 'BILLFN_CONFLICT',
    message: 'The subscription is being imported',
    details: { reason: 'subscription_import_pending' },
    retryable: true
  });
}

/**
 * Whether a subscription write dropped this reference (still pending on the
 * subscription, or recorded). A writer records the reference before it clears
 * pending, so pending is read first, as `namesReplacedReference` does: a writer
 * that clears pending between the reads has already recorded it. `holderId`,
 * the row that holds the reference now, is not counted: a reference it dropped
 * and holds again, or one a write that lost its race on it recorded, is held.
 */
async function isReplacedProviderReference(
  deps: ServiceDeps,
  provider: BillingProviderName,
  reference: string,
  holderId?: string
) {
  const pending = await deps.db.findMany<BillFnSubscription>({
    model: TABLES.subscriptions,
    where: [
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'replacedReferencesPending', operator: 'eq', value: true }
    ],
    namespace: deps.namespace
  });
  if (
    pending.some(
      (subscription) => subscription.id !== holderId && pendingReplacedReferencesOf(subscription).includes(reference)
    )
  ) {
    return true;
  }
  const replaced = await deps.db.findOne<BillFnReplacedProviderReference>({
    model: TABLES.replacedProviderReferences,
    where: [
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'providerReference', operator: 'eq', value: reference }
    ],
    namespace: deps.namespace
  });
  return Boolean(replaced && replaced.subscriptionId !== holderId);
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

/**
 * Writes provider state to a checkout session. `checkout.completed` commits with the write that moves the session
 * to `succeeded` from a stored status other than `succeeded`, applied only over the status it read, so of racing
 * writes one completes it. A rewrite of a succeeded session (a renewal webhook, a restore, a repeated
 * verification), also of one that succeeded before lifecycle events existed, records nothing.
 */
async function writeCheckoutSessionState(
  deps: ServiceDeps,
  read: BillFnCheckoutSession,
  state: VerifiedBillingState,
  subscription: BillFnSubscription,
  timestamp: string
): Promise<BillFnCheckoutSession> {
  let stored: BillFnCheckoutSession | null = read;
  for (let attempt = 0; stored && attempt < CHECKOUT_WRITE_ATTEMPTS; attempt += 1) {
    const current: BillFnCheckoutSession = stored;
    const patch: Partial<BillFnCheckoutSession> = {
      status: state.checkoutStatus,
      providerSubscriptionId: state.providerSubscriptionId ?? current.providerSubscriptionId,
      providerChargeId: state.providerChargeId ?? current.providerChargeId,
      updatedAt: timestamp,
      metadata: mergeJson(current.metadata, state.raw)
    };
    if (patch.status !== 'succeeded' || current.status === 'succeeded') {
      return updateCheckoutSession(deps, current.checkoutSessionId, patch);
    }
    const events = [checkoutCompletedEvent(current, subscription)];
    const applied = await writeWithLifecycleEvents(deps, events, current, async (db, marker) => {
      const updated = await db.updateMany({
        model: TABLES.checkoutSessions,
        where: [
          { field: 'checkoutSessionId', operator: 'eq', value: current.checkoutSessionId },
          { field: 'status', operator: 'eq', value: current.status },
          ...marker.where
        ],
        data: { ...patch, ...marker.data },
        namespace: deps.namespace
      });
      return updated === 1;
    });
    stored = await getCheckoutSession(deps, current.checkoutSessionId);
    if (applied) {
      return stored ?? { ...current, ...patch };
    }
  }
  throw createBillFnError({ code: 'BILLFN_CONFLICT', message: 'Unable to write the checkout session after multiple retries' });
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
    const subscription = await deps.db.findOne<BillFnSubscription>({
      model: TABLES.subscriptions,
      where: [
        { field: 'id', operator: 'eq', value: subscriptionId },
        { field: 'billingAccountId', operator: 'eq', value: billingAccountId }
      ],
      namespace: deps.namespace
    });
    return isImportPending(subscription) ? null : subscription;
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
  // A pending import row is not the account's until its import accepts it.
  return candidates.find((candidate) => !isImportPending(candidate)) ?? null;
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

/**
 * Checkout metadata with the configured region as `billfn_region`. A caller
 * value is always dropped, so only BillFn decides where the ingress routes the
 * provider record's events.
 */
function withRegionMetadata(
  metadata: Record<string, unknown> | undefined,
  regionId: string | undefined
): Record<string, unknown> | undefined {
  if (!regionId && !(metadata && Object.hasOwn(metadata, BILLFN_REGION_METADATA_KEY))) {
    return metadata;
  }
  const next: Record<string, unknown> = { ...metadata };
  delete next[BILLFN_REGION_METADATA_KEY];
  if (regionId) {
    next[BILLFN_REGION_METADATA_KEY] = regionId;
  }
  return next;
}

async function ownsProviderReference(deps: ServiceDeps, provider: BillingProviderName, reference: string) {
  const lookups: Array<{ model: string; field: string }> = [
    { model: TABLES.subscriptions, field: 'providerSubscriptionId' },
    { model: TABLES.subscriptions, field: 'providerChargeId' },
    { model: TABLES.checkoutSessions, field: 'providerSubscriptionId' },
    { model: TABLES.checkoutSessions, field: 'providerChargeId' },
    { model: TABLES.checkoutSessions, field: 'providerCheckoutId' }
  ];
  for (const lookup of lookups) {
    const found = await deps.db.findOne<Record<string, unknown>>({
      model: lookup.model,
      where: [
        { field: 'provider', operator: 'eq', value: provider },
        { field: lookup.field, operator: 'eq', value: reference }
      ],
      namespace: deps.namespace
    });
    if (found) {
      return true;
    }
  }
  // A reference a write dropped stays owned here whether the write saved it
  // pending or recorded it; read in the order that sees one of them.
  return isReplacedProviderReference(deps, provider, reference);
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
  // The provider change this call applies, which keys its cancellation: the same across the write's retries.
  const providerChangeKey =
    input.providerEventId ?? input.committedAt ?? input.liveStateObservedAt ?? input.occurredAt ?? timestamp;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!input.importReference && isImportPending(baseSubscription)) {
      // Only the import settles its pending row; anything else applies once it is accepted (or deleted).
      throw importPendingConflict();
    }
    if (baseSubscription && baseSubscription.billingAccountId !== input.billingAccount.id) {
      throw createBillFnError({
        code: 'BILLFN_CONFLICT',
        message: 'Provider billing reference belongs to a different billing account'
      });
    }
    if (input.importReference && baseSubscription && baseSubscription.providerSubscriptionId !== input.importReference) {
      // Found by another reference the provider record names: an import never moves its reference onto such a row.
      throw createBillFnError({
        code: 'BILLFN_CONFLICT',
        message: 'The provider record names a reference another subscription holds'
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
      // An import that adds its marker or references to an accepted row records its audit first.
      if (await updateSubscriptionAfterImportAudit(deps, baseSubscription, linked, input.importAudit)) {
        subscription = linked;
        break;
      }
      const current = await reloadAfterLostWrite(deps, input, baseSubscription);
      if (!current && !input.importReference) {
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
    const merged = mergeJson(mergeJson(input.metadataDefaults, baseSubscription?.metadata), input.state.raw);
    const mergedMetadata = input.keepMutationWindow ? merged : withoutMutationWindow(merged);
    const providerStateAt = providerStateTimeFor(input.occurredAt, supersededBefore, baseSubscription);
    const metadata = {
      ...mergedMetadata,
      ...(providerStateAt
        ? {
            [PROVIDER_EVENT_OCCURRED_AT_METADATA_KEY]: providerStateAt,
            ...(input.committedAt ? { [PROVIDER_MUTATION_STARTED_AT_METADATA_KEY]: input.liveStateObservedAt } : {})
          }
        : {}),
      // A row an import creates stays pending until `settleImportBinding` accepts it.
      ...(input.importReference && !baseSubscription ? { [BILLFN_IMPORT_PENDING_METADATA_KEY]: true } : {})
    };

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
      // Every update is ordered against the row it was computed from, so a provider-state time and the
      // pending references it clears always come from the row it replaces. A re-import of an accepted row
      // records its audit first. The renewal or cancellation this write makes commits with it.
      if (
        await updateSubscriptionAfterImportAudit(
          deps,
          baseSubscription,
          record,
          input.importAudit,
          subscriptionLifecycleEvents(baseSubscription, record, providerChangeKey)
        )
      ) {
        subscription = record;
        break;
      }
      // A lost race leaves its records: a reference the winner keeps is held, so its events still link to it.
      const current = await reloadAfterLostWrite(deps, input, baseSubscription);
      if (!current && !input.importReference) {
        throw createBillFnError({
          code: 'BILLFN_CONFLICT',
          message: 'Subscription changed while applying provider event state'
        });
      }
      baseSubscription = current;
      await Promise.resolve();
      continue;
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
  // Whether the row carries this call's state; otherwise it publishes the row's own plan, never `input.plan`.
  let ownState = !liveStateSuperseded;
  // Whether this call records the row's lifecycle event (an import that accepts another run's state records it).
  let recordLifecycle = ownState;
  if (input.importReference) {
    const settled = await settleImportBinding(deps, subscription, input.importReference, input.billingAccount.id, input.importAudit);
    subscription = settled.subscription;
    ownState = ownState && settled.ownState;
    recordLifecycle = ownState || settled.acceptedHere;
  }

  let checkoutSession = input.checkoutSession;
  if (input.checkoutSession) {
    checkoutSession = await writeCheckoutSessionState(deps, input.checkoutSession, input.state, subscription, timestamp);
  }

  // A superseded read leaves the subscription's state, so its entitlements stand and no lifecycle event is recorded;
  // an import that ends on another run's state publishes that state's plan.
  const entitlements = await upsertEntitlements(
    deps,
    input.billingAccount.id,
    ownState ? input.plan : requirePlan(deps.catalog, subscription.planKey),
    subscription,
    timestamp
  );
  if (!recordLifecycle) {
    return {
      checkoutSession: checkoutSession ?? input.checkoutSession,
      subscription,
      entitlements,
      providerStateRaced
    };
  }

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
 * The row to retry a lost ordered write against: the row again, or for an
 * import the row that holds its reference now (null when none does, and the
 * import creates one), so the import never writes its reference back onto a
 * row a writer took it from.
 */
function reloadAfterLostWrite(deps: ServiceDeps, input: ApplyVerificationStateInput, subscription: BillFnSubscription) {
  return input.importReference
    ? findSubscriptionByProviderRef(deps, input.price.provider, input.importReference)
    : getSubscriptionById(deps, subscription.id);
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
 * superseded: missing provider references and metadata keys from the read are
 * added and every state field is kept. Returns null when the read adds neither.
 */
function linkLiveReadReferences(
  subscription: BillFnSubscription,
  input: ApplyVerificationStateInput,
  timestamp: string
): BillFnSubscription | null {
  const providerSubscriptionId = subscription.providerSubscriptionId ?? input.state.providerSubscriptionId;
  const providerCheckoutId = subscription.providerCheckoutId ?? input.checkoutSession?.providerCheckoutId;
  const providerChargeId = subscription.providerChargeId ?? input.state.providerChargeId;
  const addsMetadata = Object.keys(input.metadataDefaults ?? {}).some((key) => subscription.metadata?.[key] === undefined);
  if (
    providerSubscriptionId === subscription.providerSubscriptionId &&
    providerCheckoutId === subscription.providerCheckoutId &&
    providerChargeId === subscription.providerChargeId &&
    !addsMetadata
  ) {
    return null;
  }
  const metadata = addsMetadata ? { ...input.metadataDefaults, ...subscription.metadata } : subscription.metadata;
  return { ...subscription, providerSubscriptionId, providerCheckoutId, providerChargeId, metadata, updatedAt: timestamp };
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

/**
 * The ordered update of an existing row that `applyVerificationState` (state and superseded-read link updates)
 * and an import's acceptance (`settleImportBinding`) go through. With an import's audit, a write that leaves the
 * row usable (not pending) records the run's audit for the state it publishes first, so no later failure or
 * interruption leaves an import's change without its operator. The row an import creates is pending, so it is
 * audited when this accepts it.
 */
async function updateSubscriptionAfterImportAudit(
  deps: ServiceDeps,
  current: BillFnSubscription,
  next: BillFnSubscription,
  importAudit: ApplyVerificationStateInput['importAudit'],
  events: LifecycleEventInput[] = []
) {
  if (importAudit && !isImportPending(next)) {
    await recordBillingEvent(deps, importAudit(next));
  }
  return writeWithLifecycleEvents(deps, events, current, async (db, marker) => {
    const updated = await db.updateMany({
      model: TABLES.subscriptions,
      where: [
        { field: 'id', operator: 'eq', value: current.id },
        { field: 'updatedAt', operator: 'eq', value: current.updatedAt },
        ...marker.where
      ],
      data: { ...next, ...marker.data },
      namespace: deps.namespace
    });
    return updated === 1;
  });
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

    // The `entitlement.changed` this write makes commits with it.
    const events = entitlementChangeEvents(existing, snapshot, subscription);
    if (existing) {
      const updated = await writeWithLifecycleEvents(deps, events, existing, async (db, marker) => {
        const count = await db.updateMany({
          model: TABLES.entitlementSnapshots,
          where: [
            { field: 'billingAccountId', operator: 'eq', value: billingAccountId },
            existing.sourceEventId
              ? { field: 'sourceEventId', operator: 'eq', value: existing.sourceEventId }
              : { field: 'updatedAt', operator: 'eq', value: existing.updatedAt },
            ...marker.where
          ],
          data: { ...snapshot, ...marker.data },
          namespace: deps.namespace
        });
        return count === 1;
      });
      if (updated) {
        return snapshot;
      }
      await Promise.resolve();
      continue;
    }

    try {
      let created = snapshot;
      await writeWithLifecycleEvents(deps, events, null, async (db, marker) => {
        created = await db.create<BillFnEntitlementSnapshot>({
          model: TABLES.entitlementSnapshots,
          data: { ...snapshot, ...marker.data },
          namespace: deps.namespace
        });
        return true;
      });
      return created;
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

/**
 * The `entitlement.changed` of a snapshot write that changes the paid snapshot's plan, status, features or
 * limits. Keyed by the subscription version it derives from and the entitlements it replaces and writes, so a
 * retry of the write (also after a lost race that kept those entitlements) and a racing write of the same change
 * share its id.
 */
function entitlementChangeEvents(
  previous: BillFnEntitlementSnapshot | null,
  next: BillFnEntitlementSnapshot,
  subscription: BillFnSubscription
): LifecycleEventInput[] {
  if (
    previous?.planKey === next.planKey &&
    previous.status === next.status &&
    sameJson(previous.features, next.features) &&
    sameJson(previous.limits, next.limits)
  ) {
    return [];
  }
  const replaced = previous ? entitlementsFingerprint(previous) : 'none';
  const data = {
    cause: 'subscription' as const,
    subscriptionId: subscription.id,
    planKey: next.planKey,
    status: next.status,
    features: next.features,
    limits: next.limits,
    previousPlanKey: previous?.planKey ?? null,
    previousStatus: previous?.status ?? null
  };
  return [
    {
      id: payloadEventId('entitlement.changed', `subscription\n${next.billingAccountId}\n${next.sourceEventId ?? ''}\n${replaced}`, data),
      type: 'entitlement.changed',
      billingAccountId: next.billingAccountId,
      occurredAt: next.updatedAt,
      data
    }
  ];
}

/**
 * The id of a lifecycle event a state write records: derived from `key`, the change it reports, and from its
 * payload, so one id names one payload. A write that loses its race to another reporting the same change with
 * another payload stages another id, which no applied write names, and never replaces the payload the applied
 * write's event delivers (see `lifecycle.stage`).
 */
function payloadEventId(type: BillFnLifecycleEventType, key: string, data: unknown) {
  return lifecycleEventId(type, `${key}\n${JSON.stringify(canonicalJson(data))}`);
}

function entitlementsFingerprint(snapshot: Pick<BillFnEntitlementSnapshot, 'planKey' | 'status' | 'features' | 'limits'>) {
  return JSON.stringify(canonicalJson([snapshot.planKey, snapshot.status, snapshot.features, snapshot.limits]));
}

/**
 * Whether the row a staged lifecycle event's write targets (its subscription, snapshot or checkout session)
 * names the event in its `lifecycleEventIds` marker, which only a write that caused it sets.
 */
async function isStagedEventApplied(deps: ServiceDeps, event: BillFnLifecycleEventRecord): Promise<boolean> {
  const row = await stagedEventRow(deps, event);
  return Boolean(row?.lifecycleEventIds?.split(' ').includes(event.id));
}

/** The row a staged lifecycle event's write targets: its checkout session, entitlement snapshot or subscription. */
function stagedEventRow(deps: ServiceDeps, event: BillFnLifecycleEventRecord) {
  const data = event.data as { subscriptionId?: string; checkoutSessionId?: string };
  if (event.type === 'checkout.completed') {
    return getCheckoutSession(deps, data.checkoutSessionId!);
  }
  if (event.type === 'entitlement.changed') {
    return findEntitlementSnapshot(deps, event.billingAccountId);
  }
  return getSubscriptionById(deps, data.subscriptionId!);
}

/**
 * The `checkout.completed` of a checkout session that succeeded with `subscription`: one per session, keyed by
 * it, with a payload from the session's own purchase (and its subscription's id), so every write that completes
 * the session reports the same one.
 */
function checkoutCompletedEvent(session: BillFnCheckoutSession, subscription: BillFnSubscription): LifecycleEventInput {
  return {
    billingAccountId: session.billingAccountId,
    occurredAt: subscription.updatedAt,
    id: lifecycleEventId('checkout.completed', session.checkoutSessionId),
    type: 'checkout.completed',
    data: {
      subscriptionId: subscription.id,
      provider: session.provider,
      planKey: session.planKey,
      priceId: session.priceId,
      checkoutSessionId: session.checkoutSessionId
    }
  };
}

function subscriptionRef(subscription: BillFnSubscription) {
  return {
    subscriptionId: subscription.id,
    provider: subscription.provider,
    planKey: subscription.planKey,
    priceId: subscription.priceId
  };
}

/**
 * The lifecycle events of a write of provider state over `previous`: `subscription.renewed` when an active
 * subscription's period end moves later (once per period end), and `subscription.canceled` when a renewing
 * subscription is canceled (`isCanceledFrom`), keyed by the provider change the call applies
 * (`providerChangeKey`), so every retry of its write, also over a newer row after a lost race, shares its id,
 * and by the payload (`payloadEventId`).
 */
function subscriptionLifecycleEvents(
  previous: BillFnSubscription,
  subscription: BillFnSubscription,
  providerChangeKey: string
): LifecycleEventInput[] {
  // A pending import row is no one's subscription until `settleImportBinding` accepts it, which can still refuse
  // and delete it, so a write to it reports no transition; its acceptance publishes its state.
  if (isImportPending(previous)) {
    return [];
  }
  const events: LifecycleEventInput[] = [];
  const base = { billingAccountId: subscription.billingAccountId, occurredAt: subscription.updatedAt };
  const ref = subscriptionRef(subscription);
  const previousEnd = previous.currentPeriodEnd ? Date.parse(previous.currentPeriodEnd) : Number.NaN;
  const nextEnd = subscription.currentPeriodEnd ? Date.parse(subscription.currentPeriodEnd) : Number.NaN;
  if (subscription.status === 'active' && Number.isFinite(previousEnd) && Number.isFinite(nextEnd) && nextEnd > previousEnd) {
    const data = {
      ...ref,
      currentPeriodStart: subscription.currentPeriodStart ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd!,
      previousPeriodEnd: previous.currentPeriodEnd!
    };
    const id = payloadEventId('subscription.renewed', `${subscription.id}\n${toIsoString(new Date(nextEnd))}`, data);
    events.push({ ...base, id, type: 'subscription.renewed', data });
  }
  if (isCanceledFrom(previous, subscription)) {
    const data = {
      ...ref,
      status: subscription.status,
      autoRenew: subscription.autoRenew,
      currentPeriodEnd: subscription.currentPeriodEnd ?? null
    };
    const id = payloadEventId('subscription.canceled', `${subscription.id}\n${providerChangeKey}`, data);
    events.push({ ...base, id, type: 'subscription.canceled', data });
  }
  return events;
}

/**
 * Statuses of a subscription that renews unless `autoRenew` is off: live (`active`, `trialing`, `grace`) or
 * held by a payment problem or a pause (`past_due`, `paused`), which resumes. `autoRenew` is the renewal
 * intent in all of them, independent of a hold.
 */
const RENEWABLE_STATUSES = new Set<SubscriptionStatus>(['active', 'trialing', 'grace', 'past_due', 'paused']);

/**
 * Whether `next` cancels a subscription that intended to renew in `previous` (renewable with `autoRenew` on):
 * it became `canceled`, or stays renewable with `autoRenew` turned off (a cancel at period end, also one made
 * during a hold). Once reported, the row no longer intends to renew, so a later hold, resume, expiry or final
 * cancellation reports nothing more. A hold alone, `pending`, an expiry or a failure is not a cancellation.
 */
function isCanceledFrom(previous: BillFnSubscription, next: BillFnSubscription) {
  if (!RENEWABLE_STATUSES.has(previous.status) || !previous.autoRenew) {
    return false;
  }
  return next.status === 'canceled' || (RENEWABLE_STATUSES.has(next.status) && !next.autoRenew);
}

/** Compares JSON values regardless of key order (a jsonb column reorders keys). */
function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])]);
  }
  return value ?? null;
}

/** Orders strings by UTF-16 code units, as a comparator-free sort does, never by locale, so canonical bytes stay stable. */
function compareCodeUnits(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

function findBillingEvent(db: Adapter, namespace: string, id: string) {
  return db.findOne<BillFnBillingEvent>({
    model: TABLES.billingEvents,
    where: [{ field: 'id', operator: 'eq', value: id }],
    namespace
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
    // Already recorded: a provider-event-keyed entry by an earlier apply of the same event, or a digest-keyed
    // import event by an earlier write of the same import run and state. The first write wins.
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

  if (isImportPending(subscription)) {
    // Not usable until its import accepts it: the event is stored unlinked and replayed then.
    return null;
  }
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
  parsedEvent: ParsedProviderEvent
) {
  const state = parsedEvent.billingState;
  if (!state) {
    return null;
  }
  const event = await withTrustedCheckoutReference(deps, providerName, parsedEvent, state);
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
  const importPending = isImportPending(existing);
  if (importPending) {
    // Its import replays this event once it accepts the row; a refused import leaves it unlinked.
    reason = 'subscription_import_pending';
  } else if (existing) {
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
  if (existing && !importPending) {
    return { handled: null };
  }
  // A link (or an import's acceptance) that committed while this event was being stored would have missed it;
  // replay it now. The replay skips a row still pending.
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
  if (isImportPending(subscription)) {
    // A pending import row is not linked yet: its import replays the events once it accepts the row.
    return result;
  }
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
  const storedEvent = deserializeParsedWebhookEvent(row.event);
  const state = storedEvent?.billingState;
  if (!storedEvent || !state) {
    return { kind: 'unresolved' };
  }
  const event = await withTrustedCheckoutReference(deps, row.provider, storedEvent, state);
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

/**
 * The event with its checkout reference kept only when it can be trusted. A reference the provider reported from
 * its own record (`checkoutReferenceSource` other than `metadata`) that equals a session's provider checkout id,
 * or any reference to a session that already holds the event's provider references, is the provider's. A
 * reference copied from metadata anyone paying the provider can set, or one naming a BillFn checkout session id,
 * links the event to that session (and its plan and billing account) only when the event pays for the session's
 * product, as the provider reported it, and any billing account its metadata names is the session's. Otherwise it
 * is dropped and the event is linked, bootstrapped or stored unlinked by its own references, as if it named no
 * session.
 */
async function withTrustedCheckoutReference<T extends ParsedProviderEvent>(
  deps: ServiceDeps,
  provider: BillingProviderName,
  event: T,
  state: VerifiedBillingState
): Promise<T> {
  const reference = event.checkoutReferenceId;
  if (!reference) {
    return event;
  }
  // An event stored before sources were recorded is the provider's when its raw record names the reference as
  // the provider's own checkout id (Dodo's checkout_session_id).
  const rawData = asRecord(event.raw.data);
  const source =
    event.checkoutReferenceSource ??
    (readString(rawData ?? event.raw, 'checkout_session_id') === reference ? 'provider' : undefined);
  const byProviderId = await deps.db.findOne<BillFnCheckoutSession>({
    model: TABLES.checkoutSessions,
    where: [
      { field: 'provider', operator: 'eq', value: provider },
      { field: 'providerCheckoutId', operator: 'eq', value: reference }
    ],
    namespace: deps.namespace
  });
  // Only a reference the adapter says it read from the provider's own record is trusted as the provider's; one
  // without a source (an adapter that does not say, or an event stored before sources were recorded) is checked.
  if (byProviderId && source === 'provider') {
    return event;
  }
  const session =
    byProviderId ??
    (await deps.db.findOne<BillFnCheckoutSession>({
      model: TABLES.checkoutSessions,
      where: [{ field: 'checkoutSessionId', operator: 'eq', value: reference }],
      namespace: deps.namespace
    }));
  if (!session || checkoutReferenceMatchesSession(deps, provider, event, state, session)) {
    return event;
  }
  deps.metrics.track('webhook.checkout_reference.dropped', {
    provider,
    providerEventId: event.providerEventId
  });
  return { ...event, checkoutReferenceId: undefined, checkoutReferenceSource: undefined };
}

function checkoutReferenceMatchesSession(
  deps: ServiceDeps,
  provider: BillingProviderName,
  event: ParsedProviderEvent,
  state: VerifiedBillingState,
  session: BillFnCheckoutSession
): boolean {
  if (session.provider !== provider) {
    return false;
  }
  const holdsReference =
    (state.providerSubscriptionId !== undefined && session.providerSubscriptionId === state.providerSubscriptionId) ||
    (state.providerChargeId !== undefined && session.providerChargeId === state.providerChargeId);
  if (holdsReference) {
    return true;
  }
  const metadataBillingAccountId = readBillingAccountMetadata(event, state);
  if (metadataBillingAccountId && metadataBillingAccountId !== session.billingAccountId) {
    return false;
  }
  // The session's own price, looked up in its plan (a price id may repeat across plans).
  const sessionPrice = resolvePlan(deps.catalog, session.planKey)?.prices.find(
    (price) => price.priceId === session.priceId && price.provider === provider
  );
  // The event must pay for the session's product, as the provider itself reported it; a price id from metadata
  // proves nothing.
  // The adapter's providerProductId may name the catalog price itself (see BillFnVerifiedBillingState).
  return (
    sessionPrice !== undefined &&
    (providerReportedProducts(provider, state).includes(sessionPrice.providerProductId) ||
      state.providerProductId === sessionPrice.priceId)
  );
}

/**
 * The products a provider's own record says the event paid for: the state's product, and the product fields of
 * its raw record (its transaction's for Apple, its cart's for a Dodo one-time payment). Metadata is never read.
 */
function providerReportedProducts(provider: BillingProviderName, state: VerifiedBillingState | undefined): string[] {
  const raw = asRecord(state?.raw);
  const records = [raw, asRecord(raw?.transaction)];
  // A Dodo cart lists a payment's one-time items; a payment that also charges a subscription keeps the
  // subscription's product elsewhere, so its cart says nothing about the subscription's plan.
  const cart = dodoCartNamesProduct(provider, state) && Array.isArray(raw?.product_cart) ? raw.product_cart : [];
  return [
    state?.providerProductId,
    ...records.flatMap((record) => (record ? [readString(record, 'product_id'), readString(record, 'productId')] : [])),
    ...cart.map((item) => readString(asRecord(item) ?? {}, 'product_id'))
  ].filter((product): product is string => typeof product === 'string' && product.length > 0);
}

/**
 * Whether a record's Dodo product_cart names the product paid for: only for a Dodo payment that says it is one-time
 * (a null subscription_id, or a subscription_ids list) and charges no subscription. A cart lists a payment's one-time
 * items, so it says nothing about a subscription's plan, nor about a payment that does not say which it is.
 */
function dodoCartNamesProduct(provider: BillingProviderName, state: VerifiedBillingState | undefined): boolean {
  const raw = asRecord(state?.raw);
  const saysOneTime = raw !== null && (raw.subscription_id === null || Array.isArray(raw.subscription_ids));
  return provider === 'dodo' && saysOneTime && !chargesSubscription(state);
}

/** Whether a record charges a subscription: it names one, or (Dodo) lists subscription ids or is multi-subscription. */
function chargesSubscription(state: VerifiedBillingState | undefined): boolean {
  const raw = asRecord(state?.raw);
  return (
    Boolean(state?.providerSubscriptionId) ||
    Boolean(readString(raw ?? {}, 'subscription_id')) ||
    (Array.isArray(raw?.subscription_ids) && raw.subscription_ids.length > 0) ||
    raw?.is_multi_subscription === true
  );
}

function readCheckoutReferenceSource(value: unknown): 'provider' | 'metadata' | undefined {
  return value === 'provider' || value === 'metadata' ? value : undefined;
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
    // A Dodo payment whose cart does not name its product, and that reports no product, names its plan nowhere: a
    // hint an older adapter stored from its cart is not used.
    const rawCart = asRecord(event.billingState?.raw)?.product_cart;
    const staleCartHint =
      provider === 'dodo' &&
      Array.isArray(rawCart) &&
      rawCart.length > 0 &&
      !dodoCartNamesProduct(provider, event.billingState) &&
      providerReportedProducts(provider, event.billingState).length === 0;
    const references = [
      event.billingState?.providerProductId,
      staleCartHint ? undefined : event.priceId,
      ...records.flatMap((record) =>
        record ? ['product_id', 'productId', 'price_id', 'priceId'].map((key) => readString(record, key)) : []
      )
    ];
    // When the provider reported what the event paid for, a price id (which can come from metadata) selects only
    // a catalog price of this provider with that id that sells a reported product; the reported products then
    // select by product id alone, so neither can stand in for the other.
    const paidProducts = providerReportedProducts(provider, event.billingState);
    const resolved =
      paidProducts.length === 0
        ? findCatalogPriceReference(deps.catalog, provider, references, subscription?.priceId)
        : (selectPaidPriceById(deps.catalog, provider, references, paidProducts, event.billingState?.providerProductId) ??
          findCatalogPriceReference(deps.catalog, provider, paidProducts, subscription?.priceId, { productsOnly: true }));
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
 * The first catalog price of this provider whose id a reference names and whose product was paid for, or that the
 * adapter's own providerProductId names directly.
 */
function selectPaidPriceById(
  catalog: BillFnCatalog,
  provider: BillingProviderName,
  references: Array<string | null | undefined>,
  paidProducts: readonly string[],
  /** The adapter's providerProductId, which may name the catalog price itself rather than a product. */
  adapterPriceReference?: string
): CatalogSelection | null {
  for (const reference of references) {
    if (!reference) {
      continue;
    }
    for (const plan of catalog.plans) {
      const price = plan.prices.find(
        (candidate) =>
          candidate.priceId === reference &&
          candidate.provider === provider &&
          (paidProducts.includes(candidate.providerProductId) || candidate.priceId === adapterPriceReference)
      );
      if (price) {
        return { plan, price };
      }
    }
  }
  return null;
}

/**
 * The catalog price the references name: an exact catalog price id first, then
 * a provider product id. A product several prices share names the current
 * price if it is one of them, else the first of them when they are all in one
 * plan; across plans it names none, so the caller keeps its stored selection.
 * With `productsOnly`, only the product-id pass runs.
 */
function findCatalogPriceReference(
  catalog: BillFnCatalog,
  provider: BillingProviderName,
  references: Array<string | null | undefined>,
  currentPriceId?: string,
  options: { productsOnly?: boolean } = {}
): CatalogSelection | null {
  const prices = catalog.plans.flatMap((plan) =>
    plan.prices.filter((price) => price.provider === provider).map((price) => ({ plan, price }))
  );
  const named = references.filter((reference): reference is string => Boolean(reference));
  for (const reference of options.productsOnly ? [] : named) {
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
    case 'lifecycle-events':
      return { type: 'lifecycle-events', jobId: job.id };
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
  checkoutReferenceSource?: 'provider' | 'metadata';
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
    ...(event.checkoutReferenceSource ? { checkoutReferenceSource: event.checkoutReferenceSource } : {}),
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
    checkoutReferenceSource: readCheckoutReferenceSource(record.checkoutReferenceSource),
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
