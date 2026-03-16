import { describe, it, expect } from "vitest";
import { runAdapterContractTests } from "./adapter-contract";
import { IndexedDbAdapter } from "../src/index";
import { SearchAdapterError } from "@searchfn/adapter-contracts";

let testCounter = 0;
function freshDbName(): string {
  return `test-idb-${++testCounter}`;
}

runAdapterContractTests("IndexedDbAdapter", () => new IndexedDbAdapter({ dbName: freshDbName() }));

describe("IndexedDbAdapter — IDB-specific tests", () => {
  // TV-IDB-002: persistence across dispose/reinitialize
  it("persists indexed data across dispose and reinitialize", async () => {
    const dbName = freshDbName();

    const adapter1 = new IndexedDbAdapter({ dbName });
    await adapter1.index({
      resource: "tasks",
      documents: [
        { id: "task:1", fields: { title: "Buy groceries", description: "Get milk and bread" } },
        { id: "task:2", fields: { title: "Review pull request", description: "Check auth changes" } },
      ],
    });
    await adapter1.dispose();

    const adapter2 = new IndexedDbAdapter({ dbName });
    try {
      const result = await adapter2.search({ resource: "tasks", query: "groceries" });
      expect(result).toEqual(["task:1"]);
    } finally {
      await adapter2.dispose();
    }
  });

  it("persists remove operations across dispose and reinitialize", async () => {
    const dbName = freshDbName();

    const adapter1 = new IndexedDbAdapter({ dbName });
    await adapter1.index({
      resource: "tasks",
      documents: [
        { id: "task:1", fields: { title: "Buy groceries" } },
        { id: "task:2", fields: { title: "Review pull request" } },
      ],
    });
    await adapter1.remove({ resource: "tasks", ids: ["task:1"] });
    await adapter1.dispose();

    const adapter2 = new IndexedDbAdapter({ dbName });
    try {
      const result = await adapter2.search({ resource: "tasks", query: "groceries", fields: ["title"] });
      expect(result).toEqual([]);
      const result2 = await adapter2.search({ resource: "tasks", query: "review", fields: ["title"] });
      expect(result2).toContain("task:2");
    } finally {
      await adapter2.dispose();
    }
  });

  // TV-IDB-003: clear removes data from IDB permanently
  it("clear removes IndexedDB data so a new adapter session finds nothing", async () => {
    const dbName = freshDbName();

    const adapter1 = new IndexedDbAdapter({ dbName });
    await adapter1.index({
      resource: "tasks",
      documents: [
        { id: "1", fields: { title: "Buy groceries" } },
        { id: "2", fields: { title: "Review request" } },
      ],
    });
    await adapter1.clear("tasks");
    await adapter1.dispose();

    const adapter2 = new IndexedDbAdapter({ dbName });
    try {
      const result = await adapter2.search({
        resource: "tasks",
        query: "groceries",
        fields: ["title"],
      });
      expect(result).toEqual([]);
    } finally {
      await adapter2.dispose();
    }
  });

  // TV-IDB-004: multiple resources in same adapter use separate IDBs
  it("isolates multiple resources — each resource uses a separate database", async () => {
    const dbName = freshDbName();
    const adapter = new IndexedDbAdapter({ dbName });

    try {
      await adapter.index({
        resource: "tasks",
        documents: [{ id: "1", fields: { title: "Task A" } }],
      });
      await adapter.index({
        resource: "notes",
        documents: [{ id: "1", fields: { title: "Note A" } }],
      });

      const taskResult = await adapter.search({ resource: "tasks", query: "Note" });
      expect(taskResult).toEqual([]);

      const noteResult = await adapter.search({ resource: "notes", query: "Task" });
      expect(noteResult).toEqual([]);
    } finally {
      await adapter.dispose();
    }
  });

  it("upsert correctly updates persisted data on cold restart", async () => {
    const dbName = freshDbName();

    const adapter1 = new IndexedDbAdapter({ dbName });
    await adapter1.index({
      resource: "tasks",
      documents: [{ id: "1", fields: { title: "old title" } }],
    });
    await adapter1.dispose();

    const adapter2 = new IndexedDbAdapter({ dbName });
    await adapter2.index({
      resource: "tasks",
      documents: [{ id: "1", fields: { title: "new title" } }],
    });
    await adapter2.dispose();

    const adapter3 = new IndexedDbAdapter({ dbName });
    try {
      const oldResult = await adapter3.search({ resource: "tasks", query: "old", fields: ["title"] });
      expect(oldResult).toEqual([]);

      const newResult = await adapter3.search({ resource: "tasks", query: "new", fields: ["title"] });
      expect(newResult).toContain("1");
    } finally {
      await adapter3.dispose();
    }
  });

  it("supports fuzzy search on persisted index", async () => {
    const dbName = freshDbName();
    const adapter = new IndexedDbAdapter({ dbName });
    try {
      await adapter.index({
        resource: "tasks",
        documents: [{ id: "1", fields: { title: "groceries" } }],
      });
      const result = await adapter.search({
        resource: "tasks",
        query: "groceris",
        fuzzy: true,
      });
      expect(result).toContain("1");
    } finally {
      await adapter.dispose();
    }
  });

  it("supports fieldBoosts for ranking", async () => {
    const dbName = freshDbName();
    const adapter = new IndexedDbAdapter({ dbName });
    try {
      await adapter.index({
        resource: "items",
        documents: [
          { id: "A", fields: { title: "report", body: "quarterly data" } },
          { id: "B", fields: { title: "quarterly data", body: "report" } },
        ],
      });
      const result = await adapter.search({
        resource: "items",
        query: "report",
        fieldBoosts: { title: 5, body: 1 },
        limit: 10,
      });
      expect(result[0]).toBe("A");
    } finally {
      await adapter.dispose();
    }
  });

  it("indexes >10k documents via deterministic chunking", async () => {
    const dbName = freshDbName();
    const adapter = new IndexedDbAdapter({ dbName });
    try {
      const documents = Array.from({ length: 12000 }, (_, i) => ({
        id: `d${i}`,
        fields: { title: `doc ${i}` },
      }));
      await adapter.index({ resource: "bulk", documents });
      const result = await adapter.search({
        resource: "bulk",
        query: "doc 11999",
        fields: ["title"],
      });
      expect(result).toContain("d11999");
    } finally {
      await adapter.dispose();
    }
  });

  it("throws DFQL_ABORTED when indexing with an aborted signal", async () => {
    const adapter = new IndexedDbAdapter({ dbName: freshDbName() });
    const controller = new AbortController();
    controller.abort();
    await expect(
      adapter.index({
        resource: "tasks",
        documents: [{ id: "1", fields: { title: "hello" } }],
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SearchAdapterError);
    await expect(
      adapter.index({
        resource: "tasks",
        documents: [{ id: "1", fields: { title: "hello" } }],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "DFQL_ABORTED" });
    await adapter.dispose();
  });

  it("throws DFQL_ABORTED when searchAll signal is aborted", async () => {
    const adapter = new IndexedDbAdapter({ dbName: freshDbName() });
    await adapter.index({
      resource: "tasks",
      documents: [{ id: "1", fields: { title: "hello report" } }],
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      adapter.searchAll({
        query: "report",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "DFQL_ABORTED" });

    await adapter.dispose();
  });
});

describe("IndexedDbAdapter — prefix search", () => {
  // TV-IDB-001: prefix: true matches partial terms
  it("TV-IDB-001: prefix: true finds documents matching partial query", async () => {
    const adapter = new IndexedDbAdapter({ dbName: freshDbName() });
    try {
      await adapter.index({
        resource: "r",
        documents: [{ id: "1", fields: { text: "testing" } }],
      });
      const result = await adapter.search({
        resource: "r",
        query: "test",
        prefix: true,
      });
      expect(result).toContain("1");
    } finally {
      await adapter.dispose();
    }
  });

  // TV-IDB-002: construct-time defaults.prefix applied
  it("TV-IDB-002: construct-time defaults.prefix applied when param omitted", async () => {
    const adapter = new IndexedDbAdapter({ dbName: freshDbName(), defaults: { prefix: true } });
    try {
      await adapter.index({
        resource: "r",
        documents: [{ id: "1", fields: { text: "hello world" } }],
      });
      const result = await adapter.search({
        resource: "r",
        query: "hel",
      });
      expect(result).toContain("1");
    } finally {
      await adapter.dispose();
    }
  });

  it("TV-IDB-CAP: capabilities include prefix: true", () => {
    const adapter = new IndexedDbAdapter();
    expect(adapter.capabilities.prefix).toBe(true);
  });
});
