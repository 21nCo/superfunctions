/**
 * Full and partial push-down query execution (Phase 02/03)
 *
 * FULL_PUSHDOWN:    executes DFQL entirely via the adapter's `findMany`,
 *                  bypassing DbDataStore.  Covers SCALE-002/005/006/007.
 * PARTIAL_PUSHDOWN: pushes filters/sort/limit to adapter for the primary
 *                  resource, then loads related records on demand and
 *                  runs in-memory relation expansion via materializeSelect.
 *                  Covers SCALE-003.
 */

import type { DatafnSchema } from "@datafn/core";
import { SYSTEM_FIELDS } from "@datafn/core";
import type { Adapter, WhereClause } from "@superfunctions/db";
import type { DFQLQuery, QueryResult } from "./dfql.js";
import { convertDfqlFilters, convertDfqlSort } from "./planner.js";
import { parseSortTerms, validateSortForCursor } from "./sort.js";
import { computeNextCursor, applyCursorAfter } from "./pagination.js";
import { materializeSelect } from "./select.js";
import { DbDataStore } from "../db-store.js";
import { DatafnExecutionError } from "../errors.js";

/**
 * Execute a DFQL query classified as FULL_PUSHDOWN directly against the adapter.
 *
 * - Base filters, sort, limit, and offset are pushed to `db.findMany()`
 * - Cursor pagination is applied in-memory on the already-sorted result set
 * - Simple field projection (no relation expansion — FULL_PUSHDOWN only)
 * - Optional count via `db.count()` with the same where clauses
 */
export async function executePushdownQuery(
  query: DFQLQuery,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
): Promise<QueryResult> {
  const { records, nextCursor, count } = await pushdownCore(
    query,
    schema,
    db,
    namespace,
  );

  // Simple field projection (no relation expansion)
  const data = records.map((record) =>
    projectFieldsPushdown(
      record,
      query.resource,
      schema,
      query.select,
      query.omit,
    ),
  );

  return { data, count, nextCursor };
}

// ---------------------------------------------------------------------------
// Partial push-down (Phase 03)
// ---------------------------------------------------------------------------

/**
 * Execute a DFQL query classified as PARTIAL_PUSHDOWN.
 *
 * - Filters, sort, and pagination that apply only to the primary resource
 *   are pushed to `db.findMany()` (same as FULL_PUSHDOWN core)
 * - The resulting primary records are then used to create a targeted
 *   DbDataStore via `forPushdownResult()`, which loads only the related
 *   records referenced by the select list
 * - Relation expansion and final projection are handled by `materializeSelect`
 *
 * Covers SCALE-003: partial push-down for queries with relations.
 */
