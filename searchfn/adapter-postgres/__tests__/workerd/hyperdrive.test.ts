/// <reference types="@cloudflare/vitest-pool-workers" />
/**
 * postgres.js and pg inside workerd through a local Hyperdrive binding (Miniflare connects
 * straight to the test Postgres). Skips when the config found Postgres unreachable, unless
 * SEARCHFN_PG_REQUIRED=1. Live Hyperdrive is not exercised here.
 */
import { env } from "cloudflare:test";
import pg from "pg";
import postgres from "postgres";
import { beforeAll, describe, expect, it } from "vitest";
import { runConformanceSuite } from "@searchfn/adapter-contracts/testing";
import { PostgresAdapter, fromPg, fromPostgresJs, type PostgresDriver } from "../../src/index";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    /** Bound by vitest.workerd.config.ts only when the test Postgres is reachable. */
    HYPERDRIVE?: { connectionString: string };
    SEARCHFN_PG_REQUIRED: string;
  }
}

/**
 * Clients are not ended: postgres.js's workerd socket polyfill reports "Stream was cancelled" as
 * an unhandled rejection when it closes, and the isolate is torn down after the suite anyway.
 */
const bindings: Array<{ name: string; schema: string; open: (connectionString: string) => PostgresDriver }> = [
  {
    name: "postgres.js",
    schema: "searchfn_workerd_pgjs",
    // Cloudflare's Hyperdrive settings for postgres.js: a small pool and no type fetching.
    open: (connectionString) => fromPostgresJs(postgres(connectionString, { max: 5, fetch_types: false })),
  },
  {
    name: "pg",
    schema: "searchfn_workerd_pg",
    open: (connectionString) => fromPg(new pg.Pool({ connectionString, max: 5 })),
  },
];

for (const { name, schema, open } of bindings) {
  describe(`PostgresAdapter with ${name} in workerd (local Hyperdrive binding)`, () => {
    let driver: PostgresDriver | undefined;

    beforeAll(async () => {
      if (!env.HYPERDRIVE) {
        if (env.SEARCHFN_PG_REQUIRED === "1") throw new Error("SEARCHFN_PG_REQUIRED=1 but Postgres is unreachable");
        console.warn(`Postgres not available, skipping ${name} in workerd`);
        return;
      }
      driver = open(env.HYPERDRIVE.connectionString);
      await driver.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await driver.query(`CREATE SCHEMA "${schema}"`);
    });

    it("indexes atomically and searches through the Hyperdrive connection string", async (ctx) => {
      if (!driver) return ctx.skip();
      const adapter = new PostgresAdapter({ driver, schema });
      await adapter.initialize({ resources: [{ name: "memos", searchFields: ["title", "body"] }] });
      await adapter.index({
        resource: "memos",
        documents: [
          { id: 1, fields: { title: "Hyperdrive pooling", body: "workers" } },
          { id: "two", fields: { title: "Durable objects", body: "workers" } },
        ],
      });
      expect(await adapter.search({ resource: "memos", query: "hyper", prefix: true })).toEqual([1]);
      expect(await adapter.search({ resource: "memos", query: "workers", fields: ["body"] })).toEqual([1, "two"]);

      // A failing insert rolls back the batch's delete, so the old document stays searchable.
      const failing: PostgresDriver = {
        query: (sql, params) => driver!.query(sql, params),
        transaction: (fn) =>
          driver!.transaction!((tx) =>
            fn({
              query: (sql, params) =>
                sql.includes("INSERT INTO") ? Promise.reject(new Error("insert failed")) : tx.query(sql, params),
            }),
          ),
      };
      const failingAdapter = new PostgresAdapter({ driver: failing, schema, retry: { maxRetries: 0 } });
      await expect(
        failingAdapter.index({ resource: "memos", documents: [{ id: 1, fields: { title: "replaced" } }] }),
      ).rejects.toThrow(/insert failed/);
      expect(await adapter.search({ resource: "memos", query: "hyper", prefix: true })).toEqual([1]);
      await adapter.dispose();
    });

    describe("conformance", () => {
      runConformanceSuite({
        name: `${name}-workerd`,
        persistent: true,
        shouldSkip: () => !driver,
        create: () => new PostgresAdapter({ driver: driver!, schema }),
        cleanup: async () => {
          const { rows } = await driver!.query<{ tablename: string }>(
            `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'searchfn_docs_%'`,
            [schema],
          );
          for (const { tablename } of rows) {
            await driver!.query(`DELETE FROM "${schema}"."${tablename}"`);
          }
        },
      });
    });
  });
}
