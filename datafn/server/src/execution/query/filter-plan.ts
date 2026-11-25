/**
 * Filter push-down planning.
 *
 * Turns a DFQL filter object into adapter WHERE clauses, including filters
 * the plain clause conversion in planner.ts cannot express:
 *
 * - `$is_empty` / `$is_not_empty` on string, number and boolean fields.
 *   "Empty" matches the in-memory matcher in @datafn/core: null, undefined
 *   or "" (an empty array is only possible for array/json fields, which
 *   stay in memory). `$is_not_empty` is `field IS NOT NULL AND field <> ''`;
 *   `$is_empty` needs `field IS NULL OR field = ''`.
 * - `$any` on any many-one, one-many or many-many relation, and `$none` on
 *   relations whose foreign key or join row is on the related side. They are
 *   resolved in two steps: the related records matching the sub-filter are
 *   read first, then the primary resource is filtered by `id`/foreign key
 *   `IN` (or `id NOT IN` for `$none`) the matching ids.
 *
 * WhereClause lists are combined left to right by each clause's connector,
 * so one OR group can lead a list (`(a OR b) AND c AND …`); the row-level
 * namespace clause the adapter appends is ANDed after it. A query with more
 * than one OR group is run as several disjoint WHERE lists ("branches"), one
 * per combination of the remaining groups, whose rows are merged.
 */

import type { Adapter, WhereClause } from "@superfunctions/db";
import {
  endpointList,
  evaluateFilter as coreEvaluateFilter,
  findRelationMatch,
  getCapabilityFields,
  getRelationJoinTableName,
  relationFkFieldForManyOne,
  relationTargetEndpoint,
  resolveCapabilities,
  normalizeFilterOps,
  resolveEndpointResource,
} from "@datafn/core";
import type { DatafnSchema } from "../../core-types.js";
import {
  isNamespaceOwnerActor,
  isPrivateShareableResource,
  resolveAccessLevel,
} from "../../validation/authz.js";
import { isPolymorphicForeignKey, relationForeignKey, resolvePredicateEndpoint } from "./filters.js";
import { MAX_PUSHDOWN_IN_VALUES } from "./planner.js";

/** Most disjoint WHERE lists one filter may expand to (one per OR-group combination). */
export const MAX_FILTER_BRANCHES = 16;

/**
 * Most related ids a relation filter may resolve to before the query is
 * evaluated in memory instead (keeps `IN` lists well under driver
 * bound-parameter limits).
 */
export const MAX_RELATION_FILTER_IDS = 10_000;

/** Thrown when a query classified for push-down cannot be pushed down at run time. */
export class FilterPushdownUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterPushdownUnavailableError";
  }
}

type RelationMatch = NonNullable<ReturnType<typeof findRelationMatch>>;

type Conjunct =
  | { kind: "clause"; clause: WhereClause }
  /**
   * Exactly one of two alternatives (each an AND of clauses) holds. The
   * alternatives exclude each other on every adapter, so WHERE lists built
   * from different alternatives never share a row.
   */
  | { kind: "either"; alternatives: [WhereClause[], WhereClause[]] }
  | {
      kind: "relation";
      quantifier: "$any" | "$none";
      match: RelationMatch;
      /** Compiled sub-filter per related resource. */
      targets: Map<string, Conjunct[]>;
      /** The DFQL sub-filter, re-checked on the related rows read. */
      subFilter: Record<string, unknown>;
    };

export type FilterPlan =
  /** The filter can match no row. */
  | { kind: "empty" }
  /** Disjoint WHERE lists; the result is the union of their rows. */
  | { kind: "where"; branches: WhereClause[][] };

export interface FilterPlanContext {
  db: Adapter;
  namespace: string;
  actorId?: string;
}

/**
 * Operators that map to one adapter clause. `$ne` and `$in` are handled
 * separately where NULL matters; `$like` / `$ilike` have no WhereClause
 * operator and stay in memory.
 */
const SCALAR_OPS: Record<string, WhereClause["operator"]> = {
  $eq: "eq", eq: "eq",
  $gt: "gt", gt: "gt",
  $gte: "gte", gte: "gte",
  $lt: "lt", lt: "lt",
  $lte: "lte", lte: "lte",
};

