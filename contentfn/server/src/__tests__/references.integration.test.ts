import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { Adapter } from "@superfunctions/db";
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
        { name: "relatedPost", type: { kind: "reference" as const, to: ["post"] }, required: false },
      ],
    },
  ],
};

describe("References (REF-001) integration tests", () => {
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

  describe("TV-REF-ENCODE-001: canonical reference shape round-trip", () => {
    it("stores and returns reference in canonical shape", async () => {
      const authorRes = await docCreate(
        { db },
        { dataset: "prod", id: "author-1", type: "author", doc: { name: "Ada" }, asDraft: false }
      );
      expect(authorRes.ok).toBe(true);

      const postRes = await docCreate(
        { db },
        {
          dataset: "prod",
          id: "post-10",
          type: "post",
          doc: {
            title: "With ref",
            author: { _type: "reference", _ref: "author-1", _weak: false },
          },
          asDraft: false,
        }
      );
      expect(postRes.ok).toBe(true);

      const queryRes = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "_id", op: "eq", value: "post-10" },
          limit: 1,
        }
      );

      expect(queryRes.ok).toBe(true);
      if (!queryRes.ok) return;

      const doc = queryRes.result.data[0];
      expect(doc._id).toBe("post-10");
      expect(doc.author).toEqual({
        _type: "reference",
        _ref: "author-1",
        _weak: false,
      });
    });
  });

  describe("TV-REF-EXPAND-001: expand reference", () => {
    it("expands reference to include projected referenced document", async () => {
      const authorRes = await docCreate(
        { db },
        { dataset: "prod", id: "author-2", type: "author", doc: { name: "Grace" }, asDraft: false }
      );
      expect(authorRes.ok).toBe(true);

      const postRes = await docCreate(
        { db },
        {
          dataset: "prod",
          id: "post-11",
          type: "post",
          doc: {
            title: "Expandable",
            author: { _type: "reference", _ref: "author-2", _weak: false },
          },
          asDraft: false,
        }
      );
      expect(postRes.ok).toBe(true);

      const queryRes = await executeCfql(
        { db },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "_id", op: "eq", value: "post-11" },
          projection: {
            fields: ["_id", "title"],
            expand: {
              authorDoc: { field: "author", projection: { fields: ["_id", "name"] } },
            },
          },
          limit: 1,
        }
      );

      expect(queryRes.ok).toBe(true);
      if (!queryRes.ok) return;

      const doc = queryRes.result.data[0];
      expect(doc._id).toBe("post-11");
      expect(doc.title).toBe("Expandable");
      expect(doc.authorDoc).toBeDefined();
      expect(doc.author).toBeUndefined();

      const authorDoc = doc.authorDoc as Record<string, unknown>;
      expect(authorDoc._id).toBe("author-2");
      expect(authorDoc.name).toBe("Grace");
    });
  });

  describe("TV-REF-EXPAND-002: expand depth exceeded", () => {
    it("returns QUERY_TOO_COMPLEX when expansion depth exceeds limit", async () => {
      const authorRes = await docCreate(
        { db },
        { dataset: "prod", id: "author-3", type: "author", doc: { name: "Alan" }, asDraft: false }
      );
      expect(authorRes.ok).toBe(true);

      const postRes = await docCreate(
        { db },
        {
          dataset: "prod",
          id: "post-12",
          type: "post",
          doc: {
            title: "Deep expansion",
            author: { _type: "reference", _ref: "author-3", _weak: false },
          },
          asDraft: false,
        }
      );
      expect(postRes.ok).toBe(true);

      const queryRes = await executeCfql(
        { db, maxExpandDepth: 1 },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "_id", op: "eq", value: "post-12" },
          projection: {
            fields: ["_id", "title", "author"],
            expand: {
              authorDoc: {
                field: "author",
                projection: {
                  fields: ["_id", "name"],
                  expand: {
                    nestedExpand: { field: "author", projection: { fields: ["_id"] } },
                  },
                },
              },
            },
          },
          limit: 1,
        }
      );

      expect(queryRes.ok).toBe(false);
      if (queryRes.ok) return;
      expect(queryRes.error.code).toBe("QUERY_TOO_COMPLEX");
    });
  });

  describe("TV-REF-CYCLE-001: cycle-safe expansion", () => {
    it("handles cycles deterministically without infinite recursion", async () => {
      const postARes = await docCreate(
        { db },
        {
          dataset: "prod",
          id: "post-a",
          type: "post",
          doc: {
            title: "Post A",
          },
          asDraft: false,
        }
      );
      expect(postARes.ok).toBe(true);

      const postBRes = await docCreate(
        { db },
        {
          dataset: "prod",
          id: "post-b",
          type: "post",
          doc: {
            title: "Post B",
            relatedPost: { _type: "reference", _ref: "post-a", _weak: false },
          },
          asDraft: false,
        }
      );
      expect(postBRes.ok).toBe(true);

      const queryRes = await executeCfql(
        { db, maxExpandDepth: 3 },
        {
          dataset: "prod",
          types: ["post"],
          filter: { field: "_id", op: "eq", value: "post-a" },
          projection: {
            fields: ["_id", "title", "relatedPost"],
            expand: {
              relatedDoc: {
                field: "relatedPost",
                projection: {
                  fields: ["_id", "title", "relatedPost"],
                  expand: {
                    nestedRelated: {
                      field: "relatedPost",
                      projection: { fields: ["_id", "title"] },
                    },
                  },
                },
              },
            },
          },
          limit: 1,
        }
      );

      expect(queryRes.ok).toBe(true);
      if (!queryRes.ok) return;

      const doc = queryRes.result.data[0];
      expect(doc._id).toBe("post-a");
      expect(doc.title).toBe("Post A");
    });
  });
});
