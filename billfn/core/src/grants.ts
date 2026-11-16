import type { Adapter } from '@superfunctions/db';
import type { MetricsEmitter } from '@superfunctions/metrics';
import { createBillFnError } from './errors.js';
import { resolvePlan, toIsoString } from './helpers.js';
import type {
  BillFnBillingEvent,
  BillFnCatalog,
  BillFnCreateGrantRequest,
  BillFnEntitlementGrant,
  BillFnEntitlementGrantSummary,
  BillFnEntitlementGrantKind,
  BillFnEntitlementSnapshot,
  BillFnOperator,
  BillFnRevokeGrantRequest
} from './types.js';

const GRANTS_TABLE = 'entitlementGrants';
const BILLING_EVENTS_TABLE = 'billingEvents';
const GRANT_KINDS = new Set<BillFnEntitlementGrantKind>(['trial', 'comp']);
const REVOKE_ATTEMPTS = 3;
const CREATE_ATTEMPTS = 3;
/** The most grants with pending events one `lifecycle-events` job run repairs. */
export const GRANT_REPAIR_BATCH_SIZE = 50;

/** The service dependencies grants use; the billing event and duplicate-key helpers are the service's own. */
export interface GrantDeps {
  db: Adapter;
  namespace: string;
  catalog: BillFnCatalog;
  now: () => Date;
  metrics: MetricsEmitter;
  /** Records the event through `db` when given (a transaction), otherwise through the service's adapter. */
  recordBillingEvent(event: BillFnBillingEvent, db?: Adapter): Promise<void>;
  isDuplicateRecordError(error: unknown): boolean;
  /** Whether grant writes set `eventsPending` for the `lifecycle-events` job: with lifecycle events, without transactions. */
  flagsPendingEvents: boolean;
}

/**
 * A grant as stored: its status is derived on every read. Without transactions `eventsPending` is set by the
 * write of a create or revoke and cleared once that change's billing event is recorded (see `repairGrantEvents`).
 */
type GrantRecord = Omit<BillFnEntitlementGrant, 'status'> & { eventsPending?: boolean | null };

export type GrantCreateInput = {
  planKey: string;
  kind: BillFnEntitlementGrantKind;
  expiresAt: string;
  operator: BillFnOperator | null;
  reason: string | null;
};

/**
 * Validates a grant request before any write, so a refused request creates no billing account. The expiry's
 * position against now is checked separately (`requireFutureExpiry`), after `repairGrantEvents`.
 */
export function readCreateGrantInput(deps: GrantDeps, input: BillFnCreateGrantRequest): GrantCreateInput {
  if (typeof input.billingAccountId !== 'string' || input.billingAccountId.length === 0) {
    throw validation('billingAccountId must be a non-empty string');
  }
  if (!GRANT_KINDS.has(input.kind)) {
    throw validation("kind must be 'trial' or 'comp'");
  }
  if (typeof input.planKey !== 'string' || !resolvePlan(deps.catalog, input.planKey)) {
    throw createBillFnError({ code: 'BILLFN_NOT_FOUND', message: `Plan not found: ${String(input.planKey)}` });
  }
  const expiresAt = typeof input.expiresAt === 'string' ? Date.parse(input.expiresAt) : Number.NaN;
  if (!Number.isFinite(expiresAt)) {
    throw validation('expiresAt must be an ISO 8601 time');
  }
  return {
    planKey: input.planKey,
    kind: input.kind,
    expiresAt: toIsoString(new Date(expiresAt)),
    operator: readOperator(input.operator),
    reason: readReason(input.reason)
  };
}

/** Refuses a grant whose expiry is not after now. */
export function requireFutureExpiry(deps: GrantDeps, input: GrantCreateInput) {
  if (Date.parse(input.expiresAt) <= deps.now().getTime()) {
    throw validation('expiresAt must be in the future');
  }
}

