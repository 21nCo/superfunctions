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
const RETRY_BASE_MS = 30 * 1000;
const RETRY_MAX_MS = HOUR_MS;
/** `grant.expiring` is recorded once a grant expires within this long. */
export const GRANT_EXPIRING_LEAD_MS = 3 * DAY_MS;
/** How far back the sweep looks for grants that expired, to record their `entitlement.changed`. */
export const GRANT_EXPIRED_LOOKBACK_MS = 7 * DAY_MS;
const DEFAULT_LIMIT = 100;
const SWEEP_PAGE_SIZE = 200;

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
}

export type LifecycleEvents = ReturnType<typeof createLifecycleEvents>;

/** The stable id of the event of `type` that `key` identifies. */
export function lifecycleEventId(type: BillFnLifecycleEventType, key: string) {
  return `lce_${createHash('sha256').update(`${type}\n${key}`).digest('base64url').slice(0, 32)}`;
}

/** The lifecycle events a grant billing event stands for, derived from it alone so a repair records the same ones. */
export function grantLifecycleEvents(event: {
  billingAccountId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}): LifecycleEventInput[] {
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
      grantEntitlementChange(base, 'grant.started', grantId!, planKey!, kind === 'trial' ? 'trialing' : 'active')
    ];
  }
  if (event.type === 'billfn.grant.revoked') {
    return [grantEntitlementChange(base, 'grant.revoked', grantId!, planKey!, 'inactive')];
  }
  return [];
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
 * lapses. A handler failure schedules the next attempt with exponential backoff
 * until 24 hours after the event was recorded; a failure after that marks it
 * `failed`, where `list({ status: 'failed' })` shows it.
 */
