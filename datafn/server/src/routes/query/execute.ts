/**
 * FIX-SRV-005: Query execution bridge module
 * Extracted from routes/query.ts — single responsibility: strategy classification + data store + execution
 */

import type { DatafnSchema } from "../../core-types.js";
import type { Adapter, WhereClause } from "@superfunctions/db";
import type { SearchProvider } from "../../search-provider.js";
import type { DatafnLogger } from "../../logger.js";
import { executeQuery } from "../../execution/query/execute.js";
import { DbDataStore } from "../../execution/db-store.js";
import { classifyQuery, extractPushableFilters } from "../../execution/query/planner.js";
import {
  buildPrefilterWhere,
  filterReadsPrimaryThroughRelation,
  FilterPushdownUnavailableError,
  queryPathsReadPrimaryThroughRelation,
  selectReadsPrimaryThroughRelation,
} from "../../execution/query/filter-plan.js";
import { executePushdownQuery, executePartialPushdownQuery } from "../../execution/query/pushdown.js";
import { planTemporalQuery } from "../../execution/query/temporal-pushdown.js";
import { materializeSelect } from "../../execution/query/select.js";
import { parseSortTerms, sortRecords } from "../../execution/query/sort.js";
import { executeSearchQuery } from "../../execution/query/search.js";
import { DatafnExecutionError } from "../../execution/errors.js";
import { findRelationMatch } from "@datafn/core";
import {
  executeDbNativeResourceSearch,
  hasDbNativeSearchSupport,
  NO_PROVIDER_NATIVE_UNSUPPORTED_MESSAGE,
} from "../../execution/search/native-fallback.js";
import type { ExecutionTimer } from "../../middleware/timing.js";
import type { DatafnMultiRegionRuntimeConfig } from "../../plugins/multi-region.js";

function mergeAnchorFilter(
  filters: Record<string, unknown> | undefined,
  id: string,
): Record<string, unknown> {
  const idFilter = { id };
  if (!filters || Object.keys(filters).length === 0) {
    return idFilter;
  }
  if (Array.isArray(filters.$and) && Object.keys(filters).length === 1) {
    return { $and: [...filters.$and as Record<string, unknown>[], idFilter] };
  }
  return { $and: [filters, idFilter] };
}

export function relationQuerySelectTokens(relationName: string, select: unknown): string[] {
  const tokens = Array.isArray(select) && select.length > 0 ? select : ["*"];
  return tokens
    .filter((token): token is string => typeof token === "string")
    .map((token) => `${relationName}.${token}`);
}

function normalizeRelationQueryValue(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }
  if (typeof value === "object" && value !== null) {
    return [value as Record<string, unknown>];
  }
  return [];
}

function isMetadataOnlyRelationSelect(select: unknown): boolean {
  return Array.isArray(select) && select.length === 1 && select[0] === "#";
}

async function executeRelationQuery(
  query: Record<string, unknown>,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  actorId: string | undefined,
  searchProvider: SearchProvider | undefined,
  logger?: DatafnLogger,
  timer?: ExecutionTimer | null,
  multiRegionRuntime?: DatafnMultiRegionRuntimeConfig | null,
  allowUnknownResources = true,
): Promise<unknown> {
  const resource = query.resource as string;
  const relationName = query.relation as string;
  const id = query.id as string;
  const match = findRelationMatch(schema as any, resource, relationName);
  if (!match) {
    throw new DatafnExecutionError(
      "DFQL_UNKNOWN_RELATION",
      `Unknown relation: ${relationName}`,
      "relation",
    );
  }

  const {
    relation: _relation,
    id: _id,
    sort: _sort,
    limit: _limit,
    offset: _offset,
    cursor: _cursor,
    count: _count,
    groupBy: _groupBy,
    aggregations: _aggregations,
    having: _having,
    search: _search,
    temporal: _temporal,
    select: _select,
    omit: _omit,
    ...anchorQueryBase
  } = query;
  const existingFilters =
    query.filters &&
    typeof query.filters === "object" &&
    !Array.isArray(query.filters)
      ? (query.filters as Record<string, unknown>)
      : undefined;
  const anchorResult = await executeSingleQuery(
    {
      ...anchorQueryBase,
      resource,
      select: ["*"],
      filters: mergeAnchorFilter(existingFilters, id),
      limit: 1,
    },
    schema,
    db,
    namespace,
    actorId,
    searchProvider,
    logger,
    timer,
    multiRegionRuntime,
    // Keep the anchor's stored keys through hydration of the related records.
    { allowUnknownResources, projectRecords: false },
  );
  const anchorData =
    anchorResult &&
    typeof anchorResult === "object" &&
    Array.isArray((anchorResult as { data?: unknown }).data)
      ? ((anchorResult as { data: Record<string, unknown>[] }).data)
      : [];
  if (anchorData.length === 0) {
    return {
      data: [],
      nextCursor: null,
      ...(query.count === true ? { count: 0 } : {}),
    };
  }

  const store = await DbDataStore.forPushdownResult(
    db,
    anchorData.slice(0, 1),
    resource,
    { select: relationQuerySelectTokens(relationName, query.select) },
    schema,
    namespace,
    logger,
    actorId,
    allowUnknownResources,
  );
  const materialized = materializeSelect(
    anchorData[0],
    resource,
    relationQuerySelectTokens(relationName, query.select),
    schema,
    store,
    Array.isArray(query.omit) ? (query.omit as string[]) : undefined,
    query.metadata as Record<string, unknown> | undefined,
    { visibleJoinRowsOnly: isMetadataOnlyRelationSelect(query.select) },
  );
  let data = normalizeRelationQueryValue(materialized[relationName]);
  if (Array.isArray(query.sort)) {
    data = sortRecords(data, parseSortTerms(query.sort as import("@datafn/core").SortInputTerm[]));
  }

  const count = query.count === true ? data.length : undefined;
  const offset = typeof query.offset === "number" && query.offset > 0 ? query.offset : 0;
  const limit = typeof query.limit === "number" && query.limit >= 0 ? query.limit : undefined;
  const paged = typeof limit === "number" ? data.slice(offset, offset + limit) : data.slice(offset);

  return {
    data: paged,
    nextCursor: null,
    ...(count !== undefined ? { count } : {}),
  };
}

