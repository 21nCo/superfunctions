import type { Adapter, TableSchema } from '@superfunctions/db';
import type { Envelope } from '@superfunctions/envelope';
import type { Router } from '@superfunctions/http';
import type { MetricsEmitter } from '@superfunctions/metrics';

export type BillingProviderName =
  | 'dodo'
  | 'apple'
  | 'stripe'
  | 'polar'
  | 'google-play'
  | 'microsoft-store';

export type BillingOwnerType = 'user' | 'organization';
export type BillingActorType = 'user' | 'api-key' | 'service';
export type BillingPriceKind = 'subscription' | 'one_time';
export type BillingInterval = 'month' | 'year' | 'lifetime';

export type SubscriptionStatus =
  | 'pending'
  | 'trialing'
  | 'active'
  | 'grace'
  | 'past_due'
  | 'canceled'
  | 'expired'
  | 'paused'
  | 'failed';

export type EntitlementStatus = 'trialing' | 'active' | 'grace' | 'inactive';
export type CheckoutSessionStatus =
  | 'pending'
  | 'requires_action'
  | 'succeeded'
  | 'failed'
  | 'expired';

export type BillFnOperationStatus = 'applied' | 'requires_action';
export type BillFnChangeEffectiveAt = 'immediate' | 'next_renewal';
export type BillFnProrationBehavior = 'provider_default' | 'prorate' | 'none';
export type BillFnRefundMode = 'full' | 'prorated_remaining_period' | 'custom';
export type BillFnReconciliationJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type BillFnReconciliationJobKind =
  | 'webhook-event'
  | 'subscription-sync'
  | 'account-scan'
  | 'notification-history-backfill'
  | 'webhook-replay'
  | 'lifecycle-events';

export interface BillableSubject {
  actorId?: string;
  actorType?: BillingActorType;
  principalId?: string;
  tenantId?: string;
  organizationId?: string;
}

export interface BillingAccountResolver {
  resolve(input: BillableSubject): Promise<{
    billingAccountId: string;
    ownerType: BillingOwnerType;
    ownerId: string;
  } | null>;
}

export interface BillFnPlanDefinition {
  productKey: string;
  planKey: string;
  displayName: string;
  description?: string;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  metadata?: Record<string, unknown>;
  prices: BillFnPriceDefinition[];
}

export interface BillFnPriceDefinition {
  priceId: string;
  provider: BillingProviderName;
  providerProductId: string;
  displayName?: string;
  currency: string;
  amount: number;
  kind: BillingPriceKind;
  interval: BillingInterval;
  trialDays?: number;
  /**
   * Restricts who may buy this price, for example `first-purchase` for an
   * introductory discount. Checkout and plan changes sell a tagged price only
   * when the host's `checkout.isPriceEligible` hook approves it for the billing
   * account, and checkout never picks a tagged price as the default for a plan,
   * provider and interval.
   */
  eligibility?: string;
  metadata?: Record<string, unknown>;
}

export interface BillFnCatalog {
  plans: BillFnPlanDefinition[];
}

