/**
 * DataFn Table Handle
 *
 * Represents a table/resource from the schema with methods for query, mutation, signals, and subscriptions.
 */

import type {
  DatafnSchema,
  DatafnSignal,
  DfqlQueryFragment,
  DfqlMutationFragment,
  DfqlTransact,
} from "@datafn/core";
import { resolveCapabilities } from "@datafn/core";
import { createClientError } from "../errors.js";
import type { EventHandler } from "../events/bus.js";
import type { EventFilter } from "../events/filter.js";
import type { SignalRegistry } from "../signals/querySignal.js";
import {
  buildTableOperationMutation,
  buildShareMutation,
  buildUnshareMutation,
  type TableOperation,
} from "../mutate.js";
import {
  buildGetPermissionsQuery,
  type PermissionEntry,
} from "../query.js";

type QueryMetadata = {
  includeTrashed?: boolean;
  includeArchived?: boolean;
};

export interface DatafnTable<
  S extends DatafnSchema = DatafnSchema,
  Name extends string = string,
  TRecord = unknown,
> {
  name: Name;
  version: number;

  query(q: DfqlQueryFragment & { metadata?: QueryMetadata }): Promise<unknown>;
  mutate(m: DfqlMutationFragment | DfqlMutationFragment[]): Promise<unknown>;
  delete(id: string): Promise<unknown>;
  trash?: (id: string) => Promise<unknown>;
  restore?: (id: string) => Promise<unknown>;
  archive?: (id: string) => Promise<unknown>;
  unarchive?: (id: string) => Promise<unknown>;
  share?: (id: string, userId: string, level: string) => Promise<unknown>;
  unshare?: (id: string, userId: string) => Promise<unknown>;
  getPermissions?: (id: string) => Promise<PermissionEntry[]>;
  transact(payload: DfqlTransact): Promise<unknown>;
  signal(q: DfqlQueryFragment, options?: { disableOptimistic?: boolean }): DatafnSignal<unknown>;
  subscribe(handler: EventHandler, filter?: EventFilter): () => void;
}

// Forward declaration for client interface
interface ClientWithQuery {
  query(q: unknown | unknown[]): Promise<unknown>;
  mutate(m: unknown | unknown[]): Promise<unknown>;
  transact(payload: unknown): Promise<unknown>;
  subscribe(handler: EventHandler, filter?: EventFilter): () => void;
}

/**
 * Create a table handle (internal factory)
 */
