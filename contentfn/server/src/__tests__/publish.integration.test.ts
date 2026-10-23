import { describe, it, expect, beforeEach } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import { isISO8601 } from "@contentfn/core";
import type { Adapter } from "@superfunctions/db";
import { CONTENTFN_TABLE_NAMES } from "../storage/schema.js";

const schemaV1 = {
  version: 1,
  documentTypes: [
    {
      name: "post",
      fields: [
        { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
        { name: "views", type: { kind: "primitive" as const, type: "number" as const }, required: false },
      ],
    },
  ],
};

describe("PHASE_04 publish/unpublish + event emission", () => {
  let api: ReturnType<typeof createContentfnServer>["api"];
  let db: Adapter;

  beforeEach(async () => {
    db = memoryAdapter();
    const server = createContentfnServer({ db });
    api = server.api;
    await api.datasets.create({ dataset: "prod" });
    await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
  });

  describe("TV-DOC-PUBLISH-001: publish draft to published", () => {
    it("publishes draft, sets _publishedAt, updates published doc, and emits doc.published event", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-3",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const publishRes = await api.docs.publish({
        dataset: "prod",
        id: "post-3",
      });

      expect(publishRes.ok).toBe(true);
      if (publishRes.ok) {
        expect(publishRes.result._id).toBe("post-3");
        expect(publishRes.result.title).toBe("Draft");
        expect(publishRes.result._publishedAt).toBeDefined();
        if (publishRes.result._publishedAt) {
          expect(isISO8601(publishRes.result._publishedAt)).toBe(true);
        }
      }

      const getPublished = await api.docs.get({
        dataset: "prod",
        id: "post-3",
        perspective: "published",
      });

      expect(getPublished.ok).toBe(true);
      if (getPublished.ok) {
        expect(getPublished.result.title).toBe("Draft");
        expect(getPublished.result._publishedAt).toBeDefined();
      }

      const events = await db.findMany({
        model: CONTENTFN_TABLE_NAMES.events,
        where: [
          { field: "dataset", operator: "eq" as const, value: "prod" },
          { field: "type", operator: "eq" as const, value: "doc.published" },
          { field: "docId", operator: "eq" as const, value: "post-3" },
        ],
      });

      expect(events.length).toBeGreaterThan(0);
      if (events.length > 0) {
        const evt = events[0] as { type: string; docId: string; rev: string };
        expect(evt.type).toBe("doc.published");
        expect(evt.docId).toBe("post-3");
        expect(typeof evt.rev).toBe("string");
      }
    });
  });

  describe("TV-DOC-PUBLISH-002: publish without draft", () => {
    it("returns DOCUMENT_NOT_FOUND when draft does not exist", async () => {
      const publishRes = await api.docs.publish({
        dataset: "prod",
        id: "post-404",
      });

      expect(publishRes.ok).toBe(false);
      if (!publishRes.ok) {
        expect(publishRes.error.code).toBe("DOCUMENT_NOT_FOUND");
      }
    });
  });

  describe("TV-DOC-UNPUBLISH-001: unpublish removes published only", () => {
    it("removes published doc, keeps draft, and emits doc.unpublished event", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-3",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });

      const publishRes = await api.docs.publish({
        dataset: "prod",
        id: "post-3",
      });

      expect(publishRes.ok).toBe(true);

      const unpublishRes = await api.docs.unpublish({
        dataset: "prod",
        id: "post-3",
      });

      expect(unpublishRes.ok).toBe(true);

      const getPublished = await api.docs.get({
        dataset: "prod",
        id: "post-3",
        perspective: "published",
      });

      expect(getPublished.ok).toBe(false);
      if (!getPublished.ok) {
        expect(getPublished.error.code).toBe("DOCUMENT_NOT_FOUND");
      }

      const getDraft = await api.docs.get({
        dataset: "prod",
        id: "drafts.post-3",
        perspective: "draft",
      });

      expect(getDraft.ok).toBe(true);
      if (getDraft.ok) {
        expect(getDraft.result._id).toBe("drafts.post-3");
        expect(getDraft.result.title).toBe("Draft");
      }

      const events = await db.findMany({
        model: CONTENTFN_TABLE_NAMES.events,
        where: [
          { field: "dataset", operator: "eq" as const, value: "prod" },
          { field: "type", operator: "eq" as const, value: "doc.unpublished" },
          { field: "docId", operator: "eq" as const, value: "post-3" },
        ],
      });

      expect(events.length).toBeGreaterThan(0);
      if (events.length > 0) {
        const evt = events[0] as { type: string; docId: string };
        expect(evt.type).toBe("doc.unpublished");
        expect(evt.docId).toBe("post-3");
      }
    });
  });

  describe("TV-DOC-PUBLISH-001 (optimistic concurrency)", () => {
    it("respects ifRev during publish", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-5",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const rev0 = createRes.result._rev;

      await api.docs.patch({
        dataset: "prod",
        id: "drafts.post-5",
        ops: [{ op: "set", path: "title", value: "Updated Draft" }],
      });

      const publishRes = await api.docs.publish({
        dataset: "prod",
        id: "post-5",
        ifRev: rev0,
      });

      expect(publishRes.ok).toBe(false);
      if (!publishRes.ok) {
        expect(publishRes.error.code).toBe("REV_CONFLICT");
        expect(publishRes.error.details.expectedRev).toBe(rev0);
        expect(publishRes.error.details.actualRev).toBeDefined();
      }
    });
  });
});
