/**
 * Unit tests for evidence create, get, list (TV-EVID-*).
 * Phase 03: evidence immutable; controlId validation; type and scoping validation; payload size; list filters.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

describe("Evidence (TV-EVID-*)", () => {
  let api: ReturnType<typeof compFn>;

  beforeAll(async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    if (!result.success) throw new Error(result.errors?.join("; "));
    api = compFn({ database: db, namespace: "compfn" });
  });

  describe("TV-EVID-CREATE-001 (Positive: create evidence)", () => {
    it("returns Evidence with controlId, type, outcome, id, createdAt", async () => {
      const ctrl = await api.controls.create({
        name: "Access reviews",
        description: "Quarterly access reviews",
        category: "access",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      const res = await api.evidence.create({
        controlId: c.id,
        type: "manual_attestation",
        actorId: "user1",
        outcome: "pass",
        payload: { note: "Done" },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.controlId).toBe(c.id);
      expect(res.result.type).toBe("manual_attestation");
      expect(res.result.outcome).toBe("pass");
      expect(res.result.id).toBeDefined();
      expect(res.result.createdAt).toBeDefined();
      expect(res.result.actorId).toBe("user1");
      expect(res.result.payload).toEqual({ note: "Done" });
    });
  });

  describe("TV-EVID-CONTROL-LINK-001 (Negative: evidence with nonexistent controlId)", () => {
    it("returns VALIDATION_FAILED with details.controlId", async () => {
      const res = await api.evidence.create({
        controlId: "nonexistent",
        type: "manual_attestation",
        actorId: "user1",
        outcome: "pass",
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
      expect(res.error.details.controlId).toBe("nonexistent");
    });
  });

  describe("TV-EVID-CONTROL-LINK-002 (Positive: evidence with existing controlId)", () => {
    it("succeeds when control exists", async () => {
      const ctrl = await api.controls.create({
        name: "Existing",
        description: "For link test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      const res = await api.evidence.create({
        controlId: c.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.controlId).toBe(c.id);
    });
  });

  describe("TV-EVID-TYPE-001 (Positive: valid evidence type)", () => {
    it("returns Evidence with type file_upload", async () => {
      const ctrl = await api.controls.create({
        name: "File control",
        description: "For type test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      const res = await api.evidence.create({
        controlId: c.id,
        type: "file_upload",
        actorId: "u1",
        outcome: "pass",
        artifactRef: "s3://bucket/key",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.type).toBe("file_upload");
    });
  });

  describe("TV-EVID-TYPE-002 (Negative: invalid evidence type)", () => {
    it("returns VALIDATION_FAILED for invalid type", async () => {
      const ctrl = await api.controls.create({
        name: "Type test",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const res = await api.evidence.create({
        controlId: ctrl.result.id,
        type: "invalid_type" as any,
        actorId: "u1",
        outcome: "pass",
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("TV-EVID-SCOPING-001 (Positive: create scoping decision evidence)", () => {
    it("succeeds with outcome unknown and payload.status not_applicable", async () => {
      const ctrl = await api.controls.create({
        name: "Scoping control",
        description: "For scoping test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;
      const res = await api.evidence.create({
        controlId: c.id,
        type: "scoping_decision",
        actorId: "user1",
        outcome: "unknown",
        payload: { status: "not_applicable", reason: "Out of scope for this system" },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.type).toBe("scoping_decision");
      expect(res.result.outcome).toBe("unknown");
      expect(res.result.payload?.status).toBe("not_applicable");
    });
  });

  describe("TV-EVID-SCOPING-002 (Negative: invalid scoping decision evidence)", () => {
    it("returns VALIDATION_FAILED when outcome is not unknown", async () => {
      const ctrl = await api.controls.create({
        name: "Scoping invalid",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const res = await api.evidence.create({
        controlId: ctrl.result.id,
        type: "scoping_decision",
        actorId: "user1",
        outcome: "pass",
        payload: { status: "not_applicable" },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("TV-EVID-PAYLOAD-SIZE-001 (Positive: payload within limit)", () => {
    it("succeeds with small payload", async () => {
      const ctrl = await api.controls.create({
        name: "Payload control",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const res = await api.evidence.create({
        controlId: ctrl.result.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
        payload: { small: "x" },
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.payload).toEqual({ small: "x" });
    });
  });

  describe("TV-EVID-PAYLOAD-SIZE-002 (Negative: payload exceeds limit)", () => {
    it("returns PAYLOAD_TOO_LARGE with default 512 KiB limit", async () => {
      const ctrl = await api.controls.create({
        name: "Big payload control",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const res = await api.evidence.create({
        controlId: ctrl.result.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
        payload: { big: "x".repeat(600_000) },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  describe("TV-EVID-IMMUTABLE-001 (Positive: no update/delete on evidence)", () => {
    it("evidence namespace has create, get, list only", () => {
      expect(typeof api.evidence.create).toBe("function");
      expect(typeof api.evidence.get).toBe("function");
      expect(typeof api.evidence.list).toBe("function");
      expect((api.evidence as any).update).toBeUndefined();
      expect((api.evidence as any).delete).toBeUndefined();
    });
  });

  describe("TV-EVID-GET-001 (Positive: get evidence by id)", () => {
    it("returns Evidence when id exists", async () => {
      const ctrl = await api.controls.create({
        name: "Get evid",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const created = await api.evidence.create({
        controlId: ctrl.result.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const e = created.result;
      const res = await api.evidence.get(e.id);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.id).toBe(e.id);
      expect(res.result.controlId).toBe(ctrl.result.id);
    });
  });

  describe("TV-EVID-GET-002 (Negative: get nonexistent evidence)", () => {
    it("returns EVIDENCE_NOT_FOUND", async () => {
      const res = await api.evidence.get("nonexistent-id");
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("EVIDENCE_NOT_FOUND");
      expect(res.error.details.id).toBe("nonexistent-id");
    });
  });

  describe("TV-EVID-LIST-001 (Positive: list by controlId)", () => {
    it("returns only evidence for that control", async () => {
      const ctrl = await api.controls.create({
        name: "List control",
        description: "Desc",
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
      await api.evidence.create({
        controlId: c.id,
        type: "file_upload",
        actorId: "u2",
        outcome: "fail",
      });
      const res = await api.evidence.list({ controlId: c.id });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(Array.isArray(res.result)).toBe(true);
      expect(res.result.length).toBeGreaterThanOrEqual(2);
      expect(res.result.every((e) => e.controlId === c.id)).toBe(true);
    });
  });

  describe("TV-EVID-LIST-002 (Positive: list since timestamp)", () => {
    it("result includes evidence with timestamp >= since", async () => {
      const ctrl = await api.controls.create({
        name: "Since control",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const created = await api.evidence.create({
        controlId: ctrl.result.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const e = created.result;
      const res = await api.evidence.list({ since: e.timestamp - 1 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const found = res.result.find((ev) => ev.id === e.id);
      expect(found).toBeDefined();
      expect(found!.timestamp).toBeGreaterThanOrEqual(e.timestamp - 1);
    });
  });

  describe("Verification: nonexistent controlId → VALIDATION_FAILED", () => {
    it("create with nonexistent controlId returns VALIDATION_FAILED", async () => {
      const res = await api.evidence.create({
        controlId: "nonexistent-control-id",
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("Verification: payload > limit → PAYLOAD_TOO_LARGE", () => {
    it("create with payload over evidencePayloadMaxBytes returns PAYLOAD_TOO_LARGE", async () => {
      const db = memoryAdapter();
      await db.initialize();
      await createSchemaIfSupported(db, { namespace: "compfn_limit" });
      const apiLimit = compFn({
        database: db,
        namespace: "compfn_limit",
        evidencePayloadMaxBytes: 1000,
      });
      const ctrl = await apiLimit.controls.create({
        name: "Limit control",
        description: "Desc",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const res = await apiLimit.evidence.create({
        controlId: ctrl.result.id,
        type: "manual_attestation",
        actorId: "u1",
        outcome: "pass",
        payload: { data: "x".repeat(1100) },
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  describe("List with frameworkId", () => {
    it("returns evidence for controls in framework", async () => {
      const c1 = await api.controls.create({
        name: "C1",
        description: "Desc",
        category: "test",
      });
      const c2 = await api.controls.create({
        name: "C2",
        description: "Desc",
        category: "test",
      });
      expect(c1.ok && c2.ok).toBe(true);
      if (!c1.ok || !c2.ok) return;
      const fw = await api.frameworks.create({
        name: "F",
        requirements: [
          { requirementId: "R1", controlIds: [c1.result.id] },
          { requirementId: "R2", controlIds: [c2.result.id] },
        ],
      });
      expect(fw.ok).toBe(true);
      if (!fw.ok) return;
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
      const res = await api.evidence.list({ frameworkId: fw.result.id });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.length).toBeGreaterThanOrEqual(2);
      const controlIds = new Set([c1.result.id, c2.result.id]);
      expect(res.result.every((e) => controlIds.has(e.controlId))).toBe(true);
    });

    it("returns FRAMEWORK_NOT_FOUND for nonexistent frameworkId", async () => {
      const res = await api.evidence.list({ frameworkId: "nonexistent-fw" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("FRAMEWORK_NOT_FOUND");
    });
  });
});
