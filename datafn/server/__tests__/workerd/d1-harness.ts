import { drizzle } from "drizzle-orm/d1";
import { drizzleSchema } from "../drizzle-sqlite/fixture.js";
import type { SqliteHarness } from "../drizzle-sqlite/suite.js";

/** Tables a test created; SQLite's own `sqlite_*` and D1's reserved `_cf_*` tables are excluded. */
export const USER_TABLES_SQL = String.raw`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\' ORDER BY name`;

/**
 * Serves the conformance suite from the `DB` binding, starting from an empty
 * database. isolatedStorage normally gives each test an empty database, but if
 * a test's storage pop fails, the next test inherits its tables, so this drops
 * any it finds instead of letting `CREATE TABLE` fail with "already exists".
 */
export async function createD1Harness(db: D1Database): Promise<SqliteHarness> {
  const { results } = await db.prepare(USER_TABLES_SQL).all<{ name: string }>();
  if (results.length > 0) {
    await db.batch([
      // Lets a table be dropped before the tables that reference it.
      db.prepare("PRAGMA defer_foreign_keys = on"),
      ...results.map(({ name }) => db.prepare(`DROP TABLE "${name.replaceAll('"', '""')}"`)),
    ]);
  }
  return {
    db: drizzle(db, { schema: drizzleSchema }),
    async exec(statements) {
      await db.batch(statements.map((statement) => db.prepare(statement)));
    },
    async all(sql) {
      return (await db.prepare(sql).all<Record<string, unknown>>()).results;
    },
    close() {},
  };
}
