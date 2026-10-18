import { describe, it, expect, beforeAll } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { compFn } from "../compfn.js";
import { createSchemaIfSupported } from "../storage/adapter.js";
import { createCompFnRouter } from "../http/routes.js";

describe("HTTP API (TV-HTTP-001)", () => {
  let api: ReturnType<typeof compFn>;
  let app: { request(path: string, init?: RequestInit): Promise<Response> };

  beforeAll(async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    if (!result.success) throw new Error(result.errors?.join("; "));
    api = compFn({ database: db, namespace: "compfn" });
    const router = createCompFnRouter(api);
    app = { request: (path, init) => router.handle(new Request(new URL(path, "http://compfn.local"), init)) };
  });

  describe("TV-HTTP-001 (HTTP envelope)", () => {
    it("POST /controls returns 201 with { ok: true, result: Control }", async () => {
      const res = await app.request("/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "HTTP Test Control",
          description: "Test via HTTP",
          category: "test",
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result).toBeDefined();
      expect(json.result.id).toBeDefined();
      expect(json.result.name).toBe("HTTP Test Control");
      expect(json.result.category).toBe("test");
    });

    it("GET /controls/:id returns 200 with { ok: true, result: Control }", async () => {
      const createRes = await app.request("/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Get Test Control",
          description: "Test GET",
          category: "test",
        }),
      });
      const created = await createRes.json();
      expect(created.ok).toBe(true);
      const controlId = created.result.id;

      const res = await app.request(`/controls/${controlId}`, {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result).toBeDefined();
      expect(json.result.id).toBe(controlId);
      expect(json.result.name).toBe("Get Test Control");
    });

    it("GET /controls/:id for nonexistent returns 404 with { ok: false, error: { code: CONTROL_NOT_FOUND } }", async () => {
      const res = await app.request("/controls/nonexistent-id", {
        method: "GET",
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error).toBeDefined();
      expect(json.error.code).toBe("CONTROL_NOT_FOUND");
      expect(json.error.message).toBeDefined();
      expect(json.error.details).toBeDefined();
    });

    it("GET /controls returns 200 with { ok: true, result: Control[] }", async () => {
      const res = await app.request("/controls", {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.result)).toBe(true);
    });

    it("PATCH /controls/:id returns 200 with updated control", async () => {
      const createRes = await app.request("/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Original",
          description: "Original desc",
          category: "test",
        }),
      });
      const created = await createRes.json();
      const controlId = created.result.id;

      const res = await app.request(`/controls/${controlId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.name).toBe("Updated");
      expect(json.result.id).toBe(controlId);
    });

    it("DELETE /controls/:id returns 200", async () => {
      const createRes = await app.request("/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "To Delete",
          description: "Will be deleted",
          category: "test",
        }),
      });
      const created = await createRes.json();
      const controlId = created.result.id;

      const res = await app.request(`/controls/${controlId}`, {
        method: "DELETE",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);

      const getRes = await app.request(`/controls/${controlId}`, {
        method: "GET",
      });
      expect(getRes.status).toBe(404);
    });
  });

  describe("Frameworks endpoints", () => {
    it("POST /frameworks returns 201 with envelope", async () => {
      const controlRes = await app.request("/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Control for FW",
          description: "Test",
          category: "test",
        }),
      });
      const control = await controlRes.json();
      const controlId = control.result.id;

      const res = await app.request("/frameworks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Framework",
          version: "1.0",
          requirements: [
            { requirementId: "R1", controlIds: [controlId] },
          ],
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.id).toBeDefined();
    });

    it("GET /frameworks/:id returns 200 with envelope", async () => {
      const controlRes = await app.request("/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Control for FW2",
          description: "Test",
          category: "test",
        }),
      });
      const control = await controlRes.json();

      const createRes = await app.request("/frameworks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Framework 2",
          requirements: [
            { requirementId: "R1", controlIds: [control.result.id] },
          ],
        }),
      });
      const created = await createRes.json();
      const frameworkId = created.result.id;

      const res = await app.request(`/frameworks/${frameworkId}`, {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.id).toBe(frameworkId);
    });
  });

  describe("Evidence endpoints", () => {
    it("POST /evidence returns 201 with envelope", async () => {
      const controlRes = await app.request("/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Control for Evidence",
          description: "Test",
          category: "test",
        }),
      });
      const control = await controlRes.json();
      const controlId = control.result.id;

      const res = await app.request("/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          controlId,
          type: "manual_attestation",
          actorId: "user1",
          outcome: "pass",
          payload: { note: "Test evidence" },
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.id).toBeDefined();
      expect(json.result.controlId).toBe(controlId);
    });

    it("GET /evidence with filters returns 200", async () => {
      const res = await app.request("/evidence?controlId=test123", {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.result)).toBe(true);
    });

    it("GET /evidence/:id returns 200 or 404", async () => {
      const res = await app.request("/evidence/nonexistent", {
        method: "GET",
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("EVIDENCE_NOT_FOUND");
    });
  });

  describe("Checks endpoints", () => {
    it("POST /checks returns 201 with envelope", async () => {
      const controlRes = await app.request("/controls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Control for Check",
          description: "Test",
          category: "test",
        }),
      });
      const control = await controlRes.json();
      const controlId = control.result.id;

      const res = await app.request("/checks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test Check",
          controlId,
          schedule: "daily",
        }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.id).toBeDefined();
    });

    it("GET /checks returns 200 with array", async () => {
      const res = await app.request("/checks", {
        method: "GET",
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(Array.isArray(json.result)).toBe(true);
    });
  });

  describe("Readiness endpoints", () => {
    it("GET /readiness/control/:controlId returns 200 or 404", async () => {
      const res = await app.request("/readiness/control/nonexistent", {
        method: "GET",
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("CONTROL_NOT_FOUND");
    });

    it("GET /readiness/framework/:frameworkId returns 200 or 404", async () => {
      const res = await app.request("/readiness/framework/nonexistent", {
        method: "GET",
      });

      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.error.code).toBe("FRAMEWORK_NOT_FOUND");
    });
  });

  describe("Export endpoints", () => {
    it("POST /export/auditor-pack returns 200 with envelope", async () => {
      const res = await app.request("/export/auditor-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.result.exportedAt).toBeDefined();
      expect(json.result.controls).toBeDefined();
      expect(json.result.frameworks).toBeDefined();
      expect(json.result.evidence).toBeDefined();
    });
  });
});

describe('shared HTTP request boundaries', () => {
  const request = (body: string, maxBodyBytes = 1024) => {
    const api = compFn({ database: memoryAdapter() });
    const router = createCompFnRouter(api, { maxBodyBytes });
    return router.handle(new Request('http://compfn.local/controls', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }));
  };
  it('returns a JSON error envelope for malformed JSON', async () => {
    const response = await request('{');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } });
  });
  it('bounds streamed request bodies before service execution', async () => {
    const response = await request(JSON.stringify({ name: 'large body' }), 4);
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
  });
});
