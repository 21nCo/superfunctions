/**
 * DFQL-to-Adapter conversion utilities (Phase 00)
 *
 * Converts DFQL filter expressions and sort terms to the @superfunctions/db
 * adapter's WhereClause[], OrderBy[], and limit/offset format.
 *
 * This module is intentionally a pure-function utility with no side effects.
 * QueryPlanner classification (FULL_PUSHDOWN / PARTIAL_PUSHDOWN / IN_MEMORY)
 * is added in Phase 01.
 */

import type { WhereClause, OrderBy } from "@superfunctions/db";
import { endpointIncludes, endpointList, findRelationMatch, relationTargetEndpoint } from "@datafn/core";
import { parseSortTerms } from "./sort.js";
import type { SortInputTerm } from "@datafn/core";
import type { DatafnSchema } from "../../core-types.js";
import { canPushDownFilters, isRelationFilterEntry } from "./filter-plan.js";

// ---------------------------------------------------------------------------
// Extended types
// ---------------------------------------------------------------------------

/**
 * Extended operator type that includes DFQL operators not present in the
 * base WhereClause union (like, ilike). These are forwarded as-is to
 * adapters that support them.
 */
export type PushdownOperator =
  | WhereClause["operator"]
  | "like"
  | "ilike";

/**
 * A WhereClause-compatible object that allows the additional operators
 * supported by DFQL push-down (like, ilike).
 */
export interface PushdownWhereClause {
  field: string;
  operator: PushdownOperator;
  value: unknown;
  connector?: "AND" | "OR";
}

// ---------------------------------------------------------------------------
// Internal operator mapping
// ---------------------------------------------------------------------------

/**
 * Largest `$in` list pushed to the adapter as one bound-parameter list. A
 * longer list stays an in-memory filter so the SQL statement cannot exceed
 * Postgres' 65,535 parameters per statement; the shareable access filter can
 * appear twice in one statement, leaving room for the query's own filters.
 */
export const MAX_PUSHDOWN_IN_VALUES = 30_000;

function isOversizedInList(adapterOp: PushdownOperator, value: unknown): boolean {
  return adapterOp === "in" && Array.isArray(value) && value.length > MAX_PUSHDOWN_IN_VALUES;
}

/**
 * Total `$in` values across a DFQL filter tree. Several lists in one query
 * share one statement's parameter budget, so the planner keeps a query whose
 * lists add up to more than MAX_PUSHDOWN_IN_VALUES in memory.
 */
function countInValues(filters: unknown): number {
  if (Array.isArray(filters)) {
    return filters.reduce((sum: number, item) => sum + countInValues(item), 0);
  }
  if (typeof filters !== "object" || filters === null) return 0;
  let total = 0;
  for (const [key, value] of Object.entries(filters as Record<string, unknown>)) {
    if ((key === "$in" || key === "in") && Array.isArray(value)) {
      total += value.length;
    } else if (Array.isArray(value) && !key.startsWith("$") && value.every((v) => typeof v !== "object" || v === null)) {
      // Field shorthand value list ({ status: ["a", "b"] }), pushed as `in`
      total += value.length;
    } else if (typeof value === "object" && value !== null) {
      total += countInValues(value);
    }
  }
  return total;
}

