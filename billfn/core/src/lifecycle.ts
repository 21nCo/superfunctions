import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Adapter, WhereClause } from '@superfunctions/db';
import type { MetricsEmitter } from '@superfunctions/metrics';
import { toIsoString } from './helpers.js';
import type {
  BillFnDispatchEventsRequest,
  BillFnDispatchEventsResult,
  BillFnEntitlementGrant,
  BillFnLifecycleEvent,
  BillFnLifecycleEventDataMap,
  BillFnLifecycleEventHandler,
  BillFnLifecycleEventRecord,
  BillFnLifecycleEventType,
  BillFnListEventsRequest
} from './types.js';

const EVENTS_TABLE = 'lifecycleEvents';
const GRANTS_TABLE = 'entitlementGrants';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A handler failure is retried until this long after the event was recorded; then the event is `failed`. */
export const LIFECYCLE_DELIVERY_WINDOW_MS = DAY_MS;
/** How long a dispatcher holds a claimed event; an unfinished claim (a crashed dispatcher) lapses after it. */
export const LIFECYCLE_CLAIM_LEASE_MS = 5 * 60 * 1000;
/**
 * How long after its stage a staged event whose write no row names yet is kept and checked again, because
 * the write may still apply (it stalled); only then is it deleted.
 */
export const LIFECYCLE_STAGE_WINDOW_MS = DAY_MS;
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = HOUR_MS;
/** `grant.expiring` is recorded once a grant expires within this long. */
export const GRANT_EXPIRING_LEAD_MS = 3 * DAY_MS;
/** How far back the sweep looks for grants that expired, to record their `entitlement.changed`. */
export const GRANT_EXPIRED_LOOKBACK_MS = 7 * DAY_MS;
/** How long a call waits for the inline delivery of its events; a slower handler finishes in the background. */
export const LIFECYCLE_INLINE_DELIVERY_MS = 10 * 1000;
const DEFAULT_LIMIT = 100;
/** At most 50 ids per `in` query, within D1's 100 bound parameters. */
const SWEEP_PAGE_SIZE = 50;
/** The most grants each expiry sweep (`expired`, `expiring`) reads in one job run; the next run resumes after them. */
export const GRANT_SWEEP_RUN_LIMIT = 200;
/**
 * How far behind now each sweep's window ends, so a grant write that becomes visible up to this long after its
 * timestamp is usually still ahead of the stored position. One that lands later, or on an instance whose clock is
 * behind, gets its expiry events from `recordPassedGrantExpiry` once its creation is recorded.
 */
export const GRANT_SWEEP_SETTLE_MS = 60 * 1000;
const CURSORS_TABLE = 'reconciliationCursors';

/** An event to record: its id derives from what it describes, so recording it again is a no-op. */
export type LifecycleEventInput = {
  [K in BillFnLifecycleEventType]: {
    id: string;
    type: K;
    billingAccountId: string;
    occurredAt: string;
    data: BillFnLifecycleEventDataMap[K];
  };
}[BillFnLifecycleEventType];

export interface LifecycleDeps {
  db: Adapter;
  namespace: string;
  now: () => Date;
  generateId: (prefix: string) => string;
  metrics: MetricsEmitter;
  onEvent?: BillFnLifecycleEventHandler;
  isDuplicateRecordError(error: unknown): boolean;
  /**
   * Whether the row the write of a `staged` event targets names the event in
   * its `lifecycleEventIds` marker, the proof that a write causing it applied;
   * a staged event whose write was interrupted is delivered only then, and is
   * deleted once no write naming it applied within `LIFECYCLE_STAGE_WINDOW_MS`.
   */
  isStagedEventApplied(event: BillFnLifecycleEventRecord): Promise<boolean>;
}

export type LifecycleEvents = ReturnType<typeof createLifecycleEvents>;

/** The stable id of the event of `type` that `key` identifies. */
export function lifecycleEventId(type: BillFnLifecycleEventType, key: string) {
  const digest = createHash('sha256').update(`${type}\n${key}`).digest('base64url');
  return `lce_${digest.slice(0, 32)}`;
}

/**
 * The lifecycle events a grant billing event stands for, derived from it and the stored grant's revocation so a
 * repair records the same ones; a creation-time `grant.expiring` only while the grant is not revoked (`revoked`:
 * the stored grant has a `revokedAt` when the event is recorded) and has not expired at `now` (a repair after its
 * expiry or revocation records none).
 */
export function grantLifecycleEvents(
  event: {
    billingAccountId: string;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  },
  now: Date,
  revoked = false
): LifecycleEventInput[] {
  const { grantId, kind, planKey, startsAt, expiresAt } = event.payload as Record<string, string>;
  const base = { billingAccountId: event.billingAccountId, occurredAt: event.createdAt };
  if (event.type === 'billfn.grant.created') {
    return [
      {
        ...base,
        id: lifecycleEventId('grant.started', grantId!),
        type: 'grant.started',
        data: { grantId: grantId!, kind: kind as 'trial' | 'comp', planKey: planKey!, startsAt: startsAt!, expiresAt: expiresAt! }
      },
      grantEntitlementChange(base, 'grant.started', grantId!, planKey!, kind === 'trial' ? 'trialing' : 'active'),
      // A grant that already expires within the lead time gets its `grant.expiring` with its creation: the
      // expiry sweep resumes after the grants it read, so it never returns to an expiry that is already behind it.
      // A revoked grant never expires, so it gets none.
      ...(!revoked &&
      Date.parse(expiresAt!) - Date.parse(event.createdAt) <= GRANT_EXPIRING_LEAD_MS &&
      Date.parse(expiresAt!) > now.getTime()
        ? [grantExpiringEvent({ ...base, grantId: grantId!, kind: kind as 'trial' | 'comp', planKey: planKey!, expiresAt: expiresAt! })]
        : [])
    ];
  }
  if (event.type === 'billfn.grant.revoked') {
    return [grantEntitlementChange(base, 'grant.revoked', grantId!, planKey!, 'inactive')];
  }
  return [];
}

