import { describe, expect, it, vi } from "vitest";
import {
  hostFnAdminCapability,
  createHostFnAdminAdapter,
  type HostFnAdminService,
  type HostFnAdminServiceRequest,
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

describe("@hostfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(hostFnAdminCapability.schemaVersion).toBe("1.0");
    expect(hostFnAdminCapability.availability).toBe("required-product");
    expect(hostFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      hostFnAdminCapability.operations.some(
        (operation) => operation.id === "hostfn.projects.list",
      ),
    ).toBe(true);
    const mutation = hostFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: HostFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: HostFnAdminService = { execute };
    const adapter = createHostFnAdminAdapter(service);

    const result = await adapter.execute(
      "hostfn.projects.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "hostfn.projects.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "hostfn.projects.list",
      input: { limit: 25 },
      context,
    });
  });
});
