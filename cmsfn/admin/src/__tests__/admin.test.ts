import { describe, expect, it, vi } from "vitest";
import {
  cmsFnAdminCapability,
  createCmsFnAdminAdapter,
  type CmsFnAdminService,
  type CmsFnAdminServiceRequest,
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

describe("@cmsfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(cmsFnAdminCapability.schemaVersion).toBe("1.0");
    expect(cmsFnAdminCapability.availability).toBe("required-product");
    expect(cmsFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      cmsFnAdminCapability.operations.some(
        (operation) => operation.id === "cmsfn.datasets.list",
      ),
    ).toBe(true);
    const mutation = cmsFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: CmsFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: CmsFnAdminService = { execute };
    const adapter = createCmsFnAdminAdapter(service);

    const result = await adapter.execute(
      "cmsfn.datasets.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "cmsfn.datasets.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "cmsfn.datasets.list",
      input: { limit: 25 },
      context,
    });
  });
});
