import { BrowseFn } from "browsefn";
import { AdminError, assertAdminCapabilityManifest, validateAdminValue } from "@superfunctions/admin";
import { describe, expect, it } from "vitest";
import {
  browseFnAdminCapability,
  createBrowseFnAdminAdapter,
  createBrowseFnDomainAdminService,
  type BrowseFnAdminService,
} from "../index.js";

const ownedScope = {
  installationId: "install_1",
  workspaceId: "workspace_1",
  projectId: "project_1",
  environmentId: "environment_1",
  namespace: "tenant_1",
  region: "in-south",
};

function context(overrides: Record<string, unknown> = {}) {
  return {
    scope: { ...ownedScope },
    actor: { id: "operator_1", type: "user" as const, permissions: ["*"] },
    requestId: "request_1",
    correlationId: "correlation_1",
    source: "console" as const,
    idempotencyKey: "idempotency_1",
    confirmationToken: "confirmation_1",
    ...overrides,
  };
}

function fixture() {
  const browsefn = new BrowseFn({
    cache: { enabled: true, ttl: 60_000 },
    rateLimit: { global: { requests: 25, window: 60_000 } },
  });
  const service = createBrowseFnDomainAdminService({ browsefn, scope: ownedScope });
  return { browsefn, service, adapter: createBrowseFnAdminAdapter(service) };
}

function expectValidOutput(operationId: string, output: unknown): void {
  const operation = browseFnAdminCapability.operations.find((candidate) => candidate.id === operationId);
  expect(operation?.outputSchema).toBeDefined();
  expect(validateAdminValue(operation!.outputSchema!, output)).toEqual([]);
}

