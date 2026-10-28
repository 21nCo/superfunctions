import { describe } from "vitest";
import { runConformanceSuite } from "@searchfn/adapter-contracts/testing";
import { SqliteAdapter } from "../../src/index";
import { betterSqlite, type TestDatabase } from "../helpers";

describe("SqliteAdapter conformance (better-sqlite3)", () => {
  let database: TestDatabase | undefined;

  runConformanceSuite({
    name: "sqlite-better-sqlite3",
    persistent: true,
    create: () => {
      database = betterSqlite();
      return new SqliteAdapter({ driver: database.driver });
    },
    cleanup: async () => {
      database?.close();
      database = undefined;
    },
  });
});