export function createLifecycleEvents(deps: LifecycleDeps) {
  const handler = deps.onEvent;
  /** Events recorded since the last `flush`, delivered by it. */
  const recorded = new Set<string>();

  /**
   * Stores the events through `db` (a transaction, when given) unless already
   * stored. Without an `onEvent` handler nothing is recorded.
   */
  async function record(events: LifecycleEventInput[], db: Adapter = deps.db) {
    if (!handler) {
      return;
    }
    for (const event of events) {
      // Checked first: inside a Postgres transaction a duplicate-key error would abort it.
      const existing = await db.findOne<{ id: string }>({
        model: EVENTS_TABLE,
        where: [{ field: 'id', operator: 'eq', value: event.id }],
        namespace: deps.namespace
      });
      if (!existing) {
        const timestamp = toIsoString(deps.now());
        const row: BillFnLifecycleEventRecord = {
          ...event,
          data: event.data as Record<string, unknown>,
          status: 'pending',
          attempts: 0,
          nextAttemptAt: timestamp,
          claimId: null,
          lastError: null,
          deliveredAt: null,
          failedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        try {
          await db.create({ model: EVENTS_TABLE, data: row, namespace: deps.namespace });
          deps.metrics.track('event.recorded', { type: event.type });
        } catch (error) {
          if (!deps.isDuplicateRecordError(error)) {
            throw error;
          }
        }
      }
      recorded.add(event.id);
    }
  }

  /**
   * Delivers the events recorded since the last flush that are due. Never
   * throws: an event it cannot deliver stays pending for a later dispatch.
   */
  async function flush() {
    if (recorded.size === 0) {
      return;
    }
    const ids = [...recorded];
    recorded.clear();
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

  /** Delivers the due events, oldest due first. */
  async function dispatch(input: BillFnDispatchEventsRequest = {}): Promise<BillFnDispatchEventsResult> {
    const result: BillFnDispatchEventsResult = { delivered: 0, retrying: 0, failed: 0 };
    if (!handler) {
      return result;
    }
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
      const outcome = await deliver(row);
      if (outcome) {
        result[outcome] += 1;
      }
    }
    return result;
  }

  /** Claims the event and calls the handler once; null when the event is not due or another dispatcher claimed it. */
  async function deliver(row: BillFnLifecycleEventRecord): Promise<keyof BillFnDispatchEventsResult | null> {
    const claimedAt = deps.now();
    if (!handler || row.status !== 'pending' || Date.parse(row.nextAttemptAt) > claimedAt.getTime()) {
      return null;
    }
    const claimId = deps.generateId('lcc');
    const attempt = row.attempts + 1;
    const claimed = await deps.db.updateMany({
      model: EVENTS_TABLE,
      where: [
        { field: 'id', operator: 'eq', value: row.id },
        { field: 'status', operator: 'eq', value: 'pending' },
        { field: 'nextAttemptAt', operator: 'eq', value: row.nextAttemptAt },
        { field: 'attempts', operator: 'eq', value: row.attempts }
      ],
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

    let failure: { error: unknown } | null = null;
    try {
      await handler({
        id: row.id,
        type: row.type,
        billingAccountId: row.billingAccountId,
        occurredAt: row.occurredAt,
        data: row.data,
        attempt
      } as BillFnLifecycleEvent);
    } catch (error) {
      failure = { error };
    }

    const finishedAt = deps.now();
    const timestamp = toIsoString(finishedAt);
    if (!failure) {
      await settle(row.id, claimId, { status: 'delivered', deliveredAt: timestamp, lastError: null, updatedAt: timestamp });
      deps.metrics.track('event.delivered', { type: row.type });
      return 'delivered';
    }
    const lastError = errorMessage(failure.error);
    const deadline = Date.parse(row.createdAt) + LIFECYCLE_DELIVERY_WINDOW_MS;
    if (!Number.isFinite(deadline) || finishedAt.getTime() >= deadline) {
      await settle(row.id, claimId, { status: 'failed', failedAt: timestamp, lastError, updatedAt: timestamp });
      deps.metrics.track('event.failed', { type: row.type });
      return 'failed';
    }
    const retryAt = Math.min(finishedAt.getTime() + retryDelay(attempt), deadline);
    await settle(row.id, claimId, { nextAttemptAt: toIsoString(new Date(retryAt)), lastError, updatedAt: timestamp });
    deps.metrics.track('event.retry_scheduled', { type: row.type });
    return 'retrying';
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
   * Records `grant.expiring` for each grant that is not revoked and expires
   * within 3 days, and `entitlement.changed` (cause `grant.expired`) for each
   * that expired in the last 7 days. Both are recorded once per grant.
   */
  async function recordGrantExpiry() {
    if (!handler) {
      return;
    }
    const now = deps.now().getTime();
    const where: WhereClause[] = [
      { field: 'expiresAt', operator: 'gt', value: toIsoString(new Date(now - GRANT_EXPIRED_LOOKBACK_MS)) },
      { field: 'expiresAt', operator: 'lte', value: toIsoString(new Date(now + GRANT_EXPIRING_LEAD_MS)) }
    ];
    for (let offset = 0; ; offset += SWEEP_PAGE_SIZE) {
      const grants = await deps.db.findMany<BillFnEntitlementGrant>({
        model: GRANTS_TABLE,
        where,
        orderBy: [
          { field: 'expiresAt', direction: 'asc' },
          { field: 'id', direction: 'asc' }
        ],
        limit: SWEEP_PAGE_SIZE,
        offset,
        namespace: deps.namespace
      });
      const events = grants.filter((grant) => !grant.revokedAt).map((grant) => grantExpiryEvent(grant, now));
      if (events.length > 0) {
        const stored = await deps.db.findMany<{ id: string }>({
          model: EVENTS_TABLE,
          where: [{ field: 'id', operator: 'in', value: events.map((event) => event.id) }],
          namespace: deps.namespace
        });
        const storedIds = new Set(stored.map((event) => event.id));
        await record(events.filter((event) => !storedIds.has(event.id)));
      }
      if (grants.length < SWEEP_PAGE_SIZE) {
        return;
      }
    }
  }

  async function list(input: BillFnListEventsRequest = {}) {
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

  function findEvent(id: string) {
    return deps.db.findOne<BillFnLifecycleEventRecord>({
      model: EVENTS_TABLE,
      where: [{ field: 'id', operator: 'eq', value: id }],
      namespace: deps.namespace
    });
  }

  return { record, flush, dispatch, recordGrantExpiry, list };
}

function grantExpiryEvent(grant: BillFnEntitlementGrant, now: number): LifecycleEventInput {
  const base = { billingAccountId: grant.billingAccountId };
  if (Date.parse(grant.expiresAt) > now) {
    return {
      ...base,
      id: lifecycleEventId('grant.expiring', grant.id),
      type: 'grant.expiring',
      occurredAt: toIsoString(new Date(now)),
      data: { grantId: grant.id, kind: grant.kind, planKey: grant.planKey, expiresAt: grant.expiresAt }
    };
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

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message || error.name : String(error);
  return message.slice(0, 1000) || 'handler failed';
}