/**
 * How scalar operators treat NULL.
 * - "adapter": SQL semantics (`<>`, `IN`, comparisons never match NULL), the
 *   semantics the server has always applied to top-level filters of the
 *   primary resource (plain push-down and the in-memory pre-filter).
 * - "memory": the in-memory evaluator's semantics, for relation sub-filters,
 *   which were only ever evaluated in memory. `$ne: v` and `$in` with null
 *   match NULL; range comparisons (JS coerces null to 0) stay in memory.
 */
type NullSemantics = "adapter" | "memory";

const RANGE_OPS = new Set(["gt", "gte", "lt", "lte"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A relation quantifier object, as the in-memory evaluator recognises one. */
export function isQuantifierFilterValue(value: unknown): boolean {
  return isPlainObject(value) && ("$any" in value || "$all" in value || "$none" in value);
}

/**
 * True when `key` names a relation of `resource` whose foreign key is stored
 * on `resource` under the same name (e.g. a many-one `parent` relation with
 * `fkField: "parent"`). Such a key is also a field of the resource.
 */
export function isForeignKeyNamedRelation(
  schema: DatafnSchema,
  resource: string,
  key: string,
): boolean {
  const match = findRelationMatch(schema as any, resource, key);
  if (!match) return false;
  const relation = match.relation as any;
  if (relation.type === "many-one" && match.direction === "forward") {
    return relationFkFieldForManyOne(relation) === key;
  }
  if (relation.type === "one-many" && match.direction === "inverse") {
    return (relation.fkField || relation.foreignKey || `${relation.inverse}Id`) === key;
  }
  return false;
}

/**
 * Whether a filter entry is a relation filter. A key that names a relation is
 * one, except when the relation's foreign key has the same name and the value
 * is not a quantifier object: that entry filters the foreign key field.
 */
export function isRelationFilterEntry(
  schema: DatafnSchema,
  resource: string,
  key: string,
  value: unknown,
): boolean {
  if (!findRelationMatch(schema as any, resource, key)) return false;
  if (isQuantifierFilterValue(value)) return true;
  return !isForeignKeyNamedRelation(schema, resource, key);
}

function fieldType(schema: DatafnSchema, resource: string, field: string): string | undefined {
  if (field === "id") return "string";
  const resourceSchema = schema.resources.find((r) => r.name === resource);
  if (!resourceSchema) return undefined;
  const capabilityField = getCapabilityFields(
    resolveCapabilities(schema.capabilities as any, resourceSchema.capabilities as any) as any,
  ).find((f) => f.name === field);
  if (capabilityField) return capabilityField.type;
  const declared = resourceSchema.fields.find((f) => f.name === field);
  if (declared) return declared.type;
  // Undeclared many-one foreign keys hold record ids.
  for (const relation of schema.relations ?? []) {
    if (
      relation.type === "many-one" &&
      endpointList(relation.from).includes(resource) &&
      relationFkFieldForManyOne(relation) === field
    ) {
      return "string";
    }
  }
  return undefined;
}

/** `$is_empty` / `$is_not_empty` for one field, or null when it stays in memory. */
function compileEmptiness(
  field: string,
  wantEmpty: boolean,
  type: string | undefined,
): Conjunct[] | null {
  if (type === "string") {
    return wantEmpty
      ? [{
          kind: "either",
          alternatives: [
            [{ field, operator: "eq", value: null }],
            [{ field, operator: "eq", value: "" }],
          ],
        }]
      : [
          { kind: "clause", clause: { field, operator: "ne", value: null } },
          { kind: "clause", clause: { field, operator: "ne", value: "" } },
        ];
  }
  if (type === "number" || type === "boolean") {
    return [{ kind: "clause", clause: { field, operator: wantEmpty ? "eq" : "ne", value: null } }];
  }
  return null;
}

function compileFieldFilter(
  schema: DatafnSchema,
  resource: string,
  field: string,
  value: unknown,
  semantics: NullSemantics,
): Conjunct[] | null {
  // A sub-filter on a polymorphic relation can name a field only some
  // target resources declare; the in-memory evaluator reads it as missing.
  const type = fieldType(schema, resource, field);
  if (semantics === "memory" && type === undefined) return null;
  /**
   * In "memory" semantics an equality operand is pushed only when SQL
   * equality agrees with the evaluator's strict `===` / `includes`: a
   * non-null scalar of the field's declared type. Null (the evaluator tells
   * null from a missing value, the memory adapter does not), objects and
   * arrays (compared by identity) and mismatched types (SQL coerces "3" to
   * 3) stay in memory. `list`: the operand is a value list.
   */
  const unsafeOperand = (operand: unknown, list = false): boolean => {
    if (semantics !== "memory") return false;
    const values = list && Array.isArray(operand) ? operand : [operand];
    return values.some((v) =>
      !((type === "string" && typeof v === "string") ||
        (type === "number" && typeof v === "number" && Number.isFinite(v)) ||
        (type === "boolean" && typeof v === "boolean")),
    );
  };
  const clause = (operator: string, operand: unknown): Conjunct => ({
    kind: "clause",
    clause: { field, operator: operator as WhereClause["operator"], value: operand },
  });

  // Shorthand forms, normalised the way the in-memory evaluator does.
  // A value list longer than one bound-parameter list stays in memory.
  const oversized = (list: unknown[]) => list.length > MAX_PUSHDOWN_IN_VALUES;
  if (Array.isArray(value)) {
    return unsafeOperand(value, true) || oversized(value) ? null : [clause("in", value)];
  }
  if (!isPlainObject(value)) return unsafeOperand(value) ? null : [clause("eq", value)];

  const out: Conjunct[] = [];
  for (const [op, operand] of Object.entries(value)) {
    if (operand === undefined) return null;
    const scalar = SCALAR_OPS[op];
    if (scalar) {
      if (semantics === "memory" && (RANGE_OPS.has(scalar) || unsafeOperand(operand))) return null;
      out.push(clause(scalar, operand));
      continue;
    }
    if (op === "$in" || op === "in") {
      if (!Array.isArray(operand) || unsafeOperand(operand, true) || oversized(operand)) return null;
      out.push(clause("in", operand));
      continue;
    }
    if (op === "$ne" || op === "ne") {
      if (unsafeOperand(operand)) return null;
      // A database whose collation compares strings case-insensitively
      // would drop rows that differ only in case; the re-check of the rows
      // read can't bring them back, so string inequality stays in memory.
      if (semantics === "memory" && typeof operand === "string") return null;
      // In memory, `$ne: v` also matches null and missing values.
      out.push(
        semantics === "adapter"
          ? clause("ne", operand)
          : {
              kind: "either",
              alternatives: [
                [{ field, operator: "eq", value: null }],
                // `IS NOT NULL` keeps the alternatives disjoint on adapters
                // (the memory adapter) whose `ne` also matches null.
                [
                  { field, operator: "ne", value: null },
                  { field, operator: "ne", value: operand },
                ],
              ],
            },
      );
      continue;
    }
    if (op === "$is_null" || op === "is_null" || op === "$is_not_null" || op === "is_not_null") {
      // In memory a non-boolean operand constrains nothing.
      if (semantics === "memory" && typeof operand !== "boolean") continue;
      const wantNull = (op === "$is_null" || op === "is_null") === (operand !== false);
      out.push(clause(wantNull ? "eq" : "ne", null));
      continue;
    }
    if (op === "$is_empty" || op === "is_empty" || op === "$is_not_empty" || op === "is_not_empty") {
      // Like the in-memory matcher, a non-boolean operand constrains nothing.
      if (typeof operand !== "boolean") continue;
      const isEmptyOp = op === "$is_empty" || op === "is_empty";
      // `<> ''` would leave out values a padding or case-insensitive
      // collation compares equal to '' (e.g. " "); the re-check of the rows
      // read can't bring them back, so this stays in memory.
      if (semantics === "memory" && type === "string" && isEmptyOp !== operand) return null;
      const compiled = compileEmptiness(field, isEmptyOp === operand, type);
      if (!compiled) return null;
      out.push(...compiled);
      continue;
    }
    return null;
  }
  return out;
}

function compileRelationFilter(
  schema: DatafnSchema,
  resource: string,
  key: string,
  value: Record<string, unknown>,
): Conjunct | null {
  const match = findRelationMatch(schema as any, resource, key);
  if (!match) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const quantifier = keys[0];
  if (quantifier !== "$any" && quantifier !== "$none") return null;
  const subFilter = value[quantifier];
  if (!isPlainObject(subFilter) || Object.keys(subFilter).length === 0) return null;

  const relation = match.relation as any;
  if (relation.type !== "many-one" && relation.type !== "one-many" && relation.type !== "many-many") {
    return null;
  }
  // `$none` with the foreign key on the primary side needs `fk IS NULL OR
  // fk NOT IN (…)`; it stays in memory.
  if (quantifier === "$none" && foreignKeyOnPrimary(match)) return null;
  // FK membership alone cannot distinguish polymorphic records that share an ID.
  if (isPolymorphicForeignKey(relation)) return null;

  const targets = new Map<string, Conjunct[]>();
  for (const target of endpointList(relationTargetEndpoint(match.relation, match.direction))) {
    if (!schema.resources.some((r) => r.name === target)) return null;
    const compiled = compileConjuncts(schema, target, subFilter, false, "memory");
    if (!compiled || !expandBranches(compiled)) return null;
    targets.set(target, compiled);
  }
  return { kind: "relation", quantifier, match, targets, subFilter };
}

function compileConjuncts(
  schema: DatafnSchema,
  resource: string,
  filters: unknown,
  allowRelations: boolean,
  semantics: NullSemantics = "adapter",
): Conjunct[] | null {
  if (!isPlainObject(filters)) return null;
  const out: Conjunct[] = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined) return null;
    if (key === "$and") {
      if (!Array.isArray(value)) return null;
      for (const sub of value) {
        const compiled = compileConjuncts(schema, resource, sub, allowRelations, semantics);
        if (!compiled) return null;
        out.push(...compiled);
      }
      continue;
    }
    // $or, other logical keys and dot paths are evaluated in memory.
    if (key.startsWith("$") || key.includes(".")) return null;
    if (isQuantifierFilterValue(value)) {
      if (!allowRelations) return null;
      const compiled = compileRelationFilter(schema, resource, key, value as Record<string, unknown>);
      if (!compiled) return null;
      out.push(compiled);
      continue;
    }
    if (isRelationFilterEntry(schema, resource, key, value)) return null;
    const compiled = compileFieldFilter(schema, resource, key, value, semantics);
    if (!compiled) return null;
    out.push(...compiled);
  }
  return out;
}

