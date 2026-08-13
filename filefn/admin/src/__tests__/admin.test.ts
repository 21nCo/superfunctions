import { describe, expect, it, vi } from "vitest";
import {
  fileFnAdminCapability,
  createFileFnAdminAdapter,
  type FileFnAdminService,
  type FileFnAdminServiceRequest,
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

describe("@filefn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(fileFnAdminCapability.schemaVersion).toBe("1.0");
    expect(fileFnAdminCapability.availability).toBe("required-product");
    expect(fileFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      fileFnAdminCapability.operations.some(
        (operation) => operation.id === "filefn.files.list",
      ),
    ).toBe(true);
    const mutation = fileFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: FileFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: FileFnAdminService = { execute };
    const adapter = createFileFnAdminAdapter(service);

    const result = await adapter.execute(
      "filefn.files.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "filefn.files.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "filefn.files.list",
      input: { limit: 25 },
      context,
    });
  });
});
