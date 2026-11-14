import { describe, expect, it, vi } from "vitest";
import {
  billFnAdminCapability,
  createBillFnAdminAdapter,
  createBillFnDomainAdminService,
} from "../index.js";
import { createBillFn, type BillFnInstance } from "@billfn/core";
import { encodeAdminCursor } from "@superfunctions/admin";
import { memoryAdapter } from "@superfunctions/db/adapters";

const context = {
  scope: {
    organizationId: "org_1",
    workspaceId: "workspace_1",
    projectId: "project_1",
    environmentId: "environment_1",
    namespace: "tenant_1",
    region: "in-south",
  },
  actor: { id: "operator_1", type: "user" as const, permissions: ["*"] },
  requestId: "request_1",
  correlationId: "correlation_1",
  source: "console" as const,
  idempotencyKey: "idempotency_1",
};

describe("@billfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(billFnAdminCapability.schemaVersion).toBe("1.0");
    expect(billFnAdminCapability.availability).toBe("required-product");
    expect(billFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      billFnAdminCapability.operations.some(
        (operation) => operation.id === "billfn.plans.list",
      ),
    ).toBe(true);
    const mutation = billFnAdminCapability.operations.find(
      (operation) => operation.safety.classification !== "read",
    );
    expect(mutation).toMatchObject({
      safety: {
        audit: "required",
        idempotent: true,
      },
    });
    expect(billFnAdminCapability.resources.find((resource) => resource.id === "products")).toMatchObject({
      displayFields: ["id", "productKey", "planCount"],
      filterableFields: ["productKey", "planCount"],
      sortableFields: ["productKey", "planCount"],
    });
  });


  it("reads the configured catalog through a real BillFn instance", async () => {
    const billfn = createBillFn({
      db: memoryAdapter(),
      catalog: {
        plans: [{
          productKey: "superconsole",
          planKey: "pro",
          displayName: "Pro",
          features: { audit: true },
          limits: { projects: 25 },
          prices: [{
            priceId: "price_monthly",
            provider: "stripe",
            providerProductId: "prod_superconsole",
            currency: "USD",
            amount: 2900,
            kind: "subscription",
            interval: "month",
          }],
        }],
      },
    });
    const adapter = createBillFnAdminAdapter(
      createBillFnDomainAdminService({
        billfn,
        subject: (admin) => ({ tenantId: admin.scope.workspaceId }),
      }),
    );

    await expect(adapter.execute("billfn.plans.list", {}, context)).resolves.toMatchObject({
      data: { items: [{ id: "pro", productKey: "superconsole" }] },
    });
    await expect(adapter.execute("billfn.prices.get", { id: "price_monthly" }, context)).resolves.toMatchObject({
      data: { item: { planKey: "pro", amount: 2900 } },
    });
  });

  it("applies declared catalog list search, filters, sorting, limits, and cursors", async () => {
    const plans = ["gamma", "alpha", "beta"].map((planKey) => ({
      productKey: "console",
      planKey,
      displayName: `${planKey} plan`,
      features: {},
      limits: {},
      prices: [],
    }));
    const service = createBillFnDomainAdminService({
      billfn: { getCatalog: vi.fn(async () => ({ plans })) } as unknown as BillFnInstance,
      subject: () => ({ tenantId: "tenant_1" }),
    });
    const first = await service.listPlans({ search: "plan", sort: [{ field: "id", direction: "asc" }], limit: 2 }, context);
    expect(first.data).toMatchObject({ items: [{ id: "alpha" }, { id: "beta" }], nextCursor: expect.any(String) });
    const second = await service.listPlans({
      search: "plan",
      sort: [{ field: "id", direction: "asc" }],
      limit: 2,
      cursor: (first.data as { nextCursor: string }).nextCursor,
    }, context);
    expect(second.data).toEqual({ items: [expect.objectContaining({ id: "gamma" })], nextCursor: null });
    const cursor = (first.data as { nextCursor: string }).nextCursor;
    await expect(service.listPrices({ search: "plan", sort: [{ field: "id", direction: "asc" }], cursor }, context))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(service.listPlans({ search: "gamma", sort: [{ field: "id", direction: "asc" }], cursor }, context))
      .rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("sorts numeric catalog fields numerically and rejects missing cursor positions", async () => {
    const plans = [
      ...Array.from({ length: 9 }, (_, index) => ({
        productKey: "nine", planKey: `nine_${index}`, displayName: "Nine", features: {}, limits: {}, prices: [],
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        productKey: "ten", planKey: `ten_${index}`, displayName: "Ten", features: {}, limits: {}, prices: [],
      })),
    ];
    const service = createBillFnDomainAdminService({
      billfn: { getCatalog: vi.fn(async () => ({ plans })) } as unknown as BillFnInstance,
      subject: () => ({ tenantId: "tenant_1" }),
    });

    await expect(service.listProducts({ sort: [{ field: "planCount", direction: "asc" }] }, context)).resolves.toMatchObject({
      data: { items: [{ productKey: "nine", planCount: 9 }, { productKey: "ten", planCount: 10 }] },
    });
    await expect(service.listProducts({ cursor: encodeAdminCursor(context.scope, null) }, context)).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("derives reconciliation targets from the active subject and rejects foreign targets/providers", async () => {
    const enqueueReconciliationJob = vi.fn(async (input) => ({
      ok: true as const,
      data: { jobId: "reconcile_1", ...input },
    }));
    const billfn = {
      getEntitlements: vi.fn(async () => ({
        ok: true as const,
        data: {
          billingAccount: { id: "account_owned" },
          subscription: { id: "subscription_owned" },
        },
      })),
      enqueueReconciliationJob,
    } as unknown as BillFnInstance;
    const service = createBillFnDomainAdminService({
      billfn,
      subject: () => ({ tenantId: "tenant_owned" }),
    });

    await expect(service.reconcileProvider({
      payload: { kind: "account-scan", billingAccountId: "account_foreign" },
    }, context)).rejects.toMatchObject({ code: "forbidden" });
    await expect(service.reconcileProvider({
      payload: { kind: "account-scan", provider: "not-a-provider" as never },
    }, context)).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(service.reconcileProvider({
      payload: { kind: "subscription-sync", subscriptionId: "subscription_foreign" },
    }, context)).rejects.toMatchObject({ code: "forbidden" });

    await expect(service.reconcileProvider({
      payload: { kind: "subscription-sync", provider: "stripe" },
    }, context)).resolves.toMatchObject({ data: { accepted: true } });
    expect(enqueueReconciliationJob).toHaveBeenCalledTimes(1);
    expect(enqueueReconciliationJob).toHaveBeenCalledWith({
      kind: "subscription-sync",
      provider: "stripe",
      billingAccountId: "account_owned",
      subscriptionId: "subscription_owned",
    });
  });

  describe("import-subscription", () => {
    function importingBillFn() {
      const importSubscription = vi.fn(async (input: { providerReference: string }) => ({
        subscriptionStatus: "active" as const,
        checkoutStatus: "succeeded" as const,
        providerSubscriptionId: input.providerReference,
        autoRenew: true,
        raw: { subscription_id: input.providerReference, product_id: "pdt_nucleus_month", status: "active" },
      }));
      const db = memoryAdapter();
      const billfn = createBillFn({
        db,
        catalog: {
          plans: [{
            productKey: "nucleus",
            planKey: "nucleus",
            displayName: "Nucleus",
            features: { memotron: true },
            limits: {},
            prices: [{
              priceId: "price_nucleus_month",
              provider: "dodo",
              providerProductId: "pdt_nucleus_month",
              currency: "USD",
              amount: 12,
              kind: "subscription",
              interval: "month",
            }],
          }],
        },
        providers: {
          dodo: {
            provider: "dodo",
            capabilities: {
              createCheckout: false, verifyCheckout: false, cancelSubscription: false, syncSubscription: false,
              restorePurchases: false, webhookIngestion: false, importSubscription: true,
            },
            importSubscription,
          },
        },
      });
      return { billfn, db, importSubscription };
    }

    it("declares a confirmed, audited collection action that is not a public BillFn route", () => {
      const operation = billFnAdminCapability.operations.find(
        (candidate) => candidate.id === "billfn.subscriptions.import-subscription",
      );
      expect(operation).toMatchObject({
        permission: "billfn.subscriptions.import-subscription",
        route: { method: "POST", path: "/resources/subscriptions/actions/import-subscription" },
        safety: {
          classification: "write",
          requiresConfirmation: true,
          idempotent: true,
          audit: "required",
          confirmation: { risk: "high", method: "recent-auth" },
        },
        target: { resource: "subscriptions", collection: true },
        inputSchema: {
          required: ["payload"],
          properties: { payload: { required: ["provider", "planKey"] } },
        },
      });
    });

    it("binds the provider subscription to the subject's billing account and records the operator", async () => {
      const { billfn, db } = importingBillFn();
      const adapter = createBillFnAdminAdapter(
        createBillFnDomainAdminService({ billfn, subject: (admin) => ({ tenantId: admin.scope.workspaceId }) }),
      );

      const result = await adapter.execute(
        "billfn.subscriptions.import-subscription",
        { payload: { provider: "dodo", providerSubscriptionId: "sub_legacy", planKey: "nucleus" }, reason: "cutover" },
        context,
      );

      expect(result).toMatchObject({
        ok: true,
        data: {
          accepted: true,
          item: { billingAccountId: "ba_organization_workspace_1", providerSubscriptionId: "sub_legacy", status: "active" },
          operationReference: expect.any(String),
        },
      });
      const [event] = await db.findMany<{ id: string; payload: Record<string, unknown> }>({
        model: "billingEvents",
        where: [{ field: "type", operator: "eq", value: "billfn.subscription.imported" }],
        namespace: "billfn",
      });
      expect(event.id).toBe((result as { data: { operationReference: string } }).data.operationReference);
      expect(event.payload).toMatchObject({
        operator: { id: "operator_1", type: "user", requestId: "request_1" },
        reason: "cutover",
      });
      await expect(billfn.subscriptionProvider.hasFeature({ tenantId: "workspace_1" }, "memotron")).resolves.toBe(true);
    });

    it("rejects a foreign billing account and reports a reference bound elsewhere as a conflict", async () => {
      const { billfn, importSubscription } = importingBillFn();
      const service = (tenantId: string) => createBillFnDomainAdminService({ billfn, subject: () => ({ tenantId }) });

      await expect(service("workspace_1").importSubscription({
        payload: { provider: "dodo", providerSubscriptionId: "sub_legacy", planKey: "nucleus", billingAccountId: "ba_organization_other" },
      }, context)).rejects.toMatchObject({ code: "forbidden" });
      expect(importSubscription).not.toHaveBeenCalled();

      await service("workspace_1").importSubscription({
        payload: { provider: "dodo", providerSubscriptionId: "sub_legacy", planKey: "nucleus" },
      }, context);
      await expect(service("workspace_2").importSubscription({
        payload: { provider: "dodo", providerSubscriptionId: "sub_legacy", planKey: "nucleus" },
      }, context)).rejects.toMatchObject({ code: "conflict", retryable: false, message: expect.stringContaining("different billing account") });
    });

    it("reports a reference the provider does not have as not found and an unfinished replay as a retryable conflict", async () => {
      const { billfn, db, importSubscription } = importingBillFn();
      const service = createBillFnDomainAdminService({ billfn, subject: () => ({ tenantId: "workspace_1" }) });
      const payload = { provider: "dodo", providerSubscriptionId: "sub_legacy", planKey: "nucleus" } as const;

      importSubscription.mockResolvedValueOnce(null as never);
      await expect(service.importSubscription({ payload: { ...payload, providerSubscriptionId: "sub_mistyped" } }, context)).rejects.toMatchObject({
        code: "not_found",
        retryable: false,
      });

      // Another replay run, interrupted moments ago, still holds an unlinked event for the reference.
      const now = new Date().toISOString();
      await db.create({
        model: "unlinkedWebhookEvents",
        data: {
          id: "uwe_dodo_evt_held",
          provider: "dodo",
          providerEventId: "evt_held",
          providerReference: "sub_legacy",
          eventType: "subscription.renewed",
          occurredAt: now,
          reason: "billing_account_metadata_missing",
          status: "replaying",
          event: {},
          replayClaimId: "uwr_interrupted",
          replayClaimedAt: now,
          expiresAt: "2099-01-01T00:00:00.000Z",
          createdAt: now,
          updatedAt: now,
        },
        namespace: "billfn",
      });
      await expect(service.importSubscription({ payload }, context)).rejects.toMatchObject({
        code: "conflict",
        retryable: true,
        details: { code: "BILLFN_CONFLICT", reason: "import_replay_unfinished" },
      });
    });
  });
});
