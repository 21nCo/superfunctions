import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { authFnSqliteSchema } from './fixture.js';
import { describeAuthFnSqliteConformance } from './suite.js';

describeAuthFnSqliteConformance('better-sqlite3', async () => {
  const sqlite = new Database(':memory:');
  return {
    db: drizzle(sqlite, { schema: authFnSqliteSchema }),
    async exec(statements) {
      for (const statement of statements) sqlite.exec(statement);
    },
    async all(sql, ...params) {
      return sqlite.prepare(sql).all(...params) as Record<string, unknown>[];
    },
    close() {
      sqlite.close();
    }
  };
});
