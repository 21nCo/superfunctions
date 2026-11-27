import type { Adapter, InternalColumnDef } from "@superfunctions/db";

const META_COLUMNS: InternalColumnDef[] = [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "next_server_seq", type: "integer" },
];

const CHANGES_COLUMNS: InternalColumnDef[] = [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "server_seq", type: "integer" },
  { name: "resource", type: "text" },
  { name: "record_id", type: "text" },
  { name: "op", type: "text" },
  { name: "record", type: "text" },
  { name: "created_at", type: "text" },
  // DATA-41: the record's revision after this change. Added to existing
  // tables by `ensureChangesRevColumn`; NULL on rows written before it.
  { name: "rev", type: "integer" },
  // DATA-41: 1 when the writer committed the change together with its
  // revision (in one database transaction), so the recorded row is the state
  // at `rev`; 0 or NULL otherwise. Pull pairs a row with `rev` only then.
  { name: "rev_certified", type: "integer" },
];

/** DATA-41: the late `__datafn_changes` columns a change row's revision needs. */
const CHANGES_REVISION_COLUMNS = ["rev", "rev_certified"] as const;

/**
 * Columns a table may still lack on a database created before they were
 * added; they are added on first use, so namespace planning does not require
 * them.
 */
export const LATE_INTERNAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  __datafn_changes: CHANGES_REVISION_COLUMNS,
};

/** DATA-41: one row per record, kept as a tombstone when the record is deleted. */
const REVISIONS_COLUMNS: InternalColumnDef[] = [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "resource", type: "text" },
  { name: "record_id", type: "text" },
  { name: "rev", type: "integer" },
  { name: "deleted", type: "integer" },
  { name: "updated_at", type: "text" },
];

const IDEMPOTENCY_COLUMNS: InternalColumnDef[] = [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "client_id", type: "text" },
  { name: "mutation_id", type: "text" },
  { name: "result", type: "text" },
  { name: "created_at", type: "text" },
];

const SEED_COLUMNS: InternalColumnDef[] = [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "seed_id", type: "text" },
  { name: "status", type: "text" },
  { name: "created_at", type: "text" },
];

const PERMISSION_DIRECTORY_OUTBOX_COLUMNS: InternalColumnDef[] = [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "region_id", type: "text" },
  { name: "mutation", type: "text" },
  { name: "attempts", type: "integer" },
  { name: "last_error", type: "text" },
  { name: "next_attempt_at", type: "text" },
  { name: "created_at", type: "text" },
];

/**
 * LOW-012: Internal table schemas — index specifications:
 * - __datafn_meta: PK on (id). Used for namespace-scoped sequence tracking.
 * - __datafn_changes: PK on (id). Index on (namespace, server_seq) for sync pull range queries.
 * - __datafn_idempotency: PK on (id). Index on (namespace, client_id, mutation_id) for dedup lookups.
 * - __datafn_seed: PK on (id). Index on (namespace, seed_id) for seed status lookups.
 * - __datafn_permission_directory_outbox: PK on (id). Durable retry queue for
 *   post-commit multi-region permission-directory reconciliation.
 * - __datafn_revisions: PK on (id), a digest of (namespace, resource, record id).
 *   Per-record revisions; never pruned.
 */
export const INTERNAL_TABLE_SCHEMAS: Record<string, InternalColumnDef[]> = {
  __datafn_meta: META_COLUMNS,
  __datafn_changes: CHANGES_COLUMNS,
  __datafn_idempotency: IDEMPOTENCY_COLUMNS,
  __datafn_seed: SEED_COLUMNS,
  __datafn_permission_directory_outbox: PERMISSION_DIRECTORY_OUTBOX_COLUMNS,
  __datafn_revisions: REVISIONS_COLUMNS,
};

export function listNamespacedInternalTables(): string[] {
  return Object.entries(INTERNAL_TABLE_SCHEMAS)
    .filter(([, columns]) => columns.some((column) => column.name === "namespace"))
    .map(([name]) => name)
    .sort();
}

export async function ensureInternalTable(
  adapter: Adapter,
  tableName: string,
): Promise<void> {
  const columns = INTERNAL_TABLE_SCHEMAS[tableName];
  if (!columns) {
    throw new Error(
      `Unknown internal table: "${tableName}". Expected one of: ${Object.keys(INTERNAL_TABLE_SCHEMAS).join(", ")}`,
    );
  }
  await adapter.internal.ensureTable(tableName, columns);
}

const adapterTargets = new WeakMap<object, object>();

/**
 * DATA-41: the adapter a per-write wrapper (withWriteEvidence) stands for, so
 * state kept per adapter (namespace locks, prepared tables) is shared with it.
 */
export function adapterIdentity(adapter: object): object {
  return adapterTargets.get(adapter) ?? adapter;
}

export function registerAdapterWrapper(wrapper: object, adapter: object): void {
  adapterTargets.set(wrapper, adapterIdentity(adapter));
}

const changesRevColumnReady = new WeakMap<object, { ready: Promise<boolean>; at: number }>();