export interface BillFnBillingAccount {
  id: string;
  ownerType: BillingOwnerType;
  ownerId: string;
  currency?: string;
  region?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BillFnSubscription {
  id: string;
  billingAccountId: string;
  planKey: string;
  priceId: string;
  provider: BillingProviderName;
  providerSubscriptionId?: string;
  providerCheckoutId?: string;
  providerChargeId?: string;
  status: SubscriptionStatus;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAt?: string;
  canceledAt?: string;
  trialEnd?: string;
  autoRenew: boolean;
  metadata?: Record<string, unknown>;
  /**
   * Set while references a committed mutation's write dropped could not be
   * recorded as replaced; they are saved in metadata and recorded by the next write.
   */
  replacedReferencesPending?: boolean | null;
  /**
   * Without transactions (and with `onEvent`), the ids of the lifecycle
   * events the latest write that caused any recorded, space-separated: the
   * proof a stopped write leaves that it applied. Internal.
   */
  lifecycleEventIds?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillFnCheckoutSession {
  checkoutSessionId: string;
  billingAccountId: string;
  planKey: string;
  priceId: string;
  provider: BillingProviderName;
  providerCheckoutId?: string;
  providerSubscriptionId?: string;
  providerChargeId?: string;
  status: CheckoutSessionStatus;
  checkoutUrl?: string;
  clientAction?: BillFnClientAction;
  metadata?: Record<string, unknown>;
  /** As on `BillFnSubscription`. Internal. */
  lifecycleEventIds?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillFnEntitlementSnapshot {
  id: string;
  billingAccountId: string;
  planKey: string;
  status: EntitlementStatus;
  features: Record<string, boolean>;
  limits: Record<string, number>;
  effectiveAt: string;
  expiresAt?: string;
  sourceEventId?: string;
  /** As on `BillFnSubscription`. Internal. */
  lifecycleEventIds?: string | null;
  /**
   * Set when an active entitlement grant, not the account's paid subscription,
   * supplies this snapshot (`trialing` for a trial, `active` for a comp) until
   * `expiresAt`. Never stored: every read derives it from the grant.
   */
  grant?: BillFnEntitlementSnapshotGrant;
  createdAt: string;
  updatedAt: string;
}

export interface BillFnEntitlementSnapshotGrant {
  id: string;
  kind: BillFnEntitlementGrantKind;
  expiresAt: string;
}

/** A trial (`trialing` entitlements, once per billing account) or a comp (`active`, revocable). */
export type BillFnEntitlementGrantKind = 'trial' | 'comp';

/** Derived when a grant is read: `revoked` once revoked, otherwise `expired` from `expiresAt` on. */
export type BillFnEntitlementGrantStatus = 'active' | 'expired' | 'revoked';

/**
 * Entitlements granted without payment until `expiresAt`. A paid subscription
 * whose entitlements are not `inactive` supersedes a grant; once the grant
 * expires or is revoked, the account falls back to its paid state, or to
 * `inactive` without one.
 */
export interface BillFnEntitlementGrant {
  id: string;
  billingAccountId: string;
  planKey: string;
  kind: BillFnEntitlementGrantKind;
  /** Derived from `revokedAt` and `expiresAt` when read; not stored. */
  status: BillFnEntitlementGrantStatus;
  startsAt: string;
  expiresAt: string;
  revokedAt?: string | null;
  operator?: BillFnOperator | null;
  reason?: string | null;
  revokedBy?: BillFnOperator | null;
  revokeReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The subject-facing view of a grant, as `getEntitlements` and `GET /entitlements` return it. */
export interface BillFnEntitlementGrantSummary {
  id: string;
  kind: BillFnEntitlementGrantKind;
  planKey: string;
  status: BillFnEntitlementGrantStatus;
  startsAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface BillFnUsageMeter {
  id: string;
  billingAccountId: string;
  resource: string;
  current: number;
  updatedAt: string;
}

export interface BillFnUsageLedgerEntry {
  id: string;
  billingAccountId: string;
  resource: string;
  amount: number;
  createdAt: string;
}

export interface BillFnWebhookReceipt {
  id: string;
  provider: BillingProviderName;
  providerEventId: string;
  eventType: string;
  signatureVerified: boolean;
  rawPayload: Record<string, unknown>;
  createdAt: string;
  processingJobId?: string | null;
  processingClaimedAt?: string | null;
  processedAt?: string | null;
}

/**
 * Why a verified webhook event could not be applied to a subscription:
 * - `billing_account_metadata_missing`: the provider record carries no `billfn_billing_account_id` metadata.
 * - `billing_account_not_found`: the metadata names a billing account that does not exist.
 * - `price_not_found`: the event's product or price is not in the catalog.
 * - `billing_account_unavailable`: a subscription matches the reference but its billing account is gone.
 * - `provider_reference_replaced`: a subscription write (an event, a replay, a provider read or a mutation) dropped the reference, possibly before this event was first delivered, and no subscription holds it.
 * - `subscription_import_pending`: an operator import holds the reference on a subscription it has not accepted yet; the import replays the event once it accepts it, and a refused import leaves it unlinked.
 */
export type BillFnUnlinkedWebhookEventReason =
  | 'billing_account_metadata_missing'
  | 'billing_account_not_found'
  | 'price_not_found'
  | 'billing_account_unavailable'
  | 'provider_reference_replaced'
  | 'subscription_import_pending';

/**
 * `unlinked` waits for its provider reference to be linked to a subscription;
 * `replaying` is claimed by a replay run; `replayed` was applied and `skipped`
 * was older than the subscription's current provider state.
 */
export type BillFnUnlinkedWebhookEventStatus = 'unlinked' | 'replaying' | 'replayed' | 'skipped';

/** A verified webhook event kept until its provider reference is linked to a subscription. */
export interface BillFnUnlinkedWebhookEvent {
  id: string;
  provider: BillingProviderName;
  providerEventId: string;
  /** The provider subscription id, or the provider charge id for a one-time payment. */
  providerReference: string;
  /** The charge of an event that also names its subscription, so linking either reference replays it. */
  providerSecondaryReference?: string | null;
  eventType: string;
  occurredAt?: string | null;
  reason: BillFnUnlinkedWebhookEventReason;
  /** The `billfn_billing_account_id` metadata value, when the provider record carried one. */
  metadataBillingAccountId?: string | null;
  status: BillFnUnlinkedWebhookEventStatus;
  /** The parsed provider event, replayed once the reference is linked. */
  event: Record<string, unknown>;
  replayClaimId?: string | null;
  replayClaimedAt?: string | null;
  replayedAt?: string | null;
  subscriptionId?: string | null;
  error?: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A provider reference a subscription write dropped (for example the previous
 * charge after a renewal). While no subscription holds it, no event naming it
 * bootstraps another subscription. Rows are never deleted.
 */
export interface BillFnReplacedProviderReference {
  id: string;
  provider: BillingProviderName;
  providerReference: string;
  /** The subscription whose latest write dropped the reference. */
  subscriptionId: string;
  billingAccountId: string;
  replacedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillFnBillingEvent {
  id: string;
  billingAccountId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface BillFnRefund {
  id: string;
  billingAccountId: string;
  subscriptionId?: string;
  provider: BillingProviderName;
  providerChargeId?: string;
  providerRefundId?: string;
  mode: BillFnRefundMode;
  amount?: number;
  currency?: string;
  reason?: string;
  status: 'pending' | 'succeeded' | 'failed' | 'requires_action';
  operationStatus: BillFnOperationStatus;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BillFnSubscriptionChangeRequest {
  id: string;
  billingAccountId: string;
  subscriptionId: string;
  provider: BillingProviderName;
  currentPriceId: string;
  targetPriceId: string;
  effectiveAt: BillFnChangeEffectiveAt;
  prorationBehavior: BillFnProrationBehavior;
  status: 'pending' | 'applied' | 'requires_action' | 'failed';
  operationStatus: BillFnOperationStatus;
  clientAction?: BillFnClientAction;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BillFnReconciliationJob {
  id: string;
  kind: BillFnReconciliationJobKind;
  status: BillFnReconciliationJobStatus;
  provider?: BillingProviderName;
  billingAccountId?: string;
  subscriptionId?: string;
  providerEventId?: string;
  cursor?: string;
  attempts: number;
  error?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface BillFnReconciliationCursor {
  id: string;
  provider: BillingProviderName;
  cursorKey: string;
  cursor?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface BillFnClientAction {
  type: 'redirect' | 'apple-purchase' | 'manage-subscription';
  url?: string;
  productId?: string;
  metadata?: Record<string, unknown>;
}

export interface BillFnProviderCapabilities {
  createCheckout: boolean;
  verifyCheckout: boolean;
  cancelSubscription: boolean;
  syncSubscription: boolean;
  restorePurchases: boolean;
  webhookIngestion: boolean;
  changeSubscription?: boolean;
  resumeSubscription?: boolean;
  refundCharge?: boolean;
  notificationHistory?: boolean;
  importSubscription?: boolean;
}

export interface BillFnProviderCheckoutResult {
  status: CheckoutSessionStatus;
  providerCheckoutId?: string;
  providerSubscriptionId?: string;
  providerChargeId?: string;
  checkoutUrl?: string;
  clientAction?: BillFnClientAction;
  raw?: Record<string, unknown>;
}

export interface BillFnVerifiedBillingState {
  subscriptionStatus: SubscriptionStatus;
  checkoutStatus: CheckoutSessionStatus;
  providerSubscriptionId?: string;
  providerChargeId?: string;
  /**
   * The catalog price or provider product id the provider record names, set
   * by an adapter whose record carries it in a form BillFn cannot read from
   * `raw` (Apple's signed transaction). BillFn reads it before `raw`. A
   * subscription import reads it, like the record's product, as a provider
   * product id only.
   */
  providerProductId?: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  autoRenew?: boolean;
  raw?: Record<string, unknown>;
}

export interface BillFnProviderOperationResult {
  operationStatus: BillFnOperationStatus;
  billingState?: BillFnVerifiedBillingState | null;
  clientAction?: BillFnClientAction;
  providerRefundId?: string;
  raw?: Record<string, unknown>;
}

export interface BillFnParsedWebhookEvent {
  providerEventId: string;
  type: string;
  signatureVerified: boolean;
  occurredAt?: string;
  planKey?: string;
  priceId?: string;
  providerSubscriptionId?: string;
  providerChargeId?: string;
  checkoutReferenceId?: string;
  /**
   * Where `checkoutReferenceId` came from: `provider` for the provider's own checkout id in its record, `metadata`
   * for a value copied from metadata the payer can set. Only a `provider` reference that equals a session's
   * provider checkout id links without a check; any other link needs the event to pay for the session's product.
   */
  checkoutReferenceSource?: 'provider' | 'metadata';
  billingState?: BillFnVerifiedBillingState;
  raw: Record<string, unknown>;
}

export interface BillFnNotificationHistoryPage {
  events: BillFnParsedWebhookEvent[];
  nextCursor?: string;
}

export interface BillFnCreateCheckoutInput {
  checkoutSessionId: string;
  billingAccount: BillFnBillingAccount;
  plan: BillFnPlanDefinition;
  price: BillFnPriceDefinition;
  metadata?: Record<string, unknown>;
  customer?: {
    email?: string;
    name?: string;
    billing?: Record<string, unknown>;
  };
  returnUrl?: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface BillFnVerifyCheckoutInput {
  checkoutSession: BillFnCheckoutSession;
  billingAccount: BillFnBillingAccount;
  plan: BillFnPlanDefinition;
  price: BillFnPriceDefinition;
  payload?: Record<string, unknown>;
}

export interface BillFnSyncSubscriptionInput {
  subscription: BillFnSubscription;
  plan: BillFnPlanDefinition;
  price: BillFnPriceDefinition;
}

export interface BillFnCancelSubscriptionInput {
  subscription: BillFnSubscription;
  reason?: string;
}

export interface BillFnChangeSubscriptionInput {
  subscription: BillFnSubscription;
  currentPlan: BillFnPlanDefinition;
  currentPrice: BillFnPriceDefinition;
  targetPlan: BillFnPlanDefinition;
  targetPrice: BillFnPriceDefinition;
  effectiveAt: BillFnChangeEffectiveAt;
  prorationBehavior: BillFnProrationBehavior;
  reason?: string;
}

export interface BillFnResumeSubscriptionInput {
  subscription: BillFnSubscription;
}

export interface BillFnRefundChargeInput {
  subscription?: BillFnSubscription;
  billingAccount: BillFnBillingAccount;
  providerChargeId?: string;
  mode: BillFnRefundMode;
  amount?: number;
  /**
   * The currency `amount` is in and the refund is recorded in: the subscription's catalog price currency. A
   * provider refunds a partial amount only when it is the currency the charge was paid in.
   */
  currency?: string;
  reason?: string;
}

export interface BillFnRestorePurchasesInput {
  billingAccount: BillFnBillingAccount;
  plan: BillFnPlanDefinition;
  price: BillFnPriceDefinition;
  purchaseReference: string;
  payload?: Record<string, unknown>;
}

/**
 * Reads an existing provider subscription an operator is importing. The
 * adapter checks only that the record is the referenced subscription, not the
 * BillFn ownership metadata (`billfn_*`, `appAccountToken`) a subscription
 * created outside BillFn lacks; BillFn checks its product against `plan`.
 */
export interface BillFnImportSubscriptionInput {
  /** The provider subscription id (Dodo) or original transaction id (Apple). */
  providerReference: string;
  billingAccount: BillFnBillingAccount;
  plan: BillFnPlanDefinition;
}

export interface BillFnParseWebhookInput {
  headers: Headers;
  rawBody: string;
}

export interface BillFnFetchNotificationHistoryInput {
  cursor?: string;
  limit?: number;
}

export interface BillFnProviderAdapter {
  readonly provider: BillingProviderName;
  readonly capabilities: BillFnProviderCapabilities;
  createCheckout?(input: BillFnCreateCheckoutInput): Promise<BillFnProviderCheckoutResult>;
  verifyCheckout?(input: BillFnVerifyCheckoutInput): Promise<BillFnVerifiedBillingState>;
  fetchSubscription?(input: BillFnSyncSubscriptionInput): Promise<BillFnVerifiedBillingState | null>;
  cancelSubscription?(input: BillFnCancelSubscriptionInput): Promise<BillFnProviderOperationResult | null>;
  changeSubscription?(input: BillFnChangeSubscriptionInput): Promise<BillFnProviderOperationResult>;
  resumeSubscription?(input: BillFnResumeSubscriptionInput): Promise<BillFnProviderOperationResult>;
  refundCharge?(input: BillFnRefundChargeInput): Promise<BillFnProviderOperationResult>;
  restorePurchases?(input: BillFnRestorePurchasesInput): Promise<BillFnVerifiedBillingState[]>;
  /** Returns null when the provider has no such subscription. */
  importSubscription?(input: BillFnImportSubscriptionInput): Promise<BillFnVerifiedBillingState | null>;
  parseWebhook?(input: BillFnParseWebhookInput): Promise<BillFnParsedWebhookEvent[]>;
  fetchNotificationHistory?(input: BillFnFetchNotificationHistoryInput): Promise<BillFnNotificationHistoryPage>;
}

export interface BillFnWebhookQueuedJob {
  type: 'webhook-event';
  jobId?: string;
  provider: BillingProviderName;
  providerEventId: string;
}

export interface BillFnSubscriptionSyncQueuedJob {
  type: 'subscription-sync';
  jobId?: string;
  provider: BillingProviderName;
  subscriptionId: string;
}

export interface BillFnAccountScanQueuedJob {
  type: 'account-scan';
  jobId?: string;
  provider?: BillingProviderName;
  billingAccountId: string;
}

export interface BillFnNotificationHistoryQueuedJob {
  type: 'notification-history-backfill';
  jobId?: string;
  provider: BillingProviderName;
  cursor?: string;
}

export interface BillFnWebhookReplayQueuedJob {
  type: 'webhook-replay';
  jobId?: string;
  provider: BillingProviderName;
  providerEventId: string;
}

/** Records `grant.expiring` (and `entitlement.changed` for grants that expired), then dispatches due lifecycle events. */
export interface BillFnLifecycleEventsQueuedJob {
  type: 'lifecycle-events';
  jobId?: string;
}

export type BillFnQueuedJob =
  | BillFnWebhookQueuedJob
  | BillFnSubscriptionSyncQueuedJob
  | BillFnAccountScanQueuedJob
  | BillFnNotificationHistoryQueuedJob
  | BillFnWebhookReplayQueuedJob
  | BillFnLifecycleEventsQueuedJob;

/**
 * The queue operations BillFn calls, declared structurally so the published
 * declarations do not import the optional `@superfunctions/queue` peer. A
 * `QueueAdapter<BillFnQueuedJob>` from `@superfunctions/queue` satisfies it.
 */
export interface BillFnQueueAdapter<TPayload = BillFnQueuedJob> {
  enqueue(queueName: string, payload: TPayload, options?: { delayMs?: number; dedupeKey?: string }): Promise<unknown>;
  claim(
    queueName: string,
    options: { leaseMs: number }
  ): Promise<{ id: string; payload: TPayload; attempt: number } | null>;
  ack(id: string, fence?: { attempt?: number }): Promise<void>;
  fail(
    id: string,
    options:
      | { retryAt: Date | number; reason?: string; attempt?: number }
      | { deadLetter: true; reason: string; attempt?: number }
  ): Promise<void>;
  extendLease(id: string, leaseMs: number, fence?: { attempt?: number }): Promise<void>;
}

export interface BillFnRegionConfig {
  /**
   * This deployment's region id. Checkout writes it to the provider record's
   * metadata as `billfn_region` (replacing any caller value), so the webhook
   * ingress can route the record's events here.
   */
  id: string;
  /**
   * The shared internal token the webhook ingress presents as
   * `authorization: Bearer <token>` to `GET <basePath>/ops/owner`. Without
   * one, that endpoint answers every call with 401.
   */
  internalToken?: string;
}

export interface BillFnConfig {
  db: Adapter;
  catalog: BillFnCatalog;
  namespace?: string;
  basePath?: string;
  providers?: Partial<Record<BillingProviderName, BillFnProviderAdapter>>;
  billingAccountResolver?: BillingAccountResolver;
  metrics?: MetricsEmitter;
  queue?: BillFnQueueAdapter<BillFnQueuedJob>;
  auth?: {
    /**
     * Resolves the billing subject of a router request from the host's own
     * session or token check. When it is set, a `subject` in the request body
     * or query string is ignored. A `null` result (or one with no subject
     * field) answers 400; throw `BILLFN_UNAUTHENTICATED` to answer 401.
     */
    resolveSubject?: (request: Request) => Promise<BillableSubject | null> | BillableSubject | null;
    /**
     * Lets the router take the subject from the request body or query string
     * when no `resolveSubject` is configured. Any caller can then act for any
     * account, so set it only when every caller that can reach the router is
     * trusted (a server-to-server deployment behind its own authentication).
     * Without it and without `resolveSubject`, subject routes answer 401.
     */
    allowClientSubject?: boolean;
  };
  /**
   * Router refunds (`POST <basePath>/subscriptions/refund`). The route is off
   * until `authorize` approves the request: refunds move money, so a host
   * decides who may ask for one (an operator check, or a self-service policy
   * such as one refund per charge within a window). In-process
   * `refundCharge` calls and the admin package do not use this hook.
   */
  refunds?: {
    authorize?: (input: BillFnRefundAuthorizationInput) => Promise<boolean> | boolean;
  };
  operations?: {
    authorize?: (request: Request) => Promise<boolean> | boolean;
  };
  /**
   * The region this deployment serves when BillFn runs in several regions
   * behind one webhook ingress per provider (`createWebhookIngress`).
   */
  region?: BillFnRegionConfig;
  checkout?: {
    /**
     * Decides whether a price with an `eligibility` tag may be sold to the
     * billing account. Checkout and `changeSubscription` (including the admin
     * operator path) call it only for a tagged target price and treat any
     * result other than `true` as ineligible; without the hook, tagged prices
     * are never sold. It runs once per request, so a hook that limits a price
     * to one purchase should also count the account's pending checkouts.
     */
    isPriceEligible?: (input: BillFnPriceEligibilityInput) => Promise<boolean> | boolean;
  };
  /**
   * Receives BillFn's lifecycle events. With a handler, every lifecycle event
   * is first stored in the `lifecycleEvents` outbox, then delivered at least
   * once: right after the call that recorded it (which waits for that
   * delivery at most 10 seconds), and otherwise by
   * `services.events.dispatch` or the `lifecycle-events` reconciliation job. A
   * handler that throws, or does not settle within 5 minutes, is retried with
   * backoff for 24 hours after the event was recorded; then the event is
   * `failed`, as is one whose delivery never completed by then (its dispatcher
   * stopped mid-delivery). Deduplicate by `event.id`.
   * Without a handler no event is recorded, so set it in every process that
   * writes billing state.
   */
  onEvent?: BillFnLifecycleEventHandler;
  now?: () => Date;
  generateId?: (prefix: string) => string;
}

export type BillFnLifecycleEventType =
  | 'entitlement.changed'
  | 'checkout.completed'
  | 'subscription.renewed'
  | 'subscription.canceled'
  | 'grant.started'
  | 'grant.expiring';

/** What changed an account's entitlements. */
export type BillFnEntitlementChangeCause = 'subscription' | 'grant.started' | 'grant.revoked' | 'grant.expired';

export interface BillFnLifecycleEventDataMap {
  /**
   * The paid entitlements of a subscription write, or a grant that started or
   * ended, changed. `planKey` and `status` are those of the change's source; a
   * paid subscription that is not `inactive` supersedes a grant, so read
   * `getEntitlements` for the account's effective entitlements.
   */
  'entitlement.changed': {
    cause: BillFnEntitlementChangeCause;
    planKey: string;
    status: EntitlementStatus;
    subscriptionId?: string;
    grantId?: string;
    /** The paid snapshot's features and limits after a subscription write (cause `subscription`). */
    features?: Record<string, boolean>;
    limits?: Record<string, number>;
    previousPlanKey?: string | null;
    previousStatus?: EntitlementStatus | null;
  };
  /** A checkout session succeeded; recorded once per checkout session. */
  'checkout.completed': {
    checkoutSessionId: string;
    subscriptionId: string;
    provider: BillingProviderName;
    planKey: string;
    priceId: string;
  };
  /** An active subscription's billing period moved later; recorded once per period end. */
  'subscription.renewed': {
    subscriptionId: string;
    provider: BillingProviderName;
    planKey: string;
    priceId: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string;
    previousPeriodEnd: string;
  };
  /**
   * A renewing subscription stopped renewing: it was canceled now (`status`
   * `canceled`) or will end at `currentPeriodEnd` (auto-renew turned off).
   */
  'subscription.canceled': {
    subscriptionId: string;
    provider: BillingProviderName;
    planKey: string;
    priceId: string;
    status: SubscriptionStatus;
    autoRenew: boolean;
    currentPeriodEnd: string | null;
  };
  'grant.started': {
    grantId: string;
    kind: BillFnEntitlementGrantKind;
    planKey: string;
    startsAt: string;
    expiresAt: string;
  };
  /** A grant that is not revoked expires within 3 days. */
  'grant.expiring': {
    grantId: string;
    kind: BillFnEntitlementGrantKind;
    planKey: string;
    expiresAt: string;
  };
}

/** A lifecycle event as the `onEvent` handler receives it. */
export type BillFnLifecycleEvent<T extends BillFnLifecycleEventType = BillFnLifecycleEventType> = {
  [K in T]: {
    /** Stable across every delivery of the event: deduplicate by it. */
    id: string;
    type: K;
    billingAccountId: string;
    occurredAt: string;
    data: BillFnLifecycleEventDataMap[K];
    /** The delivery attempt, from 1. */
    attempt: number;
  };
}[T];

export type BillFnLifecycleEventHandler = (event: BillFnLifecycleEvent) => Promise<void> | void;

/**
 * `staged`: recorded, without transactions, before the write that causes it;
 * it is delivered only once that write is confirmed (see `services.events.dispatch`).
 */
export type BillFnLifecycleEventStatus = 'staged' | 'pending' | 'delivered' | 'failed';

/** A row of the `lifecycleEvents` outbox. */
export interface BillFnLifecycleEventRecord {
  id: string;
  type: BillFnLifecycleEventType;
  billingAccountId: string;
  occurredAt: string;
  data: Record<string, unknown>;
  status: BillFnLifecycleEventStatus;
  /**
   * Delivery attempts started, including one an interrupted dispatcher never
   * finished; for a `staged` event, the checks of its row's marker so far.
   */
  attempts: number;
  /**
   * When the event is next due; while a dispatcher holds it, when that claim
   * lapses. A `staged` event is checked against its row's marker then.
   */
  nextAttemptAt: string;
  /** The claim of the dispatcher delivering a `pending` event; one still set once it lapsed marks a delivery that did not complete. */
  claimId?: string | null;
  lastError?: string | null;
  deliveredAt?: string | null;
  failedAt?: string | null;
  /**
   * When the event was recorded, or its latest stage or promotion to `pending`;
   * the 24-hour delivery window counts from it.
   */
  createdAt: string;
  updatedAt: string;
}

export interface BillFnDispatchEventsRequest {
  /** At most this many due events (default 100). */
  limit?: number;
}

export interface BillFnDispatchEventsResult {
  delivered: number;
  /** Handler failures scheduled for another attempt. */
  retrying: number;
  /** Handler failures past the 24-hour delivery window, now `failed`. */
  failed: number;
}

export interface BillFnListEventsRequest {
  status?: BillFnLifecycleEventStatus;
  billingAccountId?: string;
  /** At most this many events, newest first (default 100). */
  limit?: number;
}

/** What the host `checkout.isPriceEligible` hook receives for a tagged catalog price. */
export interface BillFnPriceEligibilityInput {
  billingAccountId: string;
  planKey: string;
  /** The catalog price, including its `eligibility` tag. */
  price: BillFnPriceDefinition;
}

/** Checkout metadata: at most 20 entries; keys up to 40 characters; string (up to 500 characters), finite number or boolean values. */
export type BillFnCheckoutMetadata = Record<string, string | number | boolean>;

export interface BillFnCheckoutCreateRequest {
  subject?: BillableSubject;
  planKey: string;
  provider: BillingProviderName;
  interval?: BillingInterval;
  /**
   * A catalog price of the plan for the chosen provider (and interval, when
   * given). Without it, checkout uses the plan's first untagged price for the
   * provider and interval.
   */
  priceId?: string;
  metadata?: BillFnCheckoutMetadata;
  customer?: {
    email?: string;
    name?: string;
    billing?: Record<string, unknown>;
  };
  returnUrl?: string;
  successUrl?: string;
  cancelUrl?: string;
}

export interface BillFnCheckoutVerifyRequest {
  subject?: BillableSubject;
  checkoutSessionId: string;
  payload?: Record<string, unknown>;
}

export type BillFnVerifyCheckoutRequest = BillFnCheckoutVerifyRequest;

export interface BillFnCancelSubscriptionRequest {
  subject?: BillableSubject;
  subscriptionId?: string;
  reason?: string;
}

export interface BillFnChangeSubscriptionRequest {
  subject?: BillableSubject;
  subscriptionId?: string;
  targetPriceId: string;
  effectiveAt?: BillFnChangeEffectiveAt;
  prorationBehavior?: BillFnProrationBehavior;
  reason?: string;
}

export interface BillFnResumeSubscriptionRequest {
  subject?: BillableSubject;
  subscriptionId?: string;
}

export interface BillFnRefundChargeRequest {
  subject?: BillableSubject;
  subscriptionId?: string;
  providerChargeId?: string;
  mode?: BillFnRefundMode;
  amount?: number;
  reason?: string;
}

/**
 * What `refunds.authorize` sees for a router refund request: the target the
 * refund will act on, resolved before the hook runs (the subscription and
 * charge the request named, or the account's active subscription and its
 * latest charge), so an approval cannot apply to another charge.
 */
export interface BillFnRefundAuthorizationInput {
  request: Request;
  /** The subject the router resolved for the request. */
  subject: BillableSubject;
  billingAccountId: string;
  subscriptionId: string;
  /**
   * The provider's subscription reference. A provider refunds by it when the
   * subscription has no charge id (Apple revokes the original transaction).
   */
  providerSubscriptionId?: string;
  providerChargeId?: string;
  mode: BillFnRefundMode;
  /** For a partial refund: the amount in minor units of `currency`. */
  amount?: number;
  /** The currency BillFn records the refund in: that of the subscription's catalog price. */
  currency: string;
  reason?: string;
}

export interface BillFnRestorePurchasesRequest {
  subject?: BillableSubject;
  planKey: string;
  provider: BillingProviderName;
  priceId?: string;
  purchaseReference: string;
  payload?: Record<string, unknown>;
}

/** The operator or service that granted or revoked entitlements; recorded on the grant and its billing event. */
export interface BillFnOperator {
  id: string;
  type?: string;
  /** The operator request, for audit correlation. */
  requestId?: string;
}

/** Who imported a subscription; recorded on the import's billing event. */
export interface BillFnImportOperator {
  id: string;
  type?: string;
  /**
   * The operator request that ran the import, for audit correlation. It also
   * identifies the run: calling import again with the same request records no
   * new `billfn.subscription.imported` event for a state it already recorded.
   */
  requestId?: string;
}

/**
 * The subscription an import binds: the provider subscription id, or for Apple
 * the original transaction id (both may be given when they are equal).
 */
export type BillFnImportSubscriptionReference =
  | { provider: 'apple'; providerSubscriptionId: string; originalTransactionId?: string }
  | { provider: Exclude<BillingProviderName, 'apple'>; providerSubscriptionId: string; originalTransactionId?: never }
  | {
      provider: 'apple';
      providerSubscriptionId?: string;
      /** Apple only: the subscription's original transaction id. */
      originalTransactionId: string;
    };

/** Binds an existing provider subscription to a billing account. */
export type BillFnImportSubscriptionRequest = BillFnImportSubscriptionRequestFields & BillFnImportSubscriptionReference;

export interface BillFnImportSubscriptionRequestFields {
  provider: BillingProviderName;
  billingAccountId: string;
  /**
   * When set, the billing account is created for this subject if it does not
   * exist yet; the subject must resolve to `billingAccountId`. Without it the
   * billing account must already exist.
   */
  subject?: BillableSubject;
  planKey: string;
  operator: BillFnImportOperator;
  reason?: string;
}

export interface BillFnCreateGrantRequest {
  billingAccountId: string;
  /**
   * When set, the billing account is created for this subject if it does not
   * exist yet; the subject must resolve to `billingAccountId`. Without it the
   * billing account must already exist.
   */
  subject?: BillableSubject;
  planKey: string;
  kind: BillFnEntitlementGrantKind;
  /** An ISO 8601 time after now. */
  expiresAt: string;
  operator?: BillFnOperator;
  reason?: string;
}

export interface BillFnRevokeGrantRequest {
  /** The billing account the grant belongs to; a grant of another account is not found. */
  billingAccountId: string;
  grantId: string;
  operator?: BillFnOperator;
  reason?: string;
}

export interface BillFnSyncSubscriptionRequest {
  subject?: BillableSubject;
  subscriptionId?: string;
}

export interface BillFnWebhookRequest {
  provider: BillingProviderName;
  rawBody: string;
  headers: Headers;
}

export interface BillFnEnqueueReconciliationJobRequest {
  kind: BillFnReconciliationJobKind;
  provider?: BillingProviderName;
  billingAccountId?: string;
  subscriptionId?: string;
  providerEventId?: string;
  cursor?: string;
  payload?: Record<string, unknown>;
}

export interface BillFnRunReconciliationJobRequest {
  jobId: string;
}

export interface BillFnGetReconciliationJobRequest {
  jobId: string;
}

export interface BillFnStatus {
  ok: true;
  version: number;
  namespace: string;
  providers: BillingProviderName[];
  capabilities: string[];
}

export interface BillFnSubscriptionOperationResponseData {
  subscription: BillFnSubscription;
  entitlements: BillFnEntitlementSnapshot;
  operationStatus: BillFnOperationStatus;
  clientAction?: BillFnClientAction;
}

export interface BillFnRefundChargeResponseData {
  refund: BillFnRefund;
  subscription: BillFnSubscription | null;
  entitlements: BillFnEntitlementSnapshot | null;
  operationStatus: BillFnOperationStatus;
  clientAction?: BillFnClientAction;
}

export interface BillFnReconciliationJobResponseData {
  job: BillFnReconciliationJob;
}

export interface BillFnCreateCheckoutResponseData {
  checkoutSession: BillFnCheckoutSession;
  billingAccount: BillFnBillingAccount;
  plan: Pick<BillFnPlanDefinition, 'planKey' | 'productKey' | 'displayName'>;
}

export interface BillFnVerifyCheckoutResponseData {
  checkoutSession: BillFnCheckoutSession;
  subscription: BillFnSubscription;
  entitlements: BillFnEntitlementSnapshot;
}

export interface BillFnCancelSubscriptionResponseData extends BillFnSubscriptionOperationResponseData {}

export interface BillFnChangeSubscriptionResponseData extends BillFnSubscriptionOperationResponseData {
  changeRequest: BillFnSubscriptionChangeRequest;
}

export interface BillFnResumeSubscriptionResponseData extends BillFnSubscriptionOperationResponseData {}

export interface BillFnSyncSubscriptionResponseData {
  subscription: BillFnSubscription;
  entitlements: BillFnEntitlementSnapshot;
}

export interface BillFnImportSubscriptionResponseData {
  subscription: BillFnSubscription;
  entitlements: BillFnEntitlementSnapshot;
  /**
   * The `billfn.subscription.imported` billing event for the subscription state
   * this import returns, after its replay. A rerun of the same request
   * (`operator.requestId`) that finds a state the request already recorded
   * returns the event an earlier call recorded for it.
   */
  billingEvent: BillFnBillingEvent;
}

export interface BillFnRestorePurchasesResponseData {
  subscription: BillFnSubscription;
  entitlements: BillFnEntitlementSnapshot;
}

export interface BillFnEntitlementsResponseData {
  billingAccount: BillFnBillingAccount;
  entitlements: BillFnEntitlementSnapshot | null;
  subscription: BillFnSubscription | null;
  /**
   * The account's entitlement grants, newest first, with their kind, expiry and
   * derived status. The operator and reasons stay on the operator grant
   * results and the billing events.
   */
  grants: BillFnEntitlementGrantSummary[];
}

export interface BillFnGrantResponseData {
  grant: BillFnEntitlementGrant;
  /** The account's entitlements after the write. */
  entitlements: BillFnEntitlementSnapshot | null;
}

export interface BillFnUsageResponseData {
  billingAccount: BillFnBillingAccount;
  usage: Array<{
    resource: string;
    current: number;
    limit: number;
  }>;
}

export interface BillFnWebhookResponseData {
  accepted: boolean;
  processed: number;
}

export type BillFnEnvelope<T> = Envelope<T>;

export type BillFnCreateCheckoutResponse = BillFnEnvelope<BillFnCreateCheckoutResponseData>;
export type BillFnVerifyCheckoutResponse = BillFnEnvelope<BillFnVerifyCheckoutResponseData>;
export type BillFnCancelSubscriptionResponse = BillFnEnvelope<BillFnCancelSubscriptionResponseData>;
export type BillFnChangeSubscriptionResponse = BillFnEnvelope<BillFnChangeSubscriptionResponseData>;
export type BillFnResumeSubscriptionResponse = BillFnEnvelope<BillFnResumeSubscriptionResponseData>;
export type BillFnRefundChargeResponse = BillFnEnvelope<BillFnRefundChargeResponseData>;
export type BillFnSyncSubscriptionResponse = BillFnEnvelope<BillFnSyncSubscriptionResponseData>;
export type BillFnRestorePurchasesResponse = BillFnEnvelope<BillFnRestorePurchasesResponseData>;
export type BillFnImportSubscriptionResponse = BillFnEnvelope<BillFnImportSubscriptionResponseData>;
export type BillFnEntitlementsResponse = BillFnEnvelope<BillFnEntitlementsResponseData>;
export type BillFnGrantResponse = BillFnEnvelope<BillFnGrantResponseData>;
export type BillFnUsageResponse = BillFnEnvelope<BillFnUsageResponseData>;
export type BillFnWebhookResponse = BillFnEnvelope<BillFnWebhookResponseData>;
export type BillFnReconciliationJobResponse = BillFnEnvelope<BillFnReconciliationJobResponseData>;

export interface BillFnInstance {
  router: Router;
  getSchema(): { version: number; schemas: TableSchema[] };
  getCatalog(): Promise<BillFnCatalog>;
  createCheckout(input: BillFnCheckoutCreateRequest): Promise<BillFnCreateCheckoutResponse>;
  verifyCheckout(input: BillFnCheckoutVerifyRequest): Promise<BillFnVerifyCheckoutResponse>;
  cancelSubscription(input: BillFnCancelSubscriptionRequest): Promise<BillFnCancelSubscriptionResponse>;
  changeSubscription(input: BillFnChangeSubscriptionRequest): Promise<BillFnChangeSubscriptionResponse>;
  resumeSubscription(input: BillFnResumeSubscriptionRequest): Promise<BillFnResumeSubscriptionResponse>;
  refundCharge(input: BillFnRefundChargeRequest): Promise<BillFnRefundChargeResponse>;
  syncSubscription(input: BillFnSyncSubscriptionRequest): Promise<BillFnSyncSubscriptionResponse>;
  restorePurchases(input: BillFnRestorePurchasesRequest): Promise<BillFnRestorePurchasesResponse>;
  getEntitlements(subject: BillableSubject): Promise<BillFnEntitlementsResponse>;
  getUsage(subject: BillableSubject, resource?: string): Promise<BillFnUsageResponse>;
  handleWebhook(input: BillFnWebhookRequest): Promise<BillFnWebhookResponse>;
  enqueueReconciliationJob(input: BillFnEnqueueReconciliationJobRequest): Promise<BillFnReconciliationJobResponse>;
  getReconciliationJob(input: BillFnGetReconciliationJobRequest): Promise<BillFnReconciliationJobResponse>;
  runReconciliationJob(input: BillFnRunReconciliationJobRequest): Promise<BillFnReconciliationJobResponse>;
  /** Operator services; none of them is exposed as a public route. */
  services: {
    subscriptions: {
      /**
       * Binds an existing provider subscription to a billing account, syncs its
       * state from the provider and replays its unlinked webhook events. Idempotent
       * per provider reference; a reference bound to another billing account fails
       * with `BILLFN_CONFLICT`. Every successful import records a `billfn.subscription.imported`
       * billing event with the operator before each write that leaves a subscription
       * usable (accepting a new binding, a re-import's change, or adding its import
       * marker), and before its replay. A state the replay writes is recorded after
       * the replay, when the call gets that far.
       */
      import(input: BillFnImportSubscriptionRequest): Promise<BillFnImportSubscriptionResponse>;
    };
    grants: {
      /**
       * Grants a plan's entitlements until `expiresAt`: `trialing` for a trial,
       * `active` for a comp. A billing account gets one trial ever (a second fails
       * with `BILLFN_CONFLICT`, reason `trial_already_granted`) and one active comp
       * at a time (`active_comp_exists`). Records a `billfn.grant.created` billing event.
       */
      create(input: BillFnCreateGrantRequest): Promise<BillFnGrantResponse>;
      /**
       * Revokes a comp (a trial cannot be revoked); revoking a revoked comp
       * returns it unchanged. Records a `billfn.grant.revoked` billing event.
       */
      revoke(input: BillFnRevokeGrantRequest): Promise<BillFnGrantResponse>;
    };
    events: {
      /**
       * Delivers the due lifecycle events to `onEvent`, oldest due first. A
       * dispatcher claims an event before calling the handler, so of two
       * racing dispatchers one delivers it. A claim lasts 5 minutes: an event
       * a dispatcher claimed and never finished, or whose handler still runs,
       * is due again after that. It first settles each `staged` event whose
       * write did not confirm it 5 minutes ago or more: one its row's
       * `lifecycleEventIds` names becomes `pending`; any other is checked
       * again later, since its write may still apply, and is deleted once 24
       * hours passed since its stage.
       */
      dispatch(input?: BillFnDispatchEventsRequest): Promise<BillFnDispatchEventsResult>;
      /** The outbox's events, newest first; `status: 'failed'` lists the events that ran out of retries. */
      list(input?: BillFnListEventsRequest): Promise<BillFnLifecycleEventRecord[]>;
    };
  };
  subscriptionProvider: {
    getActiveSubscription(subject: BillableSubject): Promise<BillFnSubscription | null>;
    getEntitlementSnapshot(subject: BillableSubject): Promise<BillFnEntitlementSnapshot | null>;
    isActive(subject: BillableSubject): Promise<boolean>;
    hasFeature(subject: BillableSubject, feature: string): Promise<boolean>;
  };
  quotaProvider: {
    checkQuota(input: {
      principalId?: string;
      tenantId?: string;
      requestedBytes: number;
      resource?: string;
    }): Promise<{
      allowed: boolean;
      current: number;
      limit: number;
      warning?: string;
      reason?: string;
    }>;
    recordUsage(input: {
      principalId?: string;
      tenantId?: string;
      bytes: number;
      resource?: string;
    }): Promise<void>;
    getUsage(principalId?: string, tenantId?: string, resource?: string): Promise<{ current: number; limit: number }>;
  };
}
