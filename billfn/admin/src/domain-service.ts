import type {
  BillableSubject,
  BillFnInstance,
  BillFnPlanDefinition,
  BillingProviderName,
} from "@billfn/core";
import {
  AdminError,
  decodeAdminCursor,
  encodeAdminCursor,
  normalizeAdminPageLimit,
  type AdminOperationContext,
  type AdminOperationResult,
} from "@superfunctions/admin";
import type { BillFnAdminListInput, BillFnAdminService } from "./index.js";

type JsonRecord = Record<string, unknown>;

function pageIdentity(operationId: string, input: BillFnAdminListInput): string {
  const filter = Object.entries(input.filter ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const sort = (input.sort ?? []).map((descriptor) => [descriptor.field ?? null, descriptor.direction ?? null]);
  return JSON.stringify([operationId, input.search?.trim().toLowerCase() ?? null, filter, sort]);
}

export interface BillFnDomainAdminServiceOptions {
  billfn: BillFnInstance;
  /** Resolves the billable subject only after Super Console scope authorization. */
  subject(context: AdminOperationContext): BillableSubject | Promise<BillableSubject>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new AdminError("invalid_argument", `${name} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : string(value, name);
}

function unwrap<T>(value: { ok: true; data: T } | { ok: false; error: { code: string; message: string; status: number; retryable: boolean; details?: unknown } }): T {
  if (value.ok) return value.data;
  throw new AdminError(adminCodeForStatus(value.error.status), value.error.message, {
    details: value.error.details,
    retryable: value.error.retryable,
  });
}

function adminCodeForStatus(status: number): "not_found" | "forbidden" | "conflict" | "dependency_unavailable" | "invalid_argument" {
  return status === 404
    ? "not_found"
    : status === 403
      ? "forbidden"
      : status === 409
        ? "conflict"
        : status >= 500
          ? "dependency_unavailable"
          : "invalid_argument";
}

/** Maps an error BillFn throws to the admin error an operator sees; other errors pass through. */
function adminErrorFromBillFn(error: unknown): unknown {
  if (error instanceof AdminError || typeof error !== "object" || error === null) return error;
  const { code, status, message, retryable, details } = error as { code?: unknown; status?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
  if (typeof code !== "string" || !code.startsWith("BILLFN_") || typeof status !== "number") return error;
  return new AdminError(adminCodeForStatus(status), typeof message === "string" ? message : code, {
    details: { code, ...importErrorDetails(details) },
    retryable: retryable === true,
  });
}

/**
 * The BillFn error details an operator needs to recover, passed on by allow-list: `reason` separates conflicts
 * (an unfinished import replay from a reference bound elsewhere), `originalTransactionIds` names the Apple
 * reference to import instead of a renewal transaction, `planKey`/`providerProductIds` explain a product mismatch, and
 * `grantId` names the grant a refused grant request conflicts with.
 */
const IMPORT_ERROR_DETAIL_KEYS = ["reason", "planKey", "providerProductIds", "originalTransactionIds", "grantId"] as const;

function importErrorDetails(details: unknown): Record<string, string | string[]> {
  if (typeof details !== "object" || details === null) return {};
  const passed: Record<string, string | string[]> = {};
  for (const key of IMPORT_ERROR_DETAIL_KEYS) {
    const value = (details as Record<string, unknown>)[key];
    if (typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      passed[key] = value;
    }
  }
  return passed;
}

function asJson(value: object): JsonRecord {
  return { ...value };
}

function compareAdminValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function list(
  values: object[],
  input: BillFnAdminListInput,
  context: AdminOperationContext,
  operationId: string,
): AdminOperationResult<JsonRecord> {
  let records = values.map(asJson);
  if (input.search?.trim()) {
    const query = input.search.trim().toLowerCase();
    records = records.filter((value) => JSON.stringify(value).toLowerCase().includes(query));
  }
  if (input.filter) {
    records = records.filter((value) => Object.entries(input.filter!).every(([key, expected]) => Object.is(value[key], expected)));
  }
  const sorts = input.sort ?? [];
  records.sort((left, right) => {
    for (const descriptor of sorts) {
      if (!descriptor.field) continue;
      const compared = compareAdminValues(left[descriptor.field], right[descriptor.field]);
      if (compared !== 0) return compared * (descriptor.direction === "desc" ? -1 : 1);
    }
    return String(left.id ?? "").localeCompare(String(right.id ?? ""));
  });
  const identity = pageIdentity(operationId, input);
  const decoded = input.cursor
    ? decodeAdminCursor<{ identity?: unknown; offset?: unknown }>(input.cursor, context.scope)
    : { identity, offset: 0 };
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new AdminError("invalid_argument", "The BillFn cursor is invalid.");
  }
  if (decoded.identity !== identity) {
    throw new AdminError("invalid_argument", "The BillFn cursor does not belong to this collection query.");
  }
  const offset = decoded.offset ?? 0;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new AdminError("invalid_argument", "The BillFn cursor is invalid.");
  const limit = normalizeAdminPageLimit(input.limit, { defaultLimit: 50, maxLimit: 200 });
  const items = records.slice(offset as number, (offset as number) + limit);
  const nextOffset = (offset as number) + items.length;
  return { ok: true, data: { items, nextCursor: nextOffset < records.length ? encodeAdminCursor(context.scope, { identity, offset: nextOffset }) : null } };
}

function item(value: object): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { item: asJson(value) } };
}

function accepted(value: object): AdminOperationResult<JsonRecord> {
  return { ok: true, data: { accepted: true, item: asJson(value) } };
}

/**
 * The grant a revoke targets. Super Console runs revoke-grant as an entitlements row action, so the row's
 * snapshot id names the account's active comp; any other id is taken as a grant id.
 */
function revokeTarget(
  id: string,
  scoped: { entitlements: { id: string } | null; grants: Array<{ id: string; kind: string; status: string }> },
): string {
  if (scoped.entitlements?.id !== id) return id;
  const comp = scoped.grants.find((grant) => grant.kind === "comp" && grant.status === "active");
  if (!comp) throw new AdminError("not_found", "No active comp was found for the active BillFn subject.");
  return comp.id;
}

function notFound(label: string): never {
  throw new AdminError("not_found", `${label} was not found for the active BillFn subject.`);
}

const BILLING_PROVIDERS = new Set<BillingProviderName>([
  "dodo",
  "apple",
  "stripe",
  "polar",
  "google-play",
  "microsoft-store",
]);

function billingProvider(value: string | undefined): BillingProviderName | undefined {
  if (value === undefined) return undefined;
  if (!BILLING_PROVIDERS.has(value as BillingProviderName)) {
    throw new AdminError("invalid_argument", "provider must be a configured BillFn provider name.");
  }
  return value as BillingProviderName;
}

function products(plans: BillFnPlanDefinition[]): object[] {
  const grouped = new Map<string, { id: string; productKey: string; planCount: number }>();
  for (const plan of plans) {
    const existing = grouped.get(plan.productKey);
    grouped.set(plan.productKey, {
      id: plan.productKey,
      productKey: plan.productKey,
      planCount: (existing?.planCount ?? 0) + 1,
    });
  }
  return [...grouped.values()];
}

/** Delegates billing changes to BillFn so provider, catalog, entitlement and reconciliation invariants remain active. */
export function createBillFnDomainAdminService(
  options: BillFnDomainAdminServiceOptions,
): BillFnAdminService {
  return {
    async listProducts(input, context) {
      const catalog = await options.billfn.getCatalog();
      return list(products(catalog.plans), input, context, "billfn.products.list");
    },
    async getProduct(input) {
      const catalog = await options.billfn.getCatalog();
      const value = products(catalog.plans).find((entry) => (entry as { id: string }).id === input.id);
      return value ? item(value) : notFound("Product");
    },
    async listPlans(input, context) {
      const catalog = await options.billfn.getCatalog();
      const plans = catalog.plans.map((plan) => ({ ...plan, id: plan.planKey }));
      return list(plans, input, context, "billfn.plans.list");
    },
    async getPlan(input) {
      const catalog = await options.billfn.getCatalog();
      const value = catalog.plans.map((plan) => ({ ...plan, id: plan.planKey })).find((entry) => entry.id === input.id);
      return value ? item(value) : notFound("Plan");
    },
    async listPrices(input, context) {
      const catalog = await options.billfn.getCatalog();
      return list(catalog.plans.flatMap((plan) => plan.prices.map((price) => ({ ...price, id: price.priceId, planKey: plan.planKey, productKey: plan.productKey }))), input, context, "billfn.prices.list");
    },
    async getPrice(input) {
      const catalog = await options.billfn.getCatalog();
      const value = catalog.plans.flatMap((plan) => plan.prices.map((price) => ({ ...price, id: price.priceId, planKey: plan.planKey, productKey: plan.productKey }))).find((entry) => entry.id === input.id);
      return value ? item(value) : notFound("Price");
    },
    async listSubscriptions(input, context) {
      const subject = await options.subject(context);
      const subscription = await options.billfn.subscriptionProvider.getActiveSubscription(subject);
      return list(subscription ? [subscription] : [], input, context, "billfn.subscriptions.list");
    },
    async getSubscription(input, context) {
      const subject = await options.subject(context);
      const subscription = await options.billfn.subscriptionProvider.getActiveSubscription(subject);
      return subscription?.id === input.id ? item(subscription) : notFound("Subscription");
    },
    async listEntitlements(input, context) {
      const data = unwrap(await options.billfn.getEntitlements(await options.subject(context)));
      return list(data.entitlements ? [data.entitlements] : [], input, context, "billfn.entitlements.list");
    },
    async getEntitlement(input, context) {
      const data = unwrap(await options.billfn.getEntitlements(await options.subject(context)));
      return data.entitlements?.id === input.id ? item(data.entitlements) : notFound("Entitlement");
    },
    async listUsage(input, context) {
      const data = unwrap(await options.billfn.getUsage(await options.subject(context), optionalString(input.filter?.resource, "filter.resource")));
      return list(data.usage.map((entry) => ({ ...entry, id: entry.resource })), input, context, "billfn.usage.list");
    },
    async getUsage(input, context) {
      const data = unwrap(await options.billfn.getUsage(await options.subject(context), input.id));
      const value = data.usage.find((entry) => entry.resource === input.id);
      return value ? item({ ...value, id: value.resource }) : notFound("Usage meter");
    },
    async grantEntitlement(input, context) {
      const subject = await options.subject(context);
      const scoped = unwrap(await options.billfn.getEntitlements(subject));
      if (input.payload.billingAccountId !== undefined && input.payload.billingAccountId !== scoped.billingAccount.id) {
        throw new AdminError("forbidden", "The grant billing account is outside the active BillFn subject.");
      }
      const kind = string(input.payload.kind, "payload.kind");
      if (kind !== "trial" && kind !== "comp") {
        throw new AdminError("invalid_argument", "payload.kind must be trial or comp.");
      }
      try {
        const data = unwrap(await options.billfn.services.grants.create({
          billingAccountId: scoped.billingAccount.id,
          // The subject's billing account is created when this is its first billing record.
          subject,
          planKey: string(input.payload.planKey, "payload.planKey"),
          kind,
          expiresAt: string(input.payload.expiresAt, "payload.expiresAt"),
          operator: { id: context.actor.id, type: context.actor.type, requestId: context.requestId },
          reason: input.reason,
        }));
        return { ok: true, data: { accepted: true, item: asJson(data.grant), operationReference: data.grant.id } };
      } catch (error) {
        throw adminErrorFromBillFn(error);
      }
    },
    async revokeGrant(input, context) {
      const scoped = unwrap(await options.billfn.getEntitlements(await options.subject(context)));
      if (input.payload?.billingAccountId !== undefined && input.payload.billingAccountId !== scoped.billingAccount.id) {
        throw new AdminError("forbidden", "The grant billing account is outside the active BillFn subject.");
      }
      try {
        const data = unwrap(await options.billfn.services.grants.revoke({
          billingAccountId: scoped.billingAccount.id,
          grantId: revokeTarget(string(input.id, "id"), scoped),
          operator: { id: context.actor.id, type: context.actor.type, requestId: context.requestId },
          reason: input.reason,
        }));
        return { ok: true, data: { accepted: true, item: asJson(data.grant), operationReference: data.grant.id } };
      } catch (error) {
        throw adminErrorFromBillFn(error);
      }
    },
    async changeSubscription(input, context) {
      return accepted(unwrap(await options.billfn.changeSubscription({
        subject: await options.subject(context),
        subscriptionId: input.id,
        targetPriceId: input.payload.targetPriceId,
        effectiveAt: input.payload.effectiveAt,
        prorationBehavior: input.payload.prorationBehavior,
        reason: input.reason,
      })));
    },
    async importSubscription(input, context) {
      const subject = await options.subject(context);
      const scoped = unwrap(await options.billfn.getEntitlements(subject));
      if (input.payload.billingAccountId !== undefined && input.payload.billingAccountId !== scoped.billingAccount.id) {
        throw new AdminError("forbidden", "The import billing account is outside the active BillFn subject.");
      }
      const provider = billingProvider(string(input.payload.provider, "payload.provider")) as BillingProviderName;
      const providerSubscriptionId = optionalString(input.payload.providerSubscriptionId, "payload.providerSubscriptionId");
      const originalTransactionId = optionalString(input.payload.originalTransactionId, "payload.originalTransactionId");
      const reference = provider === "apple"
        ? providerSubscriptionId !== undefined
          ? { provider, providerSubscriptionId, originalTransactionId }
          : originalTransactionId !== undefined ? { provider, originalTransactionId } : undefined
        : providerSubscriptionId !== undefined && originalTransactionId === undefined
          ? { provider, providerSubscriptionId }
          : undefined;
      if (!reference) {
        throw new AdminError("invalid_argument", "payload.providerSubscriptionId is required (payload.originalTransactionId names Apple subscriptions only).");
      }
      try {
        const data = unwrap(await options.billfn.services.subscriptions.import({
          ...reference,
          billingAccountId: scoped.billingAccount.id,
          // The subject's billing account is created when this is its first billing record.
          subject,
          planKey: string(input.payload.planKey, "payload.planKey"),
          operator: { id: context.actor.id, type: context.actor.type, requestId: context.requestId },
          reason: input.reason,
        }));
        return { ok: true, data: { accepted: true, item: asJson(data.subscription), operationReference: data.billingEvent.id } };
      } catch (error) {
        throw adminErrorFromBillFn(error);
      }
    },
    async cancelSubscription(input, context) {
      return accepted(unwrap(await options.billfn.cancelSubscription({
        subject: await options.subject(context),
        subscriptionId: input.id,
        reason: input.reason,
      })));
    },
    async refundPayment(input, context) {
      return accepted(unwrap(await options.billfn.refundCharge({
        subject: await options.subject(context),
        providerChargeId: input.id,
        subscriptionId: input.payload?.subscriptionId,
        mode: input.payload?.mode,
        amount: input.payload?.amount,
        reason: input.reason,
      })));
    },
    async reconcileProvider(input, context) {
      const subject = await options.subject(context);
      const scoped = unwrap(await options.billfn.getEntitlements(subject));
      if (input.payload.billingAccountId !== undefined && input.payload.billingAccountId !== scoped.billingAccount.id) {
        throw new AdminError("forbidden", "The reconciliation billing account is outside the active BillFn subject.");
      }

      if (input.payload.kind !== "account-scan" && input.payload.kind !== "subscription-sync") {
        throw new AdminError(
          "forbidden",
          "Provider-wide reconciliation jobs cannot be scheduled from a subject-scoped admin operation.",
        );
      }

      const subscriptionId = input.payload.kind === "subscription-sync"
        ? scoped.subscription?.id
        : undefined;
      if (input.payload.kind === "subscription-sync" && !subscriptionId) {
        throw new AdminError("precondition_failed", "The active BillFn subject has no subscription to reconcile.");
      }
      if (input.payload.subscriptionId !== undefined && input.payload.subscriptionId !== subscriptionId) {
        throw new AdminError("forbidden", "The reconciliation subscription is outside the active BillFn subject.");
      }

      return accepted(unwrap(await options.billfn.enqueueReconciliationJob({
        kind: input.payload.kind,
        provider: billingProvider(input.payload.provider),
        billingAccountId: scoped.billingAccount.id,
        subscriptionId,
      })));
    },
  };
}
