/**
 * DFQL filter evaluation — server wrapper around @datafn/core evaluateFilter.
 * Handles $any/$all/$none relation quantifiers (server-specific) and
 * normalizes non-$-prefixed operator names before delegating to core.
 */

import {
  endpointList,
  evaluateFilter as coreEvaluateFilter,
  findRelationMatch,
  firstEndpoint,
  OP_REMAP,
  relationKeyFor,
  relationTargetEndpoint,
  relationFkFieldForManyOne,
  resolveEndpointResource,
  resourceNameFromId,
} from "@datafn/core";
import type { DatafnFieldSchema } from "../../core-types.js";
import { DatafnExecutionError } from "../errors.js";

// Keep the same traversal bound as Core's dot-path evaluator.
const MAX_RELATION_FILTER_DEPTH = 10;

type FilterResource = {
  name: string;
  fields: readonly { name: string; type?: DatafnFieldSchema["type"] }[];
};

type FilterSchema = {
  resources: readonly FilterResource[];
  relations?: readonly unknown[];
};

/** A dot-path rooted in a declared structured field stays inside that field. */
export function isNestedFilterField(resource: FilterResource | undefined, name: string): boolean {
  const field = resource?.fields.find((candidate) => candidate.name === name);
  return field?.type === "object" || field?.type === "json" || field?.type === "array" || field?.type === "file";
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
  store: any,
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
  if (dot === -1 || record[key.slice(0, dot)] != null) {
    return coreEvaluateFilter(record, { [key]: value });
  }

  const head = key.slice(0, dot);
  const source = schema.resources.find((candidate) => candidate.name === resourceName);
  if (isNestedFilterField(source, head)) return false;
  const relation = findRelation(schema, resourceName, head);
  if (!relation) return false;
  const tail = key.slice(dot + 1);
  if (tail === "__proto__" || tail === "constructor" || tail === "prototype") {
    throw new DatafnExecutionError("DFQL_INVALID", "Unsafe relation filter path", "filters");
  }
  const target = relationTargetEndpoint(relation.relation, relation.direction);
  return getRelatedRecords(record, relation, store, resourceName, schema).some((related) =>
    evaluateFieldFilter(related, tail, value, recordResourceName(schema, related.id, target), schema, store, depth + 1),
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
): boolean {
  for (const [key, value] of Object.entries(filters)) {
    // Recurse $and/$or through server's evaluateFilter (handles nested quantifiers)
    if (key === "$and") {
      if (!Array.isArray(value)) return false;
      if (!(value as Record<string, unknown>[]).every((sub) =>
        evaluateFilter(record, sub, resourceName, schema, store)
      )) return false;
      continue;
    }
    if (key === "$or") {
      if (!Array.isArray(value)) return false;
      if (!(value as Record<string, unknown>[]).some((sub) =>
        evaluateFilter(record, sub, resourceName, schema, store)
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

    if (!evaluateFieldFilter(record, key, normalizeOps(value), resourceName, schema, store)) {
      return false;
    }
  }

  return true;
}

function findRelation(schema: any, resourceName: string, relationName: string) {
  return findRelationMatch(schema, resourceName, relationName) ?? null;
}

function recordResourceName(
  schema: any,
  id: unknown,
  fallback: string | readonly string[],
): string {
  return (
    resolveEndpointResource(fallback, id, schema) ??
    resourceNameFromId(id) ??
    firstEndpoint(fallback)
  );
}

function getRelatedRecords(
  record: any,
  rel: any,
  store: any,
  resourceName: string,
  schema: any,
): Record<string, unknown>[] {
  const relation = rel.relation;
  const direction = rel.direction;
  const isForward = direction === "forward";
  const targetEndpoint = relationTargetEndpoint(relation, direction);

  if (relation.type === "many-one") {
    if (isForward) {
      const fk = relationFkFieldForManyOne(relation);
      const targetId = record[fk];
      if (!targetId) return [];
      const target = store.getRecord(recordResourceName(schema, targetId, targetEndpoint), targetId as string);
      return target ? [target] : [];
    } else {
      const fk = relationFkFieldForManyOne(relation);
      return endpointList(targetEndpoint).flatMap((targetResource) =>
        store.findRecords(targetResource, fk, record.id),
      );
    }
  } else if (relation.type === "one-many") {
    if (isForward) {
      const fk = relation.fkField || relation.foreignKey || `${relation.inverse}Id`;
      return endpointList(targetEndpoint).flatMap((targetResource) =>
        store.findRecords(targetResource, fk, record.id),
      );
    } else {
      const fk = relation.fkField || relation.foreignKey || `${relation.inverse}Id`;
      const targetId = record[fk];
      if (!targetId) return [];
      const target = store.getRecord(recordResourceName(schema, targetId, targetEndpoint), targetId as string);
      return target ? [target] : [];
    }
  } else if (relation.type === "many-many") {
    if (isForward) {
      const joinRows = store.getJoinRows(relationKeyFor(resourceName, relation));
      const relatedIds = joinRows
        .filter((row: any) => row.from === record.id)
        .map((row: any) => row.to);
      return relatedIds
        .map((id: unknown) => store.getRecord(recordResourceName(schema, id, targetEndpoint), id as string))
        .filter((target: unknown): target is Record<string, unknown> => Boolean(target));
    } else {
      return endpointList(relation.from).flatMap((fromResource) => {
        const joinRows = store.getJoinRows(relationKeyFor(fromResource, relation));
        return joinRows
          .filter((row: any) => row.to === record.id)
          .map((row: any) => row.from)
          .map((id: unknown) => store.getRecord(recordResourceName(schema, id, targetEndpoint), id as string))
          .filter((target: unknown): target is Record<string, unknown> => Boolean(target));
      });
    }
  }
  return [];
}

function evaluateRelationFilter(
  record: any,
  relationName: string,
  ops: any,
  resourceName: string,
  schema: any,
  store: any,
): boolean {
  const rel = findRelation(schema, resourceName, relationName);
  if (!rel) return false;

  const relatedRecords = getRelatedRecords(record, rel, store, resourceName, schema);
  const targetEndpoint = relationTargetEndpoint(rel.relation, rel.direction);
  const relatedResource = (relatedRecord: Record<string, unknown>) =>
    recordResourceName(schema, relatedRecord.id, targetEndpoint);

  if (ops.$any) {
    const subFilter = ops.$any as Record<string, unknown>;
    return relatedRecords.some((r) =>
      evaluateFilter(r, subFilter, relatedResource(r), schema, store),
    );
  }

  if (ops.$all) {
    const subFilter = ops.$all as Record<string, unknown>;
    if (relatedRecords.length === 0) return false;
    return relatedRecords.every((r) =>
      evaluateFilter(r, subFilter, relatedResource(r), schema, store),
    );
  }

  if (ops.$none) {
    const subFilter = ops.$none as Record<string, unknown>;
    if (relatedRecords.length === 0) return true;
    return !relatedRecords.some((r) =>
      evaluateFilter(r, subFilter, relatedResource(r), schema, store),
    );
  }

  return true;
}
