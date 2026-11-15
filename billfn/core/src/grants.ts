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
}

/** A grant as stored: its status is derived on every read. */
type GrantRecord = Omit<BillFnEntitlementGrant, 'status'>;

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
 * Records the account's grant events an interrupted call left unrecorded. Without transactions a grant change
 * commits before its billing event, and a failed event write undoes it (see `commitWithEvent`); when the process
 * stops or the undo fails in between, the change stays without its event. Every grant create and revoke calls this first,
 * before it checks the expiry or reads the grant it acts on: whatever that request then does, the account's
 * earlier creations and revocations, also of grants that have since expired or been revoked, have their events.
 * The events' ids derive from the grant, so a recorded event is kept and none is written twice. With
 * transactions each change commits with its event and there is nothing to repair.
 */
export async function repairGrantEvents(deps: GrantDeps, billingAccountId: string) {
  if (deps.db.capabilities.transactions.supported) {
    return;
  }
  for (const grant of await listGrants(deps, billingAccountId)) {
    await deps.recordBillingEvent(grantCreatedEvent(grant));
    if (grant.revokedAt) {
      await deps.recordBillingEvent(grantRevokedEvent(grant));
    }
  }
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
      updatedAt: timestamp
    };
    try {
      await commitWithEvent(
        deps,
        grantCreatedEvent(record),
        async (db) => {
          await db.create({ model: GRANTS_TABLE, data: record, namespace: deps.namespace });
          return true;
        },
        () => deps.db.deleteMany({ model: GRANTS_TABLE, where: unchanged(record), namespace: deps.namespace })
      );
    } catch (error) {
      if (!deps.isDuplicateRecordError(error)) {
        throw error;
      }
      const existing = await findGrant(deps, billingAccountId, record.id);
      if (existing) {
        await deps.recordBillingEvent(grantCreatedEvent(existing));
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
      await deps.recordBillingEvent(grantRevokedEvent(existing));
      return withStatus(existing, deps.now());
    }
    const now = deps.now();
    const revoked: GrantRecord = {
      ...existing,
      revokedAt: toIsoString(now),
      revokedBy: operator,
      revokeReason: reason,
      // Strictly later than the stored time, so a racing revoke's compare-and-set on it fails.
      updatedAt: laterThan(now, existing.updatedAt)
    };
    const applied = await commitWithEvent(
      deps,
      grantRevokedEvent(revoked),
      async (db) => {
        const updated = await db.updateMany({
          model: GRANTS_TABLE,
          where: unchanged(existing),
          data: {
            revokedAt: revoked.revokedAt,
            revokedBy: revoked.revokedBy,
            revokeReason: revoked.revokeReason,
            updatedAt: revoked.updatedAt
          },
          namespace: deps.namespace
        });
        return updated === 1;
      },
      () =>
        deps.db.updateMany({
          model: GRANTS_TABLE,
          where: unchanged(revoked),
          data: { revokedAt: null, revokedBy: null, revokeReason: null, updatedAt: laterThan(deps.now(), revoked.updatedAt) },
          namespace: deps.namespace
        })
    );
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
 * in one transaction, so a failed event write leaves no grant change. Without
 * transactions (Drizzle SQLite) the change commits first, and a failed event
 * write runs `undo` (a compare-and-set on the changed grant) and fails, so a
 * failed request has changed nothing and its retry applies it; an event the
 * failed write stored anyway makes the change stand and the request succeed. A
 * change left by a stopped process or a failed undo keeps its event id, derived
 * from the grant, and the account's next grant create or revoke records the
 * event once (`repairGrantEvents`). Returns whether `write` applied the change;
 * an unapplied change records no event.
 */
async function commitWithEvent(
  deps: GrantDeps,
  event: BillFnBillingEvent,
  write: (db: Adapter) => Promise<boolean>,
  undo: () => Promise<unknown>
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
  try {
    await deps.recordBillingEvent(event);
  } catch (error) {
    if (await keepRecordedChange(deps, event.id, undo)) {
      return true;
    }
    throw error;
  }
  return true;
}

/**
 * After a failed event write without transactions: true when the write stored the event anyway, so the change
 * stands; otherwise undoes the change and returns false.
 */
async function keepRecordedChange(deps: GrantDeps, eventId: string, undo: () => Promise<unknown>) {
  try {
    const stored = await deps.db.findOne({
      model: BILLING_EVENTS_TABLE,
      where: [{ field: 'id', operator: 'eq', value: eventId }],
      namespace: deps.namespace
    });
    if (stored) {
      return true;
    }
    await undo();
  } catch {
    // The change stays without its event; the account's next grant create or revoke records it (`repairGrantEvents`).
  }
  return false;
}

/** Matches the grant only while it is as given: its `updatedAt` changes with every write. */
function unchanged(grant: GrantRecord) {
  return [
    { field: 'id', operator: 'eq' as const, value: grant.id },
    { field: 'updatedAt', operator: 'eq' as const, value: grant.updatedAt }
  ];
}

/** The account's grants, newest first, with their derived status. */
export async function listGrants(deps: GrantDeps, billingAccountId: string): Promise<BillFnEntitlementGrant[]> {
  const records = await deps.db.findMany<GrantRecord>({
    model: GRANTS_TABLE,
    where: [{ field: 'billingAccountId', operator: 'eq', value: billingAccountId }],
    orderBy: [{ field: 'createdAt', direction: 'desc' }],
    namespace: deps.namespace
  });
  const now = deps.now();
  return records
    .map((record) => withStatus(record, now))
    .sort((left, right) => compareTimes(right.createdAt, left.createdAt) || right.id.localeCompare(left.id));
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

function withStatus(record: GrantRecord, now: Date): BillFnEntitlementGrant {
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
