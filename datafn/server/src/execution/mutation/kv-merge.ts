/**
 * Server-side merge semantics for the built-in KV resource.
 *
 * `kv.merge(key, patch)` sends `operation: "merge"` with `record: { value: patch }`.
 * The stored value must keep every top-level key earlier merges wrote, exactly
 * as the client's `mergeRecord` does locally, so the merge reads the stored
 * value and writes `{ ...stored, ...patch }` atomically per record.
 */

import { KV_RESOURCE_NAME } from "@datafn/core";
import type { Adapter, WhereClause } from "@superfunctions/db";
import { isNotFoundError } from "./merge-decision.js";
import type { ChangeEntryInput } from "../sync/change-tracking.js";

/**
 * `kv.set` is also sent as a `merge` operation with `record: { value }`
 * (datafn/client/src/kv.ts). Released clients mark it only by this mutation id
 * prefix; such writes keep their replace semantics.
 */
export const KV_SET_MUTATION_ID_PREFIX = "kv-set-";

/**
 * Bound on compare-and-swap attempts for adapters without transactions. Each
 * miss means another writer changed the value in between, so this is only
 * reached under sustained contention on one record.
 */
const KV_MERGE_MAX_ATTEMPTS = 16;

/**
 * A KV merge whose conditional writes all missed because other writers kept
 * changing the record. Nothing was written, and the same merge can succeed
 * when retried, so callers report it as retryable.
 */
export class KvMergeContentionError extends Error {
  readonly retryable = true;

  constructor(id: string) {
    super(`KV merge of ${id} did not settle after ${KV_MERGE_MAX_ATTEMPTS} concurrent attempts`);
    this.name = "KvMergeContentionError";
  }
}

/** True for a KV merge that gave up under contention (see KvMergeContentionError). */
export function isKvMergeContentionError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "KvMergeContentionError";
}

/**
 * Misses in a row, each with the stored value unchanged when read again, after
 * which the adapter is taken to be unable to compare the value column.
 */
const KV_MERGE_MAX_UNCHANGED_MISSES = 3;

/**
 * The adapter cannot make the conditional write a KV merge needs without
 * transactions: its update never matched the value it had just returned (for
 * example it compares JSON objects by identity) or updateMany returned no row
 * count. Nothing was written, and retrying cannot help.
 */
export class KvMergeUnsupportedError extends Error {
  constructor(reason: string) {
    super(`KV merge is not supported by this adapter without transactions: ${reason}`);
    this.name = "KvMergeUnsupportedError";
  }
}

/** True when the adapter cannot run a KV merge (see KvMergeUnsupportedError). */
export function isKvMergeUnsupportedError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "KvMergeUnsupportedError";
}

/** Order-independent JSON equality, to tell a changed value from a missed compare. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJsonValue(item, right[index]))
    );
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key]),
    )
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notFound(): { name: string; message: string } {
  return { name: "NotFoundError", message: "Record not found" };
}

/**
 * True when a mutation merges a partial value into a KV record: a `merge` on
 * the KV resource that carries `value` and is not a `kv.set`.
 */
export function isKvValueMerge(mutation: {
  resource?: unknown;
  operation?: unknown;
  mutationId?: unknown;
  record?: unknown;
}): boolean {
  return (
    mutation.resource === KV_RESOURCE_NAME &&
    mutation.operation === "merge" &&
    isPlainObject(mutation.record) &&
    Object.prototype.hasOwnProperty.call(mutation.record, "value") &&
    !(
      typeof mutation.mutationId === "string" &&
      mutation.mutationId.startsWith(KV_SET_MUTATION_ID_PREFIX)
    )
  );
}

/**
 * Top-level merge with the client's `mergeRecord` semantics: when both the
 * stored value and the patch are plain objects the patch keys win and every
 * other stored key survives; nested objects are replaced whole. Otherwise the
 * patch replaces the stored value.
 */
export function mergeKvValue(stored: unknown, patch: unknown): unknown {
  if (!isPlainObject(stored) || !isPlainObject(patch)) {
    return patch;
  }
  return { ...stored, ...patch };
}

/** True when the adapter declares database transactions and exposes them. */
function supportsTransactions(db: Adapter): boolean {
  return (
    db.capabilities?.transactions?.supported !== false &&
    typeof db.transaction === "function"
  );
}

