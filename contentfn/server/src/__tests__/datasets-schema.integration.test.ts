/**
 * Integration tests for PHASE_01: datasets + schema endpoints.
 * Covers TV-DS-CREATE-001/002/003, TV-DS-DELETE-001, TV-SCHEMA-UPSERT-001/002,
 * TV-SCHEMA-GET-001, TV-SCHEMA-VERSION-001/002.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";

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

describe("PHASE_01 datasets + schema", () => {
  let api: ReturnType<typeof createContentfnServer>["api"];

  beforeEach(() => {
    const server = createContentfnServer({ db: memoryAdapter() });
    api = server.api;
  });

  describe("TV-DS-CREATE-001: create dataset", () => {
    it("POST create prod returns ok and result.dataset", async () => {
      const res = await api.datasets.create({ dataset: "prod" });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.result.dataset).toBe("prod");
    });
  });

  describe("TV-DS-CREATE-002: invalid dataset name", () => {
    it("create with invalid name returns VALIDATION_FAILED", async () => {
      const res = await api.datasets.create({ dataset: "Prod!" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
        expect(res.error.details.path).toBe("dataset");
      }
    });
  });

  describe("TV-DS-CREATE-003: duplicate dataset", () => {
    it("create same name twice returns DATASET_ALREADY_EXISTS", async () => {
      await api.datasets.create({ dataset: "prod" });
      const res = await api.datasets.create({ dataset: "prod" });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DATASET_ALREADY_EXISTS");
        expect(res.error.details.dataset).toBe("prod");
      }
    });
  });

  describe("TV-DS-DELETE-001: delete dataset", () => {
    it("delete then schema get returns DATASET_NOT_FOUND", async () => {
      await api.datasets.create({ dataset: "prod" });
      const del = await api.datasets.delete({ dataset: "prod" });
      expect(del.ok).toBe(true);
      const getSchema = await api.schema.get({ dataset: "prod" });
      expect(getSchema.ok).toBe(false);
      if (!getSchema.ok) expect(getSchema.error.code).toBe("DATASET_NOT_FOUND");
    });
  });

  describe("TV-SCHEMA-UPSERT-001: upsert schema", () => {
    it("upsert valid schema returns ok and schemaHash", async () => {
      await api.datasets.create({ dataset: "prod" });
      const res = await api.schema.upsert({
        dataset: "prod",
        schema: {
          version: 1,
          documentTypes: [
            { name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" }, required: true }] },
          ],
        },
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(typeof res.result.schemaHash).toBe("string");
        expect(res.result.schemaHash.length).toBeGreaterThan(0);
      }
    });
  });

  describe("TV-SCHEMA-GET-001: get schema", () => {
    it("get after upsert returns schemaV1", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
      const res = await api.schema.get({ dataset: "prod" });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result.version).toBe(1);
        expect(res.result.documentTypes).toHaveLength(2);
        expect(res.result.documentTypes?.map((t) => t.name).sort()).toEqual(["author", "post"]);
      }
    });
  });

  describe("TV-SCHEMA-UPSERT-002: invalid schema", () => {
    it("upsert duplicate type name returns SCHEMA_INVALID", async () => {
      await api.datasets.create({ dataset: "prod" });
      const res = await api.schema.upsert({
        dataset: "prod",
        schema: {
          version: 1,
          documentTypes: [
            { name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" }, required: true }] },
            { name: "post", fields: [] },
          ],
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("SCHEMA_INVALID");
        expect(res.error.details.path).toBeDefined();
      }
    });
  });

  describe("TV-SCHEMA-VERSION-001: decreasing version", () => {
    it("upsert version 1 after version 2 returns SCHEMA_VERSION_CONFLICT", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({
        dataset: "prod",
        schema: { version: 2, documentTypes: [{ name: "post", fields: [] }] },
      });
      const res = await api.schema.upsert({
        dataset: "prod",
        schema: { version: 1, documentTypes: [] },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("SCHEMA_VERSION_CONFLICT");
    });
  });

  describe("TV-SCHEMA-VERSION-002: same version different content", () => {
    it("upsert same version with different content returns SCHEMA_VERSION_CONFLICT", async () => {
      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
      const res = await api.schema.upsert({
        dataset: "prod",
        schema: {
          version: 1,
          documentTypes: [{ name: "other", fields: [] }],
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("SCHEMA_VERSION_CONFLICT");
    });
  });

  describe("schemaHash determinism", () => {
    it("schemaHash changes only when schema content changes", async () => {
      const { schemaHash } = await import("../hash/schemaHash.js");
      const s1 = { version: 1, documentTypes: [{ name: "a", fields: [] }] };
      const s2 = { version: 1, documentTypes: [{ name: "a", fields: [] }] };
      const s3 = { version: 1, documentTypes: [{ name: "b", fields: [] }] };
      expect(schemaHash(s1 as any)).toBe(schemaHash(s2 as any));
      expect(schemaHash(s1 as any)).not.toBe(schemaHash(s3 as any));
    });
  });
});

it("requires explicit migration steps before invalidating stored content", async () => {
  const server = createContentfnServer({ db: memoryAdapter() });
  await server.api.datasets.create({ dataset: "migration" });
  const schema = { version: 1, documentTypes: [{ name: "post", fields: [] }] };
  await server.api.schema.upsert({ dataset: "migration", schema });
  await server.api.docs.create({ dataset: "migration", id: "old", type: "post", doc: {}, asDraft: true });
  const next = { version: 2, documentTypes: [{ name: "post", fields: [{ name: "title", required: true, type: { kind: "primitive" as const, type: "string" as const } }] }] };
  expect(await server.api.schema.upsert({ dataset: "migration", schema: next })).toMatchObject({ ok: false, error: { code: "SCHEMA_INVALID" } });
  expect(await server.api.schema.get({ dataset: "migration" })).toMatchObject({ ok: true, result: { version: 1 } });
  expect(await server.api.schema.upsert({ dataset: "migration", schema: next, migration: { description: "Backfill draft titles before publication" } })).toMatchObject({ ok: true });
  expect(await server.api.docs.get({ dataset: "migration", id: "drafts.old", perspective: "draft" })).toMatchObject({ ok: true });
  expect(await server.api.docs.publish({ dataset: "migration", id: "old" })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
});