/** Maps DFQL operator strings (with and without $ prefix) to adapter operators. */
const DFQL_TO_ADAPTER_OP: Record<string, PushdownOperator | null> = {
  // $-prefixed DFQL operators
  $eq: "eq",
  $ne: "ne",
  $gt: "gt",
  $gte: "gte",
  $lt: "lt",
  $lte: "lte",
  $in: "in",
  $like: "like",
  $ilike: "ilike",
  $is_null: "eq",
  $is_not_null: "ne",
  // Non-$-prefixed equivalents
  eq: "eq",
  ne: "ne",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  in: "in",
  like: "like",
  ilike: "ilike",
  is_null: "eq",
  is_not_null: "ne",
  // Explicitly unpushable — relation quantifiers
  $any: null,
  $all: null,
  $none: null,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert DFQL filter expressions to PushdownWhereClause[].
 *
 * Returns `null` if any part of the filter cannot be pushed down to the
 * adapter. Callers MUST fall back to in-memory execution when null is returned.
 *
 * Non-pushable conditions:
 * - `$or` operator (no OR connector in WhereClause)
 * - Relation quantifiers (`$any` / `$all` / `$none`)
 * - Dot-path filter keys (e.g. `goal.label`)
 * - Unknown or otherwise un-mappable operators
 *
 * @param filters  DFQL filter object (e.g. `{ status: "active", priority: { $gte: 3 } }`)
 * @param resource Resource name (used for schema-based relation detection)
 * @param schema   DatafnSchema (optional; enables relation key detection)
 * @returns        Flat list of PushdownWhereClause, or null if not fully pushable
 */
export function convertDfqlFilters(
  filters: Record<string, unknown>,
  resource?: string,
  schema?: unknown,
): PushdownWhereClause[] | null {
  const result: PushdownWhereClause[] = [];

  for (const [key, value] of Object.entries(filters)) {
    // $or is not pushable — no OR connector in WhereClause
    if (key === "$or") return null;

    // $and: flatten all sub-filters into the result (AND is implied by multiple clauses)
    if (key === "$and") {
      if (!Array.isArray(value)) return null;
      for (const subFilter of value) {
        if (typeof subFilter !== "object" || subFilter === null) return null;
        const subResult = convertDfqlFilters(
          subFilter as Record<string, unknown>,
          resource,
          schema,
        );
        if (subResult === null) return null;
        result.push(...subResult);
      }
      continue;
    }

    // Dot-path filter keys (e.g. "goal.label") cannot be pushed down
    if (key.includes(".")) return null;

    // Relation quantifiers in the value object ($any/$all/$none)
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const ops = value as Record<string, unknown>;
      if ("$any" in ops || "$all" in ops || "$none" in ops) return null;
    }

    // Schema-based relation key detection
    if (schema != null && isRelationKey(key, value, resource, schema)) {
      return null;
    }

    // Shorthand: { status: ["a", "b"] } → in (as the in-memory evaluator
    // reads it); { status: "active" } → eq
    if (Array.isArray(value)) {
      if (isOversizedInList("in", value)) return null;
      result.push({ field: key, operator: "in", value });
      continue;
    }
    if (typeof value !== "object" || value === null) {
      result.push({ field: key, operator: "eq", value });
      continue;
    }

    // Operator object: { $gte: 3 }, { $ne: "done" }, etc.
    const ops = value as Record<string, unknown>;
    for (const [op, opVal] of Object.entries(ops)) {
      if (!(op in DFQL_TO_ADAPTER_OP)) {
        // Unknown operator — cannot push down
        return null;
      }
      const adapterOp = DFQL_TO_ADAPTER_OP[op];
      if (adapterOp === null) {
        // Explicitly unpushable
        return null;
      }
      if (isOversizedInList(adapterOp, opVal)) {
        return null;
      }
      if (
        op === "$is_null" ||
        op === "is_null"
      ) {
        result.push({
          field: key,
          operator: opVal === false ? "ne" : "eq",
          value: null,
        });
        continue;
      }
      if (
        op === "$is_not_null" ||
        op === "is_not_null"
      ) {
        result.push({
          field: key,
          operator: opVal === false ? "eq" : "ne",
          value: null,
        });
        continue;
      }
      result.push({ field: key, operator: adapterOp, value: opVal });
    }
  }

  return result;
}

/**
 * Relation levels whose records a select path needs loaded (`depth`): its
 * leading segments that name relations, minus a terminal ids-only segment
 * whose id is a foreign key on the previous level's records (e.g. `d` in
 * `b.c.d` with a many-one `d`). `reachesPrimary`: a route that follows the
 * whole path passes through the primary resource (polymorphic routes that
 * cannot continue don't count).
 */
