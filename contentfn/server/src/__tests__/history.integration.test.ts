import { describe, it, expect, beforeEach } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import { isISO8601 } from "@contentfn/core";
import type { Adapter } from "@superfunctions/db";

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

describe("PHASE_05 history + restore", () => {
  let api: ReturnType<typeof createContentfnServer>["api"];
  let db: Adapter;

  beforeEach(async () => {
    db = memoryAdapter();
    const server = createContentfnServer({ db });
    api = server.api;
    await api.datasets.create({ dataset: "prod" });
    await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
  });

  describe("TV-HIST-LIST-001: list history", () => {
    it("lists revision history in reverse chronological order after mutations", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello" },
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      await new Promise(resolve => setTimeout(resolve, 5));

      await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "set", path: "title", value: "Hello 2" }],
      });

      await new Promise(resolve => setTimeout(resolve, 5));

      await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "set", path: "title", value: "Hello 3" }],
      });

      const historyRes = await api.docs.history({
        dataset: "prod",
        id: "post-1",
        limit: 10,
      });

      expect(historyRes.ok).toBe(true);
      if (historyRes.ok) {
        expect(historyRes.result.revisions.length).toBeGreaterThanOrEqual(2);

        for (const rev of historyRes.result.revisions) {
          expect(rev._id).toBe("post-1");
          expect(rev._type).toBe("post");
          expect(typeof rev._rev).toBe("string");
          expect(isISO8601(rev._updatedAt)).toBe(true);
        }

        const latest = historyRes.result.revisions[0];
        expect(latest.title).toBe("Hello 3");
      }
    });

    it("supports cursor pagination", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        doc: { title: "A" },
      });

      for (let i = 0; i < 5; i++) {
        await api.docs.patch({
          dataset: "prod",
          id: "post-2",
          ops: [{ op: "set", path: "title", value: `Title ${i}` }],
        });
      }

      const page1 = await api.docs.history({
        dataset: "prod",
        id: "post-2",
        limit: 2,
      });

      expect(page1.ok).toBe(true);
      if (!page1.ok) return;

      expect(page1.result.revisions.length).toBe(2);
      expect(page1.result.nextCursor).not.toBeNull();

      if (page1.result.nextCursor) {
        const page2 = await api.docs.history({
          dataset: "prod",
          id: "post-2",
          limit: 2,
          cursor: page1.result.nextCursor,
        });

        expect(page2.ok).toBe(true);
        if (page2.ok) {
          expect(page2.result.revisions.length).toBeGreaterThan(0);
          const firstPage1Rev = page1.result.revisions[0]._rev;
          const firstPage2Rev = page2.result.revisions[0]._rev;
          expect(firstPage1Rev).not.toBe(firstPage2Rev);
        }
      }
    });
  });

  describe("TV-RESTORE-001: restore revision writes draft", () => {
    it("restores an older revision to draft perspective with new _rev", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Version 1" },
      });

      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const historyAfterCreate = await api.docs.history({
        dataset: "prod",
        id: "post-1",
        limit: 10,
      });

      expect(historyAfterCreate.ok).toBe(true);
      if (!historyAfterCreate.ok) return;

      const oldRev = historyAfterCreate.result.revisions[0]._rev;

      await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "set", path: "title", value: "Version 2" }],
      });

      const historyAfterPatch = await api.docs.history({
        dataset: "prod",
        id: "post-1",
        limit: 10,
      });

      expect(historyAfterPatch.ok).toBe(true);
      if (!historyAfterPatch.ok) return;
      expect(historyAfterPatch.result.revisions.length).toBeGreaterThanOrEqual(2);

      const restoreRes = await api.docs.restore({
        dataset: "prod",
        id: "post-1",
        rev: oldRev,
      });

      expect(restoreRes.ok).toBe(true);
      if (restoreRes.ok) {
        expect(restoreRes.result._id).toBe("drafts.post-1");
        expect(restoreRes.result.title).toBe("Version 1");
        expect(restoreRes.result._rev).not.toBe(oldRev);
        expect(isISO8601(restoreRes.result._updatedAt)).toBe(true);
      }

      const getDraft = await api.docs.get({
        dataset: "prod",
        id: "drafts.post-1",
        perspective: "draft",
      });

      expect(getDraft.ok).toBe(true);
      if (getDraft.ok) {
        expect(getDraft.result.title).toBe("Version 1");
      }

      const getPublished = await api.docs.get({
        dataset: "prod",
        id: "post-1",
        perspective: "published",
      });

      expect(getPublished.ok).toBe(true);
      if (getPublished.ok) {
        expect(getPublished.result.title).toBe("Version 2");
      }
    });
  });

  describe("TV-RESTORE-002: restore unknown revision", () => {
    it("returns VALIDATION_FAILED when revision does not exist", async () => {
      await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello" },
      });

      const restoreRes = await api.docs.restore({
        dataset: "prod",
        id: "post-1",
        rev: "does-not-exist",
      });

      expect(restoreRes.ok).toBe(false);
      if (!restoreRes.ok) {
        expect(restoreRes.error.code).toBe("VALIDATION_FAILED");
        expect(restoreRes.error.message).toContain("not found");
      }
    });
  });
});

it("retains restorable snapshots for unpublish and delete mutations", async () => {
  const server = createContentfnServer({ db: memoryAdapter() });
  await server.api.datasets.create({ dataset: "history" });
  await server.api.schema.upsert({ dataset: "history", schema: { version: 1, documentTypes: [{ name: "post", fields: [] }] } });
  await server.api.docs.create({ dataset: "history", id: "post", type: "post", doc: {}, asDraft: false });
  await server.api.docs.unpublish({ dataset: "history", id: "post" });
  const afterUnpublish = await server.api.docs.history({ dataset: "history", id: "post" });
  expect(afterUnpublish.ok).toBe(true);
  if (!afterUnpublish.ok) return;
  expect(afterUnpublish.result.revisions).toHaveLength(2);
  await server.api.docs.create({ dataset: "history", id: "post", type: "post", doc: {}, asDraft: false });
  await server.api.docs.delete({ dataset: "history", id: "post" });
  const afterDelete = await server.api.docs.history({ dataset: "history", id: "post" });
  expect(afterDelete.ok).toBe(true);
  if (!afterDelete.ok) return;
  expect(afterDelete.result.revisions).toHaveLength(4);
});
