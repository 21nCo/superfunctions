/**
 * Client-Side Search Plugin (SRCH-001)
 * 
 * Provides offline full-text search via a client-side search plugin using MiniSearch.
 * Builds search indices from schema `indices.search` fields at clone/pull time,
 * updates indices on local mutations, and routes queries with `search` field to local index.
 */

import type { DatafnPlugin, DatafnHookContext, DatafnSchema } from "@datafn/core";
import type { DatafnStorageAdapter } from "../storage.js";
import MiniSearch from "minisearch";

export interface ClientSearchConfig {
  /**
   * Optional field-specific boost weights for search relevance.
   * Higher boost values give more weight to matches in those fields.
   * Example: { title: 2, description: 1 }
   */
  boost?: Record<string, number>;
  
  /**
   * Optional storage adapter (if not provided via context)
   */
  storage?: DatafnStorageAdapter;
}

interface SearchIndexEntry {
  index: MiniSearch;
  fields: string[];
}

/**
 * Create a client-side search plugin
 * 
 * @param options - Search configuration
 * @returns DatafnPlugin instance
 */
export function createClientSearchPlugin(options?: ClientSearchConfig): DatafnPlugin {
  const indices = new Map<string, SearchIndexEntry>();
  const boost = options?.boost;
  let storage: DatafnStorageAdapter | undefined = options?.storage;

  return {
    name: "client-search",
    runsOn: ["client"],

    /**
     * afterSync hook: Rebuild indices after clone/pull
     */
    async afterSync(ctx: DatafnHookContext, phase: string, payload: unknown, result: unknown) {
      // Store storage adapter from context if available
      const ctxStorage = (payload as any)?.storage as DatafnStorageAdapter | undefined;
      if (ctxStorage) {
        storage = ctxStorage;
      }

      // Rebuild indices after clone or pull
      if (phase === "clone" || phase === "pull") {
        if (!storage) {
          console.warn("[client-search] No storage adapter available, skipping index rebuild");
          return;
        }
        await rebuildIndices(ctx.schema, storage, indices, boost);
      }
    },

    /**
     * afterMutation hook: Update indices on local mutations
     */
    async afterMutation(ctx: DatafnHookContext, m: unknown | unknown[], result: unknown) {
      if (!storage) {
        return;
      }

      // Handle batch mutations
      if (Array.isArray(m)) {
        for (const mutation of m) {
          await updateIndex(indices, mutation, storage);
        }
        return;
      }

      // Handle single mutation
      await updateIndex(indices, m, storage);
    },

    /**
     * beforeQuery hook: Route search queries to local index when hydrated
     */
    async beforeQuery(ctx: DatafnHookContext, q: unknown) {
      // Handle batch queries - pass through
      if (Array.isArray(q)) {
        return q;
      }

      const query = q as Record<string, unknown>;
      const resource = query.resource as string | undefined;
      const searchTerm = query.search as string | undefined;

      // Only transform queries with search field
      if (!searchTerm || !resource) {
        return query;
      }

      // Check if we have an index for this resource
      const indexEntry = indices.get(resource);
      if (!indexEntry) {
        // No index available, let query fall through to remote
        return query;
      }

      // Check hydration state - only use local index if hydrated
      if (storage) {
        const hydrationState = await storage.getHydrationState(resource);
        if (hydrationState !== "ready") {
          // Not hydrated, fall back to remote
          return query;
        }
      }

      // Execute search on local index
      try {
        // Build search options
        const searchOptions: any = {
          fuzzy: 0.2, // Allow fuzzy matching with 20% tolerance
          prefix: true, // Enable prefix matching for partial words
        };
        
        // Add boost if configured
        if (boost) {
          searchOptions.boost = boost;
        }
        
        const searchResults = indexEntry.index.search(searchTerm, searchOptions);

        // Extract IDs from search results
        const candidateIds = searchResults.map((r) => r.id as string);

        // Inject candidate IDs into query for filtering
        // This is a private field used by query execution to filter results
        return {
          ...query,
          _searchCandidateIds: candidateIds,
        };
      } catch (error) {
        console.error("[client-search] Search failed:", error);
        // On error, fall back to remote
        return query;
      }
    },
  };
}

