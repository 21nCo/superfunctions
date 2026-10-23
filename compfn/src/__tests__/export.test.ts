/**
 * Export tests: auditorPack (TV-EXPORT-001, TV-EXPORT-002, TV-EXPORT-003).
 * Phase 06: full export; scoped to frameworkId; export size exceeded → EXPORT_FAILED.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

describe("Export auditorPack (TV-EXPORT-*)", () => {
  let api: ReturnType<typeof compFn>;

  beforeAll(async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    if (!result.success) throw new Error(result.errors?.join("; "));
    api = compFn({ database: db, namespace: "compfn" });
  });

  describe("TV-EXPORT-001 (Positive: auditor pack full)", () => {
    it("returns AuditorPack with exportedAt, controls, frameworks, evidence, mapping", async () => {
      const ctrl = await api.controls.create({
        name: "Export control",
        description: "For full export",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      const fwRes = await api.frameworks.create({
        name: "SOC 2",
        version: "2022",
        requirements: [{ requirementId: "CC6.1", controlIds: [c.id] }],
      });
      expect(fwRes.ok).toBe(true);
      if (!fwRes.ok) return;
      const f = fwRes.result;

      const evRes = await api.evidence.create({
        controlId: c.id,
        type: "manual_attestation",
        actorId: "user1",
        outcome: "pass",
        payload: { note: "Done" },
      });
      expect(evRes.ok).toBe(true);
      if (!evRes.ok) return;

      const res = await api.export.auditorPack({});
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.exportedAt).toBeDefined();
      expect(typeof res.result.exportedAt).toBe("number");
      expect(Array.isArray(res.result.controls)).toBe(true);
      expect(Array.isArray(res.result.frameworks)).toBe(true);
      expect(Array.isArray(res.result.evidence)).toBe(true);
      expect(Array.isArray(res.result.mapping)).toBe(true);
      expect(res.result.controls.length).toBeGreaterThanOrEqual(1);
      expect(res.result.frameworks.length).toBeGreaterThanOrEqual(1);
      expect(res.result.evidence.length).toBeGreaterThanOrEqual(1);
      expect(res.result.mapping.some((m) => m.requirementId === "CC6.1" && m.controlIds.includes(c.id))).toBe(true);
    });
  });

  describe("TV-EXPORT-002 (Positive: auditor pack scoped to framework)", () => {
    it("returns only controls and evidence relevant to the given framework", async () => {
      const c1 = await api.controls.create({
        name: "In framework",
        description: "In scope",
        category: "test",
      });
      const c2 = await api.controls.create({
        name: "Other control",
        description: "Not in framework",
        category: "other",
      });
      expect(c1.ok && c2.ok).toBe(true);
      if (!c1.ok || !c2.ok) return;

      const fwRes = await api.frameworks.create({
        name: "Scoped framework",
        version: "1",
        requirements: [{ requirementId: "R1", controlIds: [c1.result.id] }],
      });
      expect(fwRes.ok).toBe(true);
      if (!fwRes.ok) return;
      const f = fwRes.result;

      await api.evidence.create({
        controlId: c1.result.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
      });
      await api.evidence.create({
        controlId: c2.result.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
      });

      const res = await api.export.auditorPack({ frameworkId: f.id });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const controlIds = new Set(res.result.controls.map((x) => x.id));
      const evidenceControlIds = new Set(res.result.evidence.map((e) => e.controlId));
      expect(controlIds.has(c1.result.id)).toBe(true);
      expect(controlIds.has(c2.result.id)).toBe(false);
      expect(res.result.frameworks.length).toBe(1);
      expect(res.result.frameworks[0].id).toBe(f.id);
      expect(evidenceControlIds.has(c2.result.id)).toBe(false);
      expect(evidenceControlIds.has(c1.result.id)).toBe(true);
      expect(res.result.mapping).toEqual([{ requirementId: "R1", controlIds: [c1.result.id] }]);
    });
  });

  describe("TV-EXPORT-003 (Negative: export size exceeded)", () => {
    it("returns EXPORT_FAILED when result would exceed exportMaxBytes", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn_export_limit" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));

      // Very small limit so even a tiny export might exceed, or we add enough evidence to exceed
      const exportMaxBytes = 200;
      const limitApi = compFn({
        database: db,
        namespace: "compfn_export_limit",
        exportMaxBytes,
      });

      const ctrl = await limitApi.controls.create({
        name: "Big",
        description: "Control for large export",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      await limitApi.frameworks.create({
        name: "F",
        requirements: [{ requirementId: "R1", controlIds: [c.id] }],
      });

      // Create evidence with payload that pushes total size over 200 bytes
      const evRes = await limitApi.evidence.create({
        controlId: c.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
        payload: { data: "x".repeat(300) },
      });
      expect(evRes.ok).toBe(true);

      const res = await limitApi.export.auditorPack({});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("EXPORT_FAILED");
      expect(res.error.details?.limit).toBe(exportMaxBytes);
      expect(typeof res.error.details?.size).toBe("number");
    });
  });
});