/**
 * Records the account's grant events that are missing. Without transactions a grant change commits before its
 * billing event, and a change whose event write fails stands (see `commitWithEvent`). Every grant create and
 * revoke runs this first, before it checks the expiry or reads the grant it acts on, and every entitlements read
 * runs it through `listRepairedGrants`: whatever that request then does, the account's earlier creations and
 * revocations, also of grants that have since expired or been revoked, have their events. The events' ids and
 * payloads derive from the stored grant, so a recorded event is kept and none is written twice. With
 * transactions each change commits with its event and there is nothing to repair. Best effort: finding the
 * missing events and writing each one fail on their own, a failed write skips no other event, and a repair that
 * cannot write leaves the events to a later one and never fails the request. Pass the account's grants when
 * already read.
 */
export async function repairGrantEvents(deps: GrantDeps, billingAccountId: string, grants?: GrantRecord[]) {
  if (deps.db.capabilities.transactions.supported) {
    return;
  }
  let missing: BillFnBillingEvent[];
  let grantList: GrantRecord[];
  try {
    grantList = grants ?? (await listGrantRecords(deps, billingAccountId));
    const events = grantList.flatMap((grant) =>
      grant.revokedAt ? [grantCreatedEvent(grant), grantRevokedEvent(grant)] : [grantCreatedEvent(grant)]
    );
    if (events.length === 0) {
      return;
    }
    const recorded = await deps.db.findMany<{ id: string }>({
      model: BILLING_EVENTS_TABLE,
      where: [{ field: 'id', operator: 'in', value: events.map((event) => event.id) }],
      namespace: deps.namespace
    });
    const recordedIds = new Set(recorded.map((event) => event.id));
    missing = events.filter((candidate) => !recordedIds.has(candidate.id));
  } catch {
    deps.metrics.track('grant.event_deferred', { type: 'repair' });
    return;
  }
  const unrecorded = new Set<string>();
  for (const event of missing) {
    try {
      await deps.recordBillingEvent(event);
    } catch {
      unrecorded.add(event.payload.grantId as string);
      deps.metrics.track('grant.event_deferred', { type: event.type });
    }
  }
  for (const grant of grantList) {
    if (!unrecorded.has(grant.id)) {
      await clearEventsPending(deps, grant);
    }
  }
}

/**
 * Runs `repairGrantEvents` for the accounts of the oldest `GRANT_REPAIR_BATCH_SIZE` grants whose `eventsPending`
 * is set, so a committed grant change whose event write failed or was interrupted has its events recorded without
 * later traffic of that account, however long ago it was made. A change's flag is cleared once its events are
 * recorded, so the work of a run follows the changes that lack events, not all grants. It records only what
 * stored grants derive, under the same ids, so a change that never applied records nothing and a second run adds
 * nothing. `beforeEach` runs before each account (the job's lease check).
 */
export async function repairPendingGrantEvents(deps: GrantDeps, beforeEach?: () => Promise<void>) {
  if (!deps.flagsPendingEvents) {
    return;
  }
  const grants = await deps.db.findMany<GrantRecord>({
    model: GRANTS_TABLE,
    where: [{ field: 'eventsPending', operator: 'eq', value: true }],
    orderBy: [{ field: 'updatedAt', direction: 'asc' }],
    limit: GRANT_REPAIR_BATCH_SIZE,
    namespace: deps.namespace
  });
  for (const billingAccountId of new Set(grants.map((grant) => grant.billingAccountId))) {
    await beforeEach?.();
    await repairGrantEvents(deps, billingAccountId);
  }
}

/**
 * Clears a grant's `eventsPending` once the events of the change it was read with are recorded: a compare-and-set
 * on `updatedAt`, so a revoke written after the read keeps its flag. A failed clear leaves it to a later repair.
 */
async function clearEventsPending(deps: GrantDeps, grant: GrantRecord) {
  if (!grant.eventsPending) {
    return;
  }
  try {
    await deps.db.updateMany({
      model: GRANTS_TABLE,
      where: [
        { field: 'id', operator: 'eq', value: grant.id },
        { field: 'updatedAt', operator: 'eq', value: grant.updatedAt }
      ],
      data: { eventsPending: false },
      namespace: deps.namespace
    });
  } catch {
    deps.metrics.track('grant.event_deferred', { type: 'clear' });
  }
}

