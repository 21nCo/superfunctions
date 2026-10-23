import { describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";

describe("configured text search", () => {
  async function fixture(enabled: boolean) {
    const db = memoryAdapter();
    const server = createContentfnServer({ db, search: { enabled }, limits: { maxQueryLimit: 2 } });
    await server.api.datasets.create({ dataset: "prod" });
    await server.api.schema.upsert({ dataset: "prod", schema: { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" } }] }] } });
    for (const [id, title] of [["b", "Blue café"], ["a", "CAFÉ blue sky"], ["c", "blueberry café"]]) {
      await server.api.docs.create({ dataset: "prod", id, type: "post", doc: { title } });
    }
    return { db, server };
  }
  it("matches complete Unicode tokens and uses stable pagination", async () => {
    const { db, server } = await fixture(true);
    try {
      const query = { dataset: "prod", filter: { field: "title", op: "match" as const, value: "BLUE CAFÉ" }, orderBy: [{ field: "_id", direction: "asc" as const }], limit: 1 };
      const first = await server.api.docs.list(query);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.result.data.map(d => d._id)).toEqual(["a"]);
      const second = await server.api.docs.list({ ...query, cursor: first.result.nextCursor });
      expect(second.ok && second.result.data.map(d => d._id)).toEqual(["b"]);
      expect(second.ok && second.result.nextCursor).toBeNull();
    } finally { await db.close(); }
  });
  it("rejects disabled match even inside an otherwise matching OR", async () => {
    const { db, server } = await fixture(false);
    try {
      const result = await server.api.docs.list({ dataset: "prod", filter: { op: "or", filters: [{ field: "title", op: "is_not_null" }, { field: "title", op: "match", value: "blue" }] } });
      expect(result).toMatchObject({ ok: false, error: { code: "QUERY_INVALID" } });
    } finally { await db.close(); }
  });
  it("rejects noninteger limits and configured limit violations", async () => {
    const { db, server } = await fixture(true);
    try {
      expect(await server.api.docs.list({ dataset: "prod", limit: 1.5 })).toMatchObject({ ok: false, error: { code: "QUERY_INVALID" } });
      expect(await server.api.docs.list({ dataset: "prod", limit: 3 })).toMatchObject({ ok: false, error: { code: "QUERY_TOO_COMPLEX" } });
    } finally { await db.close(); }
  });
});