/**
 * True for an adapter that exposes transactions but refuses this call, such as
 * Drizzle on SQLite rejecting async callbacks (the same signals push.ts uses).
 */
function isTransactionUnsupportedError(error: unknown): boolean {
  if ((error as { name?: unknown })?.name === "OperationNotSupportedError") return true;
  const message = String((error as { message?: unknown })?.message ?? error).toLowerCase();
  return (
    message.includes("cannot return a promise") ||
    message.includes("not supported") ||
    message.includes("not implemented")
  );
}

/**
 * Update an existing KV record, merging `data.value` into the stored value.
 * Returns the data written, whose `value` is the complete merged value.
 * Throws a NotFoundError when the record does not exist so the caller can
 * create it with the patch.
 *
 * Atomicity per record:
 * - On an adapter with transactions, a no-op update first takes the row lock,
 *   so the read and the write cannot interleave with another merge of the
 *   record. A caller outside a transaction gets its own transaction for this.
 *   Comparing the stored JSON is never needed there, so how a dialect compares
 *   a JSON column (MySQL never equals one to a string) does not matter.
 * - Adapters without transactions use a compare-and-swap: every write is
 *   conditional on the value that was read, and a miss means a concurrent
 *   change, so the merge reads again and retries. An adapter that reports
 *   missed updates (strictUpdateNotFound, as Drizzle on SQLite and D1 does)
 *   detects a miss through update(); any other adapter through the row count
 *   updateMany returns. The merge never writes unconditionally. After
 *   KV_MERGE_MAX_ATTEMPTS misses it throws a KvMergeContentionError having
 *   written nothing, which callers report as retryable. An adapter whose
 *   conditional write misses although the value reads back unchanged (it
 *   cannot compare the JSON value), or whose updateMany returns no count,
 *   gets a KvMergeUnsupportedError instead, which callers reject as
 *   DFQL_UNSUPPORTED without retrying.
 *
 * Known limit: the locked read is an ordinary read. On a database whose
 * transactions read from a snapshot taken at their first read (MySQL InnoDB at
 * its default REPEATABLE READ), a merge inside a transaction that read data
 * before it (a mutation guard, or a query step earlier in an atomic transact)
 * can read the record as of that snapshot. With the default database
 * serverSeq allocation such a transaction fails and rolls back, because the
 * concurrent merge also advanced the sequence row it then reads stale; with a
 * custom sequence store it could commit a merge from the older value. Merges
 * sent by kv.merge (/mutation, /push, REST) read nothing before the lock.
 */
