import { describe, expect, it, vi } from "vitest";
import {
  apiFnAdminCapability,
  apiFnAdminOperationPolicies,
  createApiFnAdminAdapter,
  type ApiFnAdminService,
  type ApiFnAdminServiceRequest,
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

describe("@apifn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(apiFnAdminCapability.schemaVersion).toBe("1.0");
    expect(apiFnAdminCapability.availability).toBe("optional-product");
    expect(apiFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      apiFnAdminCapability.operations.some(
        (operation) => operation.id === "apifn.specs.list",
      ),
    ).toBe(true);
    const mutation = apiFnAdminCapability.operations.find(
      (operation) => operation.safety.classification !== "read",
    );
    expect(mutation).toMatchObject({
      safety: {
        audit: "required",
        idempotent: true,
      },
    });
  });

  it("distinguishes collection creation from resource-targeted actions", () => {
    const importSpec = apiFnAdminCapability.operations.find(
      (operation) => operation.id === "apifn.specs.import-spec",
    );
    expect(importSpec).toMatchObject({
      target: { resource: "specs", collection: true },
    });
    expect(importSpec?.inputSchema?.required).toBeUndefined();
    expect(apiFnAdminOperationPolicies["apifn.specs.import-spec"]?.audit).toEqual({
      mode: "required",
      action: "apifn.import-spec",
      targetResource: "specs",
      collection: true,
    });
    expect(
      apiFnAdminCapability.operations.find(
        (operation) => operation.id === "apifn.specs.update-spec",
      ),
    ).toMatchObject({
      target: { resource: "specs", idInput: "id" },
      inputSchema: { required: ["id"] },
    });
    expect(apiFnAdminOperationPolicies["apifn.specs.update-spec"]?.audit).toEqual({
      mode: "required",
      action: "apifn.update-spec",
      targetResource: "specs",
      targetIdPath: "$.id",
    });
  });

  it("delegates the operation and complete scope to the injected domain service", async () => {
    const execute = vi.fn(async (request: ApiFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: ApiFnAdminService = { execute };
    const adapter = createApiFnAdminAdapter(service);

    const result = await adapter.execute(
      "apifn.specs.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "apifn.specs.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "apifn.specs.list",
      input: { limit: 25 },
      context,
    });
  });
});
