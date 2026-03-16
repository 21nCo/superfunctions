/**
 * Postgres schema bootstrap for SearchFn adapter.
 *
 * Creates adapter-owned tables and indices idempotently.
 * Uses a single table per resource with Postgres-native tsvector for full-text search.
 */
import type { Pool } from "pg";

/**
 * Name of the schema table that tracks initialized resources and their fields.
 */
export const META_TABLE = "searchfn_meta";

/**
 * Prefix for per-resource document tables.
 */
export const TABLE_PREFIX = "searchfn_docs_";

/**
 * Sanitize a resource name to a safe SQL identifier suffix.
 * Only allows lowercase alphanumeric and underscores.
 */
export function sanitizeResourceName(resource: string): string {
  return resource.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
}

/**
 * Get the fully qualified table name for a resource, optionally within a schema.
 */
export function resourceTableName(resource: string, schema?: string): string {
  const table = `${TABLE_PREFIX}${sanitizeResourceName(resource)}`;
  return schema ? `"${schema}".${table}` : table;
}

/**
 * Bootstrap the meta table if it doesn't exist.
 */
export async function ensureMetaTable(pool: Pool, schema?: string): Promise<void> {
  const schemaPrefix = schema ? `"${schema}".` : "";
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${schemaPrefix}${META_TABLE} (
      resource TEXT PRIMARY KEY,
      search_fields TEXT[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * Bootstrap a per-resource document table with tsvector index.
 */
export async function ensureResourceTable(
  pool: Pool,
  resource: string,
  searchFields: string[],
  schema?: string,
): Promise<void> {
  const table = resourceTableName(resource, schema);
  const safeName = sanitizeResourceName(resource);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      doc_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      field_value TEXT NOT NULL DEFAULT '',
      tsv TSVECTOR NOT NULL DEFAULT ''::tsvector,
      PRIMARY KEY (doc_id, field_name)
    )
  `);

  // GIN index on tsvector for fast full-text search
  const indexName = `idx_${TABLE_PREFIX}${safeName}_tsv`;
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING GIN (tsv)
  `);

  // Upsert into meta table
  const schemaPrefix = schema ? `"${schema}".` : "";
  await pool.query(
    `INSERT INTO ${schemaPrefix}${META_TABLE} (resource, search_fields)
     VALUES ($1, $2)
     ON CONFLICT (resource) DO UPDATE SET search_fields = EXCLUDED.search_fields`,
    [resource, searchFields],
  );
}

/**
 * Drop a resource table and remove its meta entry.
 */
export async function dropResourceTable(
  pool: Pool,
  resource: string,
  schema?: string,
): Promise<void> {
  const table = resourceTableName(resource, schema);
  const schemaPrefix = schema ? `"${schema}".` : "";
  await pool.query(`DROP TABLE IF EXISTS ${table}`);
  await pool.query(`DELETE FROM ${schemaPrefix}${META_TABLE} WHERE resource = $1`, [resource]);
}
