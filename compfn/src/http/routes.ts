import { Hono } from "hono";
import type { CompFnAPI } from "../api.js";
import type { CompfnErrorCode } from "../errors.js";
import type { StatusCode } from "hono/utils/http-status";

export function createCompFnRouter(api: CompFnAPI) {
  const app = new Hono();

  app.post("/controls", async (c) => {
    const body = await c.req.json();
    const result = await api.controls.create(body);
    if (result.ok) {
      c.status(201);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/controls", async (c) => {
    const category = c.req.query("category");
    const tags = c.req.query("tags");
    const filters: { category?: string; tags?: string[] } = {};
    if (category) filters.category = category;
    if (tags) filters.tags = tags.split(",");
    
    const result = await api.controls.list(filters);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/controls/:id", async (c) => {
    const id = c.req.param("id");
    const result = await api.controls.get(id);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.patch("/controls/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const result = await api.controls.update(id, body);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.delete("/controls/:id", async (c) => {
    const id = c.req.param("id");
    const result = await api.controls.delete(id);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: undefined });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.post("/frameworks", async (c) => {
    const body = await c.req.json();
    const result = await api.frameworks.create(body);
    if (result.ok) {
      c.status(201);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/frameworks", async (c) => {
    const result = await api.frameworks.list();
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/frameworks/:id", async (c) => {
    const id = c.req.param("id");
    const result = await api.frameworks.get(id);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.patch("/frameworks/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json();
    const result = await api.frameworks.update(id, body);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.delete("/frameworks/:id", async (c) => {
    const id = c.req.param("id");
    const result = await api.frameworks.delete(id);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: undefined });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.post("/evidence", async (c) => {
    const body = await c.req.json();
    const result = await api.evidence.create(body);
    if (result.ok) {
      c.status(201);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/evidence", async (c) => {
    const controlId = c.req.query("controlId");
    const frameworkId = c.req.query("frameworkId");
    const type = c.req.query("type");
    const since = c.req.query("since");
    
    const filters: {
      controlId?: string;
      frameworkId?: string;
      type?: any;
      since?: number;
    } = {};
    if (controlId) filters.controlId = controlId;
    if (frameworkId) filters.frameworkId = frameworkId;
    if (type) filters.type = type as any;
    if (since) filters.since = parseInt(since, 10);
    
    const result = await api.evidence.list(filters);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/evidence/:id", async (c) => {
    const id = c.req.param("id");
    const result = await api.evidence.get(id);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.post("/checks", async (c) => {
    const body = await c.req.json();
    const result = await api.checks.create(body);
    if (result.ok) {
      c.status(201);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/checks", async (c) => {
    const result = await api.checks.list();
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/checks/:id", async (c) => {
    const id = c.req.param("id");
    const result = await api.checks.get(id);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.post("/checks/:id/run", async (c) => {
    const id = c.req.param("id");
    const result = await api.checks.run(id);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.delete("/checks/:id", async (c) => {
    const id = c.req.param("id");
    const result = await api.checks.delete(id);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: undefined });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/readiness/control/:controlId", async (c) => {
    const controlId = c.req.param("controlId");
    const frameworkId = c.req.query("frameworkId");
    const result = await api.readiness.forControl(controlId, frameworkId);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.get("/readiness/framework/:frameworkId", async (c) => {
    const frameworkId = c.req.param("frameworkId");
    const result = await api.readiness.forFramework(frameworkId);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  app.post("/export/auditor-pack", async (c) => {
    const body = await c.req.json();
    const result = await api.export.auditorPack(body);
    if (result.ok) {
      c.status(200);
      return c.json({ ok: true, result: result.result });
    }
    c.status(getStatusCode(result.error.code) as StatusCode);
    return c.json({ ok: false, error: result.error });
  });

  return app;
}

function getStatusCode(code: CompfnErrorCode): number {
  switch (code) {
    case "CONTROL_NOT_FOUND":
    case "FRAMEWORK_NOT_FOUND":
    case "EVIDENCE_NOT_FOUND":
    case "CHECK_NOT_FOUND":
    case "ADAPTER_NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
      return 400;
    case "PAYLOAD_TOO_LARGE":
      return 413;
    case "RATE_LIMITED":
      return 429;
    case "ADAPTER_ERROR":
    case "STORAGE_ERROR":
    case "EXPORT_FAILED":
    default:
      return 500;
  }
}
