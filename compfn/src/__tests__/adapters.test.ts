/**
 * Adapter tests: TV-ADAPT-INTERFACE-001, TV-ADAPT-SECFN-001, TV-ADAPT-AUTHFN-001.
 * Phase 07: EvidenceAdapter interface, secfn adapter, authfn adapter; check run with
 * adapters creates evidence with correct type.
 */

import { describe, it, expect, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn, createSecfnAdapter, createAuthfnAdapter } from "../index.js";
import { createSchemaIfSupported } from "../storage/adapter.js";

describe("Adapters (TV-ADAPT-*)", () => {
  describe("TV-ADAPT-INTERFACE-001 (Adapter interface)", () => {
    it("compFn accepts adapters; check with adapterName 'mock' can be created and run (run invokes adapter.runCheck)", async () => {
      const mockAdapter = {
        name: "mock",
        runCheck: async () => ({ type: "custom_check" as const, outcome: "unknown" as const }),
      };
      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({
        database: db,
        namespace: "compfn",
        adapters: { mock: mockAdapter },
      });
      expect(api.controls).toBeDefined();
      expect(api.checks).toBeDefined();

      const ctrl = await api.controls.create({
        name: "Interface control",
        description: "For adapter interface test",
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
      expect(runRes.result.evidenceId).toBeDefined();
      const evRes = await api.evidence.get(runRes.result.evidenceId);
      expect(evRes.ok).toBe(true);
      if (!evRes.ok) return;
      expect(evRes.result.type).toBe("custom_check");
      expect(evRes.result.outcome).toBe("unknown");
    });
  });

  describe("TV-ADAPT-SECFN-001 (Secfn adapter returns evidence)", () => {
    it("secfn adapter with mock client returns AdapterEvidence with type automated_secfn; run creates evidence with type automated_secfn", async () => {
      const secfnAdapter = createSecfnAdapter({
        client: {
          getRbacStatus: async () => ({ enabled: true, summary: "RBAC enabled" }),
        },
      });
      expect(secfnAdapter.name).toBe("secfn");

      const directResult = await secfnAdapter.runCheck({
        checkId: "ch1",
        controlId: "c1",
        method: "getRbacStatus",
      });
      expect(directResult.type).toBe("automated_secfn");
      expect(directResult.outcome).toBe("pass");
      expect(directResult.payload).toBeDefined();

      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({
        database: db,
        namespace: "compfn",
        adapters: { secfn: secfnAdapter },
      });

      const ctrl = await api.controls.create({
        name: "RBAC control",
        description: "RBAC enabled",
        category: "access",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      const createRes = await api.checks.create({
        name: "RBAC check",
        controlId: c.id,
        adapterName: "secfn",
        adapterMethod: "getRbacStatus",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;
      const ch = createRes.result;

      const runRes = await api.checks.run(ch.id);
      expect(runRes.ok).toBe(true);
      if (!runRes.ok) return;
      const evRes = await api.evidence.get(runRes.result.evidenceId);
      expect(evRes.ok).toBe(true);
      if (!evRes.ok) return;
      expect(evRes.result.type).toBe("automated_secfn");
      expect(evRes.result.controlId).toBe(c.id);
      expect(evRes.result.outcome).toBe("pass");
    });
  });

  describe("TV-ADAPT-AUTHFN-001 (Authfn adapter)", () => {
    it("authfn adapter with mock client returns AdapterEvidence with type automated_authfn; run creates evidence with type automated_authfn", async () => {
      const authfnAdapter = createAuthfnAdapter({
        client: {
          getMfaStatus: async () => ({ enforced: true, summary: "MFA enforced" }),
        },
      });
      expect(authfnAdapter.name).toBe("authfn");

      const directResult = await authfnAdapter.runCheck({
        checkId: "ch1",
        controlId: "c1",
        method: "getMfaStatus",
      });
      expect(directResult.type).toBe("automated_authfn");
      expect(directResult.outcome).toBe("pass");
      expect(directResult.payload).toBeDefined();

      const db = memoryAdapter();
      await db.initialize();
      const schemaResult = await createSchemaIfSupported(db, { namespace: "compfn" });
      if (!schemaResult.success) throw new Error(schemaResult.errors?.join("; "));
      const api = compFn({
        database: db,
        namespace: "compfn",
        adapters: { authfn: authfnAdapter },
      });

      const ctrl = await api.controls.create({
        name: "MFA control",
        description: "MFA enforced",
        category: "access",
      });
      expect(ctrl.ok).toBe(true);
      if (!ctrl.ok) return;
      const c = ctrl.result;

      const createRes = await api.checks.create({
        name: "MFA check",
        controlId: c.id,
        adapterName: "authfn",
        adapterMethod: "getMfaStatus",
      });
      expect(createRes.ok).toBe(true);
      if (!createRes.ok) return;
      const ch = createRes.result;

      const runRes = await api.checks.run(ch.id);
      expect(runRes.ok).toBe(true);
      if (!runRes.ok) return;
      const evRes = await api.evidence.get(runRes.result.evidenceId);
      expect(evRes.ok).toBe(true);
      if (!evRes.ok) return;
      expect(evRes.result.type).toBe("automated_authfn");
      expect(evRes.result.controlId).toBe(c.id);
      expect(evRes.result.outcome).toBe("pass");
    });
  });
});


describe("requested adapter method isolation", () => {
  it.each([
    ["authfn", "getSessionPolicy"], ["authfn", "getUserInfo"], ["authfn", "typo"],
    ["secfn", "getSecretScanSummary"], ["secfn", "getSecurityEvents"], ["secfn", "typo"],
  ])("%s %s cannot pass by invoking a different method", async (name, method) => {
    const defaultCheck = vi.fn(async () => ({ enforced: true, enabled: true }));
    const adapter = name === "authfn"
      ? createAuthfnAdapter({ client: { getMfaStatus: defaultCheck } })
      : createSecfnAdapter({ client: { getRbacStatus: defaultCheck } });
    const db = memoryAdapter();
    await db.initialize();
    const api = compFn({ database: db, adapters: { [name]: adapter } });
    const control = await api.controls.create({ name: "Requested policy", description: "Test", category: "security" });
    if (!control.ok) throw new Error(control.error.message);
    const check = await api.checks.create({ name: "Unsupported policy", controlId: control.result.id, adapterName: name, adapterMethod: method });
    if (!check.ok) throw new Error(check.error.message);
    const run = await api.checks.run(check.result.id);
    expect(run).toMatchObject({ ok: true, result: { outcome: "unknown" } });
    expect(defaultCheck).not.toHaveBeenCalled();
    const readiness = await api.readiness.forControl(control.result.id);
    expect(readiness.ok).toBe(true);
    if (readiness.ok) expect(readiness.result.status).not.toBe("compliant");
    await db.close();
  });
});

describe("secret scan completion evidence", () => {
  it.each(["failed", "running", "cancelled", "pending", "unrecognized"])("does not certify a control from a %s scan with zero findings", async status => {
    const db = memoryAdapter();
    await db.initialize();
    try {
      const api = compFn({ database: db, adapters: { secfn: createSecfnAdapter({ client: {
        getSecretScanSummary: async () => ({ findings: 0, status, lastScanAt: Date.now() }),
      } }) } });
      const control = await api.controls.create({ name: "Secret scan", description: "Completed scan required", category: "security" });
      if (!control.ok) throw new Error(control.error.message);
      const check = await api.checks.create({ name: "Scan", controlId: control.result.id, adapterName: "secfn", adapterMethod: "getSecretScanSummary" });
      if (!check.ok) throw new Error(check.error.message);
      const result = await api.checks.run(check.result.id);
      expect(result).toMatchObject({ ok: true, result: { outcome: "unknown" } });
      const readiness = await api.readiness.forControl(control.result.id);
      expect(readiness.ok).toBe(true);
      if (readiness.ok) expect(readiness.result.status).not.toBe("compliant");
    } finally { await db.close(); }
  });
});


it.each([
  [{ findings: 0 }, "pass"],
  [{ findings: 0, status: " COMPLETED " }, "pass"],
  [{ findings: 2, status: "succeeded" }, "fail"],
  [{ findings: 2, status: "running" }, "unknown"],
  [{ findings: -1, status: "completed" }, "unknown"],
  [{ findings: 0.5, status: "completed" }, "unknown"],
  [{ findings: Number.NaN, status: "completed" }, "unknown"],
  [{ status: "completed" }, "unknown"],
] as const)("validates secret scan completion and count: %j", async (summary, expected) => {
  const adapter = createSecfnAdapter({ client: { getSecretScanSummary: async () => summary } });
  const result = await adapter.runCheck({ checkId: "check", controlId: "control", method: "getSecretScanSummary" });
  expect(result.outcome).toBe(expected);
});
