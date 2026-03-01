/**
 * Soft-Delete Plugin (SD-001)
 * 
 * Converts delete mutations to merge operations with isDeleted/deletedAt fields,
 * and auto-filters soft-deleted records from queries.
 */

import type { DatafnPlugin, DatafnHookContext } from "@datafn/core";

export interface SoftDeleteConfig {
  /**
   * Resources that use soft-delete
   */
  resources: string[];
  
  /**
   * Field name for deletion timestamp
   * Default: "deletedAt"
   */
  deletedAtField?: string;
  
  /**
   * Field name for deletion flag
   * Default: "isDeleted"
   */
  isDeletedField?: string;

  /**
   * LOW-029: Optional timestamp factory. Defaults to `() => new Date()`.
   * Override for testability (deterministic timestamps in tests) or to use
   * a server-authoritative clock instead of the local device clock.
   */
  getTimestamp?: () => Date;
}

/**
 * Create a soft-delete plugin
 * 
 * @param config - Soft-delete configuration
 * @returns DatafnPlugin instance
 */
export function createSoftDeletePlugin(config: SoftDeleteConfig): DatafnPlugin {
  const deletedAtField = config.deletedAtField ?? "deletedAt";
  const isDeletedField = config.isDeletedField ?? "isDeleted";
  const resourceSet = new Set(config.resources);
  // LOW-029: Use configurable timestamp factory for testability
  const getTimestamp = config.getTimestamp ?? (() => new Date());

  return {
    name: "soft-delete",
    runsOn: ["client"],

    /**
     * beforeMutation hook: Convert delete to merge for configured resources
     */
    beforeMutation(ctx: DatafnHookContext, m: unknown | unknown[]) {
      // Handle batch mutations
      if (Array.isArray(m)) {
        return m.map((mutation) => transformMutation(mutation));
      }
      
      // Handle single mutation
      return transformMutation(m);
    },

    /**
     * beforeQuery hook: Auto-filter soft-deleted records for configured resources
     */
    beforeQuery(ctx: DatafnHookContext, q: unknown) {
      // Handle batch queries
      if (Array.isArray(q)) {
        return q.map((query) => transformQuery(query));
      }
      
      // Handle single query
      return transformQuery(q);
    },
  };

  /**
   * Transform a mutation: convert delete to merge for configured resources
   */
  function transformMutation(mutation: unknown): unknown {
    if (!mutation || typeof mutation !== "object") {
      return mutation;
    }

    const m = mutation as Record<string, unknown>;
    const resource = m.resource as string | undefined;
    const operation = m.operation as string | undefined;

    // Only transform delete operations on configured resources
    if (operation !== "delete" || !resource || !resourceSet.has(resource)) {
      return mutation;
    }

    // Convert delete to merge with soft-delete fields
    return {
      ...m,
      operation: "merge",
      record: {
        [isDeletedField]: true,
        [deletedAtField]: getTimestamp(),
      },
    };
  }

  /**
   * Transform a query: auto-filter soft-deleted records for configured resources
   */
  function transformQuery(query: unknown): unknown {
    if (!query || typeof query !== "object") {
      return query;
    }

    const q = query as Record<string, unknown>;
    const resource = q.resource as string | undefined;

    // Only transform queries on configured resources
    if (!resource || !resourceSet.has(resource)) {
      return query;
    }

    // Check if query has includeDeleted metadata (skip filter injection if true)
    const metadata = q.metadata as Record<string, unknown> | undefined;
    if (metadata && metadata.includeDeleted === true) {
      return query;
    }

    // Get existing filters
    const existingFilters = q.filters as Record<string, unknown> | undefined;

    // Create soft-delete filter
    const softDeleteFilter = {
      [isDeletedField]: { $ne: true },
    };

    // Merge with existing filters using $and if filters exist
    let newFilters: Record<string, unknown>;
    if (existingFilters && Object.keys(existingFilters).length > 0) {
      // If there's already an $and, extend it
      if (existingFilters.$and && Array.isArray(existingFilters.$and)) {
        newFilters = {
          ...existingFilters,
          $and: [...existingFilters.$and, softDeleteFilter],
        };
      } else {
        // Wrap existing filters and soft-delete filter in $and
        newFilters = {
          $and: [existingFilters, softDeleteFilter],
        };
      }
    } else {
      // No existing filters, just use soft-delete filter
      newFilters = softDeleteFilter;
    }

    return {
      ...q,
      filters: newFilters,
    };
  }
}

/**
 * Restore a soft-deleted record
 * 
 * Convenience utility that clears isDeleted and deletedAt fields
 * 
 * @param table - Table instance with mutate method
 * @param id - Record ID to restore
 * @param config - Soft-delete config (optional field names)
 * @returns Promise resolving to mutation result
 */
export async function restore(
  table: { mutate: (m: any) => Promise<unknown> },
  id: string,
  config?: Pick<SoftDeleteConfig, "deletedAtField" | "isDeletedField">,
): Promise<unknown> {
  const deletedAtField = config?.deletedAtField ?? "deletedAt";
  const isDeletedField = config?.isDeletedField ?? "isDeleted";

  return table.mutate({
    operation: "merge",
    id,
    record: {
      [isDeletedField]: false,
      [deletedAtField]: null,
    },
  });
}
