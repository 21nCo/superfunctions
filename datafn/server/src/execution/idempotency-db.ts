/**
 * Database-backed idempotency store
 * Provides durable mutation deduplication using adapter storage
 */

import type { Adapter } from "@superfunctions/db";
import type { IdempotencyStore, MutationResult } from "./idempotency.js";
import { ensureInternalTable } from "./internal-tables.js";

/**
 * Adapter-backed idempotency store for durable deduplication
 */
export class DbIdempotencyStore implements IdempotencyStore {
  private ensured = false;

  constructor(
    private db: Adapter,
    private namespace: string = "datafn",
  ) {}

  async get(
    clientId: string,
    mutationId: string,
  ): Promise<MutationResult | null> {
    // EXE-007: DB errors propagate; only swallow JSON parse errors (SyntaxError)
    if (!this.ensured) {
      await ensureInternalTable(this.db, "__datafn_idempotency");
      this.ensured = true;
    }

    const record = await this.db.internal.findOne("__datafn_idempotency", [
      { field: "namespace", op: "eq", value: this.namespace },
      { field: "client_id", op: "eq", value: clientId },
      { field: "mutation_id", op: "eq", value: mutationId },
    ]);

    if (!record) {
      return null;
    }

    // Only catch JSON parse errors; DB errors propagated above
    try {
      return JSON.parse(record.result as string);
    } catch {
      // Malformed JSON in stored result — treat as cache miss
      return null;
    }
  }

  /**
   * Delete idempotency records older than retentionDays for this namespace.
   * Returns the number of rows deleted.
   */
  async pruneIdempotency(retentionDays: number): Promise<number> {
    if (!this.ensured) {
      await ensureInternalTable(this.db, "__datafn_idempotency");
      this.ensured = true;
    }
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    return await this.db.internal.delete("__datafn_idempotency", [
      { field: "namespace", op: "eq", value: this.namespace },
      { field: "created_at", op: "lt", value: cutoff },
    ]);
  }

  async set(
    clientId: string,
    mutationId: string,
    result: MutationResult,
  ): Promise<void> {
    try {
      if (!this.ensured) {
        await ensureInternalTable(this.db, "__datafn_idempotency");
        this.ensured = true;
      }

      await this.db.internal.create("__datafn_idempotency", {
        id: `${this.namespace}:${clientId}:${mutationId}`,
        namespace: this.namespace,
        client_id: clientId,
        mutation_id: mutationId,
        result: JSON.stringify(result),
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      // Silently fail - idempotency is best-effort
      // Duplicate key errors are expected on replay
    }
  }
}
