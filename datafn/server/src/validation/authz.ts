/**
 * Server-side authorization enforcement based on permissions policy.
 * Enforces read/write field policies and rejects unauthorized access with FORBIDDEN.
 */

import type { DatafnSchema, DatafnResourceSchema, DatafnPermissionsPolicy } from "@datafn/core";

/**
 * Error result for authorization failures
 */
export type AuthzError = {
  ok: false;
  code: "FORBIDDEN";
  message: string;
  path: string;
};

/**
 * Validate that a query adheres to read permissions policy
 */
export function validateQueryAuthz(
  query: Record<string, unknown>,
  schema: DatafnSchema,
): { ok: true } | AuthzError {
  const resource = schema.resources.find((r) => r.name === query.resource);
  if (!resource) {
    // Resource not found should be caught by schema validation first
    return { ok: true };
  }

  const policy = resource.permissions;
  if (!policy) {
    // No policy = no restrictions
    return { ok: true };
  }

  // Validate select fields
  if (query.select && Array.isArray(query.select)) {
    for (let i = 0; i < query.select.length; i++) {
      const token = query.select[i];
      if (typeof token !== "string") continue;

      // Parse token to extract field name (ignore relation directives like .*, .#)
      const parts = token.split(".");
      const baseName = parts[0];

      // Check if baseName is a field (not a relation)
      // Relations are allowed if the relation target also has appropriate permissions
      // For now, we focus on direct fields
      const isField = resource.fields.some((f) => f.name === baseName) || 
                      baseName === "id" || 
                      baseName === "createdAt" || 
                      baseName === "updatedAt" ||
                      baseName === "createdBy" ||
                      baseName === "updatedBy" ||
                      baseName === "isArchived";

      if (isField) {
        // Check read policy
        const readFields = policy.read?.fields || [];
        if (!readFields.includes(baseName)) {
          return {
            ok: false,
            code: "FORBIDDEN",
            message: "Authorization denied",
            path: `select[${i}]`,
          };
        }
      }
    }
  }

  // Validate filter fields
  if (query.filters && typeof query.filters === "object") {
    const filterFieldsResult = extractFieldsFromFilter(query.filters as Record<string, unknown>, resource, policy);
    if (!filterFieldsResult.ok) {
      return filterFieldsResult;
    }
  }

  return { ok: true };
}

/**
 * Extract and validate fields from a filter object
 */
function extractFieldsFromFilter(
  filter: Record<string, unknown>,
  resource: DatafnResourceSchema,
  policy: DatafnPermissionsPolicy,
): { ok: true } | AuthzError {
  const readFields = policy.read?.fields || [];

  for (const [key, value] of Object.entries(filter)) {
    // Skip logical operators
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        for (const subFilter of value) {
          if (typeof subFilter === "object" && subFilter !== null) {
            const result = extractFieldsFromFilter(subFilter as Record<string, unknown>, resource, policy);
            if (!result.ok) return result;
          }
        }
      }
      continue;
    }

    // Extract base field name (handle dot-paths like "goal.label")
    const parts = key.split(".");
    const baseField = parts[0];

    // Check if it's a direct field (not a relation)
    const isField = resource.fields.some((f) => f.name === baseField) ||
                    baseField === "id" ||
                    baseField === "createdAt" ||
                    baseField === "updatedAt" ||
                    baseField === "createdBy" ||
                    baseField === "updatedBy" ||
                    baseField === "isArchived";

    if (isField && !readFields.includes(baseField)) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "Authorization denied",
        path: `filters.${key}`,
      };
    }
  }

  return { ok: true };
}

/**
 * Validate that a mutation adheres to write permissions policy
 */
export function validateMutationAuthz(
  mutation: Record<string, unknown>,
  schema: DatafnSchema,
): { ok: true } | AuthzError {
  const resource = schema.resources.find((r) => r.name === mutation.resource);
  if (!resource) {
    // Resource not found should be caught by schema validation first
    return { ok: true };
  }

  const policy = resource.permissions;
  if (!policy) {
    // No policy = no restrictions
    return { ok: true };
  }

  const writeFields = policy.write?.fields || [];

  // Validate record fields for insert/merge/replace operations
  if (mutation.record && typeof mutation.record === "object") {
    const record = mutation.record as Record<string, unknown>;
    for (const fieldName of Object.keys(record)) {
      // id is a special case - always allowed for upsert/merge semantics
      if (fieldName === "id") continue;

      // Check write policy
      if (!writeFields.includes(fieldName)) {
        return {
          ok: false,
          code: "FORBIDDEN",
          message: "Authorization denied",
          path: `record.${fieldName}`,
        };
      }
    }
  }

  // Validate relation mutations
  // For relate/modifyRelation/unrelate, we need to check if relations are allowed
  // For now, relations are implicitly allowed if the operation is valid
  // A more sophisticated policy could restrict specific relation operations
  // This is marked as "minimal shape" in the spec, so we'll keep it simple

  return { ok: true };
}
