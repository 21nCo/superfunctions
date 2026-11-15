/**
 * Data export and import for backup and restore
 */

import type { DatafnSchema } from "@datafn/core";
import { getJoinStoreKey, getRelationKeyName } from "@datafn/core";
import type { DatafnStorageAdapter } from "./storage.js";
import { createClientError } from "./errors.js";
import type { SyncFacade } from "./sync.js";
import type { CloneUpResult } from "./sync/cloneUp.js";

/**
 * Export payload format version 1
 */
export interface DatafnExportPayload {
  version: 1;
  exportedAt: string; // ISO 8601
  schema: Array<{ name: string; version: number }>;
  resources: Record<string, Array<Record<string, unknown>>>;
  joins?: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Import result with per-resource stats
 */
export interface DatafnImportResult {
  ok: boolean;
  stats: {
    resources: Record<string, { imported: number; skipped: number }>;
    joins: Record<string, { imported: number; skipped: number }>;
  };
  errors: Array<{ resource: string; id: string; code: string; message: string }>;
}

/**
 * Options for data export
 */
export interface DatafnExportOptions {
  /** Filter export to specific resources. If omitted, exports all non-remote-only resources. */
  resources?: string[];
}

/**
 * Called by importData after the local writes and before any cloneUp, with
 * the records written per resource and, per resource, the ids at either end
 * of the join rows written.
 */
export type DatafnImportLocalHook = (
  imported: Record<string, Array<Record<string, unknown>>>,
  relatedIds: Record<string, string[]>,
) => Promise<void> | void;

/**
 * The resources at either end of each many-many join store, under the key
 * the local stores use (`relation`, else "rel") and the canonical one
 * (core's getRelationKeyName).
 */
function joinStoreEndpoints(schema: DatafnSchema): Map<string, { from: string; to: string }> {
  const endpoints = new Map<string, { from: string; to: string }>();
  for (const relation of schema.relations ?? []) {
    if (relation.type !== "many-many") continue;
    const froms = Array.isArray(relation.from) ? relation.from : [relation.from];
    const tos = Array.isArray(relation.to) ? relation.to : [relation.to];
    for (const from of froms) {
      for (const to of tos) {
        const names = new Set([relation.relation ?? "rel", getRelationKeyName(relation, to)]);
        for (const name of names) endpoints.set(getJoinStoreKey(from, name, to), { from, to });
      }
    }
  }
  return endpoints;
}

/**
 * Options for data import
 */
export interface DatafnImportOptions {
  /** When true, trigger cloneUp after import to sync changes to server. Default: false. */
  triggerCloneUp?: boolean;
}

/**
 * Resolve the set of resources to export based on schema and filter options
 */
function resolveExportScope(
  schema: DatafnSchema,
  resourceNames?: string[],
): Array<{ name: string; version: number }> {
  const allExportable = schema.resources.filter(r => !r.isRemoteOnly);
  
  if (!resourceNames || resourceNames.length === 0) {
    // Export all non-remote-only resources
    return allExportable.map(r => ({ name: r.name, version: r.version }));
  }
  
  // Filter to specified resources
  const result: Array<{ name: string; version: number }> = [];
  for (const name of resourceNames) {
    const resource = allExportable.find(r => r.name === name);
    if (resource) {
      result.push({ name: resource.name, version: resource.version });
    }
  }
  
  return result;
}

/**
 * Export all local records and join rows as structured JSON
 */
export async function exportData(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  options?: DatafnExportOptions,
): Promise<DatafnExportPayload> {
  const resources = resolveExportScope(schema, options?.resources);
  
  const payload: DatafnExportPayload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    schema: resources.map(r => ({ name: r.name, version: r.version })),
    resources: {},
    joins: {},
  };
  
  // Export records for each resource
  for (const resource of resources) {
    payload.resources[resource.name] = await storage.listRecords(resource.name);
  }
  
  // Export join rows for many-many relations (handle multi-resource from/to arrays)
  for (const relation of schema.relations ?? []) {
    if (relation.type !== "many-many") continue;
    const froms = Array.isArray(relation.from) ? relation.from : [relation.from];
    const tos = Array.isArray(relation.to) ? relation.to : [relation.to];
    const relName = relation.relation ?? "rel";
    for (const f of froms) {
      for (const t of tos) {
        const storeName = getJoinStoreKey(f, relName, t);
        try {
          payload.joins![storeName] = await storage.listJoinRows(storeName);
        } catch (err) {
          // Join store may not exist if no relations have been created
          // Continue without error
        }
      }
    }
  }
  
  return payload;
}

/**
 * Import records and join rows from a structured JSON payload
 */