/**
 * Execute a single DFQL query using the optimal strategy.
 * Returns the query result (data + nextCursor + count).
 */
export async function executeSingleQuery(
  query: Record<string, unknown>,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  actorId: string | undefined,
  searchProvider: SearchProvider | undefined,
  logger?: DatafnLogger,
  timer?: ExecutionTimer | null,
  multiRegionRuntime?: DatafnMultiRegionRuntimeConfig | null,
  options: { timezoneNamespace?: string; allowUnknownResources?: boolean; projectRecords?: boolean } = {},
): Promise<unknown> {
  const { timezoneNamespace = namespace, allowUnknownResources = true, projectRecords = true } = options;
  if (typeof query.relation === "string" && typeof query.id === "string") {
    return executeRelationQuery(
      query,
      schema,
      db,
      namespace,
      actorId,
      searchProvider,
      logger,
      timer,
      multiRegionRuntime,
      allowUnknownResources,
    );
  }

  // Temporal period/range clauses become field bounds so the database
  // returns only the rows in range; see temporal-pushdown.ts.
  // Temporal queries keep the in-memory execution path they always used
  // (sorting, pagination and projection unchanged); only the rows it loads
  // are narrowed, through the pre-filter below.
  const temporalPlan = await planTemporalQuery(query, schema, db, timezoneNamespace, logger);
  query = temporalPlan.query;

  const strategy = temporalPlan.config ? "IN_MEMORY" : classifyQuery(query, schema);

  timer?.startPhase("fetch");

  if (strategy === "FULL_PUSHDOWN" || strategy === "PARTIAL_PUSHDOWN") {
    try {
      return strategy === "FULL_PUSHDOWN"
        ? await executePushdownQuery(query as any, schema, db, namespace, actorId, allowUnknownResources, projectRecords)
        : await executePartialPushdownQuery(query as any, schema, db, namespace, actorId, allowUnknownResources, projectRecords);
    } catch (error) {
      // A relation filter matched too many records to push down; evaluate
      // the query in memory below.
      if (!(error instanceof FilterPushdownUnavailableError)) throw error;
      logger?.debug("Query push-down unavailable; evaluating in memory", {
        resource: query.resource,
        operation: "query-pushdown-fallback",
      });
    }
  }

  // IN_MEMORY: load records via DbDataStore.
  // Extract base-field (pushable) filters to pre-filter the primary
  // resource at the adapter level before in-memory evaluation (SCALE-004).
  // Skip pre-filtering for HTREE queries — HTREE expansion needs all
  // ancestor/descendant records, not just the one matching the filter.
  // `parent.*` / `children.*` also cover self relations (e.g. a many-one
  // `parent`), whose related records are only found in the full table.
  const selectHasHtree = Array.isArray(query.select) &&
    (query.select as string[]).some(
      (t: string) => typeof t === "string" && (t.startsWith("parent.") || t.startsWith("children."))
    );
  // A relation filter that reads other records of the primary resource (a
  // self relation) needs them in the store as well.
  // A selected self relation (e.g. `childNodes.*`), or a groupBy, sort or
  // aggregation path through one (e.g. `manager.name`), does too.
  const filtersReadPrimary =
    (query.filters && typeof query.filters === "object"
      ? filterReadsPrimaryThroughRelation(query.filters, query.resource as string, schema)
      : false) ||
    selectReadsPrimaryThroughRelation(query.select, query.resource as string, schema) ||
    queryPathsReadPrimaryThroughRelation(query, query.resource as string, schema);
  let preFilterWhere: WhereClause[] | undefined;
  if (!selectHasHtree && !filtersReadPrimary && query.filters && typeof query.filters === "object") {
    const pushable = schema.resources.some((r) => r.name === query.resource)
      ? buildPrefilterWhere(
          query.filters as Record<string, unknown>,
          query.resource as string,
          schema,
        )
      : (extractPushableFilters(
          query.filters as Record<string, unknown>,
          query.resource as string,
          schema,
        ).pushable as WhereClause[]);
    if (pushable.length > 0) {
      preFilterWhere = pushable;
    }
  }

  const store = await DbDataStore.forQuery(
    db,
    query as { resource: string; select?: string[] },
    schema,
    namespace,
    preFilterWhere,
    logger,
    actorId,
    allowUnknownResources,
  );

  // Execute search query or regular query
  if (query.search) {
    const metadata = query.metadata && typeof query.metadata === "object" && !Array.isArray(query.metadata)
      ? query.metadata as Record<string, unknown>
      : {};
    const scopedQuery = {
      ...query,
      metadata: {
        ...metadata,
        searchNamespaceFilter: Array.isArray(metadata.namespaceFilter)
          ? metadata.namespaceFilter
          : [namespace],
        ...(multiRegionRuntime?.regionId ? { searchRegionFilter: [multiRegionRuntime.regionId] } : {}),
      },
    };
    if (searchProvider) {
      return executeSearchQuery(scopedQuery as any, schema, store, searchProvider, undefined, logger, temporalPlan.config, projectRecords);
    }
    if (!hasDbNativeSearchSupport(db)) {
      throw new DatafnExecutionError(
        "DFQL_UNSUPPORTED",
        NO_PROVIDER_NATIVE_UNSUPPORTED_MESSAGE,
        "search",
      );
    }
    return executeSearchQuery(
      scopedQuery as any,
      schema,
      store,
      undefined,
      async ({
        resource,
        query: searchQuery,
        fields,
        limit,
        prefix,
        fuzzy,
        fieldBoosts,
        signal,
      }) =>
        executeDbNativeResourceSearch(db, schema, namespace, {
          resource,
          query: searchQuery,
          fields,
          limit,
          prefix,
          fuzzy,
          fieldBoosts,
          signal,
        } as any),
      logger,
      temporalPlan.config,
      projectRecords,
    );
  }

  return executeQuery(query as any, schema, store, temporalPlan.config, projectRecords);
}

