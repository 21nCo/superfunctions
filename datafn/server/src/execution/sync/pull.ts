/**
 * Pull implementation - incremental updates since cursor using change tracking
 */

import type { DatafnSchema } from "@datafn/core";
import type { Adapter } from "@superfunctions/db";
import type { SequenceStore } from "./sequence-store.js";
import { ChangeTrackingService } from "./change-tracking.js";

// Legacy global-cursor pull (TV-SYNC-004)
export interface PullRequestLegacy {
  clientId: string;
  cursor: string;
  limit?: number;
}

export interface PullResultLegacy {
  ok: boolean;
  changes: Array<{
    serverSeq: number;
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
  }>;
  nextCursor: string | null;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Canonical per-table cursor pull (TV-SYNC-003)
export interface PullRequestCanonical {
  clientId: string;
  cursors: Record<string, string>;
  limit?: number;
  includeJoins?: boolean;
}

export interface PullResultCanonical {
  ok: boolean;
  records: Record<string, Array<Record<string, unknown>>>;
  merged?: Record<string, Array<Record<string, unknown>>>; // partial records applied via mergeRecord (FIX-A)
  deleted: Record<string, string[]>;
  joins?: Record<string, {
    upsert: Array<Record<string, unknown>>;
    delete: Array<{ from: string; to: string }>;
  }>;
  cursors: Record<string, string>;
  hasMore?: boolean; // CLIENT-PULL-001: true when changes were truncated
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Union type for request detection
export type PullRequest = PullRequestLegacy | PullRequestCanonical;
export type PullResult = PullResultLegacy | PullResultCanonical;

/**
 * Validate cursor is a base-10 integer string
 */
function validateCursor(cursor: string): boolean {
  return /^\d+$/.test(cursor);
}

/**
 * Detect request type: legacy (has `cursor` string) or canonical (has `cursors` object)
 */
function isLegacyPull(request: PullRequest): request is PullRequestLegacy {
  return "cursor" in request && typeof (request as any).cursor === "string";
}

/**
 * Execute pull operation - return changes since cursor
 * Supports both legacy global-cursor and canonical per-table cursor protocols
 */
export async function executePull(
  request: PullRequest,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
  maxPullLimit?: number,
): Promise<PullResult> {
  // Validate clientId (common to both protocols)
  if (!request.clientId || typeof request.clientId !== "string") {
    return {
      ok: false,
      changes: [],
      nextCursor: null,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: clientId must be string",
        details: { path: "clientId" },
      },
    } as PullResultLegacy;
  }

  // Route to appropriate implementation
  if (isLegacyPull(request)) {
    return executePullLegacy(request, schema, db, namespace, sequenceStore);
  } else {
    return executePullCanonical(request as PullRequestCanonical, schema, db, namespace, sequenceStore, maxPullLimit);
  }
}

/**
 * Execute legacy global-cursor pull (TV-SYNC-004)
 */
async function executePullLegacy(
  request: PullRequestLegacy,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
): Promise<PullResultLegacy> {
  // Validate cursor
  if (typeof request.cursor !== "string" || !validateCursor(request.cursor)) {
    return {
      ok: false,
      changes: [],
      nextCursor: null,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: cursor must be an integer string",
        details: { path: "cursor" },
      },
    };
  }

  const limit = request.limit ?? 100;
  if (!Number.isInteger(limit) || limit <= 0) {
    return {
      ok: false,
      changes: [],
      nextCursor: null,
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: limit must be a positive integer",
        details: { path: "limit" },
      },
    };
  }

  // Create change tracking service
  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore);
  const sinceSeq = parseInt(request.cursor, 10);

  // Get global changes
  const changes = await changeTracking.getGlobalChanges({
    sinceSeq,
    limit,
  });

  const mappedChanges = changes.map((c) => ({
    serverSeq: c.serverSeq,
    resource: c.resource,
    id: c.id,
    op: c.op,
    record: c.record,
  }));

  // Determine next cursor
  let nextCursor: string | null = null;
  if (mappedChanges.length === limit) {
    nextCursor = String(mappedChanges[mappedChanges.length - 1].serverSeq);
  }

  return {
    ok: true,
    changes: mappedChanges,
    nextCursor,
  };
}

/**
 * Execute canonical per-table cursor pull (TV-SYNC-003)
 */
