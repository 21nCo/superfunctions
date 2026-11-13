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

/**
 * Update an existing KV record, merging `data.value` into the stored value.
 * Returns the data written, whose `value` is the complete merged value.
 * Throws a NotFoundError when the record does not exist so the caller can
 * create it with the patch.
 *
 * Atomicity per record:
 * - Inside a database transaction, a no-op update first takes the row lock, so
 *   the read and the write cannot interleave with another merge of the record.
 * - Without transactions (Drizzle on SQLite and D1), the write is conditional
 *   on the value that was read and retries after a concurrent change.
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

  const readStored = async (): Promise<Record<string, unknown>> => {
    const row = await db.findOne<Record<string, unknown>>({
      model: resource,
      where,
      namespace,
    });
    if (!row) throw notFound();
    return row;
  };

  /** Returns false when the update matched no row. */
  const tryUpdate = async (
    updateWhere: WhereClause[],
    updateData: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      const updated = await db.update({
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

  if (inTransaction) {
    // Setting id to itself locks the row until the transaction settles.
    if (!(await tryUpdate(where, { id }))) throw notFound();
    const written = withMergedValue(await readStored());
    if (!(await tryUpdate(where, written))) throw notFound();
    return written;
  }

  if (!strictUpdateNotFound) {
    // An adapter that reports no missed updates cannot detect a failed
    // compare-and-swap, so the conditional write would be unsafe here.
    const written = withMergedValue(await readStored());
    if (!(await tryUpdate(where, written))) throw notFound();
    return written;
  }

  let previousFingerprint: string | undefined;
  for (let attempt = 0; attempt < KV_MERGE_MAX_ATTEMPTS; attempt += 1) {
    const stored = await readStored();
    const current = stored.value ?? null;
    const written = withMergedValue(stored);
    const fingerprint = JSON.stringify(current);
    // A conditional write that missed while the value stayed the same means
    // the store cannot compare this stored representation (for example JSON
    // written outside DataFn). Fall back to a plain write of the fresh merge.
    const conditional = fingerprint !== previousFingerprint;
    previousFingerprint = fingerprint;
    const updateWhere: WhereClause[] = conditional
      ? [...where, { field: "value", operator: "eq", value: current }]
      : where;
    if (await tryUpdate(updateWhere, written)) {
      return written;
    }
  }

  throw new Error(
    `KV merge of ${id} did not settle after ${KV_MERGE_MAX_ATTEMPTS} concurrent attempts`,
  );
}