/**
 * The account's grants for an entitlements read: their missing events are repaired first (see
 * `repairGrantEvents`), and their status is derived after that, so a grant that ends during the repair reads
 * as ended.
 */
export async function listRepairedGrants(deps: GrantDeps, billingAccountId: string) {
  const grants = await listGrantRecords(deps, billingAccountId);
  await repairGrantEvents(deps, billingAccountId, grants);
  const now = deps.now();
  return grants.map((grant) => withStatus(grant, now));
}

/**
 * Stores a grant. A trial's id is derived from its billing account, so the
 * unique id refuses a second trial even when two requests race. Comps take
 * numbered ids (`grant_comp_<account>_<n>`): a comp is refused while the
 * latest one is active, and a new one claims the next number, so of two racing
 * comps the unique id stores one and refuses the other. The grant and its
 * creation event commit together (see `commitWithEvent`); without transactions
 * the caller runs `repairGrantEvents` first, and a request refused by a racing
 * grant records that grant's creation event.
 */
export async function insertGrant(deps: GrantDeps, billingAccountId: string, input: GrantCreateInput) {
  for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
    const id = input.kind === 'trial' ? trialGrantId(billingAccountId) : await nextCompId(deps, billingAccountId);
    const timestamp = toIsoString(deps.now());
    const record: GrantRecord = {
      id,
      billingAccountId,
      planKey: input.planKey,
      kind: input.kind,
      startsAt: timestamp,
      expiresAt: input.expiresAt,
      revokedAt: null,
      operator: input.operator,
      reason: input.reason,
      revokedBy: null,
      revokeReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...pendingFlag(deps)
    };
    try {
      await commitWithEvent(deps, record, grantCreatedEvent(record), async (db) => {
        await db.create({ model: GRANTS_TABLE, data: record, namespace: deps.namespace });
        return true;
      });
    } catch (error) {
      if (!deps.isDuplicateRecordError(error)) {
        throw error;
      }
      const existing = await findGrant(deps, billingAccountId, record.id);
      if (existing) {
        await recordCommittedEvent(deps, grantCreatedEvent(existing));
      }
      if (input.kind === 'trial') {
        throw conflict('A trial was already granted to this billing account', 'trial_already_granted', record.id);
      }
      // The comp that took this number is active, or (read stale) it ended and the next number is free.
      if (!existing || withStatus(existing, deps.now()).status === 'active') {
        throw activeCompExists(record.id);
      }
      continue;
    }
    deps.metrics.track('grant.created', { kind: record.kind });
    return withStatus(record, deps.now());
  }
  throw createBillFnError({ code: 'BILLFN_CONFLICT', message: 'Unable to create the grant after multiple retries' });
}

/**
 * The id of the account's next comp. Comp n is created only while comp n-1 is
 * not active, so the latest comp is the only one that can be active; while it
 * is, the account's active comp is refused.
 */
async function nextCompId(deps: GrantDeps, billingAccountId: string) {
  const prefix = compGrantIdPrefix(billingAccountId);
  let latest: BillFnEntitlementGrant | undefined;
  let latestNumber = 0;
  for (const grant of await listGrants(deps, billingAccountId)) {
    const number = grant.kind === 'comp' && grant.id.startsWith(prefix) ? Number(grant.id.slice(prefix.length)) : 0;
    if (Number.isSafeInteger(number) && number > latestNumber) {
      latest = grant;
      latestNumber = number;
    }
  }
  if (latest?.status === 'active') {
    throw activeCompExists(latest.id);
  }
  return `${prefix}${latestNumber + 1}`;
}

/**
 * Revokes a comp. A revoked comp is returned unchanged; a racing revoke is applied once. Without transactions the
 * account's unrecorded grant events are recorded first, also when the grant is then not found.
 */