/**
 * Rebuild all search indices from storage
 */
async function rebuildIndices(
  schema: DatafnSchema,
  storage: DatafnStorageAdapter,
  indices: Map<string, SearchIndexEntry>,
  boost?: Record<string, number>,
): Promise<void> {
  // Clear existing indices
  indices.clear();

  // Build index for each resource with indices.search defined
  for (const resource of schema.resources) {
    const searchFields = getSearchFields(resource);
    if (!searchFields || searchFields.length === 0) {
      continue;
    }

    try {
      // Create MiniSearch index
      const index = new MiniSearch({
        fields: searchFields,
        storeFields: [], // Don't store full documents, just IDs
      });

      // Load all records from storage
      const records = await storage.listRecords(resource.name);

      // Index each record
      for (const record of records) {
        const doc = buildSearchDocument(record, searchFields);
        if (doc) {
          index.add(doc);
        }
      }

      // Store index
      indices.set(resource.name, {
        index,
        fields: searchFields,
      });

      console.log(
        `[client-search] Built index for ${resource.name}: ${records.length} documents, ${searchFields.length} fields`,
      );
    } catch (error) {
      console.error(`[client-search] Failed to build index for ${resource.name}:`, error);
    }
  }
}

/**
 * Update search index on mutation
 */
async function updateIndex(
  indices: Map<string, SearchIndexEntry>,
  mutation: unknown,
  storage: DatafnStorageAdapter,
): Promise<void> {
  if (!mutation || typeof mutation !== "object") {
    return;
  }

  const m = mutation as Record<string, unknown>;
  const resource = m.resource as string | undefined;
  const operation = m.operation as string | undefined;
  const id = m.id as string | undefined;

  if (!resource || !id) {
    return;
  }

  const indexEntry = indices.get(resource);
  if (!indexEntry) {
    // No index for this resource
    return;
  }

  try {
    switch (operation) {
      case "insert":
      case "merge":
      case "replace": {
        // Fetch updated record from storage
        const record = await storage.getRecord(resource, id);
        if (!record) {
          // Record was deleted or doesn't exist
          if (indexEntry.index.has(id)) {
            indexEntry.index.remove(id);
          }
          return;
        }

        // Build search document
        const doc = buildSearchDocument(record, indexEntry.fields);
        if (!doc) {
          return;
        }

        // Remove old version if exists
        try {
          if (indexEntry.index.has(id)) {
            indexEntry.index.remove(id);
          }
        } catch (e) {
          // Record might not exist in index yet, that's OK
        }

        // Add new version
        indexEntry.index.add(doc);
        break;
      }

      case "delete": {
        // Remove from index
        try {
          indexEntry.index.discard(id);
        } catch (e) {
          // Record might not exist in index, that's OK
        }
        break;
      }

      default:
        // Unknown operation, ignore
        break;
    }
  } catch (error) {
    console.error(`[client-search] Failed to update index for ${resource}:`, error);
  }
}

/**
 * Extract search fields from resource schema
 */
function getSearchFields(resource: Record<string, unknown>): string[] | null {
  const indices = resource.indices;
  if (!indices) {
    return null;
  }

  // Handle object format: { search: [...] }
  if (typeof indices === "object" && !Array.isArray(indices)) {
    const search = (indices as Record<string, unknown>).search;
    if (Array.isArray(search)) {
      return search as string[];
    }
    return null;
  }

  // Handle legacy array format (treated as base indices, not search)
  return null;
}

/**
 * Build a search document from a record
 */
function buildSearchDocument(
  record: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> | null {
  const id = record.id as string | undefined;
  if (!id) {
    return null;
  }

  const doc: Record<string, unknown> = { id };

  // Extract searchable fields
  for (const field of fields) {
    const value = record[field];
    if (value !== undefined && value !== null) {
      // Convert to string for indexing
      if (typeof value === "string") {
        doc[field] = value;
      } else if (typeof value === "number" || typeof value === "boolean") {
        doc[field] = String(value);
      } else if (typeof value === "object") {
        // For objects/arrays, stringify for search
        doc[field] = JSON.stringify(value);
      }
    }
  }

  return doc;
}
