/**
 * Unit tests for controls CRUD (TV-CTRL-*).
 * Phase 01: controls.create, get, list (category/tags filter), update, delete.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

describe("Controls CRUD (TV-CTRL-*)", () => {
  let api: ReturnType<typeof compFn>;

  beforeAll(async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    if (!result.success) throw new Error(result.errors?.join("; "));
    api = compFn({ database: db, namespace: "compfn" });
  });

  afterAll(async () => {
    // Adapter is not stored on api; if we need to close we'd pass it. Skip for in-memory.
  });

  describe("TV-CTRL-CREATE-001 (Positive: create control)", () => {
    it("returns Control with id, name, createdAt, updatedAt", async () => {
      const res = await api.controls.create({
        name: "Access reviews",
        description: "Quarterly access reviews",
        category: "access",
        tags: ["soc2"],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.id).toBeDefined();
      expect(res.result.name).toBe("Access reviews");
      expect(typeof res.result.createdAt).toBe("number");
      expect(typeof res.result.updatedAt).toBe("number");
      expect(res.result.description).toBe("Quarterly access reviews");
      expect(res.result.category).toBe("access");
      expect(res.result.tags).toEqual(["soc2"]);
    });
  });

  describe("TV-CTRL-GET-001 (Positive: get existing control)", () => {
    it("returns Control when id exists", async () => {
      const created = await api.controls.create({
        name: "Get me",
        description: "For get test",
        category: "test",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const c = created.result;
      const res = await api.controls.get(c.id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.id).toBe(c.id);
      expect(res.result.name).toBe("Get me");
    });
  });

  describe("TV-CTRL-GET-002 (Negative: get nonexistent control)", () => {
    it("returns CONTROL_NOT_FOUND with details.id", async () => {
      const res = await api.controls.get("nonexistent-id");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("CONTROL_NOT_FOUND");
      expect(res.error.message).toBeDefined();
      expect(res.error.details.id).toBe("nonexistent-id");
    });
  });

  describe("TV-CTRL-LIST-001 (Positive: list controls with filter)", () => {
    it("filters by category", async () => {
      await api.controls.create({
        name: "Access control 1",
        description: "Access",
        category: "access",
      });
      await api.controls.create({
        name: "Backup control 1",
        description: "Backup",
        category: "backup",
      });
      const res = await api.controls.list({ category: "access" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(Array.isArray(res.result)).toBe(true);
      expect(res.result.every((c) => c.category === "access")).toBe(true);
    });
  });

  describe("TV-CTRL-UPDATE-001 (Positive: update control)", () => {
    it("updates only provided fields and returns Control", async () => {
      const created = await api.controls.create({
        name: "Original name",
        description: "Original desc",
        category: "cat",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const c = created.result;
      const res = await api.controls.update(c.id, { name: "Updated name" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.name).toBe("Updated name");
      expect(res.result.id).toBe(c.id);
      expect(res.result.description).toBe("Original desc");
    });
  });

  describe("TV-CTRL-DELETE-001 (Positive: delete control)", () => {
    it("delete returns ok; get then returns CONTROL_NOT_FOUND", async () => {
      const created = await api.controls.create({
        name: "To delete",
        description: "Will be deleted",
        category: "test",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const c = created.result;
      const delRes = await api.controls.delete(c.id);
      expect(delRes.ok).toBe(true);
      if (!delRes.ok) return;
      expect((delRes as { result?: unknown }).result).toBeUndefined();
      const getRes = await api.controls.get(c.id);
      expect(getRes.ok).toBe(false);
      if (getRes.ok) return;
      expect(getRes.error.code).toBe("CONTROL_NOT_FOUND");
    });
  });

  describe("Validation (create)", () => {
    it("returns VALIDATION_FAILED when name is missing", async () => {
      const res = await api.controls.create({
        name: "",
        description: "x",
        category: "y",
      } as Parameters<typeof api.controls.create>[0]);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
      expect(res.error.details.path).toContain("name");
    });
    it("returns VALIDATION_FAILED when category is missing", async () => {
      const res = await api.controls.create({
        name: "x",
        description: "y",
        category: "",
      } as Parameters<typeof api.controls.create>[0]);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
    });
  });
});