export async function revokeGrant(deps: GrantDeps, input: BillFnRevokeGrantRequest) {
  if (typeof input.billingAccountId !== 'string' || input.billingAccountId.length === 0) {
    throw validation('billingAccountId must be a non-empty string');
  }
  if (typeof input.grantId !== 'string' || input.grantId.length === 0) {
    throw validation('grantId must be a non-empty string');
  }
  const operator = readOperator(input.operator);
  const reason = readReason(input.reason);
  await repairGrantEvents(deps, input.billingAccountId);
  for (let attempt = 0; attempt < REVOKE_ATTEMPTS; attempt += 1) {
    const existing = await findGrant(deps, input.billingAccountId, input.grantId);
    if (!existing) {
      throw createBillFnError({ code: 'BILLFN_NOT_FOUND', message: 'Grant not found' });
    }
    if (existing.kind !== 'comp') {
      throw createBillFnError({
        code: 'BILLFN_VALIDATION_ERROR',
        message: 'Only a comp grant can be revoked',
        details: { reason: 'grant_not_revocable' }
      });
    }
    if (existing.revokedAt) {
      await recordCommittedEvent(deps, grantRevokedEvent(existing));
      return withStatus(existing, deps.now());
    }
    const now = deps.now();
    const revoked: GrantRecord = {
      ...existing,
      ...pendingFlag(deps),
      revokedAt: toIsoString(now),
      revokedBy: operator,
      revokeReason: reason,
      // Strictly later than the stored time, so a racing revoke's compare-and-set on it fails.
      updatedAt: laterThan(now, existing.updatedAt)
    };
    const applied = await commitWithEvent(deps, revoked, grantRevokedEvent(revoked), async (db) => {
      const updated = await db.updateMany({
        model: GRANTS_TABLE,
        where: [
          { field: 'id', operator: 'eq', value: existing.id },
          { field: 'updatedAt', operator: 'eq', value: existing.updatedAt }
        ],
        data: {
          revokedAt: revoked.revokedAt,
          revokedBy: revoked.revokedBy,
          revokeReason: revoked.revokeReason,
          updatedAt: revoked.updatedAt,
          ...pendingFlag(deps)
        },
        namespace: deps.namespace
      });
      return updated === 1;
    });
    if (applied) {
      deps.metrics.track('grant.revoked', { kind: revoked.kind });
      return withStatus(revoked, now);
    }
  }
  throw createBillFnError({ code: 'BILLFN_CONFLICT', message: 'Unable to revoke the grant after multiple retries' });
}

/**
 * Applies a grant change and records its billing event. Where the adapter
 * supports transactions (memory, Prisma, Kysely, Drizzle Postgres) both commit
 * in one transaction, so a failed event write leaves no grant change and the
 * request fails. Without transactions (Drizzle SQLite) nothing can undo the
 * change safely, so the committed change is the outcome: the grant stores its
 * operator and reasons, a failed event write is retried once, and the request
 * succeeds. An event still unrecorded derives from the grant and is recorded
 * once by the account's next grant create or revoke or entitlements read
 * or a `lifecycle-events` job run (`repairGrantEvents`). Returns whether `write` applied the change; an
 * unapplied change records no event.
 */
async function commitWithEvent(
  deps: GrantDeps,
  grant: GrantRecord,
  event: BillFnBillingEvent,
  write: (db: Adapter) => Promise<boolean>
) {
  if (deps.db.capabilities.transactions.supported) {
    return deps.db.transaction(async (transaction) => {
      const db = transaction as unknown as Adapter;
      if (!(await write(db))) {
        return false;
      }
      await deps.recordBillingEvent(event, db);
      return true;
    });
  }
  if (!(await write(deps.db))) {
    return false;
  }
  if (await recordCommittedEvent(deps, event)) {
    await clearEventsPending(deps, grant);
  }
  return true;
}

/** The `eventsPending` a grant write sets (see `GrantDeps.flagsPendingEvents`). */
function pendingFlag(deps: GrantDeps): Pick<GrantRecord, 'eventsPending'> {
  return deps.flagsPendingEvents ? { eventsPending: true } : {};
}

