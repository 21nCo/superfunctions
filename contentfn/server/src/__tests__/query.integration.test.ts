import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
import type { CfqlQuery } from "@contentfn/core";
import { datasetCreate } from "../storage/datasets.js";
import { schemaUpsert } from "../storage/schemaStorage.js";
import { docCreate } from "../storage/docs.js";
import { executeCfql } from "../query/executeCfql.js";

const schemaV1 = {
  version: 1,
  documentTypes: [
    {
      name: "author",
      fields: [{ name: "name", type: { kind: "primitive" as const, type: "string" as const }, required: true }],
    },
    {
      name: "post",
      fields: [
        { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
        { name: "views", type: { kind: "primitive" as const, type: "number" as const }, required: false },
        { name: "author", type: { kind: "reference" as const, to: ["author"] }, required: false },
        { name: "body", type: { kind: "richtext" as const }, required: false },
        { name: "heroImage", type: { kind: "asset" as const, assetType: "image" as const }, required: false },
      ],
    },
  ],
};

describe("Query (CFQL) integration tests", () => {
  let db: Adapter;

  beforeAll(async () => {
    db = memoryAdapter();
    const dsRes = await datasetCreate({ db }, { dataset: "prod" });
    expect(dsRes.ok).toBe(true);
    const schRes = await schemaUpsert({ db }, { dataset: "prod", schema: schemaV1 });
    expect(schRes.ok).toBe(true);
  });

  afterAll(async () => {
    await db.close();
  });

  describe("TV-QRY-001: filter + order + limit", () => {
    it("filters, orders, and limits results", async () => {
      const c1 = await docCreate(
        { db },
        { dataset: "prod", id: "post-1", type: "post", doc: { title: "A" }, asDraft: false }
      );
      expect(c1.ok).toBe(true);

      const c2 = await docCreate(
        { db },
        { dataset: "prod", id: "post-2", type: "post", doc: { title: "B" }, asDraft: false }
      );
      expect(c2.ok).toBe(true);

      const result = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "title", op: "in", value: ["A", "B"] },
          orderBy: [{ field: "title", direction: "asc" }],
          limit: 1,
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.data.length).toBe(1);
      expect(result.result.data[0].title).toBe("A");
      expect(result.result.nextCursor).not.toBeNull();
    });
  });

  describe("TV-QRY-PROJECTION-001: projection fields", () => {
    it("returns only projected fields plus system fields", async () => {
      const c1 = await docCreate(
        { db },
        { dataset: "prod", id: "post-proj-1", type: "post", doc: { title: "Projected", views: 100 }, asDraft: false }
      );
      expect(c1.ok).toBe(true);

      const result = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          projection: { fields: ["_id", "title"] },
          orderBy: [{ field: "_id", direction: "asc" }],
          limit: 10,
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const doc = result.result.data.find((d) => d._id === "post-proj-1");
      expect(doc).toBeDefined();
      if (!doc) return;
      expect(doc._id).toBe("post-proj-1");
      expect(doc.title).toBe("Projected");
      expect("views" in doc).toBe(false);
    });
  });

  describe("TV-QRY-INVALID-001: invalid operator", () => {
    it("returns QUERY_INVALID for unknown operator", async () => {
      const result = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "title", op: "wat" as any, value: "A" },
        }
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("QUERY_INVALID");
      expect(result.error.details.path).toContain("filter.op");
    });
  });

  describe("TV-QRY-ORDER-DEFAULT-001: default ordering", () => {
    it("orders by _updatedAt desc, _id asc when orderBy is omitted", async () => {
      const c1 = await docCreate(
        { db },
        { dataset: "prod", id: "def-order-1", type: "post", doc: { title: "First" }, asDraft: false }
      );
      expect(c1.ok).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const c2 = await docCreate(
        { db },
        { dataset: "prod", id: "def-order-2", type: "post", doc: { title: "Second" }, asDraft: false }
      );
      expect(c2.ok).toBe(true);

      const result = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "_id", op: "in", value: ["def-order-1", "def-order-2"] },
          limit: 10,
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.data.length).toBe(2);
      expect(result.result.data[0]._id).toBe("def-order-2");
      expect(result.result.data[1]._id).toBe("def-order-1");
    });
  });

  describe("TV-QRY-ORDER-TIEBREAK-001: _id asc tie-break", () => {
    it("uses _id asc as tie-breaker when ordering field values are equal", async () => {
      const c1 = await docCreate(
        { db },
        { dataset: "prod", id: "tie-1", type: "post", doc: { title: "Tie", views: 10 }, asDraft: false }
      );
      expect(c1.ok).toBe(true);

      const c2 = await docCreate(
        { db },
        { dataset: "prod", id: "tie-2", type: "post", doc: { title: "Tie", views: 10 }, asDraft: false }
      );
      expect(c2.ok).toBe(true);

      const result = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "title", op: "eq", value: "Tie" },
          orderBy: [{ field: "views", direction: "asc" }],
          limit: 10,
        }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.data.length).toBeGreaterThanOrEqual(2);
      const ties = result.result.data.filter((d) => d.title === "Tie" && d.views === 10);
      expect(ties.length).toBe(2);
      expect(ties[0]._id).toBe("tie-1");
      expect(ties[1]._id).toBe("tie-2");
    });
  });

  describe("TV-QRY-CURSOR-001: cursor pagination", () => {
    it("paginates results with cursor", async () => {
      const c1 = await docCreate(
        { db },
        { dataset: "prod", id: "cursor-a", type: "post", doc: { title: "A" }, asDraft: false }
      );
      expect(c1.ok).toBe(true);

      const c2 = await docCreate(
        { db },
        { dataset: "prod", id: "cursor-b", type: "post", doc: { title: "B" }, asDraft: false }
      );
      expect(c2.ok).toBe(true);

      const c3 = await docCreate(
        { db },
        { dataset: "prod", id: "cursor-c", type: "post", doc: { title: "C" }, asDraft: false }
      );
      expect(c3.ok).toBe(true);

      const page1 = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "_id", op: "in", value: ["cursor-a", "cursor-b", "cursor-c"] },
          orderBy: [{ field: "title", direction: "asc" }],
          limit: 2,
        }
      );

      expect(page1.ok).toBe(true);
      if (!page1.ok) return;
      expect(page1.result.data.length).toBe(2);
      expect(page1.result.data[0]._id).toBe("cursor-a");
      expect(page1.result.data[1]._id).toBe("cursor-b");
      expect(page1.result.nextCursor).not.toBeNull();

      const page2 = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "_id", op: "in", value: ["cursor-a", "cursor-b", "cursor-c"] },
          orderBy: [{ field: "title", direction: "asc" }],
          limit: 2,
          cursor: page1.result.nextCursor,
        }
      );

      expect(page2.ok).toBe(true);
      if (!page2.ok) return;
      expect(page2.result.data.length).toBe(1);
      expect(page2.result.data[0]._id).toBe("cursor-c");
      expect(page2.result.nextCursor).toBeNull();
    });
  });

  describe("Determinism invariants", () => {
    it("returns identical results for repeated queries over same dataset state", async () => {
      const c1 = await docCreate(
        { db },
        { dataset: "prod", id: "det-1", type: "post", doc: { title: "Det1" }, asDraft: false }
      );
      expect(c1.ok).toBe(true);

      const c2 = await docCreate(
        { db },
        { dataset: "prod", id: "det-2", type: "post", doc: { title: "Det2" }, asDraft: false }
      );
      expect(c2.ok).toBe(true);

      const query: CfqlQuery = {
        dataset: "prod",
        types: ["post"],
        filter: { field: "_id", op: "in", value: ["det-1", "det-2"] },
        orderBy: [{ field: "title", direction: "asc" }],
        limit: 10,
      };

      const result1 = await executeCfql({ db }, query);
      const result2 = await executeCfql({ db }, query);
      const result3 = await executeCfql({ db }, query);

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(result3.ok).toBe(true);

      if (!result1.ok || !result2.ok || !result3.ok) return;

      expect(result1.result.data.length).toBe(result2.result.data.length);
      expect(result2.result.data.length).toBe(result3.result.data.length);

      for (let i = 0; i < result1.result.data.length; i++) {
        expect(result1.result.data[i]._id).toBe(result2.result.data[i]._id);
        expect(result2.result.data[i]._id).toBe(result3.result.data[i]._id);
      }

      expect(result1.result.nextCursor).toBe(result2.result.nextCursor);
      expect(result2.result.nextCursor).toBe(result3.result.nextCursor);
    });
  });
});
