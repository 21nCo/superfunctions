import type { DatafnSchema } from "@datafn/core";
import type { DataStore } from "../store.js";
import type { DFQLQuery, QueryResult, AggregateResult } from "./dfql.js";
import { executeQuery } from "./execute.js";
import type { SearchFnPlugin } from "../../plugins/searchfn.js";
import { DatafnExecutionError } from "../errors.js";
import type { DatafnLogger } from "../../logger.js";

export async function executeSearchQuery(
  query: DFQLQuery,
  schema: DatafnSchema,
  store: DataStore,
  searchPlugin: SearchFnPlugin,
  logger?: DatafnLogger,
): Promise<QueryResult | AggregateResult> {
  if (!query.search) {
    throw new DatafnExecutionError(
      "INTERNAL",
      "executeSearchQuery called without search block",
    );
  }

  // 1. Get candidates
  const candidates = await searchPlugin.selectCandidates({
    resource: query.resource,
    query: query.search.query,
    type: query.search.type,
    fields: query.search.fields,
    topK: query.search.topK,
  });

  // 2. Merge filters
  // Implicit: (Original Filters) AND (id IN candidates)
  // Note: if candidates is empty, id IN [] should return 0 results.
  // EXE-017: Cap IN clause to prevent unbounded queries
  const MAX_SEARCH_CANDIDATES = 1000;
  const cappedCandidates =
    candidates.length > MAX_SEARCH_CANDIDATES
      ? (() => {
          logger?.warn("Search returned too many candidates, capping result set", {
            operation: "executeSearchQuery",
            resource: query.resource,
            candidateCount: candidates.length,
            maxCandidates: MAX_SEARCH_CANDIDATES,
          });
          return candidates.slice(0, MAX_SEARCH_CANDIDATES);
        })()
      : candidates;
  const candidateFilter = { id: { in: cappedCandidates } };

  let mergedFilters: Record<string, unknown> = candidateFilter;

  if (query.filters && Object.keys(query.filters).length > 0) {
    mergedFilters = {
      $and: [query.filters, candidateFilter],
    };
  }

  // 3. Execute
  const modifiedQuery: DFQLQuery = {
    ...query,
    filters: mergedFilters,
  };

  return executeQuery(modifiedQuery, schema, store);
}
