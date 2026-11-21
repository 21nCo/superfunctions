/**
 * Database-backed idempotency store
 * Provides durable mutation deduplication using adapter storage
 */

import type { Adapter } from "@superfunctions/db";
import {
  carryIdempotencyScope,
  idempotencyRecordId,
  markIdempotencyScope,
  isRetryableMutationResult,
  type IdempotencyScope,
  type IdempotencyStore,
  type MutationResult,
} from "./idempotency.js";
import { ensureInternalTable } from "./internal-tables.js";
import type { DatafnLogger } from "../logger.js";

/**
 * Adapter-backed idempotency store for durable deduplication
 */
export class DbIdempotencyStore implements IdempotencyStore {
  private ensured = false;
  private logger?: DatafnLogger;

  constructor(
    private db: Adapter,
    private namespace: string = "datafn",
    logger?: DatafnLogger,
    ensured = false,
    private actorId?: string,
  ) {
    this.logger = logger;
    this.ensured = ensured;
  }

  withDb(db: Adapter): IdempotencyStore {
    // The outer store performs initialization before transactional mutation
    // execution. Preserve that state so rebinding does not issue DDL inside a
    // transaction (which implicitly commits on MySQL).
    return carryIdempotencyScope(
      this,
      new DbIdempotencyStore(db, this.namespace, this.logger, this.ensured, this.actorId),
    );
  }

  /**
   * DFN-01: records are keyed by the request namespace and the actor, so the
   * same (clientId, mutationId) from another tenant or user is a new mutation.
   */
  scoped(scope: IdempotencyScope): IdempotencyStore {
    return markIdempotencyScope(this, scope, () =>
      new DbIdempotencyStore(this.db, scope.namespace, this.logger, this.ensured, scope.actorId),
    );
  }

  private recordId(clientId: string, mutationId: string): string {
    return idempotencyRecordId(this.namespace, this.actorId, clientId, mutationId);
  }

  async ensureReady(): Promise<void> {
    if (!this.ensured) {
      await ensureInternalTable(this.db, "__datafn_idempotency");
      this.ensured = true;
    }
  }

  async get(
    clientId: string,
    mutationId: string,
  ): Promise<MutationResult | null> {
    // EXE-007: DB errors propagate; only swallow JSON parse errors (SyntaxError)
    await this.ensureReady();

    // Looked up by the versioned primary key, so 0.2.x records never match.
    const record = await this.db.internal.findOne("__datafn_idempotency", [
      { field: "id", op: "eq", value: this.recordId(clientId, mutationId) },
    ]);

    if (!record) {
      return null;
    }

    // Only catch JSON parse errors; DB errors propagated above
    try {
      return JSON.parse(record.result as string);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        this.logger?.warn("Idempotency store get: unexpected error during parse", {
          error: String(error),
          operation: "idempotency-get",
        });
      }
      return null;
    }
  }

  /**
   * Delete idempotency records older than retentionDays for this namespace.
   * Returns the number of rows deleted.
   */
  async pruneIdempotency(retentionDays: number): Promise<number> {
    await this.ensureReady();
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    return await this.db.internal.delete("__datafn_idempotency", [
      { field: "namespace", op: "eq", value: this.namespace },
      { field: "created_at", op: "lt", value: cutoff },
    ]);
  }

  /**
   * Delete idempotency records older than retentionDays in every namespace.
   * Used by the server's retention pruner, since records are kept per tenant.
   */
  async pruneIdempotencyAllNamespaces(retentionDays: number): Promise<number> {
    await this.ensureReady();
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    return await this.db.internal.delete("__datafn_idempotency", [
      { field: "created_at", op: "lt", value: cutoff },
    ]);
  }

  async set(
    clientId: string,
    mutationId: string,
    result: MutationResult,
  ): Promise<void> {
    try {
      await this.ensureReady();

      const where = [
        { field: "id", op: "eq" as const, value: this.recordId(clientId, mutationId) },
      ];
      const existing = await this.db.internal.findOne(
        "__datafn_idempotency",
        where,
      );
      if (existing) {
        let existingResult: MutationResult | null = null;
        try {
          existingResult = JSON.parse(existing.result as string);
        } catch {
          existingResult = null;
        }
        if (!isRetryableMutationResult(existingResult)) return;
        await this.db.internal.update("__datafn_idempotency", where, {
          result: JSON.stringify(result),
          created_at: new Date().toISOString(),
        });
        return;
      }

      await this.db.internal.create("__datafn_idempotency", {
        id: this.recordId(clientId, mutationId),
        namespace: this.namespace,
        client_id: clientId,
        mutation_id: mutationId,
        result: JSON.stringify(result),
        created_at: new Date().toISOString(),
      });
    } catch (error: any) {
      // Duplicate key errors are expected on replay — stay silent
      const code = error?.code;
      const msg = (error?.message || "").toLowerCase();
      const isDuplicate =
        code === "23505" || code === "UNIQUE_VIOLATION" || code === "ER_DUP_ENTRY" ||
        code === "SQLITE_CONSTRAINT_UNIQUE" ||
        msg.includes("unique") || msg.includes("duplicate") || msg.includes("conflict");
      if (!isDuplicate) {
        this.logger?.warn("Idempotency store set failed (non-duplicate)", {
          error: String(error),
          operation: "idempotency-set",
        });
      }
    }
  }
}
