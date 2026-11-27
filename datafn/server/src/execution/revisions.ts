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

import { createHash, randomBytes } from "node:crypto";
import { NotFoundError, type Adapter } from "@superfunctions/db";
import { getRelationFkFieldsForResource, resolveJoinStoreResources } from "@datafn/core";
import type { DatafnSchema } from "../core-types.js";
import { ensureInternalTable, registerAdapterWrapper } from "./internal-tables.js";
import { isKvResource } from "./mutation/kv-merge.js";
import { canReadEveryField, withoutUnreadableFields } from "../validation/authz.js";
import { isNotFoundError } from "./mutation/merge-decision.js";

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

/**
 * Binds the revisions option to a server's validated schema. A schema whose
 * relation writes a record's primary key `id` cannot issue revisions (see
 * relationWritingPrimaryKey): turning them on for it fails here, before any
 * write.
 */
export function configureRevisions(schema: DatafnSchema, config: DatafnRevisionsConfig | undefined): void {
  const enabled = config?.enabled === true;
  const writesId = enabled ? relationWritingPrimaryKey(schema) : undefined;
  if (writesId !== undefined) {
    throw new Error(`DATAFN_REVISIONS_UNSUPPORTED: revisions cannot be enabled: ${writesId} is the record id`);
  }
  configs.set(schema, { enabled });
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
 * Called only inside a transaction: the timestamp replaces the row's raise
 * marks, which only writes outside one need (see PendingRaise).
 * Returns the rows the updates affected (0 when the row does not exist).
 */
async function writeLatest(db: Adapter, id: unknown, updatedAt: string): Promise<number> {
  const where = [{ field: "id", op: "eq" as const, value: id }];
  const later = new Date(Date.parse(updatedAt) + 1_000).toISOString();
  return (await db.internal.update(REVISIONS_TABLE, where, { updated_at: later })) +
    (await db.internal.update(REVISIONS_TABLE, where, { updated_at: updatedAt }));
}

/**
 * Inserts the first revision row of a record unless another writer did:
 * `created`, or `exists` when the stored row is not this insert's (its raise
 * mark is not kept; see raisedBy), and the caller raises that row.
 */
async function createIfAbsent(
  db: Adapter,
  row: Record<string, unknown>,
  inTransaction: boolean,
): Promise<"created" | "exists"> {
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
    return inserted.length > 0 ? "created" : "exists";
  }
  const create = async (): Promise<"created" | "exists"> => {
    if (await db.internal.findOne(REVISIONS_TABLE, [{ field: "id", op: "eq", value: row.id }])) {
      return "exists";
    }
    try {
      await db.internal.create(REVISIONS_TABLE, row);
      return "created";
    } catch (error) {
      // The insert may have been stored before the adapter failed: a row
      // carrying this insert's raise mark is this insert. Otherwise it is
      // raised again, so a mark dropped since only skips a revision.
      const stored = await db.internal.findOne(REVISIONS_TABLE, [{ field: "id", op: "eq", value: row.id }]);
      if (stored) {
        return raisedBy(stored, raiseMarks(row)[0]) ? "created" : "exists";
      }
      // A concurrent writer created it first (MySQL and SQLite reject only
      // the statement); the caller reads it and retries the bump. A plain
      // read in a transaction may not see that row in its snapshot, so check
      // by writing it. Any other failure is the write's failure.
      if (inTransaction && (await writeLatest(db, row.id, String(row.updated_at).split("#")[0])) > 0) {
        return "exists";
      }
      throw error;
    }
  };
  return rawSql ? create() : withCreateLock(String(row.id), create);
}

/**
 * Raises a record's revision by one inside the caller's transaction
 * (`inTransaction`, the caller's scope; false for a raise outside one) and
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
  inTransaction: boolean,
): Promise<number> {
  const decide = () => ({ deleted, byDelete: deleted });
  return (await raiseRevision(db, namespace, resource, recordId, decide, { inTransaction }))!.rev;
}

/**
 * DATA-41: `staleView` is set when the bump succeeded only after a swap miss
 * on an adapter whose reads may be a transaction snapshot: the record row this
 * transaction reads may then be older than the revision, so it is not
 * recorded as the row at that revision.
 */
export interface BumpOutcome {
  staleView?: boolean;
}

