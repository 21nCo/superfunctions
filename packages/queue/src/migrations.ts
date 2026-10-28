import type { QueueSqlDialect } from './sql-client.js';
import { QueueError } from './validation.js';

export const DEFAULT_QUEUE_JOBS_TABLE = 'queue_jobs';

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;

export function quoteQueueTableName(tableName: string): string {
  if (typeof tableName !== 'string' || !TABLE_NAME_RE.test(tableName)) {
    throw new QueueError('FLOWFN_QUEUE_TABLE_NAME_INVALID');
  }
  return `"${tableName}"`;
}

/**
 * DDL for the jobs table, one statement per entry, safe to re-run.
 *
 * Times are epoch milliseconds. `id` never repeats (AUTOINCREMENT / identity),
 * so a stale id cannot address a later job. The partial unique index makes a
 * `dedupe_key` unique only among pending and leased jobs.
 */
export function queueJobsMigrationStatements(
  dialect: QueueSqlDialect,
  tableName: string = DEFAULT_QUEUE_JOBS_TABLE
): string[] {
  const table = quoteQueueTableName(tableName);
  const index = (suffix: string) => `"${tableName}_${suffix}"`;
  const id =
    dialect === 'postgres'
      ? 'id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
      : 'id INTEGER PRIMARY KEY AUTOINCREMENT';
  const payload = dialect === 'postgres' ? 'payload JSON NOT NULL' : 'payload TEXT NOT NULL';
  const time = dialect === 'postgres' ? 'BIGINT' : 'INTEGER';

  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  ${id},
  queue TEXT NOT NULL,
  ${payload},
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'dead')),
  attempt INTEGER NOT NULL DEFAULT 0,
  available_at ${time} NOT NULL,
  lease_until ${time},
  dedupe_key TEXT,
  last_error TEXT,
  created_at ${time} NOT NULL,
  updated_at ${time} NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS ${index('available_idx')} ON ${table} (queue, state, available_at, id)`,
    `CREATE INDEX IF NOT EXISTS ${index('lease_idx')} ON ${table} (queue, state, lease_until)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${index('dedupe_idx')} ON ${table} (queue, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('pending', 'leased')`,
  ];
}

/** The migration as one SQL script, matching the files shipped under `migrations/`. */
export function queueJobsMigrationSql(dialect: QueueSqlDialect, tableName: string = DEFAULT_QUEUE_JOBS_TABLE): string {
  return `${queueJobsMigrationStatements(dialect, tableName).join(';\n\n')};\n`;
}
