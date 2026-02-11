/**
 * Offline query executor
 */

import type { DatafnSchema } from "@datafn/core";
import type { DatafnStorageAdapter } from "../storage.js";
import { materializeSelect } from "./relations.js";
import { executeAggregateQuery } from "./aggregate.js";

/**
 * Execute a local query with index-aware routing (OFFQ-001)
 */
export async function executeLocalQuery(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
): Promise<{ data?: any[]; groups?: any[]; nextCursor?: any }> {
  // Check for aggregation
  if (query.groupBy) {
    return executeAggregateQuery(storage, schema, query);
  }

  const resource = query.resource as string;
  let records: Record<string, unknown>[];
  let usedIndexedPath = false;

  // Planning step: detect index-aware routing opportunities (OFFQ-001)
  if (query.filters) {
    const filters = query.filters as Record<string, unknown>;
    
    // Case 1: id eq → use getRecord
    if (filters.id && typeof filters.id === "object") {
      const idFilter = filters.id as Record<string, unknown>;
      if (idFilter.eq !== undefined) {
        const record = await storage.getRecord(resource, idFilter.eq as string);
        records = record ? [record] : [];
        usedIndexedPath = true;
      }
    }
    
    // Case 2: single-field indexed eq → use findRecords
    if (!usedIndexedPath) {
      const singleFieldEq = detectSingleFieldEq(filters);
      if (singleFieldEq) {
        const { field, value } = singleFieldEq;
        // findRecords will use index if available, else fall back to scan
        records = await storage.findRecords(resource, field, value);
        usedIndexedPath = true;
      }
    }
  }

  // Fallback: full scan with deterministic ordering
  if (!usedIndexedPath) {
    records = await storage.listRecords(resource);
  }

  // Apply filters (if not fully satisfied by routing)
  if (query.filters) {
    records = records.filter((r) =>
      evaluateFilter(r, query.filters as Record<string, unknown>),
    );
  }

  // Sort (with stable id:asc tie-breaker if no explicit orderBy and scan path was used)
  if (query.sort) {
    const sort = query.sort as string[];
    records.sort((a, b) => {
      for (const term of sort) {
        const [field, dir] = term.split(":");
        const va = a[field] as any;
        const vb = b[field] as any;
        if (va < vb) return dir === "desc" ? 1 : -1;
        if (va > vb) return dir === "desc" ? -1 : 1;
      }
      return 0;
    });
  } else if (!usedIndexedPath) {
    // Deterministic ordering: stable sort by id:asc when scan path is used
    records.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  // Pagination
  if (query.limit || query.offset) {
    const offset = (query.offset as number) || 0;
    const limit = (query.limit as number) || records.length;
    records = records.slice(offset, offset + limit);
  }

  // Select / Expansion
  if (query.select) {
    records = await materializeSelect(
      storage,
      schema,
      resource,
      records,
      query.select as string[],
    );
  }

  return {
    data: records,
    nextCursor: null,
  };
}

/**
 * Detect if filters contain a single-field eq that could use an index.
 * Returns null if not applicable, or { field, value } if applicable.
 */
function detectSingleFieldEq(
  filters: Record<string, unknown>,
): { field: string; value: unknown } | null {
  const keys = Object.keys(filters);
  
  // Only consider if exactly one field and it's not a logical operator
  if (keys.length !== 1) return null;
  const key = keys[0];
  if (key.startsWith("$")) return null;
  
  const val = filters[key];
  
  // Check for { field: { eq: value } } or { field: { $eq: value } }
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
    const ops = val as Record<string, unknown>;
    if (ops.eq !== undefined && Object.keys(ops).length === 1) {
      return { field: key, value: ops.eq };
    }
    if (ops.$eq !== undefined && Object.keys(ops).length === 1) {
      return { field: key, value: ops.$eq };
    }
  }
  
  return null;
}

/**
 * Evaluate filter recursively with full operator coverage (OFFQ-002).
 * Rejects unsupported operators with deterministic error.
 */
function evaluateFilter(
  record: Record<string, unknown>,
  filter: Record<string, unknown>,
  path: string = "filters",
): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const currentPath = `${path}.${key}`;
    
    // Logical operators
    if (key === "$and") {
      if (!Array.isArray(value)) {
        throw {
          code: "DFQL_INVALID",
          message: "Invalid DFQL: $and must be array",
          details: { path: currentPath },
        };
      }
      // Short-circuit: if any fails, return false immediately
      for (const subFilter of value) {
        if (!evaluateFilter(record, subFilter, currentPath)) {
          return false;
        }
      }
      continue;
    }
    
    if (key === "$or") {
      if (!Array.isArray(value)) {
        throw {
          code: "DFQL_INVALID",
          message: "Invalid DFQL: $or must be array",
          details: { path: currentPath },
        };
      }
      // Short-circuit: if any succeeds, return true immediately
      for (const subFilter of value) {
        if (evaluateFilter(record, subFilter, currentPath)) {
          return true;
        }
      }
      // If we get here, none matched
      return false;
    }

    // Field-level filters
    const recordVal = record[key];

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Operator object: { $op: operand }
      for (const [op, opVal] of Object.entries(value)) {
        if (op === "eq" || op === "$eq") {
          if (recordVal !== opVal) return false;
        } else if (op === "$ne") {
          if (recordVal === opVal) return false;
        } else if (op === "$gt") {
          if (!((recordVal as any) > (opVal as any))) return false;
        } else if (op === "$gte") {
          if (!((recordVal as any) >= (opVal as any))) return false;
        } else if (op === "$lt") {
          if (!((recordVal as any) < (opVal as any))) return false;
        } else if (op === "$lte") {
          if (!((recordVal as any) <= (opVal as any))) return false;
        } else if (op === "$in") {
          if (!Array.isArray(opVal)) {
            throw {
              code: "DFQL_INVALID",
              message: "Invalid DFQL: $in operand must be array",
              details: { path: `${currentPath}.$in` },
            };
          }
          if (!opVal.includes(recordVal)) return false;
        } else if (op === "$nin") {
          if (!Array.isArray(opVal)) {
            throw {
              code: "DFQL_INVALID",
              message: "Invalid DFQL: $nin operand must be array",
              details: { path: `${currentPath}.$nin` },
            };
          }
          if (opVal.includes(recordVal)) return false;
        } else if (op === "$contains") {
          if (!Array.isArray(recordVal)) {
            // If field is not an array, $contains cannot match
            return false;
          }
          if (!recordVal.includes(opVal)) return false;
        } else {
          // Unsupported operator
          throw {
            code: "DFQL_UNSUPPORTED",
            message: `Unsupported DFQL feature: ${currentPath}.${op}`,
            details: { path: currentPath },
          };
        }
      }
    } else {
      // Direct equality: { field: value }
      if (recordVal !== value) return false;
    }
  }
  return true;
}