function relationPath(
  parts: string[],
  resource: unknown,
  schema: unknown,
): { depth: number; reachesPrimary: boolean } {
  if (!schema || typeof schema !== "object" || typeof resource !== "string") {
    return { depth: 0, reachesPrimary: false };
  }
  // Resources the path can be at, each with whether its own route there
  // passed through the primary resource (routes that stop are dropped).
  let current = new Map<string, boolean>([[resource, false]]);
  let depth = 0;
  let lastFkOnSource = false;
  // Whether a route that took the last step had passed through the primary
  // before it (the last target itself not counted).
  let lastSourceViaPrimary = false;
  for (const segment of parts) {
    const next = new Map<string, boolean>();
    let fkOnSource = true;
    let sourceViaPrimary = false;
    for (const [name, viaPrimary] of current) {
      const match = findRelationMatch(schema as any, name, segment);
      if (!match) continue;
      if (viaPrimary) sourceViaPrimary = true;
      const type = (match.relation as any).type;
      if (!((type === "many-one" && match.direction === "forward") || (type === "one-many" && match.direction === "inverse"))) {
        fkOnSource = false;
      }
      for (const target of endpointList(relationTargetEndpoint(match.relation, match.direction))) {
        next.set(target, (next.get(target) ?? false) || viaPrimary || target === resource);
      }
    }
    if (next.size === 0) break;
    depth += 1;
    lastFkOnSource = fkOnSource;
    lastSourceViaPrimary = sourceViaPrimary;
    current = next;
  }
  // A terminal ids-only segment read from the previous level's foreign key
  // loads nothing, so its target does not count.
  const terminalFkOnly = depth === parts.length && lastFkOnSource;
  const reachesPrimary = terminalFkOnly ? lastSourceViaPrimary : [...current.values()].some(Boolean);
  return { depth: terminalFkOnly ? depth - 1 : depth, reachesPrimary };
}

/**
 * Partial filter extraction for IN_MEMORY queries (SCALE-004).
 *
 * Separates base-field filters that CAN be pushed to the adapter from
 * relation/complex filters that MUST remain in-memory. This enables
 * pre-filtering at the DB level even for IN_MEMORY-classified queries,
 * reducing the in-memory working set.
 *
 * @param filters  DFQL filter object
 * @param resource Resource name
 * @param schema   DatafnSchema (for relation key detection)
 * @returns        `{ pushable, remaining }` — remaining is null if everything was pushable
 */
export function extractPushableFilters(
  filters: Record<string, unknown>,
  resource?: string,
  schema?: unknown,
): { pushable: PushdownWhereClause[]; remaining: Record<string, unknown> | null } {
  const pushable: PushdownWhereClause[] = [];
  const remaining: Record<string, unknown> = {};
  let hasRemaining = false;

  for (const [key, value] of Object.entries(filters)) {
    // $and: try to split sub-filters
    if (key === "$and") {
      if (!Array.isArray(value)) {
        remaining[key] = value;
        hasRemaining = true;
        continue;
      }
      const andPushable: PushdownWhereClause[] = [];
      const andRemaining: Record<string, unknown>[] = [];
      for (const subFilter of value) {
        if (typeof subFilter !== "object" || subFilter === null) {
          andRemaining.push(subFilter as Record<string, unknown>);
          continue;
        }
        const sub = subFilter as Record<string, unknown>;
        const subResult = convertDfqlFilters(sub, resource, schema);
        if (subResult !== null) {
          andPushable.push(...subResult);
        } else {
          andRemaining.push(sub);
        }
      }
      pushable.push(...andPushable);
      if (andRemaining.length > 0) {
        remaining["$and"] = andRemaining;
        hasRemaining = true;
      }
      continue;
    }

    // $or is always remaining
    if (key === "$or") {
      remaining[key] = value;
      hasRemaining = true;
      continue;
    }

    // Dot-path filters are always remaining
    if (key.includes(".")) {
      remaining[key] = value;
      hasRemaining = true;
      continue;
    }

    // Relation quantifiers ($any/$all/$none) are always remaining
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const ops = value as Record<string, unknown>;
      if ("$any" in ops || "$all" in ops || "$none" in ops) {
        remaining[key] = value;
        hasRemaining = true;
        continue;
      }
    }

    // Schema-based relation key detection
    if (schema != null && isRelationKey(key, value, resource, schema)) {
      remaining[key] = value;
      hasRemaining = true;
      continue;
    }

    // Attempt single-filter push
    const singleResult = convertSingleFilter(key, value);
    if (singleResult !== null) {
      pushable.push(...singleResult);
    } else {
      remaining[key] = value;
      hasRemaining = true;
    }
  }

  // Keep the pushed $in lists within one statement's parameter budget; a list
  // past it is evaluated in memory instead (the AND of clauses is unchanged).
  let inBudget = MAX_PUSHDOWN_IN_VALUES;
  const withinBudget: PushdownWhereClause[] = [];
  const overBudget: Record<string, unknown>[] = [];
  for (const clause of pushable) {
    if (clause.operator === "in" && Array.isArray(clause.value)) {
      if (clause.value.length > inBudget) {
        overBudget.push({ [clause.field]: { $in: clause.value } });
        continue;
      }
      inBudget -= clause.value.length;
    }
    withinBudget.push(clause);
  }
  if (overBudget.length > 0) {
    const existing = Array.isArray(remaining.$and) ? (remaining.$and as Record<string, unknown>[]) : [];
    remaining.$and = [...existing, ...overBudget];
    hasRemaining = true;
  }

  return {
    pushable: withinBudget,
    remaining: hasRemaining ? remaining : null,
  };
}

