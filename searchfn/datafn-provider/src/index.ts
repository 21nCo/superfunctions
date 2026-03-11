import type { SearchAdapter } from "@searchfn/adapters";
import type { SearchProvider } from "@datafn/core";

export type { SearchProvider };

export interface CreateSearchProviderOptions {
  /**
   * Per-resource search field configuration.
   * Used to extract searchable fields from mutation records when calling updateIndices().
   * Keys are resource names; values are arrays of field names to index.
   *
   * @example
   * { tasks: ["title", "description"], notes: ["content"] }
   */
  resourceFields?: Record<string, string[]>;
}

class SearchProviderError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SearchProviderError";
    this.code = code;
  }
}

const FALLBACK_CONCURRENCY = 10;

/**
 * Creates a DataFn SearchProvider from any SearchAdapter.
 * The factory does NOT modify the adapter instance.
 */
export function createSearchProvider(
  adapter: SearchAdapter,
  options?: CreateSearchProviderOptions,
): SearchProvider {
  const resourceFields = options?.resourceFields ?? {};

  return {
    get name() {
      return adapter.name;
    },

    async search(params) {
      const request = params as any;
      const ids = await adapter.search({
        resource: request.resource,
        query: request.query,
        fields: request.fields,
        limit: request.limit ?? 50,
        signal: request.signal,
      } as any);
      return ids.map((id) => String(id));
    },

    async updateIndices({ resource, records, operation }) {
      if (operation === "delete") {
        await adapter.remove({
          resource,
          ids: records.map((r) => String(r.id)),
        });
      } else {
        const searchFieldNames = resourceFields[resource];
        const documents = records.map((r) => ({
          id: String(r.id),
          fields: extractFields(r, searchFieldNames),
        }));
        await adapter.index({ resource, documents });
      }
    },

    async searchAll(params) {
      const request = params as any;
      if (adapter.searchAll) {
        const results = await adapter.searchAll({
          query: request.query,
          resources: request.resources,
          fields: request.fields,
          limit: request.limit,
          limitPerResource: request.limitPerResource,
          signal: request.signal,
        } as any);
        return results.map((r) => ({
          resource: r.resource,
          id: String(r.id),
          score: r.score,
        }));
      }

      const resources = request.resources ?? Object.keys(resourceFields);
      if (resources.length === 0) {
        throw new SearchProviderError(
          "DFQL_INVALID",
          "resources are required when adapter.searchAll is unavailable",
        );
      }

      const limitPerResource = request.limitPerResource ?? 50;
      const allResults: Array<{ resource: string; id: string; score: number }> = [];

      for (let i = 0; i < resources.length; i += FALLBACK_CONCURRENCY) {
        const batch = resources.slice(i, i + FALLBACK_CONCURRENCY);
        const batchResults = await Promise.all(
          batch.map(async (resource: string) => {
            const ids = await adapter.search({
              resource,
              query: request.query,
              fields: request.fields,
              limit: limitPerResource,
              signal: request.signal,
            } as any);
            return ids.map((id, index) => ({
              resource,
              id: String(id),
              score: limitPerResource - index,
            }));
          }),
        );
        for (const results of batchResults) {
          allResults.push(...results);
        }
      }

      allResults.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.resource !== b.resource) return a.resource < b.resource ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });

      if (request.limit !== undefined) {
        return allResults.slice(0, request.limit);
      }
      return allResults;
    },

    async initialize(config) {
      if (adapter.initialize) {
        await adapter.initialize(config);
      }
    },

    async dispose() {
      if (adapter.dispose) {
        await adapter.dispose();
      }
    },
  };
}

function extractFields(
  record: Record<string, unknown>,
  fields?: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  const keys = fields ?? Object.keys(record).filter((k) => k !== "id");
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
    } else if (typeof value === "object") {
      result[key] = JSON.stringify(value);
    }
  }
  return result;
}