function grantExpiringEvent(input: {
  billingAccountId: string;
  occurredAt: string;
  grantId: string;
  kind: 'trial' | 'comp';
  planKey: string;
  expiresAt: string;
}): LifecycleEventInput {
  return {
    id: lifecycleEventId('grant.expiring', input.grantId),
    type: 'grant.expiring',
    billingAccountId: input.billingAccountId,
    occurredAt: input.occurredAt,
    data: { grantId: input.grantId, kind: input.kind, planKey: input.planKey, expiresAt: input.expiresAt }
  };
}

function grantEntitlementChange(
  base: { billingAccountId: string; occurredAt: string },
  cause: 'grant.started' | 'grant.revoked' | 'grant.expired',
  grantId: string,
  planKey: string,
  status: 'trialing' | 'active' | 'inactive'
): LifecycleEventInput {
  return {
    ...base,
    id: lifecycleEventId('entitlement.changed', `${cause}\n${grantId}`),
    type: 'entitlement.changed',
    data: { cause, grantId, planKey, status }
  };
}

/**
 * The lifecycle event outbox. Every event is stored before any delivery, with
 * an id derived from what it describes, so a repeated write records it once and
 * every delivery carries the same id. Delivery is at least once: a dispatcher
 * claims a due event with a compare-and-set on its due time and attempt count,
 * so of two racing dispatchers one delivers it; the claim moves the due time a
 * lease ahead, so an event whose dispatcher crashed is due again once the lease
 * lapses. A handler failure, or a delivery that did not complete, schedules the
 * next attempt with exponential backoff until 24 hours after the event was
 * recorded; a dispatch after that marks it `failed` without calling the handler
 * (one never attempted gets one attempt), and `list({ status: 'failed' })` shows it.
 */
