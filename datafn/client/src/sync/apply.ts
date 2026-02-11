/**
 * Sync Apply Logic
 *
 * Apply clone/pull results into local storage with hydration state management.
 */

import type { DatafnStorageAdapter } from "../storage.js";

export const GLOBAL_CURSOR_KEY = "__global_cursor__";

/**
 * Clone result shape from remote
 */
export type CloneResult = {
  ok: boolean;
  data: Record<string, Array<Record<string, unknown>>>;
  cursors: Record<string, string>;
  joins?: Record<string, Array<Record<string, unknown>>>;
  next?: Record<string, string | null>;
};

/**
 * Legacy pull result shape (global cursor)
 */
export type PullResultLegacy = {
  ok: boolean;
  changes: Array<{
    serverSeq: number;
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
  }>;
  nextCursor: string | null;
};

/**
 * Canonical per-table cursor pull result shape (PHASE_05)
 */
export type PullResultCanonical = {
  ok: boolean;
  records: Record<string, Array<Record<string, unknown>>>;
  deleted: Record<string, string[]>;
  joins?: Record<string, {
    upsert: Array<Record<string, unknown>>;
    delete: Array<{ from: string; to: string }>;
  }>;
  cursors: Record<string, string>;
};

export type PullResult = PullResultLegacy | PullResultCanonical;

/**
 * Apply clone result to local storage.
 * Transitions hydration state: notStarted → hydrating → ready
 */
export async function applyCloneResult(
  storage: DatafnStorageAdapter,
  result: CloneResult,
): Promise<void> {
  if (!result.ok) {
    return; // Don't apply failed results
  }

  const { data, cursors, joins } = result;

  // Process each table
  for (const [resource, records] of Object.entries(data)) {
    // Transition to hydrating state before applying
    await storage.setHydrationState(resource, "hydrating");

    // Upsert all records by id
    for (const record of records) {
      await storage.upsertRecord(resource, record);
    }

    // Set cursor per resource
    const cursor = cursors[resource];
    if (cursor !== undefined) {
      await storage.setCursor(resource, cursor);
    }

    // Transition to ready after applying
    await storage.setHydrationState(resource, "ready");
  }

  // Apply join rows if present (TV-SYNC-006, TV-REL-002)
  if (joins) {
    for (const [joinStoreKey, rows] of Object.entries(joins)) {
      for (const row of rows) {
        try {
          await storage.upsertJoinRow(joinStoreKey, row);
        } catch (error) {
          // If join store doesn't exist, this is a deterministic error (TV-REL-002N)
          console.error(`Failed to apply join row to ${joinStoreKey}:`, error);
          throw new Error(
            `INTERNAL: Store not found: ${joinStoreKey}`,
          );
        }
      }
    }
  }

  // Calculate and set global cursor
  let maxSeq = 0;
  for (const cursor of Object.values(cursors)) {
    const seq = parseInt(cursor, 10);
    if (!isNaN(seq) && seq > maxSeq) {
      maxSeq = seq;
    }
  }
  await setCursorMonotonically(storage, GLOBAL_CURSOR_KEY, String(maxSeq));
}

/**
 * Detect if pull result is legacy format
 */
function isLegacyPullResult(result: PullResult): result is PullResultLegacy {
  return "changes" in result && Array.isArray((result as any).changes);
}

/**
 * Apply pull result to local storage.
 * Supports both legacy and canonical per-table cursor formats.
 */
export async function applyPullResult(
  storage: DatafnStorageAdapter,
  result: PullResult,
): Promise<void> {
  if (!result.ok) {
    return; // Don't apply failed results
  }

  if (isLegacyPullResult(result)) {
    await applyPullResultLegacy(storage, result);
  } else {
    await applyPullResultCanonical(storage, result as PullResultCanonical);
  }
}

/**
 * Apply legacy pull result (global cursor)
 */
async function applyPullResultLegacy(
  storage: DatafnStorageAdapter,
  result: PullResultLegacy,
): Promise<void> {
  const { changes, nextCursor } = result;

  // Process changes in order
  for (const change of changes) {
    const { resource, id, op, record } = change;

    if (op === "upsert" && record) {
      await storage.upsertRecord(resource, record);
    } else if (op === "delete") {
      await storage.deleteRecord(resource, id);
    }
  }

  // Update global cursor monotonically
  if (nextCursor !== null) {
    await setCursorMonotonically(storage, GLOBAL_CURSOR_KEY, nextCursor);
  }
}

/**
 * Apply canonical per-table cursor pull result (PHASE_05)
 */
async function applyPullResultCanonical(
  storage: DatafnStorageAdapter,
  result: PullResultCanonical,
): Promise<void> {
  const { records, deleted, joins, cursors } = result;

  // Apply record upserts
  for (const [resource, resourceRecords] of Object.entries(records)) {
    for (const record of resourceRecords) {
      await storage.upsertRecord(resource, record);
    }
  }

  // Apply record deletes
  for (const [resource, ids] of Object.entries(deleted)) {
    for (const id of ids) {
      await storage.deleteRecord(resource, id);
    }
  }

  // Apply join deltas if present (TV-SYNC-006, TV-REL-002)
  if (joins) {
    for (const [joinStoreKey, delta] of Object.entries(joins)) {
      // Apply upserts
      for (const row of delta.upsert) {
        try {
          await storage.upsertJoinRow(joinStoreKey, row);
        } catch (error) {
          // If join store doesn't exist, this is a deterministic error (TV-REL-002N)
          console.error(`Failed to apply join upsert to ${joinStoreKey}:`, error);
          throw new Error(
            `INTERNAL: Store not found: ${joinStoreKey}`,
          );
        }
      }

      // Apply deletes
      for (const edge of delta.delete) {
        try {
          await storage.deleteJoinRow(joinStoreKey, edge.from, edge.to);
        } catch (error) {
          console.error(`Failed to apply join delete to ${joinStoreKey}:`, error);
          throw new Error(
            `INTERNAL: Store not found: ${joinStoreKey}`,
          );
        }
      }
    }
  }

  // Update per-table cursors monotonically
  for (const [resource, cursor] of Object.entries(cursors)) {
    await setCursorMonotonically(storage, resource, cursor);
  }

  // Calculate and update global cursor (derived optimization)
  let maxSeq = 0;
  for (const cursor of Object.values(cursors)) {
    const seq = parseInt(cursor, 10);
    if (!isNaN(seq) && seq > maxSeq) {
      maxSeq = seq;
    }
  }
  if (maxSeq > 0) {
    await setCursorMonotonically(storage, GLOBAL_CURSOR_KEY, String(maxSeq));
  }
}

/**
 * Set cursor only if new cursor is greater than existing cursor.
 * Cursors are base-10 integer strings representing serverSeq.
 */
async function setCursorMonotonically(
  storage: DatafnStorageAdapter,
  resource: string,
  newCursor: string,
): Promise<void> {
  const existingCursor = await storage.getCursor(resource);

  // If no existing cursor, set the new one
  if (existingCursor === null) {
    await storage.setCursor(resource, newCursor);
    return;
  }

  // Parse as integers for comparison
  const existingSeq = parseInt(existingCursor, 10);
  const newSeq = parseInt(newCursor, 10);

  // Only update if new cursor is greater (monotonic)
  if (newSeq > existingSeq) {
    await storage.setCursor(resource, newCursor);
  }
}
