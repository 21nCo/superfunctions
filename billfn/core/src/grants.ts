import type { Adapter } from '@superfunctions/db';
import type { MetricsEmitter } from '@superfunctions/metrics';
import { createBillFnError } from './errors.js';
import { resolvePlan, toIsoString } from './helpers.js';
import type {
  BillFnBillingEvent,
  BillFnCatalog,
  BillFnCreateGrantRequest,
  BillFnEntitlementGrant,
  BillFnEntitlementGrantKind,
  BillFnEntitlementSnapshot,
  BillFnOperator,
  BillFnRevokeGrantRequest
} from './types.js';

const GRANTS_TABLE = 'entitlementGrants';
const GRANT_KINDS = new Set<BillFnEntitlementGrantKind>(['trial', 'comp']);
const REVOKE_ATTEMPTS = 3;

/** The service dependencies grants use; the billing event and duplicate-key helpers are the service's own. */
export interface GrantDeps {
  db: Adapter;
  namespace: string;
  catalog: BillFnCatalog;
  now: () => Date;
  generateId: (prefix: string) => string;
  metrics: MetricsEmitter;
  recordBillingEvent(event: BillFnBillingEvent): Promise<void>;
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

/** Validates a grant request before any write, so a refused request creates no billing account. */
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
  if (expiresAt <= deps.now().getTime()) {
    throw validation('expiresAt must be in the future');
  }
  return {
    planKey: input.planKey,
    kind: input.kind,
    expiresAt: toIsoString(new Date(expiresAt)),
    operator: readOperator(input.operator),
    reason: readReason(input.reason)
  };
}

/**
 * Stores a grant. A trial's id is derived from its billing account, so the
 * unique id refuses a second trial even when two requests race; a comp is
 * refused while another comp of the account is active. A refused request
 * records the existing grant's creation event if an interrupted call left it
 * unrecorded.
 */
export async function insertGrant(deps: GrantDeps, billingAccountId: string, input: GrantCreateInput) {
  const timestamp = toIsoString(deps.now());
  if (input.kind === 'comp') {
    const activeComp = (await listGrants(deps, billingAccountId)).find(
      (grant) => grant.kind === 'comp' && grant.status === 'active'
    );
    if (activeComp) {
      await deps.recordBillingEvent(grantCreatedEvent(activeComp));
      throw conflict('An active comp already exists for this billing account', 'active_comp_exists', activeComp.id);
    }
  }
  const record: GrantRecord = {
    id: input.kind === 'trial' ? trialGrantId(billingAccountId) : deps.generateId('grant'),
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
    await deps.db.create({ model: GRANTS_TABLE, data: record, namespace: deps.namespace });
  } catch (error) {
    if (!deps.isDuplicateRecordError(error) || input.kind !== 'trial') {
      throw error;
    }
    const existing = await findGrant(deps, billingAccountId, record.id);
    if (existing) {
      await deps.recordBillingEvent(grantCreatedEvent(existing));
    }
    throw conflict('A trial was already granted to this billing account', 'trial_already_granted', record.id);
  }
  await deps.recordBillingEvent(grantCreatedEvent(record));
  deps.metrics.track('grant.created', { kind: record.kind });
  return withStatus(record, deps.now());
}

/** Revokes a comp. A revoked comp is returned unchanged; a racing revoke is applied once. */
export async function revokeGrant(deps: GrantDeps, input: BillFnRevokeGrantRequest) {
  if (typeof input.billingAccountId !== 'string' || input.billingAccountId.length === 0) {
    throw validation('billingAccountId must be a non-empty string');
  }
  if (typeof input.grantId !== 'string' || input.grantId.length === 0) {
    throw validation('grantId must be a non-empty string');
  }
  const operator = readOperator(input.operator);
  const reason = readReason(input.reason);
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
    const updated = await deps.db.updateMany({
      model: GRANTS_TABLE,
      where: [
        { field: 'id', operator: 'eq', value: existing.id },
        { field: 'updatedAt', operator: 'eq', value: existing.updatedAt }
      ],
      data: {
        revokedAt: revoked.revokedAt,
        revokedBy: revoked.revokedBy,
        revokeReason: revoked.revokeReason,
        updatedAt: revoked.updatedAt
      },
      namespace: deps.namespace
    });
    if (updated === 1) {
      await deps.recordBillingEvent(grantRevokedEvent(revoked));
      deps.metrics.track('grant.revoked', { kind: revoked.kind });
      return withStatus(revoked, now);
    }
  }
  throw createBillFnError({ code: 'BILLFN_CONFLICT', message: 'Unable to revoke the grant after multiple retries' });
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