type Alternatives = [WhereClause[], WhereClause[]];

/** A group that can lead a WHERE list as `a OR b` (one clause per alternative). */
function canLead(group: Alternatives): boolean {
  return group[0].length === 1 && group[1].length === 1;
}

/**
 * Expand clauses and OR groups into disjoint WHERE lists. One group with a
 * single clause per alternative leads every list through the OR connector;
 * the others are expanded, one list per combination of alternatives.
 * Relation conjuncts must already be resolved. Returns null past
 * MAX_FILTER_BRANCHES.
 */
function expandBranches(conjuncts: Conjunct[], extra: WhereClause[] = []): WhereClause[][] | null {
  const clauses: WhereClause[] = [];
  const groups: Alternatives[] = [];
  for (const conjunct of conjuncts) {
    if (conjunct.kind === "clause") clauses.push(conjunct.clause);
    else if (conjunct.kind === "either") groups.push(conjunct.alternatives);
  }
  clauses.push(...extra);
  const leadIndex = groups.findIndex(canLead);
  const expanded = groups.filter((_, index) => index !== leadIndex);
  if (2 ** expanded.length > MAX_FILTER_BRANCHES) return null;
  const lead: WhereClause[] = leadIndex === -1
    ? []
    : [groups[leadIndex][0][0], { ...groups[leadIndex][1][0], connector: "OR" }];
  let combinations: WhereClause[][] = [[]];
  for (const group of expanded) {
    combinations = combinations.flatMap((combination) => [
      [...combination, ...group[0]],
      [...combination, ...group[1]],
    ]);
  }
  return combinations.map((combination) => [...lead, ...combination, ...clauses]);
}

