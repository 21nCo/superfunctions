import { createRouter, PayloadTooLargeError } from "@superfunctions/http";
import { CatchFnConflictError, CatchFnValidationError, type CatchFnService, type BugFilters } from "./service.js";
import type { BugReportEvent } from "catchfn";

export interface CatchFnRouterConfig {
  /** Authenticate and select the scoped service at the application boundary. */
  authorize?: (request: Request) => boolean | Promise<boolean>;
  maxBodyBytes?: number;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers:{"content-type":"application/json"}});
export function createCatchFnRouter(service: CatchFnService, config: CatchFnRouterConfig = {}) {
  const allowed = async (request: Request) => !config.authorize || await config.authorize(request);
  return createRouter({
    maxBodyBytes: config.maxBodyBytes ?? 262144,
    onError: (error) => {
      if (error instanceof CatchFnValidationError || error instanceof SyntaxError) return json({error:"Invalid request"},400);
      if (error instanceof CatchFnConflictError) return json({error:"Bug id already exists"},409);
      if (error instanceof PayloadTooLargeError) return json({error:"Payload too large"},413);
      return json({error:"Internal Server Error"},500);
    },
    routes: [
      {method:"POST", path:"/bugs", handler: async (request, context) => {
        if (!await allowed(request)) return json({error:"Unauthorized"},401);
        return json(await service.createBug(await context.json() as BugReportEvent),201);
      }},
      {method:"GET", path:"/bugs/:id", handler: async (request, context) => {
        if (!await allowed(request)) return json({error:"Unauthorized"},401);
        const report = await service.getBug(context.params.id);
        return report ? json(report) : json({error:"Bug not found"},404);
      }},
      {method:"GET", path:"/bugs", handler: async (request, context) => {
        if (!await allowed(request)) return json({error:"Unauthorized"},401);
        const url = new URL(request.url);
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
        const filters: BugFilters = {};
        for (const field of ["app", "severity", "sessionId", "replayId", "issueId"] as const) {
          const value = url.searchParams.get(field);
          if (value) (filters as Record<string, unknown>)[field] = value;
        }
        for (const field of ["from", "to"] as const) if (url.searchParams.has(field)) filters[field] = Number(url.searchParams.get(field));
        filters.tags = url.searchParams.getAll("tag");
        return json(await service.listBugs(limit, offset, filters));
      }},
    ],
  });
}
