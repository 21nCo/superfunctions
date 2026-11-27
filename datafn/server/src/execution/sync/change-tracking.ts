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
 * Supports pluggable sequence stores (atomic store or database sequence path) for
 * high-performance serverSeq generation.
 */

import type { Adapter } from "@superfunctions/db";
import type { InternalWhereClause } from "@superfunctions/db/types";
import type { SequenceStore } from "./sequence-store.js";
import { adapterIdentity, ensureChangesRevColumn, ensureInternalTable } from "../internal-tables.js";
import { assignWriteRevisions, ensureRevisionsTable, issuesRevisions, revisionsEnabled } from "../revisions.js";
import type { DatafnSchema } from "../../core-types.js";
import type { DatafnLogger } from "../../logger.js";
import { withAdapterNamespaceLock } from "./namespace-lock.js";

/** REL-010: Sleep helper for CAS backoff */
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * FIX-REL-002: runs one change-tracking step with up to `maxRetries` retries
 * (50ms/100ms backoff), and throws the last failure so the caller treats the
 * mutation as failed.
 *
 * DATA-41: only outside a database transaction. A service recording inside
 * the write's transaction makes one attempt: a failed statement may have
 * aborted that transaction (PostgreSQL), so the failure propagates, the whole
 * write rolls back, and the mutation stays retryable under its id. Outside a
 * transaction the write has committed and is never replayed: the same entries
 * are assigned and recorded again, keeping the revisions already raised.
 */
async function withChangeRetry(
  changeTracking: ChangeTrackingService,
  step: () => Promise<void>,
  maxRetries: number,
  logger: DatafnLogger | undefined,
  message: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const retries = changeTracking.inTransaction ? 0 : maxRetries;
  for (let i = 0; ; i++) {
    try {
      await step();
      return;
    } catch (e) {
      if (i >= retries) throw e;
      logger?.warn(message, { attempt: i + 1, maxRetries, ...context, error: String(e) });
      await sleep(50 * (i + 1)); // 50ms, 100ms
    }
  }
}

/**
 * FIX-REL-002: Shared retry helper for change-tracking writes.
 * Used by both execute-mutation and push paths for parity.
 */
export async function recordChangeWithRetry(
  changeTracking: ChangeTrackingService,
  params: ChangeEntryInput,
  maxRetries = 2,
  logger?: DatafnLogger,
): Promise<void> {
  await withChangeRetry(changeTracking, () => changeTracking.recordChange(params), maxRetries, logger, "Change tracking retry");
}

/**
 * FIX-REL-002: Shared retry helper for bulk change-tracking writes.
 */
export async function recordChangesWithRetry(
  changeTracking: ChangeTrackingService,
  entries: ChangeEntryInput[],
  maxRetries = 2,
  logger?: DatafnLogger,
): Promise<void> {
  if (entries.length === 0) return;
  await withChangeRetry(
    changeTracking,
    () => changeTracking.recordChanges(entries),
    maxRetries,
    logger,
    "Change tracking retry (bulk)",
    { entryCount: entries.length },
  );
}

/**
 * DATA-41: records one write's change entries one by one, after raising the
 * revisions of the records they change (on the evidence `writeDb` recorded).
 * Assignment has its own retries (a retry raises no record twice), then each
 * entry, in serverSeq order as base recorded them, has its own (a retry
 * records no entry twice; see recordChanges), so a failing entry never
 * spends another entry's retries (see withChangeRetry). Outside a
 * transaction every entry is attempted before the first failure is thrown,
 * and `onRecorded` names each entry stored. Only the entries in `record` are
 * recorded when it is given: the others (changes left without a sequence)
 * still raise their records' revisions.
 */