/**
 * Convert DFQL filters to @superfunctions/db WhereClause format
 */
export function convertFiltersToWhere(
  filters?: Record<string, unknown>,
): WhereClause[] {
  if (!filters || typeof filters !== "object") {
    return [];
  }

  const whereClauses: WhereClause[] = [];

  for (const [key, value] of Object.entries(filters)) {
    // Handle $and logical operator
    if (key === "$and" && Array.isArray(value)) {
      for (const subFilter of value) {
        if (typeof subFilter === "object" && subFilter !== null) {
          const subClauses = convertFiltersToWhere(
            subFilter as Record<string, unknown>,
          );
          whereClauses.push(...subClauses);
        }
      }
      continue;
    }

    // Skip $or for now (not supported by WhereClause)
    if (key === "$or") {
      continue;
    }

    // Simple equality: { id: "task:1" }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      whereClauses.push({
        field: key,
        operator: "eq",
        value: value,
      });
      continue;
    }

    // Array value = IN operator: { status: ["active", "pending"] }
    if (Array.isArray(value)) {
      whereClauses.push({
        field: key,
        operator: "in",
        value: value,
      });
      continue;
    }

    // Object value = operator object: { age: { $gt: 18 } }
    if (typeof value === "object" && value !== null) {
      const operators = value as Record<string, unknown>;
      for (const [op, opValue] of Object.entries(operators)) {
        let dbOperator: WhereClause["operator"] = "eq";

        switch (op) {
          case "eq":
          case "$eq":
            dbOperator = "eq";
            break;
          case "ne":
          case "$ne":
            dbOperator = "ne";
            break;
          case "gt":
          case "$gt":
            dbOperator = "gt";
            break;
          case "gte":
          case "$gte":
            dbOperator = "gte";
            break;
          case "lt":
          case "$lt":
            dbOperator = "lt";
            break;
          case "lte":
          case "$lte":
            dbOperator = "lte";
            break;
          case "in":
          case "$in":
            dbOperator = "in";
            break;
          case "like":
          case "$like":
            dbOperator = "contains";
            break;
          default:
            // Unknown operator, skip
            continue;
        }

        whereClauses.push({
          field: key,
          operator: dbOperator,
          value: opValue,
        });
      }
    }
  }

  return whereClauses;
}
