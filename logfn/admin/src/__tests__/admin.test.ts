import { describe, expect, it, vi } from "vitest";
import {
  logFnAdminCapability,
  createLogFnAdminAdapter,
  type LogFnAdminService,
  type LogFnAdminServiceRequest,
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

describe("@logfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(logFnAdminCapability.schemaVersion).toBe("1.0");
    expect(logFnAdminCapability.availability).toBe("nested");
    expect(logFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      logFnAdminCapability.operations.some(
        (operation) => operation.id === "logfn.log-events.list",
      ),
    ).toBe(true);
    const mutation = logFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: LogFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: LogFnAdminService = { execute };
    const adapter = createLogFnAdminAdapter(service);

    const result = await adapter.execute(
      "logfn.log-events.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "logfn.log-events.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "logfn.log-events.list",
      input: { limit: 25 },
      context,
    });
  });
});
