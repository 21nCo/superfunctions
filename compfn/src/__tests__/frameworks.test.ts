/**
 * Unit tests for frameworks CRUD and validation (TV-FW-*, TV-LIMIT-FW-001).
 * Phase 02: frameworks.create, get, list, update, delete; controlId validation; limits.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

describe("Frameworks CRUD (TV-FW-*)", () => {
  let api: ReturnType<typeof compFn>;

  beforeAll(async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    if (!result.success) throw new Error(result.errors?.join("; "));
    api = compFn({ database: db, namespace: "compfn" });
  });

  describe("TV-FW-CREATE-001 (Positive: create framework with requirements)", () => {
    it("returns Framework with requirements when control exists", async () => {
      const ctrl = await api.controls.create({
        name: "Access reviews",
        description: "Quarterly access reviews",
        category: "access",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c1 = ctrl.result;
      const res = await api.frameworks.create({
        name: "SOC 2",
        version: "2022",
        requirements: [{ requirementId: "CC6.1", controlIds: [c1.id] }],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.id).toBeDefined();
      expect(res.result.name).toBe("SOC 2");
      expect(res.result.version).toBe("2022");
      expect(res.result.requirements).toHaveLength(1);
      expect(res.result.requirements[0].requirementId).toBe("CC6.1");
      expect(res.result.requirements[0].controlIds).toContain(c1.id);
      expect(typeof res.result.createdAt).toBe("number");
      expect(typeof res.result.updatedAt).toBe("number");
    });
  });

  describe("TV-FW-GET-001 (Positive: get framework)", () => {
    it("returns Framework when id exists", async () => {
      const ctrl = await api.controls.create({
        name: "Get FW",
        description: "For get test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const created = await api.frameworks.create({
        name: "Get Me Framework",
        requirements: [{ requirementId: "R1", controlIds: [ctrl.result.id] }],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const f = created.result;
      const res = await api.frameworks.get(f.id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.id).toBe(f.id);
      expect(res.result.name).toBe("Get Me Framework");
    });
  });

  describe("TV-FW-GET-002 (Negative: get nonexistent framework)", () => {
    it("returns FRAMEWORK_NOT_FOUND with details", async () => {
      const res = await api.frameworks.get("nonexistent-id");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("FRAMEWORK_NOT_FOUND");
      expect(res.error.message).toBeDefined();
      expect(res.error.details.id).toBe("nonexistent-id");
    });
  });

  describe("TV-FW-LIST-001 (Positive: list frameworks)", () => {
    it("returns at least one framework after create", async () => {
      const ctrl = await api.controls.create({
        name: "List FW",
        description: "For list test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      await api.frameworks.create({
        name: "List Framework",
        requirements: [{ requirementId: "L1", controlIds: [ctrl.result.id] }],
      });
      const res = await api.frameworks.list();
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(Array.isArray(res.result)).toBe(true);
      expect(res.result.length).toBeGreaterThanOrEqual(1);
      const found = res.result.find((f) => f.name === "List Framework");
      expect(found).toBeDefined();
    });
  });

  describe("TV-FW-VALIDATE-CONTROLS-001 (Negative: framework with nonexistent controlId)", () => {
    it("returns VALIDATION_FAILED when controlId does not exist", async () => {
      const res = await api.frameworks.create({
        name: "F",
        requirements: [{ requirementId: "R1", controlIds: ["nonexistent-control-id"] }],
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
      expect(res.error.message).toBeDefined();
      expect(res.error.details.controlId ?? res.error.details.path).toBeDefined();
    });
  });

  describe("TV-FW-VALIDATE-CONTROLS-002 (Positive: framework with existing controlIds)", () => {
    it("succeeds when all controlIds exist", async () => {
      const ctrl = await api.controls.create({
        name: "Existing",
        description: "For validate test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      const res = await api.frameworks.create({
        name: "F",
        requirements: [{ requirementId: "R1", controlIds: [c.id] }],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.requirements[0].controlIds).toContain(c.id);
    });
  });

  describe("TV-LIMIT-FW-001 (Framework too many requirements or controlIds)", () => {
    it("returns VALIDATION_FAILED when requirements.length > 1000", async () => {
      const ctrl = await api.controls.create({
        name: "One",
        description: "One control",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c1 = ctrl.result.id;
      const res = await api.frameworks.create({
        name: "F",
        requirements: Array(1001)
          .fill(null)
          .map((_, i) => ({ requirementId: `R${i}`, controlIds: [c1] })),
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
    });

    it("returns VALIDATION_FAILED when controlIds per requirement > 100", async () => {
      const res = await api.frameworks.create({
        name: "F",
        requirements: [
          {
            requirementId: "R",
            controlIds: Array(101)
              .fill("any-id")
              .map((id, i) => `${id}-${i}`),
          },
        ],
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("Framework update and delete", () => {
    it("update returns FRAMEWORK_NOT_FOUND for missing id", async () => {
      const res = await api.frameworks.update("nonexistent-id", { name: "X" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("FRAMEWORK_NOT_FOUND");
    });

    it("delete returns FRAMEWORK_NOT_FOUND for missing id", async () => {
      const res = await api.frameworks.delete("nonexistent-id");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("FRAMEWORK_NOT_FOUND");
    });

    it("update re-validates controlIds and rejects nonexistent", async () => {
      const ctrl = await api.controls.create({
        name: "Original",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const created = await api.frameworks.create({
        name: "ToUpdate",
        requirements: [{ requirementId: "R1", controlIds: [ctrl.result.id] }],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const updated = await api.frameworks.update(created.result.id, {
        requirements: [{ requirementId: "R1", controlIds: ["nonexistent-control"] }],
      });
      expect(updated.ok).toBe(false);
      if (updated.ok) return;
      expect(updated.error.code).toBe("VALIDATION_FAILED");
    });

    it("update succeeds with valid requirements", async () => {
      const ctrl = await api.controls.create({
        name: "For update",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const created = await api.frameworks.create({
        name: "Original",
        requirements: [{ requirementId: "R1", controlIds: [ctrl.result.id] }],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const res = await api.frameworks.update(created.result.id, { name: "Updated" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.name).toBe("Updated");
      expect(res.result.id).toBe(created.result.id);
    });

    it("delete removes framework; get then returns FRAMEWORK_NOT_FOUND", async () => {
      const ctrl = await api.controls.create({
        name: "To delete FW",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const created = await api.frameworks.create({
        name: "ToDelete",
        requirements: [{ requirementId: "R1", controlIds: [ctrl.result.id] }],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const delRes = await api.frameworks.delete(created.result.id);
      expect(delRes.ok).toBe(true);
      const getRes = await api.frameworks.get(created.result.id);
      expect(getRes.ok).toBe(false);
      if (getRes.ok) return;
      expect(getRes.error.code).toBe("FRAMEWORK_NOT_FOUND");
    });
  });
});
