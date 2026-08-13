import { describe, expect, it, vi } from "vitest";
import {
  docsFnAdminCapability,
  createDocsFnAdminAdapter,
  type DocsFnAdminService,
  type DocsFnAdminServiceRequest,
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

describe("@docsfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(docsFnAdminCapability.schemaVersion).toBe("1.0");
    expect(docsFnAdminCapability.availability).toBe("optional-product");
    expect(docsFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      docsFnAdminCapability.operations.some(
        (operation) => operation.id === "docsfn.sites.list",
      ),
    ).toBe(true);
    const mutation = docsFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: DocsFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: DocsFnAdminService = { execute };
    const adapter = createDocsFnAdminAdapter(service);

    const result = await adapter.execute(
      "docsfn.sites.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "docsfn.sites.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "docsfn.sites.list",
      input: { limit: 25 },
      context,
    });
  });
});