/**
 * Convert DFQL sort terms to OrderBy[] format compatible with the adapter's
 * `findMany.orderBy` parameter.
 *
 * Delegates to the server's `parseSortTerms` (which adds the `id:asc` default
 * when sort is undefined or empty). `SortTerm` is structurally identical to
 * `OrderBy`, so the cast is safe.
 *
 * @param sort  Optional DFQL sort array (e.g. `["name:asc", "-priority", "id"]`)
 * @returns     OrderBy[] — never empty (defaults to `[{ field: "id", direction: "asc" }]`)
 */
export function convertDfqlSort(sort?: SortInputTerm[]): OrderBy[] {
  // parseSortTerms from sort.ts already applies the id:asc default.
  // SortTerm = { field: string; direction: "asc" | "desc" } is structurally
  // identical to OrderBy, so the cast is safe.
  return parseSortTerms(sort) as OrderBy[];
}

// ---------------------------------------------------------------------------
// QueryPlanner classification (Phase 01)
// ---------------------------------------------------------------------------

/**
 * The three execution strategies a DFQL query can be classified into.
 *
 * - FULL_PUSHDOWN  : No relation selects, no relation filters, no groupBy, no search,
 *                   no HTREE tokens. Entire query (filters, sort, limit, offset) is
 *                   delegated to the adapter's findMany. DbDataStore is NOT used.
 * - PARTIAL_PUSHDOWN: Has relation select tokens (e.g. `tags.*`) but no relation-based
 *                   filters. Base resource records are fetched via push-down; related
 *                   resources are loaded on-demand for materialization.
 * - IN_MEMORY       : Has relation-based filters (`$any`/`$all`/`$none`), groupBy,
 *                   search, having, or HTREE tokens. Falls back to DbDataStore
 *                   pre-loading with optional base-field pre-filtering (SCALE-004).
 */
export type QueryStrategy = "FULL_PUSHDOWN" | "PARTIAL_PUSHDOWN" | "IN_MEMORY";

/**
 * Classify a DFQL query into an execution strategy.
 *
 * Rules (evaluated in order — first match wins):
 *   1. `search` present                          → IN_MEMORY
 *   2. `groupBy` or `having` present             → IN_MEMORY
 *   3. Filters contain `$any`/`$all`/`$none`
 *      or dot-path keys (e.g. "goal.label")      → IN_MEMORY
 *   4. Select contains HTREE token
 *      (`parent.*`, `children.*`, `children.**`) → IN_MEMORY
 *   5. Select contains a token with `.` notation
 *      (e.g. `tags.*`, `category.*`,
 *       `tasks.tags.*`)                          → PARTIAL_PUSHDOWN
 *   6. Select contains a bare relation name
 *      (ids-only, e.g. `tags` when schema knows
 *       `tags` is a relation)                    → PARTIAL_PUSHDOWN
 *   7. Otherwise                                 → FULL_PUSHDOWN
 *
 * The function is a pure classifier — it never executes queries.
 *
 * @param query  DFQL query object (or a partial shape for classification)
 * @param schema DatafnSchema (optional; enables bare-relation-name detection)
 * @returns      QueryStrategy
 */
