/**
 * The shared adapter contract, run through injected drivers against a real Postgres:
 * postgres.js with the client options Cloudflare recommends for Hyperdrive, and a caller-owned
 * pg Pool through fromPg. Each suite uses its own schema.
 */
import { afterAll, beforeAll, describe } from "vitest";
import { Pool } from "pg";
import postgres from "postgres";
import { runConformanceSuite } from "@searchfn/adapter-contracts/testing";
import { PostgresAdapter, fromPg, fromPostgresJs, type PostgresDriver } from "../../src/index";
import { PG_URL, clearSchema, postgresAvailable, resetSchema } from "../support/postgres-env";

const retry = { maxRetries: 1, baseDelayMs: 50 };

function injectedDriverSuite(name: string, schema: string, open: () => { driver: PostgresDriver; close: () => Promise<void> }) {
  describe(`PostgresAdapter conformance (${name})`, () => {
    let available = false;
    let connection: ReturnType<typeof open> | undefined;

    beforeAll(async () => {
      available = await postgresAvailable();
      if (!available) return;
      await resetSchema(schema);
      connection = open();
    });

    afterAll(async () => {
      await connection?.close();
    });

    runConformanceSuite({
      name,
      persistent: true,
      shouldSkip: () => !available,
      create: () => new PostgresAdapter({ driver: connection!.driver, schema, retry }),
      cleanup: () => clearSchema(schema),
    });
  });
}

injectedDriverSuite("postgres.js", "searchfn_conf_pgjs", () => {
  // Cloudflare's Hyperdrive guidance for postgres.js: a small pool and no type fetching.
  const sql = postgres(PG_URL, { max: 5, fetch_types: false });
  return { driver: fromPostgresJs(sql), close: () => sql.end() };
});

injectedDriverSuite("fromPg", "searchfn_conf_pg", () => {
  const pool = new Pool({ connectionString: PG_URL });
  return { driver: fromPg(pool), close: () => pool.end() };
});