export async function updateKvRecordMerging(params: {
  db: Adapter;
  resource: string;
  id: string;
  namespace?: string;
  data: Record<string, unknown>;
  inTransaction: boolean;
}): Promise<Record<string, unknown>> {
  const { db, resource, id, namespace, data, inTransaction } = params;
  const where: WhereClause[] = [{ field: "id", operator: "eq", value: id }];
  const strictUpdateNotFound =
    db.capabilities?.operations?.strictUpdateNotFound === true;

  const readStored = async (target: Adapter): Promise<Record<string, unknown>> => {
    const row = await target.findOne<Record<string, unknown>>({
      model: resource,
      where,
      namespace,
    });
    if (!row) throw notFound();
    return row;
  };

  /** Returns false when the update matched no row. */
  const tryUpdate = async (
    target: Adapter,
    updateWhere: WhereClause[],
    updateData: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const updated = await target.update({
        model: resource,
        where: updateWhere,
        data: updateData,
        namespace,
      });
      return !(strictUpdateNotFound && updated === undefined);
    } catch (error) {
      if (isNotFoundError(error)) return false;
      throw error;
    }
  };

  const withMergedValue = (stored: Record<string, unknown>) => ({
    ...data,
    value: mergeKvValue(stored.value, data.value),
  });

  /** Lock the row, read it and write the merge, all in `trx`'s transaction. */
  const mergeLocked = async (trx: Adapter): Promise<Record<string, unknown>> => {
    // Setting id to itself locks the row until the transaction settles.
    if (!(await tryUpdate(trx, where, { id }))) throw notFound();
    const written = withMergedValue(await readStored(trx));
    if (!(await tryUpdate(trx, where, written))) throw notFound();
    return written;
  };

  if (inTransaction) {
    return mergeLocked(db);
  }

  if (supportsTransactions(db)) {
    let started = false;
    try {
      return await db.transaction(async (trx) => {
        started = true;
        return mergeLocked(trx as unknown as Adapter);
      });
    } catch (error) {
      // Fall back to the compare-and-swap only when the adapter refused to
      // start the transaction; an error from the merge itself propagates.
      if (started || !isTransactionUnsupportedError(error)) throw error;
    }
  }

  /**
   * Write only if the stored value is still `current`; false on a miss. An
   * adapter without strictUpdateNotFound may report success from update()
   * when nothing matched, so it uses the updateMany row count instead.
   */
  const tryConditionalUpdate = async (
    updateWhere: WhereClause[],
    updateData: Record<string, unknown>,
  ): Promise<boolean> => {
    if (strictUpdateNotFound) return tryUpdate(db, updateWhere, updateData);
    const count: unknown = await db.updateMany({
      model: resource,
      where: updateWhere,
      data: updateData,
      namespace,
    });
    if (typeof count !== "number") {
      throw new KvMergeUnsupportedError("updateMany returned no row count");
    }
    return count > 0;
  };

  // Every attempt is a compare-and-swap on the value it read, so a write never
  // lands on a value it did not merge from. A miss means another writer
  // changed the record in between; read again and retry (a deleted record
  // then reads as not found, so the caller creates it). A miss after which
  // the value reads back unchanged was not caused by a writer; several in a
  // row mean the adapter cannot compare the value, which is reported as
  // unsupported rather than as contention.
  let missedValue: { value: unknown } | undefined;
  let unchangedMisses = 0;
  for (let attempt = 0; attempt < KV_MERGE_MAX_ATTEMPTS; attempt += 1) {
    const stored = await readStored(db);
    const current = stored.value ?? null;
    if (missedValue && sameJsonValue(missedValue.value, current)) {
      unchangedMisses += 1;
      if (unchangedMisses >= KV_MERGE_MAX_UNCHANGED_MISSES) {
        throw new KvMergeUnsupportedError(
          "a conditional update on the value never matched the value it returned",
        );
      }
    } else {
      unchangedMisses = 0;
    }
    const written = withMergedValue(stored);
    const updateWhere: WhereClause[] = [
      ...where,
      { field: "value", operator: "eq", value: current },
    ];
    if (await tryConditionalUpdate(updateWhere, written)) {
      return written;
    }
    missedValue = { value: current };
  }

  throw new KvMergeContentionError(id);
}

/** True for a change on the built-in KV resource. */
export function isKvResource(resource: unknown): boolean {
  return resource === KV_RESOURCE_NAME;
}

type KvChangeOp = ChangeEntryInput["op"];

/**
 * The op and record to store for a change on a KV record: the record's stored
 * state when the change's serverSeq was allocated.
 *
 * Clients apply the change with the highest serverSeq for a record as its
 * whole value (a delete removes it), but writers can commit in a different
 * order than they allocate serverSeqs: a write may commit, then a concurrent
 * write commits and records, and only then does the first write allocate its
 * serverSeq. So every KV change allocates its serverSeq after its own write
 * (never from a pool reserved earlier) and only then reads the record. Any
 * write that commits later allocates a higher serverSeq after it and reads
 * again, so the record's latest change always carries the stored state:
 * - row present: the change carries the stored value (a delete whose record
 *   was created again after it becomes an upsert of the stored value);
 * - row absent: the change becomes a delete, so a merge or set that a
 *   concurrent delete overtook cannot resurrect the record.
 * Inside a transaction the row stays locked by this request's write, so the
 * read returns that write.
 */
export async function snapshotKvChange(params: {
  db: Adapter;
  id: string;
  namespace?: string;
  op: KvChangeOp;
  record: Record<string, unknown> | null;
}): Promise<{ op: KvChangeOp; record: Record<string, unknown> | null }> {
  const { db, id, namespace, op, record } = params;
  const row = await db.findOne<Record<string, unknown>>({
    model: KV_RESOURCE_NAME,
    where: [{ field: "id", operator: "eq", value: id }],
    namespace,
  });
  if (!row) return { op: "delete", record: null };
  const value = row.value ?? null;
  if (op === "delete" || !record) return { op: "upsert", record: { id, value } };
  return { op, record: { ...record, id, value } };
}
