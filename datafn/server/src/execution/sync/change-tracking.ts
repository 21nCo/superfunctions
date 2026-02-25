/**
 * Change tracking service for serverSeq and change log management
 *
 * Implements monotonic serverSeq ordering per namespace and change tracking
 * for sync operations (SERVER-CONFLICT-001, SERVER-SYNC-001/002/003).
 *
 * Internal tables:
 * - __datafn_meta: stores next_server_seq per namespace
 * - __datafn_changes: stores change entries with (namespace, resource, server_seq) index
 *
 * Supports pluggable sequence stores (Redis, KV, or database fallback) for
 * high-performance serverSeq generation.
 */

import type { Adapter } from "@superfunctions/db";
import type { SequenceStore } from "./sequence-store.js";
import { ensureInternalTable } from "../internal-tables.js";

/**
 * Change entry representing a mutation effect
 */
export interface ChangeEntry {
  namespace: string;
  serverSeq: number;
  resource: string;
  id: string;
  op: "insert" | "merge" | "replace" | "upsert" | "delete";
  record: Record<string, unknown> | null;
}

/**
 * Input type for recording a change entry (without namespace, which is supplied by the service)
 */
export interface ChangeEntryInput {
  serverSeq: number;
  resource: string;
  id: string;
  op: "insert" | "merge" | "replace" | "upsert" | "delete";
  record: Record<string, unknown> | null;
}

/**
 * Service for managing serverSeq and change tracking
 *
 * When a sequenceStore is provided, serverSeq generation uses that store
 * (e.g., Redis for atomic INCR). Otherwise, falls back to the database
 * with CAS retry loop.
 */
export class ChangeTrackingService {
  private metaEnsured = false;
  private changesEnsured = false;

  constructor(
    private db: Adapter,
    private namespace: string = "datafn",
    private sequenceStore?: SequenceStore,
    private onChange?: (seq: number) => void,
  ) {}

  /**
   * Get and increment serverSeq atomically
   * Returns the next available serverSeq for this namespace
   *
   * Implements SERVER-SEQ-001: atomic monotonic increment per namespace
   *
   * When a sequenceStore is configured (Redis/KV), uses that for atomic increment.
   * Otherwise, uses compare-and-swap retry loop with the database.
   */
  async getNextServerSeq(): Promise<number> {
    return (await this.getNextServerSeqBatch(1))[0];
  }

  /**
   * Allocate a batch of contiguous serverSeq values atomically
   */
  async getNextServerSeqBatch(count: number): Promise<number[]> {
    if (this.sequenceStore) {
      return await this.sequenceStore.getNextN(this.namespace, count);
    }
    return await this.getNextServerSeqBatchFromDb(count);
  }

  /**
   * Database-based sequence generation using CAS retry loop
   * Used when no secondary database (Redis/KV) is configured
   */
  private async getNextServerSeqFromDb(): Promise<number> {
    return (await this.getNextServerSeqBatchFromDb(1))[0];
  }

