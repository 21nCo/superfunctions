/**
 * Storage adapter integration: compfn schema + @superfunctions/db adapter.
 * Callers pass Adapter in CompFnConfig; this module provides schema and helpers for namespace.
 */

import type { Adapter, TableSchemaMap } from "@superfunctions/db";
import { getCompfnSchemaMap, type CompfnSchemaOptions } from "./schema.js";

export type { CompfnSchemaOptions } from "./schema.js";
export { getCompfnSchema, getCompfnSchemaMap } from "./schema.js";

/**
 * Get schema map for the given namespace (for createSchema / validateSchema with the db adapter).
 */
export function getSchemaForAdapter(options: CompfnSchemaOptions = {}): TableSchemaMap {
  return getCompfnSchemaMap(options);
}

/**
 * Create or migrate schema using the provided adapter.
 * Adapter must support createSchema (e.g. drizzle/kysely); memory adapter may only validate.
 */
export async function createSchemaIfSupported(
  database: Adapter,
  options: CompfnSchemaOptions = {}
): Promise<{ success: boolean; errors?: string[] }> {
  const schema = getCompfnSchemaMap(options);
  const namespace = options.namespace ?? "compfn";

  if (typeof database.createSchema !== "function") {
    // Validate each table instead
    const tables = Object.values(schema);
    for (const table of tables) {
      const result = await database.validateSchema(table);
      if (!result.valid && result.errors?.length) {
        return { success: false, errors: result.errors };
      }
    }
    return { success: true };
  }

  const result = await database.createSchema({ schema, namespace });
  return {
    success: result.success,
    errors: result.errors,
  };
}
