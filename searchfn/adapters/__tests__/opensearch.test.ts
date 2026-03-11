import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { OpenSearchAdapter } from "../src/opensearch";

const OPENSEARCH_URL = process.env.SEARCHFN_OS_URL ?? "http://localhost:9201";

let testCounter = 0;

async function canConnect(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

describe("OpenSearchAdapter integration", () => {
  let available = false;
  let adapter: OpenSearchAdapter;

  beforeAll(async () => {
    available = await canConnect(OPENSEARCH_URL);
    if (!available) {
      console.warn("OpenSearch not available, skipping integration tests");
    }
  });

  beforeEach(async () => {
    if (!available) return;

    adapter = new OpenSearchAdapter({
      node: OPENSEARCH_URL,
      indexPrefix: `searchfn_os_test_${++testCounter}`,
      requestTimeoutMs: 10_000,
      retry: { maxRetries: 1, baseDelayMs: 25, maxDelayMs: 100 },
    });

    await adapter.initialize({
      resources: [
        { name: "docs", searchFields: ["title", "body"] },
        { name: "tickets", searchFields: ["summary"] },
      ],
    });
  });

  afterAll(async () => {
    if (adapter) {
      await adapter.dispose();
    }
  });

  it("indexes and searches using OpenSearch dialect", async () => {
    if (!available) return;

    await adapter.index({
      resource: "docs",
      documents: [{ id: "d1", fields: { title: "incident update", body: "resolved" } }],
    });

    const result = await adapter.search({ resource: "docs", query: "incident", limit: 5 });
    expect(result).toEqual(["d1"]);
  });

  it("supports field filtering and searchAll", async () => {
    if (!available) return;

    await adapter.index({
      resource: "docs",
      documents: [{ id: "d1", fields: { title: "incident", body: "postmortem" } }],
    });
    await adapter.index({
      resource: "tickets",
      documents: [{ id: "t1", fields: { summary: "incident" } }],
    });

    const filtered = await adapter.search({
      resource: "docs",
      query: "postmortem",
      fields: ["title"],
      limit: 10,
    });
    expect(filtered).toEqual([]);

    const searchAll = await adapter.searchAll({ query: "incident", limit: 10 });
    expect(searchAll.map((r) => String(r.id))).toContain("d1");
    expect(searchAll.map((r) => String(r.id))).toContain("t1");
  });

  it("remove and clear are idempotent", async () => {
    if (!available) return;

    await adapter.index({
      resource: "docs",
      documents: [{ id: "d1", fields: { title: "incident" } }],
    });

    await adapter.remove({ resource: "docs", ids: ["d1"] });
    await expect(adapter.remove({ resource: "docs", ids: ["d1"] })).resolves.toBeUndefined();

    await adapter.clear("docs");
    await expect(adapter.clear("docs")).resolves.toBeUndefined();
  });
});
