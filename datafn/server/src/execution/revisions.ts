/**
 * Server-managed per-record revisions (DATA-41).
 *
 * Every committed write to a record raises its revision by one. The revision
 * lives in `__datafn_revisions`, one row per record, so it survives deletes
 * (the row stays as a tombstone) and is never touched by change-log pruning
 * or sequence reservation. Revisions are bumped by change tracking, inside the
 * transaction that writes the record and its change row.
 *
 * Issuing revisions to clients (`rev`, `$rev`) is gated by the server option
 * `revisions: { enabled: true }`; bumping is unconditional.
 */

import { createHash } from "node:crypto";
import type { Adapter } from "@superfunctions/db";
import type { DatafnSchema } from "../core-types.js";
import { ensureInternalTable } from "./internal-tables.js";
import { isKvResource } from "./mutation/kv-merge.js";
import { canReadEveryField, withoutUnreadableFields } from "../validation/authz.js";

export const REVISIONS_TABLE = "__datafn_revisions";
/** Reserved row metadata property that carries a returned row's revision. */
export const REVISION_FIELD = "$rev";
/** The namespace sequence allocator's CAS retry limit. */
const MAX_BUMP_ATTEMPTS = 10;
/** Ids per `IN` list: D1 binds at most 100 parameters per statement. */
export const READ_CHUNK = 90;

export interface DatafnRevisionsConfig {
  /**
   * Issue revisions to clients and record them on change rows. Turn this on
   * only once every worker writing to the database runs a release that bumps
   * revisions. Default: false.
   */
  enabled?: boolean;
}

const configs = new WeakMap<object, DatafnRevisionsConfig>();

/** Binds the revisions option to a server's validated schema. */
export function configureRevisions(schema: DatafnSchema, config: DatafnRevisionsConfig | undefined): void {
  configs.set(schema, { enabled: config?.enabled === true });
}

export function revisionsEnabled(schema: DatafnSchema): boolean {
  return configs.get(schema)?.enabled === true;
}

/** Records of data resources have revisions; join rows and internal tables do not. */
export function tracksRevisions(resource: string): boolean {
  return !resource.startsWith("join_") && !resource.startsWith("__datafn_");
}

/**
 * Whether revisions are returned for `resource`: the option is on and the
 * resource has no field of its own named `$rev`, so application data is never
 * read as a revision.
 */
export function issuesRevisions(schema: DatafnSchema, resource: string): boolean {
  if (!revisionsEnabled(schema) || !tracksRevisions(resource)) return false;
  const def = schema.resources.find((r) => r.name === resource);
  if (!def) return false;
  return !(def.fields ?? []).some((field) => field.name === REVISION_FIELD);
}

/** Fixed-length key of a record's revision row, like the v2 idempotency ids. */
export function revisionRowId(namespace: string, resource: string, recordId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([namespace, resource, recordId]))
    .digest("hex");
  return `rev1:${digest}`;
}

export async function ensureRevisionsTable(db: Adapter): Promise<void> {
  await ensureInternalTable(db, REVISIONS_TABLE);
}

const createLocks = new Map<string, Promise<unknown>>();

/**
 * Serializes creation of one revision row within this process. Used only on
 * adapters without SQL (`rawSql`), whose internal `create` may overwrite a
 * row instead of rejecting a duplicate key.
 */
async function withCreateLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = createLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.catch(() => undefined);
  createLocks.set(key, tail);
  try {
    return await run;
  } finally {
    if (createLocks.get(key) === tail) createLocks.delete(key);
  }
}

