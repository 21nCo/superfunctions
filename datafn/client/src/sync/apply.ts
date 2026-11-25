/**
 * Sync Apply Logic
 *
 * Apply clone/pull results into local storage with hydration state management.
 */

import type { DatafnRevisionEntry, DatafnStorageAdapter } from "../storage.js";
import {
  DATAFN_REVISION_FIELD,
  KV_RESOURCE_NAME,
  readRowRevision,
  withoutRowRevision,
  type DatafnSchema,
} from "@datafn/core";

/**
 * DATA-41: whether `$rev` on rows of a resource is the server's revision
 * metadata (true unless the resource has its own field named `$rev`).
 */
export type RevisionResources = (resource: string) => boolean;

/** DATA-41: the revision resources of a schema (see RevisionResources). */
export function schemaRevisionResources(schema: DatafnSchema): RevisionResources {
  return (resource) => {
    const def = schema.resources.find((entry) => entry.name === resource);
    if (!def) return resource === KV_RESOURCE_NAME;
    return !(def.fields ?? []).some((field) => field.name === DATAFN_REVISION_FIELD);
  };
}

function storesRevisions(storage: DatafnStorageAdapter): boolean {
  return storage.capabilities?.revisions === true && typeof storage.putRecordsWithRevisions === "function";
}

/**
 * DATA-41: installs complete server rows (record null for a tombstone) with
 * their revisions in one storage write, leaving alone each record a pending
 * local change (logged or debounced) may change, or, with `writtenSince`, that
 * was written after the request started. Returns the installed ids.
 */
export async function installServerRevisions(
  storage: DatafnStorageAdapter,
  resource: string,
  entries: DatafnRevisionEntry[],
  options: ApplyRevisionOptions & { writtenSince?: number },
): Promise<string[]> {
  if (entries.length === 0 || !options.revisionResources?.(resource) || !storesRevisions(storage)) return [];
  return storage.putRecordsWithRevisions!(resource, entries, {
    unlessPending: true,
    writtenSince: options.writtenSince,
    pendingMutations: options.pendingMutations?.(),
  });
}

/**
 * DATA-41: stores complete server rows. Rows with a revision are installed
 * with it in one write on an adapter that keeps revisions (see
 * installServerRevisions); every other row is returned without `$rev` for a
 * plain write, which leaves its revision unknown.
 */
async function storeServerRows(
  storage: DatafnStorageAdapter,
  resource: string,
  rows: Array<Record<string, unknown>>,
  options: ApplyRevisionOptions,
): Promise<Array<Record<string, unknown>>> {
  if (!options.revisionResources?.(resource)) return rows;
  const entries = rows.flatMap((row) => {
    const rev = readRowRevision(row);
    return rev !== undefined && typeof row.id === "string"
      ? [{ id: row.id, record: withoutRowRevision(row), rev }]
      : [];
  });
  const installed = new Set(await installServerRevisions(storage, resource, entries, options));
  return rows
    .filter((row) => typeof row.id !== "string" || !installed.has(row.id))
    .map((row) => withoutRowRevision(row));
}

/** DATA-41: a delete, as a tombstone with its revision when one is known. */
async function deleteServerRecord(
  storage: DatafnStorageAdapter,
  resource: string,
  id: string,
  rev: number | undefined,
  options: ApplyRevisionOptions,
): Promise<void> {
  if (rev !== undefined) {
    const installed = await installServerRevisions(storage, resource, [{ id, record: null, rev }], options);
    if (installed.length > 0) return;
  }
  await storage.deleteRecord(resource, id);
}

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

/** DATA-41: revision options for applying server results. */
export type ApplyRevisionOptions = {
  /** Resources whose `$rev` row property is revision metadata. */
  revisionResources?: RevisionResources;
  /** Local mutations applied to storage but not yet in the changelog (debounced). */
  pendingMutations?: () => readonly unknown[];
};

/**
 * Global-cursor pull result shape
 */