export async function recordWriteChangesWithRetry(
  changeTracking: ChangeTrackingService,
  entries: ChangeEntryInput[],
  /** The write's evidence adapter; the service's own adapter when undefined. */
  writeDb: Adapter | undefined,
  maxRetries = 2,
  logger?: DatafnLogger,
  options: { record?: ReadonlySet<ChangeEntryInput>; onRecorded?: (entry: ChangeEntryInput) => void } = {},
): Promise<void> {
  await withChangeRetry(
    changeTracking,
    () => changeTracking.assignRevisions(entries, writeDb),
    maxRetries,
    logger,
    "Revision assignment retry",
    { entryCount: entries.length },
  );
  let failure: { error: unknown } | undefined;
  for (const entry of entries) {
    if (options.record && !options.record.has(entry)) continue;
    try {
      await recordChangeWithRetry(changeTracking, entry, maxRetries, logger);
    } catch (error) {
      if (changeTracking.inTransaction) throw error;
      failure ??= { error };
      continue;
    }
    options.onRecorded?.(entry);
  }
  if (failure) throw failure.error;
}

/** DATA-41: change entries whose insert was sent (see unstoredChanges). */
const sentChanges = new WeakSet<ChangeEntryInput>();

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
  /** DATA-41: the record's revision after this change; absent on rows written without one. */
  rev?: number;
  /**
   * DATA-41: set when the writer committed this change together with `rev`
   * (in one database transaction), so `record` is the stored state at `rev`.
   * Absent on rows written without that guarantee or before it was recorded.
   */
  certified?: true;
}

/** DATA-41: a change row's revision and its write-time provenance, when it recorded one. */
function storedRev(row: Record<string, unknown>): { rev?: number; certified?: true } {
  const rev = row.rev === null || row.rev === undefined ? Number.NaN : Number(row.rev);
  if (!Number.isInteger(rev) || rev <= 0) return {};
  return Number(row.rev_certified) === 1 ? { rev, certified: true } : { rev };
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
  /**
   * DATA-41: set by `recordChanges` on a record's last entry of a write to
   * the record's revision after that write. A retry of the same entries
   * reuses it instead of bumping again.
   */
  rev?: number;
  /** DATA-41: the revision was raised from a possibly stale view; the change row is not certified. */
  revUncertified?: boolean;
}

/**
 * Namespaces whose `__datafn_meta` row is known to exist, per base adapter.
 * Services are created per request, so the cache lives with the adapter rather
 * than the service; after a namespace's first write, preparing it costs no
 * query. A stale entry (for example after the row is deleted) is harmless:
 * allocation falls back to creating the row itself.
 */
const preparedNamespaces = new WeakMap<object, Set<string>>();

/**
 * Service for managing serverSeq and change tracking
 *
 * When a sequenceStore is provided, serverSeq generation uses that store
   * (e.g., a distributed atomic store). Otherwise, uses the database
 * with CAS retry loop.
 */
export class ChangeTrackingService {
  private metaEnsured = false;
  private changesEnsured = false;
  private namespaceMetaEnsured = false;
  private revisionsEnsured = false;
  private revColumnReady = false;
  private transactionBound = false;
  /**
   * DATA-41: this service records changes inside a database transaction that
   * also commits the write and its revisions (set by `withDb`), so the rows it
   * records are certified as the state at their revision.
   */
  private writesCertified = false;

  /** DATA-41: whether this service records inside the write's database transaction. */
  get inTransaction(): boolean {
    return this.writesCertified;
  }
  /**
   * DATA-41: record each change's revision on its change row. Set from the
   * server's `revisions.enabled` option; revisions are bumped either way.
   */
  issueRevisions = false;
  /** DATA-41: the schema whose resources get revisions issued (see useRevisionsOf). */
  private revisionSchema?: DatafnSchema;

  /** DATA-41: issues revisions as `schema`'s server option says. */
  useRevisionsOf(schema: DatafnSchema): this {
    this.revisionSchema = schema;
    this.issueRevisions = revisionsEnabled(schema);
    return this;
  }

