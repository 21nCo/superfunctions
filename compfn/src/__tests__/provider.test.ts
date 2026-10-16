/**
 * Unit tests for provider consumption (TV-PROVIDER-001).
 * Phase 12: Verify readiness.forFramework and evidence.list are sufficient for productFn/flowfn
 * to compute "evidence due" (controls with no recent evidence or lastEvidenceAt before threshold).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

describe("Provider API (TV-PROVIDER-001)", () => {
  let api: ReturnType<typeof compFn>;

  beforeAll(async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    if (!result.success) throw new Error(result.errors?.join("; "));
    api = compFn({ database: db, namespace: "compfn", readinessWindowDays: 90 });
  });

  describe("TV-PROVIDER-001 (Positive: readiness.forFramework and evidence.list sufficient for evidence-due)", () => {
    it("allows consumer to compute evidence-due controls using readiness.forFramework and evidence.list with since filter", async () => {
      const ctrl1 = await api.controls.create({
        name: "Control with recent evidence",
        description: "Has evidence within 90 days",
        category: "access",
      });
      expect(ctrl1.ok).toBe(true);
      if (!ctrl1.ok) return;

      const ctrl2 = await api.controls.create({
        name: "Control with old evidence",
        description: "Has evidence older than 90 days",
        category: "access",
      });
      expect(ctrl2.ok).toBe(true);
      if (!ctrl2.ok) return;

      const ctrl3 = await api.controls.create({
        name: "Control with no evidence",
        description: "Has no evidence at all",
        category: "access",
      });
      expect(ctrl3.ok).toBe(true);
      if (!ctrl3.ok) return;

      const fw = await api.frameworks.create({
        name: "SOC 2",
        version: "2022",
        requirements: [
          { requirementId: "CC6.1", controlIds: [ctrl1.result.id, ctrl2.result.id, ctrl3.result.id] },
        ],
      });
      expect(fw.ok).toBe(true);
      if (!fw.ok) return;

      const now = Date.now();
      const ninetyDaysAgo = now - 90 * 24 * 60 * 60 * 1000;
      const hundredDaysAgo = now - 100 * 24 * 60 * 60 * 1000;

      await api.evidence.create({
        controlId: ctrl1.result.id,
        type: "manual_attestation",
        actorId: "user1",
        outcome: "pass",
        timestamp: now - 10 * 24 * 60 * 60 * 1000,
      });

      await api.evidence.create({
        controlId: ctrl2.result.id,
        type: "manual_attestation",
        actorId: "user1",
        outcome: "pass",
        timestamp: hundredDaysAgo,
      });

      const readinessRes = await api.readiness.forFramework(fw.result.id);
      expect(readinessRes.ok).toBe(true);
      if (!readinessRes.ok) return;

      const evidenceDueControls = readinessRes.result.controlReadiness.filter((cr) => {
        if (cr.status === "not_applicable") return false;
        if (!cr.lastEvidenceAt) return true;
        return cr.lastEvidenceAt < ninetyDaysAgo;
      });

      expect(evidenceDueControls.length).toBeGreaterThanOrEqual(2);
      const evidenceDueControlIds = evidenceDueControls.map((c) => c.controlId);
      expect(evidenceDueControlIds).toContain(ctrl2.result.id);
      expect(evidenceDueControlIds).toContain(ctrl3.result.id);
      expect(evidenceDueControlIds).not.toContain(ctrl1.result.id);

      const evidenceListRes = await api.evidence.list({ since: ninetyDaysAgo });
      expect(evidenceListRes.ok).toBe(true);
      if (!evidenceListRes.ok) return;

      const recentControlIds = new Set(evidenceListRes.result.map((e) => e.controlId));
      expect(recentControlIds.has(ctrl1.result.id)).toBe(true);
      expect(recentControlIds.has(ctrl2.result.id)).toBe(false);
      expect(recentControlIds.has(ctrl3.result.id)).toBe(false);
    });

    it("documents usage pattern: get readiness, filter evidence-due, list evidence per control", async () => {
      const ctrl = await api.controls.create({
        name: "Example control",
        description: "For documentation",
        category: "example",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;

      const fw = await api.frameworks.create({
        name: "Example Framework",
        requirements: [{ requirementId: "EX1", controlIds: [ctrl.result.id] }],
      });
      expect(fw.ok).toBe(true);
      if (!fw.ok) return;

      const readinessRes = await api.readiness.forFramework(fw.result.id);
      expect(readinessRes.ok).toBe(true);
      if (!readinessRes.ok) return;

      const threshold = Date.now() - 90 * 24 * 60 * 60 * 1000;
      const evidenceDue = readinessRes.result.controlReadiness.filter(
        (cr) => cr.status !== "not_applicable" && (!cr.lastEvidenceAt || cr.lastEvidenceAt < threshold)
      );

      for (const due of evidenceDue) {
        const evidenceRes = await api.evidence.list({ controlId: due.controlId, since: threshold });
        expect(evidenceRes.ok).toBe(true);
      }

      expect(evidenceDue.length).toBe(1);
      expect(evidenceDue[0].controlId).toBe(ctrl.result.id);
    });
  });
});
