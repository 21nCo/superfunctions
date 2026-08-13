import { describe, expect, it, vi } from "vitest";
import {
  mailFnAdminCapability,
  createMailFnAdminAdapter,
  createMailFnAdminClient,
  createMailFnDomainAdminService,
  type MailFnAdminService,
} from "../index.js";
import type { AdminClient } from "@superfunctions/admin";
import {
  DEFAULT_PROJECT_QUOTA,
  DEFAULT_STABLE_RETENTION,
  MailFn,
  MemoryMailFnObjectStore,
  MemoryMailFnStore,
} from "@mailfn/core";

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
    const listProjects = vi.fn(async (input, operationContext) => ({
      ok: true as const,
      data: {
        items: [{ limit: input.limit }],
        nextCursor: null,
        namespace: operationContext.scope.namespace,
        region: operationContext.scope.region,
      },
    }));
    const service = { listProjects } as unknown as MailFnAdminService;
    const adapter = createMailFnAdminAdapter(service);
    expect(Object.keys(adapter.handlers).sort()).toEqual(
      mailFnAdminCapability.operations.map((operation) => operation.id).sort(),
    );

    const result = await adapter.execute(
      "mailfn.projects.list",
      { limit: 25 },
      context,
    );

    expect(result.data).toEqual({
      items: [{ limit: 25 }],
      nextCursor: null,
      namespace: "tenant_1",
      region: "in-south",
    });
    expect(listProjects).toHaveBeenCalledWith({ limit: 25 }, context);
  });

  it("exposes named typed clients for mutations instead of generic operation dispatch", async () => {
    const invokeOperation = vi.fn(async () => ({ ok: true, data: { accepted: true } }));
    const client = createMailFnAdminClient({ invokeOperation } as unknown as AdminClient);

    await client.webhooks.create(
      { payload: { url: "https://example.test/hook", eventTypes: ["message.received"] } },
      { idempotencyKey: "idem_webhook" },
    );

    expect(invokeOperation).toHaveBeenCalledWith(
      "mailfn.webhooks.create-webhook",
      { payload: { url: "https://example.test/hook", eventTypes: ["message.received"] } },
      { idempotencyKey: "idem_webhook" },
    );
  });

  it("binds project-scoped reads and writes to the real MailFn service", async () => {
    const store = new MemoryMailFnStore();
    await store.saveProject({
      id: "project_1",
      slug: "admin-project",
      displayName: "Admin project",
      status: "active",
      environment: "production",
      dataRegion: "in",
      defaultRetentionPolicy: { ...DEFAULT_STABLE_RETENTION },
      quota: { ...DEFAULT_PROJECT_QUOTA },
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    const mailfn = new MailFn({
      store,
      objects: new MemoryMailFnObjectStore(),
      defaultDomain: "mail.example.test",
      ids: {
        generate: (() => {
          let sequence = 0;
          return (prefix: string) => `${prefix}_${++sequence}`;
        })(),
      },
    });
    const adapter = createMailFnAdminAdapter(
      createMailFnDomainAdminService({ mailfn, store }),
    );

    const created = await adapter.execute(
      "mailfn.inboxes.create-inbox",
      {
        payload: {
          kind: "stable",
          requestedLocalPart: "operators",
          displayName: "Operator inbox",
        },
      },
      context,
    );
    expect(created.data).toMatchObject({
      accepted: true,
      item: {
        projectId: "project_1",
        address: "operators@mail.example.test",
      },
    });

    const listed = await adapter.execute(
      "mailfn.inboxes.list",
      { limit: 25 },
      context,
    );
    expect(listed.data).toMatchObject({
      items: [{ address: "operators@mail.example.test" }],
      nextCursor: null,
    });
    expect(JSON.stringify(created.data)).not.toContain("token");
  });

  it("does not expose a MailFn object outside the active project", async () => {
    const store = new MemoryMailFnStore();
    await store.saveProject({
      id: "project_other",
      slug: "other",
      displayName: "Other",
      status: "active",
      environment: "production",
      dataRegion: "global",
      defaultRetentionPolicy: { ...DEFAULT_STABLE_RETENTION },
      quota: { ...DEFAULT_PROJECT_QUOTA },
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    const adapter = createMailFnAdminAdapter(
      createMailFnDomainAdminService({
        mailfn: new MailFn({
          store,
          objects: new MemoryMailFnObjectStore(),
          defaultDomain: "mail.example.test",
        }),
        store,
      }),
    );

    await expect(
      adapter.execute("mailfn.projects.get", { id: "project_other" }, context),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
