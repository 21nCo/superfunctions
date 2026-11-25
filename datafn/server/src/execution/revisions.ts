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

export const REVISIONS_TABLE = "__datafn_revisions";
/** Reserved row metadata property that carries a returned row's revision. */
export const REVISION_FIELD = "$rev";
/** The namespace sequence allocator's CAS retry limit. */
const MAX_BUMP_ATTEMPTS = 10;
const READ_CHUNK = 500;

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
    } catch {
      // A concurrent writer created it first (MySQL and SQLite reject only
      // the statement); the caller reads it and retries the bump.
      return false;
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
 * Callers create `__datafn_revisions` (`ensureRevisionsTable`) before the
 * snapshot opens; a missing table would abort a PostgreSQL transaction.
 *
 * Runs `read` so that the rows it reads and the revisions read with them come
 * from one snapshot: a transaction at REPEATABLE READ on PostgreSQL. Other
 * adapters run it in a transaction when they support one (SQLite transactions
 * are serialized), or directly (best effort, like their other reads).
 */
export async function readInSnapshot<T>(db: Adapter, read: (snapshotDb: Adapter) => Promise<T>): Promise<T> {
  if (!transactionsUsable(db)) return read(db);
  try {
    return await db.transaction(async (tx) => {
      if (tx.rawSql?.dialect === "postgres") {
        await tx.rawSql.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      }
      return read(tx as unknown as Adapter);
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? error).toLowerCase();
    if (message.includes("not supported") || message.includes("cannot return a promise")) {
      return read(db);
    }
    throw error;
  }
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
  rows.forEach((row, index) => {
    const stored = typeof row.id === "string" ? revisions.get(row.id) : undefined;
    if (stored && !stored.deleted && readable(row)) {
      // A copy: some adapters return their stored row objects.
      rows[index] = { ...row, [REVISION_FIELD]: stored.rev };
    }
  });
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
