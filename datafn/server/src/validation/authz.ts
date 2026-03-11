/**
 * Server-side authorization enforcement based on permissions policy.
 * Enforces read/write field policies and rejects unauthorized access with FORBIDDEN.
 */

import type { DatafnSchema, DatafnResourceSchema, DatafnPermissionsPolicy } from "../core-types.js";
import type { Adapter } from "@superfunctions/db";
import { resolveCapabilities, getCapabilityFields } from "@datafn/core";

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
 * Options for authorization validation
 */
export type AuthzOptions = {
  /** VAL-001: Allow queries/mutations on resources with no policy. Default: false (deny-by-default). */
  allowUnknownResources?: boolean;
  /** VAL-009: Debug mode — when false, strip field/schema details from error messages. Default: true. */
  debug?: boolean;
};

function getCapabilityFieldSets(
  schema: DatafnSchema,
  resource: DatafnResourceSchema,
): {
  capabilityFields: Set<string>;
  readonlyCapabilityFields: Set<string>;
} {
  const resolvedCapabilities = resolveCapabilities(
    schema.capabilities as any,
    resource.capabilities as any,
  );
  const capabilityFieldDefs = getCapabilityFields(resolvedCapabilities as any);
  const capabilityFields = new Set<string>();
  const readonlyCapabilityFields = new Set<string>();

  for (const fieldDef of capabilityFieldDefs) {
    capabilityFields.add(fieldDef.name);
    if (fieldDef.readonly) {
      readonlyCapabilityFields.add(fieldDef.name);
    }
  }

  return { capabilityFields, readonlyCapabilityFields };
}

/**
 * Validate that a query adheres to read permissions policy
 */
