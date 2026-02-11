/**
 * Clone implementation - full data sync with change tracking
 */

import type { DatafnSchema } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService } from "./change-tracking.js";

export interface CloneRequest {
  clientId: string;
  tables?: string[]; // Optional: specific tables to clone
  page?: {
    table: string;
    afterId: string | null;
    limit: number;
  };
  includeJoins?: boolean;
}

export interface CloneResult {
  ok: boolean;
  data: Record<string, Array<Record<string, unknown>>>;
  cursors: Record<string, string>;
  joins?: Record<string, Array<Record<string, unknown>>>;
  next?: Record<string, string | null>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Execute clone operation - return full dataset with cursors
 */
export async function executeClone(
  request: CloneRequest,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
): Promise<CloneResult> {
  // Validate clientId
  if (!request.clientId || typeof request.clientId !== "string") {
    return {
      ok: false,
      data: {},
      cursors: {},
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: clientId must be string",
        details: { path: "clientId" },
      },
    };
  }

  const data: Record<string, Array<Record<string, unknown>>> = {};
  const cursors: Record<string, string> = {};
  const next: Record<string, string | null> = {};
  let joins: Record<string, Array<Record<string, unknown>>> | undefined;

  // Determine which tables to clone
  const tablesToClone = request.tables || schema.resources.map((r) => r.name);

  // Check for isRemoteOnly tables
  for (const tableName of tablesToClone) {
    const resource = schema.resources.find((r) => r.name === tableName);

    if (!resource) {
      return {
        ok: false,
        data: {},
        cursors: {},
        error: {
          code: "DFQL_UNKNOWN_RESOURCE",
          message: `Unknown resource: ${tableName}`,
          details: { path: "tables" },
        },
      };
    }

    // Check for isRemoteOnly flag
    if ((resource as any).isRemoteOnly) {
      return {
        ok: false,
        data: {},
        cursors: {},
        error: {
          code: "DFQL_INVALID",
          message: `Invalid DFQL: remote-only table cannot be cloned: ${tableName}`,
          details: { path: "tables" },
        },
      };
    }
  }

  // Create change tracking service with user/tenant namespace and optional sequence store
  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore);

  // Handle paginated clone if page parameter is provided
  if (request.page) {
    const { table, afterId, limit } = request.page;

    // Validate page table is in requested tables
    if (!tablesToClone.includes(table)) {
      return {
        ok: false,
        data: {},
        cursors: {},
        error: {
          code: "DFQL_INVALID",
          message: `Invalid DFQL: page.table must be in tables list: ${table}`,
          details: { path: "page.table" },
        },
      };
    }

    // Enforce maximum page size (default 1000)
    const effectiveLimit = Math.min(limit, 1000);

    try {
      // Build where clause for afterId pagination
      const where = afterId
        ? [{ field: "id", operator: ">", value: afterId }]
        : [];

      const records = await db.findMany({
        model: table,
        where,
        orderBy: [{ field: "id", direction: "asc" }],
        limit: effectiveLimit,
        namespace,
      });

      data[table] = records;

      // Compute next marker
      if (records.length === effectiveLimit) {
        // More pages exist
        const lastRecord = records[records.length - 1];
        next[table] = lastRecord.id as string;
      } else {
        // This was the last page
        next[table] = null;
      }

      // Get latest serverSeq for this table as cursor
      const latestSeq = await changeTracking.getLatestServerSeq({
        resource: table,
      });
      cursors[table] = String(latestSeq);
    } catch (error) {
      // On adapter error, return empty data for this table
      data[table] = [];
      cursors[table] = "0";
      next[table] = null;
    }

    // For paginated clone of other tables in the list (if any), return empty arrays
    for (const tableName of tablesToClone) {
      if (tableName !== table && !data[tableName]) {
        data[tableName] = [];
        const latestSeq = await changeTracking.getLatestServerSeq({
          resource: tableName,
        });
        cursors[tableName] = String(latestSeq);
      }
    }
  } else {
    // Non-paginated: get all records for each table, sorted by id
    for (const tableName of tablesToClone) {
      try {
        const records = await db.findMany({
          model: tableName,
          where: [],
          orderBy: [{ field: "id", direction: "asc" }],
          namespace,
        });

        data[tableName] = records;

        // Get latest serverSeq for this table as cursor
        const latestSeq = await changeTracking.getLatestServerSeq({
          resource: tableName,
        });
        cursors[tableName] = String(latestSeq);
      } catch (error) {
        // On adapter error, return empty data for this table
        data[tableName] = [];
        cursors[tableName] = "0";
      }
    }
  }

  // Include join rows if requested (SYNC-001, SYNC-006)
  if (request.includeJoins && schema.relations) {
    joins = {};

    for (const relation of schema.relations) {
      // Skip relations that aren't many-many (no join rows)
      if (relation.type !== "many-many") continue;

      // Derive join store key (consistent with client naming)
      const joinStoreKey = `join_${relation.from}_${relation.relation}_${relation.to}`;

      try {
        // Query join table for all rows
        const joinRecords = await db.findMany({
          model: joinStoreKey,
          where: [],
          orderBy: [{ field: "from", direction: "asc" }],
          namespace,
        });

        if (joinRecords.length > 0) {
          joins[joinStoreKey] = joinRecords;
        }
      } catch (error) {
        // Join table might not exist or be queryable; skip gracefully
        continue;
      }
    }
  }

  return {
    ok: true,
    data,
    cursors,
    joins,
    next: Object.keys(next).length > 0 ? next : undefined,
  };
}