describe("@browsefn/admin", () => {
  it("declares only the domain-backed environment operator surface", () => {
    expect(() => assertAdminCapabilityManifest(browseFnAdminCapability)).not.toThrow();
    expect(browseFnAdminCapability.availability).toBe("required-product");
    expect(browseFnAdminCapability.scopeLevels).toEqual([
      "installation", "workspace", "project", "environment",
    ]);
    expect(browseFnAdminCapability.resources?.map((resource) => resource.id)).toEqual([
      "providers", "metrics", "rate-limits", "logs", "cache",
    ]);
    expect(browseFnAdminCapability.operations.map((operation) => operation.id)).toEqual([
      "browsefn.providers.list",
      "browsefn.metrics.get",
      "browsefn.metrics.clear",
      "browsefn.rate-limits.get",
      "browsefn.logs.list",
      "browsefn.logs.clear",
      "browsefn.cache.get",
      "browsefn.cache.clear",
    ]);
    expect(browseFnAdminCapability.operations.every((operation) => operation.minimumScope === "environment")).toBe(true);
    expect(browseFnAdminCapability.operations.filter((operation) => operation.safety.classification !== "read")
      .every((operation) =>
        operation.safety.audit === "required" &&
        operation.safety.idempotent === true &&
        operation.safety.requiresConfirmation === true,
      )).toBe(true);
    expect(browseFnAdminCapability.operations.some((operation) => operation.id.includes("scrape-jobs"))).toBe(false);
    expect(browseFnAdminCapability.operations.some((operation) => operation.id.includes("credentials"))).toBe(false);
  });

  it("reads providers, metrics, rate limits, and cache through a real BrowseFn facade", async () => {
    const { browsefn, adapter } = fixture();
    await browsefn.cache!.set("test", "https://example.test/resource", { ok: true });

    const providers = await adapter.execute("browsefn.providers.list", {}, context());
    expect(providers.data).toEqual({
      items: [{ id: "web:cheerio", name: "cheerio", kind: "web", available: true }],
      nextCursor: null,
    });
    expectValidOutput("browsefn.providers.list", providers.data);

    const metrics = await adapter.execute("browsefn.metrics.get", { timeRange: "all" }, context());
    expect(metrics.data).toMatchObject({ item: { id: "current", totalRequests: 0 } });
    expectValidOutput("browsefn.metrics.get", metrics.data);

    const rateLimit = await adapter.execute("browsefn.rate-limits.get", { provider: "cheerio" }, context());
    expect(rateLimit.data).toMatchObject({
      item: { id: "cheerio", provider: "cheerio", allowed: true, remaining: 25, limit: 25 },
    });
    expectValidOutput("browsefn.rate-limits.get", rateLimit.data);

    const cache = await adapter.execute("browsefn.cache.get", {}, context());
    expect(cache.data).toMatchObject({ item: { id: "cache", enabled: true, size: 1 } });
    expectValidOutput("browsefn.cache.get", cache.data);
  });

  it("projects bounded lifecycle logs without URLs, error bodies, or arbitrary details", async () => {
    const { browsefn, adapter } = fixture();
    await expect(browsefn.web.getPage("not a valid url")).rejects.toThrow();

    const result = await adapter.execute("browsefn.logs.list", { limit: 10 }, context());
    const data = result.data as { items: Array<Record<string, unknown>>; nextCursor: null };
    expect(data.nextCursor).toBeNull();
    expect(data.items.map((item) => item.event)).toEqual(["request", "error"]);
    expect(data.items.every((item) => !("url" in item) && !("error" in item) && !("details" in item))).toBe(true);
    expect(data.items.every((item) => !String(item.id).includes("request_"))).toBe(true);
    expect(data.items[1]).toMatchObject({ operation: "web.getPage", outcome: "error" });
    expectValidOutput("browsefn.logs.list", data);
  });

  it("performs destructive maintenance only after exact scope and idempotency checks", async () => {
    const { browsefn, adapter } = fixture();
    await browsefn.cache!.set("test", "https://example.test/resource", { ok: true });

    await expect(adapter.execute(
      "browsefn.cache.clear",
      { id: "cache", reason: "Operator requested a clean cache." },
      context({ idempotencyKey: undefined }),
    )).rejects.toMatchObject({ code: "precondition_failed" });

    await expect(adapter.execute(
      "browsefn.cache.clear",
      { id: "cache", reason: "Operator requested a clean cache." },
      context({ scope: { ...ownedScope, environmentId: "environment_2" } }),
    )).rejects.toBeInstanceOf(AdminError);

    await expect(adapter.execute(
      "browsefn.cache.clear",
      { id: "cache", reason: "Operator requested a clean cache." },
      context(),
    )).resolves.toMatchObject({ data: { accepted: true } });
    await expect(browsefn.cache!.getStats()).resolves.toMatchObject({ size: 0, hits: 0, misses: 0 });
  });

  it("rejects invalid or wildcard ownership bindings at construction", () => {
    expect(() => createBrowseFnDomainAdminService({
      browsefn: new BrowseFn(),
      scope: { ...ownedScope, namespace: "" },
    })).toThrowError(/scope.namespace/);
    expect(() => createBrowseFnDomainAdminService({
      browsefn: new BrowseFn(),
      scope: { ...ownedScope, environmentId: "*" },
    })).toThrowError(/scope.environmentId/);
  });

  it("normalizes provider aliases before reading rate-limit state", async () => {
    const { adapter } = fixture();
    await expect(adapter.execute("browsefn.rate-limits.get", { provider: "  googleMaps  " }, context()))
      .resolves.toMatchObject({ data: { item: { id: "google-maps", provider: "google-maps" } } });
  });

  it("preserves service receivers through the generic adapter", async () => {
    const fallback = async () => ({ accepted: true as const });
    const service = {
      marker: "bound",
      async listProviders() {
        if (this.marker !== "bound") throw new Error("lost receiver");
        return { items: [], nextCursor: null };
      },
      getMetrics: async () => ({ item: { id: "current", totalRequests: 0, successRate: 0, avgResponseTime: 0, cacheHitRate: 0, byProvider: {} } }),
      clearMetrics: fallback,
      getRateLimit: async () => ({ item: { id: "cheerio", provider: "cheerio", allowed: true, remaining: null, resetAt: null, limit: null, retryAfterMs: null } }),
      listLogs: async () => ({ items: [], nextCursor: null }),
      clearLogs: fallback,
      getCache: async () => ({ item: { id: "cache", enabled: false, hits: null, misses: null, hitRate: null, size: null } }),
      clearCache: fallback,
    } as BrowseFnAdminService & { marker: string };

    await expect(createBrowseFnAdminAdapter(service).execute("browsefn.providers.list", {}, context()))
      .resolves.toMatchObject({ data: { items: [] } });
  });
});
