/**
 * Unit tests for checks create, get, list, run, delete (TV-CHECK-*).
 * Phase 04: check CRUD; run with adapter; CHECK_NOT_FOUND, ADAPTER_NOT_FOUND, ADAPTER_ERROR; run creates evidence.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import type { EvidenceAdapter } from "../api.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

const mockAdapter: EvidenceAdapter = {
  name: "mock",
  runCheck: async () => ({
    type: "custom_check",
    outcome: "pass",
  }),
};

const throwingAdapter: EvidenceAdapter = {
  name: "throw",
  runCheck: async () => {
    throw new Error("Adapter failed");
  },
};

describe("Checks (TV-CHECK-*)", () => {
  describe("TV-CHECK-CREATE-001 (Positive: create check)", () => {
    it("returns CheckDefinition with controlId, id set", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const result = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!result.success) throw new Error(result.errors?.join("; "));
      const api = compFn({ database: db, namespace: "compfn" });

      const ctrl = await api.controls.create({
        name: "Access reviews",
        description: "Quarterly access reviews",
        category: "access",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      const res = await api.checks.create({
        name: "RBAC check",
        controlId: c.id,
        adapterName: "secfn",
        adapterMethod: "getRbacStatus",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.result.controlId).toBe(c.id);
      expect(res.result.id).toBeDefined();
      expect(res.result.name).toBe("RBAC check");
      expect(res.result.adapterName).toBe("secfn");
      expect(res.result.adapterMethod).toBe("getRbacStatus");
      expect(res.result.createdAt).toBeDefined();
      expect(res.result.updatedAt).toBeDefined();
    });
  });

  describe("TV-CHECK-RUN-001 (Positive: run check)", () => {
    it("returns RunCheckResult with checkId, controlId, evidenceId, outcome, timestamp", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({
        database: db,
        namespace: "compfn",
        adapters: { mock: mockAdapter },
      });

      const ctrl = await api.controls.create({
        name: "Test control",
        description: "For check run",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      const createRes = await api.checks.create({
        name: "Mock check",
        controlId: c.id,
        adapterName: "mock",
        adapterMethod: "run",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;
      const ch = createRes.result;

      const runRes = await api.checks.run(ch.id);
      expect(runRes.ok).toBe(true);
      if (!runRes.ok) return;
      expect(runRes.result.checkId).toBe(ch.id);
      expect(runRes.result.controlId).toBe(c.id);
      expect(runRes.result.evidenceId).toBeDefined();
      expect(runRes.result.outcome).toBe("pass");
      expect(runRes.result.timestamp).toBeDefined();
    });
  });

  describe("TV-CHECK-RUN-002 (Negative: run nonexistent check)", () => {
    it("returns CHECK_NOT_FOUND", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({ database: db, namespace: "compfn" });

      const runRes = await api.checks.run("nonexistent-id");
      expect(runRes.ok).toBe(false);
      if (runRes.ok) return;
      expect(runRes.error.code).toBe("CHECK_NOT_FOUND");
      expect(runRes.error.details.id).toBe("nonexistent-id");
    });
  });

  describe("TV-CHECK-RUN-003 (Negative: adapter throws)", () => {
    it("returns ADAPTER_ERROR", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({
        database: db,
        namespace: "compfn",
        adapters: { throw: throwingAdapter },
      });

      const ctrl = await api.controls.create({
        name: "Test control",
        description: "For throw test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      const createRes = await api.checks.create({
        name: "Throwing check",
        controlId: c.id,
        adapterName: "throw",
        adapterMethod: "run",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;
      const ch = createRes.result;

      const runRes = await api.checks.run(ch.id);
      expect(runRes.ok).toBe(false);
      if (runRes.ok) return;
      expect(runRes.error.code).toBe("ADAPTER_ERROR");
      expect(runRes.error.details.adapterName).toBe("throw");
    });
  });

  describe("TV-CHECK-RUN-004 (Negative: adapter not found)", () => {
    it("returns ADAPTER_NOT_FOUND", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({ database: db, namespace: "compfn" });

      const ctrl = await api.controls.create({
        name: "Test control",
        description: "For missing adapter test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      const createRes = await api.checks.create({
        name: "Missing adapter check",
        controlId: c.id,
        adapterName: "missingAdapter",
        adapterMethod: "run",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;
      const ch = createRes.result;

      const runRes = await api.checks.run(ch.id);
      expect(runRes.ok).toBe(false);
      if (runRes.ok) return;
      expect(runRes.error.code).toBe("ADAPTER_NOT_FOUND");
      expect(runRes.error.details.adapterName).toBe("missingAdapter");
    });
  });

  describe("TV-CHECK-EVIDENCE-001 (Positive: run creates evidence)", () => {
    it("evidence.get(result.evidenceId) returns evidence with controlId === check.controlId", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({
        database: db,
        namespace: "compfn",
        adapters: { mock: mockAdapter },
      });

      const ctrl = await api.controls.create({
        name: "Evidence control",
        description: "For evidence test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      const createRes = await api.checks.create({
        name: "Evidence check",
        controlId: c.id,
        adapterName: "mock",
        adapterMethod: "run",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;
      const ch = createRes.result;

      const runRes = await api.checks.run(ch.id);
      expect(runRes.ok).toBe(true);
      if (!runRes.ok) return;
      const evidenceId = runRes.result.evidenceId;

      const evRes = await api.evidence.get(evidenceId);
      expect(evRes.ok).toBe(true);
      if (!evRes.ok) return;
      expect(evRes.result.controlId).toBe(c.id);
      expect(evRes.result.id).toBe(evidenceId);
    });
  });

  describe("checks.get / list / delete and CHECK_NOT_FOUND", () => {
    it("get(nonexistent) returns CHECK_NOT_FOUND", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({ database: db, namespace: "compfn" });

      const getRes = await api.checks.get("nonexistent-id");
      expect(getRes.ok).toBe(false);
      if (getRes.ok) return;
      expect(getRes.error.code).toBe("CHECK_NOT_FOUND");
    });

    it("delete(nonexistent) returns CHECK_NOT_FOUND", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({ database: db, namespace: "compfn" });

      const delRes = await api.checks.delete("nonexistent-id");
      expect(delRes.ok).toBe(false);
      if (delRes.ok) return;
      expect(delRes.error.code).toBe("CHECK_NOT_FOUND");
    });

    it("list returns array; after create and delete get returns CHECK_NOT_FOUND", async () => {
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({ database: db, namespace: "compfn" });

      const listRes = await api.checks.list();
      expect(listRes.ok).toBe(true);
      if (!listRes.ok) return;
      expect(Array.isArray(listRes.result)).toBe(true);

      const ctrl = await api.controls.create({
        name: "List control",
        description: "For list test",
        category: "test",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const createRes = await api.checks.create({
        name: "To delete",
        controlId: ctrl.result.id,
        schedule: "0 * * * *",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;
      const ch = createRes.result;

      const afterCreate = await api.checks.list();
      expect(afterCreate.ok).toBe(true);
      if (!afterCreate.ok) return;
      expect(afterCreate.result.some((x) => x.id === ch.id)).toBe(true);

      const delRes = await api.checks.delete(ch.id);
      expect(delRes.ok).toBe(true);

      const getAfter = await api.checks.get(ch.id);
      expect(getAfter.ok).toBe(false);
      if (getAfter.ok) return;
      expect(getAfter.error.code).toBe("CHECK_NOT_FOUND");
    });
  });
});
