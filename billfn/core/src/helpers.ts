import { randomBytes } from 'node:crypto';
import { createBillFnError } from './errors.js';
import type {
  BillFnCatalog,
  BillFnPlanDefinition,
  BillFnPriceDefinition,
  BillableSubject,
  BillingAccountResolver,
  BillingOwnerType
} from './types.js';

export function normalizeBasePath(basePath: string | undefined, fallback: string): string {
  const raw = (basePath ?? fallback).trim();
  if (!raw) {
    return fallback;
  }
  return raw.startsWith('/') ? raw.replace(/\/$/, '') : `/${raw.replace(/\/$/, '')}`;
}

export function toIsoString(value: Date): string {
  return value.toISOString();
}

export function defaultIdFactory(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

export function createDefaultBillingAccountResolver(): BillingAccountResolver {
  return {
    async resolve(input) {
      const organizationId = input.organizationId ?? input.tenantId;
      if (organizationId) {
        return {
          billingAccountId: buildBillingAccountId('organization', organizationId),
          ownerType: 'organization',
          ownerId: organizationId
        };
      }

      const userId = input.principalId ?? input.actorId;
      if (!userId) {
        return null;
      }

      return {
        billingAccountId: buildBillingAccountId('user', userId),
        ownerType: 'user',
        ownerId: userId
      };
    }
  };
}

export function buildBillingAccountId(ownerType: BillingOwnerType, ownerId: string): string {
  return `ba_${ownerType}_${ownerId}`;
}

export function resolvePlan(catalog: BillFnCatalog, planKey: string): BillFnPlanDefinition | undefined {
  return catalog.plans.find((plan) => plan.planKey === planKey);
}

/** Whether a catalog price carries an `eligibility` tag, so only an approving host hook may sell it. */
export function isRestrictedPrice(price: BillFnPriceDefinition): boolean {
  return price.eligibility !== undefined && price.eligibility !== null;
}

/**
 * The plan's default price for a provider and optional interval: its first
 * matching price without an `eligibility` tag, so a discount listed first is
 * never sold by default.
 */
export function resolvePrice(
  plan: BillFnPlanDefinition,
  provider: BillFnPriceDefinition['provider'],
  interval: BillFnPriceDefinition['interval'] | undefined
): BillFnPriceDefinition | undefined {
  return plan.prices.find(
    (price) =>
      price.provider === provider &&
      (interval === undefined || price.interval === interval) &&
      !isRestrictedPrice(price)
  );
}

export function getSubjectFromQuery(url: URL): BillableSubject {
  const actorId = url.searchParams.get('actorId') ?? undefined;
  const principalId = url.searchParams.get('principalId') ?? undefined;
  const tenantId = url.searchParams.get('tenantId') ?? undefined;
  const organizationId = url.searchParams.get('organizationId') ?? undefined;
  const actorType = url.searchParams.get('actorType') as BillableSubject['actorType'] | null;

  return {
    actorId,
    actorType: actorType ?? undefined,
    principalId,
    tenantId,
    organizationId
  };
}

export interface RequestSubjectAuth {
  resolveSubject?: (request: Request) => Promise<BillableSubject | null> | BillableSubject | null;
  allowClientSubject?: boolean;
}

/**
 * The subject a router request acts for. With `auth.resolveSubject`, only its
 * result counts. Without it, a body or query-string subject is used only when
 * the host opted in with `auth.allowClientSubject`; otherwise the request is
 * refused, because any caller could name any account.
 */
export async function resolveRequestSubject(
  request: Request,
  auth: RequestSubjectAuth | undefined,
  bodySubject?: BillableSubject
): Promise<BillableSubject> {
  if (auth?.resolveSubject) {
    const resolved = await auth.resolveSubject(request);
    if (resolved && hasSomeSubjectField(resolved)) {
      return resolved;
    }
    return {};
  }

  if (auth?.allowClientSubject !== true) {
    throw createBillFnError({
      code: 'BILLFN_UNAUTHENTICATED',
      message: 'BillFn subject routes need auth.resolveSubject, or auth.allowClientSubject for trusted callers'
    });
  }

  if (bodySubject && hasSomeSubjectField(bodySubject)) {
    return bodySubject;
  }

  const fromQuery = getSubjectFromQuery(new URL(request.url));
  if (hasSomeSubjectField(fromQuery)) {
    return fromQuery;
  }

  return {};
}

export function hasSomeSubjectField(subject: BillableSubject): boolean {
  return Boolean(
    subject.actorId ||
    subject.principalId ||
    subject.organizationId ||
    subject.tenantId
  );
}

export function decodeJwtPayload<T extends Record<string, unknown>>(token: string): T | null {
  const parts = token.split('.');
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return JSON.parse(decoded) as T;
  } catch {
    return null;
  }
}
