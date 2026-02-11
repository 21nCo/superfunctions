/**
 * Query candidate documents for reference picker (CFQL, type-scoped, deterministic order, bounded preview).
 */

import type { CfqlQuery, CfqlProjection, ContentfnEnvelope, CfqlResultPage } from "@contentfn/core";
import { queryContentfn } from "../contentfn/client.js";

export interface QueryCandidatesParams {
  baseUrl: string;
  dataset: string;
  /** Allowed document types (reference field's `to`). */
  types: string[];
  /** Bounded preview: limit returned fields (e.g. _id, _type, title). */
  projection?: CfqlProjection;
  limit?: number;
  cursor?: string | null;
}

const DEFAULT_ORDER = { field: "_id", direction: "asc" as const };
const DEFAULT_LIMIT = 30;

/**
 * Run a CFQL query for reference picker candidates: deterministic order (_id asc), optional projection.
 */
export async function queryCandidates(params: QueryCandidatesParams): Promise<ContentfnEnvelope<CfqlResultPage>> {
  const {
    baseUrl,
    dataset,
    types,
    projection,
    limit = DEFAULT_LIMIT,
    cursor = null,
  } = params;

  const query: CfqlQuery = {
    dataset,
    types: types.length ? types : undefined,
    orderBy: [DEFAULT_ORDER],
    limit,
    cursor: cursor ?? undefined,
    projection,
  };

  return queryContentfn({ baseUrl }, query);
}
