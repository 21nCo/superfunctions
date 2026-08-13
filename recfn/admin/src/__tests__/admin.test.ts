import { describe, expect, it, vi } from "vitest";
import {
  recFnAdminCapability,
  createRecFnAdminAdapter,
  type RecFnAdminService,
  type RecFnAdminServiceRequest,
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

describe("@recfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(recFnAdminCapability.schemaVersion).toBe("1.0");
    expect(recFnAdminCapability.availability).toBe("required-product");
    expect(recFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      recFnAdminCapability.operations.some(
        (operation) => operation.id === "recfn.recording-bots.list",
      ),
    ).toBe(true);
    const mutation = recFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: RecFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: RecFnAdminService = { execute };
    const adapter = createRecFnAdminAdapter(service);

    const result = await adapter.execute(
      "recfn.recording-bots.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "recfn.recording-bots.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "recfn.recording-bots.list",
      input: { limit: 25 },
      context,
    });
  });
});
