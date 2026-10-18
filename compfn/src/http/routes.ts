import { createRouter, RouterError, type Route } from "@superfunctions/http";
import type { CompFnAPI } from "../api.js";
import type { CompfnErrorCode } from "../errors.js";
import type { CompfnEnvelope } from "../errors.js";

/** Returns the shared Web Request router; consumers choose their HTTP adapter. */
export function createCompFnRouter(api: CompFnAPI, options: { maxBodyBytes?: number } = {}) {
  const routes: Route[] = [];

  routes.push({ method: "POST", path: "/controls", handler: async (_request, ctx) => {
    const body = await ctx.json();
    const result = await api.controls.create(body);
    return envelopeResponse(result, 201);
  } });

  routes.push({ method: "GET", path: "/controls", handler: async (_request, ctx) => {
    const category = (ctx.query.get("category") ?? undefined);
    const tags = (ctx.query.get("tags") ?? undefined);
    const filters: { category?: string; tags?: string[] } = {};
    if (category) filters.category = category;
    if (tags) filters.tags = tags.split(",");

    const result = await api.controls.list(filters);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "GET", path: "/controls/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const result = await api.controls.get(id);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "PATCH", path: "/controls/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const body = await ctx.json();
    const result = await api.controls.update(id, body);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "DELETE", path: "/controls/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const result = await api.controls.delete(id);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "POST", path: "/frameworks", handler: async (_request, ctx) => {
    const body = await ctx.json();
    const result = await api.frameworks.create(body);
    return envelopeResponse(result, 201);
  } });

  routes.push({ method: "GET", path: "/frameworks", handler: async (_request, ctx) => {
    const result = await api.frameworks.list();
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "GET", path: "/frameworks/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const result = await api.frameworks.get(id);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "PATCH", path: "/frameworks/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const body = await ctx.json();
    const result = await api.frameworks.update(id, body);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "DELETE", path: "/frameworks/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const result = await api.frameworks.delete(id);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "POST", path: "/evidence", handler: async (_request, ctx) => {
    const body = await ctx.json();
    const result = await api.evidence.create(body);
    return envelopeResponse(result, 201);
  } });

  routes.push({ method: "GET", path: "/evidence", handler: async (_request, ctx) => {
    const controlId = (ctx.query.get("controlId") ?? undefined);
    const frameworkId = (ctx.query.get("frameworkId") ?? undefined);
    const type = (ctx.query.get("type") ?? undefined);
    const since = (ctx.query.get("since") ?? undefined);

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
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "GET", path: "/evidence/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const result = await api.evidence.get(id);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "POST", path: "/checks", handler: async (_request, ctx) => {
    const body = await ctx.json();
    const result = await api.checks.create(body);
    return envelopeResponse(result, 201);
  } });

  routes.push({ method: "GET", path: "/checks", handler: async (_request, ctx) => {
    const result = await api.checks.list();
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "GET", path: "/checks/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const result = await api.checks.get(id);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "POST", path: "/checks/:id/run", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const result = await api.checks.run(id);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "DELETE", path: "/checks/:id", handler: async (_request, ctx) => {
    const id = ctx.params["id"];
    const result = await api.checks.delete(id);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "GET", path: "/readiness/control/:controlId", handler: async (_request, ctx) => {
    const controlId = ctx.params["controlId"];
    const frameworkId = (ctx.query.get("frameworkId") ?? undefined);
    const result = await api.readiness.forControl(controlId, frameworkId);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "GET", path: "/readiness/framework/:frameworkId", handler: async (_request, ctx) => {
    const frameworkId = ctx.params["frameworkId"];
    const result = await api.readiness.forFramework(frameworkId);
    return envelopeResponse(result, 200);
  } });

  routes.push({ method: "POST", path: "/export/auditor-pack", handler: async (_request, ctx) => {
    const body = await ctx.json();
    const result = await api.export.auditorPack(body);
    return envelopeResponse(result, 200);
  } });

  return createRouter({
    routes,
    maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024,
    onError(error) {
      const status = error instanceof RouterError ? error.statusCode : error instanceof SyntaxError ? 400 : 500;
      return Response.json({ ok: false, error: {
        code: status === 413 ? "PAYLOAD_TOO_LARGE" : status < 500 ? "VALIDATION_FAILED" : "STORAGE_ERROR",
        message: status >= 500 ? "Request failed" : error.message,
        details: {},
      } }, { status });
    },
  });
}

function envelopeResponse<T>(result: CompfnEnvelope<T>, successStatus: number): Response {
  return Response.json(result, { status: result.ok ? successStatus : getStatusCode(result.error.code) });
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
