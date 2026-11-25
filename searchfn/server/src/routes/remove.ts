import type { SearchAdapter } from "@searchfn/adapter-contracts";
import { mapAdapterErrorToResponse, okResponse } from "../http/errors.js";
import { validateIds } from "../http/validation.js";

export function removeHandler(adapter: SearchAdapter) {
  return async (req: Request, body: Record<string, unknown>): Promise<Response> => {
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
