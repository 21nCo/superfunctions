/**
 * Diffing logic for DataFn schemas.
 */

import {
  type DatafnSchema,
  type DatafnRelationSchema,
  validateSchema,
  unwrapEnvelope,
} from "@datafn/core";
import type { MigrationPlan, MigrationChange, RelationType } from "./types.js";

/**
 * Compute the migration plan to transition 'from' schema to 'to' schema.
 */
export function diffSchemas(
  fromInput: unknown,
  toInput: unknown,
): MigrationPlan {
  // Validate both schemas deterministically via envelope
  const from = unwrapEnvelope(validateSchema(fromInput));
  const to = unwrapEnvelope(validateSchema(toInput));

  const changes: MigrationChange[] = [];

  // Sort resources for deterministic diff
  const fromResources = new Map(from.resources.map((r) => [r.name, r]));
  const toResources = new Map(to.resources.map((r) => [r.name, r]));

  // 1. Added/Removed Resources
  const allResourceNames = new Set([
    ...fromResources.keys(),
    ...toResources.keys(),
  ]);
  const sortedResourceNames = Array.from(allResourceNames).sort();

  for (const name of sortedResourceNames) {
    const fromRes = fromResources.get(name);
    const toRes = toResources.get(name);

    if (!fromRes && toRes) {
      changes.push({ kind: "addResource", resource: name });
      // Implicitly, all fields are added, but usually migration logic separates table creation from column addition
      // or treats table creation as including initial columns.
      // For simplicity in this phase (and as per standard patterns),
      // "addResource" implies creating the table.
      // However, if we want detailed "addField" ops, we could generate them.
      // But typically `CREATE TABLE` includes columns.
      // Wait, let's check Test Vector TV-MIG-001 expectation.
      // TV-MIG-001 shows `changes: [{ kind: "addField", ... }]` for a simple field addition.
      // If we add a whole table, the plan usually just says "addResource".
      // But we might need to know the initial schema of that resource.
      // Let's assume for now `diffSchemas` produces granular changes or robust `addResource` handled by renderer.
      // Actually, for `addField` to work, the resource must exist.
      // If `addResource` is emitted, the renderer needs to look up the definition in `to` schema.
    } else if (fromRes && !toRes) {
      changes.push({ kind: "removeResource", resource: name });
    } else if (fromRes && toRes) {
      // Shared resource: check fields
      const fromFields = new Map(fromRes.fields.map((f) => [f.name, f]));
      const toFields = new Map(toRes.fields.map((f) => [f.name, f]));

      const allFieldNames = new Set([...fromFields.keys(), ...toFields.keys()]);
      const sortedFieldNames = Array.from(allFieldNames).sort();

      for (const fieldName of sortedFieldNames) {
        const fromField = fromFields.get(fieldName);
        const toField = toFields.get(fieldName);

        if (!fromField && toField) {
          changes.push({
            kind: "addField",
            resource: name,
            field: fieldName,
            type: toField.type,
            required: toField.required,
          });
        } else if (fromField && !toField) {
          changes.push({
            kind: "removeField",
            resource: name,
            field: fieldName,
          });
        } else if (fromField && toField) {
          // Check for modifications
          const typeChanged = fromField.type !== toField.type;
          const requiredChanged = fromField.required !== toField.required;

          if (typeChanged || requiredChanged) {
            changes.push({
              kind: "alterField",
              resource: name,
              field: fieldName,
              changes: {
                ...(typeChanged ? { type: toField.type } : {}),
                ...(requiredChanged ? { required: toField.required } : {}),
              },
            });
          }
        }
      }

      // Index diffing for shared resources
      const fromIndices = normalizeIndices(fromRes.indices);
      const toIndices = normalizeIndices(toRes.indices);

      for (const indexType of ["base", "search", "vector"] as const) {
        const fromFields = fromIndices[indexType];
        const toFields = toIndices[indexType];

        const addedFields = toFields.filter((f) => !fromFields.includes(f));
        const removedFields = fromFields.filter((f) => !toFields.includes(f));

        for (const field of addedFields.sort()) {
          changes.push({
            kind: "addIndex",
            resource: name,
            indexType,
            fields: [field],
          });
        }

        for (const field of removedFields.sort()) {
          changes.push({
            kind: "removeIndex",
            resource: name,
            indexType,
            fields: [field],
          });
        }
      }
    }
  }

  // Relation diffing
  const fromRelations = from.relations ?? [];
  const toRelations = to.relations ?? [];

  const relationKey = (r: DatafnRelationSchema): string => {
    const fromStr = Array.isArray(r.from) ? r.from.sort().join(",") : r.from;
    const toStr = Array.isArray(r.to) ? r.to.sort().join(",") : r.to;
    return `${fromStr}:${toStr}:${r.relation || ""}`;
  };

  const fromRelationMap = new Map(fromRelations.map((r) => [relationKey(r), r]));
  const toRelationMap = new Map(toRelations.map((r) => [relationKey(r), r]));

  const allRelationKeys = new Set([
    ...fromRelationMap.keys(),
    ...toRelationMap.keys(),
  ]);
  const sortedRelationKeys = Array.from(allRelationKeys).sort();

  for (const key of sortedRelationKeys) {
    const fromRel = fromRelationMap.get(key);
    const toRel = toRelationMap.get(key);

    if (!fromRel && toRel) {
      const fromStr = Array.isArray(toRel.from) ? toRel.from[0] : toRel.from;
      const toStr = Array.isArray(toRel.to) ? toRel.to[0] : toRel.to;
      changes.push({
        kind: "addRelation",
        from: fromStr,
        to: toStr,
        type: mapRelationType(toRel.type),
        relation: toRel.relation,
        inverse: toRel.inverse,
        metadata: toRel.metadata
          ? Object.fromEntries(toRel.metadata.map((m) => [m.name, m.type]))
          : undefined,
      });
    } else if (fromRel && !toRel) {
      const fromStr = Array.isArray(fromRel.from)
        ? fromRel.from[0]
        : fromRel.from;
      const toStr = Array.isArray(fromRel.to) ? fromRel.to[0] : fromRel.to;
      changes.push({
        kind: "removeRelation",
        from: fromStr,
        to: toStr,
        relation: fromRel.relation || "",
      });
    }
  }

  return { changes };
}

function normalizeIndices(
  indices?: { base?: string[]; search?: string[]; vector?: string[] } | string[],
): { base: string[]; search: string[]; vector: string[] } {
  if (!indices) {
    return { base: [], search: [], vector: [] };
  }
  if (Array.isArray(indices)) {
    return { base: indices, search: [], vector: [] };
  }
  return {
    base: indices.base ?? [],
    search: indices.search ?? [],
    vector: indices.vector ?? [],
  };
}

function mapRelationType(
  type: DatafnRelationSchema["type"],
): RelationType {
  switch (type) {
    case "one-many":
      return "one-to-many";
    case "many-one":
      return "one-to-many";
    case "many-many":
      return "many-to-many";
    case "htree":
      return "one-to-many";
    default:
      return "one-to-many";
  }
}
