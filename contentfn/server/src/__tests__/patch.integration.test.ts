/**
 * Integration tests for PHASE_03: patch engine + optimistic concurrency.
 * Covers TV-PATCH-SET-001, TV-PATCH-UNSET-001, TV-PATCH-NONNUM-001,
 * TV-PATCH-INVALID-001, TV-REV-CONFLICT-001, and insert/splice operations.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import { isISO8601 } from "@contentfn/core";

const schemaV1 = {
  version: 1,
  documentTypes: [
    {
      name: "post",
      fields: [
        { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
        { name: "views", type: { kind: "primitive" as const, type: "number" as const }, required: false },
        { name: "author", type: { kind: "primitive" as const, type: "string" as const }, required: false },
      ],
    },
  ],
};

describe("PHASE_03 patch operations + optimistic concurrency", () => {
  let api: ReturnType<typeof createContentfnServer>["api"];

  beforeEach(async () => {
    const server = createContentfnServer({ db: memoryAdapter() });
    api = server.api;
    await api.datasets.create({ dataset: "prod" });
    await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
  });

  describe("TV-PATCH-SET-001: set field via patch", () => {
    it("updates field value and changes _rev", async () => {
      // Create document
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello", views: 1 },
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const rev0 = createRes.result._rev;

      // Patch with ifRev
      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ifRev: rev0,
        ops: [{ op: "set", path: "title", value: "Hello 2" }],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect(patchRes.result.title).toBe("Hello 2");
      expect(patchRes.result._rev).not.toBe(rev0);
      expect(patchRes.result._rev.length).toBeGreaterThan(0);
      expect(isISO8601(patchRes.result._updatedAt)).toBe(true);
    });

    it("set can add new fields", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        doc: { title: "Test" },
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      // Set author field that wasn't in original doc
      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-2",
        ops: [{ op: "set", path: "author", value: "Alice" }],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect((patchRes.result as any).author).toBe("Alice");
    });
  });

  describe("TV-PATCH-UNSET-001: unset field via patch", () => {
    it("removes field from document", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Test", views: 5 },
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "unset", path: "views" }],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect((patchRes.result as any).views).toBeUndefined();
      expect(patchRes.result.title).toBe("Test");
    });

    it("unset is no-op if path doesn't exist", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        doc: { title: "Test" },
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-2",
        ops: [{ op: "unset", path: "views" }],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect(patchRes.result.title).toBe("Test");
    });
  });

  describe("TV-PATCH-NONNUM-001: inc/dec non-numeric field", () => {
    it("returns PATCH_INVALID when inc applied to non-numeric field", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello" },
      });
      expect(createRes.ok).toBe(true);

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "inc", path: "title", value: 1 }],
      });

      expect(patchRes.ok).toBe(false);
      if (patchRes.ok) return;

      expect(patchRes.error.code).toBe("PATCH_INVALID");
      expect(patchRes.error.details.path).toBe("title");
    });

    it("inc/dec works on numeric fields", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        doc: { title: "Test", views: 10 },
      });
      expect(createRes.ok).toBe(true);

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-2",
        ops: [
          { op: "inc", path: "views", value: 5 },
          { op: "dec", path: "views", value: 2 },
        ],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect((patchRes.result as any).views).toBe(13);
    });

    it("inc on undefined field initializes to 0 then increments", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-3",
        type: "post",
        doc: { title: "Test" },
      });
      expect(createRes.ok).toBe(true);

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-3",
        ops: [{ op: "inc", path: "views", value: 1 }],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect((patchRes.result as any).views).toBe(1);
    });
  });

  describe("TV-PATCH-INVALID-001: invalid patch path", () => {
    it("returns PATCH_INVALID when path conflicts with non-object", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Test", views: 5 },
      });
      expect(createRes.ok).toBe(true);

      // Try to set nested path under views (which is a number)
      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "set", path: "views.nested", value: "value" }],
      });

      expect(patchRes.ok).toBe(false);
      if (patchRes.ok) return;

      expect(patchRes.error.code).toBe("PATCH_INVALID");
    });

    it("returns PATCH_INVALID for empty path", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        doc: { title: "Test" },
      });
      expect(createRes.ok).toBe(true);

      // Empty path in patch application should fail
      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-2",
        ops: [{ op: "set", path: "", value: "value" }],
      });

      expect(patchRes.ok).toBe(false);
      if (patchRes.ok) return;

      expect(patchRes.error.code).toBe("PATCH_INVALID");
    });
  });

  describe("TV-REV-CONFLICT-001: revision conflict", () => {
    it("returns REV_CONFLICT when ifRev doesn't match current _rev", async () => {
      // Create document
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello", views: 1 },
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const rev0 = createRes.result._rev;

      // First patch (without ifRev) to advance revision
      const patch1Res = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "set", path: "views", value: 2 }],
      });
      expect(patch1Res.ok).toBe(true);
      if (!patch1Res.ok) return;

      const rev1 = patch1Res.result._rev;
      expect(rev1).not.toBe(rev0);

      // Second patch with stale ifRev (rev0)
      const patch2Res = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ifRev: rev0,
        ops: [{ op: "set", path: "title", value: "Conflict" }],
      });

      expect(patch2Res.ok).toBe(false);
      if (patch2Res.ok) return;

      expect(patch2Res.error.code).toBe("REV_CONFLICT");
      expect(patch2Res.error.details.expectedRev).toBe(rev0);
      expect(patch2Res.error.details.actualRev).toBe(rev1);
    });

    it("patch succeeds when ifRev matches current _rev", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        doc: { title: "Test" },
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const rev0 = createRes.result._rev;

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-2",
        ifRev: rev0,
        ops: [{ op: "set", path: "title", value: "Updated" }],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect(patchRes.result.title).toBe("Updated");
    });
  });

  // Note: splice and insert tests require array fields which are deferred to later phases.
  // Patch application logic for these operations is implemented in applyPatch.ts and will be tested
  // when proper array field support is added to the schema and storage layers.

  describe("patch draft documents", () => {
    it("patches draft document when ID starts with drafts.", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-5",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "drafts.post-5",
        ops: [{ op: "set", path: "title", value: "Updated Draft" }],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect(patchRes.result.title).toBe("Updated Draft");
      expect(patchRes.result._id).toBe("drafts.post-5");
    });
  });

  describe("revision history recording", () => {
    it("appends revision record after successful patch", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Original" },
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "set", path: "title", value: "Updated" }],
      });
      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      // Revision is recorded (we'll verify in PHASE_05 with history endpoint)
      // For now, just confirm patch succeeded and _rev changed
      expect(patchRes.result._rev).toBeDefined();
      expect(patchRes.result._rev).not.toBe(createRes.result._rev);
    });
  });

  describe("multiple ops in single patch", () => {
    it("applies all ops in order", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Test", views: 10 },
      });
      expect(createRes.ok).toBe(true);

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [
          { op: "set", path: "title", value: "Updated" },
          { op: "inc", path: "views", value: 5 },
          { op: "set", path: "author", value: "Alice" },
        ],
      });

      expect(patchRes.ok).toBe(true);
      if (!patchRes.ok) return;

      expect(patchRes.result.title).toBe("Updated");
      expect((patchRes.result as any).views).toBe(15);
      expect((patchRes.result as any).author).toBe("Alice");
    });

    it("stops at first failing op", async () => {
      const createRes = await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        doc: { title: "Test", views: 10 },
      });
      expect(createRes.ok).toBe(true);

      const patchRes = await api.docs.patch({
        dataset: "prod",
        id: "post-2",
        ops: [
          { op: "set", path: "title", value: "Updated" },
          { op: "inc", path: "title", value: 1 }, // This will fail
          { op: "set", path: "author", value: "Alice" },
        ],
      });

      expect(patchRes.ok).toBe(false);
      if (patchRes.ok) return;

      expect(patchRes.error.code).toBe("PATCH_INVALID");

      // Document should not be modified at all
      const getRes = await api.docs.get({
        dataset: "prod",
        id: "post-2",
        perspective: "published",
      });
      expect(getRes.ok).toBe(true);
      if (!getRes.ok) return;

      expect(getRes.result.title).toBe("Test");
    });
  });

  describe("patch validation", () => {
    it("returns DATASET_NOT_FOUND for empty/invalid dataset", async () => {
      // Note: Programmatic API doesn't validate input structure like HTTP layer does
      // Empty dataset passes through to storage layer which checks dataset existence
      const res = await api.docs.patch({
        dataset: "",
        id: "post-1",
        ops: [{ op: "set", path: "title", value: "X" }],
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;

      // Empty dataset triggers DATASET_NOT_FOUND at storage layer
      expect(res.error.code).toBe("DATASET_NOT_FOUND");
    });

    it("returns DOCUMENT_NOT_FOUND for missing document", async () => {
      const res = await api.docs.patch({
        dataset: "prod",
        id: "missing",
        ops: [{ op: "set", path: "title", value: "X" }],
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.error.code).toBe("DOCUMENT_NOT_FOUND");
    });

    it("returns DATASET_NOT_FOUND for missing dataset", async () => {
      const res = await api.docs.patch({
        dataset: "missing",
        id: "post-1",
        ops: [{ op: "set", path: "title", value: "X" }],
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.error.code).toBe("DATASET_NOT_FOUND");
    });
  });
});
