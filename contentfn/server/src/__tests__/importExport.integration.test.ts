import { describe, it, expect, beforeEach } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import type { Adapter } from "@superfunctions/db";
import type { ContentfnExportArtifact } from "../importExport/format.js";

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
      ],
    },
  ],
};

describe("PHASE_11 import/export", () => {
  let server: ReturnType<typeof createContentfnServer>;
  let api: ReturnType<typeof createContentfnServer>["api"];
  let db: Adapter;

  beforeEach(async () => {
    db = memoryAdapter();
    server = createContentfnServer({ db });
    api = server.api;
  });

  describe("TV-IMP-EXPORT-001: export dataset artifact", () => {
    it("exports artifact with schema + documents + assets metadata + revisions", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        asDraft: true,
        doc: { title: "Hello" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-1" });

      await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        asDraft: true,
        doc: { title: "Draft Only" },
      });

      await api.assets.upload({
        dataset: "prod",
        filename: "hello.txt",
        contentType: "text/plain",
        bytesBase64: "aGVsbG8=",
      });

      const res = await api.datasets.export({ dataset: "prod" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const artifact = res.result.artifact;
      expect(artifact.formatVersion).toBe(1);
      expect(artifact.dataset).toBe("prod");
      expect(typeof artifact.exportedAt).toBe("string");

      expect(artifact.schema).not.toBeNull();
      expect(artifact.schema!.version).toBe(1);
      expect(artifact.schema!.schemaJson.documentTypes.length).toBe(2);
      expect(typeof artifact.schema!.schemaHash).toBe("string");

      expect(artifact.publishedDocs.length).toBe(1);
      expect(artifact.publishedDocs[0]._id).toBe("post-1");
      expect(artifact.publishedDocs[0]._type).toBe("post");

      expect(artifact.draftDocs.length).toBe(2);
      const draftIds = artifact.draftDocs.map((d) => d._id).sort();
      expect(draftIds).toContain("drafts.post-1");
      expect(draftIds).toContain("drafts.post-2");

      expect(artifact.assets.length).toBe(1);
      expect(artifact.assets[0].filename).toBe("hello.txt");
      expect(artifact.assets[0].contentType).toBe("text/plain");
      expect(typeof artifact.assets[0].assetId).toBe("string");

      expect(artifact.revisions.length).toBeGreaterThan(0);
    });

    it("returns DATASET_NOT_FOUND for missing dataset", async () => {
      const res = await api.datasets.export({ dataset: "missing" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DATASET_NOT_FOUND");
      }
    });

    it("exports are deterministically ordered", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      await api.docs.create({
        dataset: "prod",
        id: "post-b",
        type: "post",
        asDraft: true,
        doc: { title: "B" },
      });
      await api.docs.create({
        dataset: "prod",
        id: "post-a",
        type: "post",
        asDraft: true,
        doc: { title: "A" },
      });

      await api.docs.publish({ dataset: "prod", id: "post-b" });
      await api.docs.publish({ dataset: "prod", id: "post-a" });

      const res = await api.datasets.export({ dataset: "prod" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const pubIds = res.result.artifact.publishedDocs.map((d) => d._id);
      expect(pubIds).toEqual(["post-a", "post-b"]);

      const draftIds = res.result.artifact.draftDocs.map((d) => d._id);
      expect(draftIds).toEqual(["drafts.post-a", "drafts.post-b"]);
    });
  });

  describe("TV-IMP-IMPORT-001: import into new dataset", () => {
    it("imports artifact into new dataset and reproduces query results", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        asDraft: true,
        doc: { title: "Hello" },
      });
      await api.docs.publish({ dataset: "prod", id: "post-1" });

      await api.docs.create({
        dataset: "prod",
        id: "post-2",
        type: "post",
        asDraft: true,
        doc: { title: "World" },
      });

      const exportRes = await api.datasets.export({ dataset: "prod" });
      expect(exportRes.ok).toBe(true);
      if (!exportRes.ok) return;

      const importRes = await api.datasets.import({
        dataset: "prod2",
        artifact: exportRes.result.artifact,
      });
      expect(importRes.ok).toBe(true);

      const schemaRes = await api.schema.get({ dataset: "prod2" });
      expect(schemaRes.ok).toBe(true);
      if (schemaRes.ok) {
        expect(schemaRes.result.version).toBe(1);
        expect(schemaRes.result.documentTypes.length).toBe(2);
      }

      const pubDoc = await api.docs.get({
        dataset: "prod2",
        id: "post-1",
        perspective: "published",
      });
      expect(pubDoc.ok).toBe(true);
      if (pubDoc.ok) {
        expect(pubDoc.result._id).toBe("post-1");
        expect((pubDoc.result as Record<string, unknown>).title).toBe("Hello");
      }

      const draftDoc = await api.docs.get({
        dataset: "prod2",
        id: "drafts.post-2",
        perspective: "draft",
      });
      expect(draftDoc.ok).toBe(true);
      if (draftDoc.ok) {
        expect(draftDoc.result._id).toBe("drafts.post-2");
        expect((draftDoc.result as Record<string, unknown>).title).toBe("World");
      }
    });

    it("imports into existing dataset without error", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        asDraft: true,
        doc: { title: "Original" },
      });
      await api.docs.publish({ dataset: "prod", id: "post-1" });

      const exportRes = await api.datasets.export({ dataset: "prod" });
      expect(exportRes.ok).toBe(true);
      if (!exportRes.ok) return;

      await api.datasets.create({ dataset: "prod-copy" });

      const importRes = await api.datasets.import({
        dataset: "prod-copy",
        artifact: exportRes.result.artifact,
      });
      expect(importRes.ok).toBe(true);
    });
  });

  describe("TV-IMP-IMPORT-002: malformed import artifact", () => {
    it("returns VALIDATION_FAILED for null artifact", async () => {
      const res = await api.datasets.import({
        dataset: "test",
        artifact: null,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("returns VALIDATION_FAILED for missing schema/documents fields", async () => {
      const res = await api.datasets.import({
        dataset: "test",
        artifact: { formatVersion: 1, dataset: "test" },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("returns VALIDATION_FAILED for non-object artifact", async () => {
      const res = await api.datasets.import({
        dataset: "test",
        artifact: "not-an-object",
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("returns VALIDATION_FAILED for artifact missing publishedDocs array", async () => {
      const res = await api.datasets.import({
        dataset: "test",
        artifact: {
          formatVersion: 1,
          dataset: "test",
          exportedAt: "2026-02-11T00:00:00Z",
          schema: null,
          draftDocs: [],
          assets: [],
          revisions: [],
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
      }
    });
  });

  describe("cross-dataset isolation", () => {
    it("import does not affect other datasets", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      await api.docs.create({
        dataset: "prod",
        id: "post-1",
        type: "post",
        asDraft: true,
        doc: { title: "Prod Only" },
      });
      await api.docs.publish({ dataset: "prod", id: "post-1" });

      const exportRes = await api.datasets.export({ dataset: "prod" });
      expect(exportRes.ok).toBe(true);
      if (!exportRes.ok) return;

      await api.datasets.create({ dataset: "other" });
      await api.schema.upsert({ dataset: "other", schema: schemaV1 });

      await api.docs.create({
        dataset: "other",
        id: "other-doc",
        type: "post",
        asDraft: true,
        doc: { title: "Other" },
      });
      await api.docs.publish({ dataset: "other", id: "other-doc" });

      await api.datasets.import({
        dataset: "imported",
        artifact: exportRes.result.artifact,
      });

      const otherDoc = await api.docs.get({
        dataset: "other",
        id: "other-doc",
        perspective: "published",
      });
      expect(otherDoc.ok).toBe(true);
      if (otherDoc.ok) {
        expect((otherDoc.result as Record<string, unknown>).title).toBe("Other");
      }

      const importedOther = await api.docs.get({
        dataset: "imported",
        id: "other-doc",
        perspective: "published",
      });
      expect(importedOther.ok).toBe(false);
      if (!importedOther.ok) {
        expect(importedOther.error.code).toBe("DOCUMENT_NOT_FOUND");
      }
    });
  });

  describe("asset metadata preserved", () => {
    it("preserves asset metadata through export/import", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });

      const uploadRes = await api.assets.upload({
        dataset: "prod",
        filename: "test.txt",
        contentType: "text/plain",
        bytesBase64: "dGVzdA==",
      });
      expect(uploadRes.ok).toBe(true);
      if (!uploadRes.ok) return;

      const exportRes = await api.datasets.export({ dataset: "prod" });
      expect(exportRes.ok).toBe(true);
      if (!exportRes.ok) return;

      expect(exportRes.result.artifact.assets.length).toBe(1);
      expect(exportRes.result.artifact.assets[0].assetId).toBe(uploadRes.result.assetId);

      await api.datasets.import({
        dataset: "prod3",
        artifact: exportRes.result.artifact,
      });

      const assetGet = await api.assets.get({
        dataset: "prod3",
        assetId: uploadRes.result.assetId,
      });
      expect(assetGet.ok).toBe(true);
      if (assetGet.ok) {
        expect(assetGet.result.assetId).toBe(uploadRes.result.assetId);
        expect(assetGet.result.metadata.filename).toBe("test.txt");
      }
    });
  });
});
