/**
 * DFQL filter evaluation — server wrapper around @datafn/core evaluateFilter.
 * Handles $any/$all/$none relation quantifiers (server-specific) and
 * normalizes non-$-prefixed operator names before delegating to core.
 */

import {
  endpointList,
  endpointIncludes,
  evaluateFilter as coreEvaluateFilter,
  findRelationMatch,
  firstEndpoint,
  getCapabilityFields,
  getRelationFkFieldsForResource,
  OP_REMAP,
  relationKeyFor,
  relationTargetEndpoint,
  relationFkFieldForManyOne,
  resolveCapabilities,
  resolveEndpointResource,
  type DatafnRelationMatch,
} from "@datafn/core";
import type { DatafnFieldSchema, DatafnRelationSchema, DatafnResourceSchema, DatafnSchema } from "../../core-types.js";
import { DatafnExecutionError } from "../errors.js";
import type { DataStore } from "../store.js";

// Keep the same traversal bound as Core's dot-path evaluator.
const MAX_RELATION_FILTER_DEPTH = 10;

type FilterResource = {
  name: string;
  fields: readonly { name: string; type?: DatafnFieldSchema["type"] }[];
  capabilities?: DatafnResourceSchema["capabilities"];
};

type FilterSchema = {
  resources: readonly FilterResource[];
  relations?: readonly unknown[];
  capabilities?: DatafnSchema["capabilities"];
};

/** A dot-path rooted in a declared structured field stays inside that field. */
export function isNestedFilterField(resource: FilterResource | undefined, name: string): boolean {
  const field = resource?.fields.find((candidate) => candidate.name === name);
  return field?.type === "object" || field?.type === "json" || field?.type === "array" || field?.type === "file";
}

export function hasPredicateField(schema: FilterSchema, resource: FilterResource, name: string): boolean {
  if (name === "id" || resource.fields.some((field) => field.name === name)) return true;
  if (getRelationFkFieldsForResource(schema as DatafnSchema, resource.name)
    .some(({ field, resourceField }) => field === name || resourceField === name)) return true;
  return getCapabilityFields(resolveCapabilities(schema.capabilities, resource.capabilities))
    .some((field) => field.name === name);
}

function normalizeOps(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  // Array shorthand: ["a", "b"] → { $in: ["a", "b"] }
  if (Array.isArray(value)) return { $in: value };
  const ops = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [op, opVal] of Object.entries(ops)) {
    out[OP_REMAP[op] ?? op] = opVal;
  }
  return out;
}

function evaluateFieldFilter(
  record: Record<string, unknown>,
  key: string,
  value: unknown,
  resourceName: string,
  schema: FilterSchema,
  store: DataStore,
  related: boolean,
  depth = 0,
): boolean {
  if (depth > MAX_RELATION_FILTER_DEPTH) {
    throw new DatafnExecutionError(
      "DFQL_INVALID",
      `Filter nesting depth exceeds maximum of ${MAX_RELATION_FILTER_DEPTH}`,
      "filters",
    );
  }
  const dot = key.indexOf(".");
  const head = dot === -1 ? key : key.slice(0, dot);
  const source = related || dot !== -1
    ? schema.resources.find((candidate) => candidate.name === resourceName)
    : undefined;
  const knownField = !related || (!!source && hasPredicateField(schema, source, head));
  if (dot === -1 || (knownField && record[head] != null)) {
    return coreEvaluateFilter(knownField ? record : Object.create(null), { [key]: value });
  }

  if (isNestedFilterField(source, head)) return false;
  const relation = findRelation(schema, resourceName, head);
  if (!relation) return false;
  const tail = key.slice(dot + 1);
  if (tail === "__proto__" || tail === "constructor" || tail === "prototype") {
    throw new DatafnExecutionError("DFQL_INVALID", "Unsafe relation filter path", "filters");
  }
  return getRelatedRecords(record, relation, store, resourceName, schema).some(({ resource, record: related }) =>
    evaluateFieldFilter(related, tail, value, resource, schema, store, true, depth + 1),
  );
}

/**
 * Evaluate a filter expression against a record.
 * Handles $any/$all/$none quantifiers server-side; delegates the rest to core.
 */
export function evaluateFilter(
  record: Record<string, unknown>,
  filters: Record<string, unknown>,
  resourceName: string,
  schema: FilterSchema,
  store: any,
  related = false,
): boolean {
  for (const [key, value] of Object.entries(filters)) {
    // Recurse $and/$or through server's evaluateFilter (handles nested quantifiers)
    if (key === "$and") {
      if (!Array.isArray(value)) return false;
      if (!(value as Record<string, unknown>[]).every((sub) =>
        evaluateFilter(record, sub, resourceName, schema, store, related)
      )) return false;
      continue;
    }
    if (key === "$or") {
      if (!Array.isArray(value)) return false;
      if (!(value as Record<string, unknown>[]).some((sub) =>
        evaluateFilter(record, sub, resourceName, schema, store, related)
      )) return false;
      continue;
    }

    // Relation quantifiers: handled server-side
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const ops = value as Record<string, unknown>;
      if ("$any" in ops || "$all" in ops || "$none" in ops) {
        if (!evaluateRelationFilter(record, key, ops, resourceName, schema, store)) return false;
        continue;
      }
    }

    if (!evaluateFieldFilter(record, key, normalizeOps(value), resourceName, schema, store, related)) {
      return false;
    }
  }

  return true;
}

function findRelation(schema: any, resourceName: string, relationName: string) {
  return findRelationMatch(schema, resourceName, relationName) ?? null;
}

type RelatedRecord = { resource: string; record: Record<string, unknown> };

