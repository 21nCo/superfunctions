import { describe, expect, it, vi } from "vitest";
import {
  compFnAdminCapability,
  createCompFnAdminAdapter,
  type CompFnAdminService,
  type CompFnAdminServiceRequest,
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

describe("@compfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(compFnAdminCapability.schemaVersion).toBe("1.0");
    expect(compFnAdminCapability.availability).toBe("required-product");
    expect(compFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      compFnAdminCapability.operations.some(
        (operation) => operation.id === "compfn.frameworks.list",
      ),
    ).toBe(true);
    const mutation = compFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: CompFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: CompFnAdminService = { execute };
    const adapter = createCompFnAdminAdapter(service);

    const result = await adapter.execute(
      "compfn.frameworks.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "compfn.frameworks.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "compfn.frameworks.list",
      input: { limit: 25 },
      context,
    });
  });
});