export function createTable<S extends DatafnSchema>(
  name: string,
  version: number,
  client: ClientWithQuery,
  signalRegistry: SignalRegistry,
  generateId: (params: { resource: string; idPrefix?: string }) => string,
  schema: S,
): DatafnTable<S, string> {
  const resource = schema.resources.find((r) => r.name === name);
  const resolvedCapabilities = resource
    ? resolveCapabilities(
        schema.capabilities as any,
        resource.capabilities as any,
      )
    : [];

  const executeOperation = async (
    operation: TableOperation,
    id: string,
  ): Promise<unknown> =>
    client.mutate(buildTableOperationMutation(name, version, operation, id));

  const table: DatafnTable<S, string> = {
    name,
    version,

    /**
     * Execute a query with resource/version merged (CLIENT-QUERY-001)
     */
    async query(
      q: DfqlQueryFragment & { metadata?: QueryMetadata },
    ): Promise<unknown> {
      // Merge query fragment with table resource/version
      const fragment = (typeof q === "object" && q !== null ? q : {}) as Record<
        string,
        unknown
      >;

      // Remove resource/version from fragment if present (table is authoritative)
      const { resource: _r, version: _v, ...rest } = fragment;

      // Build full query
      const fullQuery = {
        resource: name,
        version,
        ...rest,
      };

      // Delegate to client.query and return single result
      return client.query(fullQuery);
    },

    /**
     * Execute a mutation with resource/version merged (CLIENT-MUT-001)
     */
    async mutate(
      m: DfqlMutationFragment | DfqlMutationFragment[],
    ): Promise<unknown> {
      // Normalize to array for processing if needed, but here we just pass through
      // Since executeMutation handles single or array, we just need to preserve that structure
      // But we need to inject resource/version into each item if it's an array, or the item itself

      const mutations = Array.isArray(m) ? m : [m];

      const fullMutations = mutations.map((fragment) => {
        const {
          resource: _r,
          version: _v,
          ...rest
        } = fragment as Record<string, unknown>;
        const mutation = {
          resource: name,
          version,
          ...rest,
        } as Record<string, unknown>;

        // Auto-generate ID for insert operations if not provided (API-001)
        if (mutation.operation === "insert" && !mutation.id) {
          // Find resource in schema to get idPrefix
          const resource = schema.resources.find((r) => r.name === name);
          const idPrefix = resource?.idPrefix;

          // Generate ID with resource and idPrefix
          const generatedId = generateId({ resource: name, idPrefix });

          // Validate prefix (API-001)
          const expectedPrefix = idPrefix || name;
          if (!generatedId.startsWith(`${expectedPrefix}:`)) {
            throw createClientError(
              "DFQL_INVALID",
              "Invalid id: does not match required prefix",
              { path: "id" },
            );
          }

          mutation.id = generatedId;
        }

        return mutation;
      });

      // Delegate to client.mutate and return single result (or array if input was array)
      const result = await client.mutate(
        Array.isArray(m) ? fullMutations : fullMutations[0],
      );
      return result;
    },

    async delete(id: string): Promise<unknown> {
      return executeOperation("delete", id);
    },

    /**
     * Execute a transaction (CLIENT-TX-001)
     */
    async transact(payload: DfqlTransact): Promise<unknown> {
      // Delegate directly to client.transact without modification
      // Note: client.transact expects unknown but at runtime/logic level it handles it.
      // Ideally client.transact should also be typed; cast here to keep table API ergonomic.
      return client.transact(payload as any);
    },

    /**
     * Create reactive query signal (CLIENT-SIGNAL-001, SIG-003)
     */
    signal(q: DfqlQueryFragment, options?: { disableOptimistic?: boolean }): DatafnSignal<unknown> {
      // Merge query fragment with table resource/version
      const fragment = (typeof q === "object" && q !== null ? q : {}) as Record<
        string,
        unknown
      >;

      // Remove resource/version from fragment if present (table is authoritative)
      const { resource: _r, version: _v, ...rest } = fragment;

      // Build full query
      const fullQuery = {
        resource: name,
        version,
        ...rest,
      };

      // Get or create signal from registry (ensures caching by dfqlKey)
      return signalRegistry.getSignal(fullQuery, options);
    },

    /**
     * Subscribe to events for this table's resource (CLIENT-SUB-001)
     */
    subscribe(handler: EventHandler, filter?: EventFilter): () => void {
      // Inject resource filter (table is authoritative)
      const tableFilter: EventFilter = {
        ...filter,
        resource: name, // Always use table's resource, ignore user-provided
      };

      return client.subscribe(handler, tableFilter);
    },
  };

  if (resolvedCapabilities.some((capability) => capability === "trash")) {
    table.trash = async (id: string): Promise<unknown> =>
      executeOperation("trash", id);
    table.restore = async (id: string): Promise<unknown> =>
      executeOperation("restore", id);
  }

  if (resolvedCapabilities.some((capability) => capability === "archivable")) {
    table.archive = async (id: string): Promise<unknown> =>
      executeOperation("archive", id);
    table.unarchive = async (id: string): Promise<unknown> =>
      executeOperation("unarchive", id);
  }

  const hasShareableCapability = resolvedCapabilities.some(
    (capability) =>
      typeof capability === "object" &&
      capability !== null &&
      "shareable" in (capability as Record<string, unknown>),
  );
  if (hasShareableCapability) {
    table.share = async (
      id: string,
      userId: string,
      level: string,
    ): Promise<unknown> =>
      client.mutate(buildShareMutation(name, version, id, userId, level));
    table.unshare = async (id: string, userId: string): Promise<unknown> =>
      client.mutate(buildUnshareMutation(name, version, id, userId));
    table.getPermissions = async (id: string): Promise<PermissionEntry[]> =>
      client.query(buildGetPermissionsQuery(name, version, id)) as Promise<PermissionEntry[]>;
  }

  return table;
}
