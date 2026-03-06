import type { DatafnSchema } from "@datafn/core";
import type { DataStore } from "../store.js";
import type { DFQLQuery, QueryResult, AggregateResult } from "./dfql.js";
import { executeQuery } from "./execute.js";
import type { SearchFnPlugin } from "../../plugins/searchfn.js";
import { DatafnExecutionError } from "../errors.js";
import type { DatafnLogger } from "../../logger.js";

const DEFAULT_SEARCH_CHUNK_SIZE = 1000;

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

  // 2. EXE-017: Process candidates in deterministic chunks instead of truncating
  if (candidates.length <= DEFAULT_SEARCH_CHUNK_SIZE) {
    // Fast path: single chunk
    const candidateFilter = { id: { in: candidates } };
    let mergedFilters: Record<string, unknown> = candidateFilter;
    if (query.filters && Object.keys(query.filters).length > 0) {
      mergedFilters = { $and: [query.filters, candidateFilter] };
    }
    return executeQuery({ ...query, filters: mergedFilters }, schema, store);
  }

  // Multi-chunk path: process all candidates in pages
  const allData: Record<string, unknown>[] = [];
  for (let i = 0; i < candidates.length; i += DEFAULT_SEARCH_CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + DEFAULT_SEARCH_CHUNK_SIZE);
    const candidateFilter = { id: { in: chunk } };
    let mergedFilters: Record<string, unknown> = candidateFilter;
    if (query.filters && Object.keys(query.filters).length > 0) {
      mergedFilters = { $and: [query.filters, candidateFilter] };
    }

    // Execute without limit/offset/sort per chunk — we merge and re-apply after
    const chunkQuery: DFQLQuery = {
      ...query,
      filters: mergedFilters,
      limit: undefined,
      offset: undefined,
      sort: undefined,
      cursor: undefined,
    };
    const chunkResult = executeQuery(chunkQuery, schema, store) as QueryResult;
    if (chunkResult.data) {
      allData.push(...chunkResult.data);
    }
  }

  // 3. Re-execute with full merged data set using a final pass for sort/limit/offset
  // Build an id-in filter for all matched records, then run the original query
  const matchedIds = allData.map((r) => r.id).filter(Boolean);
  const finalFilter = { id: { in: matchedIds } };
  let finalMergedFilters: Record<string, unknown> = finalFilter;
  if (query.filters && Object.keys(query.filters).length > 0) {
    finalMergedFilters = { $and: [query.filters, finalFilter] };
  }

  return executeQuery({ ...query, filters: finalMergedFilters }, schema, store);
}
