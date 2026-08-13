import { describe, expect, it, vi } from "vitest";
import {
  ciFnAdminCapability,
  createCiFnAdminAdapter,
  type CiFnAdminService,
  type CiFnAdminServiceRequest,
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

describe("@cifn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(ciFnAdminCapability.schemaVersion).toBe("1.0");
    expect(ciFnAdminCapability.availability).toBe("required-product");
    expect(ciFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      ciFnAdminCapability.operations.some(
        (operation) => operation.id === "cifn.projects.list",
      ),
    ).toBe(true);
    const mutation = ciFnAdminCapability.operations.find(
      (operation) => operation.safety.classification !== "read",
    );
    expect(mutation).toMatchObject({
      safety: {
        audit: "required",
        idempotent: true,
      },
    });
  });

  it("mounts new runs at collection scope and retries/cancellation on a run", () => {
    expect(
      ciFnAdminCapability.operations.find(
        (operation) => operation.id === "cifn.runs.trigger-run",
      ),
    ).toMatchObject({ target: { resource: "runs", collection: true } });
    expect(
      ciFnAdminCapability.operations.find(
        (operation) => operation.id === "cifn.runs.retry-run",
      ),
    ).toMatchObject({
      target: { resource: "runs", idInput: "id" },
      inputSchema: { required: ["id"] },
    });
    expect(
      ciFnAdminCapability.operations.find(
        (operation) => operation.id === "cifn.runs.cancel-run",
      ),
    ).toMatchObject({
      safety: { classification: "destructive" },
      target: { resource: "runs", idInput: "id" },
      inputSchema: { required: ["id"] },
    });
  });

  it("delegates the operation and complete scope to the injected domain service", async () => {
    const execute = vi.fn(async (request: CiFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: CiFnAdminService = { execute };
    const adapter = createCiFnAdminAdapter(service);

    const result = await adapter.execute(
      "cifn.projects.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "cifn.projects.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "cifn.projects.list",
      input: { limit: 25 },
      context,
    });
  });
});
