import { describe, expect, it, vi } from "vitest";
import {
  authFnAdminCapability,
  createAuthFnAdminAdapter,
  type AuthFnAdminService,
  type AuthFnAdminServiceRequest,
} from "../index.js";

const context = {
  scope: {
    organizationId: "org_1",
    workspaceId: "workspace_1",
    projectId: "project_1",
    environmentId: "environment_1",
    namespace: "auth_tenant_1",
    region: "in-south",
  },
  actor: { id: "operator_1", type: "user" as const, permissions: ["*"] },
  requestId: "request_1",
  correlationId: "correlation_1",
  source: "console" as const,
  idempotencyKey: "idempotency_1",
};

describe("@authfn/admin capability", () => {
  it("extends the existing admin routes with the full operator contract", () => {
    expect(authFnAdminCapability.availability).toBe("required-product");
    expect(
      authFnAdminCapability.operations.some(
        (operation) => operation.id === "authfn.users.list",
      ),
    ).toBe(true);
    expect(
      authFnAdminCapability.operations.find(
        (operation) => operation.id === "authfn.users.delete-user",
      ),
    ).toMatchObject({
      safety: {
        classification: "destructive",
        requiresConfirmation: true,
        audit: "required",
      },
    });
  });

  it("binds collection invitations and destructive user targets explicitly", () => {
    const inviteUser = authFnAdminCapability.operations.find(
      (operation) => operation.id === "authfn.users.invite-user",
    );
    expect(inviteUser).toMatchObject({
      target: { resource: "users", collection: true },
    });
    expect(inviteUser?.inputSchema?.required).toBeUndefined();
    expect(
      authFnAdminCapability.operations.find(
        (operation) => operation.id === "authfn.users.delete-user",
      ),
    ).toMatchObject({
      safety: { classification: "destructive", requiresConfirmation: true },
      target: { resource: "users", idInput: "id" },
      inputSchema: { required: ["id"] },
    });
  });

  it("delegates the operation and complete scope to the injected AuthFn service", async () => {
    const execute = vi.fn(async (request: AuthFnAdminServiceRequest) => ({
      ok: true as const,
      data: {
        operationId: request.operationId,
        namespace: request.context.scope.namespace,
        region: request.context.scope.region,
      },
    }));
    const service: AuthFnAdminService = { execute };
    const adapter = createAuthFnAdminAdapter(service);

    const result = await adapter.execute(
      "authfn.users.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "authfn.users.list",
      namespace: "auth_tenant_1",
      region: "in-south",
    });
    expect(execute).toHaveBeenCalledWith({
      operationId: "authfn.users.list",
      input: { limit: 25 },
      context,
    });
  });
});