/** Raises a deleted record's revision to a tombstone (see raiseRevision). */
export async function bumpTombstone(
  db: Adapter,
  namespace: string,
  resource: string,
  recordId: string,
  inTransaction: boolean,
  outcome?: BumpOutcome,
): Promise<number> {
  const decide = () => ({ deleted: true, byDelete: true });
  return (await raiseRevision(db, namespace, resource, recordId, decide, { outcome, inTransaction }))!.rev;
}

/**
 * DATA-41: whether a plain read inside a transaction on `db` may return a
 * snapshot older than the latest commit (MySQL InnoDB REPEATABLE READ, or SQL
 * of unknown isolation). PostgreSQL READ COMMITTED, SQLite (one writer at a
 * time), the memory adapter and adapters without transactions read current.
 */
export function readsMayBeSnapshot(db: Adapter): boolean {
  if (!transactionsUsable(db)) return false;
  const dialect = db.rawSql?.dialect;
  if (dialect === "postgres" || dialect === "sqlite") return false;
  return dialect !== undefined || (db as { id?: unknown }).id !== "memory";
}

type WhereList = ReadonlyArray<{ field?: unknown; operator?: unknown; value?: unknown }>;

/** The record ids a where clause names by `id = x` or `id IN (...)`. */
function idsOf(where: unknown, allowIn: boolean): string[] | undefined {
  if (!Array.isArray(where)) return undefined;
  for (const clause of where as WhereList) {
    if (clause?.field !== "id") continue;
    if (clause.operator === "eq" && typeof clause.value === "string") return [clause.value];
    if (allowIn && clause.operator === "in" && Array.isArray(clause.value)) {
      return [...new Set(clause.value.filter((v): v is string => typeof v === "string"))];
    }
  }
  return undefined;
}

/**
 * What one statement of a write proves about one record row:
 * - `applied`: the statement changed the row (or removed it, for a delete);
 * - `missed`: the statement changed nothing (a miss the adapter reported);
 * - `unverified`: the adapter reported success, but its result may come from
 *   a transaction snapshot older than the row the statement wrote (see
 *   `updateResultIsCurrent`), so it proves neither.
 */
type WriteState = "applied" | "missed" | "unverified";

interface WriteEvent extends RecordEvidence {
  key: string;
}

/** One write's evidence for one record, folded over its statements. */
interface RecordEvidence {
  state: WriteState;
  deleted: boolean;
  /** For a delete whose adapter reports no count: a current read of whether the row is absent now. */
  absentNow?: () => Promise<boolean>;
  /** For such a delete: whether a read just before the statement found the row. */
  presentBefore?: boolean;
  /**
   * Outside a transaction, for a write by one id: the record's revision row
   * as read before its statement (revision 0 without one); unset when it was
   * not read.
   */
  ledgerBefore?: StoredRevision;
  /** For such a delete: an earlier write of the same write that changed the row and left it live. */
  before?: RecordEvidence;
}

const writeLogs = new WeakMap<object, WriteEvent[]>();

/**
 * DATA-41: whether an update's returned row comes from the statement itself:
 * the adapter declares RETURNING (`capabilities.operations.returning`), or
 * reads are current, so the adapter's re-select reads the row the statement
 * wrote. Otherwise (MySQL InnoDB REPEATABLE READ) the re-select may return a
 * snapshot row that another transaction has since deleted.
 */
function updateResultIsCurrent(db: Adapter): boolean {
  return db.capabilities?.operations?.returning === true || !readsMayBeSnapshot(db);
}

/**
 * DATA-41: whether `updateMany` counts the rows it matched. MySQL drivers
 * count only rows whose values changed, so a zero count there does not show
 * that a row is missing; every other adapter (Prisma included, which asks
 * MySQL for found rows) reports matched rows.
 */
function countsMatchedRows(db: Adapter): boolean {
  return db.rawSql?.dialect !== "mysql";
}

/**
 * The revision row of the record a delete by id names, read before the
 * delete; called only outside a transaction (inside one a failed read could
 * abort it). Undefined when it cannot be read.
 */
async function revisionBefore(db: Adapter, p: any, id: string): Promise<StoredRevision | undefined> {
  if (typeof p.namespace !== "string") return undefined;
  try {
    return (await readRevisions(db, p.namespace, p.model, [id])).get(id) ?? { rev: 0, deleted: false };
  } catch {
    return undefined;
  }
}

