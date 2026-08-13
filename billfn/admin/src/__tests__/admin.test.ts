import { describe, expect, it, vi } from "vitest";
import {
  billFnAdminCapability,
  createBillFnAdminAdapter,
  type BillFnAdminService,
  type BillFnAdminServiceRequest,
} from "../index.js";

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
        (operation) => operation.id === "billfn.customers.list",
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
  });

  it("delegates the operation and complete scope to the injected domain service", async () => {
    const execute = vi.fn(async (request: BillFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: BillFnAdminService = { execute };
    const adapter = createBillFnAdminAdapter(service);

    const result = await adapter.execute(
      "billfn.customers.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "billfn.customers.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "billfn.customers.list",
      input: { limit: 25 },
      context,
    });
  });
});
