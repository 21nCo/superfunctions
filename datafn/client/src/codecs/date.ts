/**
 * Date Codec (CODEC-001)
 *
 * Provides schema-driven date serialization and parsing:
 * - Outbound (mutation): Date objects → ISO 8601 strings (UTC)
 * - Inbound (query result): ISO strings → Date objects for schema date fields
 * - Deterministic error behavior for invalid dates
 */

import type { DatafnSchema } from "@datafn/core";

/**
 * Serialize Date fields in mutation records to ISO 8601 strings (CODEC-001 outbound)
 *
 * @param schema Schema definition
 * @param resource Resource name
 * @param record Record to serialize
 * @returns Serialized record with Date → ISO string
 * @throws DFQL_INVALID if a date field contains a non-Date value
 */
export function serializeDateFields(
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const resourceDef = schema.resources.find((r) => r.name === resource);
  if (!resourceDef || !resourceDef.fields) {
    return record;
  }

  const dateFields = resourceDef.fields.filter((f) => f.type === "date");
  if (dateFields.length === 0) {
    return record;
  }

  const serialized = { ...record };

  for (const field of dateFields) {
    const value = serialized[field.name];

    // Skip if field is not present
    if (value === undefined || value === null) {
      continue;
    }

    // Convert Date to ISO string
    if (value instanceof Date) {
      if (isNaN(value.getTime())) {
        throw {
          code: "DFQL_INVALID",
          message: "Invalid date value",
          details: { path: `record.${field.name}` },
        };
      }
      serialized[field.name] = value.toISOString();
    } else {
      // Non-Date value in a date field - deterministic rejection
      throw {
        code: "DFQL_INVALID",
        message: "Invalid date value: expected Date object",
        details: { path: `record.${field.name}` },
      };
    }
  }

  return serialized;
}

/**
 * Parse date fields in query results from ISO strings to Date objects (CODEC-001 inbound)
 *
 * @param schema Schema definition
 * @param resource Resource name
 * @param record Record to parse
 * @returns Parsed record with ISO string → Date
 * @throws DFQL_INVALID if a date field contains an invalid ISO string
 */
export function parseDateFields(
  schema: DatafnSchema,
  resource: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const resourceDef = schema.resources.find((r) => r.name === resource);
  if (!resourceDef || !resourceDef.fields) {
    return record;
  }

  const dateFields = resourceDef.fields.filter((f) => f.type === "date");
  if (dateFields.length === 0) {
    return record;
  }

  const parsed = { ...record };

  for (const field of dateFields) {
    const value = parsed[field.name];

    // Skip if field is not present
    if (value === undefined || value === null) {
      continue;
    }

    // Parse ISO string to Date
    if (typeof value === "string") {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        throw {
          code: "DFQL_INVALID",
          message: "Invalid date value",
          details: { path: `data[].${field.name}` },
        };
      }
      parsed[field.name] = date;
    } else if (value instanceof Date) {
      // Already a Date object (passthrough)
      if (isNaN(value.getTime())) {
        throw {
          code: "DFQL_INVALID",
          message: "Invalid date value",
          details: { path: `data[].${field.name}` },
        };
      }
      parsed[field.name] = value;
    } else {
      // Non-string, non-Date value - deterministic rejection
      throw {
        code: "DFQL_INVALID",
        message: "Invalid date value: expected ISO string or Date",
        details: { path: `data[].${field.name}` },
      };
    }
  }

  return parsed;
}

/**
 * Parse date fields in a query result payload
 * Handles both non-aggregate (data array) and aggregate (groups array) results
 *
 * @param schema Schema definition
 * @param resource Resource name
 * @param result Query result payload
 * @returns Result with parsed Date fields
 */
export function parseQueryResultDates(
  schema: DatafnSchema,
  resource: string,
  result: any,
): any {
  if (!result) {
    return result;
  }

  // Non-aggregate query: { data: [...], nextCursor? }
  if (Array.isArray(result.data)) {
    return {
      ...result,
      data: result.data.map((record: any) =>
        parseDateFields(schema, resource, record),
      ),
    };
  }

  // Aggregate query: { groups: [...], nextCursor? }
  // Note: aggregate results don't have record fields, so no date parsing needed
  // But for completeness, we handle this gracefully
  if (Array.isArray(result.groups)) {
    return result;
  }

  // Unknown result shape - passthrough
  return result;
}
