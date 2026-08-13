import { describe, expect, it, vi } from "vitest";
import {
  searchFnAdminCapability,
  createSearchFnAdminAdapter,
  type SearchFnAdminService,
  type SearchFnAdminServiceRequest,
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

describe("@searchfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(searchFnAdminCapability.schemaVersion).toBe("1.0");
    expect(searchFnAdminCapability.availability).toBe("required-product");
    expect(searchFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      searchFnAdminCapability.operations.some(
        (operation) => operation.id === "searchfn.adapters-backends.list",
      ),
    ).toBe(true);
    const mutation = searchFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: SearchFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: SearchFnAdminService = { execute };
    const adapter = createSearchFnAdminAdapter(service);

    const result = await adapter.execute(
      "searchfn.adapters-backends.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "searchfn.adapters-backends.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "searchfn.adapters-backends.list",
      input: { limit: 25 },
      context,
    });
  });
});