export type PullResultGlobalCursor = {
  ok: boolean;
  changes: Array<{
    serverSeq: number;
    resource: string;
    id: string;
    op: "insert" | "merge" | "replace" | "upsert" | "delete";
    record: Record<string, unknown> | null;
    reason?: "revoked" | "grant_backfill";
    /** DATA-41: the record's revision after this change. */
    rev?: number;
  }>;
  nextCursor: string | null;
  actorFeed?: Array<Record<string, unknown>>;
};

/**
 * Canonical per-table cursor pull result shape (PHASE_05)
 */
export type PullResultCanonical = {
  ok: boolean;
  records: Record<string, Array<Record<string, unknown>>>;
  merged?: Record<string, Array<Record<string, unknown>>>; // partial records to apply via mergeRecord (FIX-A)
  deleted: Record<string, string[]>;
  /** DATA-41: tombstone revisions of deleted ids, per resource. */
  deletedRevisions?: Record<string, Record<string, number>>;
  joins?: Record<string, {
    upsert: Array<Record<string, unknown>>;
    delete: Array<{ from: string; to: string }>;
  }>;
  cursors: Record<string, string>;
  actorFeed?: Array<Record<string, unknown>>;
  hasMore?: boolean; // CLIENT-PULL-001: true when more changes remain on server
};

export type PullResult = PullResultGlobalCursor | PullResultCanonical;

/**
 * Apply clone result to local storage.
 * Transitions hydration state: notStarted → hydrating → ready
 */
