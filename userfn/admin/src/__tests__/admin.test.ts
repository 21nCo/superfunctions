import { describe, expect, it, vi } from "vitest";
import {
  userFnAdminCapability,
  createUserFnAdminAdapter,
  type UserFnAdminService,
  type UserFnAdminServiceRequest,
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

describe("@userfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(userFnAdminCapability.schemaVersion).toBe("1.0");
    expect(userFnAdminCapability.availability).toBe("required-product");
    expect(userFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      userFnAdminCapability.operations.some(
        (operation) => operation.id === "userfn.users.list",
      ),
    ).toBe(true);
    const mutation = userFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: UserFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: UserFnAdminService = { execute };
    const adapter = createUserFnAdminAdapter(service);

    const result = await adapter.execute(
      "userfn.users.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "userfn.users.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "userfn.users.list",
      input: { limit: 25 },
      context,
    });
  });
});
