import { describe, expect, it, vi } from "vitest";
import {
  mailFnAdminCapability,
  createMailFnAdminAdapter,
  type MailFnAdminService,
  type MailFnAdminServiceRequest,
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

describe("@mailfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(mailFnAdminCapability.schemaVersion).toBe("1.0");
    expect(mailFnAdminCapability.availability).toBe("required-product");
    expect(mailFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      mailFnAdminCapability.operations.some(
        (operation) => operation.id === "mailfn.projects.list",
      ),
    ).toBe(true);
    const mutation = mailFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: MailFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: MailFnAdminService = { execute };
    const adapter = createMailFnAdminAdapter(service);

    const result = await adapter.execute(
      "mailfn.projects.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "mailfn.projects.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "mailfn.projects.list",
      input: { limit: 25 },
      context,
    });
  });
});
