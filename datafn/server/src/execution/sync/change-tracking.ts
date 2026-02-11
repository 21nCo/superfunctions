/**
 * Change tracking service for serverSeq and change log management
 *
 * Implements monotonic serverSeq ordering per namespace and change tracking
 * for sync operations (SERVER-CONFLICT-001, SERVER-SYNC-001/002/003).
 *
 * Internal tables:
 * - __datafn_meta: stores nextServerSeq per namespace
 * - __datafn_changes: stores change entries with (namespace, resource, serverSeq) index
 *
 * Supports pluggable sequence stores (Redis, KV, or database fallback) for
 * high-performance serverSeq generation.
 */

import type { Adapter } from "@superfunctions/db";
import type { SequenceStore } from "./sequence-store.js";

/**
 * Change entry representing a mutation effect
 */
export interface ChangeEntry {
  namespace: string;
  serverSeq: number;
  resource: string;
  id: string;
  op: "upsert" | "delete";
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
    // Use sequence store if available (Redis/KV for atomic increment)
    if (this.sequenceStore) {
      return await this.sequenceStore.getNext(this.namespace);
    }

    // Fallback to database with CAS retry loop
    return await this.getNextServerSeqFromDb();
  }

  /**
   * Database-based sequence generation using CAS retry loop
   * Used when no secondary database (Redis/KV) is configured
   */
  private async getNextServerSeqFromDb(): Promise<number> {
    const MAX_RETRIES = 10;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        // Try to find existing meta record
        const meta = await this.db.findOne({
          model: "__datafn_meta",
          where: [
            { field: "namespace", operator: "eq", value: this.namespace },
          ],
          namespace: this.namespace,
        });

        if (!meta) {
          // Initialize meta record with nextServerSeq = 1
          // This may fail due to concurrent initialization - that's ok, we'll retry
          try {
            await this.db.create({
              model: "__datafn_meta",
              data: {
                id: `meta:${this.namespace}`,
                namespace: this.namespace,
                nextServerSeq: 2, // Next one will be 2
              },
              namespace: this.namespace,
            });
            // Successfully initialized - return 1
            return 1;
          } catch (createError) {
            // Concurrent create detected - retry to read the created record
            continue;
          }
        } else {
          // Read current value
          const currentSeq = (meta.nextServerSeq as number) || 1;

          // Attempt atomic update using where clause as CAS check
          // Note: This assumes the adapter supports conditional updates
          // For memory adapter, this is synchronous and atomic
          try {
            await this.db.update({
              model: "__datafn_meta",
              where: [
                { field: "namespace", operator: "eq", value: this.namespace },
                { field: "nextServerSeq", operator: "eq", value: currentSeq },
              ],
              data: {
                nextServerSeq: currentSeq + 1,
              },
              namespace: this.namespace,
            });

            // Update succeeded - return the allocated sequence
            return currentSeq;
          } catch (updateError) {
            // Update failed (concurrent modification) - retry
            continue;
          }
        }
      } catch (error) {
        // On last attempt, throw deterministic INTERNAL error
        if (attempt === MAX_RETRIES - 1) {
          console.error(
            "Failed to get next serverSeq after max retries:",
            error,
          );
          throw new Error(
            "INTERNAL: Failed to allocate serverSeq after maximum retries",
          );
        }
        // Otherwise retry
      }
    }

    // Should never reach here due to loop, but TypeScript needs this
    throw new Error(
      "INTERNAL: Failed to allocate serverSeq after maximum retries",
    );
  }

  /**
   * Record a change entry for a mutation
   */
  async recordChange(params: {
    serverSeq: number;
    resource: string;
    id: string;
    op: "upsert" | "delete";
    record: Record<string, unknown> | null;
  }): Promise<void> {
    try {
      await this.db.create({
        model: "__datafn_changes",
        data: {
          id: `change:${this.namespace}:${params.serverSeq}:${params.resource}:${params.id}`,
          namespace: this.namespace,
          serverSeq: params.serverSeq,
          resource: params.resource,
          recordId: params.id,
          op: params.op,
          record: params.record ? JSON.stringify(params.record) : null,
          createdAt: new Date().toISOString(),
        },
        namespace: this.namespace,
      });

      // Notify callback if present
      if (this.onChange) {
        this.onChange(params.serverSeq);
      }
    } catch (error) {
      // Log but don't throw - change tracking errors shouldn't block mutations
      console.error("Failed to record change:", error);
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
    try {
      const meta = await this.db.findOne({
        model: "__datafn_meta",
        where: [{ field: "namespace", operator: "eq", value: this.namespace }],
        namespace: this.namespace,
      });

      if (!meta) {
        return 0;
      }
      return ((meta.nextServerSeq as number) || 1) - 1;
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
    try {
      const changes = await this.db.findMany({
        model: "__datafn_changes",
        where: [
          { field: "namespace", operator: "eq", value: this.namespace },
          { field: "serverSeq", operator: "gt", value: params.sinceSeq },
        ],
        orderBy: [{ field: "serverSeq", direction: "asc" }],
        limit: params.limit,
        namespace: this.namespace,
      });

      return changes.map((change) => ({
        namespace: this.namespace,
        serverSeq: change.serverSeq as number,
        resource: change.resource as string,
        id: change.recordId as string,
        op: change.op as "upsert" | "delete",
        record: change.record ? JSON.parse(change.record as string) : null,
      }));
    } catch (error) {
      console.error("Failed to get global changes:", error);
      return [];
    }
  }

  /**
   * Get changes since a given serverSeq for a resource
   */
  async getChangesSince(params: {
    resource: string;
    sinceSeq: number;
  }): Promise<ChangeEntry[]> {
    try {
      const changes = await this.db.findMany({
        model: "__datafn_changes",
        where: [
          { field: "namespace", operator: "eq", value: this.namespace },
          { field: "resource", operator: "eq", value: params.resource },
          { field: "serverSeq", operator: "gt", value: params.sinceSeq },
        ],
        orderBy: [{ field: "serverSeq", direction: "asc" }],
        namespace: this.namespace,
      });

      return changes.map((change) => ({
        namespace: this.namespace,
        serverSeq: change.serverSeq as number,
        resource: change.resource as string,
        id: change.recordId as string,
        op: change.op as "upsert" | "delete",
        record: change.record ? JSON.parse(change.record as string) : null,
      }));
    } catch (error) {
      console.error("Failed to get changes since:", error);
      return [];
    }
  }

  /**
   * Get the latest serverSeq for a resource
   * Returns 0 if no changes exist
   */
  async getLatestServerSeq(params: { resource: string }): Promise<number> {
    try {
      const changes = await this.db.findMany({
        model: "__datafn_changes",
        where: [
          { field: "namespace", operator: "eq", value: this.namespace },
          { field: "resource", operator: "eq", value: params.resource },
        ],
        orderBy: [{ field: "serverSeq", direction: "desc" }],
        limit: 1,
        namespace: this.namespace,
      });

      if (changes.length === 0) {
        return 0;
      }

      return (changes[0].serverSeq as number) || 0;
    } catch (error) {
      console.error("Failed to get latest serverSeq:", error);
      return 0;
    }
  }
}
