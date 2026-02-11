/**
 * Integration tests for PHASE_02: document create/get/delete + perspectives.
 * Covers TV-DOC-CREATE-001/002, TV-DOC-GET-001/002, TV-DOC-DELETE-001,
 * TV-DOC-DRAFT-ID-001, TV-DOC-PERSPECTIVE-001/002.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import { isISO8601 } from "@contentfn/core";

const schemaV1 = {
  version: 1,
  documentTypes: [
    {
      name: "author",
      fields: [
        { name: "name", type: { kind: "primitive" as const, type: "string" as const }, required: true },
      ],
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

describe("PHASE_02 docs create/get/delete + perspectives", () => {
  let api: ReturnType<typeof createContentfnServer>["api"];

  beforeEach(async () => {
    const server = createContentfnServer({ db: memoryAdapter() });
    api = server.api;
    await api.datasets.create({ dataset: "prod" });
    await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
  });

  describe("TV-DOC-CREATE-001: create published doc", () => {
    it("creates published doc with system fields and ISO timestamps", async () => {
      const res = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello", views: 1 },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result._id).toBe("post-1");
        expect(res.result._type).toBe("post");
        expect(typeof res.result._rev).toBe("string");
        expect(res.result._rev.length).toBeGreaterThan(0);
        expect(isISO8601(res.result._createdAt)).toBe(true);
        expect(isISO8601(res.result._updatedAt)).toBe(true);
        expect(res.result.title).toBe("Hello");
        expect(res.result.views).toBe(1);
        // Published docs should have _publishedAt
        expect(res.result._publishedAt).toBeDefined();
        if (res.result._publishedAt) {
          expect(isISO8601(res.result._publishedAt)).toBe(true);
        }
      }
    });
  });

  describe("TV-DOC-CREATE-002: missing required field", () => {
    it("returns VALIDATION_FAILED when required field is missing", async () => {
      const res = await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        doc: { views: 1 },
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
        expect(res.error.details.path).toContain("title");
      }
    });
  });

  describe("TV-DOC-GET-001: get existing doc", () => {
    it("returns document after create", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello" },
      });

      const res = await api.docs.get({
        dataset: "prod",
        id: "post-1",
        perspective: "published",
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result._id).toBe("post-1");
        expect(res.result.title).toBe("Hello");
      }
    });
  });

  describe("TV-DOC-GET-002: get missing doc", () => {
    it("returns DOCUMENT_NOT_FOUND for missing doc", async () => {
      const res = await api.docs.get({
        dataset: "prod",
        id: "missing",
        perspective: "published",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DOCUMENT_NOT_FOUND");
      }
    });
  });

  describe("TV-DOC-DELETE-001: delete doc", () => {
    it("deletes doc and subsequent get returns DOCUMENT_NOT_FOUND", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello" },
      });

      const delRes = await api.docs.delete({
        dataset: "prod",
        id: "post-1",
        purge: true,
      });
      expect(delRes.ok).toBe(true);

      const getRes = await api.docs.get({
        dataset: "prod",
        id: "post-1",
        perspective: "published",
      });
      expect(getRes.ok).toBe(false);
      if (!getRes.ok) {
        expect(getRes.error.code).toBe("DOCUMENT_NOT_FOUND");
      }
    });
  });

  describe("TV-DOC-DRAFT-ID-001: create draft uses drafts. prefix", () => {
    it("creates draft with drafts. prefix", async () => {
      const res = await api.docs.create({
        dataset: "prod",
        id: "post-3",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result._id).toBe("drafts.post-3");
        expect(res.result.title).toBe("Draft");
        // Drafts should NOT have _publishedAt
        expect(res.result._publishedAt).toBeUndefined();
      }
    });
  });

  describe("TV-DOC-PERSPECTIVE-001: draft perspective returns draft only", () => {
    it("gets draft using draft perspective", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-3",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });

      const res = await api.docs.get({
        dataset: "prod",
        id: "drafts.post-3",
        perspective: "draft",
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result._id).toBe("drafts.post-3");
        expect(res.result.title).toBe("Draft");
      }
    });
  });

  describe("TV-DOC-PERSPECTIVE-002: draft perspective missing", () => {
    it("returns DOCUMENT_NOT_FOUND when draft does not exist", async () => {
      const res = await api.docs.get({
        dataset: "prod",
        id: "drafts.post-999",
        perspective: "draft",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DOCUMENT_NOT_FOUND");
      }
    });
  });

  describe("API-002: envelope correctness", () => {
    it("success responses always include ok:true and result", async () => {
      const res = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Test" },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result).toBeDefined();
        expect((res as any).error).toBeUndefined();
      }
    });

    it("failure responses always include ok:false and error", async () => {
      const res = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: {}, // missing required field
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBeDefined();
        expect(res.error.code).toBeDefined();
        expect(res.error.message).toBeDefined();
        expect(res.error.details).toBeDefined();
        expect((res as any).result).toBeUndefined();
      }
    });
  });

  describe("perspective isolation", () => {
    it("published perspective does not return draft docs", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-5",
        type: "post",
        asDraft: true,
        doc: { title: "Draft Only" },
      });

      const res = await api.docs.get({
        dataset: "prod",
        id: "drafts.post-5",
        perspective: "published",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DOCUMENT_NOT_FOUND");
      }
    });

    it("draft perspective does not return published docs", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-6",
        type: "post",
        asDraft: false,
        doc: { title: "Published Only" },
      });

      const res = await api.docs.get({
        dataset: "prod",
        id: "post-6",
        perspective: "draft",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DOCUMENT_NOT_FOUND");
      }
    });
  });

  describe("delete with purge semantics", () => {
    it("purge=false deletes only published", async () => {
      // Create both draft and published with same base ID
      await api.docs.create({
        dataset: "prod",
        id: "post-7",
        type: "post",
        asDraft: false,
        doc: { title: "Published" },
      });
      await api.docs.create({
        dataset: "prod",
        id: "post-7",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });

      // Delete published only
      const delRes = await api.docs.delete({
        dataset: "prod",
        id: "post-7",
        purge: false,
      });
      expect(delRes.ok).toBe(true);

      // Published should be gone
      const pubRes = await api.docs.get({
        dataset: "prod",
        id: "post-7",
        perspective: "published",
      });
      expect(pubRes.ok).toBe(false);

      // Draft should still exist
      const draftRes = await api.docs.get({
        dataset: "prod",
        id: "drafts.post-7",
        perspective: "draft",
      });
      expect(draftRes.ok).toBe(true);
    });

    it("purge=true deletes both perspectives", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-8",
        type: "post",
        asDraft: false,
        doc: { title: "Published" },
      });
      await api.docs.create({
        dataset: "prod",
        id: "post-8",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });

      const delRes = await api.docs.delete({
        dataset: "prod",
        id: "post-8",
        purge: true,
      });
      expect(delRes.ok).toBe(true);

      const pubRes = await api.docs.get({
        dataset: "prod",
        id: "post-8",
        perspective: "published",
      });
      expect(pubRes.ok).toBe(false);

      const draftRes = await api.docs.get({
        dataset: "prod",
        id: "drafts.post-8",
        perspective: "draft",
      });
      expect(draftRes.ok).toBe(false);
    });
  });
});