export async function importData(
  storage: DatafnStorageAdapter,
  schema: DatafnSchema,
  sync: SyncFacade,
  data: DatafnExportPayload,
  options?: DatafnImportOptions,
  afterLocalImport?: DatafnImportLocalHook,
): Promise<DatafnImportResult> {
  // Validate version
  if (data.version !== 1) {
    throw createClientError(
      "DFQL_INVALID",
      "Unsupported export version",
      { path: "version", version: data.version },
    );
  }
  
  const result: DatafnImportResult = {
    ok: true,
    stats: {
      resources: {},
      joins: {},
    },
    errors: [],
  };
  
  const importedRecords: Record<string, Array<Record<string, unknown>>> = {};

  // Import records
  for (const [resourceName, records] of Object.entries(data.resources)) {
    const resourceSchema = schema.resources.find(r => r.name === resourceName);
    if (!resourceSchema) {
      // Skip unknown resources (not an error)
      continue;
    }
    
    let imported = 0;
    let skipped = 0;
    const written: Array<Record<string, unknown>> = [];
    
    for (const record of records) {
      try {
        await storage.upsertRecord(resourceName, record);
        written.push(record);
        imported++;
      } catch (err) {
        skipped++;
        result.errors.push({
          resource: resourceName,
          id: String(record.id),
          code: "IMPORT_FAILED",
          message: String(err),
        });
      }
    }
    
    result.stats.resources[resourceName] = { imported, skipped };
    if (written.length > 0) importedRecords[resourceName] = written;
  }
  
  // Import join rows
  const endpointsByStore = joinStoreEndpoints(schema);
  const relatedIds = new Map<string, Set<string>>();
  const addRelated = (resource: string, id: unknown) => {
    if (typeof id !== "string") return;
    let ids = relatedIds.get(resource);
    if (!ids) {
      ids = new Set();
      relatedIds.set(resource, ids);
    }
    ids.add(id);
  };
  for (const [storeName, rows] of Object.entries(data.joins ?? {})) {
    let imported = 0;
    let skipped = 0;
    const endpoints = endpointsByStore.get(storeName);
    
    for (const row of rows) {
      try {
        await storage.upsertJoinRow(storeName, row);
        if (endpoints) {
          addRelated(endpoints.from, row.from);
          addRelated(endpoints.to, row.to);
        }
        imported++;
      } catch (err) {
        skipped++;
        // Join row errors are not added to errors array (less critical)
      }
    }
    
    result.stats.joins[storeName] = { imported, skipped };
  }
  
  // Search indexing and change events for what was written locally
  if (afterLocalImport) {
    await afterLocalImport(
      importedRecords,
      Object.fromEntries([...relatedIds].map(([resource, ids]) => [resource, [...ids]])),
    );
  }

  // Trigger cloneUp if requested. Local writes stay in place when the push is
  // rejected or fails; the result reports why.
  if (options?.triggerCloneUp && sync.cloneUp) {
    let pushed: CloneUpResult | undefined;
    try {
      pushed = await sync.cloneUp();
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown } | null;
      result.errors.push({
        resource: "",
        id: "",
        code: typeof failure?.code === "string" ? failure.code : "PUSH_FAILED",
        message:
          typeof failure?.message === "string" && failure.message.length > 0
            ? failure.message
            : "cloneUp failed",
      });
    }
    if (pushed && pushed.ok === false) {
      const pushErrors = Array.isArray(pushed.errors) ? pushed.errors : [];
      if (pushErrors.length === 0) {
        result.errors.push({
          resource: "",
          id: "",
          code: "PUSH_REJECTED",
          message: "cloneUp did not complete",
        });
      }
      for (const error of pushErrors) {
        const target = parseCloneUpMutationId(error.mutationId);
        result.errors.push({
          resource: target.resource,
          id: target.id,
          code: error.code || "PUSH_REJECTED",
          message: error.message || "Push rejected by server",
        });
      }
    }
  }
  
  // Mark result as not ok if there were any errors
  if (result.errors.length > 0) {
    result.ok = false;
  }
  
  return result;
}

/**
 * Resource and id from a cloneUp record mutation id
 * (`<prefix>:rec:<resource>:<id>:<hash>`, or `:ref:` for a deferred reference).
 */
function parseCloneUpMutationId(mutationId: unknown): { resource: string; id: string } {
  if (typeof mutationId !== "string") return { resource: "", id: "" };
  const match = /:(rec|ref):/.exec(mutationId);
  if (!match) return { resource: "", id: mutationId };
  const rest = mutationId.slice(match.index + match[0].length);
  const resourceEnd = rest.indexOf(":");
  const hashStart = rest.lastIndexOf(":");
  if (resourceEnd === -1 || hashStart <= resourceEnd) return { resource: "", id: mutationId };
  return {
    resource: rest.slice(0, resourceEnd),
    id: rest.slice(resourceEnd + 1, hashStart),
  };
}
