/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { drizzleSchema } from "../drizzle-sqlite/fixture.js";
import { describeDrizzleSqliteConformance } from "../drizzle-sqlite/suite.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

describeDrizzleSqliteConformance("Cloudflare D1 (workerd)", async () => {
  // isolatedStorage gives every test an empty D1 database, so close() has nothing to drop.
  return {
    db: drizzle(env.DB, { schema: drizzleSchema }),
    async exec(statements) {
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
    },
    async all(sql) {
      return (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;
    },
    close() {},
  };
});