/**
 * Records the event of a committed grant change: retried once, then left to `repairGrantEvents`. Never fails
 * the request, whose outcome is the committed change.
 */
async function recordCommittedEvent(deps: GrantDeps, event: BillFnBillingEvent) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.recordBillingEvent(event);
      return true;
    } catch {
      // Retried once, then deferred.
    }
  }
  deps.metrics.track('grant.event_deferred', { type: event.type });
  return false;
}

/** The account's grants, newest first, with their derived status. */
export async function listGrants(deps: GrantDeps, billingAccountId: string): Promise<BillFnEntitlementGrant[]> {
  const now = deps.now();
  return (await listGrantRecords(deps, billingAccountId)).map((record) => withStatus(record, now));
}

/** The account's grants as stored, newest first. */
async function listGrantRecords(deps: GrantDeps, billingAccountId: string) {
  const records = await deps.db.findMany<GrantRecord>({
    model: GRANTS_TABLE,
    where: [{ field: 'billingAccountId', operator: 'eq', value: billingAccountId }],
    orderBy: [{ field: 'createdAt', direction: 'desc' }],
    namespace: deps.namespace
  });
  return records.sort((left, right) => compareTimes(right.createdAt, left.createdAt) || right.id.localeCompare(left.id));
}

/** A grant as its billing subject sees it: without the operator, reasons or revoking operator. */
export function toGrantSummary(grant: BillFnEntitlementGrant): BillFnEntitlementGrantSummary {
  return {
    id: grant.id,
    kind: grant.kind,
    planKey: grant.planKey,
    status: grant.status,
    startsAt: grant.startsAt,
    expiresAt: grant.expiresAt,
    revokedAt: grant.revokedAt ?? null
  };
}

/**
 * The account's entitlements: the paid snapshot while it is not `inactive`
 * (paid supersedes a grant), otherwise the active grant's plan (`trialing` for
 * a trial, `active` for a comp) until the grant's expiry. Without an active
 * grant the paid snapshot stands; an account with ended grants and no paid
 * snapshot is `inactive` with no features or limits. Grants are read only when
 * the paid snapshot does not decide, unless the caller passes them.
 */
export async function applyGrants(
  deps: GrantDeps,
  billingAccountId: string,
  paid: BillFnEntitlementSnapshot | null,
  grants?: BillFnEntitlementGrant[]
): Promise<BillFnEntitlementSnapshot | null> {
  if (paid && paid.status !== 'inactive') {
    return paid;
  }
  const candidates = grants ?? (await listGrants(deps, billingAccountId));
  const active = selectActiveGrant(candidates);
  if (active) {
    const plan = resolvePlan(deps.catalog, active.planKey);
    return {
      id: paid?.id ?? `ent_${billingAccountId}`,
      billingAccountId,
      planKey: active.planKey,
      status: active.kind === 'trial' ? 'trialing' : 'active',
      // A plan removed from the catalog after the grant entitles nothing.
      features: { ...(plan?.features ?? {}) },
      limits: { ...(plan?.limits ?? {}) },
      effectiveAt: active.startsAt,
      expiresAt: active.expiresAt,
      sourceEventId: `grant:${active.id}`,
      grant: { id: active.id, kind: active.kind, expiresAt: active.expiresAt },
      createdAt: paid?.createdAt ?? active.createdAt,
      updatedAt: active.updatedAt
    };
  }
  if (paid || candidates.length === 0) {
    return paid;
  }
  const latest = candidates[0]!;
  return {
    id: `ent_${billingAccountId}`,
    billingAccountId,
    planKey: latest.planKey,
    status: 'inactive',
    features: {},
    limits: {},
    effectiveAt: latest.revokedAt ?? latest.expiresAt,
    expiresAt: latest.revokedAt ?? latest.expiresAt,
    sourceEventId: `grant:${latest.id}`,
    createdAt: latest.createdAt,
    updatedAt: latest.updatedAt
  };
}

