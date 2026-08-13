import { createSecFnServer } from "@secfn/server";
import { memoryAdapter } from "@superfunctions/db/adapters/memory";
import { AdminError, createAdminClient } from "@superfunctions/admin";
import { describe, expect, it, vi } from "vitest";
import {
  createSecFnAdminAdapter,
  createSecFnAdminClient,
  createSecFnDomainAdminService,
  secFnAdminCapability,
} from "../index.js";

const baseContext = {
  scope: {
    installationId: "installation_1",
    workspaceId: "workspace_1",
    projectId: "project_1",
    namespace: "team-a",
  },
  actor: { id: "operator_1", type: "user" as const, permissions: ["*"] },
  requestId: "request_1",
  correlationId: "correlation_1",
  source: "console" as const,
  idempotencyKey: "idempotency_1",
};

function fixture() {
  const server = createSecFnServer({
    db: memoryAdapter(),
    encryption: { masterKey: "secfn-admin-integration-test-master-key" },
  });
  const service = createSecFnDomainAdminService({
    server: async () => server,
    scope: async (context) => ({
      tenantId: context.scope.projectId!,
      namespace: context.scope.namespace,
    }),
  });
  return { server, service, adapter: createSecFnAdminAdapter(service) };
}

describe("@secfn/admin", () => {
  it("advertises only domain-backed resources and hardens sensitive mutations", () => {
    expect(secFnAdminCapability.schemaVersion).toBe("1.0");
    expect(secFnAdminCapability.scopeLevels).toEqual(["installation", "workspace", "project", "environment"]);
    expect(secFnAdminCapability.resources.map((resource) => resource.id)).toEqual([
      "namespaces",
      "environments",
      "secrets",
      "secret-sets",
      "secret-set-members",
      "audit-events",
      "scanner",
      "rate-limits",
    ]);
    expect(secFnAdminCapability.resources.some((resource) => resource.id === "incidents")).toBe(false);
    expect(secFnAdminCapability.operations.some((operation) => operation.id.includes("reveal"))).toBe(false);

    const rotate = secFnAdminCapability.operations.find((operation) => operation.id === "secfn.secrets.rotate");
    expect(rotate).toMatchObject({
      minimumScope: "project",
      safety: {
        classification: "write",
        requiresConfirmation: true,
        confirmation: { risk: "high", method: "mfa" },
        audit: "required",
      },
      redaction: { inputFields: ["value"] },
    });
    const remove = secFnAdminCapability.operations.find((operation) => operation.id === "secfn.secrets.delete");
    expect(remove?.safety.confirmation).toMatchObject({ risk: "critical", method: "mfa" });
  });

  it("creates, lists, rotates, and audits secrets through a real SecFn server", async () => {
    const { adapter, service } = fixture();
    expect(Object.keys(adapter.handlers).sort()).toEqual(
      secFnAdminCapability.operations.map((operation) => operation.id).sort(),
    );
    expect(service).not.toHaveProperty("execute");
    await adapter.execute("secfn.namespaces.create", { slug: "team-a", label: "Team A" }, baseContext);
    const created = await adapter.execute("secfn.secrets.create", {
      key: "DATABASE_URL",
      value: "postgres://secret@example.test/db",
      description: "Primary database",
      tags: ["database"],
    }, baseContext);
    const secret = (created.data as { item: { id: string; key: string; currentVersion: number; value?: string } }).item;
    expect(secret).toMatchObject({ key: "DATABASE_URL", currentVersion: 1 });
    expect(secret.value).toBeUndefined();

    const listed = await adapter.execute("secfn.secrets.list", { tag: "database" }, baseContext);
    expect((listed.data as { items: Array<{ id: string }> }).items).toHaveLength(1);

    const rotated = await adapter.execute("secfn.secrets.rotate", { id: secret.id, value: "postgres://rotated@example.test/db" }, baseContext);
    expect((rotated.data as { item: { currentVersion: number } }).item.currentVersion).toBe(2);

    const audit = await adapter.execute("secfn.audit-events.list", { limit: 20 }, baseContext);
    expect((audit.data as { items: Array<{ action?: string }> }).items.map((event) => event.action)).toEqual(expect.arrayContaining(["create", "rotate"]));
  });

  it("provides named typed client methods for every SecFn service family", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { items: [], nextCursor: null },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createSecFnAdminClient(createAdminClient({
      baseUrl: "https://console.example.test/api/admin/v1",
      fetch: fetcher as typeof fetch,
    }));

    await client.secrets.list({ limit: 25 });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(String(url)).toContain("/operations/secfn.secrets.list");
    expect(JSON.parse(String(request?.body))).toEqual({ limit: 25 });
    expect(client).toEqual(expect.objectContaining({
      namespaces: expect.any(Object),
      environments: expect.any(Object),
      secrets: expect.any(Object),
      secretSets: expect.any(Object),
      secretSetMembers: expect.any(Object),
      auditEvents: expect.any(Object),
      scanner: expect.any(Object),
      rateLimits: expect.any(Object),
    }));
    expect(client.secrets.rotate).toEqual(expect.any(Function));
    expect(client.scanner.scanContent).toEqual(expect.any(Function));
  });

  it("prevents an ID lookup from crossing the mapped project tenant", async () => {
    const { adapter } = fixture();
    await adapter.execute("secfn.namespaces.create", { slug: "team-a" }, baseContext);
    const created = await adapter.execute("secfn.secrets.create", { key: "TOKEN", value: "tenant-one" }, baseContext);
    const id = (created.data as { item: { id: string } }).item.id;

    const otherProject = {
      ...baseContext,
      scope: { ...baseContext.scope, projectId: "project_2" },
      requestId: "request_2",
    };
    await expect(adapter.execute("secfn.secrets.get", { id }, otherProject)).rejects.toMatchObject<Partial<AdminError>>({
      code: "not_found",
    });
  });

  it("uses SecFn's real scanner and rate limiter services", async () => {
    const { adapter } = fixture();
    const scan = await adapter.execute("secfn.scanner.scan-content", {
      content: "const token = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';",
      path: "src/config.ts",
    }, baseContext);
    expect((scan.data as { findingCount: number }).findingCount).toBeGreaterThan(0);

    const rate = await adapter.execute("secfn.rate-limits.check", { endpoint: "/admin" }, baseContext);
    expect((rate.data as { item: { allowed: boolean } }).item.allowed).toBe(true);
  });
});
