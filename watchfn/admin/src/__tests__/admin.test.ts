import { describe, expect, it, vi } from "vitest";
import {
  watchFnAdminCapability,
  createWatchFnAdminAdapter,
  type WatchFnAdminService,
  type WatchFnAdminServiceRequest,
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

describe("@watchfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(watchFnAdminCapability.schemaVersion).toBe("1.0");
    expect(watchFnAdminCapability.availability).toBe("required-product");
    expect(watchFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      watchFnAdminCapability.operations.some(
        (operation) => operation.id === "watchfn.organizations.list",
      ),
    ).toBe(true);
    const mutation = watchFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: WatchFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: WatchFnAdminService = { execute };
    const adapter = createWatchFnAdminAdapter(service);

    const result = await adapter.execute(
      "watchfn.organizations.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "watchfn.organizations.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "watchfn.organizations.list",
      input: { limit: 25 },
      context,
    });
  });
});
