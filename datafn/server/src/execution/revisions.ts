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
import { getRelationFkFieldsForResource, resolveJoinStoreResources } from "@datafn/core";
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

/**
 * DATA-41: rows whose `$rev` the server paired with them (a snapshot read or
 * a change that recorded its revision). A `$rev` on any other row of a
 * resource that issues revisions is a stored legacy value, never a revision.
 */
const certifiedRows = new WeakSet<object>();

function certify<T extends Record<string, unknown>>(row: T): T {
  certifiedRows.add(row);
  return row;
}

/** Orders strings by UTF-16 code unit, independent of locale. */
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** DATA-41: a row's JSON wire form with its keys sorted, for comparing rows. */
export function canonicalRow(row: Record<string, unknown>): string {
  return JSON.stringify(JSON.parse(JSON.stringify(row)), (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort(byCodeUnit).map((key) => [key, (value as Record<string, unknown>)[key]]))
      : value);
}

/** Whether `row`'s `$rev` was paired with it by the server. */
export function isRevisionCertified(row: Record<string, unknown>): boolean {
  return certifiedRows.has(row);
}

/** `row` without a `$rev` the server did not pair with it. */
export function withoutUncertifiedRevision(row: Record<string, unknown>): Record<string, unknown> {
  if (!(REVISION_FIELD in row) || certifiedRows.has(row)) return row;
  const { [REVISION_FIELD]: _legacy, ...rest } = row;
  return rest;
}

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

const joinStores = new WeakMap<object, Set<string>>();

/** The change-log names of `schema`'s many-many join stores, from relation metadata. */
function joinStoreNames(schema: DatafnSchema): Set<string> {
  let names = joinStores.get(schema);
  if (!names) {
    names = new Set(resolveJoinStoreResources(schema.relations ?? []).keys());
    joinStores.set(schema, names);
  }
  return names;
}

/**
 * Records of data resources have revisions; join rows and internal tables do
 * not. With the schema, join stores are recognized from its many-many
 * relations, never by prefix, so a declared resource named `join_*` is a data
 * resource (core joins.ts). Without one, only the base prefix rule applies.
 */
export function tracksRevisions(resource: string, schema?: DatafnSchema): boolean {
  if (resource.startsWith("__datafn_")) return false;
  if (!schema) return !resource.startsWith("join_");
  if (joinStoreNames(schema).has(resource)) return false;
  if (schema.resources.some((r) => r.name === resource)) return true;
  return !resource.startsWith("join_");
}

/**
 * Whether revisions are returned for `resource`: the option is on and the
 * resource has no field of its own named `$rev`, so application data is never
 * read as a revision.
 */
export function issuesRevisions(schema: DatafnSchema, resource: string): boolean {
  if (!revisionsEnabled(schema) || !tracksRevisions(resource, schema)) return false;
  const def = schema.resources.find((r) => r.name === resource);
  if (!def) return false;
  return !(def.fields ?? []).some((field) => field.name === REVISION_FIELD);
}

/**
 * DATA-41: a record write names one record. A `record.id` that differs from
 * the mutation's `id` would store (or rename the row to) a record other than
 * the one whose revision the write raises, so such a write is rejected before
 * anything is written.
 */
export function recordIdMismatch(
  schema: DatafnSchema,
  mutation: { resource: string; id: unknown; record?: unknown },
): boolean {
  if (!tracksRevisions(mutation.resource, schema)) return false;
  const record = mutation.record;
  if (typeof record !== "object" || record === null || !Object.prototype.hasOwnProperty.call(record, "id")) return false;
  const recordId = (record as Record<string, unknown>).id;
  return recordId !== undefined && recordId !== mutation.id;
}

/**
 * DATA-41: names the first relation column of `schema` that is a record's
 * primary key `id` (a foreign key, its resource discriminator, or a tree path
 * column), or undefined. A relation write to such a column would move the
 * record to another id while the revision is raised under the old one.
 */
