import { describe, expect, it, vi } from "vitest";
import {
  dataFnAdminCapability,
  createDataFnAdminAdapter,
  type DataFnAdminService,
  type DataFnAdminServiceRequest,
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

describe("@datafn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(dataFnAdminCapability.schemaVersion).toBe("1.0");
    expect(dataFnAdminCapability.availability).toBe("required-product");
    expect(dataFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      dataFnAdminCapability.operations.some(
        (operation) => operation.id === "datafn.schemas.list",
      ),
    ).toBe(true);
    const mutation = dataFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: DataFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: DataFnAdminService = { execute };
    const adapter = createDataFnAdminAdapter(service);

    const result = await adapter.execute(
      "datafn.schemas.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "datafn.schemas.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "datafn.schemas.list",
      input: { limit: 25 },
      context,
    });
  });
});
