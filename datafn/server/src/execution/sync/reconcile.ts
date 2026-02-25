/**
 * Reconcile implementation - counts-based drift detection
 * 
 * Implements SYNC-007: Server reconcile endpoint returns deterministic counts
 * for resources and join stores.
 */

import type { DatafnSchema } from "@datafn/core";
import { getJoinStoreKey, getJoinTableName } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import { ChangeTrackingService } from "./change-tracking.js";
import type { SequenceStore } from "./sequence-store.js";

export interface ReconcileRequest {
  clientId: string;
  resources: string[];
  includeJoins?: boolean;
}

export interface ReconcileResult {
  ok: boolean;
  counts?: Record<string, number>;
  joinCounts?: Record<string, number>;
  latestCursor?: string;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Execute reconcile operation - return deterministic counts for drift detection
 */
export async function executeReconcile(
  request: ReconcileRequest,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
): Promise<ReconcileResult> {
  // Validate clientId
  if (!request.clientId || typeof request.clientId !== "string") {
    return {
      ok: false,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: clientId must be string",
        details: { path: "clientId" },
      },
    };
  }

  // Validate resources array
  if (!Array.isArray(request.resources)) {
    return {
      ok: false,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: resources must be array",
        details: { path: "resources" },
      },
    };
  }

  const counts: Record<string, number> = {};
  let joinCounts: Record<string, number> | undefined;

  // Validate and count each requested resource
  for (const resourceName of request.resources) {
    const resource = schema.resources.find((r) => r.name === resourceName);

    if (!resource) {
      return {
        ok: false,
        error: {
          code: "DFQL_UNKNOWN_RESOURCE",
          message: `Unknown resource: ${resourceName}`,
          details: { path: `resources[${request.resources.indexOf(resourceName)}]` },
        },
      };
    }

    // Check for isRemoteOnly flag (reconcile doesn't make sense for remote-only)
    if ((resource as any).isRemoteOnly) {
      return {
        ok: false,
        error: {
          code: "DFQL_INVALID",
          message: `Invalid DFQL: remote-only table cannot be reconciled: ${resourceName}`,
          details: { path: `resources[${request.resources.indexOf(resourceName)}]` },
        },
      };
    }

    try {
      // Count records deterministically
      const records = await db.findMany({
        model: resourceName,
        where: [],
        namespace,
      });

      counts[resourceName] = records.length;
    } catch (error) {
      // On adapter error, return 0 count
      counts[resourceName] = 0;
    }
  }

  // Include join counts if requested (SYNC-007)
  if (request.includeJoins && schema.relations) {
    joinCounts = {};

    for (const relation of schema.relations) {
      // Skip relations that aren't many-many (no join rows)
      if (relation.type !== "many-many") continue;

      // Check if this relation involves any of the requested resources
      const involvesRequestedResource =
        request.resources.includes(relation.from) ||
        request.resources.includes(relation.to);

      if (!involvesRequestedResource) continue;

      // Logical key used by the client for its join store (matches change tracking and pull)
      const joinStoreKey = getJoinStoreKey(relation.from as string, relation.relation!, relation.to as string);
      // Actual DB table name (matches what relations.ts writes and what codegen generates)
      const joinTableName = getJoinTableName(relation.from as string, relation.relation!, relation.joinTable);

      try {
        // Count join rows using the actual DB table name
        const joinRecords = await db.findMany({
          model: joinTableName,
          where: [],
          namespace,
        });

        // Return count under the logical client store key
        joinCounts[joinStoreKey] = joinRecords.length;
      } catch (error) {
        // Join table might not exist or be queryable; count as 0
        joinCounts[joinStoreKey] = 0;
      }
    }
  }

  // Get latest cursor (global max across requested resources)
  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore);
  const latestCursor = String(await changeTracking.getCurrentServerSeq());

  return {
    ok: true,
    counts,
    joinCounts,
    latestCursor,
  };
}