export function createLifecycleEvents(deps: LifecycleDeps) {
  const handler = deps.onEvent;
  /** The ids of the events the current call recorded, which `deliverAfter` delivers once the call settles. */
  const callEvents = new AsyncLocalStorage<Set<string>>();

  /**
   * Stores the events through `db` (a transaction, when given) unless already
   * stored. Without an `onEvent` handler nothing is recorded. `beforeWrite`
   * runs before each row write (a job's lease check); when it throws, no
   * further row is written.
   */
  async function record(events: LifecycleEventInput[], db: Adapter = deps.db, beforeWrite?: () => Promise<void>) {
    if (!handler) {
      return;
    }
    for (const event of events) {
      // Checked first: inside a Postgres transaction a duplicate-key error would abort it.
      if (!(await findEvent(event.id, db))) {
        await beforeWrite?.();
        await createEvent(event, 'pending', null, db);
      }
      callEvents.getStore()?.add(event.id);
    }
  }

  /**
   * `record` for a grant's expiry events (`grant.expiring`, `entitlement.changed` with cause `grant.expired`):
   * the stored grant is read again through `db` right before each row is written (then `beforeWrite` runs), and a
   * grant revoked by then gets no more rows. A revoke that commits between that read and the write is caught at
   * delivery, which drops such an event without calling the handler.
   */
  async function recordForUnrevokedGrant(
    events: LifecycleEventInput[],
    grantId: string,
    db: Adapter = deps.db,
    beforeWrite?: () => Promise<void>
  ) {
    if (!handler) {
      return;
    }
    for (const event of events) {
      if (!(await findEvent(event.id, db))) {
        const grant = await db.findOne<{ revokedAt?: string | null }>({
          model: GRANTS_TABLE,
          where: [{ field: 'id', operator: 'eq', value: grantId }],
          namespace: deps.namespace
        });
        if (!grant || grant.revokedAt) {
          return;
        }
        await beforeWrite?.();
        await createEvent(event, 'pending', null, db);
      }
      callEvents.getStore()?.add(event.id);
    }
  }

  /**
   * Without transactions, records the events of a write before it runs, as
   * `staged`: no dispatcher delivers them until `confirm` or `promote` makes
   * them `pending` once a write that names them applied. Staging an event that
   * is already staged renews its stage, which ends a recovery claim on it, and
   * keeps its stored payload: an id names one payload (the caller derives it
   * from the payload), so a racing write that loses never replaces what the
   * applied one delivers. One already pending, delivered or failed is left as
   * it is. A staged event
   * whose write was interrupted, or failed or lost its race, is settled by
   * `dispatch` after the claim lease against the marker on its row; it is
   * kept staged, and checked again, until `LIFECYCLE_STAGE_WINDOW_MS` after
   * its latest stage.
   */
  async function stage(events: LifecycleEventInput[]) {
    if (!handler) {
      return;
    }
    const stageId = deps.generateId('lcs');
    for (const event of events) {
      const existing = await findEvent(event.id);
      if (!existing && (await createEvent(event, 'staged', stageId))) {
        continue;
      }
      await deps.db.updateMany({
        model: EVENTS_TABLE,
        where: [
          { field: 'id', operator: 'eq', value: event.id },
          { field: 'status', operator: 'eq', value: 'staged' }
        ],
        data: {
          claimId: stageId,
          attempts: 0,
          nextAttemptAt: leaseEnd(),
          createdAt: toIsoString(deps.now()),
          updatedAt: toIsoString(deps.now())
        },
        namespace: deps.namespace
      });
    }
  }

  /**
   * Makes the staged events with these ids `pending` and due now: a stored write names them. Their 24-hour
   * delivery window starts at the promotion (`createdAt`), however late in their stage window it comes.
   */
  async function promote(ids: string[]) {
    const promoted = new Set<string>();
    for (const id of handler ? ids : []) {
      const timestamp = toIsoString(deps.now());
      const count = await deps.db.updateMany({
        model: EVENTS_TABLE,
        where: [
          { field: 'id', operator: 'eq', value: id },
          { field: 'status', operator: 'eq', value: 'staged' }
        ],
        data: { status: 'pending', claimId: null, attempts: 0, nextAttemptAt: timestamp, createdAt: timestamp, updatedAt: timestamp },
        namespace: deps.namespace
      });
      if (count === 1) {
        promoted.add(id);
        callEvents.getStore()?.add(id);
      }
    }
    return promoted;
  }

  /** Makes the staged events of an applied write `pending`, recording one that is missing. */
  async function confirm(events: LifecycleEventInput[]) {
    const promoted = await promote(events.map((event) => event.id));
    await record(events.filter((event) => !promoted.has(event.id)));
  }

  function deleteStaged(id: string, claimId: string) {
    return deps.db.deleteMany({
      model: EVENTS_TABLE,
      where: [
        { field: 'id', operator: 'eq', value: id },
        { field: 'status', operator: 'eq', value: 'staged' },
        { field: 'claimId', operator: 'eq', value: claimId }
      ],
      namespace: deps.namespace
    });
  }

  /** Creates the event's row; false when another writer created it first. */
  async function createEvent(
    event: LifecycleEventInput,
    status: 'staged' | 'pending',
    claimId: string | null,
    db: Adapter = deps.db
  ) {
    const timestamp = toIsoString(deps.now());
    const row: BillFnLifecycleEventRecord = {
      ...event,
      data: event.data as Record<string, unknown>,
      status,
      attempts: 0,
      nextAttemptAt: status === 'staged' ? leaseEnd() : timestamp,
      claimId,
      lastError: null,
      deliveredAt: null,
      failedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    try {
      await db.create({ model: EVENTS_TABLE, data: row, namespace: deps.namespace });
      deps.metrics.track('event.recorded', { type: event.type });
      return true;
    } catch (error) {
      if (!deps.isDuplicateRecordError(error)) {
        throw error;
      }
      return false;
    }
  }

  function leaseEnd() {
    return toIsoString(new Date(deps.now().getTime() + LIFECYCLE_CLAIM_LEASE_MS));
  }

  /**
   * Runs `call` and, once it settles, delivers the events it recorded. Each
   * call keeps its own ids, and they are read only after the call's
   * transactions committed or rolled back: an event a rollback discarded is
   * not found and skipped. Delivery never fails the call, and the call waits
   * for it at most `LIFECYCLE_INLINE_DELIVERY_MS`: a slower handler finishes
   * in the background, and an event not delivered stays pending for a later
   * dispatch. A call inside another one leaves delivery to the outer call.
   */
  async function deliverAfter<R>(call: () => Promise<R>): Promise<R> {
    if (!handler || callEvents.getStore()) {
      return call();
    }
    const ids = new Set<string>();
    try {
      return await callEvents.run(ids, call);
    } finally {
      if (ids.size > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          deliverRecorded([...ids]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, LIFECYCLE_INLINE_DELIVERY_MS);
          })
        ]);
        clearTimeout(timer);
      }
    }
  }

  async function deliverRecorded(ids: string[]) {
    for (const id of ids) {
      try {
        const row = await findEvent(id);
        if (row) {
          await deliver(row);
        }
      } catch {
        deps.metrics.track('event.dispatch_deferred', {});
      }
    }
  }

  /**
   * Delivers the due events, oldest due first. `beforeEach` runs before each
   * delivery (the lifecycle job renews its lease there) and stops the dispatch
   * when it throws.
   */
  async function dispatch(
    input: BillFnDispatchEventsRequest = {},
    beforeEach?: () => Promise<void>
  ): Promise<BillFnDispatchEventsResult> {
    const result: BillFnDispatchEventsResult = { delivered: 0, retrying: 0, failed: 0 };
    if (!handler) {
      return result;
    }
    await settleStaged(readLimit(input.limit), beforeEach);
    const due = await deps.db.findMany<BillFnLifecycleEventRecord>({
      model: EVENTS_TABLE,
      where: [
        { field: 'status', operator: 'eq', value: 'pending' },
        { field: 'nextAttemptAt', operator: 'lte', value: toIsoString(deps.now()) }
      ],
      orderBy: [{ field: 'nextAttemptAt', direction: 'asc' }],
      limit: readLimit(input.limit),
      namespace: deps.namespace
    });
    for (const row of due) {
      await beforeEach?.();
      const outcome = await deliver(row);
      if (outcome) {
        result[outcome] += 1;
      }
    }
    return result;
  }

  /**
   * Claims the event and calls the handler once; null when the event is not due
   * or another dispatcher claimed it. A pending event that still holds a claim
   * is due only once that claim lapsed, so its delivery did not complete (the
   * handler hung or the dispatcher stopped); that counts as a failed attempt. It
   * is retried after the backoff of that attempt, counted from the lapsed claim.
   * Once the 24-hour window passed, a due event already attempted (its last retry
   * slot is that deadline) is marked `failed` without calling the handler; one never
   * attempted is delivered once, and fails if that attempt fails. The handler call is
   * bounded by the claim lease; one that does not settle within it failed too.
   */
  async function deliver(row: BillFnLifecycleEventRecord): Promise<DeliveryOutcome | null> {
    const claimedAt = deps.now();
    if (!handler || row.status !== 'pending' || Date.parse(row.nextAttemptAt) > claimedAt.getTime()) {
      return null;
    }
    const due = [
      { field: 'id', operator: 'eq', value: row.id },
      { field: 'status', operator: 'eq', value: 'pending' },
      { field: 'nextAttemptAt', operator: 'eq', value: row.nextAttemptAt },
      { field: 'attempts', operator: 'eq', value: row.attempts }
    ] satisfies WhereClause[];
    const deadline = Date.parse(row.createdAt) + LIFECYCLE_DELIVERY_WINDOW_MS;
    const expired = row.attempts > 0 && (!Number.isFinite(deadline) || claimedAt.getTime() >= deadline);
    if (row.claimId || expired) {
      const ended = await endUndelivered(row, due, deadline, expired, claimedAt);
      if (ended !== undefined) {
        return ended;
      }
    }
    const claimId = deps.generateId('lcc');
    const attempt = row.attempts + 1;
    const claimed = await deps.db.updateMany({
      model: EVENTS_TABLE,
      where: due,
      data: {
        claimId,
        attempts: attempt,
        nextAttemptAt: toIsoString(new Date(claimedAt.getTime() + LIFECYCLE_CLAIM_LEASE_MS)),
        updatedAt: toIsoString(claimedAt)
      },
      namespace: deps.namespace
    });
    if (claimed !== 1) {
      return null;
    }
    if (await isRevokedGrantExpiry(row)) {
      // Its grant was revoked after the event was recorded (a write racing the revoke): dropped, never delivered.
      await deps.db.deleteMany({
        model: EVENTS_TABLE,
        where: [
          { field: 'id', operator: 'eq', value: row.id },
          { field: 'claimId', operator: 'eq', value: claimId }
        ],
        namespace: deps.namespace
      });
      deps.metrics.track('event.dropped', { type: row.type });
      return null;
    }
    const failure = await callHandler(handler, row, attempt);
    return settleAttempt(row, claimId, attempt, deadline, failure);
  }

  /** Whether the event is a grant's `grant.expiring` or its `entitlement.changed` (cause `grant.expired`) and that grant is revoked now. */
  async function isRevokedGrantExpiry(row: BillFnLifecycleEventRecord) {
    const data = row.data as { grantId?: string; cause?: string };
    if (!data.grantId || !(row.type === 'grant.expiring' || (row.type === 'entitlement.changed' && data.cause === 'grant.expired'))) {
      return false;
    }
    const grant = await deps.db.findOne<{ revokedAt?: string | null }>({
      model: GRANTS_TABLE,
      where: [{ field: 'id', operator: 'eq', value: data.grantId }],
      namespace: deps.namespace
    });
    return Boolean(grant?.revokedAt);
  }

  /**
   * A due event attempted before whose 24-hour window passed, or that still holds a claim (a lapsed delivery):
   * marks it `failed` once the window passed, keeping the last error of an unclaimed one, or schedules the
   * retry of a lapsed claim after the backoff of that attempt, counted from the lapsed claim. Returns that
   * outcome, null when another dispatcher ended or claimed it first, or undefined when the retry is due now,
   * so the caller claims it.
   */
  async function endUndelivered(
    row: BillFnLifecycleEventRecord,
    due: WhereClause[],
    deadline: number,
    expired: boolean,
    claimedAt: Date
  ): Promise<DeliveryOutcome | null | undefined> {
    const retryAt = Math.min(Date.parse(row.nextAttemptAt) - LIFECYCLE_CLAIM_LEASE_MS + retryDelay(row.attempts), deadline);
    if (!expired && retryAt <= claimedAt.getTime()) {
      return undefined;
    }
    const timestamp = toIsoString(claimedAt);
    const data = expired ? { status: 'failed' as const, failedAt: timestamp } : { nextAttemptAt: toIsoString(new Date(retryAt)) };
    const ended = await deps.db.updateMany({
      model: EVENTS_TABLE,
      where: due,
      data: { ...data, lastError: row.claimId ? 'delivery did not complete' : (row.lastError ?? 'delivery window passed'), claimId: null, updatedAt: timestamp },
      namespace: deps.namespace
    });
    if (ended !== 1) {
      return null;
    }
    deps.metrics.track(expired ? 'event.failed' : 'event.retry_scheduled', { type: row.type });
    return expired ? 'failed' : 'retrying';
  }

  /** Settles a claimed attempt: delivered, or retried with backoff until the 24-hour window passed, then failed. */
  async function settleAttempt(
    row: BillFnLifecycleEventRecord,
    claimId: string,
    attempt: number,
    deadline: number,
    failure: { error: unknown } | null
  ): Promise<DeliveryOutcome> {
    const finishedAt = deps.now();
    const settledAt = toIsoString(finishedAt);
    if (!failure) {
      await settle(row.id, claimId, { status: 'delivered', deliveredAt: settledAt, lastError: null, updatedAt: settledAt });
      deps.metrics.track('event.delivered', { type: row.type });
      return 'delivered';
    }
    const lastError = errorMessage(failure.error);
    if (!Number.isFinite(deadline) || finishedAt.getTime() >= deadline) {
      await settle(row.id, claimId, { status: 'failed', failedAt: settledAt, lastError, updatedAt: settledAt });
      deps.metrics.track('event.failed', { type: row.type });
      return 'failed';
    }
    const retryAt = Math.min(finishedAt.getTime() + retryDelay(attempt), deadline);
    await settle(row.id, claimId, { nextAttemptAt: toIsoString(new Date(retryAt)), lastError, updatedAt: settledAt });
    deps.metrics.track('event.retry_scheduled', { type: row.type });
    return 'retrying';
  }

  /**
   * Settles the staged events whose stage lapsed: each is claimed like a
   * delivery, then made `pending` when its row names it (a write that caused
   * it applied). Otherwise its write may still apply (it stalled past the
   * lease), so it stays staged and is checked again with backoff, and is
   * deleted only once `LIFECYCLE_STAGE_WINDOW_MS` passed since its stage. A
   * later write that replaces a marker first promotes the events it names, so
   * a marker that is gone proves nothing was lost.
   */
  async function settleStaged(limit: number, beforeEach?: () => Promise<void>) {
    const now = toIsoString(deps.now());
    const lapsed = await deps.db.findMany<BillFnLifecycleEventRecord>({
      model: EVENTS_TABLE,
      where: [
        { field: 'status', operator: 'eq', value: 'staged' },
        { field: 'nextAttemptAt', operator: 'lte', value: now }
      ],
      orderBy: [{ field: 'nextAttemptAt', direction: 'asc' }],
      limit,
      namespace: deps.namespace
    });
    for (const row of lapsed) {
      await beforeEach?.();
      const claimId = deps.generateId('lcc');
      const claimed = await deps.db.updateMany({
        model: EVENTS_TABLE,
        where: [
          { field: 'id', operator: 'eq', value: row.id },
          { field: 'status', operator: 'eq', value: 'staged' },
          { field: 'nextAttemptAt', operator: 'eq', value: row.nextAttemptAt }
        ],
        data: { claimId, nextAttemptAt: leaseEnd(), updatedAt: toIsoString(deps.now()) },
        namespace: deps.namespace
      });
      if (claimed !== 1) {
        continue;
      }
      if (await deps.isStagedEventApplied(row)) {
        const timestamp = toIsoString(deps.now());
        await updateStaged(row.id, claimId, {
          status: 'pending',
          attempts: 0,
          nextAttemptAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp
        });
        deps.metrics.track('event.stage_recovered', { type: row.type });
        continue;
      }
      const now = deps.now().getTime();
      const deadline = Date.parse(row.createdAt) + LIFECYCLE_STAGE_WINDOW_MS;
      if (!Number.isFinite(deadline) || now >= deadline) {
        await deleteStaged(row.id, claimId);
        deps.metrics.track('event.stage_discarded', { type: row.type });
        continue;
      }
      const attempts = row.attempts + 1;
      const recheckAt = Math.min(now + Math.max(retryDelay(attempts), LIFECYCLE_CLAIM_LEASE_MS), deadline);
      await updateStaged(row.id, claimId, { attempts, nextAttemptAt: toIsoString(new Date(recheckAt)), updatedAt: toIsoString(deps.now()) });
    }
  }

  /** Ends a recovery claim on a staged event; one a stage renewed or a write promoted is left as it is. */
  function updateStaged(id: string, claimId: string, data: Partial<BillFnLifecycleEventRecord>) {
    return deps.db.updateMany({
      model: EVENTS_TABLE,
      where: [
        { field: 'id', operator: 'eq', value: id },
        { field: 'status', operator: 'eq', value: 'staged' },
        { field: 'claimId', operator: 'eq', value: claimId }
      ],
      data: { ...data, claimId: null },
      namespace: deps.namespace
    });
  }

  /** Ends this dispatcher's claim; a claim that lapsed and was taken over is left to its new holder. */
  async function settle(id: string, claimId: string, data: Partial<BillFnLifecycleEventRecord>) {
    await deps.db.updateMany({
      model: EVENTS_TABLE,
      where: [
        { field: 'id', operator: 'eq', value: id },
        { field: 'claimId', operator: 'eq', value: claimId }
      ],
      data: { ...data, claimId: null },
      namespace: deps.namespace
    });
  }

  /**
   * Records `entitlement.changed` (cause `grant.expired`) for each grant that is not revoked and expired in the
   * last 7 days, then `grant.expiring` for each that expires within 3 days. Each is one sweep keyed by
   * (`expiresAt`, `id`) that stores the position after the grants it finished in `reconciliationCursors`, so a
   * run reads at most `GRANT_SWEEP_RUN_LIMIT` grants per sweep and the next run resumes after them, never
   * rereading a grant a run finished. Grants only enter a window by time passing (a new grant expires in the
   * future, and one created already within 3 days records `grant.expiring` with its creation). A grant whose
   * write becomes visible only after a position passed its expiry is covered by the two sides of one ordering:
   * after moving the position past a page the sweep reads that page's range again and records the grants that
   * became visible since, and a grant visible only after that re-read sees the moved position once its creation
   * is recorded (`recordPassedGrantExpiry`). A page's events are recorded before the position moves past it, so a
   * run that stops mid-page leaves that page to the next run, which records only what is missing. Of two runs
   * that read the same position, the one that moves it first goes on and the other stops that sweep.
   * `beforePage` runs before each page (the job's lease check).
   */
  async function recordGrantExpiry(beforePage?: () => Promise<void>) {
    if (!handler) {
      return;
    }
    const now = deps.now().getTime();
    await sweepGrants('expired', now - GRANT_EXPIRED_LOOKBACK_MS, now - GRANT_SWEEP_SETTLE_MS, now, beforePage);
    await sweepGrants('expiring', now, now + GRANT_EXPIRING_LEAD_MS - GRANT_SWEEP_SETTLE_MS, now, beforePage);
  }

  /** One expiry sweep over the grants that expire after `after` and at or before `until`, resuming at its position. */
  async function sweepGrants(
    sweep: GrantSweep,
    after: number,
    until: number,
    now: number,
    beforePage?: () => Promise<void>
  ) {
    const stored = await findSweepCursor(sweep);
    let cursor = stored ? (stored.cursor ?? null) : undefined;
    const yielded = () => {
      // Another run moved the position from where this one read it; it carries the sweep on.
      deps.metrics.track('grant.sweep_yielded', { sweep });
    };
    // Reading pages again is bounded per run too; a recheck that runs out stores where it stopped.
    const budget = { recheck: GRANT_SWEEP_RUN_LIMIT, beforePage };
    const storedPosition = parseSweepPosition(cursor);
    if (storedPosition?.recheck) {
      // A run stopped (or ran out) while reading a page it passed again: this one finishes that first.
      const checked = await recheckPage(sweep, cursor!, storedPosition.recheck, storedPosition, new Set(), now, budget);
      if (checked === null) {
        return yielded();
      }
      if (!checked.done) {
        return;
      }
      cursor = checked.cursor;
    }
    let position = laterPosition(storedPosition, toIsoString(new Date(after)));
    const end = toIsoString(new Date(until));
    for (let read = 0; read < GRANT_SWEEP_RUN_LIMIT && budget.recheck > 0; ) {
      await beforePage?.();
      const limit = Math.min(SWEEP_PAGE_SIZE, GRANT_SWEEP_RUN_LIMIT - read);
      const grants = await readGrantPage(position, { expiresAt: end, id: null }, limit);
      if (grants.length === 0) {
        return;
      }
      read += grants.length;
      await recordMissing(grants.filter((grant) => !grant.revokedAt).map((grant) => grantExpiryEvent(sweep, grant, now)));
      const last = grants[grants.length - 1]!;
      // The stored position keeps the page's range until it is read again, so a stop before that leaves it to
      // the next run.
      const moved = JSON.stringify({ expiresAt: last.expiresAt, id: last.id, recheck: position });
      if (!(await moveSweepCursor(sweep, cursor, moved))) {
        return yielded();
      }
      const ids = new Set(grants.map((grant) => grant.id));
      const checked = await recheckPage(sweep, moved, position, last, ids, now, budget);
      if (checked === null) {
        return yielded();
      }
      if (!checked.done) {
        return;
      }
      cursor = checked.cursor;
      position = { expiresAt: last.expiresAt, id: last.id };
      if (grants.length < limit) {
        return;
      }
    }
  }

  /**
   * Once the stored position (`cursor`) moved from `from` to `to`, reads that range again and records the events
   * of the grants not in `read` that became visible after the page was read (a write landing late), which a
   * creation that read the position before it moved left to the sweep; then stores `to` alone (`done`). It reads
   * at most `budget.recheck` grants, running `budget.beforePage` before each page; with more left it stores where
   * it stopped as the position's `recheck` for the next run. Null when another run moved the position first.
   */
  async function recheckPage(
    sweep: GrantSweep,
    cursor: string,
    from: SweepPosition,
    to: { expiresAt: string; id: string },
    read: Set<string>,
    now: number,
    budget: { recheck: number; beforePage?: () => Promise<void> }
  ): Promise<{ cursor: string; done: boolean } | null> {
    for (let position = from; ; ) {
      await budget.beforePage?.();
      const limit = Math.min(SWEEP_PAGE_SIZE, budget.recheck);
      const grants = await readGrantPage(position, to, limit);
      budget.recheck -= grants.length;
      const late = grants.filter(
        (grant) => !read.has(grant.id) && !grant.revokedAt && (sweep === 'expired' || Date.parse(grant.expiresAt) > now)
      );
      await recordMissing(late.map((grant) => grantExpiryEvent(sweep, grant, now)));
      const last = grants.at(-1);
      if (!last || grants.length < limit || last.id === to.id) {
        break;
      }
      position = { expiresAt: last.expiresAt, id: last.id };
      if (budget.recheck <= 0) {
        const paused = JSON.stringify({ expiresAt: to.expiresAt, id: to.id, recheck: position });
        return (await moveSweepCursor(sweep, cursor, paused)) ? { cursor: paused, done: false } : null;
      }
    }
    const checked = JSON.stringify({ expiresAt: to.expiresAt, id: to.id });
    return (await moveSweepCursor(sweep, cursor, checked)) ? { cursor: checked, done: true } : null;
  }

  /**
   * Records the expiry events a sweep would have recorded for a grant whose stored position already passed it,
   * so a grant whose write became visible only after a sweep read past its expiry (a write landing late, or from
   * an instance whose clock is behind) still gets them: `entitlement.changed` (cause `grant.expired`) once the
   * `expired` position passed it, within the lookback, and `grant.expiring` once the `expiring` position passed
   * it, before it expires. Run once a grant's creation is recorded and the grant is visible (after its
   * transaction commits; without transactions its `eventsPending` stays until this succeeds); the grant is read
   * again before each row, so a revoked one gets none. Each event is recorded once, also when the sweep's re-read
   * (`recheckPage`) records it too. `beforeWrite` runs before each row (a job's lease check).
   */
  async function recordPassedGrantExpiry(grant: ExpiringGrant, beforeWrite?: () => Promise<void>) {
    if (!handler) {
      return;
    }
    const rows = await deps.db.findMany<{ id: string; cursor?: string | null }>({
      model: CURSORS_TABLE,
      where: [{ field: 'id', operator: 'in', value: [sweepCursorId('expired'), sweepCursorId('expiring')] }],
      namespace: deps.namespace
    });
    const passed = (sweep: GrantSweep) => {
      const position = parseSweepPosition(rows.find((row) => row.id === sweepCursorId(sweep))?.cursor);
      return position !== null && !isAfter(grant, position);
    };
    const now = deps.now().getTime();
    const expiresAt = Date.parse(grant.expiresAt);
    const events = [
      ...(passed('expired') && expiresAt > now - GRANT_EXPIRED_LOOKBACK_MS ? [grantExpiryEvent('expired', grant, now)] : []),
      ...(passed('expiring') && expiresAt > now ? [grantExpiryEvent('expiring', grant, now)] : [])
    ];
    await recordForUnrevokedGrant(events, grant.id, deps.db, beforeWrite);
  }

  /**
   * The next grants after `position`, up to `until` (with a null id: every grant expiring at its time), in
   * (`expiresAt`, `id`) order: the rest of the grants expiring at the position's time, the later ones, then those
   * at `until`'s time up to its id (each query one range of the expiry index).
   */
  async function readGrantPage(position: SweepPosition, until: SweepPosition, limit: number) {
    const grants: BillFnEntitlementGrant[] = [];
    const read = async (where: WhereClause[], orderBy: { field: string; direction: 'asc' }[]) => {
      if (grants.length < limit) {
        grants.push(
          ...(await deps.db.findMany<BillFnEntitlementGrant>({
            model: GRANTS_TABLE,
            where,
            orderBy,
            limit: limit - grants.length,
            namespace: deps.namespace
          }))
        );
      }
    };
    const byId = [{ field: 'id', direction: 'asc' as const }];
    const upToId = (expiresAt: string): WhereClause[] =>
      until.id !== null && until.expiresAt === expiresAt ? [{ field: 'id', operator: 'lte', value: until.id }] : [];
    if (position.id !== null) {
      await read(
        [
          { field: 'expiresAt', operator: 'eq', value: position.expiresAt },
          { field: 'expiresAt', operator: 'lte', value: until.expiresAt },
          { field: 'id', operator: 'gt', value: position.id },
          ...upToId(position.expiresAt)
        ],
        byId
      );
    }
    await read(
      [
        { field: 'expiresAt', operator: 'gt', value: position.expiresAt },
        { field: 'expiresAt', operator: until.id === null ? 'lte' : 'lt', value: until.expiresAt }
      ],
      [{ field: 'expiresAt', direction: 'asc' }, ...byId]
    );
    if (until.id !== null && until.expiresAt > position.expiresAt) {
      await read([{ field: 'expiresAt', operator: 'eq', value: until.expiresAt }, ...upToId(until.expiresAt)], byId);
    }
    return grants;
  }

  /** Records the events that are not stored yet, checking them with one query (at most `SWEEP_PAGE_SIZE` ids). */
  async function recordMissing(events: LifecycleEventInput[]) {
    if (events.length === 0) {
      return;
    }
    const stored = await deps.db.findMany<{ id: string }>({
      model: EVENTS_TABLE,
      where: [{ field: 'id', operator: 'in', value: events.map((event) => event.id) }],
      namespace: deps.namespace
    });
    const storedIds = new Set(stored.map((event) => event.id));
    await record(events.filter((event) => !storedIds.has(event.id)));
  }

  function findSweepCursor(sweep: GrantSweep) {
    return deps.db.findOne<{ id: string; cursor?: string | null }>({
      model: CURSORS_TABLE,
      where: [{ field: 'id', operator: 'eq', value: sweepCursorId(sweep) }],
      namespace: deps.namespace
    });
  }

  /**
   * Moves the sweep's stored position from `previous` (undefined: none stored) to `next`, a compare-and-set;
   * false when another run moved or created it first.
   */
  async function moveSweepCursor(sweep: GrantSweep, previous: string | null | undefined, next: string) {
    const updatedAt = toIsoString(deps.now());
    if (previous !== undefined) {
      const moved = await deps.db.updateMany({
        model: CURSORS_TABLE,
        where: [
          { field: 'id', operator: 'eq', value: sweepCursorId(sweep) },
          { field: 'cursor', operator: 'eq', value: previous }
        ],
        data: { cursor: next, updatedAt },
        namespace: deps.namespace
      });
      return moved === 1;
    }
    try {
      await deps.db.create({
        model: CURSORS_TABLE,
        data: { id: sweepCursorId(sweep), provider: 'billfn', cursorKey: `lifecycle.grant-${sweep}`, cursor: next, updatedAt },
        namespace: deps.namespace
      });
      return true;
    } catch (error) {
      if (!deps.isDuplicateRecordError(error)) {
        throw error;
      }
      return false;
    }
  }

  function list(input: BillFnListEventsRequest = {}) {
    const where: WhereClause[] = [];
    if (input.status) {
      where.push({ field: 'status', operator: 'eq', value: input.status });
    }
    if (input.billingAccountId) {
      where.push({ field: 'billingAccountId', operator: 'eq', value: input.billingAccountId });
    }
    return deps.db.findMany<BillFnLifecycleEventRecord>({
      model: EVENTS_TABLE,
      where,
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
      limit: readLimit(input.limit),
      namespace: deps.namespace
    });
  }

  function findEvent(id: string, db: Adapter = deps.db) {
    return db.findOne<BillFnLifecycleEventRecord>({
      model: EVENTS_TABLE,
      where: [{ field: 'id', operator: 'eq', value: id }],
      namespace: deps.namespace
    });
  }

  return {
    /** Whether events are recorded at all: only with an `onEvent` handler. */
    enabled: Boolean(handler),
    record,
    recordForUnrevokedGrant,
    recordPassedGrantExpiry,
    stage,
    promote,
    confirm,
    deliverAfter,
    dispatch,
    recordGrantExpiry,
    list
  };
}