/**
 * Whether every filter of a query can be pushed to the adapter by
 * planFilterPushdown (relation filters may still fall back at run time when
 * they match more than MAX_RELATION_FILTER_IDS records).
 */
export function canPushDownFilters(
  filters: unknown,
  resource: string | undefined,
  schema: DatafnSchema | undefined,
): boolean {
  if (!schema || !resource || !Array.isArray(schema.resources)) return false;
  if (!schema.resources.some((r) => r.name === resource)) return false;
  const compiled = compileConjuncts(schema, resource, filters, true);
  return compiled !== null && expandBranches(compiled) !== null;
}

/**
 * WHERE clauses that pre-filter the primary resource of an in-memory query:
 * every top-level filter that compiles to clauses, plus one OR group
 * (e.g. an `$is_empty`). The result matches a superset of the filter; the full filter is
 * still evaluated in memory.
 */
export function buildPrefilterWhere(
  filters: Record<string, unknown>,
  resource: string,
  schema: DatafnSchema,
): WhereClause[] {
  const conjuncts: Conjunct[] = [];
  const collect = (filter: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(filter)) {
      if (key === "$and") {
        if (Array.isArray(value)) {
          for (const sub of value) if (isPlainObject(sub)) collect(sub);
        }
        continue;
      }
      const compiled = compileConjuncts(schema, resource, { [key]: value }, false);
      if (compiled) conjuncts.push(...compiled);
    }
  };
  collect(filters);
  // One group can lead through the OR connector; other groups are left to
  // the in-memory evaluation (dropping a conjunct only widens the set).
  const lead = conjuncts.find((c) => c.kind === "either" && canLead(c.alternatives));
  // Keep the pushed `in` lists within one statement's parameter budget; a
  // list past it is left to the in-memory evaluation.
  let inBudget = MAX_PUSHDOWN_IN_VALUES;
  const clauses = conjuncts.filter((c) => {
    if (c.kind !== "clause") return false;
    if (c.clause.operator !== "in" || !Array.isArray(c.clause.value)) return true;
    if (c.clause.value.length > inBudget) return false;
    inBudget -= c.clause.value.length;
    return true;
  });
  return expandBranches(lead ? [lead, ...clauses] : clauses)![0];
}