export function validateQueryAuthz(
  query: Record<string, unknown>,
  schema: DatafnSchema,
  opts?: AuthzOptions,
): { ok: true } | AuthzError {
  const resource = schema.resources.find((r) => r.name === query.resource);
  if (!resource) {
    // Resource not found should be caught by schema validation first
    return { ok: true };
  }

  const policy = resource.permissions;
  if (!policy) {
    // VAL-001: Deny-by-default — resources without a policy are FORBIDDEN unless escape hatch enabled
    if (!opts?.allowUnknownResources) {
      const message = opts?.debug === false
        ? "Authorization denied"
        : `No authorization policy found for resource '${query.resource}'. Define a policy or use allowUnknownResources: true to allow.`;
      return {
        ok: false,
        code: "FORBIDDEN",
        message,
        path: "resource",
      };
    }
    return { ok: true };
  }

  const { capabilityFields } = getCapabilityFieldSets(schema, resource);

  // Validate select fields
  if (query.select && Array.isArray(query.select)) {
    for (let i = 0; i < query.select.length; i++) {
      const token = query.select[i];
      if (typeof token !== "string") continue;

      // Parse token to extract field name (ignore relation directives like .*, .#)
      const parts = token.split(".");
      const baseName = parts[0];

      // id and capability-managed fields are always readable
      if (baseName === "id") continue;
      if (capabilityFields.has(baseName)) continue;

      // Check if baseName is a field (not a relation)
      const isField = resource.fields.some((f) => f.name === baseName) ||
                      capabilityFields.has(baseName);

      if (isField) {
        // Check read policy for non-capability fields
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
    const filterFieldsResult = extractFieldsFromFilter(
      query.filters as Record<string, unknown>,
      resource,
      policy,
      capabilityFields,
    );
    if (!filterFieldsResult.ok) {
      return filterFieldsResult;
    }
  }

  const readFields = policy.read?.fields || [];

  // SEC-003: Validate aggregation fields
  if (query.aggregations && typeof query.aggregations === "object" && !Array.isArray(query.aggregations)) {
    const aggs = query.aggregations as Record<string, Record<string, unknown>>;
    for (const [alias, def] of Object.entries(aggs)) {
      if (typeof def === "object" && def !== null && typeof def.field === "string") {
        const field = def.field;
        if (field === "*" || field === "id") continue;
        if (!capabilityFields.has(field) && !readFields.includes(field)) {
          return {
            ok: false,
            code: "FORBIDDEN",
            message: "Authorization denied",
            path: `aggregations.${alias}.field`,
          };
        }
      }
    }
  }

  // SEC-003: Validate groupBy fields
  if (query.groupBy && Array.isArray(query.groupBy)) {
    for (let i = 0; i < query.groupBy.length; i++) {
      const field = query.groupBy[i];
      if (typeof field !== "string") continue;
      if (field === "id" || capabilityFields.has(field)) continue;
      if (!readFields.includes(field)) {
        return {
          ok: false,
          code: "FORBIDDEN",
          message: "Authorization denied",
          path: `groupBy[${i}]`,
        };
      }
    }
  }

  // SEC-003: Validate having clause (recursive field extraction)
  if (query.having && typeof query.having === "object" && !Array.isArray(query.having)) {
    const havingResult = extractFieldsFromFilter(
      query.having as Record<string, unknown>,
      resource,
      policy,
      capabilityFields,
    );
    if (!havingResult.ok) {
      return { ...havingResult, path: `having.${havingResult.path.replace(/^filters\./, "")}` };
    }
  }

  // SEC-003: Validate sort fields
  if (query.sort && Array.isArray(query.sort)) {
    for (let i = 0; i < query.sort.length; i++) {
      const sortItem = query.sort[i];
      if (typeof sortItem !== "string") continue;
      // Parse: "field", "field:asc", "field:desc", "-field"
      const parts = sortItem.split(":");
      const rawField = parts[0];
      const field = rawField.startsWith("-") ? rawField.slice(1) : rawField;
      if (field === "id" || capabilityFields.has(field)) continue;
      // Allow sorting by aggregation aliases
      if (query.aggregations && typeof query.aggregations === "object" && field in (query.aggregations as object)) {
        continue;
      }
      const isField = resource.fields.some((f) => f.name === field) ||
                      capabilityFields.has(field);
      if (isField && !readFields.includes(field)) {
        return {
          ok: false,
          code: "FORBIDDEN",
          message: "Authorization denied",
          path: `sort[${i}]`,
        };
      }
    }
  }

  // SEC-003: Validate search.fields
  if (query.search && typeof query.search === "object" && !Array.isArray(query.search)) {
    const search = query.search as Record<string, unknown>;
    if (search.fields && Array.isArray(search.fields)) {
      for (let i = 0; i < search.fields.length; i++) {
        const field = search.fields[i];
        if (typeof field !== "string") continue;
        if (field === "id" || capabilityFields.has(field)) continue;
        if (!readFields.includes(field)) {
          return {
            ok: false,
            code: "FORBIDDEN",
            message: "Authorization denied",
            path: `search.fields[${i}]`,
          };
        }
      }
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
  capabilityFields: Set<string>,
): { ok: true } | AuthzError {
  const readFields = policy.read?.fields || [];

  for (const [key, value] of Object.entries(filter)) {
    // Skip logical operators
    if (key === "$and" || key === "$or") {
      if (Array.isArray(value)) {
        for (const subFilter of value) {
          if (typeof subFilter === "object" && subFilter !== null) {
            const result = extractFieldsFromFilter(
              subFilter as Record<string, unknown>,
              resource,
              policy,
              capabilityFields,
            );
            if (!result.ok) return result;
          }
        }
      }
      continue;
    }

    // Extract base field name (handle dot-paths like "goal.label")
    const parts = key.split(".");
    const baseField = parts[0];

    // id and capability-managed fields are always allowed for filtering
    if (baseField === "id") continue;
    if (capabilityFields.has(baseField)) continue;

    // Check if it's a direct field (not a relation)
    const isField = resource.fields.some((f) => f.name === baseField) ||
                    capabilityFields.has(baseField);

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
  opts?: AuthzOptions,
): { ok: true } | AuthzError {
  const resource = schema.resources.find((r) => r.name === mutation.resource);
  if (!resource) {
    // Resource not found should be caught by schema validation first
    return { ok: true };
  }

  const policy = resource.permissions;
  if (!policy) {
    // VAL-001: Deny-by-default — resources without a policy are FORBIDDEN unless escape hatch enabled
    if (!opts?.allowUnknownResources) {
      const message = opts?.debug === false
        ? "Authorization denied"
        : `No authorization policy found for resource '${mutation.resource}'. Define a policy or use allowUnknownResources: true to allow.`;
      return {
        ok: false,
        code: "FORBIDDEN",
        message,
        path: "resource",
      };
    }
    return { ok: true };
  }

  const { readonlyCapabilityFields } = getCapabilityFieldSets(schema, resource);

  const writeFields = policy.write?.fields || [];

  // Validate record fields for insert/merge/replace operations
  if (mutation.record && typeof mutation.record === "object") {
    const record = mutation.record as Record<string, unknown>;
    for (const fieldName of Object.keys(record)) {
      // id is a special case - always allowed for upsert/merge semantics
      if (fieldName === "id") continue;
      // readonly capability fields are excluded from write policy checks
      if (readonlyCapabilityFields.has(fieldName)) continue;

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

  // SEC-009: Validate relation mutations for relate/modifyRelation/unrelate
  const op = mutation.operation as string;
  if (op === "relate" || op === "modifyRelation" || op === "unrelate") {
    const relationAuthzResult = validateRelationAuthz(mutation, resource, writeFields);
    if (!relationAuthzResult.ok) {
      return relationAuthzResult;
    }
  }

  return { ok: true };
}

/**
 * Validate relation operation against write fields policy (SEC-009)
 * The "field" for relation authz is the FK field or relation name.
 */
export function validateRelationAuthz(
  mutation: Record<string, unknown>,
  resource: { fields: Array<{ name: string }>; name?: string },
  writeFields: string[],
): { ok: true } | AuthzError {
  // The relation field name can be: mutation.relation (relation name) or mutation.fkField
  const relation = mutation.relation as string | undefined;

  if (!relation) {
    // No relation name to check — cannot validate, allow by default
    return { ok: true };
  }

  // Check if the relation name is in the write fields policy
  if (!writeFields.includes(relation)) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Authorization denied",
      path: `relation`,
    };
  }

  return { ok: true };
}

export type ShareAccessLevel = "viewer" | "editor" | "owner";

function getPermissionsTable(resource: string): string {
  return `__datafn_permissions_${resource}`;
}

function getShareableCapability(resource: DatafnResourceSchema, schema: DatafnSchema):
  | { shareable: { levels: string[]; default: "private" | "shared" } }
  | undefined {
  const resolved = resolveCapabilities(schema.capabilities as any, resource.capabilities as any);
  return resolved.find(
    (entry: unknown): entry is { shareable: { levels: string[]; default: "private" | "shared" } } =>
      typeof entry === "object" &&
      entry !== null &&
      "shareable" in (entry as Record<string, unknown>),
  );
}

export function isPrivateShareableResource(
  schema: DatafnSchema,
  resourceName: string,
): boolean {
  const resource = schema.resources.find((r) => r.name === resourceName);
  if (!resource) return false;
  const capability = getShareableCapability(resource, schema);
  return capability?.shareable.default === "private";
}

export async function resolveAccessLevel(
  db: Adapter,
  schema: DatafnSchema,
  resource: string,
  recordId: string,
  actorId: string | undefined,
  namespace: string,
): Promise<ShareAccessLevel | null> {
  if (!actorId) {
    return null;
  }

  const resourceSchema = schema.resources.find((r) => r.name === resource);
  if (!resourceSchema) {
    return null;
  }

  const shareable = getShareableCapability(resourceSchema, schema);
  if (!shareable) {
    return null;
  }

  const record = await db.findOne({
    model: resource,
    where: [{ field: "id", operator: "eq", value: recordId }],
    namespace,
  });
  if (!record) {
    return null;
  }

  if ((record as Record<string, unknown>).createdBy === actorId) {
    return "owner";
  }

  const permissionId = `${recordId}:${actorId}`;
  const permission = await db.findOne({
    model: getPermissionsTable(resource),
    where: [{ field: "id", operator: "eq", value: permissionId }],
    namespace,
  });
  if (!permission) {
    return null;
  }

  const level = (permission as Record<string, unknown>).level;
  if (level === "viewer" || level === "editor" || level === "owner") {
    return level;
  }
  return null;
}