/** Inserts the first revision row of a record unless another writer did. */
async function createIfAbsent(db: Adapter, row: Record<string, unknown>): Promise<boolean> {
  const rawSql = db.rawSql;
  if (rawSql?.dialect === "postgres") {
    // A unique violation would abort the enclosing PostgreSQL transaction;
    // ON CONFLICT waits for a concurrent inserter and then skips instead.
    const columns = Object.keys(row);
    const inserted = await rawSql.query(
      `INSERT INTO "${REVISIONS_TABLE}" (${columns.map((c) => `"${c}"`).join(", ")}) ` +
        `VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
      columns.map((c) => row[c] as string | number | null),
    );
    return inserted.length > 0;
  }
  const create = async () => {
    if (await db.internal.findOne(REVISIONS_TABLE, [{ field: "id", op: "eq", value: row.id }])) {
      return false;
    }
    try {
      await db.internal.create(REVISIONS_TABLE, row);
      return true;
    } catch (error) {
      // A concurrent writer created it first (MySQL and SQLite reject only
      // the statement); the caller reads it and retries the bump. Any other
      // failure is the write's failure.
      if (await db.internal.findOne(REVISIONS_TABLE, [{ field: "id", op: "eq", value: row.id }])) {
        return false;
      }
      throw error;
    }
  };
  return rawSql ? create() : withCreateLock(String(row.id), create);
}

/**
 * Raises a record's revision by one inside the caller's transaction and
 * returns the new value. `deleted` marks the row as a tombstone (a delete) or
 * clears the mark (any other write). A compare-and-swap that changes no row
 * means another writer committed first; the bump is retried from a fresh read
 * so no revision is ever committed twice. On PostgreSQL the conditional update
 * waits for the other transaction and then matches no row.
 */
export async function bumpRevision(
  db: Adapter,
  namespace: string,
  resource: string,
  recordId: string,
  deleted: boolean,
): Promise<number> {
  const id = revisionRowId(namespace, resource, recordId);
  const where = [{ field: "id", op: "eq" as const, value: id }];
  for (let attempt = 0; attempt < MAX_BUMP_ATTEMPTS; attempt++) {
    const updatedAt = new Date().toISOString();
    const row = await db.internal.findOne(REVISIONS_TABLE, where);
    if (!row) {
      const created = await createIfAbsent(db, {
        id,
        namespace,
        resource,
        record_id: recordId,
        rev: 1,
        deleted: deleted ? 1 : 0,
        updated_at: updatedAt,
      });
      if (created) return 1;
      continue;
    }
    const current = Number(row.rev) || 0;
    const affected = await db.internal.update(
      REVISIONS_TABLE,
      [...where, { field: "rev", op: "eq", value: current }],
      { rev: current + 1, deleted: deleted ? 1 : 0, updated_at: updatedAt },
    );
    if (affected > 0) return current + 1;
  }
  throw new Error("INTERNAL: Failed to bump record revision after maximum retries");
}

export interface StoredRevision {
  rev: number;
  deleted: boolean;
}

/** Reads the revisions of `ids` (missing ids have none, i.e. revision 0). */
export async function readRevisions(
  db: Adapter,
  namespace: string,
  resource: string,
  ids: readonly string[],
): Promise<Map<string, StoredRevision>> {
  const result = new Map<string, StoredRevision>();
  if (ids.length === 0) return result;
  const byKey = new Map(ids.map((id) => [revisionRowId(namespace, resource, id), id]));
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += READ_CHUNK) {
    const rows = await db.internal.findMany(REVISIONS_TABLE, [
      { field: "id", op: "in", value: keys.slice(i, i + READ_CHUNK) },
    ]);
    for (const row of rows) {
      const recordId = byKey.get(String(row.id));
      const rev = Number(row.rev);
      if (recordId !== undefined && Number.isInteger(rev) && rev > 0) {
        result.set(recordId, { rev, deleted: Number(row.deleted) === 1 });
      }
    }
  }
  return result;
}

function transactionsUsable(db: Adapter): boolean {
  return db.capabilities?.transactions?.supported !== false && typeof db.transaction === "function";
}

/**
 * Replaces each returned row of `resource` that has a revision with a copy
 * carrying it as `$rev`,
 * reading the revisions on `db` (the snapshot the rows were read in). Rows the
 * caller may not read completely (`readable` false) get none.
 */
export async function attachRevisions(
  db: Adapter,
  namespace: string,
  resource: string,
  rows: Array<Record<string, unknown>>,
  readable: (row: Record<string, unknown>) => boolean = () => true,
): Promise<void> {
  const ids = rows.map((row) => row.id).filter((id): id is string => typeof id === "string");
  const revisions = await readRevisions(db, namespace, resource, ids);
  attachRead(rows, revisions, readable);
}

/**
 * Pairs each row with its revision read earlier. A row without a revision
 * row is a record written before revisions existed: revision 0. A tombstone
 * paired with an existing row (written outside DataFn) gets none.
 */
function attachRead(
  rows: Array<Record<string, unknown>>,
  revisions: Map<string, StoredRevision>,
  readable: (row: Record<string, unknown>) => boolean,
  known: (id: string) => boolean = () => true,
): void {
  rows.forEach((row, index) => {
    if (typeof row.id !== "string" || !known(row.id) || !readable(row)) return;
    const stored = revisions.get(row.id) ?? { rev: 0, deleted: false };
    if (stored.deleted) return;
    // A copy: some adapters return their stored row objects.
    rows[index] = { ...row, [REVISION_FIELD]: stored.rev };
  });
}

/**
 * DATA-41: an adapter for a read inside a revision snapshot that remembers
 * whether any of its calls (raw SQL included) failed. Query paths fall back
 * or swallow some read errors (a rejected push-down filter, a failed
 * in-memory load), which on PostgreSQL leaves the snapshot transaction
 * aborted and every later read empty. A caller that finds `failed()` leaves
 * the snapshot and reads again outside it, without revisions.
 */
export function guardSnapshotReads(db: Adapter): { db: Adapter; failed: () => boolean } {
  let failed = false;
  const fail = (error: unknown): never => {
    failed = true;
    throw error;
  };
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(obj, key) {
        const value = Reflect.get(obj, key, obj);
        if (key === "rawSql" && value && typeof value === "object") return wrap(value as object);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          let out: unknown;
          try {
            out = (value as (...a: unknown[]) => unknown).apply(obj, args);
          } catch (error) {
            return fail(error);
          }
          return out && typeof (out as Promise<unknown>).then === "function"
            ? (out as Promise<unknown>).then(undefined, fail)
            : out;
        };
      },
    });
  return { db: wrap(db), failed: () => failed };
}

/** A read inside a revision snapshot failed; read again outside it. */
export class SnapshotReadFailedError extends Error {
  constructor() {
    super("A read inside the revision snapshot failed");
    this.name = "SnapshotReadFailedError";
  }
}

/**
 * Reads rows with `read` and attaches each readable row's revision as
 * `$rev`, only where the row is known to be the state at that revision. With
 * a verified snapshot (REPEATABLE READ on PostgreSQL; SQLite transactions are
 * serialized) the rows and revisions come from one snapshot. On any other
 * transactional database a write and its revision commit together, so the
 * revisions are read before and after the returned rows, and a row gets one
 * only when both reads agree (no write to it committed in between). Without
 * transactions a write and its revision are separate statements, so no read
 * order can establish the pair and no revision is attached. Callers create
 * `__datafn_revisions` first; a missing table would abort a PostgreSQL
 * transaction.
 */
export async function readWithRevisions<T>(
  db: Adapter,
  namespace: string,
  resource: string,
  read: (readDb: Adapter) => Promise<T>,
  rowsOf: (result: T) => Array<Record<string, unknown>> | undefined,
  readable: (row: Record<string, unknown>) => boolean = () => true,
): Promise<T> {
  const idsOf = (result: T) =>
    (rowsOf(result) ?? []).map((row) => row.id).filter((id): id is string => typeof id === "string");
  const unsnapshotted = async (readDb: Adapter) => {
    const ids = idsOf(await read(readDb));
    const before = await readRevisions(readDb, namespace, resource, ids);
    const result = await read(readDb);
    const after = await readRevisions(readDb, namespace, resource, ids);
    const rows = rowsOf(result);
    const firstRead = new Set(ids);
    const unchanged = (id: string) => {
      const a = before.get(id);
      const b = after.get(id);
      return firstRead.has(id) && a?.rev === b?.rev && a?.deleted === b?.deleted;
    };
    if (rows) attachRead(rows, after, readable, unchanged);
    return result;
  };
  if (!transactionsUsable(db)) return read(db);
  // Only a verified snapshot pairs rows with revisions read after them:
  // PostgreSQL at REPEATABLE READ, or SQLite (one writer at a time). Any other
  // database, including SQL reached without raw SQL access (whose isolation
  // level is unknown), checks the revisions before and after the rows.
  const dialect = db.rawSql?.dialect;
  if (dialect !== "postgres" && dialect !== "sqlite") return unsnapshotted(db);
  try {
    return await db.transaction(async (tx) => {
      const snapshotDb = tx as unknown as Adapter;
      const txDialect = tx.rawSql?.dialect;
      if (txDialect === "postgres") {
        await tx.rawSql!.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      } else if (txDialect !== "sqlite") {
        return unsnapshotted(snapshotDb);
      }
      const result = await read(snapshotDb);
      const rows = rowsOf(result);
      if (rows) await attachRevisions(snapshotDb, namespace, resource, rows, readable);
      return result;
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? error).toLowerCase();
    if (message.includes("not supported") || message.includes("cannot return a promise")) {
      // No usable transactions, so writes are not atomic either.
      return read(db);
    }
    throw error;
  }
}

type WriteEntry = {
  resource: string;
  id: string;
  op: string;
  record: Record<string, unknown> | null;
  rev?: number;
};

/**
 * One write's revision assignment. `bumped` and `finished` hold the last
 * entries whose revision was raised and whose committed row was recorded, so
 * a retry after a failure part-way through completes the remaining records
 * without raising any record twice.
 */
interface WriteAssignment {
  entries: ReadonlyArray<WriteEntry>;
  bumped: WeakSet<object>;
  finished: WeakSet<object>;
  complete: boolean;
}

const assignments = new WeakMap<object, WriteAssignment>();

/**
 * Raises the revision of each record one write changes exactly once, inside
 * the write's transaction, however many change entries the write recorded
 * for it (an insert and its inherited-inactive update are one write). Only
 * the record's last entry carries the new revision; it marks a delete's
 * tombstone. Where `completeRow` holds, a last entry that writes a whole record
 * (insert, replace, upsert, or any KV write) records the stored row read on
 * `db` after the write, so a change carrying a revision always carries the exact committed
 * row (defaults and server fields included). Recording entries of a write
 * already assigned (in full or in part) keeps the revisions already raised
 * and raises only the records a failed attempt did not reach.
 */
export async function assignWriteRevisions(
  db: Adapter,
  namespace: string,
  entries: ReadonlyArray<WriteEntry>,
  completeRow: (resource: string) => boolean,
): Promise<void> {
  let write: WriteAssignment | undefined;
  for (const entry of entries) {
    write = assignments.get(entry);
    if (write) break;
  }
  if (write?.complete) return;
  if (!write) {
    write = { entries: [...entries], bumped: new WeakSet(), finished: new WeakSet(), complete: false };
    for (const entry of entries) assignments.set(entry, write);
  }
  const last = new Map<string, WriteEntry>();
  for (const entry of write.entries) {
    if (tracksRevisions(entry.resource)) last.set(JSON.stringify([entry.resource, entry.id]), entry);
  }
  for (const entry of last.values()) {
    if (write.finished.has(entry)) continue;
    const deleted = entry.op === "delete";
    if (!write.bumped.has(entry)) {
      entry.rev = await bumpRevision(db, namespace, entry.resource, entry.id, deleted);
      write.bumped.add(entry);
    }
    if (!deleted && completeRow(entry.resource) && (entry.op !== "merge" || isKvResource(entry.resource))) {
      const stored = await db.findOne({
        model: entry.resource,
        where: [{ field: "id", operator: "eq", value: entry.id }],
        namespace,
      });
      if (stored) entry.record = { ...(stored as Record<string, unknown>) };
      else entry.rev = undefined;
    }
    write.finished.add(entry);
  }
  write.complete = true;
}

/**
 * DATA-41: a pulled change's record and revision as they go on the wire.
 * `rev` is the record's revision after the change, when the change recorded
 * one and the resource issues revisions. The record carries it as `$rev` only
 * when it is the complete committed row (insert, replace and upsert rows, and
 * KV rows, which revision assignment records from storage) and the caller may
 * read every field; clients pair a revision only with such a row. A revisioned
 * record the read policy restricts has its unreadable fields withheld.
 */
export function wireChange(
  schema: DatafnSchema,
  resource: string,
  change: { op: string; record: Record<string, unknown> | null; rev?: number },
): { record: Record<string, unknown> | null; rev?: number } {
  const rev = change.rev !== undefined && issuesRevisions(schema, resource) ? change.rev : undefined;
  const revField = rev !== undefined ? { rev } : {};
  // A change row that recorded a revision holds the stored row, server
  // fields included, so its unreadable fields are withheld even after
  // revisions are turned off (or the resource gains its own `$rev` field).
  if (change.rev === undefined || !change.record) return { record: change.record, ...revField };
  if (!canReadEveryField(schema, resource, change.record)) {
    return { record: withoutUnreadableFields(schema, resource, change.record), ...revField };
  }
  if (rev === undefined) return { record: change.record };
  const complete = change.op !== "delete" && (change.op !== "merge" || isKvResource(resource));
  return { record: complete ? { ...change.record, [REVISION_FIELD]: rev } : change.record, rev };
}

/** The revision the last of `entries` for one record raised, if any. */
export function recordedRevision(
  entries: ReadonlyArray<{ resource: string; id: string; rev?: number }>,
  resource: string,
  id: string,
): number | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.resource === resource && entry.id === id) return entry.rev;
  }
  return undefined;
}
