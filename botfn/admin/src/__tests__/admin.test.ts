import { describe, expect, it, vi } from "vitest";
import {
  botFnAdminCapability,
  createBotFnAdminAdapter,
  type BotFnAdminService,
  type BotFnAdminServiceRequest,
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

describe("@botfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(botFnAdminCapability.schemaVersion).toBe("1.0");
    expect(botFnAdminCapability.availability).toBe("optional-product");
    expect(botFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      botFnAdminCapability.operations.some(
        (operation) => operation.id === "botfn.bots.list",
      ),
    ).toBe(true);
    const mutation = botFnAdminCapability.operations.find(
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
    const execute = vi.fn(async (request: BotFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: BotFnAdminService = { execute };
    const adapter = createBotFnAdminAdapter(service);

    const result = await adapter.execute(
      "botfn.bots.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "botfn.bots.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "botfn.bots.list",
      input: { limit: 25 },
      context,
    });
  });
});
