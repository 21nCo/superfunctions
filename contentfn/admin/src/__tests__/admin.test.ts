import { describe, expect, it, vi } from "vitest";
import {
  contentFnAdminCapability,
  createContentFnAdminAdapter,
  type ContentFnAdminService,
  type ContentFnAdminServiceRequest,
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

describe("@contentfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(contentFnAdminCapability.schemaVersion).toBe("1.0");
    expect(contentFnAdminCapability.availability).toBe("nested");
    expect(contentFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      contentFnAdminCapability.operations.some(
        (operation) => operation.id === "contentfn.datasets.list",
      ),
    ).toBe(true);
    const mutation = contentFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: ContentFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: ContentFnAdminService = { execute };
    const adapter = createContentFnAdminAdapter(service);

    const result = await adapter.execute(
      "contentfn.datasets.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "contentfn.datasets.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "contentfn.datasets.list",
      input: { limit: 25 },
      context,
    });
  });
});