export function relationWritingPrimaryKey(schema: DatafnSchema): string | undefined {
  for (const relation of schema.relations ?? []) {
    const name = String(relation.relation ?? relation.to);
    // Each relation's own columns, derived for it alone as the relation
    // writer derives them: a resource's combined list keeps one entry per
    // foreign key name, so a second relation sharing a foreign key (with its
    // own resource discriminator) would be hidden behind the first.
    for (const resource of schema.resources) {
      for (const fk of getRelationFkFieldsForResource({ resources: [], relations: [relation] }, resource.name)) {
        if (fk.field === "id") return `the foreign key of relation ${name} on ${resource.name}`;
        if (fk.resourceField === "id") return `the foreign key resource field of relation ${name} on ${resource.name}`;
      }
    }
    if (relation.type === "htree" && (relation.pathField || "parentPath") === "id") {
      return `the tree path field of ${name}`;
    }
  }
  return undefined;
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
/**
 * Changes the revision row's timestamp, locking it and giving the transaction
 * its own version of the latest committed row. Under a snapshot-per-
 * transaction isolation (MySQL InnoDB REPEATABLE READ) a plain read after
 * this sees the latest committed revision. An update that leaves every value
 * as it is creates no such version, so two different timestamps are written:
 * at least one changes the row, and the second leaves the current time.
 * Returns the rows the updates affected (0 when the row does not exist).
 */
async function writeLatest(db: Adapter, id: unknown, updatedAt: string): Promise<number> {
  const where = [{ field: "id", op: "eq" as const, value: id }];
  const later = new Date(Date.parse(updatedAt) + 1_000).toISOString();
  return (await db.internal.update(REVISIONS_TABLE, where, { updated_at: later })) +
    (await db.internal.update(REVISIONS_TABLE, where, { updated_at: updatedAt }));
}

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
      // the statement); the caller reads it and retries the bump. A plain
      // read may not see that row in this transaction's snapshot, so check by
      // writing it. Any other failure is the write's failure.
      if ((await writeLatest(db, row.id, String(row.updated_at))) > 0) {
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
  return (await raiseRevision(db, namespace, resource, recordId, deleted)) as number;
}

/**
 * DATA-41: `staleView` is set when the bump succeeded only after a swap miss
 * on an adapter whose reads are a transaction snapshot: the record row this
 * transaction reads may then be older than the revision, so it is not
 * recorded as the row at that revision.
 */
export interface BumpOutcome {
  staleView?: boolean;
}

/**
 * DATA-41: raises a deleted record's revision to a tombstone, but only for a
 * write that moved the record from present to absent. Each attempt, every
 * compare-and-swap retry included, reads the revision row and then checks,
 * before the swap:
 * - a revision row that is already a tombstone means an earlier delete raised
 *   it (a concurrent delete that removed the row first, or a repeated delete),
 *   so this delete removed nothing and raises nothing;
 * - a record row present in the write's own view means a concurrent writer
 *   re-inserted the record (and raised its revision) first, so this delete
 *   must not mark that live record deleted.
 * A writer that commits after the revision read changes the revision, so the
 * swap fails and the next attempt sees its state. Returns undefined, raising
 * nothing, in both cases. A record with no revision row or a live one still
 * gets its tombstone.
 */
export async function bumpTombstone(
  db: Adapter,
  namespace: string,
  resource: string,
  recordId: string,
  outcome?: BumpOutcome,
): Promise<number | undefined> {
  return raiseRevision(db, namespace, resource, recordId, true, outcome, async (row) =>
    isTombstone(row) ||
    (await db.findOne({
      model: resource,
      where: [{ field: "id", operator: "eq", value: recordId }],
      namespace,
    })) !== null);
}

/**
 * DATA-41: raises the revision of a record a non-delete write changed, but
 * only while the record row is present in the write's own view. Each attempt,
 * every compare-and-swap retry included, checks before the swap. A write that
 * matched no row (a relation or `setNull` update of a deleted record, or a
 * merge, trash or archive that lost to a concurrent delete) raises nothing
 * and returns undefined: an existing tombstone stays as it is, and the change
 * row and result carry no revision. A writer that deletes the record after
 * the revision read raises its tombstone, so the swap fails and the next
 * attempt sees the record absent.
 */
export async function bumpPresent(
  db: Adapter,
  namespace: string,
  resource: string,
  recordId: string,
  outcome?: BumpOutcome,
  writesRow = false,
): Promise<number | undefined> {
  // After a swap miss where reads are a snapshot, a record row this write did
  // not write may be read as it was before a delete committed since (the
  // revision row, just written, is read current). A write that certainly
  // wrote the row (`writesRow`: the write inserted, replaced, upserted or
  // KV-merged it) reads its own, current row. Any other write facing a
  // tombstone committed since cannot tell a recreation from a write that
  // matched no row, so it fails and is retried rather than guess.
  return raiseRevision(db, namespace, resource, recordId, false, outcome, async (row, recovered) => {
    if (recovered && isTombstone(row) && !writesRow) {
      throw new Error("INTERNAL: Record revision changed by a concurrent delete; retry the write");
    }
    return (await db.findOne({
      model: resource,
      where: [{ field: "id", operator: "eq", value: recordId }],
      namespace,
    })) === null;
  });
}

function isTombstone(row: Record<string, unknown> | null): boolean {
  return row !== null && Number(row.deleted) === 1;
}

async function raiseRevision(
  db: Adapter,
  namespace: string,
  resource: string,
  recordId: string,
  deleted: boolean,
  outcome?: BumpOutcome,
  skip?: (row: Record<string, unknown> | null, recovered: boolean) => Promise<boolean>,
): Promise<number | undefined> {
  const id = revisionRowId(namespace, resource, recordId);
  const where = [{ field: "id", op: "eq" as const, value: id }];
  // Only PostgreSQL's READ COMMITTED reads the latest commit on every statement.
  const snapshotReads = db.rawSql?.dialect !== "postgres";
  for (let attempt = 0; attempt < MAX_BUMP_ATTEMPTS; attempt++) {
    const updatedAt = new Date().toISOString();
    const recovered = attempt > 0 && snapshotReads;
    if (outcome) outcome.staleView = recovered;
    // A retry follows a write that committed after this transaction's read;
    // a plain read in a snapshot would return the same stale revision again.
    if (attempt > 0) await writeLatest(db, id, updatedAt);
    const row = await db.internal.findOne(REVISIONS_TABLE, where);
    if (skip && (await skip(row, recovered))) return undefined;
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
    rows[index] = certify({ ...row, [REVISION_FIELD]: stored.rev });
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

/**
 * DATA-41: reads with `read` and pairs revisions (see `readWithRevisions`),
 * but revisions are optional metadata: if creating `__datafn_revisions`, the
 * snapshot, the revision read or any read inside the snapshot (thrown, or
 * swallowed by a query fallback) fails, the rows are read again with `plain`
 * outside it and returned without revisions. Only a failure of that plain
 * read reaches the caller, as it would without revisions.
 */
export async function readWithRevisionsOrPlain<T>(
  db: Adapter,
  namespace: string,
  resource: string,
  read: (readDb: Adapter) => Promise<T>,
  plain: () => Promise<T>,
  rowsOf: (result: T) => Array<Record<string, unknown>> | undefined,
  readable: (row: Record<string, unknown>) => boolean = () => true,
): Promise<T> {
  let result: T;
  try {
    await ensureRevisionsTable(db);
    result = await readWithRevisions(
      db,
      namespace,
      resource,
      async (readDb) => {
        const guarded = guardSnapshotReads(readDb);
        const out = await read(guarded.db);
        if (guarded.failed()) throw new SnapshotReadFailedError();
        return out;
      },
      rowsOf,
      readable,
    );
  } catch {
    return plain();
  }
  return result;
}

type WriteEntry = {
  resource: string;
  id: string;
  op: string;
  record: Record<string, unknown> | null;
  rev?: number;
  /** The revision was raised from a possibly stale view; see BumpOutcome. */
  revUncertified?: boolean;
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
  schema?: DatafnSchema,
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
  // Records any entry of this write wrote as a whole row, whatever entry
  // (such as an inherited-inactive update) comes last.
  const wroteRow = new Set<string>();
  for (const entry of write.entries) {
    const key = JSON.stringify([entry.resource, entry.id]);
    if (tracksRevisions(entry.resource, schema)) last.set(key, entry);
    if (["insert", "replace", "upsert"].includes(entry.op) || (entry.op === "merge" && isKvResource(entry.resource))) {
      wroteRow.add(key);
    }
  }
  for (const entry of last.values()) {
    if (write.finished.has(entry)) continue;
    const deleted = entry.op === "delete";
    if (!write.bumped.has(entry)) {
      // A delete whose record row is present again (re-inserted by a
      // concurrent writer) raises no tombstone, and any other write whose
      // record row is absent (it changed nothing) raises nothing: its change
      // row and result carry no revision. Revisions are raised the same way
      // whether or not the server returns them, so a server with revisions
      // off never turns a tombstone live for a write that changed nothing.
      const outcome: BumpOutcome = {};
      entry.rev = deleted
        ? await bumpTombstone(db, namespace, entry.resource, entry.id, outcome)
        : await bumpPresent(db, namespace, entry.resource, entry.id, outcome,
          wroteRow.has(JSON.stringify([entry.resource, entry.id])));
      if (outcome.staleView) entry.revUncertified = true;
      write.bumped.add(entry);
    }
    // A whole-row write reads its own row (current even after a recovered
    // swap, which only leaves the change row uncertified).
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
 * read every field, and only where `pairable` (the write committed together
 * with its revision); clients pair a revision only with such a row. A revisioned
 * record the read policy restricts has its unreadable fields withheld.
 */
export function wireChange(
  schema: DatafnSchema,
  resource: string,
  change: { op: string; record: Record<string, unknown> | null; rev?: number },
  pairable: boolean,
): { record: Record<string, unknown> | null; rev?: number } {
  const issuing = issuesRevisions(schema, resource);
  // A delete's revision names the record's absence, which only a delete that
  // committed together with its revision establishes (pairable); without
  // that, a delete change carries no revision.
  const rev = change.rev !== undefined && issuing && (pairable || change.op !== "delete") ? change.rev : undefined;
  const revField = rev !== undefined ? { rev } : {};
  // On a resource that issues revisions, a `$rev` stored in a change's record
  // (an application value from before the resource dropped its own `$rev`
  // field) is never sent as one.
  const record = issuing && change.record ? withoutUncertifiedRevision(change.record) : change.record;
  // A change row that recorded a revision holds the stored row, server
  // fields included, so its unreadable fields are withheld even after
  // revisions are turned off (or the resource gains its own `$rev` field).
  if (change.rev === undefined || !record) return { record, ...revField };
  if (!canReadEveryField(schema, resource, record)) {
    return { record: withoutUnreadableFields(schema, resource, record), ...revField };
  }
  // Unless the writer committed the change together with its revision
  // (`pairable`, the change row's write-time provenance), the recorded row may
  // be another write's state: `rev` alone is sent.
  if (rev === undefined || !pairable) return { record, ...revField };
  const complete = change.op !== "delete" && (change.op !== "merge" || isKvResource(resource));
  return { record: complete ? certify({ ...record, [REVISION_FIELD]: rev }) : record, rev };
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