/**
 * Outside a transaction, before the statement of a count-less delete by id
 * that found no row: stamps its intent (INTENT) on the record's revision row,
 * keeping the revision `before` it read (a row at revision 0 when it has
 * none). A write whose row this delete may yet remove raises after it, sees
 * the intent and counts the delete. A revision raised meanwhile needs no
 * stamp (the delete then decides from the raise). The stamp keeps every raise
 * mark (see RAISE_HISTORY); a failed stamp fails nothing.
 */
async function stampIntent(db: Adapter, p: any, id: string, before: StoredRevision): Promise<void> {
  const rowId = revisionRowId(p.namespace, p.model, id);
  const where = [{ field: "id", op: "eq" as const, value: rowId }];
  try {
    const row = await db.internal.findOne(REVISIONS_TABLE, where);
    if ((row ? Number(row.rev) || 0 : 0) !== before.rev) return;
    const stamp = stampWith(new Date().toISOString(), newMark(INTENT), row);
    if (row) {
      await db.internal.update(REVISIONS_TABLE, [...where, { field: "rev", op: "eq", value: before.rev }], {
        updated_at: stamp,
      });
    } else {
      const fields = { namespace: p.namespace, resource: p.model, record_id: id };
      await createIfAbsent(db, { id: rowId, ...fields, rev: 0, deleted: 0, updated_at: stamp }, false);
    }
  } catch {
    // Without the intent, a write whose row this delete removes raises once.
  }
}

/**
 * DATA-41: `db` for one write, recording what each of its own record
 * statements proves about each record row it names by id. Every call goes to
 * the adapter's own method with its own arguments; the wrapper only reads the
 * result:
 * - a create or upsert that succeeded wrote the row;
 * - a delete that succeeded removed the row if a read after it finds the row
 *   absent (`absentNow`); `deleteMany` removed rows only when its count says
 *   so;
 * - an update wrote the row when the adapter returned it from the statement
 *   (`updateResultIsCurrent`); a NotFound error or an empty result is a miss
 *   (an empty result is confirmed by a current read where reads are current);
 *   a row re-selected from a possible snapshot is `unverified`;
 * - `updateMany` by ids wrote every row when its count covers them all; a
 *   zero count of matched rows is a miss; otherwise a current read names the
 *   rows present, and where reads may be a snapshot the ids are `unverified`.
 * A revision is raised only on this evidence (assignWriteRevisions).
 */
