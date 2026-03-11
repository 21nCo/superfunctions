import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { ElasticsearchAdapter } from "../src/elasticsearch";
import { SearchAdapterError } from "../src/types";

const ES_URL = process.env.SEARCHFN_ES_URL ?? "http://localhost:9200";

let testCounter = 0;

async function canConnect(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

describe("ElasticsearchAdapter integration", () => {
  let available = false;
  let adapter: ElasticsearchAdapter;

  beforeAll(async () => {
    available = await canConnect(ES_URL);
    if (!available) {
      console.warn("Elasticsearch not available, skipping integration tests");
    }
  });

  beforeEach(async () => {
    if (!available) return;

    adapter = new ElasticsearchAdapter({
      node: ES_URL,
      engine: "elasticsearch",
      indexPrefix: `searchfn_es_test_${++testCounter}`,
      requestTimeoutMs: 10_000,
      retry: { maxRetries: 1, baseDelayMs: 25, maxDelayMs: 100 },
    });

    await adapter.initialize({
      resources: [
        { name: "tasks", searchFields: ["title", "body"] },
        { name: "notes", searchFields: ["content"] },
      ],
    });
  });

  afterAll(async () => {
    if (adapter) {
      await adapter.dispose();
    }
  });

  it("supports index/search/remove/clear with deterministic ordering", async () => {
    if (!available) return;

    await adapter.index({
      resource: "tasks",
      documents: [
        { id: "b", fields: { title: "incident report", body: "urgent" } },
        { id: "a", fields: { title: "incident report", body: "urgent" } },
      ],
    });

    const first = await adapter.search({ resource: "tasks", query: "incident", limit: 10 });
    const second = await adapter.search({ resource: "tasks", query: "incident", limit: 10 });
    expect(first).toEqual(second);
    expect(first).toEqual(["a", "b"]);

    await adapter.remove({ resource: "tasks", ids: ["a"] });
    const afterRemove = await adapter.search({ resource: "tasks", query: "incident", limit: 10 });
    expect(afterRemove).toEqual(["b"]);

    await adapter.clear("tasks");
    const afterClear = await adapter.search({ resource: "tasks", query: "incident", limit: 10 });
    expect(afterClear).toEqual([]);
  });

  it("supports searchAll with canonical global ordering", async () => {
    if (!available) return;

    await adapter.index({
      resource: "tasks",
      documents: [{ id: "2", fields: { title: "incident" } }],
    });

    await adapter.index({
      resource: "notes",
      documents: [{ id: "1", fields: { content: "incident" } }],
    });

    const results = await adapter.searchAll({ query: "incident", limit: 10 });
    expect(results.length).toBeGreaterThan(0);

    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1];
      const curr = results[i];
      const valid =
        prev.score > curr.score ||
        (prev.score === curr.score && prev.resource < curr.resource) ||
        (prev.score === curr.score &&
          prev.resource === curr.resource &&
          String(prev.id) <= String(curr.id));
      expect(valid).toBe(true);
    }
  });
});

describe("ElasticsearchAdapter resilience and validation", () => {
  it("fails unsupported dialect with DFQL_UNSUPPORTED", () => {
    expect(
      () => new ElasticsearchAdapter({ node: "http://localhost:9200", engine: "invalid" as never }),
    ).toThrowError(SearchAdapterError);

    try {
      new ElasticsearchAdapter({ node: "http://localhost:9200", engine: "invalid" as never });
      expect.fail("should throw");
    } catch (err) {
      expect((err as SearchAdapterError).code).toBe("DFQL_UNSUPPORTED");
      expect((err as Error).message).toContain("Unsupported elastic dialect");
    }
  });

  it("enforces bounded retry budget", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response("{}", {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      );

    const adapter = new ElasticsearchAdapter({
      node: "http://localhost:9200",
      engine: "elasticsearch",
      retry: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 },
      requestTimeoutMs: 100,
    });

    try {
      await adapter.search({ resource: "tasks", query: "incident", limit: 5 });
      expect.fail("expected retry exhaustion");
    } catch (err) {
      expect((err as SearchAdapterError).code).toBe("INTERNAL");
      expect((err as Error).message).toContain("Retry budget exhausted");
    }

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    fetchSpy.mockRestore();
  });
});
