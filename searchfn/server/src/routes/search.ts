import type { SearchAdapter } from "@searchfn/adapter-contracts";
import { mapAdapterErrorToResponse, okResponse } from "../http/errors.js";
import {
  validateFieldBoosts,
  validateFields,
  validateFuzzy,
  validateLimit,
  validatePrefix,
  validateQuery,
} from "../http/validation.js";
import type { ServerLimits } from "../http/validation.js";

export function searchHandler(adapter: SearchAdapter, limits: ServerLimits) {
  return async (req: Request, body: Record<string, unknown>): Promise<Response> => {
    const queryErr = validateQuery(body.query, limits);
    if (queryErr) return queryErr;

    const { value: limit, error: limitErr } = validateLimit(
      body.limit,
      limits.maxLimit,
    );
    if (limitErr) return limitErr;

    const fieldsErr = validateFields(body.fields);
    if (fieldsErr) return fieldsErr;

    const fuzzyErr = validateFuzzy(body.fuzzy);
    if (fuzzyErr) return fuzzyErr;

    const prefixErr = validatePrefix(body.prefix);
    if (prefixErr) return prefixErr;

    const fieldBoostsErr = validateFieldBoosts(body.fieldBoosts);
    if (fieldBoostsErr) return fieldBoostsErr;

    try {
      const ids = await adapter.search({
        resource: body.resource as string,
        query: body.query as string,
        fields: Array.isArray(body.fields) ? body.fields : undefined,
        limit,
        fuzzy: body.fuzzy as boolean | number | undefined,
        prefix: body.prefix as boolean | undefined,
        fieldBoosts: body.fieldBoosts as Record<string, number> | undefined,
        signal: req.signal,
      });
      return okResponse({ ids });
    } catch (err) {
      return mapAdapterErrorToResponse(err, "Search operation failed");
    }
  };
}
