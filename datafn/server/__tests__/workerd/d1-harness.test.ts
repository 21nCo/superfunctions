/// <reference types="@cloudflare/vitest-pool-workers" />
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { allTables, createTableStatements } from "../drizzle-sqlite/fixture.js";
import { createD1Harness, USER_TABLES_SQL } from "./d1-harness.js";

const userTables = async () => (await env.DB.prepare(USER_TABLES_SQL).all<{ name: string }>()).results.map((row) => row.name);

describe("D1 harness after a test whose isolated-storage pop did not happen", () => {
  beforeAll(async () => {
    // Writes in beforeAll land in the suite's storage frame, so the test below
    // starts with these tables and rows, as it would if the previous test's pop had failed.
    await env.DB.batch(
      [
        ...createTableStatements(allTables),
        `INSERT INTO "__datafn_changes" ("id", "namespace", "server_seq") VALUES ('change:leftover', 'default', 1)`,
        `INSERT INTO "task" ("__ns", "id", "done", "priority", "title") VALUES ('default', 'task:leftover', 0, 1, 'Leftover')`,
      ].map((statement) => env.DB.prepare(statement)),
    );
  });

  it("starts the next test from an empty database that migrates again", async () => {
    expect(await userTables()).toContain("__datafn_changes");

    const harness = await createD1Harness(env.DB);
    expect(await userTables()).toEqual([]);

    // Without the reset this fails with D1_ERROR: table "__datafn_changes" already exists.
    await harness.exec(createTableStatements(allTables));
    expect(await harness.all(`SELECT count(*) AS n FROM "__datafn_changes"`)).toEqual([{ n: 0 }]);
    expect(await harness.all(`SELECT count(*) AS n FROM "task"`)).toEqual([{ n: 0 }]);
  });
});
