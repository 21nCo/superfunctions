/**
 * Postgres schema bootstrap for SearchFn adapter.
 *
 * Creates adapter-owned tables and indices idempotently.
 * Uses a single table per resource with Postgres-native tsvector for full-text search.
 */
import { createHash } from "node:crypto";
import type { PostgresQueryable } from "./driver";

/**
 * Name of the schema table that tracks initialized resources and their fields.
 */
export const META_TABLE = "searchfn_meta";

/**
 * Prefix for per-resource document tables.
 */
export const TABLE_PREFIX = "searchfn_docs_";
const PG_IDENTIFIER_MAX = 63;

/**
 * Sanitize a resource name to a safe SQL identifier suffix.
 * Only allows lowercase alphanumeric and underscores.
 */
export function sanitizeResourceName(resource: string): string {
  return resource.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
}

function boundedIdentifier(prefix: string, raw: string): string {
  const sanitized = `${prefix}${sanitizeResourceName(raw)}`;
  if (sanitized.length <= PG_IDENTIFIER_MAX) {
    return sanitized;
  }
  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  const maxBaseLength = PG_IDENTIFIER_MAX - prefix.length - hash.length - 1;
  return `${prefix}${sanitizeResourceName(raw).slice(0, Math.max(maxBaseLength, 1))}_${hash}`;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/**
 * Encode a string list as a Postgres array literal for a `text[]` parameter.
 *
 * Every parameter the adapter sends is a string or number, so an injected driver never has to
 * serialize arrays (postgres.js cannot without fetching types, which Hyperdrive setups disable).
 * The encoding matches what `pg` itself sends for a JavaScript array, so the wire value is unchanged.
 */
export function textArrayParam(items: readonly string[]): string {
  const elements = items.map((item) =>
    item === null || item === undefined ? "NULL" : `"${String(item).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `{${elements.join(",")}}`;
}

/**
 * Get the fully qualified table name for a resource, optionally within a schema.
 */
export function resourceTableName(resource: string, schema?: string): string {
  const table = boundedIdentifier(TABLE_PREFIX, resource);
  return schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(table)}` : quoteIdentifier(table);
}

/**
 * Bootstrap the meta table if it doesn't exist.
 */
export async function ensureMetaTable(db: PostgresQueryable, schema?: string): Promise<void> {
  const schemaPrefix = schema ? `${quoteIdentifier(schema)}.` : "";
  await db.query(`
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
  db: PostgresQueryable,
  resource: string,
  searchFields: string[],
  schema?: string,
): Promise<void> {
  const table = resourceTableName(resource, schema);
  const safeName = boundedIdentifier(TABLE_PREFIX, resource).replace(TABLE_PREFIX, "");

  await db.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      doc_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      field_value TEXT NOT NULL DEFAULT '',
      tsv TSVECTOR NOT NULL DEFAULT ''::tsvector,
      PRIMARY KEY (doc_id, field_name)
    )
  `);

  // GIN index on tsvector for fast full-text search
  const indexName = quoteIdentifier(boundedIdentifier("idx_", `${TABLE_PREFIX}${safeName}_tsv`));
  await db.query(`
    CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING GIN (tsv)
  `);

  // Upsert into meta table
  const schemaPrefix = schema ? `${quoteIdentifier(schema)}.` : "";
  await db.query(
    `INSERT INTO ${schemaPrefix}${META_TABLE} (resource, search_fields)
     VALUES ($1, $2)
     ON CONFLICT (resource) DO UPDATE SET search_fields = EXCLUDED.search_fields`,
    [resource, textArrayParam(searchFields)],
  );
}

/**
 * Drop a resource table and remove its meta entry.
 */
export async function dropResourceTable(
  db: PostgresQueryable,
  resource: string,
  schema?: string,
): Promise<void> {
  const table = resourceTableName(resource, schema);
  const schemaPrefix = schema ? `${quoteIdentifier(schema)}.` : "";
  await db.query(`DROP TABLE IF EXISTS ${table}`);
  await db.query(`DELETE FROM ${schemaPrefix}${META_TABLE} WHERE resource = $1`, [resource]);
}
