import { describe, expect, it, vi } from "vitest";
import {
  secFnAdminCapability,
  createSecFnAdminAdapter,
  type SecFnAdminService,
  type SecFnAdminServiceRequest,
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

describe("@secfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(secFnAdminCapability.schemaVersion).toBe("1.0");
    expect(secFnAdminCapability.availability).toBe("required-product");
    expect(secFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      secFnAdminCapability.operations.some(
        (operation) => operation.id === "secfn.secrets.list",
      ),
    ).toBe(true);
    const mutation = secFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: SecFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: SecFnAdminService = { execute };
    const adapter = createSecFnAdminAdapter(service);

    const result = await adapter.execute(
      "secfn.secrets.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "secfn.secrets.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "secfn.secrets.list",
      input: { limit: 25 },
      context,
    });
  });
});