/** A comp before a trial, then the later expiry; racing comps resolve the same way on every read. */
function selectActiveGrant(grants: BillFnEntitlementGrant[]) {
  return grants
    .filter((grant) => grant.status === 'active')
    .sort(
      (left, right) =>
        (left.kind === right.kind ? 0 : left.kind === 'comp' ? -1 : 1) ||
        compareTimes(right.expiresAt, left.expiresAt) ||
        left.id.localeCompare(right.id)
    )[0];
}

function withStatus({ eventsPending: _pending, ...record }: GrantRecord, now: Date): BillFnEntitlementGrant {
  const expiresAt = Date.parse(record.expiresAt);
  const status = record.revokedAt
    ? 'revoked'
    : Number.isFinite(expiresAt) && expiresAt > now.getTime()
      ? 'active'
      : 'expired';
  return { ...record, status };
}

async function findGrant(deps: GrantDeps, billingAccountId: string, grantId: string) {
  return deps.db.findOne<GrantRecord>({
    model: GRANTS_TABLE,
    where: [
      { field: 'id', operator: 'eq', value: grantId },
      { field: 'billingAccountId', operator: 'eq', value: billingAccountId }
    ],
    namespace: deps.namespace
  });
}

function trialGrantId(billingAccountId: string) {
  return `grant_trial_${billingAccountId}`;
}

function compGrantIdPrefix(billingAccountId: string) {
  return `grant_comp_${billingAccountId}_`;
}

function activeCompExists(grantId: string) {
  return conflict('An active comp already exists for this billing account', 'active_comp_exists', grantId);
}

function grantCreatedEvent(grant: GrantRecord): BillFnBillingEvent {
  return {
    id: `evt_grant_created_${grant.id}`,
    billingAccountId: grant.billingAccountId,
    type: 'billfn.grant.created',
    payload: {
      grantId: grant.id,
      kind: grant.kind,
      planKey: grant.planKey,
      startsAt: grant.startsAt,
      expiresAt: grant.expiresAt,
      operator: grant.operator ?? null,
      reason: grant.reason ?? null
    },
    createdAt: grant.createdAt
  };
}

function grantRevokedEvent(grant: GrantRecord): BillFnBillingEvent {
  return {
    id: `evt_grant_revoked_${grant.id}`,
    billingAccountId: grant.billingAccountId,
    type: 'billfn.grant.revoked',
    payload: {
      grantId: grant.id,
      kind: grant.kind,
      planKey: grant.planKey,
      operator: grant.revokedBy ?? null,
      reason: grant.revokeReason ?? null
    },
    createdAt: grant.revokedAt ?? grant.updatedAt
  };
}

function readOperator(operator: BillFnOperator | undefined): BillFnOperator | null {
  if (operator === undefined) {
    return null;
  }
  if (typeof operator !== 'object' || operator === null || typeof operator.id !== 'string' || operator.id.length === 0) {
    throw validation('operator.id must be a non-empty string');
  }
  return {
    id: operator.id,
    ...(typeof operator.type === 'string' ? { type: operator.type } : {}),
    ...(typeof operator.requestId === 'string' ? { requestId: operator.requestId } : {})
  };
}

function readReason(reason: string | undefined) {
  if (reason === undefined) {
    return null;
  }
  if (typeof reason !== 'string') {
    throw validation('reason must be a string');
  }
  return reason;
}

function laterThan(now: Date, previous: string) {
  const previousTime = Date.parse(previous);
  const time = Number.isFinite(previousTime) && now.getTime() <= previousTime ? previousTime + 1 : now.getTime();
  return toIsoString(new Date(time));
}

function compareTimes(left: string, right: string) {
  return (Date.parse(left) || 0) - (Date.parse(right) || 0);
}

function validation(message: string) {
  return createBillFnError({ code: 'BILLFN_VALIDATION_ERROR', message });
}

function conflict(message: string, reason: string, grantId: string) {
  return createBillFnError({ code: 'BILLFN_CONFLICT', message, details: { reason, grantId } });
}