/** A stored resource takes precedence. Unqualified legacy IDs use the first endpoint. */
export function resolvePredicateEndpoint(
  schema: FilterSchema,
  id: unknown,
  endpoint: string | readonly string[],
  discriminator?: unknown,
): string {
  if (typeof discriminator === "string") {
    return endpointIncludes(endpoint, discriminator) ? discriminator : "";
  }
  return resolveEndpointResource(endpoint, id, schema) ?? firstEndpoint(endpoint);
}

export function relationForeignKey(relation: DatafnRelationSchema): string {
  return relation.type === "many-one"
    ? relationFkFieldForManyOne(relation)
    : relation.fkField || relation.foreignKey || `${relation.inverse}Id`;
}

export function isPolymorphicForeignKey(relation: DatafnRelationSchema): boolean {
  if (relation.type === "many-one") return endpointList(relation.to).length > 1;
  return relation.type === "one-many" && Boolean(relation.fkField || relation.foreignKey) &&
    endpointList(relation.from).length > 1;
}

export function foreignKeyTargetResolver(
  schema: FilterSchema,
  relation: DatafnRelationSchema,
  ownerResource: string,
) {
  const fk = relationForeignKey(relation);
  const endpoint = relation.type === "many-one" ? relation.to : relation.from;
  const discriminator = isPolymorphicForeignKey(relation)
    ? getRelationFkFieldsForResource(schema as DatafnSchema, ownerResource)
      .find(({ field }) => field === fk)?.resourceField
    : undefined;
  return (record: Record<string, unknown>) => {
    const id = record[fk];
    if (typeof id !== "string" || !id) return undefined;
    const resource = resolvePredicateEndpoint(schema, id, endpoint, discriminator ? record[discriminator] : undefined);
    return resource ? { id, resource } : undefined;
  };
}

export function getForeignKeyRelatedRecords(
  record: Record<string, unknown>,
  match: DatafnRelationMatch,
  store: DataStore,
  resourceName: string,
  schema: FilterSchema,
): RelatedRecord[] {
  const { relation, direction } = match;
  if ((direction === "forward") === (relation.type === "many-one")) {
    const target = foreignKeyTargetResolver(schema, relation, resourceName)(record);
    if (!target) return [];
    const found = store.getRecord(target.resource, target.id);
    return found ? [{ resource: target.resource, record: found }] : [];
  }
  const fk = relationForeignKey(relation);
  const polymorphicFk = isPolymorphicForeignKey(relation);
  return endpointList(relationTargetEndpoint(relation, direction)).flatMap((resource) => {
    const resolveTarget = polymorphicFk ? foreignKeyTargetResolver(schema, relation, resource) : undefined;
    return store.findRecords(resource, fk, record.id)
      .filter((found) => !resolveTarget || resolveTarget(found)?.resource === resourceName)
      .map((found) => ({ resource, record: found }));
  });
}

function getRelatedRecords(
  record: Record<string, unknown>,
  rel: NonNullable<ReturnType<typeof findRelationMatch>>,
  store: DataStore,
  resourceName: string,
  schema: FilterSchema,
): RelatedRecord[] {
  const relation = rel.relation;
  const direction = rel.direction;
  const isForward = direction === "forward";
  const targetEndpoint = relationTargetEndpoint(relation, direction);
  const findById = (id: unknown, endpoint = targetEndpoint, discriminator?: unknown): RelatedRecord[] => {
    if (typeof id !== "string" || !id) return [];
    const resource = resolvePredicateEndpoint(schema, id, endpoint, discriminator);
    const found = resource ? store.getRecord(resource, id) : null;
    return found ? [{ resource, record: found }] : [];
  };
  if (relation.type === "many-one" || relation.type === "one-many") {
    return getForeignKeyRelatedRecords(record, rel, store, resourceName, schema);
  }
  if (relation.type === "many-many") {
    if (isForward) {
      const joinRows = store.getJoinRows(relationKeyFor(resourceName, relation));
      return joinRows
        .filter((row) => row.from === record.id)
        .flatMap((row) => findById(row.to, targetEndpoint, row.toResource));
    }
    return endpointList(relation.from).flatMap((resource) => {
      const joinRows = store.getJoinRows(relationKeyFor(resource, relation));
      return joinRows
        .filter((row) => row.to === record.id &&
          resolvePredicateEndpoint(schema, row.to, relation.to, row.toResource) === resourceName)
        .flatMap((row) => findById(row.from, resource));
    });
  }
  return [];
}

function evaluateRelationFilter(
  record: Record<string, unknown>,
  relationName: string,
  ops: any,
  resourceName: string,
  schema: FilterSchema,
  store: DataStore,
): boolean {
  const rel = findRelation(schema, resourceName, relationName);
  if (!rel) return false;

  const relatedRecords = getRelatedRecords(record, rel, store, resourceName, schema);

  if (ops.$any) {
    const subFilter = ops.$any as Record<string, unknown>;
    return relatedRecords.some(({ record, resource }) =>
      evaluateFilter(record, subFilter, resource, schema, store, true),
    );
  }

  if (ops.$all) {
    const subFilter = ops.$all as Record<string, unknown>;
    if (relatedRecords.length === 0) return false;
    return relatedRecords.every(({ record, resource }) =>
      evaluateFilter(record, subFilter, resource, schema, store, true),
    );
  }

  if (ops.$none) {
    const subFilter = ops.$none as Record<string, unknown>;
    if (relatedRecords.length === 0) return true;
    return !relatedRecords.some(({ record, resource }) =>
      evaluateFilter(record, subFilter, resource, schema, store, true),
    );
  }

  return true;
}