type GrantSweep = 'expired' | 'expiring';

/** The fields of a grant its expiry events derive from. */
export type ExpiringGrant = Pick<BillFnEntitlementGrant, 'id' | 'billingAccountId' | 'kind' | 'planKey' | 'expiresAt'>;

/** A sweep position: after the grants that expire before `expiresAt`, and those at it up to `id` (null: all). */
type SweepPosition = { expiresAt: string; id: string | null };

/** A stored position; `recheck`: where the page it last passed started, until that page is read again. */
type StoredSweepPosition = { expiresAt: string; id: string; recheck?: SweepPosition };

function sweepCursorId(sweep: GrantSweep) {
  return `rcc_billfn_lifecycle_grant_${sweep}`;
}

/** A stored position, or null when none is stored or it cannot be read (the sweep then starts at its window). */
function parseSweepPosition(cursor: string | null | undefined): StoredSweepPosition | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(cursor) as { expiresAt?: unknown; id?: unknown; recheck?: { expiresAt?: unknown; id?: unknown } };
    if (typeof parsed.expiresAt !== 'string' || typeof parsed.id !== 'string') {
      return null;
    }
    const { recheck } = parsed;
    return {
      expiresAt: parsed.expiresAt,
      id: parsed.id,
      ...(recheck && typeof recheck.expiresAt === 'string' && (recheck.id === null || typeof recheck.id === 'string')
        ? { recheck: { expiresAt: recheck.expiresAt, id: recheck.id } }
        : {})
    };
  } catch {
    return null;
  }
}