export async function executePartialPushdownQuery(
  query: DFQLQuery,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
): Promise<QueryResult> {
  // 1. Execute the push-down core (same as FULL_PUSHDOWN up to trimming)
  const { records, nextCursor, count } = await pushdownCore(
    query,
    schema,
    db,
    namespace,
  );

  // 2. Build a targeted DataStore from the already-fetched primary records.
  //    forPushdownResult() only loads related records that the select list
  //    actually needs, avoiding full table scans.
  const store = await DbDataStore.forPushdownResult(
    db,
    records,
    query.resource,
    { select: query.select },
    schema,
    namespace,
  );

  // 3. Materialize select (relation expansion + field projection)
  const data = records.map((record) =>
    materializeSelect(
      record,
      query.resource,
      query.select,
      schema,
      store,
      query.omit,
    ),
  );

  return { data, count, nextCursor };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Shared push-down core: converts filters, pushes sort/limit/cursor to the
 * adapter, applies in-memory cursor slicing, and optionally fetches count.
 *
 * Both FULL_PUSHDOWN and PARTIAL_PUSHDOWN use this logic for the primary
 * resource fetch; they differ only in how the result set is projected.
 */
async function pushdownCore(
  query: DFQLQuery,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
): Promise<{
  records: Record<string, unknown>[];
  nextCursor: Record<string, unknown> | null;
  count: number | undefined;
}> {
  // 1. Convert filters and sort -------------------------------------------
  const whereClauses: WhereClause[] = query.filters
    ? ((convertDfqlFilters(
        query.filters,
        query.resource,
        schema,
      ) ?? []) as WhereClause[])
    : [];

  const orderBy = convertDfqlSort(query.sort);
  const sortTerms = parseSortTerms(query.sort);

  // 2. Cursor validation ---------------------------------------------------
  const hasCursor =
    query.cursor?.after != null || query.cursor?.before != null;

  if (hasCursor && !validateSortForCursor(sortTerms)) {
    throw new DatafnExecutionError(
      "DFQL_INVALID",
      "Invalid DFQL: cursor requires sort with id tie-breaker",
      "cursor",
    );
  }

  // 3. Push limit/offset to adapter
  //    EXE-016: Also pass limit for cursor queries to avoid unbounded full-table fetches
  const pushdownLimit =
    query.limit != null
      ? query.limit + 1 // +1 to detect next page
      : undefined;
  // Offset only applies to non-cursor queries (cursor handles position)
  const pushdownOffset = !hasCursor ? query.offset : undefined;

  // 4. Fetch from adapter -------------------------------------------------
  const rows: Record<string, unknown>[] = await db.findMany({
    model: query.resource,
    where: whereClauses,
    orderBy,
    limit: pushdownLimit,
    offset: pushdownOffset,
    namespace,
  });

  // 5. Cursor pagination (in-memory on already-sorted adapter results) ----
  let records = rows;

  if (query.cursor?.after) {
    records = applyCursorAfter(records, query.cursor.after, sortTerms);
  } else if (query.cursor?.before) {
    const reversedRecords = [...records].reverse();
    const invertedSortTerms = sortTerms.map((t) => ({
      field: t.field,
      direction: (t.direction === "asc" ? "desc" : "asc") as "asc" | "desc",
    }));
    let workRecords = applyCursorAfter(
      reversedRecords,
      query.cursor.before,
      invertedSortTerms,
    );
    if (query.limit) {
      workRecords = workRecords.slice(0, query.limit);
    }
    records = workRecords.reverse();
  }

  // 6. Compute nextCursor and trim to limit --------------------------------
  const effectiveLimit = query.limit;
  let nextCursor: Record<string, unknown> | null = null;

  if (hasCursor) {
    if (query.cursor?.after) {
      const sliceForCheck = effectiveLimit
        ? records.slice(0, effectiveLimit + 1)
        : records;
      nextCursor = computeNextCursor(sliceForCheck, sortTerms, effectiveLimit);
      if (effectiveLimit && records.length > effectiveLimit) {
        records = records.slice(0, effectiveLimit);
      }
    } else if (query.cursor?.before && records.length > 0) {
      const lastItem = records[records.length - 1];
      const cursorObj: Record<string, unknown> = {};
      for (const term of sortTerms) {
        cursorObj[term.field] = lastItem[term.field];
      }
      nextCursor = cursorObj;
    }
  } else {
    nextCursor = computeNextCursor(records, sortTerms, effectiveLimit);
    if (effectiveLimit && records.length > effectiveLimit) {
      records = records.slice(0, effectiveLimit);
    }
  }

  // 7. Optional count -------------------------------------------------------
  let count: number | undefined;
  if (query.count === true) {
    count = await db.count({
      model: query.resource,
      where: whereClauses,
      namespace,
    });
  }

  return { records, nextCursor, count };
}

/**
 * Simple field projection for the FULL_PUSHDOWN path.
 * Returns only base schema fields — no relation expansion.
 */
function projectFieldsPushdown(
  record: Record<string, unknown>,
  resource: string,
  schema: DatafnSchema,
  select: string[] | undefined,
  omit: string[] | undefined,
): Record<string, unknown> {
  const resourceSchema = schema.resources.find((r) => r.name === resource);
  if (!resourceSchema) return { id: record.id };

  // LOW-018: Use shared SYSTEM_FIELDS constant from core instead of hardcoding
  const baseFields = new Set<string>(SYSTEM_FIELDS);
  for (const f of resourceSchema.fields) baseFields.add(f.name);

  let result: Record<string, unknown>;

  if (!select || select.length === 0) {
    // No select: return id + all schema-defined fields present in record
    result = { id: record.id };
    for (const f of resourceSchema.fields) {
      if (record[f.name] !== undefined) {
        result[f.name] = record[f.name];
      }
    }
  } else if (select.includes("*")) {
    // Bare wildcard: all base fields + any additional explicit tokens
    result = { id: record.id };
    for (const f of resourceSchema.fields) {
      if (record[f.name] !== undefined) {
        result[f.name] = record[f.name];
      }
    }
    for (const token of select) {
      if (token !== "*" && baseFields.has(token) && !(token in result)) {
        result[token] = record[token];
      }
    }
  } else {
    // Explicit field list: pick only requested base fields
    result = {};
    for (const token of select) {
      if (baseFields.has(token)) {
        result[token] = record[token];
      }
    }
  }

  // Apply omit (id is never omitted)
  if (omit && omit.length > 0) {
    for (const field of omit) {
      if (field !== "id") {
        delete result[field];
      }
    }
  }

  return result;
}
