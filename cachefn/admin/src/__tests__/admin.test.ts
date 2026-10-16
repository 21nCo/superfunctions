import { describe, expect, it } from "vitest";
import { CacheFn } from "@cachefn/core";
import { validateAdminCapabilityManifest } from "@superfunctions/admin";
import { cacheFnAdminCapability, createCacheFnDomainAdminAdapter, createCacheFnDomainAdminService } from "../index.js";

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

  it("returns statistics as a collection and omits undefined optional fields", async () => {
    const cache = {
      getStats: async () => ({ hits: 1, misses: 2, hitRate: 33, sets: 3, deletes: 0, evictions: 0, size: 2, memoryUsage: undefined }),
    } as unknown as CacheFn<unknown>;
    const result = await createCacheFnDomainAdminService({ cache, environmentId: "environment_1", namespace: "tenant_1" })
      .stats({}, context);
    expect(result).toEqual({
      items: [{ id: "current", hits: 1, misses: 2, hitRate: 33, sets: 3, deletes: 0, evictions: 0, size: 2 }],
      nextCursor: null,
    });
  });

  it("paginates all keys with a scope- and query-bound cursor", async () => {
    const cache = new CacheFn<unknown>({ name: "pagination", namespace: "tenant_1" });
    for (const key of ["a:1", "a:2", "a:3", "b:1"]) await cache.set(key, key);
    const service = createCacheFnDomainAdminService({ cache, environmentId: "environment_1", namespace: "tenant_1" });

    const first = await service.listKeys({ pattern: "a:*", limit: 2 }, context);
    expect(first.items.map(({ id }) => id)).toEqual(["a:1", "a:2"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await expect(service.listKeys({ pattern: "b:*", cursor: first.nextCursor! }, context))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(service.listKeys({ pattern: "a:*", cursor: first.nextCursor! }, context))
      .resolves.toMatchObject({ items: [{ id: "a:3" }], nextCursor: null });
  });
});
