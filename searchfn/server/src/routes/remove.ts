import type { SearchAdapter } from "@searchfn/adapters";
import { parseJsonBody, mapAdapterErrorToResponse, okResponse } from "../http/errors.js";
import { validateResource, validateIds } from "../http/validation.js";
import type { ServerLimits } from "../http/validation.js";
import type { ServerContext } from "../server.js";

export function removeHandler(adapter: SearchAdapter, limits: ServerLimits) {
  return async (req: Request, _ctx: ServerContext): Promise<Response> => {
    const parsed = await parseJsonBody(req, limits.maxPayloadBytes);
    if (!parsed.ok) return parsed.response;

    const body = parsed.data as Record<string, unknown>;

    const resourceErr = validateResource(body.resource);
    if (resourceErr) return resourceErr;

    const idsErr = validateIds(body.ids);
    if (idsErr) return idsErr;

    try {
      await adapter.remove({
        resource: body.resource as string,
        ids: body.ids as Array<string | number>,
        signal: req.signal,
      });
      return okResponse({ removed: (body.ids as any[]).length });
    } catch (err) {
      return mapAdapterErrorToResponse(err, "Remove operation failed");
    }
  };
}
