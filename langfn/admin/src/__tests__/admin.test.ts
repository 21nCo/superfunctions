import { describe, expect, it, vi } from "vitest";
import {
  langFnAdminCapability,
  createLangFnAdminAdapter,
  type LangFnAdminService,
  type LangFnAdminServiceRequest,
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

describe("@langfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(langFnAdminCapability.schemaVersion).toBe("1.0");
    expect(langFnAdminCapability.availability).toBe("optional-product");
    expect(langFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      langFnAdminCapability.operations.some(
        (operation) => operation.id === "langfn.providers.list",
      ),
    ).toBe(true);
    const mutation = langFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: LangFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: LangFnAdminService = { execute };
    const adapter = createLangFnAdminAdapter(service);

    const result = await adapter.execute(
      "langfn.providers.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "langfn.providers.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "langfn.providers.list",
      input: { limit: 25 },
      context,
    });
  });
});
