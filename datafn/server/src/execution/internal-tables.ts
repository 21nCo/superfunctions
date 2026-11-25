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
];

/**
 * Columns a table may still lack on a database created before they were
 * added; they are added on first use, so namespace planning does not require
 * them.
 */
export const LATE_INTERNAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  __datafn_changes: ["rev"],
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

const changesRevColumnReady = new WeakMap<object, Promise<boolean>>();

/**
 * Adds the `rev` column to a `__datafn_changes` table created before DATA-41
 * and resolves whether change rows may carry it. Stores without a fixed
 * schema keep any column; a SQL database without raw SQL access is probed.
 * Runs once per adapter, outside any transaction (a failed probe would abort
 * a PostgreSQL transaction).
 */
export function ensureChangesRevColumn(adapter: Adapter): Promise<boolean> {
  let ready = changesRevColumnReady.get(adapter);
  if (!ready) {
    ready = addChangesRevColumn(adapter);
    changesRevColumnReady.set(adapter, ready);
    ready.catch(() => changesRevColumnReady.delete(adapter));
  }
  return ready;
}

async function addChangesRevColumn(adapter: Adapter): Promise<boolean> {
  const rawSql = adapter.rawSql;
  if (!rawSql) {
    // Stores without a fixed schema (memory, KV) keep any column.
    if (adapter.capabilities?.schema?.constraints !== true) return true;
    // A SQL database reached without raw SQL (Prisma) cannot be altered
    // here: change rows carry `rev` only if the table already has it.
    try {
      await adapter.internal.findMany("__datafn_changes", [{ field: "rev", op: "eq", value: -1 }], { limit: 1 });
      return true;
    } catch {
      return false;
    }
  }
  if (rawSql.dialect === "postgres") {
    await rawSql.execute('ALTER TABLE "__datafn_changes" ADD COLUMN IF NOT EXISTS "rev" integer');
    return true;
  }
  // SQLite and MySQL have no ADD COLUMN IF NOT EXISTS: probe the column
  // first, and after a failed ALTER (another worker added it meanwhile, or a
  // driver that wraps the duplicate-column error) probe again.
  const quote = rawSql.dialect === "mysql" ? "`" : '"';
  const hasColumn = async () => {
    try {
      await rawSql.query(`SELECT ${quote}rev${quote} FROM ${quote}__datafn_changes${quote} LIMIT 0`);
      return true;
    } catch {
      return false;
    }
  };
  if (await hasColumn()) return true;
  try {
    await rawSql.execute(`ALTER TABLE ${quote}__datafn_changes${quote} ADD COLUMN ${quote}rev${quote} integer`);
  } catch (error) {
    if (!(await hasColumn())) throw error;
  }
  return true;
}