export function withWriteEvidence(db: Adapter, inTransaction: boolean, log: WriteEvent[] = []): Adapter {
  const note = (
    model: string,
    ids: readonly string[],
    deleted: boolean,
    state: WriteState,
    countless?: Pick<RecordEvidence, "absentNow" | "presentBefore" | "ledgerBefore">,
  ) => {
    for (const id of ids) log.push({ key: JSON.stringify([model, id]), deleted, state, ...countless });
  };
  const snapshot = readsMayBeSnapshot(db);
  const target = db as Adapter & Record<string, unknown>;
  // A current read of the rows `p.where` matches now.
  const present = async (p: any): Promise<Set<string>> =>
    new Set((await db.findMany({ model: p.model, where: p.where, namespace: p.namespace }))
      .map((row) => String((row as { id?: unknown }).id)));
  // Outside a transaction, the revision row of the one record a write names,
  // read just before its statement (see raiseFromEvidence).
  const ledgerAt = async (p: any, ids: readonly string[] | undefined) =>
    !inTransaction && ids?.length === 1 ? { ledgerBefore: await revisionBefore(db, p, ids[0]) } : undefined;
  const writers: Record<string, (p: any, ...rest: unknown[]) => Promise<unknown>> = {
    async create(p) {
      const ids = typeof p.data?.id === "string" ? [p.data.id as string] : undefined;
      const before = await ledgerAt(p, ids);
      const out = await db.create(p);
      if (ids) note(p.model, ids, false, "applied", before);
      return out;
    },
    async createMany(p) {
      const out = await db.createMany(p);
      for (const row of p.data ?? []) if (typeof row?.id === "string") note(p.model, [row.id], false, "applied");
      return out;
    },
    async upsert(p) {
      const id = idsOf(p.where, false) ?? (typeof p.create?.id === "string" ? [p.create.id] : []);
      const before = await ledgerAt(p, id);
      const out = await db.upsert(p);
      note(p.model, id, false, "applied", before);
      return out;
    },
    async update(p) {
      const ids = idsOf(p.where, false);
      if (!ids) return db.update(p);
      const before = await ledgerAt(p, ids);
      let out: unknown;
      try {
        out = await db.update(p);
      } catch (error) {
        if (isNotFoundError(error)) note(p.model, ids, false, "missed");
        throw error;
      }
      if (out !== null && out !== undefined) {
        note(p.model, ids, false, updateResultIsCurrent(db) ? "applied" : "unverified", before);
      } else if (snapshot) {
        note(p.model, ids, false, "unverified");
      } else {
        note(p.model, ids, false, (await present(p)).size > 0 ? "applied" : "missed", before);
      }
      return out;
    },
    async updateMany(p) {
      const ids = idsOf(p.where, true);
      const count = await db.updateMany(p);
      if (!ids || ids.length === 0) return count;
      if (count >= ids.length) {
        note(p.model, ids, false, "applied");
      } else if (count === 0 && countsMatchedRows(db)) {
        note(p.model, ids, false, "missed");
      } else if (snapshot) {
        note(p.model, ids, false, "unverified");
      } else {
        const found = await present(p);
        for (const id of ids) note(p.model, [id], false, found.has(id) ? "applied" : "missed");
      }
      return count;
    },
    async delete(p) {
      const ids = idsOf(p.where, false);
      // The adapter's delete reports no count. Reads just before it of the
      // revision row, then of the row, tell what it may have removed (see
      // raiseFromEvidence); a delete that found no row stamps its intent.
      // Only outside a transaction (the caller's scope, `inTransaction`),
      // where they decide: inside one a failed statement would abort it, and
      // the write's row lock decides. None fails the write: earlier
      // statements of it (cascades) may have committed. Without them the
      // delete is decided as unknown.
      const outside = ids !== undefined && !inTransaction;
      const ledgerBefore = outside && ids.length === 1 ? await revisionBefore(db, p, ids[0]) : undefined;
      const presentBefore = outside
        ? await db.findOne({ model: p.model, where: p.where, namespace: p.namespace })
          .then((row) => row !== null, () => undefined)
        : undefined;
      if (presentBefore === false && ledgerBefore) await stampIntent(db, p, ids![0], ledgerBefore);
      try {
        await db.delete(p);
      } catch (error) {
        if (ids && isNotFoundError(error)) note(p.model, ids, true, "missed");
        throw error;
      }
      // Whether it removed the row is decided by a read of the row after the
      // revision row is locked (raiseFromEvidence). A transaction sees its own
      // delete even where its other reads are a snapshot.
      if (!ids) return;
      const absentNow = async () =>
        (await db.findOne({ model: p.model, where: p.where, namespace: p.namespace })) === null;
      note(p.model, ids, true, "applied", { absentNow, presentBefore, ledgerBefore });
    },
    async deleteMany(p) {
      const count = await db.deleteMany(p);
      // A partial count cannot name the rows removed; a tombstone raised for
      // a record already absent is only an extra bump of a tombstone.
      note(p.model, idsOf(p.where, true) ?? [], true, count > 0 ? "applied" : "missed");
      return count;
    },
    async transaction(fn: (tx: Adapter) => Promise<unknown>, ...rest: unknown[]) {
      return (db.transaction as (...a: unknown[]) => Promise<unknown>).call(
        db,
        (tx: Adapter) => fn(withWriteEvidence(tx, true, log)),
        ...rest,
      );
    },
  };
  const wrapped = new Proxy(target, {
    get(obj, key) {
      const value = Reflect.get(obj, key, obj);
      if (typeof value !== "function") return value;
      if (typeof key === "string" && Object.prototype.hasOwnProperty.call(writers, key)) return writers[key];
      return value.bind(obj);
    },
  });
  writeLogs.set(wrapped, log);
  registerAdapterWrapper(wrapped, db);
  return wrapped;
}

/**
 * Takes the evidence `db` recorded since it was last taken, folded per
 * record: the last statement that applied decides (deleted as it left the
 * row); without one, any unverified statement makes it unverified; otherwise
 * it missed. A delete without a count keeps the earlier write that left the
 * row live (`before`), which decides when the delete removed nothing.
 */
