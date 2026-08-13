import { describe, expect, it, vi } from "vitest";
import {
  flowFnAdminCapability,
  createFlowFnAdminAdapter,
  type FlowFnAdminService,
  type FlowFnAdminServiceRequest,
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

describe("@flowfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(flowFnAdminCapability.schemaVersion).toBe("1.0");
    expect(flowFnAdminCapability.availability).toBe("required-product");
    expect(flowFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      flowFnAdminCapability.operations.some(
        (operation) => operation.id === "flowfn.workflows.list",
      ),
    ).toBe(true);
    const mutation = flowFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: FlowFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: FlowFnAdminService = { execute };
    const adapter = createFlowFnAdminAdapter(service);

    const result = await adapter.execute(
      "flowfn.workflows.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "flowfn.workflows.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "flowfn.workflows.list",
      input: { limit: 25 },
      context,
    });
  });
});
