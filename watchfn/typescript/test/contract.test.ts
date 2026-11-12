import { createMemoryStorage } from "../src/index.js";
import { createSqliteStorage } from "../src/sqlite.js";
import { sqliteFile } from "./helpers.js";
import { describeStorageContract } from "./storage-contract.js";

describeStorageContract("memory-fixture", () => ({ storage: createMemoryStorage(), cleanup() {} }));

describeStorageContract("durable-sqlite", () => {
  const db = sqliteFile();
  return {
    storage: createSqliteStorage({ adapter: db.connect().adapter }),
    reopen: () => createSqliteStorage({ adapter: db.connect().adapter }),
    cleanup: () => db.cleanup(),
  };
});