// ---------------------------------------------------------------------------
// Run-time planning
// ---------------------------------------------------------------------------

function foreignKeyOnPrimary(match: RelationMatch): boolean {
  const type = (match.relation as any).type;
  return (type === "many-one" && match.direction === "forward") ||
    (type === "one-many" && match.direction === "inverse");
}

async function filterVisibleRows(
  rows: Record<string, unknown>[],
  resource: string,
  schema: DatafnSchema,
  ctx: FilterPlanContext,
): Promise<Record<string, unknown>[]> {
  if (!isPrivateShareableResource(schema, resource)) return rows;
  if (!ctx.actorId) return [];
  // The namespace owner sees every row (as DbDataStore's visibility filter
  // assumes); skip the per-row access lookups.
  if (isNamespaceOwnerActor(ctx.actorId, ctx.namespace)) return rows;
  const visible: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (typeof row.id !== "string") continue;
    try {
      if (await resolveAccessLevel(ctx.db, schema, resource, row.id, ctx.actorId, ctx.namespace)) {
        visible.push(row);
      }
    } catch {
      // Excluded, as the in-memory store excludes rows it cannot check.
    }
  }
  return visible;
}

/**
 * Related records matching a relation's sub-filter, per related resource,
 * readable by the actor. Null when there are more than MAX_RELATION_FILTER_IDS.
 */
/**
 * Whether a related row matches the relation sub-filter with the in-memory
 * evaluator's semantics. The database read is a superset where its string
 * comparison is looser than strict equality (e.g. a case-insensitive
 * collation); this drops the extra rows.
 */
function matchesSubFilter(row: Record<string, unknown>, subFilter: Record<string, unknown>): boolean {
  return coreEvaluateFilter(row, normalizeFilterOps(normalizeShorthandLists(subFilter)));
}

