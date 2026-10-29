import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzleSchema } from "./fixture.js";
import { describeDrizzleSqliteConformance } from "./suite.js";

describeDrizzleSqliteConformance("better-sqlite3", async () => {
  const sqlite = new Database(":memory:");
  return {
    db: drizzle(sqlite, { schema: drizzleSchema }),
    async exec(statements) {
      for (const statement of statements) sqlite.exec(statement);
    },
    async all(sql) {
      return sqlite.prepare(sql).all() as Record<string, unknown>[];
    },
    close() {
      sqlite.close();
    },
  };
});
