import { describe, expect, it } from "vitest";
import { CacheFn } from "@cachefn/core";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { cacheFnAdminCapability, createCacheFnDomainAdminAdapter } from "../index.js";

const context = {
  scope: { organizationId: "installation_1", workspaceId: "workspace_1", projectId: "project_1", environmentId: "environment_1", namespace: "tenant_1" },
  actor: { id: "operator_1", type: "user" as const, permissions: ["*"] },
  requestId: "request_1", correlationId: "correlation_1", source: "console" as const, idempotencyKey: "idem_1",
};

describe("@cachefn/admin real CacheFn binding", () => {
  it("registers only real CacheFn keys and statistics operations", () => {
    expect(validateAdminCapabilityManifest(cacheFnAdminCapability)).toEqual([]);
    expect(cacheFnAdminCapability.operations.map((operation) => operation.id)).toEqual([
      "cachefn.keys.list", "cachefn.keys.get", "cachefn.stats.list", "cachefn.keys.set",
      "cachefn.keys.delete", "cachefn.keys.invalidate-tag", "cachefn.namespaces.clear",
    ]);
  });

  it("mutates a real namespace-bound CacheFn instance without exposing cached values", async () => {
    const cache = new CacheFn<unknown>({ name: "admin-test", namespace: "tenant_1" });
    const adapter = createCacheFnDomainAdminAdapter({ cache, environmentId: "environment_1", namespace: "tenant_1" });
    await adapter.execute("cachefn.keys.set", { id: "secret", value: { token: "do-not-return" }, tags: ["auth"] }, context);
    expect(await adapter.execute("cachefn.keys.list", {}, context)).toMatchObject({ data: { items: [{ id: "secret", exists: true }] } });
    expect(JSON.stringify(await adapter.execute("cachefn.keys.get", { id: "secret" }, context))).not.toContain("do-not-return");
    await adapter.execute("cachefn.keys.invalidate-tag", { id: "auth" }, context);
    expect(await cache.has("secret")).toBe(false);
  });

  it("fails closed across environment scope", async () => {
    const adapter = createCacheFnDomainAdminAdapter({ cache: new CacheFn({ name: "scoped" }), environmentId: "environment_1" });
    await expect(adapter.execute("cachefn.keys.list", {}, { ...context, scope: { ...context.scope, environmentId: "environment_2" } })).rejects.toMatchObject({ code: "forbidden" });
  });
});