function takeWriteEvidence(db: Adapter): Map<string, RecordEvidence> {
  const folded = new Map<string, RecordEvidence>();
  for (const event of writeLogs.get(db)?.splice(0) ?? []) {
    const prior = folded.get(event.key);
    if (event.state === "applied" || !prior || (prior.state === "missed" && event.state === "unverified")) {
      const live = prior && prior.state !== "missed" && !prior.deleted ? prior : undefined;
      const before = event.absentNow ? (prior?.absentNow ? prior.before : live) : undefined;
      const { state, deleted, absentNow, presentBefore, ledgerBefore } = event;
      folded.set(event.key, { state, deleted, absentNow, presentBefore, ledgerBefore, before });
    }
  }
  return folded;
}

/**
 * What a raise leaves: a tombstone (`deleted`) or a live record, and whether
 * the tombstone is a delete statement's own evidence (`byDelete`) rather than
 * an absence another write observed.
 */
interface Decided {
  deleted: boolean;
  byDelete?: boolean;
  /**
   * Revisions skipped before this raise's own: a write that left the row live
   * and finds it removed by a delete that raised nothing counts that delete's
   * tombstone too (raiseFromEvidence).
   */
  skip?: number;
}

/**
 * Decides, from the record's revision row as read (null when it has none),
 * what a raise leaves, or that it raises nothing (`undefined`).
 */
type RaiseDecision = (row: Record<string, unknown> | null) => Promise<Decided | undefined> | Decided | undefined;

const isTombstone = (row: Record<string, unknown> | null) => row !== null && Number(row.deleted) === 1;

/** A raise mark's suffix: the raise was a delete's own tombstone, or any other state. */
const BY_DELETE = ":d";
const OTHER = ":o";
/**
 * The suffix of a count-less delete's intent, stamped outside a transaction
 * before a statement whose reads found no row (see stampIntent): while it is
 * the revision row's latest mark, no write has raised the record since, so a
 * row that delete removed was written without a raise yet, and the raise of
 * that write counts the delete too (raiseFromEvidence).
 */
const INTENT = ":x";

const isIntent = (mark: string) => mark.endsWith(INTENT);

/** Whether `row`'s latest raise (an intent is none) is a tombstone a delete statement's own evidence raised. */
const deleteEvidenced = (row: Record<string, unknown> | null) =>
  isTombstone(row) && raiseMarks(row).find((mark) => !isIntent(mark))?.endsWith(BY_DELETE) === true;

/** Whether `row`'s latest mark is a count-less delete's intent (a raise drops intents). */
const intentLatest = (row: Record<string, unknown> | null) => isIntent(raiseMarks(row)[0] ?? "");

/**
 * Outside a transaction: whether a count-less delete that leaves the row
 * absent removed nothing, from what it read before its statement and the
 * revision row `row` now. Whatever removed the row it found raises its
 * tombstone once: a delete-evidenced tombstone raised since stands for it.
 * Without a row to remove it raises nothing while the revision row keeps the
 * revision it read: a write whose row it removed has not raised yet, and that
 * raise counts this delete under its intent (raiseFromEvidence).
 * It raises when the record was raised since that read to a state it may have
 * removed: a live re-insert, or a tombstone a write observed after the
 * revision row read a tombstone. A delete that found the row absent under a
 * live revision follows one still to raise its own.
 */
function countlessRemovedNothing(evidence: RecordEvidence, row: Record<string, unknown> | null): boolean {
  const before = evidence.ledgerBefore;
  const changed = before === undefined || (row ? Number(row.rev) || 0 : 0) > before.rev;
  if (evidence.presentBefore) return changed && deleteEvidenced(row);
  if (!changed) return true;
  if (!isTombstone(row)) return false;
  return deleteEvidenced(row) || before === undefined || !before.deleted;
}

/**
 * Outside a transaction, for a write that left its row live and finds it
 * removed: whether a count-less delete that raised nothing removed it, so
 * this raise names the live state and that delete's tombstone, as the
 * delete's own. Its intent is the latest mark (no raise since it was
 * stamped), and no delete tombstone was raised since this write read the
 * revision row before its statement: such a tombstone counts the removal of
 * this write's row (the intent then belongs to a delete after it).
 */
function intentCounted(evidence: RecordEvidence, row: Record<string, unknown> | null): boolean {
  const before = evidence.ledgerBefore;
  if (!intentLatest(row) || before === undefined) return false;
  return (row ? Number(row.rev) || 0 : 0) === before.rev || !deleteEvidenced(row);
}

