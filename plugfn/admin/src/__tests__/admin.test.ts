import { describe, expect, it, vi } from "vitest";
import {
  plugFnAdminCapability,
  createPlugFnAdminAdapter,
  type PlugFnAdminService,
  type PlugFnAdminServiceRequest,
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

describe("@plugfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(plugFnAdminCapability.schemaVersion).toBe("1.0");
    expect(plugFnAdminCapability.availability).toBe("required-product");
    expect(plugFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      plugFnAdminCapability.operations.some(
        (operation) => operation.id === "plugfn.provider-catalog.list",
      ),
    ).toBe(true);
    const mutation = plugFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: PlugFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: PlugFnAdminService = { execute };
    const adapter = createPlugFnAdminAdapter(service);

    const result = await adapter.execute(
      "plugfn.provider-catalog.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "plugfn.provider-catalog.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "plugfn.provider-catalog.list",
      input: { limit: 25 },
      context,
    });
  });
});
