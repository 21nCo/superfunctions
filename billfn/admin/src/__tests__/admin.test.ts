import { describe, expect, it, vi } from "vitest";
import {
  billFnAdminCapability,
  createBillFnAdminAdapter,
  createBillFnDomainAdminService,
} from "../index.js";
import { createBillFn, createBillFnError, type BillFnInstance } from "@billfn/core";
import {
  createAdminDispatcher,
  createAdminRegistry,
  encodeAdminCursor,
  MemoryAdminAuditSink,
  MemoryAdminIdempotencyStore,
  validateAdminValue,
} from "@superfunctions/admin";
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

    it("rejects a request naming no subscription at input validation, before confirmation or the domain", async () => {
      const { billfn, importSubscription } = importingBillFn();
      const confirmation = { verify: vi.fn(async () => true) };
      const dispatcher = createAdminDispatcher({
        registry: createAdminRegistry({
          adapters: [createBillFnAdminAdapter(createBillFnDomainAdminService({ billfn, subject: () => ({ tenantId: "workspace_1" }) }))],
          enabledModules: ["billfn"],
        }),
        confirmation,
      });

      // No reference, or an original transaction id for a provider other than Apple.
      for (const payload of [
        { provider: "dodo", planKey: "nucleus" },
        { provider: "dodo", originalTransactionId: "2000000123", planKey: "nucleus" },
        { provider: "dodo", providerSubscriptionId: "sub_legacy", originalTransactionId: "2000000123", planKey: "nucleus" },
      ]) {
        const result = await dispatcher.dispatch({
          operationId: "billfn.subscriptions.import-subscription",
          input: { payload },
          context: { ...context, confirmationToken: "token_1" },
        });
        expect(result).toMatchObject({ ok: false, error: { code: "invalid_argument" } });
      }
      expect(confirmation.verify).not.toHaveBeenCalled();
      expect(importSubscription).not.toHaveBeenCalled();
      // Either reference, or both when they are equal, satisfies the schema.
      const inputSchema = billFnAdminCapability.operations.find(
        (candidate) => candidate.id === "billfn.subscriptions.import-subscription",
      )!.inputSchema!;
      for (const reference of [
        { providerSubscriptionId: "sub_legacy" },
        { originalTransactionId: "2000000123" },
        { providerSubscriptionId: "2000000123", originalTransactionId: "2000000123" },
      ]) {
        expect(validateAdminValue(inputSchema, { payload: { provider: "apple", planKey: "nucleus", ...reference } })).toEqual([]);
      }
      expect(validateAdminValue(inputSchema, { payload: { provider: "dodo", planKey: "nucleus", providerSubscriptionId: "sub_legacy" } })).toEqual([]);
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

    it("passes on the details an operator needs to correct a refused import", async () => {
      const { billfn, importSubscription } = importingBillFn();
      const service = createBillFnDomainAdminService({ billfn, subject: () => ({ tenantId: "workspace_1" }) });
      const payload = { provider: "dodo", providerSubscriptionId: "sub_legacy", planKey: "nucleus" } as const;

      // What the Apple adapter reports for a renewal transaction id: the original transaction id to import instead.
      importSubscription.mockRejectedValueOnce(createBillFnError({
        code: "BILLFN_VALIDATION_ERROR",
        message: "The Apple reference is not an original transaction id; import the subscription by its originalTransactionId",
        details: { originalTransactionIds: ["2000000123"], internal: { token: "not passed on" } },
      }));
      const renewal = await service.importSubscription({ payload }, context).catch((error: unknown) => error);
      expect(renewal).toMatchObject({
        code: "invalid_argument",
        retryable: false,
        details: { code: "BILLFN_VALIDATION_ERROR", originalTransactionIds: ["2000000123"] },
      });
      expect((renewal as { details: Record<string, unknown> }).details).not.toHaveProperty("internal");

      // A provider subscription whose product is not a price of the plan names both.
      importSubscription.mockResolvedValueOnce({
        subscriptionStatus: "active",
        checkoutStatus: "succeeded",
        providerSubscriptionId: "sub_legacy",
        autoRenew: true,
        raw: { subscription_id: "sub_legacy", product_id: "pdt_team_month", status: "active" },
      });
      await expect(service.importSubscription({ payload }, context)).rejects.toMatchObject({
        code: "invalid_argument",
        details: { code: "BILLFN_VALIDATION_ERROR", planKey: "nucleus", providerProductIds: ["pdt_team_month"] },
      });
    });

    it("reports a provider read that gets no answer as a retryable dependency_unavailable error, and a retry imports", async () => {
      const { billfn, importSubscription } = importingBillFn();
      const adapter = createBillFnAdminAdapter(createBillFnDomainAdminService({ billfn, subject: () => ({ tenantId: "workspace_1" }) }));
      const dispatcher = createAdminDispatcher({
        registry: createAdminRegistry({ adapters: [adapter], enabledModules: ["billfn"] }),
        confirmation: { verify: vi.fn(async () => true) },
        audit: new MemoryAdminAuditSink(),
        idempotency: new MemoryAdminIdempotencyStore(),
      });
      const request = {
        operationId: "billfn.subscriptions.import-subscription",
        input: { payload: { provider: "dodo", providerSubscriptionId: "sub_legacy", planKey: "nucleus" }, reason: "cutover" },
        context: { ...context, confirmationToken: "token_1" },
      };

      // A transport failure an adapter lets through (fetch rejects on DNS, connection reset or TLS).
      importSubscription.mockRejectedValueOnce(new TypeError("fetch failed: connect ECONNREFUSED https://dodo.test?api_key=secret"));
      const failed = await dispatcher.dispatch(request);
      expect(failed).toMatchObject({
        ok: false,
        error: {
          code: "dependency_unavailable",
          retryable: true,
          message: "Provider dodo could not be read for the imported subscription",
        },
      });
      expect(JSON.stringify(failed)).not.toMatch(/fetch failed|ECONNREFUSED|secret/);

      // The operator's retry, a new request once the provider answers again, imports.
      await expect(adapter.execute(
        "billfn.subscriptions.import-subscription",
        request.input,
        { ...context, requestId: "request_2", idempotencyKey: "idempotency_2" },
      )).resolves.toMatchObject({ ok: true, data: { accepted: true, item: { providerSubscriptionId: "sub_legacy" } } });
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

  describe("grant-entitlement", () => {
    function grantingBillFn() {
      const db = memoryAdapter();
      const billfn = createBillFn({
        db,
        catalog: {
          plans: [{
            productKey: "nucleus",
            planKey: "nucleus",
            displayName: "Nucleus",
            features: { memotron: true, pointron: true },
            limits: {},
            prices: [],
          }],
        },
      });
      const adapter = createBillFnAdminAdapter(
        createBillFnDomainAdminService({ billfn, subject: (admin) => ({ tenantId: admin.scope.workspaceId }) }),
      );
      const dispatcher = createAdminDispatcher({
        registry: createAdminRegistry({ adapters: [adapter], enabledModules: ["billfn"] }),
        confirmation: { verify: vi.fn(async () => true) },
        audit: new MemoryAdminAuditSink(),
        idempotency: new MemoryAdminIdempotencyStore(),
      });
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      return { billfn, db, adapter, dispatcher, expiresAt };
    }

    it("declares confirmed, audited collection actions for granting and revoking", () => {
      const grant = billFnAdminCapability.operations.find((candidate) => candidate.id === "billfn.entitlements.grant-entitlement");
      expect(grant).toMatchObject({
        permission: "billfn.entitlements.grant-entitlement",
        route: { method: "POST", path: "/resources/entitlements/actions/grant-entitlement" },
        safety: { classification: "write", requiresConfirmation: true, idempotent: true, audit: "required", confirmation: { method: "recent-auth" } },
        target: { resource: "entitlements", collection: true },
        inputSchema: { required: ["payload"], properties: { payload: { required: ["kind", "planKey", "expiresAt"] } } },
      });
      expect(billFnAdminCapability.operations.find((candidate) => candidate.id === "billfn.entitlements.revoke-grant")).toMatchObject({
        safety: { classification: "destructive", requiresConfirmation: true, confirmation: { method: "recent-auth" } },
        target: { resource: "entitlements", idInput: "id" },
        inputSchema: { required: ["id"] },
      });
      expect(validateAdminValue(grant!.inputSchema!, { payload: { kind: "gift", planKey: "nucleus", expiresAt: "2027-01-01T00:00:00.000Z" } })).not.toEqual([]);
    });

    it("grants a trial to the subject's billing account, records the operator and refuses a second trial", async () => {
      const { billfn, db, dispatcher, expiresAt } = grantingBillFn();
      const request = {
        operationId: "billfn.entitlements.grant-entitlement",
        input: { payload: { kind: "trial", planKey: "nucleus", expiresAt }, reason: "signup" },
        context: { ...context, confirmationToken: "token_1" },
      };

      const result = await dispatcher.dispatch(request);
      expect(result).toMatchObject({
        ok: true,
        data: {
          accepted: true,
          item: { billingAccountId: "ba_organization_workspace_1", kind: "trial", status: "active", expiresAt },
          operationReference: expect.any(String),
        },
      });
      const entitlements = await billfn.getEntitlements({ tenantId: "workspace_1" });
      expect(entitlements).toMatchObject({
        ok: true,
        data: { entitlements: { status: "trialing", planKey: "nucleus" }, grants: [{ kind: "trial", expiresAt }] },
      });
      const [event] = await db.findMany<{ payload: Record<string, unknown> }>({
        model: "billingEvents",
        where: [{ field: "type", operator: "eq", value: "billfn.grant.created" }],
        namespace: "billfn",
      });
      expect(event.payload).toMatchObject({ operator: { id: "operator_1", type: "user", requestId: "request_1" }, reason: "signup" });

      const second = await dispatcher.dispatch({
        ...request,
        context: { ...request.context, requestId: "request_2", idempotencyKey: "idempotency_2" },
      });
      expect(second).toMatchObject({
        ok: false,
        error: { code: "conflict", details: { reason: "trial_already_granted" } },
      });
    });

    it("rejects a foreign billing account and revokes a comp so the entitlements fall back", async () => {
      const { billfn, adapter, expiresAt } = grantingBillFn();
      await expect(adapter.execute(
        "billfn.entitlements.grant-entitlement",
        { payload: { kind: "comp", planKey: "nucleus", expiresAt, billingAccountId: "ba_organization_other" } },
        context,
      )).rejects.toMatchObject({ code: "forbidden" });

      const granted = await adapter.execute(
        "billfn.entitlements.grant-entitlement",
        { payload: { kind: "comp", planKey: "nucleus", expiresAt } },
        context,
      );
      const grantId = (granted as { data: { operationReference: string } }).data.operationReference;
      await expect(billfn.subscriptionProvider.hasFeature({ tenantId: "workspace_1" }, "pointron")).resolves.toBe(true);

      await expect(adapter.execute(
        "billfn.entitlements.revoke-grant",
        { id: grantId, reason: "ended" },
        { ...context, requestId: "request_2", idempotencyKey: "idempotency_2" },
      )).resolves.toMatchObject({ ok: true, data: { accepted: true, item: { id: grantId, status: "revoked", revokeReason: "ended" } } });
      await expect(billfn.subscriptionProvider.hasFeature({ tenantId: "workspace_1" }, "pointron")).resolves.toBe(false);
      await expect(adapter.execute(
        "billfn.entitlements.revoke-grant",
        { id: "grant_unknown" },
        { ...context, requestId: "request_3", idempotencyKey: "idempotency_3" },
      )).rejects.toMatchObject({ code: "not_found" });
    });
  });
});