/**
 * The revision row write a raise last sent, kept by its caller across a
 * retry: `mark` is unique to that write. Each raise stores its mark after the
 * time in the row's `updated_at` (`<ISO time>#<mark> <earlier marks>`) and
 * carries the previous marks forward (the compare-and-swap on `rev` makes the
 * marks it read the ones it replaces), so a write whose outcome is unknown
 * (the statement committed but the adapter then failed) is found by its mark
 * even after later writers raised the record, and a retry adopts that
 * revision instead of raising the record again (see raisedBy). A write
 * proven not to have committed (a compare-and-swap that changed no row, an
 * insert that found the row stored) clears it.
 */
interface PendingRaise {
  rev?: number;
  deleted?: boolean;
  mark?: string;
}

/**
 * How many raise marks a revision row keeps: more than the raises other
 * writers usually make while one write retries, and short enough to keep the
 * row small. A raise keeps its own mark and the RAISE_HISTORY - 1 raise marks
 * before it, and drops every intent; an intent is stamped before them all and
 * drops none. A mark dropped after RAISE_HISTORY later raises only makes its
 * write raise again: outside a transaction a revision may then skip a value,
 * never stand for two states (see raisedBy).
 */
const RAISE_HISTORY = 12;

const newMark = (suffix: string) => randomBytes(6).toString("hex") + suffix;

function raiseMarks(row: Record<string, unknown> | null): string[] {
  const stamp = typeof row?.updated_at === "string" ? row.updated_at : "";
  const at = stamp.indexOf("#");
  return at < 0 ? [] : stamp.slice(at + 1).split(" ");
}

/** `row`'s `updated_at` after a raise or an intent carrying `mark`, at `updatedAt`. */
function stampWith(updatedAt: string, mark: string, row: Record<string, unknown> | null): string {
  const raises = raiseMarks(row).filter((each) => !isIntent(each));
  return `${updatedAt}#${[mark, ...raises.slice(0, isIntent(mark) ? RAISE_HISTORY : RAISE_HISTORY - 1)].join(" ")}`;
}

/**
 * Whether the revision row write that carried `mark` committed, read from the
 * record's revision row: its mark is kept. Otherwise the write either never
 * committed or its mark was dropped after RAISE_HISTORY later raises; the
 * caller raises the record again either way. A write whose raise cannot be
 * proven is then counted once more, never not at all.
 */
function raisedBy(row: Record<string, unknown> | null, mark: string | undefined): boolean {
  return mark !== undefined && raiseMarks(row).includes(mark);
}

interface Raised {
  rev: number;
  deleted: boolean;
}

