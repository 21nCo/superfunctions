import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { MeilisearchAdapter } from "../src/meilisearch";
import { SearchAdapterError } from "../src/types";

const MEILI_URL = process.env.SEARCHFN_MEILI_URL ?? "http://localhost:7700";
const MEILI_API_KEY = process.env.SEARCHFN_MEILI_API_KEY;

let testCounter = 0;

async function canConnect(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL("/health", url), { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

describe("MeilisearchAdapter integration", () => {
  let available = false;
  let adapter: MeilisearchAdapter;

  beforeAll(async () => {
    available = await canConnect(MEILI_URL);
    if (!available) {
      console.warn("Meilisearch not available, skipping integration tests");
    }
  });

  beforeEach(async () => {
    if (!available) return;

    adapter = new MeilisearchAdapter({
      host: MEILI_URL,
      apiKey: MEILI_API_KEY,
      indexPrefix: `searchfn_meili_test_${++testCounter}`,
      requestTimeoutMs: 10_000,
      retry: { maxRetries: 1, baseDelayMs: 25, maxDelayMs: 100 },
    });

    await adapter.initialize({
      resources: [
        { name: "docs", searchFields: ["title", "body"] },
        { name: "notes", searchFields: ["content"] },
      ],
    });
  });

  afterAll(async () => {
    if (adapter) {
      await adapter.dispose();
    }
  });

  it("implements initialize/index/search/remove/clear", async () => {
    if (!available) return;

    await adapter.index({
      resource: "docs",
      documents: [{ id: "d1", fields: { title: "Hello World", body: "incident" } }],
    });

    const first = await adapter.search({ resource: "docs", query: "hello", limit: 10 });
    expect(first).toEqual(["d1"]);

    await adapter.remove({ resource: "docs", ids: ["d1"] });
    const afterRemove = await adapter.search({ resource: "docs", query: "hello", limit: 10 });
    expect(afterRemove).toEqual([]);

    await adapter.index({
      resource: "docs",
      documents: [{ id: "d2", fields: { title: "Hello Again", body: "incident" } }],
    });
    await adapter.clear("docs");
    const afterClear = await adapter.search({ resource: "docs", query: "hello", limit: 10 });
    expect(afterClear).toEqual([]);
  });

  it("supports searchAll deterministic ordering and field filter", async () => {
    if (!available) return;

    await adapter.index({
      resource: "docs",
      documents: [{ id: "d1", fields: { title: "incident title", body: "body only" } }],
    });
    await adapter.index({
      resource: "notes",
      documents: [{ id: "n1", fields: { content: "incident title" } }],
    });

    const bodyFiltered = await adapter.search({
      resource: "docs",
      query: "body",
      fields: ["title"],
      limit: 10,
    });
    expect(bodyFiltered).toEqual([]);

    const all = await adapter.searchAll({ query: "incident", limit: 10 });
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const curr = all[i];
      const valid =
        prev.score > curr.score ||
        (prev.score === curr.score && prev.resource < curr.resource) ||
        (prev.score === curr.score && prev.resource === curr.resource && String(prev.id) <= String(curr.id));
      expect(valid).toBe(true);
    }
  });

  it("remove and clear are idempotent", async () => {
    if (!available) return;

    await adapter.index({
      resource: "docs",
      documents: [{ id: "d3", fields: { title: "idempotent" } }],
    });

    await adapter.remove({ resource: "docs", ids: ["d3"] });
    await expect(adapter.remove({ resource: "docs", ids: ["d3"] })).resolves.toBeUndefined();

    await adapter.clear("docs");
    await expect(adapter.clear("docs")).resolves.toBeUndefined();
  });
});

describe("MeilisearchAdapter resilience", () => {
  it("maps auth failures to FORBIDDEN", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    });

    const adapter = new MeilisearchAdapter({ host: "http://localhost:7700", apiKey: "bad-key" });
    try {
      await adapter.search({ resource: "docs", query: "hello", limit: 5 });
      expect.fail("expected auth failure");
    } catch (err) {
      expect((err as SearchAdapterError).code).toBe("FORBIDDEN");
      expect((err as Error).message).toContain("Meilisearch authorization failed");
    }

    fetchSpy.mockRestore();
  });

  it("enforces bounded retry budget on retryable failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
    });

    const adapter = new MeilisearchAdapter({
      host: "http://localhost:7700",
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
      requestTimeoutMs: 100,
    });

    try {
      await adapter.search({ resource: "docs", query: "hello", limit: 5 });
      expect.fail("expected retry exhaustion");
    } catch (err) {
      expect((err as SearchAdapterError).code).toBe("INTERNAL");
      expect((err as Error).message).toContain("Retry budget exhausted");
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    fetchSpy.mockRestore();
  });
});