async function executePullCanonical(
  request: PullRequestCanonical,
  schema: DatafnSchema,
  db: Adapter,
  namespace: string,
  sequenceStore?: SequenceStore,
  maxPullLimit?: number,
): Promise<PullResultCanonical> {
  // Validate cursors object
  if (!request.cursors || typeof request.cursors !== "object") {
    return {
      ok: false,
      records: {},
      deleted: {},
      cursors: {},
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: cursors must be an object",
        details: { path: "cursors" },
      },
    };
  }

  // Validate each cursor is a valid integer string
  for (const [resource, cursor] of Object.entries(request.cursors)) {
    if (typeof cursor !== "string" || !validateCursor(cursor)) {
      return {
        ok: false,
        records: {},
        deleted: {},
        cursors: {},
        error: {
          code: "DFQL_INVALID",
          message: "Invalid DFQL: cursor must be an integer string",
          details: { path: `cursors.${resource}` },
        },
      };
    }
  }

  const requestLimit = request.limit ?? 200;
  if (!Number.isInteger(requestLimit) || requestLimit <= 0) {
    return {
      ok: false,
      records: {},
      deleted: {},
      cursors: {},
      error: {
        code: "DFQL_INVALID",
        message: "Invalid DFQL: limit must be a positive integer",
        details: { path: "limit" },
      },
    };
  }

  // Enforce server-side maxPullLimit (SYNC-002)
  const effectiveMaxPullLimit = maxPullLimit && maxPullLimit > 0 ? maxPullLimit : 1000;
  const limit = Math.min(requestLimit, effectiveMaxPullLimit);

  const changeTracking = new ChangeTrackingService(db, namespace, sequenceStore);

  // Initialize result structures
  const records: Record<string, Array<Record<string, unknown>>> = {};
  const merged: Record<string, Array<Record<string, unknown>>> = {}; // merge deltas (FIX-A)
  const deleted: Record<string, string[]> = {};
  const joins: Record<string, { upsert: Array<Record<string, unknown>>; delete: Array<{ from: string; to: string }> }> = {};
  const cursors: Record<string, string> = {};

  // Initialize empty arrays for all requested resources
  for (const resource of Object.keys(request.cursors)) {
    records[resource] = [];
    deleted[resource] = [];
    cursors[resource] = request.cursors[resource]; // Start with original cursor
  }

  // EXE-021: Fetch per-resource changes in parallel instead of sequentially
  const resourceEntries = Object.entries(request.cursors);
  const allResourceChanges = await Promise.all(
    resourceEntries.map(async ([resource, cursor]) => {
      const sinceSeq = parseInt(cursor, 10);
      // Fetch limit+1 so we can detect truncation without a separate COUNT query
      const resourceChanges = await changeTracking.getChangesSince({
        resource,
        sinceSeq,
        limit: limit + 1,
      });
      return resourceChanges.map((change) => ({ resource, change }));
    }),
  );
  const allChanges: Array<{ resource: string; change: any }> = allResourceChanges.flat();

  // Sort all changes by serverSeq (deterministic ordering)
  allChanges.sort((a, b) => a.change.serverSeq - b.change.serverSeq);

  // CLIENT-PULL-001: detect truncation before slicing
  const hasMore = allChanges.length > limit;

  // Apply limit across all resources
  const limitedChanges = allChanges.slice(0, limit);

  // Track latest cursor per resource
  const latestCursorPerResource: Record<string, number> = {};

  // Process changes into result structure
  for (const { resource, change } of limitedChanges) {
    // Update latest cursor for this resource
    latestCursorPerResource[resource] = Math.max(
      latestCursorPerResource[resource] || 0,
      change.serverSeq
    );

    // Check if this is a join store change (starts with "join_")
    if (resource.startsWith("join_")) {
      // This is a join row change (TV-SYNC-006, TV-REL-002)
      if (!joins[resource]) {
        joins[resource] = { upsert: [], delete: [] };
      }

      if ((change.op === "upsert" || change.op === "insert" || change.op === "replace") && change.record) {
        joins[resource].upsert.push(change.record);
      } else if (change.op === "delete") {
        // For join deletes, extract from/to from id or record
        const from = change.record?.from || change.id.split(":")[0];
        const to = change.record?.to || change.id.split(":")[1];
        joins[resource].delete.push({ from, to });
      }
    } else {
      // Regular resource change — dispatch based on op type (FIX-A)
      if (change.op === "merge" && change.record) {
        // Merge delta: client must apply via mergeRecord() to preserve unspecified fields
        if (!merged[resource]) {
          merged[resource] = [];
        }
        merged[resource].push(change.record);
      } else if ((change.op === "insert" || change.op === "replace" || change.op === "upsert") && change.record) {
        records[resource].push(change.record);
      } else if (change.op === "delete") {
        deleted[resource].push(change.id);
      }
    }
  }

  // Update cursors with latest values
  for (const [resource, latestSeq] of Object.entries(latestCursorPerResource)) {
    cursors[resource] = String(latestSeq);
  }

  const result: PullResultCanonical = {
    ok: true,
    records,
    deleted,
    cursors,
    hasMore,
  };

  // Include merged deltas if any exist (FIX-A)
  if (Object.keys(merged).length > 0) {
    result.merged = merged;
  }

  // Include joins if requested
  if (request.includeJoins && Object.keys(joins).length > 0) {
    result.joins = joins;
  }

  return result;
}