/** Field array shorthand → `$in` (as the server evaluator reads it), through `$and` / `$or`. */
function normalizeShorthandLists(filter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (key === "$and" || key === "$or") {
      out[key] = Array.isArray(value)
        ? value.map((sub) => (isPlainObject(sub) ? normalizeShorthandLists(sub) : sub))
        : value;
    } else {
      out[key] = Array.isArray(value) ? { $in: value } : value;
    }
  }
  return out;
}

async function findMatchingRelated(
  targets: Map<string, Conjunct[]>,
  subFilter: Record<string, unknown>,
  schema: DatafnSchema,
  ctx: FilterPlanContext,
  extra: WhereClause[] = [],
  checkVisibility = true,
): Promise<Map<string, Record<string, unknown>[]> | null> {
  const matching = new Map<string, Record<string, unknown>[]>();
  let total = 0;
  for (const [resource, conjuncts] of targets) {
    const branches = expandBranches(conjuncts, extra);
    if (!branches) return null;
    const rows: Record<string, unknown>[] = [];
    for (const where of branches) {
      const found = await ctx.db.findMany({
        model: resource,
        where,
        limit: MAX_RELATION_FILTER_IDS + 1,
        namespace: ctx.namespace,
      });
      // A capped read may have left matching rows out.
      if (found.length > MAX_RELATION_FILTER_IDS) return null;
      for (const row of found) {
        if (matchesSubFilter(row, subFilter)) rows.push(row);
      }
      if (total + rows.length > MAX_RELATION_FILTER_IDS) return null;
    }
    const visible = checkVisibility ? await filterVisibleRows(rows, resource, schema, ctx) : rows;
    total += visible.length;
    matching.set(resource, visible);
  }
  return matching;
}

function joinRowsForFromResource(
  rows: Record<string, unknown>[],
  relation: any,
  fromResource: string,
  schema: DatafnSchema,
): Array<{ from: unknown; to: unknown; toResource: unknown }> {
  const fromCol = relation.joinColumns?.from ?? "from";
  const toCol = relation.joinColumns?.to ?? "to";
  const out: Array<{ from: unknown; to: unknown; toResource: unknown }> = [];
  for (const row of rows) {
    const from = row[fromCol];
    const discriminator = row.fromResource;
    const rowResource = typeof discriminator === "string"
      ? discriminator
      : resolveEndpointResource(relation.from, from, schema as any);
    if (rowResource === fromResource) out.push({ from, to: row[toCol], toResource: row.toResource });
  }
  return out;
}

/**
 * Resolve a relation filter to one WHERE clause on the primary resource,
 * `null` (no clause needed), "empty" (nothing can match), or "unavailable".
 */