  private async getNextServerSeqBatchFromDb(count: number): Promise<number[]> {
    if (!this.metaEnsured) {
      await ensureInternalTable(this.db, "__datafn_meta");
      this.metaEnsured = true;
    }

    const MAX_RETRIES = 10;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const meta = await this.db.internal.findOne("__datafn_meta", [
          { field: "namespace", op: "eq", value: this.namespace },
        ]);

        if (!meta) {
          try {
            await this.db.internal.create("__datafn_meta", {
              id: `meta:${this.namespace}`,
              namespace: this.namespace,
              next_server_seq: 1 + count,
            });
            return Array.from({ length: count }, (_, i) => 1 + i);
          } catch (createError) {
            continue;
          }
        } else {
          const currentSeq = (meta.next_server_seq as number) || 1;

          try {
            const affected = await this.db.internal.update(
              "__datafn_meta",
              [
                { field: "namespace", op: "eq", value: this.namespace },
                { field: "next_server_seq", op: "eq", value: currentSeq },
              ],
              { next_server_seq: currentSeq + count },
            );

            if (affected === 0) {
              continue;
            }

            return Array.from({ length: count }, (_, i) => currentSeq + i);
          } catch (updateError) {
            continue;
          }
        }
      } catch (error) {
        if (attempt === MAX_RETRIES - 1) {
          console.error(
            "Failed to get next serverSeq after max retries:",
            error,
          );
          throw new Error(
            "INTERNAL: Failed to allocate serverSeq after maximum retries",
          );
        }
      }
    }

    throw new Error(
      "INTERNAL: Failed to allocate serverSeq after maximum retries",
    );
  }

  /**
   * Record a change entry for a mutation (delegates to recordChanges)
   */
  async recordChange(params: ChangeEntryInput): Promise<void> {
    return this.recordChanges([params]);
  }

  /**
   * Record multiple change entries in a single call.
   * Ensures internal table once. Propagates errors immediately.
   */
  async recordChanges(entries: ChangeEntryInput[]): Promise<void> {
    if (entries.length === 0) return;

    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }

    for (const params of entries) {
      await this.db.internal.create("__datafn_changes", {
        id: `change:${this.namespace}:${params.serverSeq}:${params.resource}:${params.id}`,
        namespace: this.namespace,
        server_seq: params.serverSeq,
        resource: params.resource,
        record_id: params.id,
        op: params.op,
        record: params.record ? JSON.stringify(params.record) : null,
        created_at: new Date().toISOString(),
      });

      if (this.onChange) {
        this.onChange(params.serverSeq);
      }
    }
  }

  /**
   * Get the current global serverSeq (latest assigned)
   * Returns 0 if no sequence has been assigned yet
   */
  async getCurrentServerSeq(): Promise<number> {
    // Use sequence store if available
    if (this.sequenceStore) {
      try {
        return await this.sequenceStore.getCurrent(this.namespace);
      } catch (error) {
        console.warn("Sequence store getCurrent failed, falling back to database:", error);
      }
    }

    // Fallback to database
    if (!this.metaEnsured) {
      await ensureInternalTable(this.db, "__datafn_meta");
      this.metaEnsured = true;
    }

    try {
      const meta = await this.db.internal.findOne("__datafn_meta", [
        { field: "namespace", op: "eq", value: this.namespace },
      ]);

      if (!meta) {
        return 0;
      }
      return ((meta.next_server_seq as number) || 1) - 1;
    } catch (error) {
      console.error("Failed to get current serverSeq:", error);
      return 0;
    }
  }

  /**
   * Get global changes since a given serverSeq
   * Used for global pull (SYNC-PULL-001)
   */
  async getGlobalChanges(params: {
    sinceSeq: number;
    limit: number;
  }): Promise<ChangeEntry[]> {
    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }

    try {
      const changes = await this.db.internal.findMany(
        "__datafn_changes",
        [
          { field: "namespace", op: "eq", value: this.namespace },
          { field: "server_seq", op: "gt", value: params.sinceSeq },
        ],
        { orderBy: "server_seq", limit: params.limit },
      );

      return changes.map((change) => ({
        namespace: this.namespace,
        serverSeq: change.server_seq as number,
        resource: change.resource as string,
        id: change.record_id as string,
        op: change.op as "insert" | "merge" | "replace" | "upsert" | "delete",
        record: change.record ? JSON.parse(change.record as string) : null,
      }));
    } catch (error) {
      console.error("Failed to get global changes:", error);
      return [];
    }
  }

  /**
   * Get changes since a given serverSeq for a resource
   * When limit is provided, only that many entries are returned (bounded fetch).
   */
  async getChangesSince(params: {
    resource: string;
    sinceSeq: number;
    limit?: number;
  }): Promise<ChangeEntry[]> {
    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }

    try {
      const opts: { orderBy: string; limit?: number } = { orderBy: "server_seq" };
      if (params.limit != null && params.limit > 0) {
        opts.limit = params.limit;
      }

      const changes = await this.db.internal.findMany(
        "__datafn_changes",
        [
          { field: "namespace", op: "eq", value: this.namespace },
          { field: "resource", op: "eq", value: params.resource },
          { field: "server_seq", op: "gt", value: params.sinceSeq },
        ],
        opts,
      );

      return changes.map((change) => ({
        namespace: this.namespace,
        serverSeq: change.server_seq as number,
        resource: change.resource as string,
        id: change.record_id as string,
        op: change.op as "insert" | "merge" | "replace" | "upsert" | "delete",
        record: change.record ? JSON.parse(change.record as string) : null,
      }));
    } catch (error) {
      console.error("Failed to get changes since:", error);
      return [];
    }
  }

  /**
   * Delete change entries older than retentionDays for this namespace.
   * Returns the number of rows deleted.
   */
  async pruneChanges(retentionDays: number): Promise<number> {
    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    return await this.db.internal.delete("__datafn_changes", [
      { field: "namespace", op: "eq", value: this.namespace },
      { field: "created_at", op: "lt", value: cutoff },
    ]);
  }

  /**
   * Get the latest serverSeq for a resource
   * Returns 0 if no changes exist
   */
  async getLatestServerSeq(params: { resource: string }): Promise<number> {
    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }

    try {
      const changes = await this.db.internal.findMany(
        "__datafn_changes",
        [
          { field: "namespace", op: "eq", value: this.namespace },
          { field: "resource", op: "eq", value: params.resource },
        ],
        { orderBy: "-server_seq", limit: 1 },
      );

      return (changes[0]?.server_seq as number) ?? 0;
    } catch (error) {
      console.error("Failed to get latest serverSeq:", error);
      return 0;
    }
  }
}
