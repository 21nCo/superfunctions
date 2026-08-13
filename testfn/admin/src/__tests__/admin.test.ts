import { describe, expect, it, vi } from "vitest";
import {
  testFnAdminCapability,
  createTestFnAdminAdapter,
  type TestFnAdminService,
  type TestFnAdminServiceRequest,
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

describe("@testfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(testFnAdminCapability.schemaVersion).toBe("1.0");
    expect(testFnAdminCapability.availability).toBe("required-product");
    expect(testFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      testFnAdminCapability.operations.some(
        (operation) => operation.id === "testfn.projects.list",
      ),
    ).toBe(true);
    const mutation = testFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: TestFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: TestFnAdminService = { execute };
    const adapter = createTestFnAdminAdapter(service);

    const result = await adapter.execute(
      "testfn.projects.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "testfn.projects.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "testfn.projects.list",
      input: { limit: 25 },
      context,
    });
  });
});
