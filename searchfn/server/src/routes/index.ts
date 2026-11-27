import type { SearchAdapter } from "@searchfn/adapter-contracts";
import { mapAdapterErrorToResponse, okResponse } from "../http/errors.js";
import { validateDocuments } from "../http/validation.js";
import type { ServerLimits } from "../http/validation.js";

export function indexHandler(adapter: SearchAdapter, limits: ServerLimits) {
  return async (req: Request, body: Record<string, unknown>): Promise<Response> => {
    const docsErr = validateDocuments(body.documents, limits);
    if (docsErr) return docsErr;

    try {
      await adapter.index({
        resource: body.resource as string,
        documents: body.documents as any[],
        signal: req.signal,
      });
      return okResponse({ indexed: (body.documents as any[]).length });
    } catch (err) {
      return mapAdapterErrorToResponse(err, "Index operation failed");
    }
  };
}