async function resolveRelationConjunct(
  conjunct: Extract<Conjunct, { kind: "relation" }>,
  primaryResource: string,
  schema: DatafnSchema,
  ctx: FilterPlanContext,
): Promise<WhereClause | null | "empty" | "unavailable"> {
  const { match, quantifier, targets, subFilter } = conjunct;
  const relation = match.relation as any;
  const targetEndpoint = relationTargetEndpoint(match.relation, match.direction);

  const idClause = (ids: Set<unknown>): WhereClause | null | "empty" | "unavailable" => {
    if (ids.size > MAX_RELATION_FILTER_IDS) return "unavailable";
    if (quantifier === "$any") {
      return ids.size === 0 ? "empty" : { field: "id", operator: "in", value: [...ids] };
    }
    return ids.size === 0 ? null : { field: "id", operator: "not_in", value: [...ids] };
  };

  if (relation.type === "many-one" || relation.type === "one-many") {
    const fk = relationForeignKey(relation);
    if (foreignKeyOnPrimary(match)) {
      // `$any` only (compile rejects `$none` here): fk IN matching related ids.
      const matching = await findMatchingRelated(targets, subFilter, schema, ctx);
      if (!matching) return "unavailable";
      const ids = new Set<unknown>();
      for (const [resource, rows] of matching) {
        for (const row of rows) {
          if (resolvePredicateEndpoint(schema, row.id, targetEndpoint) === resource) ids.add(row.id);
        }
      }
      if (ids.size === 0) return "empty";
      return { field: fk, operator: "in", value: [...ids] };
    }
    // Foreign key on the related records: primary ids are their fk values.
    const matching = await findMatchingRelated(targets, subFilter, schema, ctx, [
      { field: fk, operator: "ne", value: null },
    ]);
    if (!matching) return "unavailable";
    const ids = new Set<unknown>();
    for (const rows of matching.values()) {
      for (const row of rows) {
        if (row[fk] !== null && row[fk] !== undefined) ids.add(row[fk]);
      }
    }
    return idClause(ids);
  }

  // many-many: read the join rows that point at matching related records,
  // then check visibility only for related records that are linked.
  const matching = await findMatchingRelated(targets, subFilter, schema, ctx, [], false);
  if (!matching) return "unavailable";
  const isForward = match.direction === "forward";
  const relatedIds = new Set<unknown>();
  for (const rows of matching.values()) {
    for (const row of rows) relatedIds.add(row.id);
  }
  const links: Array<{ resource: string; relatedId: unknown; primaryId: unknown }> = [];
  if (relatedIds.size > 0) {
    const fromResources = isForward ? [primaryResource] : endpointList(relation.from);
    const matchColumn = isForward
      ? relation.joinColumns?.to ?? "to"
      : relation.joinColumns?.from ?? "from";
    for (const fromResource of fromResources) {
      const rows = await ctx.db.findMany({
        model: getRelationJoinTableName(relation, fromResource),
        where: [{ field: matchColumn, operator: "in", value: [...relatedIds] }],
        namespace: ctx.namespace,
      });
      for (const row of joinRowsForFromResource(rows, relation, fromResource, schema)) {
        if (!isForward && resolvePredicateEndpoint(schema, row.to, relation.to, row.toResource) !== primaryResource) {
          continue;
        }
        const relatedId = isForward ? row.to : row.from;
        const primaryId = isForward ? row.from : row.to;
        if (relatedIds.has(relatedId) && primaryId !== null && primaryId !== undefined) {
          const resource = isForward
            ? resolvePredicateEndpoint(schema, relatedId, targetEndpoint, row.toResource)
            : fromResource;
          links.push({ resource, relatedId, primaryId });
        }
      }
    }
  }
  const linkedIds = new Map<string, Set<unknown>>();
  for (const { resource, relatedId } of links) {
    const ids = linkedIds.get(resource) ?? new Set();
    ids.add(relatedId);
    linkedIds.set(resource, ids);
  }
  const visibleIds = new Map<string, Set<unknown>>();
  for (const [resource, rows] of matching) {
    const ids = linkedIds.get(resource);
    if (!ids) continue;
    const linked = rows.filter((row) => ids.has(row.id));
    const visible = await filterVisibleRows(linked, resource, schema, ctx);
    visibleIds.set(resource, new Set(visible.map((row) => row.id)));
  }
  const primaryIds = new Set<unknown>();
  for (const link of links) {
    if (visibleIds.get(link.resource)?.has(link.relatedId)) primaryIds.add(link.primaryId);
  }
  return idClause(primaryIds);
}

/**
 * Plan a DFQL filter for the adapter. Returns null when the filter cannot be
 * pushed down (the caller evaluates the query in memory instead).
 */
export async function planFilterPushdown(
  filters: Record<string, unknown> | undefined,
  resource: string,
  schema: DatafnSchema,
  ctx: FilterPlanContext,
): Promise<FilterPlan | null> {
  if (!filters || Object.keys(filters).length === 0) {
    return { kind: "where", branches: [[]] };
  }
  const compiled = compileConjuncts(schema, resource, filters, true);
  if (!compiled) return null;
  const resolved: Conjunct[] = [];
  for (const conjunct of compiled) {
    if (conjunct.kind !== "relation") {
      resolved.push(conjunct);
      continue;
    }
    const clause = await resolveRelationConjunct(conjunct, resource, schema, ctx);
    if (clause === "unavailable") return null;
    if (clause === "empty") return { kind: "empty" };
    if (clause) resolved.push({ kind: "clause", clause });
  }
  const branches = expandBranches(resolved);
  return branches ? { kind: "where", branches } : null;
}

/**
 * Follow relation names from a set of resources. Returns the related
 * resources, and whether any step reaches `primary`. Stops at the first
 * segment that is not a relation of the current resources.
 */
