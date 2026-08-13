import { describe, expect, it, vi } from "vitest";
import {
  browseFnAdminCapability,
  createBrowseFnAdminAdapter,
  type BrowseFnAdminService,
  type BrowseFnAdminServiceRequest,
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

describe("@browsefn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(browseFnAdminCapability.schemaVersion).toBe("1.0");
    expect(browseFnAdminCapability.availability).toBe("required-product");
    expect(browseFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      browseFnAdminCapability.operations.some(
        (operation) => operation.id === "browsefn.providers.list",
      ),
    ).toBe(true);
    const mutation = browseFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: BrowseFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: BrowseFnAdminService = { execute };
    const adapter = createBrowseFnAdminAdapter(service);

    const result = await adapter.execute(
      "browsefn.providers.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "browsefn.providers.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "browsefn.providers.list",
      input: { limit: 25 },
      context,
    });
  });
});
