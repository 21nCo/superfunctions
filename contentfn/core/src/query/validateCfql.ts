/**
 * Deterministic CFQL validation: operator allowlist, filter depth limit,
 * orderBy validation, projection field names.
 */

import type { CfqlQuery, CfqlFilter, CfqlOrderBy, CfqlProjection } from "./types.js";
import { CFQL_OPERATORS } from "./types.js";
import type { ContentfnEnvelope } from "../errors.js";
import { err } from "../errors.js";
import { DEFAULT_MAX_FILTER_DEPTH } from "../limits.js";

export interface ValidateCfqlOptions {
  maxFilterDepth?: number;
  maxExpandDepth?: number;
}

function validateFilter(
  filter: unknown,
  depth: number,
  maxDepth: number,
  path: string
): ContentfnEnvelope<void> {
  if (depth > maxDepth) {
    return err("QUERY_TOO_COMPLEX", "Filter depth exceeds limit", { path });
  }
  if (filter === null || typeof filter !== "object") {
    return err("QUERY_INVALID", "Filter must be an object", { path });
  }
  const f = filter as Record<string, unknown>;
  if ("op" in f && (f.op === "and" || f.op === "or")) {
    if (!Array.isArray(f.filters)) {
      return err("QUERY_INVALID", "and/or filters must be an array", {
        path: `${path}.filters`,
      });
    }
    for (let i = 0; i < f.filters.length; i++) {
      const res = validateFilter(
        f.filters[i],
        depth + 1,
        maxDepth,
        `${path}.filters[${i}]`
      );
      if (!res.ok) return res;
    }
    return { ok: true, result: undefined };
  }
  if ("field" in f && "op" in f) {
    if (typeof f.field !== "string" || !f.field) {
      return err("QUERY_INVALID", "Filter field must be non-empty string", {
        path: `${path}.field`,
      });
    }
    if (typeof f.op !== "string" || !CFQL_OPERATORS.has(f.op as import("./types.js").CfqlOperator)) {
      return err("QUERY_INVALID", "Invalid filter operator", {
        path: `${path}.op`,
      });
    }
    return { ok: true, result: undefined };
  }
  return err("QUERY_INVALID", "Filter must be and/or or field/op", { path });
}

function validateOrderBy(orderBy: unknown, path: string): ContentfnEnvelope<void> {
  if (!Array.isArray(orderBy)) {
    return err("QUERY_INVALID", "orderBy must be an array", { path });
  }
  for (let i = 0; i < orderBy.length; i++) {
    const o = orderBy[i];
    const itemPath = `${path}[${i}]`;
    if (o === null || typeof o !== "object") {
      return err("QUERY_INVALID", "orderBy item must be object", { path: itemPath });
    }
    const ob = o as CfqlOrderBy;
    if (typeof ob.field !== "string" || !ob.field) {
      return err("QUERY_INVALID", "orderBy field must be non-empty string", {
        path: `${itemPath}.field`,
      });
    }
    if (ob.direction !== "asc" && ob.direction !== "desc") {
      return err("QUERY_INVALID", "orderBy direction must be asc or desc", {
        path: `${itemPath}.direction`,
      });
    }
  }
  return { ok: true, result: undefined };
}

function validateProjection(proj: unknown, path: string, depth = 0, maxDepth = 8): ContentfnEnvelope<void> {
  if (depth > maxDepth) return err("QUERY_TOO_COMPLEX", "Projection depth exceeds limit", { path });
  if (proj === null || typeof proj !== "object") {
    return err("QUERY_INVALID", "projection must be an object", { path });
  }
  const p = proj as CfqlProjection;
  if (p.fields !== undefined) {
    if (!Array.isArray(p.fields)) {
      return err("QUERY_INVALID", "projection.fields must be an array", {
        path: `${path}.fields`,
      });
    }
    for (let i = 0; i < p.fields.length; i++) {
      if (typeof p.fields[i] !== "string" || !p.fields[i]) {
        return err("QUERY_INVALID", "projection field name must be non-empty string", {
          path: `${path}.fields[${i}]`,
        });
      }
    }
  }
  if (p.expand !== undefined) {
    if (typeof p.expand !== "object" || p.expand === null) {
      return err("QUERY_INVALID", "projection.expand must be an object", {
        path: `${path}.expand`,
      });
    }
    for (const [key, val] of Object.entries(p.expand)) {
      if (val === null || typeof val !== "object") {
        return err("QUERY_INVALID", "expand entry must be object with field", {
          path: `${path}.expand.${key}`,
        });
      }
      if (typeof (val as { field?: unknown }).field !== "string") {
        return err("QUERY_INVALID", "expand entry must have field string", {
          path: `${path}.expand.${key}.field`,
        });
      }
      const v = val as { projection?: CfqlProjection };
      if (v.projection !== undefined) {
        const res = validateProjection(v.projection, `${path}.expand.${key}.projection`, depth + 1, maxDepth);
        if (!res.ok) return res;
      }
    }
  }
  return { ok: true, result: undefined };
}

/**
 * Validates a CFQL query. Uses maxFilterDepth from options or DEFAULT_MAX_FILTER_DEPTH.
 */
export function validateCfql(
  query: unknown,
  options: ValidateCfqlOptions = {}
): ContentfnEnvelope<CfqlQuery> {
  if (query === null || typeof query !== "object") {
    return err("QUERY_INVALID", "Query must be an object", { path: "" });
  }
  const q = query as Record<string, unknown>;
  if (typeof q.dataset !== "string" || !q.dataset) {
    return err("QUERY_INVALID", "dataset must be non-empty string", { path: "dataset" });
  }
  if (q.types !== undefined) {
    if (!Array.isArray(q.types)) {
      return err("QUERY_INVALID", "types must be an array", { path: "types" });
    }
    for (let i = 0; i < q.types.length; i++) {
      if (typeof q.types[i] !== "string" || !q.types[i]) {
        return err("QUERY_INVALID", "types item must be non-empty string", {
          path: `types[${i}]`,
        });
      }
    }
  }
  const maxDepth = options.maxFilterDepth ?? DEFAULT_MAX_FILTER_DEPTH;
  if (q.filter !== undefined) {
    const res = validateFilter(q.filter, 0, maxDepth, "filter");
    if (!res.ok) return res;
  }
  if (q.orderBy !== undefined) {
    const res = validateOrderBy(q.orderBy, "orderBy");
    if (!res.ok) return res;
  }
  if (q.projection !== undefined) {
    const res = validateProjection(q.projection, "projection", 0, options.maxExpandDepth);
    if (!res.ok) return res;
  }
  if (q.limit !== undefined && (typeof q.limit !== "number" || !Number.isSafeInteger(q.limit) || q.limit < 1)) {
    return err("QUERY_INVALID", "limit must be positive number", { path: "limit" });
  }
  if (q.cursor !== undefined && q.cursor !== null && typeof q.cursor !== "string") {
    return err("QUERY_INVALID", "cursor must be string or null", { path: "cursor" });
  }
  return { ok: true, result: query as CfqlQuery };
}
