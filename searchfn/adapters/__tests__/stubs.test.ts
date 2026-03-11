import { describe, it, expect } from "vitest";
import type { SearchAdapter } from "../src/types";
import { MeilisearchAdapter } from "../src/meilisearch";
import { ElasticsearchAdapter } from "../src/elasticsearch";
import { PostgresAdapter } from "../src/postgres";

const STUB_CONFIGS = [
  {
    name: "MeilisearchAdapter",
    create: () => new MeilisearchAdapter({ host: "http://localhost:7700" }),
    label: "MeilisearchAdapter: not implemented",
  },
  {
    name: "ElasticsearchAdapter",
    create: () => new ElasticsearchAdapter({ node: "http://localhost:9200" }),
    label: "ElasticsearchAdapter: not implemented",
  },
  {
    name: "PostgresAdapter",
    create: () => new PostgresAdapter({ connectionString: "postgres://localhost/test" }),
    label: "PostgresAdapter: not implemented",
  },
];

describe("External adapter stubs", () => {
  for (const config of STUB_CONFIGS) {
    describe(config.name, () => {
      it("satisfies the SearchAdapter interface", () => {
        const adapter: SearchAdapter = config.create();
        expect(adapter.name).toBeDefined();
        expect(typeof adapter.index).toBe("function");
        expect(typeof adapter.search).toBe("function");
        expect(typeof adapter.remove).toBe("function");
        expect(typeof adapter.clear).toBe("function");
      });

      it("throws 'not implemented' on index()", async () => {
        const adapter = config.create();
        await expect(adapter.index({ resource: "r", documents: [] })).rejects.toThrow(config.label);
      });

      it("throws 'not implemented' on search()", async () => {
        const adapter = config.create();
        await expect(adapter.search({ resource: "r", query: "q" })).rejects.toThrow(config.label);
      });

      it("throws 'not implemented' on remove()", async () => {
        const adapter = config.create();
        await expect(adapter.remove({ resource: "r", ids: [] })).rejects.toThrow(config.label);
      });

      it("throws 'not implemented' on clear()", async () => {
        const adapter = config.create();
        await expect(adapter.clear("r")).rejects.toThrow(config.label);
      });

      it("throws 'not implemented' on searchAll()", async () => {
        const adapter = config.create();
        await expect(adapter.searchAll!({ query: "q" })).rejects.toThrow(config.label);
      });

      it("throws 'not implemented' on initialize()", async () => {
        const adapter = config.create();
        await expect(adapter.initialize!({ resources: [] })).rejects.toThrow(config.label);
      });

      it("throws 'not implemented' on dispose()", async () => {
        const adapter = config.create();
        await expect(adapter.dispose!()).rejects.toThrow(config.label);
      });
    });
  }
});