export function classifyQuery(
  query: Record<string, unknown>,
  schema?: unknown,
): QueryStrategy {
  if (Object.prototype.hasOwnProperty.call(query, "temporal")) return "IN_MEMORY";
  // --- Rule 1: search ---
  if (query.search) return "IN_MEMORY";

  // --- Rule 2: groupBy / having ---
  if (query.groupBy || query.having) return "IN_MEMORY";

  // --- Rule 3: IN_MEMORY filter patterns ---
  if (query.filters != null && typeof query.filters === "object") {
    const resourceName = typeof query.resource === "string" ? query.resource : undefined;
    // $in lists that together exceed one statement's parameter budget
    if (countInValues(query.filters) > MAX_PUSHDOWN_IN_VALUES) {
      return "IN_MEMORY";
    }
    // A filter neither the plain converter nor the filter planner can
    // express (e.g. a bare relation key) must be evaluated in memory, never
    // dropped.
    const plain =
      !hasInMemoryFilterPatterns(query.filters as Record<string, unknown>) &&
      convertDfqlFilters(query.filters as Record<string, unknown>, resourceName, schema) !== null;
    if (!plain && !canPushDownFilters(query.filters, resourceName, schema as DatafnSchema | undefined)) {
      return "IN_MEMORY";
    }
  }

  // --- Rules 4-6: select token analysis ---
  if (Array.isArray(query.select)) {
    const relationNames = buildRelationNames(
      query.resource as string | undefined,
      schema,
    );

    let partial = false;
    for (const token of query.select as unknown[]) {
      if (typeof token !== "string") continue;

      // Bare wildcard selects all base fields — not a relation token
      if (token === "*") continue;

      const parts = token.split(".");
      const baseName = parts[0];

      // Rule 4: HTREE tokens → IN_MEMORY
      if (isHtreeSelectBase(baseName, query.resource, schema)) return "IN_MEMORY";

      // A path beyond two relation levels that leads back to the primary
      // resource (e.g. `parent.parent.childNodes.*`,
      // `parent.objective.nodes.*`) is expanded in memory, where the whole
      // primary resource is loaded.
      const path = relationPath(parts, query.resource, schema);
      if (path.depth > 2 && path.reachesPrimary) return "IN_MEMORY";

      // Rule 5: dot-notation token (rel.*, rel.#, tasks.tags.*, …) → PARTIAL_PUSHDOWN
      // In validated DFQL, any token with a dot whose base is not a system keyword
      // is a relation expansion token.
      if (parts.length > 1) partial = true;

      // Rule 6: bare relation name (ids-only, e.g. `tags`) → PARTIAL_PUSHDOWN
      if (relationNames.has(baseName)) partial = true;
    }
    if (partial) return "PARTIAL_PUSHDOWN";
  }

  // --- Default ---
  return "FULL_PUSHDOWN";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the filter object contains patterns that require in-memory
 * execution: relation quantifiers ($any/$all/$none) or dot-path keys.
 * Recursively checks $and/$or sub-arrays.
 */
export function hasInMemoryFilterPatterns(
  filters: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (key === "$or") return true;

    // Dot-path key (e.g. "goal.label") — requires relation traversal
    if (key.includes(".")) return true;

    // Operator object: check for non-pushable operators
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const ops = value as Record<string, unknown>;
      // Relation quantifiers ($any/$all/$none) → always IN_MEMORY
      if ("$any" in ops || "$all" in ops || "$none" in ops) return true;
      // Any operator not in DFQL_TO_ADAPTER_OP (or mapped to null) → IN_MEMORY
      // e.g. between, not_ilike, is_empty, is_null, before, after, etc.
      for (const op of Object.keys(ops)) {
        if (!(op in DFQL_TO_ADAPTER_OP) || DFQL_TO_ADAPTER_OP[op] === null) {
          return true;
        }
        // An $in list too long to bind as one parameter list
        if (isOversizedInList(DFQL_TO_ADAPTER_OP[op]!, ops[op])) {
          return true;
        }
      }
    }

    // Recurse into $and / $or sub-filters
    if ((key === "$and" || key === "$or") && Array.isArray(value)) {
      for (const sub of value) {
        if (
          typeof sub === "object" &&
          sub !== null &&
          !Array.isArray(sub) &&
          hasInMemoryFilterPatterns(sub as Record<string, unknown>)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Build the set of relation names (forward + inverse) for a given resource
 * from the schema. Used for bare-relation-name detection in select tokens.
 */
function buildRelationNames(
  resource: string | undefined,
  schema: unknown,
): Set<string> {
  const names = new Set<string>();
  if (!resource) return names;
  const s = schema as
    | { relations?: Array<{ from: string | readonly string[]; to: string | readonly string[]; relation: string; inverse?: string }> }
    | null
    | undefined;
  if (!s?.relations) return names;
  for (const rel of s.relations) {
    if (endpointIncludes(rel.from, resource) && rel.relation) names.add(rel.relation);
    if (endpointIncludes(rel.to, resource) && rel.inverse) names.add(rel.inverse);
  }
  return names;
}

/**
 * Convert a single key-value filter pair to PushdownWhereClause[].
 * Returns null if the value contains unpushable operators.
 */
function convertSingleFilter(
  key: string,
  value: unknown,
): PushdownWhereClause[] | null {
  // Shorthand: a value list → in, any other value → eq
  if (Array.isArray(value)) {
    if (isOversizedInList("in", value)) return null;
    return [{ field: key, operator: "in", value }];
  }
  if (typeof value !== "object" || value === null) {
    return [{ field: key, operator: "eq", value }];
  }

  const ops = value as Record<string, unknown>;
  const result: PushdownWhereClause[] = [];

  for (const [op, opVal] of Object.entries(ops)) {
    if (!(op in DFQL_TO_ADAPTER_OP)) return null;
    const adapterOp = DFQL_TO_ADAPTER_OP[op];
    if (adapterOp === null) return null;
    if (isOversizedInList(adapterOp, opVal)) return null;
    if (op === "$is_null" || op === "is_null") {
      result.push({
        field: key,
        operator: opVal === false ? "ne" : "eq",
        value: null,
      });
      continue;
    }
    if (op === "$is_not_null" || op === "is_not_null") {
      result.push({
        field: key,
        operator: opVal === false ? "eq" : "ne",
        value: null,
      });
      continue;
    }
    result.push({ field: key, operator: adapterOp, value: opVal });
  }

  return result.length > 0 ? result : null;
}

/**
 * Checks whether a filter entry is a relation filter for `resource`. A key
 * naming a relation whose foreign key has the same name (e.g. many-one
 * `parent` with `fkField: "parent"`) filters that field unless its value is a
 * quantifier object.
 */
function isRelationKey(
  key: string,
  value: unknown,
  resource: string | undefined,
  schema: unknown,
): boolean {
  const s = schema as { relations?: Array<{ from: string | readonly string[]; to: string | readonly string[]; relation: string; inverse?: string }> };
  if (!s?.relations || !resource) return false;
  const named = s.relations.some(
    (r) =>
      (endpointIncludes(r.from, resource) && r.relation === key) ||
      (endpointIncludes(r.to, resource) && r.inverse === key),
  );
  if (!named) return false;
  return Array.isArray((s as { resources?: unknown }).resources)
    ? isRelationFilterEntry(s as DatafnSchema, resource, key, value)
    : true;
}

/**
 * Whether a select token base (`parent` / `children`) is an HTREE expansion.
 * With a schema that defines the resource, only a relation of type "htree"
 * is; a many-one relation or a field that happens to be named `parent` is not.
 * Without one, the names alone decide (legacy behavior).
 */
export function isHtreeSelectBase(
  baseName: string,
  resource: unknown,
  schema: unknown,
): boolean {
  if (baseName !== "parent" && baseName !== "children") return false;
  const s = schema as DatafnSchema | undefined;
  if (
    typeof resource !== "string" ||
    !Array.isArray(s?.resources) ||
    !s!.resources.some((r) => r.name === resource)
  ) {
    return true;
  }
  return findRelationMatch(s as any, resource, baseName)?.relation.type === "htree";
}
