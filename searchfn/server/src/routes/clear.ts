import type { SearchAdapter } from "@searchfn/adapter-contracts";
import { mapAdapterErrorToResponse, okResponse } from "../http/errors.js";

export function clearHandler(adapter: SearchAdapter) {
  return async (req: Request, body: Record<string, unknown>): Promise<Response> => {
    try {
      await adapter.clear(body.resource as string, req.signal);
      return okResponse({ cleared: body.resource });
    } catch (err) {
      return mapAdapterErrorToResponse(err, "Clear operation failed");
    }
  };
}
