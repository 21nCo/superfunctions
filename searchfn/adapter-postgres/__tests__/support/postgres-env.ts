/**
 * Shared Postgres test setup (see docker-compose.postgres.yml). Suites skip when the server is
 * unreachable, unless SEARCHFN_PG_REQUIRED=1, which CI's Postgres job sets so a skip cannot pass.
 */
import { Pool } from "pg";

export const PG_URL =
  process.env.SEARCHFN_PG_URL ?? "postgres://searchfn:searchfn_test@localhost:5433/searchfn_test";

export async function postgresAvailable(): Promise<boolean> {
  const pool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (error) {
    if (process.env.SEARCHFN_PG_REQUIRED === "1") {
      throw new Error(`SEARCHFN_PG_REQUIRED=1 but Postgres is unreachable: ${(error as Error).message}`);
    }
    console.warn("Postgres not available, skipping injected-driver suites");
    return false;
  } finally {
    await pool.end();
  }
}

/** Run `fn` with a short-lived pg Pool for setup and inspection. */
export async function withAdminPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: PG_URL, connectionTimeoutMillis: 3000 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/** Drop and recreate `schema`, so each suite owns its tables and cannot race other files. */
export function resetSchema(schema: string): Promise<void> {
  return withAdminPool(async (pool) => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${schema}"`);
  });
}

/** Delete every indexed row in `schema`, keeping the tables. */
export function clearSchema(schema: string): Promise<void> {
  return withAdminPool(async (pool) => {
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'searchfn_docs_%'`,
      [schema],
    );
    for (const { tablename } of rows) {
      await pool.query(`DELETE FROM "${schema}"."${tablename}"`);
    }
  });
}
