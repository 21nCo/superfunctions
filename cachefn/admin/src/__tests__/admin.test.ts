import { describe, expect, it, vi } from "vitest";
import {
  cacheFnAdminCapability,
  createCacheFnAdminAdapter,
  type CacheFnAdminService,
  type CacheFnAdminServiceRequest,
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

describe("@cachefn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(cacheFnAdminCapability.schemaVersion).toBe("1.0");
    expect(cacheFnAdminCapability.availability).toBe("optional-product");
    expect(cacheFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      cacheFnAdminCapability.operations.some(
        (operation) => operation.id === "cachefn.namespaces.list",
      ),
    ).toBe(true);
    const mutation = cacheFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: CacheFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: CacheFnAdminService = { execute };
    const adapter = createCacheFnAdminAdapter(service);

    const result = await adapter.execute(
      "cachefn.namespaces.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "cachefn.namespaces.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "cachefn.namespaces.list",
      input: { limit: 25 },
      context,
    });
  });
});