/** How long a finding that the columns are missing is kept before probing again. */
export const CHANGES_REV_COLUMN_RECHECK_MS = 60_000;

/**
 * Adds the `rev` and `rev_certified` columns to a `__datafn_changes` table
 * created before DATA-41 and resolves whether change rows may carry them.
 * Stores without a fixed schema keep any column; a SQL database without raw
 * SQL access is probed. Runs outside any transaction (a failed probe would
 * abort a PostgreSQL transaction). Columns found are kept for the adapter's
 * lifetime; a finding that they are missing is probed again after
 * CHANGES_REV_COLUMN_RECHECK_MS, so a migration that adds them later is
 * picked up without recreating the adapter.
 */
export function ensureChangesRevColumn(adapter: Adapter, now: number = Date.now()): Promise<boolean> {
  const key = adapterIdentity(adapter);
  const cached = changesRevColumnReady.get(key);
  if (cached) return cached.ready.then((ok) => ok || now - cached.at < CHANGES_REV_COLUMN_RECHECK_MS
    ? ok
    : reprobeChangesRevColumns(adapter, key, cached, now));
  return startChangesRevProbe(adapter, key, now);
}

function startChangesRevProbe(adapter: Adapter, key: object, now: number): Promise<boolean> {
  const entry = { ready: addChangesRevColumns(adapter), at: now };
  changesRevColumnReady.set(key, entry);
  entry.ready.catch(() => {
    if (changesRevColumnReady.get(key) === entry) changesRevColumnReady.delete(key);
  });
  return entry.ready;
}

function reprobeChangesRevColumns(
  adapter: Adapter,
  key: object,
  stale: { ready: Promise<boolean>; at: number },
  now: number,
): Promise<boolean> {
  // A concurrent caller may have started the probe already.
  const current = changesRevColumnReady.get(key);
  if (current && current !== stale) return current.ready;
  return startChangesRevProbe(adapter, key, now);
}

/** A filter on a column name no table has, to tell a real probe from a lax one. */
const ABSENT_COLUMN = "__datafn_absent_column_probe";

async function addChangesRevColumns(adapter: Adapter): Promise<boolean> {
  const rawSql = adapter.rawSql;
  if (!rawSql) {
    // Stores without a fixed schema (memory, KV) keep any column.
    if (adapter.capabilities?.schema?.constraints !== true) return true;
    // A SQL database reached without raw SQL (Prisma) cannot be altered
    // here: change rows carry `rev` only if the table already has both
    // columns. A probe is trusted only when the same probe on a column that
    // cannot exist fails (a driver that reads an unknown quoted name as a
    // string literal accepts both), otherwise no change row records `rev`.
    const probe = async (field: string) => {
      try {
        await adapter.internal.findMany("__datafn_changes", [{ field, op: "eq", value: -1 }], { limit: 1 });
        return true;
      } catch {
        return false;
      }
    };
    if (await probe(ABSENT_COLUMN)) return false;
    const found = await Promise.all(CHANGES_REVISION_COLUMNS.map(probe));
    return found.every(Boolean);
  }
  for (const column of CHANGES_REVISION_COLUMNS) await addChangesColumn(rawSql, column);
  return true;
}

async function addChangesColumn(rawSql: NonNullable<Adapter["rawSql"]>, column: string): Promise<void> {
  // Read the column from the catalog: an unqualified `SELECT "rev"` succeeds
  // on SQLite builds that read unknown double-quoted names as strings.
  if (await changesTableHasColumn(rawSql, column)) return;
  if (rawSql.dialect === "postgres") {
    // Only when the catalog lacks the column, so a role without ownership of
    // an upgraded table, and every later start, never needs the ALTER lock.
    await rawSql.execute(`ALTER TABLE "__datafn_changes" ADD COLUMN IF NOT EXISTS "${column}" integer`);
    return;
  }
  // SQLite and MySQL have no ADD COLUMN IF NOT EXISTS: after a failed ALTER
  // (another worker added it meanwhile, or a driver that wraps the
  // duplicate-column error) read the catalog again.
  const quote = rawSql.dialect === "mysql" ? "`" : '"';
  try {
    await rawSql.execute(`ALTER TABLE ${quote}__datafn_changes${quote} ADD COLUMN ${quote}${column}${quote} integer`);
  } catch (error) {
    if (!(await changesTableHasColumn(rawSql, column))) throw error;
  }
}

async function changesTableHasColumn(rawSql: NonNullable<Adapter["rawSql"]>, column: string): Promise<boolean> {
  if (rawSql.dialect === "sqlite") {
    const columns = await rawSql.query('PRAGMA table_info("__datafn_changes")');
    return columns.some((row) => row.name === column);
  }
  if (rawSql.dialect === "postgres") {
    const rows = await rawSql.query(
      `SELECT 1 AS present FROM pg_attribute WHERE attrelid = to_regclass('"__datafn_changes"') AND attname = '${column}' AND NOT attisdropped`,
    );
    return rows.length > 0;
  }
  const rows = await rawSql.query(
    `SELECT 1 AS present FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '__datafn_changes' AND column_name = '${column}'`,
  );
  return rows.length > 0;
}