  constructor(
    private db: Adapter,
    readonly namespace: string = "datafn",
    private sequenceStore?: SequenceStore,
    private onChange?: (seq: number, namespace: string) => void,
    private logger?: DatafnLogger,
    metaEnsured = false,
    changesEnsured = false,
    namespaceMetaEnsured = false,
  ) {
    this.metaEnsured = metaEnsured;
    this.changesEnsured = changesEnsured;
    this.namespaceMetaEnsured = namespaceMetaEnsured;
  }

  /** Initialize every durable table before an enclosing transaction begins. */
  async ensureReady(): Promise<void> {
    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }

    if (this.sequenceStore) {
      await this.sequenceStore.ensureReady?.();
    }
    // The service can fall back to its database sequence path if an external
    // store fails, so its own metadata table must also exist before rebinding.
    if (!this.metaEnsured) {
      await ensureInternalTable(this.db, "__datafn_meta");
      this.metaEnsured = true;
    }
    await this.ensureNamespaceMeta();
    if (this.issueRevisions && !this.revColumnReady) {
      this.revColumnReady = await ensureChangesRevColumn(this.db);
    }
  }

  /**
   * DATA-41: creates `__datafn_revisions` before an enclosing transaction
   * begins (some databases implicitly commit DDL). Write paths call this next
   * to `ensureReady`; a service that is not transaction-bound also creates
   * the table on its first recorded change.
   */
  async ensureRevisionsReady(): Promise<void> {
    if (!this.revisionsEnsured) {
      await ensureRevisionsTable(this.db);
      this.revisionsEnsured = true;
    }
    // Change rows record revisions only once their column exists, which
    // needs the changes table first (D1 and SQLite reject an ALTER of a
    // missing table). Services bound with `withDb` inherit both.
    if (this.issueRevisions && !this.revColumnReady && !this.transactionBound) {
      if (!this.changesEnsured) {
        await ensureInternalTable(this.db, "__datafn_changes");
        this.changesEnsured = true;
      }
      this.revColumnReady = await ensureChangesRevColumn(this.db);
    }
  }

  /**
   * Creates this namespace's `__datafn_meta` row before an enclosing
   * transaction begins. Sequence allocation otherwise creates the row inside
   * the transaction on a namespace's first write, and when two first writes
   * race, the losing INSERT fails with a unique-key conflict. On PostgreSQL that
   * aborts the whole transaction, so the recovery read that follows fails with
   * "current transaction is aborted". Outside a transaction the conflict is
   * harmless: the row exists either way, and later allocations only read and
   * CAS-update it. Transaction-bound instances (from `withDb`) never prepare
   * the row; the base instance does so before the transaction opens.
   */
  private async ensureNamespaceMeta(): Promise<void> {
    if (this.namespaceMetaEnsured) {
      return;
    }
    let prepared = preparedNamespaces.get(adapterIdentity(this.db));
    if (!prepared) {
      prepared = new Set<string>();
      preparedNamespaces.set(adapterIdentity(this.db), prepared);
    }
    if (prepared.has(this.namespace)) {
      this.namespaceMetaEnsured = true;
      return;
    }
    const where = [{ field: "namespace", op: "eq" as const, value: this.namespace }];
    if (!(await this.db.internal.findOne("__datafn_meta", where))) {
      try {
        await this.db.internal.create("__datafn_meta", {
          id: `meta:${this.namespace}`,
          namespace: this.namespace,
          next_server_seq: 1,
        });
      } catch (error) {
        if (!(await this.db.internal.findOne("__datafn_meta", where))) {
          throw error;
        }
      }
    }
    prepared.add(this.namespace);
    this.namespaceMetaEnsured = true;
  }

  /**
   * REL-011: Create a new ChangeTrackingService with a different db adapter.
   * Used to run change tracking within a transaction (pass tx db here).
   * The namespace and sequenceStore are inherited from the original instance.
   * DATA-41: pass `inTransaction` only when `txDb` is a database transaction
   * that commits the write, its revisions and its change rows together; only
   * then do change rows certify their row as the state at their revision.
   */
  withDb(txDb: Adapter, emitChanges = true, inTransaction = false): ChangeTrackingService {
    const sequenceStore = this.sequenceStore?.withDb?.(txDb) ?? this.sequenceStore;
    const bound = new ChangeTrackingService(
      txDb,
      this.namespace,
      sequenceStore,
      emitChanges ? this.onChange : undefined,
      this.logger,
      this.metaEnsured,
      this.changesEnsured,
      true,
    );
    bound.issueRevisions = this.issueRevisions;
    bound.revisionSchema = this.revisionSchema;
    bound.transactionBound = true;
    bound.writesCertified = inTransaction;
    bound.revisionsEnsured = this.revisionsEnsured;
    bound.revColumnReady = this.revColumnReady;
    return bound;
  }

  /**
   * Get and increment serverSeq atomically
   * Returns the next available serverSeq for this namespace
   *
   * Implements SERVER-SEQ-001: atomic monotonic increment per namespace
   *
   * When a sequenceStore is configured, uses that for atomic increment.
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
   * Used when no atomic sequence store is configured
   */
  private async getNextServerSeqFromDb(): Promise<number> {
    return (await this.getNextServerSeqBatchFromDb(1))[0];
  }

  private async getNextServerSeqBatchFromDb(count: number): Promise<number[]> {
    return await withAdapterNamespaceLock(this.db, this.namespace, async () => {
      if (!this.metaEnsured) {
        await ensureInternalTable(this.db, "__datafn_meta");
        this.metaEnsured = true;
      }

      const MAX_RETRIES = 10;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        // REL-010: Exponential backoff between CAS retries (skip delay on first attempt)
        if (attempt > 0) {
          await sleep(10 * Math.pow(2, attempt - 1));
        }
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
                // REL-010: CAS failed due to contention — backoff applied on next iteration
                continue;
              }

              return Array.from({ length: count }, (_, i) => currentSeq + i);
            } catch (updateError) {
              continue;
            }
          }
        } catch (error) {
          if (attempt === MAX_RETRIES - 1) {
            this.logger?.error("Failed to get next serverSeq after max retries", {
              error: String(error),
              operation: "getNextServerSeqBatchFromDb",
              resource: "__datafn_meta",
            });
            throw new Error(
              "INTERNAL: Failed to allocate serverSeq after maximum retries",
            );
          }
          this.logger?.warn("Sequence batch CAS retry", {
            attempt,
            error: String(error),
            operation: "seq-batch-cas",
          });
        }
      }

      throw new Error(
        "INTERNAL: Failed to allocate serverSeq after maximum retries",
      );
    });
  }

  /**
   * DATA-41: raises the revision of each record the entries of one write
   * change, once per record, and sets it on the record's last entry (see
   * assignWriteRevisions). Recording entries already assigned does not bump
   * again, so a caller recording one write's entries one by one assigns them
   * first.
   */
  async assignRevisions(entries: ChangeEntryInput[], writeDb: Adapter = this.db): Promise<void> {
    // Inside a transaction the table and column are only used when they were
    // ensured before the transaction began; change rows then record no
    // revision.
    if (!this.transactionBound) await this.ensureRevisionsReady();
    const recordRev = this.issueRevisions && this.revColumnReady;
    const schema = this.revisionSchema;
    // A change row carrying a revision records the stored row of a resource
    // the schema issues revisions for, but only when the write commits
    // together with its revision: otherwise another write may land before
    // the row is read, so the change keeps its own payload.
    const certified = this.writesCertified;
    await assignWriteRevisions(
      writeDb,
      this.namespace,
      entries,
      (resource) => certified && recordRev && schema !== undefined && issuesRevisions(schema, resource),
      schema,
      certified,
    );
  }

  /** A change entry's row id, derived from the entry alone. */
  private changeRowId(params: ChangeEntryInput): string {
    return `change:${this.namespace}:${params.serverSeq}:${params.resource}:${params.id}`;
  }

  /**
   * DATA-41: the entries whose rows are not stored yet. Outside a
   * transaction an insert that failed may have stored its rows before the
   * adapter failed (a lost acknowledgement), so an entry sent before is
   * looked up by its row id and never inserted twice.
   */
  private async unstoredChanges(entries: ChangeEntryInput[]): Promise<ChangeEntryInput[]> {
    if (this.writesCertified) return entries;
    const unstored: ChangeEntryInput[] = [];
    for (const entry of entries) {
      const stored = sentChanges.has(entry) &&
        (await this.db.internal.findOne("__datafn_changes", [{ field: "id", op: "eq", value: this.changeRowId(entry) }]));
      if (!stored) unstored.push(entry);
    }
    return unstored;
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
   *
   * EXE-018: Uses batched write path when internal.createMany is available.
   * Uses deterministic sequential inserts otherwise.
   */
  async recordChanges(entries: ChangeEntryInput[]): Promise<void> {
    if (entries.length === 0) return;

    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }

    // DATA-41: unless the caller assigned them for a larger write, the
    // entries are one committed write (when this adapter's transaction
    // commits), which raises each changed record's revision once.
    await this.assignRevisions(entries);
    const recordRev = this.issueRevisions && this.revColumnReady;
    const schema = this.revisionSchema;
    // A change row records a revision only when the resource issued
    // revisions when it was written, and records whether the write committed
    // together with it (`rev_certified`): only then is the record the stored
    // row read in the write (or a patch or delete whose revision alone is
    // sent). A resource with its own `$rev` field records
    // none, so its payloads are never read as certified rows later.
    const certifiesRecord = (resource: string): boolean =>
      recordRev && schema !== undefined && issuesRevisions(schema, resource);

    const unstored = await this.unstoredChanges(entries);
    const now = new Date().toISOString();
    const rows = unstored.map((params) => ({
      id: this.changeRowId(params),
      namespace: this.namespace,
      server_seq: params.serverSeq,
      resource: params.resource,
      record_id: params.id,
      op: params.op,
      record: params.record ? JSON.stringify(params.record) : null,
      created_at: now,
      ...(params.rev !== undefined && certifiesRecord(params.resource)
        ? { rev: params.rev, rev_certified: this.writesCertified && !params.revUncertified ? 1 : 0 }
        : {}),
    }));

    // EXE-018: Batch capability detection — use createMany when available
    const hasBatchCapability = typeof this.db.internal.createMany === "function";

    for (const entry of unstored) sentChanges.add(entry);
    // With no rows left, every row was stored by an earlier attempt.
    if (rows.length > 0 && hasBatchCapability) {
      this.logger?.debug("recordChanges: using batch insert path", {
        operation: "recordChanges",
        entryCount: entries.length,
      });
      await this.db.internal.createMany!("__datafn_changes", rows);
    } else if (rows.length > 0) {
      this.logger?.debug("recordChanges: batch insert unavailable, using sequential path", {
        operation: "recordChanges",
        entryCount: entries.length,
      });
      // Sequential to preserve error-stops-further-writes semantics
      for (const row of rows) {
        await this.db.internal.create("__datafn_changes", row);
      }
    }

    // Fire onChange callbacks after all writes succeed
    if (this.onChange) {
      for (const params of entries) {
        this.onChange(params.serverSeq, this.namespace);
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
        this.logger?.warn("Sequence store getCurrent failed, using database sequence path", {
          error: String(error),
          operation: "getCurrentServerSeq",
        });
      }
    }

    // Database sequence path
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
      // EXE-019: Throw instead of returning 0 (returning 0 would silently mis-sync clients)
      this.logger?.error("Failed to get current serverSeq", {
        error: String(error),
        operation: "getCurrentServerSeq",
        resource: "__datafn_meta",
      });
      throw error;
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
        ...storedRev(change),
      }));
    } catch (error) {
      // Propagate error — returning empty would make client believe it's fully synced
      this.logger?.error("Failed to get global changes", {
        error: String(error),
        operation: "getGlobalChanges",
        resource: "__datafn_changes",
      });
      throw error;
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
        ...storedRev(change),
      }));
    } catch (error) {
      // Propagate error instead of returning empty (which would imply "no changes")
      this.logger?.error("Failed to get changes since", {
        error: String(error),
        operation: "getChangesSince",
        resource: params.resource,
      });
      throw error;
    }
  }

  /**
   * Get global changes after `sinceSeq` filtered to a set of resources.
   * Used by actor-feed sync logic to process permissions/membership/hierarchy updates.
   */
  async getChangesForResourcesSince(params: {
    resources: string[];
    sinceSeq: number;
    limit?: number;
  }): Promise<ChangeEntry[]> {
    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }
    if (!Array.isArray(params.resources) || params.resources.length === 0) {
      return [];
    }
    try {
      const rows = await this.db.internal.findMany(
        "__datafn_changes",
        [
          { field: "namespace", op: "eq", value: this.namespace },
          { field: "server_seq", op: "gt", value: params.sinceSeq },
          { field: "resource", op: "in" as any, value: params.resources },
        ],
        {
          orderBy: "server_seq",
          ...(typeof params.limit === "number" && params.limit > 0
            ? { limit: params.limit }
            : {}),
        },
      );
      return rows.map((change) => ({
          namespace: this.namespace,
          serverSeq: change.server_seq as number,
          resource: change.resource as string,
          id: change.record_id as string,
          op: change.op as "insert" | "merge" | "replace" | "upsert" | "delete",
          record: change.record ? JSON.parse(change.record as string) : null,
        ...storedRev(change),
        }));
    } catch (error) {
      this.logger?.error("Failed to get resource-filtered changes", {
        error: String(error),
        operation: "getChangesForResourcesSince",
        resource: "__datafn_changes",
      });
      throw error;
    }
  }

  /**
   * Get latest change entry for a resource/id at or before a given serverSeq.
   */
  async getLatestChangeForRecord(params: {
    resource: string;
    id: string;
    atOrBeforeSeq?: number;
  }): Promise<ChangeEntry | null> {
    if (!this.changesEnsured) {
      await ensureInternalTable(this.db, "__datafn_changes");
      this.changesEnsured = true;
    }
    try {
      const where: InternalWhereClause[] = [
        { field: "namespace", op: "eq", value: this.namespace },
        { field: "resource", op: "eq", value: params.resource },
        { field: "record_id", op: "eq", value: params.id },
      ];
      if (typeof params.atOrBeforeSeq === "number") {
        where.push({
          field: "server_seq",
          op: "lte",
          value: params.atOrBeforeSeq,
        });
      }
      const rows = await this.db.internal.findMany(
        "__datafn_changes",
        where,
        { orderBy: "-server_seq", limit: 1 },
      );
      const change = rows[0];
      if (!change) {
        return null;
      }
      return {
        namespace: this.namespace,
        serverSeq: change.server_seq as number,
        resource: change.resource as string,
        id: change.record_id as string,
        op: change.op as "insert" | "merge" | "replace" | "upsert" | "delete",
        record: change.record ? JSON.parse(change.record as string) : null,
        ...storedRev(change),
      };
    } catch (error) {
      this.logger?.error("Failed to get latest change for record", {
        error: String(error),
        operation: "getLatestChangeForRecord",
        resource: params.resource,
      });
      throw error;
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
      this.logger?.error("Failed to get latest serverSeq", {
        error: String(error),
        operation: "getLatestServerSeq",
        resource: params.resource,
      });
      throw error;
    }
  }
}