/** Whether the grant comes after the position in (`expiresAt`, `id`) order, so a sweep at it has not read it. */
function isAfter(grant: { expiresAt: string; id: string }, position: SweepPosition) {
  return (
    grant.expiresAt > position.expiresAt ||
    (grant.expiresAt === position.expiresAt && position.id !== null && grant.id > position.id)
  );
}

/** The stored position, or the window's start (after every grant that expires at or before `after`) when later. */
function laterPosition(stored: SweepPosition | null, after: string): SweepPosition {
  return stored && stored.expiresAt > after ? stored : { expiresAt: after, id: null };
}

function grantExpiryEvent(sweep: GrantSweep, grant: ExpiringGrant, now: number): LifecycleEventInput {
  const base = { billingAccountId: grant.billingAccountId };
  if (sweep === 'expiring') {
    return grantExpiringEvent({
      ...base,
      occurredAt: toIsoString(new Date(now)),
      grantId: grant.id,
      kind: grant.kind,
      planKey: grant.planKey,
      expiresAt: grant.expiresAt
    });
  }
  return grantEntitlementChange({ ...base, occurredAt: grant.expiresAt }, 'grant.expired', grant.id, grant.planKey, 'inactive');
}

/** 30 seconds, doubling per attempt, at most an hour. */
function retryDelay(attempt: number) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 20), RETRY_MAX_MS);
}

function readLimit(limit: number | undefined) {
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : DEFAULT_LIMIT;
}

type DeliveryOutcome = keyof BillFnDispatchEventsResult;

/**
 * Calls the handler once with the event, bounded by the claim lease: a handler that throws, rejects or does not
 * settle within the lease is a failed attempt. Returns its failure, or null when it succeeded.
 */
async function callHandler(handler: BillFnLifecycleEventHandler, row: BillFnLifecycleEventRecord, attempt: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handler({
        id: row.id,
        type: row.type,
        billingAccountId: row.billingAccountId,
        occurredAt: row.occurredAt,
        data: row.data,
        attempt
      } as BillFnLifecycleEvent),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('handler did not settle within the claim lease')), LIFECYCLE_CLAIM_LEASE_MS);
      })
    ]);
    return null;
  } catch (error) {
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message || error.name : String(error);
  return message.slice(0, 1000) || 'handler failed';
}
