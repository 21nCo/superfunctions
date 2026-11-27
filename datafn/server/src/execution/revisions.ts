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
 * `created`, `exists`, or `unknown` when the insert failed and the stored
 * row may be this insert's with its mark dropped (see pendingOutcome).
 */
async function createIfAbsent(
  db: Adapter,
  row: Record<string, unknown>,
  inTransaction: boolean,
): Promise<"created" | "exists" | "unknown"> {
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
  const create = async (): Promise<"created" | "exists" | "unknown"> => {
    if (await db.internal.findOne(REVISIONS_TABLE, [{ field: "id", op: "eq", value: row.id }])) {
      return "exists";
    }
    try {
      await db.internal.create(REVISIONS_TABLE, row);
      return "created";
    } catch (error) {
      // The insert may have been stored before the adapter failed: a row
      // carrying this insert's raise mark is this insert.
      const stored = await db.internal.findOne(REVISIONS_TABLE, [{ field: "id", op: "eq", value: row.id }]);
      // Inside a transaction a failed insert never committed on its own (and
      // lock writes replace marks), so only a kept mark makes it this one.
      if (stored && inTransaction) return raiseMarks(stored).includes(raiseMarks(row)[0]) ? "created" : "exists";
      if (stored) {
        const ended = pendingOutcome(stored, { rev: 1, mark: raiseMarks(row)[0] });
        if (ended === "raised") return "created";
        return ended === "lost" ? "exists" : "unknown";
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
  return (await raiseRevision(db, namespace, resource, recordId, () => ({ deleted, byDelete: deleted })))!.rev;
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
  outcome?: BumpOutcome,
): Promise<number> {
  const decide = () => ({ deleted: true, byDelete: true });
  return (await raiseRevision(db, namespace, resource, recordId, decide, { outcome }))!.rev;
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
export function withWriteEvidence(db: Adapter, log: WriteEvent[] = []): Adapter {
  const note = (
    model: string,
    ids: readonly string[],
    deleted: boolean,
    state: WriteState,
    absentNow?: () => Promise<boolean>,
  ) => {
    for (const id of ids) log.push({ key: JSON.stringify([model, id]), deleted, state, absentNow });
  };
  const snapshot = readsMayBeSnapshot(db);
  const target = db as Adapter & Record<string, unknown>;
  // A current read of the rows `p.where` matches now.
  const present = async (p: any): Promise<Set<string>> =>
    new Set((await db.findMany({ model: p.model, where: p.where, namespace: p.namespace }))
      .map((row) => String((row as { id?: unknown }).id)));
  const writers: Record<string, (p: any, ...rest: unknown[]) => Promise<unknown>> = {
    async create(p) {
      const out = await db.create(p);
      if (typeof p.data?.id === "string") note(p.model, [p.data.id], false, "applied");
      return out;
    },
    async createMany(p) {
      const out = await db.createMany(p);
      for (const row of p.data ?? []) if (typeof row?.id === "string") note(p.model, [row.id], false, "applied");
      return out;
    },
    async upsert(p) {
      const out = await db.upsert(p);
      const id = idsOf(p.where, false) ?? (typeof p.create?.id === "string" ? [p.create.id] : []);
      note(p.model, id, false, "applied");
      return out;
    },
    async update(p) {
      const ids = idsOf(p.where, false);
      if (!ids) return db.update(p);
      let out: unknown;
      try {
        out = await db.update(p);
      } catch (error) {
        if (isNotFoundError(error)) note(p.model, ids, false, "missed");
        throw error;
      }
      if (out !== null && out !== undefined) {
        note(p.model, ids, false, updateResultIsCurrent(db) ? "applied" : "unverified");
      } else if (snapshot) {
        note(p.model, ids, false, "unverified");
      } else {
        note(p.model, ids, false, (await present(p)).size > 0 ? "applied" : "missed");
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
      try {
        await db.delete(p);
      } catch (error) {
        if (ids && isNotFoundError(error)) note(p.model, ids, true, "missed");
        throw error;
      }
      // The adapter's delete reports no count: whether it removed the row is
      // decided by a read of the row after the revision row is locked
      // (raiseFromEvidence). A transaction sees its own delete even where its
      // other reads are a snapshot.
      if (!ids) return;
      const absentNow = async () =>
        (await db.findOne({ model: p.model, where: p.where, namespace: p.namespace })) === null;
      note(p.model, ids, true, "applied", absentNow);
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
        (tx: Adapter) => fn(withWriteEvidence(tx, log)),
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
      folded.set(event.key, { state: event.state, deleted: event.deleted, absentNow: event.absentNow, before });
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

/** Whether `row`'s latest raise is a tombstone that a delete statement's own evidence raised. */
const deleteEvidenced = (row: Record<string, unknown> | null) =>
  isTombstone(row) && raiseMarks(row)[0]?.endsWith(BY_DELETE) === true;

/**
 * The revision row write a raise last sent, kept by its caller across a
 * retry: `mark` is unique to that write. Each raise stores its mark after the
 * time in the row's `updated_at` (`<ISO time>#<mark> <earlier marks>`) and
 * carries the previous marks forward (the compare-and-swap
 * on `rev` makes the marks it read the ones it replaces), so a write whose
 * outcome is unknown (the statement committed but the adapter then failed) is
 * found by its mark even after later writers raised the record, and a retry
 * adopts that revision instead of raising the record again (see
 * pendingOutcome).
 */
interface PendingRaise {
  rev?: number;
  deleted?: boolean;
  mark?: string;
}

/**
 * How many raise marks a revision row keeps: more than the raises other
 * writers make while one write retries, and short enough for a 255-character
 * column.
 */
const RAISE_HISTORY = 12;

function raiseMarks(row: Record<string, unknown> | null): string[] {
  const stamp = typeof row?.updated_at === "string" ? row.updated_at : "";
  const at = stamp.indexOf("#");
  return at < 0 ? [] : stamp.slice(at + 1).split(" ");
}

/**
 * How the raise `pending` last sent ended, read from the record's revision
 * row: `raised` when its mark is kept; `lost` when the marks kept reach back
 * to its revision without it (the i-th mark is the raise to `rev - i`: each
 * raise prepends its mark to the ones it replaced), so another writer took
 * that revision or none committed; `unknown` when its mark may have been
 * dropped (more than RAISE_HISTORY raises since). An `unknown` raise is never
 * sent again, so the record is not raised twice for one write, and its entry
 * carries no revision. The write is still acknowledged: every raise after
 * the lost one (at least RAISE_HISTORY) came after the write's own data
 * write, so the record's revision has moved past every value read before it.
 * A write that is then acknowledged without its own raise may only leave the
 * revision one lower than its count of writes, never shared by two states.
 */
function pendingOutcome(row: Record<string, unknown> | null, pending: PendingRaise): "raised" | "lost" | "unknown" {
  const marks = raiseMarks(row);
  if (marks.includes(pending.mark!)) return "raised";
  const current = row ? Number(row.rev) || 0 : 0;
  return current - marks.length < pending.rev! ? "lost" : "unknown";
}

interface Raised {
  rev: number;
  deleted: boolean;
  /** The raise may have committed before its acknowledgement was lost; see pendingOutcome. */
  unknown?: boolean;
}

async function raiseRevision(
  db: Adapter,
  namespace: string,
  resource: string,
  recordId: string,
  decide: RaiseDecision,
  options: { lockFirst?: boolean; outcome?: BumpOutcome; pending?: PendingRaise; inTransaction?: boolean } = {},
): Promise<Raised | undefined> {
  const id = revisionRowId(namespace, resource, recordId);
  const where = [{ field: "id", op: "eq" as const, value: id }];
  const snapshotReads = readsMayBeSnapshot(db);
  const inTransaction = options.inTransaction ?? transactionsUsable(db);
  const pending = options.pending ?? {};
  if (pending.mark !== undefined) {
    const ended = pendingOutcome(await db.internal.findOne(REVISIONS_TABLE, where), pending);
    if (ended !== "lost") return { rev: pending.rev!, deleted: pending.deleted!, unknown: ended === "unknown" };
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
    const mark = randomBytes(6).toString("hex") + (decided.byDelete ? BY_DELETE : OTHER);
    const current = row ? Number(row.rev) || 0 : 0;
    Object.assign(pending, { rev: current + 1, deleted, mark });
    const stamp = `${updatedAt}#${[mark, ...raiseMarks(row)].slice(0, RAISE_HISTORY).join(" ")}`;
    if (!row) {
      const created = await createIfAbsent(db, {
        id,
        namespace,
        resource,
        record_id: recordId,
        rev: 1,
        deleted: deleted ? 1 : 0,
        updated_at: stamp,
      }, inTransaction);
      if (created !== "exists") return { rev: 1, deleted, unknown: created === "unknown" };
      continue;
    }
    const affected = await db.internal.update(
      REVISIONS_TABLE,
      [...where, { field: "rev", op: "eq", value: current }],
      { rev: current + 1, deleted: deleted ? 1 : 0, updated_at: stamp },
    );
    if (affected > 0) return { rev: current + 1, deleted };
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
 *   absent (a transaction sees its own delete), unless the latest raise is
 *   already a delete's own tombstone (`deleteEvidenced`; inside a transaction
 *   any tombstone): then this delete may have removed nothing. A tombstone another write raised from an absence it
 *   observed never stands in for it, so where the two cannot be told apart
 *   the revision may skip a value, but is never shared by two states. When
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
 *   its own write, so the last raise leaves the latest state.
 * The entry carries the revision only when it records the state its own
 * statement left and the raise left that state; a rewritten entry carries
 * none. `pending` is this record's last revision row write, so a retry
 * after an unknown outcome adopts it (see PendingRaise), or leaves the entry
 * without a revision when its mark may have been dropped (pendingOutcome).
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
  // Inside a transaction the lock write (writeLatest) replaces the raise
  // marks, and each write raises before its row lock is released, so any
  // tombstone is a removal another delete raised; outside one, only a
  // tombstone a delete statement raised is (deleteEvidenced).
  const removedBefore = transactional ? isTombstone : deleteEvidenced;
  const absentNow = evidence.absentNow ??
    (async () => (await db.findOne({ model: entry.resource, where, namespace })) === null);
  const decide: RaiseDecision = async (row) => {
    if (countless) {
      if (await absentNow()) return unproven && removedBefore(row) ? undefined : { deleted: true, byDelete: true };
      return evidence.before && !(unproven && isTombstone(row)) ? { deleted: false } : undefined;
    }
    if (unproven && isTombstone(row)) return undefined;
    if (ownState) return { deleted: evidence.deleted, byDelete: evidence.deleted };
    const absent = await absentNow();
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
  entry.rev = !rewritten && !raised?.unknown && raised?.deleted === recordsDelete ? raised.rev : undefined;
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
