import { describe, expect, it, vi } from "vitest";
import {
  probeFnAdminCapability,
  createProbeFnAdminAdapter,
  type ProbeFnAdminService,
  type ProbeFnAdminServiceRequest,
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

describe("@probefn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(probeFnAdminCapability.schemaVersion).toBe("1.0");
    expect(probeFnAdminCapability.availability).toBe("optional-product");
    expect(probeFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      probeFnAdminCapability.operations.some(
        (operation) => operation.id === "probefn.sessions.list",
      ),
    ).toBe(true);
    const mutation = probeFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: ProbeFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: ProbeFnAdminService = { execute };
    const adapter = createProbeFnAdminAdapter(service);

    const result = await adapter.execute(
      "probefn.sessions.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "probefn.sessions.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "probefn.sessions.list",
      input: { limit: 25 },
      context,
    });
  });
});