function walkRelationPath(
  segments: string[],
  from: string[],
  primary: string,
  schema: DatafnSchema,
): { resources: string[]; reachesPrimary: boolean } {
  let current = from;
  let reachesPrimary = false;
  for (const segment of segments) {
    const next = new Set<string>();
    for (const resource of current) {
      const match = findRelationMatch(schema as any, resource, segment);
      if (!match) continue;
      for (const target of endpointList(relationTargetEndpoint(match.relation, match.direction))) {
        next.add(target);
      }
    }
    if (next.size === 0) break;
    if (next.has(primary)) reachesPrimary = true;
    current = [...next];
  }
  return { resources: current, reachesPrimary };
}

function filterReachesPrimary(
  filters: unknown,
  resources: string[],
  primary: string,
  schema: DatafnSchema,
): boolean {
  if (!isPlainObject(filters)) return false;
  for (const [key, value] of Object.entries(filters)) {
    if (key === "$and" || key === "$or" || key === "$not") {
      const subs = Array.isArray(value) ? value : [value];
      if (subs.some((sub) => filterReachesPrimary(sub, resources, primary, schema))) return true;
      continue;
    }
    if (key.startsWith("$")) continue;
    const isQuantifier = isQuantifierFilterValue(value);
    // A scalar on a key that is also a same-named foreign key is a field filter.
    if (!key.includes(".") && !isQuantifier) {
      if (resources.every((resource) => !isRelationFilterEntry(schema, resource, key, value))) continue;
    }
    const walked = walkRelationPath(key.split("."), resources, primary, schema);
    if (walked.reachesPrimary) return true;
    if (isQuantifier) {
      for (const sub of Object.values(value as Record<string, unknown>)) {
        if (filterReachesPrimary(sub, walked.resources, primary, schema)) return true;
      }
    }
  }
  return false;
}

/**
 * Whether evaluating the filter in memory reads other records of the
 * primary resource through a relation path: a quantifier, nested
 * quantifier or dot path that leads back to the primary resource (e.g.
 * `childNodes: { $all: … }` or `project: { $any: { tasks: { $any: … } } }`).
 * Such a query cannot pre-filter the primary resource: the related records
 * would be missing from the store.
 */
export function filterReadsPrimaryThroughRelation(
  filters: unknown,
  resource: string,
  schema: DatafnSchema,
): boolean {
  return filterReachesPrimary(filters, [resource], resource, schema);
}

/**
 * Whether a select token expands a relation path that leads back to the
 * primary resource (e.g. `childNodes.*` or `project.tasks.*`). The in-memory
 * store finds those related records among the primary rows, so such a query
 * cannot pre-filter the primary resource either.
 */
export function selectReadsPrimaryThroughRelation(
  select: unknown,
  resource: string,
  schema: DatafnSchema,
): boolean {
  if (!Array.isArray(select)) return false;
  return select.some(
    (token) =>
      typeof token === "string" &&
      walkRelationPath(token.split("."), [resource], resource, schema).reachesPrimary,
  );
}

/**
 * Whether a groupBy key, sort term or aggregation field names a relation
 * path that leads back to the primary resource (e.g. `manager.name` on a
 * self relation). Those values are read from related records in the store.
 */
export function queryPathsReadPrimaryThroughRelation(
  query: Record<string, unknown>,
  resource: string,
  schema: DatafnSchema,
): boolean {
  const paths: string[] = [];
  if (Array.isArray(query.groupBy)) {
    for (const key of query.groupBy) if (typeof key === "string") paths.push(key);
  }
  if (Array.isArray(query.sort)) {
    for (const term of query.sort) {
      if (typeof term === "string") paths.push(term.replace(/^[-+]/, "").split(":")[0]);
      else if (isPlainObject(term) && typeof term.field === "string") paths.push(term.field);
    }
  }
  if (isPlainObject(query.aggregations)) {
    for (const def of Object.values(query.aggregations)) {
      if (isPlainObject(def) && typeof def.field === "string") paths.push(def.field);
    }
  }
  return paths.some(
    (path) => path.includes(".") && walkRelationPath(path.split("."), [resource], resource, schema).reachesPrimary,
  );
}
