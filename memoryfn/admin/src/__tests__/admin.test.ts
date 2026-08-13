import { describe, expect, it, vi } from "vitest";
import {
  memoryFnAdminCapability,
  createMemoryFnAdminAdapter,
  type MemoryFnAdminService,
  type MemoryFnAdminServiceRequest,
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

describe("@memoryfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(memoryFnAdminCapability.schemaVersion).toBe("1.0");
    expect(memoryFnAdminCapability.availability).toBe("required-product");
    expect(memoryFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      memoryFnAdminCapability.operations.some(
        (operation) => operation.id === "memoryfn.tenants.list",
      ),
    ).toBe(true);
    const mutation = memoryFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: MemoryFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: MemoryFnAdminService = { execute };
    const adapter = createMemoryFnAdminAdapter(service);

    const result = await adapter.execute(
      "memoryfn.tenants.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "memoryfn.tenants.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "memoryfn.tenants.list",
      input: { limit: 25 },
      context,
    });
  });
});