export async function applyCloneResult(
  storage: DatafnStorageAdapter,
  result: CloneResult,
  options: {
    /**
     * Mark each resource "ready" once its records are written (default true).
     * A paginated clone passes false for every page, so a resource stays
     * "hydrating" (and is cloned again after an interruption) until the
     * caller has applied its last page.
     */
    markReady?: boolean;
    /**
     * Keep a resource's stored cursor when it is older than the result's
     * (default false). A paginated or capped clone reads its batches at
     * different server sequences, and may resume an interrupted pass; keeping
     * the earliest cursor durably lets the next pull replay every change,
     * including deletions, to records an earlier batch or pass stored.
     */
    keepEarliestCursor?: boolean;
  } & ApplyRevisionOptions = {},
): Promise<void> {
  const markReady = options.markReady ?? true;
  const keepEarliestCursor = options.keepEarliestCursor ?? false;
  if (!result.ok) {
    return; // Don't apply failed results
  }

  const { data, cursors, joins } = result;

  // Process each table
  for (const [resource, records] of Object.entries(data)) {
    // Transition to hydrating state before applying
    await storage.setHydrationState(resource, "hydrating");

    // DATA-41: rows with a revision are installed with it; the rest are
    // upserted (clearing any revision).
    const plainRecords = await storeServerRows(storage, resource, records, options);

    // Upsert all records by id, in one transaction when the adapter can
    if (storage.upsertRecords) {
      if (plainRecords.length > 0) await storage.upsertRecords(resource, plainRecords);
    } else {
      for (const record of plainRecords) {
        await storage.upsertRecord(resource, record);
      }
    }

    // Set cursor per resource
    const cursor = cursors[resource];
    if (cursor !== undefined) {
      const stored = keepEarliestCursor ? await storage.getCursor(resource) : null;
      await storage.setCursor(resource, earlierCursor(stored, cursor));
    }

    // Transition to ready after applying
    if (markReady) {
      await storage.setHydrationState(resource, "ready");
    }
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

  // A clone that keeps its earliest per-resource cursor must not advance the
  // global cursor past it either: push and WebSocket paths compare against
  // the global cursor to decide whether a pull is still needed.
  if (keepEarliestCursor) {
    return;
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
 * Detect if pull result is global-cursor format
 */
function isGlobalCursorPullResult(result: PullResult): result is PullResultGlobalCursor {
  return "changes" in result && Array.isArray((result as any).changes);
}

/**
 * Apply pull result to local storage.
 * Supports both global-cursor and canonical per-table cursor formats.
 */
export async function applyPullResult(
  storage: DatafnStorageAdapter,
  result: PullResult,
  options: ApplyRevisionOptions = {},
): Promise<void> {
  if (!result.ok) {
    return; // Don't apply failed results
  }

  if (isGlobalCursorPullResult(result)) {
    await applyPullResultGlobalCursor(storage, result, options);
  } else {
    await applyPullResultCanonical(storage, result as PullResultCanonical, options);
  }
}

/**
 * Apply global-cursor pull result
 */
async function applyPullResultGlobalCursor(
  storage: DatafnStorageAdapter,
  result: PullResultGlobalCursor,
  options: ApplyRevisionOptions,
): Promise<void> {
  const { changes, nextCursor } = result;

  if (nextCursor !== null) {
    await assertCursorNonRegressing(storage, GLOBAL_CURSOR_KEY, nextCursor, "nextCursor");
  }

  // Process changes in order
  for (const change of changes) {
    const { resource, id, op, record } = change;

    // DATA-41: an upsert here may be a partial merge, so only a delete
    // (a tombstone) is paired with its revision.
    if (op === "delete") {
      await deleteServerRecord(storage, resource, id, change.rev, options);
    } else if (record) {
      await storage.upsertRecord(
        resource,
        options.revisionResources?.(resource) ? withoutRowRevision(record) : record,
      );
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
  options: ApplyRevisionOptions,
): Promise<void> {
  const { records, merged, deleted, joins, cursors } = result;
  const revisionResources = options.revisionResources;

  // Reject cursor regressions before mutating local state.
  for (const [resource, cursor] of Object.entries(cursors)) {
    await assertCursorNonRegressing(storage, resource, cursor, `cursors.${resource}`);
  }

  // Apply record upserts (insert/replace/upsert ops — full record replacement).
  // DATA-41: these rows are complete, so one with a revision is installed
  // with it; merges and deletes below run after, so a later partial change
  // leaves the revision unknown.
  for (const [resource, resourceRecords] of Object.entries(records)) {
    for (const record of await storeServerRows(storage, resource, resourceRecords, options)) {
      await storage.upsertRecord(resource, record);
    }
  }

  // Apply merge deltas (merge op — partial record, must not overwrite unset fields) (FIX-A)
  if (merged) {
    for (const [resource, mergedRecords] of Object.entries(merged)) {
      for (const record of mergedRecords) {
        const id = record.id as string;
        // A partial patch: never paired with its revision.
        await storage.mergeRecord(
          resource,
          id,
          revisionResources?.(resource) ? withoutRowRevision(record) : record,
        );
      }
    }
  }

  // Apply record deletes
  for (const [resource, ids] of Object.entries(deleted)) {
    for (const id of ids) {
      await deleteServerRecord(storage, resource, id, result.deletedRevisions?.[resource]?.[id], options);
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
export async function setCursorMonotonically(
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

async function assertCursorNonRegressing(
  storage: DatafnStorageAdapter,
  resource: string,
  newCursor: string,
  path: string,
): Promise<void> {
  const existingCursor = await storage.getCursor(resource);
  if (existingCursor === null) {
    return;
  }

  const existingSeq = parseInt(existingCursor, 10);
  const newSeq = parseInt(newCursor, 10);

  if (Number.isNaN(existingSeq) || Number.isNaN(newSeq)) {
    return;
  }

  if (newSeq < existingSeq) {
    const error = new Error("Non-monotonic cursor") as Error & {
      code: string;
      details: Record<string, unknown>;
    };
    error.code = "CONFLICT";
    error.details = { path };
    throw error;
  }
}

/**
 * The older of two per-resource sequence cursors. A missing or non-numeric
 * stored cursor yields the candidate.
 */
export function earlierCursor(stored: string | null, candidate: string): string {
  if (stored === null) return candidate;
  const a = Number(stored);
  const b = Number(candidate);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return candidate;
  return a < b ? stored : candidate;
}
