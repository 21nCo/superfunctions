/**
 * Unit tests for readiness forControl and forFramework (TV-READY-*).
 * Phase 05: control/framework readiness; CONTROL_NOT_FOUND / FRAMEWORK_NOT_FOUND; policy and determinism.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

describe("Readiness (TV-READY-*)", () => {
  let api: ReturnType<typeof compFn>;

  beforeAll(async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    if (!result.success) throw new Error(result.errors?.join("; "));
    api = compFn({ database: db, namespace: "compfn" });
  });

  describe("TV-READY-CONTROL-001 (Positive: control with pass evidence is compliant)", () => {
    it("returns ControlReadiness with status compliant and lastEvidenceAt when control has pass evidence", async () => {
      const ctrl = await api.controls.create({
        name: "Access reviews",
        description: "Quarterly access reviews",
        category: "access",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      const evRes = await api.evidence.create({
        controlId: c.id,
        type: "manual_attestation",
        actorId: "user1",
        outcome: "pass",
        payload: { note: "Done" },
      });
      expect(evRes.ok).toBe(true);
      if (!evRes.ok) return;

      const res = await api.readiness.forControl(c.id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.controlId).toBe(c.id);
      expect(res.result.status).toBe("compliant");
      expect(res.result.lastEvidenceAt).toBeDefined();
      expect(typeof res.result.lastEvidenceAt).toBe("number");
      expect(res.result.lastEvidenceId).toBe(evRes.result.id);
    });
  });

  describe("TV-READY-CONTROL-002 (Negative: control not found)", () => {
    it("returns CONTROL_NOT_FOUND for nonexistent control", async () => {
      const res = await api.readiness.forControl("nonexistent");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("CONTROL_NOT_FOUND");
      expect(res.error.details.id).toBe("nonexistent");
    });
  });

  describe("TV-READY-CONTROL-003 (Positive: control marked not applicable)", () => {
    it("returns ControlReadiness with status not_applicable when latest scoping_decision marks not applicable", async () => {
      const ctrl = await api.controls.create({
        name: "Out of scope control",
        description: "Scoped out",
        category: "other",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      const evRes = await api.evidence.create({
        controlId: c.id,
        type: "scoping_decision",
        actorId: "user1",
        outcome: "unknown",
        payload: { status: "not_applicable", reason: "Out of scope for this system" },
      });
      expect(evRes.ok).toBe(true);
      if (!evRes.ok) return;

      const res = await api.readiness.forControl(c.id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.controlId).toBe(c.id);
      expect(res.result.status).toBe("not_applicable");
    });
  });

  describe("TV-READY-FRAMEWORK-001 (Positive: framework readiness)", () => {
    it("returns FrameworkReadiness with controlReadiness and status compliant when control has pass evidence", async () => {
      const ctrl = await api.controls.create({
        name: "Framework control",
        description: "For framework readiness",
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
      });
      expect(evRes.ok).toBe(true);
      if (!evRes.ok) return;

      const res = await api.readiness.forFramework(f.id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.frameworkId).toBe(f.id);
      expect(res.result.status).toBe("compliant");
      expect(Array.isArray(res.result.controlReadiness)).toBe(true);
      expect(res.result.controlReadiness.length).toBe(1);
      expect(res.result.controlReadiness[0].controlId).toBe(c.id);
      expect(res.result.controlReadiness[0].status).toBe("compliant");
      expect(typeof res.result.lastUpdated).toBe("number");
    });
  });

  describe("TV-READY-FRAMEWORK-002 (Negative: framework not found)", () => {
    it("returns FRAMEWORK_NOT_FOUND for nonexistent framework", async () => {
      const res = await api.readiness.forFramework("nonexistent");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("FRAMEWORK_NOT_FOUND");
      expect(res.error.details.id).toBe("nonexistent");
    });
  });

  describe("Determinism and forControl with frameworkId", () => {
    it("same evidence set yields same status on repeated forControl calls", async () => {
      const ctrl = await api.controls.create({
        name: "Determinism control",
        description: "For determinism test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      await api.evidence.create({
        controlId: c.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
      });

      const r1 = await api.readiness.forControl(c.id);
      const r2 = await api.readiness.forControl(c.id);
      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;
      expect(r1.result.status).toBe(r2.result.status);
      expect(r1.result.lastEvidenceAt).toBe(r2.result.lastEvidenceAt);
    });

    it("forControl with frameworkId returns requirementIds when framework provided", async () => {
      const ctrl = await api.controls.create({
        name: "ReqIds control",
        description: "For requirementIds test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      const fwRes = await api.frameworks.create({
        name: "Req Framework",
        requirements: [
          { requirementId: "R1", controlIds: [c.id] },
          { requirementId: "R2", controlIds: [c.id] },
        ],
      });
      expect(fwRes.ok).toBe(true);
      if (!fwRes.ok) return;
      const f = fwRes.result;

      const res = await api.readiness.forControl(c.id, f.id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.requirementIds).toBeDefined();
      expect(res.result.requirementIds).toContain("R1");
      expect(res.result.requirementIds).toContain("R2");
    });
  });
});
