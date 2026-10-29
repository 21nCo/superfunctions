/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { authFnSqliteSchema } from '../sqlite/fixture.js';
import { describeAuthFnSqliteConformance } from '../sqlite/suite.js';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

describeAuthFnSqliteConformance('Cloudflare D1 (workerd)', async () => {
  // isolatedStorage gives every test an empty D1 database, so close() has nothing to drop.
  return {
    db: drizzle(env.DB, { schema: authFnSqliteSchema }),
    async exec(statements) {
      for (const statement of statements) await env.DB.prepare(statement).run();
    },
    async all(sql, ...params) {
      return (await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>()).results;
    },
    close() {}
  };
});
