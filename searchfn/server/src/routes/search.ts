import type { SearchAdapter } from "@searchfn/adapters";
import { parseJsonBody, mapAdapterErrorToResponse, okResponse } from "../http/errors.js";
import { validateResource, validateQuery, validateLimit } from "../http/validation.js";
import type { ServerLimits } from "../http/validation.js";
import type { ServerContext } from "../server.js";

export function searchHandler(adapter: SearchAdapter, limits: ServerLimits) {
  return async (req: Request, _ctx: ServerContext): Promise<Response> => {
    const parsed = await parseJsonBody(req, limits.maxPayloadBytes);
    if (!parsed.ok) return parsed.response;

    const body = parsed.data as Record<string, unknown>;

    const resourceErr = validateResource(body.resource);
    if (resourceErr) return resourceErr;

    const queryErr = validateQuery(body.query, limits);
    if (queryErr) return queryErr;

    const { value: limit, error: limitErr } = validateLimit(
      body.limit,
      limits.maxLimit,
    );
    if (limitErr) return limitErr;

    try {
      const ids = await adapter.search({
        resource: body.resource as string,
        query: body.query as string,
        fields: Array.isArray(body.fields) ? body.fields : undefined,
        limit,
        fuzzy: body.fuzzy as boolean | number | undefined,
        fieldBoosts: body.fieldBoosts as Record<string, number> | undefined,
        signal: req.signal,
      });
      return okResponse({ ids });
    } catch (err) {
      return mapAdapterErrorToResponse(err, "Search operation failed");
    }
  };
}
