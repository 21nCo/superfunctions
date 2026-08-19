import { describe, expect, it, vi } from "vitest";
import {
  compFnAdminCapability,
  createCompFnAdminAdapter,
  createCompFnDomainAdminService,
  type CompFnAdminService,
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

describe("@compfn/admin", () => {
  it("declares the inventoried operator surface and mutation policy", () => {
    expect(compFnAdminCapability.schemaVersion).toBe("1.0");
    expect(compFnAdminCapability.availability).toBe("required-product");
    expect(compFnAdminCapability.scopeLevels).toEqual([
      "organization",
      "workspace",
      "project",
      "environment",
    ]);
    expect(
      compFnAdminCapability.operations.some(
        (operation) => operation.id === "compfn.frameworks.list",
      ),
    ).toBe(true);
    const mutation = compFnAdminCapability.operations.find(
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
    const listFrameworks = vi.fn(async (_input, operationContext) => ({
      ok: true as const,
      data: {
        operationId: "compfn.frameworks.list",
        namespace: operationContext.scope.namespace,
        region: operationContext.scope.region,
      },
    }));
    const unused = vi.fn(async () => ({ ok: true as const, data: {} }));
    const service: CompFnAdminService = {
      listFrameworks,
      getFramework: unused,
      listControls: unused,
      getControl: unused,
      listChecks: unused,
      getCheck: unused,
      listEvidence: unused,
      getEvidence: unused,
      collectEvidence: unused,
      generateReport: unused,
    };
    const adapter = createCompFnAdminAdapter(service);

    const result = await adapter.execute(
      "compfn.frameworks.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      operationId: "compfn.frameworks.list",
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(listFrameworks).toHaveBeenCalledWith({ limit: 25 }, context);
    expect(unused).not.toHaveBeenCalled();
  });

  it("binds resource reads and evidence collection to a real CompFn API", async () => {
    const api = {
      controls: {
        create: vi.fn(),
        get: vi.fn(async (id: string) => ({ ok: true as const, result: { id, name: "Access control" } })),
        list: vi.fn(async () => ({ ok: true as const, result: [{ id: "ctrl_1", name: "Access control" }] })),
        update: vi.fn(),
        delete: vi.fn(),
      },
      frameworks: { create: vi.fn(), get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn() },
      evidence: {
        create: vi.fn(async (payload: Record<string, unknown>) => ({ ok: true as const, result: { id: "ev_1", ...payload } })),
        get: vi.fn(),
        list: vi.fn(async () => ({ ok: true as const, result: [] })),
      },
      checks: { create: vi.fn(), get: vi.fn(), list: vi.fn(), run: vi.fn(), delete: vi.fn() },
      readiness: { forControl: vi.fn(), forFramework: vi.fn() },
      export: { auditorPack: vi.fn() },
    };
    const adapter = createCompFnAdminAdapter(createCompFnDomainAdminService({
      compfn: api,
      scope: { workspaceId: "workspace_1", namespace: "tenant_1" },
    }));
    await expect(adapter.execute("compfn.controls.list", {}, context)).resolves.toMatchObject({
      data: { items: [{ id: "ctrl_1" }] },
    });
    await expect(adapter.execute("compfn.evidence.collect-evidence", {
      payload: {
        controlId: "ctrl_1",
        type: "manual_attestation",
        actorId: "operator_1",
        outcome: "pass",
      },
    }, context)).resolves.toMatchObject({ data: { accepted: true, item: { id: "ev_1" } } });
    await expect(adapter.execute(
      "compfn.controls.list",
      {},
      { ...context, scope: { ...context.scope, workspaceId: "workspace_other" } },
    )).rejects.toMatchObject({ code: "forbidden" });
  });
});
