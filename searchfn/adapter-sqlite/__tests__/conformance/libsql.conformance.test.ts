import { describe } from "vitest";
import { runConformanceSuite } from "@searchfn/adapter-contracts/testing";
import { SqliteAdapter } from "../../src/index";
import { libsql, type TestDatabase } from "../helpers";

describe("SqliteAdapter conformance (@libsql/client)", () => {
  let database: TestDatabase | undefined;

  runConformanceSuite({
    name: "sqlite-libsql",
    persistent: true,
    create: () => {
      database = libsql();
      return new SqliteAdapter({ driver: database.driver });
    },
    cleanup: async () => {
      database?.close();
      database = undefined;
    },
  });
});
