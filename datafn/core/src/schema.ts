/**
 * Schema Validation
 *
 * Validates and normalizes DataFn schemas according to SCHEMA-001.
 */

import type { DatafnSchema, DatafnResourceSchema } from "./types.js";
import type { DatafnEnvelope } from "./errors.js";
import { ok, err } from "./errors.js";

/**
 * Validates a schema and returns a normalized version.
 *
 * Normalization:
 * - Converts `indices: string[]` to `{ base: string[], search: [], vector: [] }`
 * - Ensures `relations` is present (defaults to [])
 *
 * Validation:
 * - `resources` must be present and be an array
 * - Each resource must have unique `name` and integer `version`
 * - Fields must have unique names within a resource
 */
export function validateSchema(schema: unknown): DatafnEnvelope<DatafnSchema> {
  // Check that schema is an object
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return err("SCHEMA_INVALID", "Invalid schema: expected object", {
      path: "$",
    });
  }

  const s = schema as Record<string, unknown>;

  // Check resources exists and is an array
  if (!s.resources || !Array.isArray(s.resources)) {
    return err("SCHEMA_INVALID", "Invalid schema: missing resources", {
      path: "resources",
    });
  }

  // LOW-028: Enforce resource count limit
  const MAX_RESOURCES = 100;
  if (s.resources.length > MAX_RESOURCES) {
    return err("SCHEMA_INVALID", `Invalid schema: too many resources (max ${MAX_RESOURCES})`, {
      path: "resources",
    });
  }

  const resourceNames = new Set<string>();
  const normalizedResources: DatafnResourceSchema[] = [];

  for (const resource of s.resources) {
    if (
      typeof resource !== "object" ||
      resource === null ||
      Array.isArray(resource)
    ) {
      return err("SCHEMA_INVALID", "Invalid schema: resource must be object", {
        path: "resources",
      });
    }

    const r = resource as Record<string, unknown>;

    // Validate name
    if (typeof r.name !== "string") {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: resource.name must be string",
        { path: "resources" }
      );
    }

    // Check for duplicate resource names
    if (resourceNames.has(r.name)) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: duplicate resource name: ${r.name}`,
        { path: "resources" }
      );
    }
    resourceNames.add(r.name);

    // Validate version
    if (typeof r.version !== "number" || !Number.isInteger(r.version)) {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: resource.version must be integer",
        { path: "resources" }
      );
    }

    // Validate fields
    if (!Array.isArray(r.fields)) {
      return err(
        "SCHEMA_INVALID",
        "Invalid schema: resource.fields must be array",
        { path: "resources" }
      );
    }

    // LOW-028: Enforce field count limit per resource
    const MAX_FIELDS_PER_RESOURCE = 200;
    if ((r.fields as unknown[]).length > MAX_FIELDS_PER_RESOURCE) {
      return err(
        "SCHEMA_INVALID",
        `Invalid schema: resource "${r.name}" has too many fields (max ${MAX_FIELDS_PER_RESOURCE})`,
        { path: `resources.${r.name}.fields` },
      );
    }

    const fieldNames = new Set<string>();
    for (const field of r.fields) {
      if (typeof field !== "object" || field === null || Array.isArray(field)) {
        return err("SCHEMA_INVALID", "Invalid schema: field must be object", {
          path: "resources",
        });
      }
      const f = field as Record<string, unknown>;
      if (typeof f.name !== "string") {
        return err(
          "SCHEMA_INVALID",
          "Invalid schema: field.name must be string",
          { path: "resources" }
        );
      }
      if (fieldNames.has(f.name)) {
        return err(
          "SCHEMA_INVALID",
          `Invalid schema: duplicate field name: ${f.name}`,
          { path: "resources" }
        );
      }
      fieldNames.add(f.name);
    }

    // Normalize indices
    let normalizedIndices: {
      base: string[];
      search: string[];
      vector: string[];
    };
    if (Array.isArray(r.indices)) {
      normalizedIndices = {
        base: r.indices as string[],
        search: [],
        vector: [],
      };
    } else if (r.indices && typeof r.indices === "object") {
      const idx = r.indices as Record<string, unknown>;
      normalizedIndices = {
        base: (idx.base as string[]) || [],
        search: (idx.search as string[]) || [],
        vector: (idx.vector as string[]) || [],
      };
    } else {
      normalizedIndices = { base: [], search: [], vector: [] };
    }

    // Validate index field names against declared fields
    for (const [category, idxFields] of Object.entries(normalizedIndices)) {
      for (const idxField of idxFields) {
        if (!fieldNames.has(idxField)) {
          return err(
            "SCHEMA_INVALID",
            `Invalid schema: index field "${idxField}" in indices.${category} does not match any field in resource "${r.name}". Available fields: ${[...fieldNames].join(", ")}`,
            { path: `resources.${r.name}.indices.${category}` }
          );
        }
      }
    }

    normalizedResources.push({
      ...r,
      indices: normalizedIndices,
    } as DatafnResourceSchema);
  }

  // Normalize relations (default to empty array)
  const relations = Array.isArray(s.relations) ? s.relations : [];

  // Validate relation fields
  for (const rel of relations) {
    if (typeof rel !== "object" || rel === null || Array.isArray(rel)) {
      return err("SCHEMA_INVALID", "Invalid schema: relation must be object", {
        path: "relations",
      });
    }
    const r = rel as Record<string, unknown>;

    // CLI-004: Validate that from/to reference declared resource names
    const validateRelationRef = (ref: unknown, side: "from" | "to") => {
      const refs = Array.isArray(ref) ? ref : (typeof ref === "string" ? [ref] : []);
      for (const name of refs) {
        if (typeof name === "string" && !resourceNames.has(name)) {
          return err(
            "SCHEMA_INVALID",
            `Invalid schema: relation.${side} references unknown resource "${name}". Available: ${[...resourceNames].join(", ")}`,
            { path: `relations.${side}` },
          );
        }
      }
      return null;
    };
    if (r.from !== undefined) {
      const e = validateRelationRef(r.from, "from");
      if (e) return e;
    }
    if (r.to !== undefined) {
      const e = validateRelationRef(r.to, "to");
      if (e) return e;
    }

    if (r.joinTable !== undefined && typeof r.joinTable !== "string") {
      return err("SCHEMA_INVALID", "Invalid schema: relation.joinTable must be string", {
        path: "relations",
      });
    }
    if (r.joinColumns !== undefined) {
      if (typeof r.joinColumns !== "object" || r.joinColumns === null || Array.isArray(r.joinColumns)) {
        return err("SCHEMA_INVALID", "Invalid schema: relation.joinColumns must be object with from/to strings", {
          path: "relations",
        });
      }
      const jc = r.joinColumns as Record<string, unknown>;
      if (typeof jc.from !== "string" || typeof jc.to !== "string") {
        return err("SCHEMA_INVALID", "Invalid schema: relation.joinColumns.from and .to must be strings", {
          path: "relations",
        });
      }
    }
  }

  // multiTenant defaults to true (namespace isolation is the safe default).
  // Only explicitly setting `multiTenant: false` disables it.
  const multiTenant = (s as any).multiTenant === false ? false : true;

  return ok({
    resources: normalizedResources,
    relations: relations as DatafnSchema["relations"],
    multiTenant,
  });
}