async function raiseRevision(
  db: Adapter,
  namespace: string,
  resource: string,
  recordId: string,
  decide: RaiseDecision,
  options: { lockFirst?: boolean; outcome?: BumpOutcome; pending?: PendingRaise; inTransaction: boolean },
): Promise<Raised | undefined> {
  const id = revisionRowId(namespace, resource, recordId);
  const where = [{ field: "id", op: "eq" as const, value: id }];
  const snapshotReads = readsMayBeSnapshot(db);
  const { inTransaction } = options;
  const pending = options.pending ?? {};
  if (pending.mark !== undefined) {
    if (raisedBy(await db.internal.findOne(REVISIONS_TABLE, where), pending.mark)) {
      return { rev: pending.rev!, deleted: pending.deleted! };
    }
    pending.mark = undefined;
  }
  for (let attempt = 0; attempt < MAX_BUMP_ATTEMPTS; attempt++) {
    const updatedAt = new Date().toISOString();
    if (options.outcome) options.outcome.staleView = attempt > 0 && snapshotReads;
    // A retry follows a write that committed after this transaction's read;
    // a plain read in a snapshot would return the same stale revision again.
    // A decision that depends on the latest row locks it before reading.
    if ((attempt > 0 && inTransaction) || options.lockFirst) await writeLatest(db, id, updatedAt);
    const row = await db.internal.findOne(REVISIONS_TABLE, where);
    const decided = await decide(row);
    if (decided === undefined) return undefined;
    const { deleted } = decided;
    const mark = newMark(decided.byDelete ? BY_DELETE : OTHER);
    const current = row ? Number(row.rev) || 0 : 0;
    // A raise may count a state no raise named (see Decided.skip).
    const next = current + 1 + (decided.skip ?? 0);
    Object.assign(pending, { rev: next, deleted, mark });
    const stamp = stampWith(updatedAt, mark, row);
    if (!row) {
      const created = await createIfAbsent(db, {
        id,
        namespace,
        resource,
        record_id: recordId,
        rev: next,
        deleted: deleted ? 1 : 0,
        updated_at: stamp,
      }, inTransaction);
      if (created === "created") return { rev: next, deleted };
      pending.mark = undefined;
      continue;
    }
    const affected = await db.internal.update(
      REVISIONS_TABLE,
      [...where, { field: "rev", op: "eq", value: current }],
      { rev: next, deleted: deleted ? 1 : 0, updated_at: stamp },
    );
    if (affected > 0) return { rev: next, deleted };
    // Another writer committed first: this write is proven not to have raised.
    pending.mark = undefined;
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
 * One write's revision assignment. `evidence` is what the write's own
 * statements proved about each record row, taken once when the write's
 * entries are first assigned and never read from the write log again; `done`
 * holds the last entries whose revision was raised and whose committed row
 * was recorded. A retry of the same entries (change tracking outside a
 * transaction) keeps every revision already raised, raises only the records
 * not yet raised, and reaches the same decisions from the same evidence.
 */
interface WriteAssignment {
  entries: ReadonlyArray<WriteEntry>;
  evidence: Map<string, RecordEvidence>;
  bumped: WeakSet<object>;
  done: WeakSet<object>;
  pending: WeakMap<object, PendingRaise>;
  complete: boolean;
}

const assignments = new WeakMap<object, WriteAssignment>();

/** The assignment `entries` already belong to, or a new one with the evidence `db` recorded. */
function assignmentOf(db: Adapter, entries: ReadonlyArray<WriteEntry>): WriteAssignment {
  for (const entry of entries) {
    const existing = assignments.get(entry);
    if (existing) return existing;
  }
  const write: WriteAssignment = {
    entries: [...entries],
    evidence: takeWriteEvidence(db),
    bumped: new WeakSet(),
    done: new WeakSet(),
    pending: new WeakMap(),
    complete: false,
  };
  for (const entry of entries) assignments.set(entry, write);
  return write;
}

/**
 * Raises one record's revision from its evidence and sets it on the record's
 * last entry. The evidence decides only whether the write moves the record's
 * revision row; the state it leaves (tombstone or live) is the record's latest
 * committed state:
 * - a proven write (a create, upsert, update returned by its statement, or a
 *   counted delete) always moves it;
 * - an update re-selected from a possible snapshot, which may have changed
 *   nothing, moves nothing over a tombstone, read after the revision row is
 *   locked;
 * - a delete without a count raises a tombstone when a read finds the row
 *   absent (a transaction sees its own delete). Inside a transaction it
 *   raises nothing over a tombstone: deletes of one row are serialized by its
 *   lock, so the row was already removed. Outside one, the reads before its
 *   statement decide (countlessRemovedNothing). When
 *   the row is present the delete may have removed nothing (a suppressed
 *   delete), and a writer that re-created it has raised past the deleted
 *   state, so it raises only for an earlier write of the same write that
 *   changed the row (`before`), live;
 * - inside a transaction (`transactional`) the write's own row lock keeps the
 *   state its statement left;
 * - outside a transaction, or for an entry recording another state than the
 *   statement left (a KV change rewritten to another writer's state), the
 *   state is read from the record row in each compare-and-swap attempt, after
 *   that attempt's revision row read: a writer committing later raises after
 *   its own write, so the last raise leaves the latest state. A write that
 *   left the row live and finds it removed under a count-less delete's
 *   intent (stampIntent) raises past the live state to that delete's
 *   tombstone, since that delete raised nothing.
 * The entry carries the revision only when it records the state its own
 * statement left and the raise left that state; a rewritten entry carries
 * none. `pending` is this record's last revision row write, so a retry
 * after an unknown outcome adopts it (see PendingRaise), or raises again when
 * its mark is not kept (raisedBy).
 */
async function raiseFromEvidence(
  db: Adapter,
  namespace: string,
  entry: WriteEntry,
  evidence: RecordEvidence,
  pending: PendingRaise,
  transactional: boolean,
): Promise<void> {
  const recordsDelete = entry.op === "delete";
  const countless = evidence.absentNow !== undefined;
  // A write that may have changed nothing; an earlier proven write of the
  // same write (`before`) still changed the record.
  const unproven = (evidence.state === "unverified" || countless) && evidence.before?.state !== "applied";
  const rewritten = recordsDelete !== evidence.deleted;
  const ownState = transactional && !countless && !rewritten;
  const where = [{ field: "id", operator: "eq" as const, value: entry.id }];
  const absentNow = evidence.absentNow ??
    (async () => (await db.findOne({ model: entry.resource, where, namespace })) === null);
  // Whether a count-less delete that leaves the row absent removed nothing.
  const removedNothing = (row: Record<string, unknown> | null) => {
    if (!unproven) return false;
    if (transactional || evidence.presentBefore === undefined) return isTombstone(row);
    return countlessRemovedNothing(evidence, row);
  };
  const decide: RaiseDecision = async (row) => {
    if (countless) {
      if (await absentNow()) return removedNothing(row) ? undefined : { deleted: true, byDelete: true };
      return evidence.before && !(unproven && isTombstone(row)) ? { deleted: false } : undefined;
    }
    if (unproven && isTombstone(row)) return undefined;
    if (ownState) return { deleted: evidence.deleted, byDelete: evidence.deleted };
    const absent = await absentNow();
    if (absent && !evidence.deleted && !transactional && intentCounted(evidence, row)) {
      return { deleted: true, byDelete: true, skip: 1 };
    }
    return { deleted: absent, byDelete: absent && evidence.deleted };
  };
  const outcome: BumpOutcome = {};
  const lockFirst = unproven && transactional;
  const raised = await raiseRevision(db, namespace, entry.resource, entry.id, decide, {
    lockFirst,
    outcome,
    pending,
    inTransaction: transactional,
  });
  entry.rev = !rewritten && raised?.deleted === recordsDelete ? raised.rev : undefined;
  const unverified = evidence.state === "unverified" || evidence.before?.state === "unverified";
  if (raised && (entry.rev === undefined || outcome.staleView || unverified)) {
    entry.revUncertified = true;
  }
}

/**
 * Raises the revision of each record one write changes exactly once, inside
 * the write's transaction, however many change entries the write recorded
 * for it (an insert and its inherited-inactive update are one write). A
 * record is raised only on the evidence of the write's own statements
 * (`withWriteEvidence` on `db`), to its latest committed state (see
 * raiseFromEvidence; `transactional` when the write and its raises share one
 * transaction). A record no statement changed (a relation update or delete that matched no row)
 * raises nothing, and its change row and result carry no revision. Only the
 * record's last entry carries the new revision. Where `completeRow` holds, a
 * last entry that writes a whole record (insert, replace, upsert, or any KV
 * write) records the stored row read on `db` after the write, so a change
 * carrying a revision always carries the exact committed row. Assigning
 * entries again (a retry) keeps the revisions already raised.
 */
export async function assignWriteRevisions(
  db: Adapter,
  namespace: string,
  entries: ReadonlyArray<WriteEntry>,
  completeRow: (resource: string) => boolean,
  schema?: DatafnSchema,
  transactional = false,
): Promise<void> {
  const write = assignmentOf(db, entries);
  if (write.complete) return;
  const last = new Map<string, WriteEntry>();
  for (const entry of write.entries) {
    if (tracksRevisions(entry.resource, schema)) last.set(JSON.stringify([entry.resource, entry.id]), entry);
  }
  for (const [key, entry] of last) {
    if (write.done.has(entry)) continue;
    const evidence = write.evidence.get(key);
    if (!evidence || evidence.state === "missed") {
      entry.rev = undefined;
    } else {
      if (!write.bumped.has(entry)) {
        // Records are raised one at a time: they share the write's
        // transaction (one connection), and the order keeps lock order stable.
        let pending = write.pending.get(entry);
        if (!pending) write.pending.set(entry, (pending = {}));
        await raiseFromEvidence(db, namespace, entry, evidence, pending, transactional);
        write.bumped.add(entry);
      }
      const wholeRow = entry.op !== "delete" && (entry.op !== "merge" || isKvResource(entry.resource));
      if (entry.rev !== undefined && wholeRow && completeRow(entry.resource)) {
        const stored = await db.findOne({
          model: entry.resource,
          where: [{ field: "id", operator: "eq", value: entry.id }],
          namespace,
        });
        if (stored) entry.record = { ...(stored as Record<string, unknown>) };
        else entry.rev = undefined;
      }
    }
    write.done.add(entry);
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
