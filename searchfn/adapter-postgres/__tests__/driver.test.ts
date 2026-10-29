/**
 * PostgresAdapter with an injected driver, and the fromPg / fromPostgresJs bindings, against fakes.
 *
 * `pg` is mocked to throw on import: an injected driver must never load it, which is what lets
 * the adapter run on Workers with postgres.js. No database is needed.
 */
import { describe, expect, it, vi } from "vitest";
import { SEARCH_ADAPTER_DISPOSED, SearchAdapterError } from "@searchfn/adapter-contracts";
import {
  PostgresAdapter,
  fromPg,
  fromPostgresJs,
  type PgPoolClientLike,
  type PostgresDriver,
  type PostgresQueryResult,
} from "../src/index";

vi.mock("pg", () => {
  throw new Error("pg must not be imported when a driver is injected");
});

interface Call {
  sql: string;
  params?: readonly unknown[];
  via: "driver" | "tx";
}

/** Records statements; answers search queries with `searchRows` and fails per `failWhen`. */
function fakeDriver(options: {
  transactions?: boolean;
  searchRows?: Array<{ doc_id: string; score: number | string }>;
  failWhen?: (sql: string, attempt: number) => unknown;
} = {}) {
  const calls: Call[] = [];
  let attempts = 0;
  const run = async (via: Call["via"], sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult<any>> => {
    calls.push({ sql, params, via });
    const failure = options.failWhen?.(sql, attempts++);
    if (failure) throw failure;
    return { rows: /SELECT doc_id, score/.test(sql) ? (options.searchRows ?? []) : [] };
  };
  const driver: PostgresDriver = { query: (sql, params) => run("driver", sql, params) };
  const transactions = { begun: 0, committed: 0, rolledBack: 0 };
  if (options.transactions) {
    driver.transaction = async (fn) => {
      transactions.begun++;
      try {
        const result = await fn({ query: (sql, params) => run("tx", sql, params) });
        transactions.committed++;
        return result;
      } catch (error) {
        transactions.rolledBack++;
        throw error;
      }
    };
  }
  return { driver, calls, transactions };
}

const statementKind = (sql: string) => sql.trim().split(/\s+/).slice(0, 2).join(" ");
const fastRetry = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 2 };

describe("PostgresAdapter options", () => {
  it("rejects a driver without a query function", () => {
    expect(() => new PostgresAdapter({ driver: {} as PostgresDriver })).toThrow(/query\(sql, params\)/);
  });

  it("rejects connectionString together with driver", () => {
    const { driver } = fakeDriver();
    const options = { driver, connectionString: "postgres://localhost/db" };
    expect(() => new PostgresAdapter(options as never)).toThrow(/either connectionString or driver/);
  });

  it("rejects queryTimeoutMs with an injected driver, which the adapter cannot apply", () => {
    const { driver } = fakeDriver();
    const error = (() => {
      try {
        new PostgresAdapter({ driver, queryTimeoutMs: 1000 } as never);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(SearchAdapterError);
    expect((error as SearchAdapterError).code).toBe("DFQL_INVALID");
  });
});

describe("PostgresAdapter with an injected driver", () => {
  it("runs every operation through driver.query without loading pg", async () => {
    const { driver, calls } = fakeDriver({ searchRows: [{ doc_id: "42", score: "0.5" }, { doc_id: "a-1", score: 0.25 }] });
    const adapter = new PostgresAdapter({ driver, schema: "search" });

    await adapter.initialize({ resources: [{ name: "notes", searchFields: ["title"] }] });
    expect(calls.map((call) => statementKind(call.sql))).toEqual([
      "CREATE TABLE",
      "CREATE TABLE",
      "CREATE INDEX",
      "INSERT INTO",
    ]);
    expect(calls[0].sql).toContain(`"search".searchfn_meta`);
    expect(calls[3].params).toEqual(["notes", '{"title"}']);

    expect(await adapter.search({ resource: "notes", query: "hello" })).toEqual([42, "a-1"]);
    expect(await adapter.searchAll({ query: "hello" })).toEqual([
      { resource: "notes", id: 42, score: 0.5 },
      { resource: "notes", id: "a-1", score: 0.25 },
    ]);

    calls.length = 0;
    await adapter.remove({ resource: "notes", ids: [1, "b"] });
    await adapter.clear("notes");
    expect(calls.map((call) => [statementKind(call.sql), call.params])).toEqual([
      ["DELETE FROM", ["1", "b"]],
      ["DELETE FROM", []],
    ]);
  });

  it("indexes inside driver.transaction: delete and insert run on the transaction, not the driver", async () => {
    const { driver, calls, transactions } = fakeDriver({ transactions: true });
    const adapter = new PostgresAdapter({ driver });
    await adapter.index({ resource: "notes", documents: [{ id: 1, fields: { title: "a", body: "b" } }] });

    expect(transactions).toEqual({ begun: 1, committed: 1, rolledBack: 0 });
    expect(calls.map((call) => [call.via, statementKind(call.sql)])).toEqual([
      ["tx", "DELETE FROM"],
      ["tx", "INSERT INTO"],
    ]);
    expect(calls[1].params).toEqual(["1", "title", "a", "1", "body", "b"]);
  });

  it("rolls the whole batch back and retries it when a statement inside the transaction fails transiently", async () => {
    const { driver, calls, transactions } = fakeDriver({
      transactions: true,
      failWhen: (sql, attempt) => (attempt === 1 && sql.includes("INSERT") ? Object.assign(new Error("closed"), { code: "CONNECTION_CLOSED" }) : undefined),
    });
    const adapter = new PostgresAdapter({ driver, retry: fastRetry });
    await adapter.index({ resource: "notes", documents: [{ id: "x", fields: { title: "a" } }] });

    expect(transactions).toEqual({ begun: 2, committed: 1, rolledBack: 1 });
    expect(calls.map((call) => statementKind(call.sql))).toEqual(["DELETE FROM", "INSERT INTO", "DELETE FROM", "INSERT INTO"]);
  });

  it("runs index statements one by one on a driver without transaction()", async () => {
    const { driver, calls } = fakeDriver();
    const adapter = new PostgresAdapter({ driver });
    await adapter.index({ resource: "notes", documents: [{ id: "x", fields: { title: "a" } }] });

    expect(calls.map((call) => [call.via, statementKind(call.sql)])).toEqual([
      ["driver", "DELETE FROM"],
      ["driver", "INSERT INTO"],
    ]);
  });

  it("retries postgres.js connection errors and SQLSTATE transients, but not other errors", async () => {
    const transient = (code: string) => fakeDriver({
      searchRows: [{ doc_id: "1", score: 1 }],
      failWhen: (_sql, attempt) => (attempt === 0 ? Object.assign(new Error(code), { code }) : undefined),
    });
    for (const code of ["CONNECTION_CLOSED", "CONNECT_TIMEOUT", "ECONNREFUSED", "ETIMEDOUT", "08006", "40001"]) {
      const { driver, calls } = transient(code);
      const adapter = new PostgresAdapter({ driver, retry: fastRetry });
      expect(await adapter.search({ resource: "notes", query: "q" }), code).toEqual([1]);
      expect(calls, code).toHaveLength(2);
    }

    const down = fakeDriver({
      failWhen: () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
    });
    const exhausted = new PostgresAdapter({ driver: down.driver, retry: fastRetry });
    await expect(exhausted.search({ resource: "notes", query: "q" })).rejects.toMatchObject({
      code: "INTERNAL",
      message: "Postgres operation failed: connect ECONNREFUSED 127.0.0.1:5432",
    });
    expect(down.calls).toHaveLength(3);

    for (const code of ["CONNECTION_ENDED", "42601"]) {
      const { driver, calls } = fakeDriver({
        failWhen: () => Object.assign(new Error(`terminal ${code}`), { code }),
      });
      const adapter = new PostgresAdapter({ driver, retry: fastRetry });
      await expect(adapter.search({ resource: "notes", query: "q" }), code).rejects.toThrow(`terminal ${code}`);
      expect(calls, code).toHaveLength(1);
    }
  });

  it("treats a missing resource table (42P01) as empty for search and as a no-op for remove and clear", async () => {
    const { driver } = fakeDriver({
      failWhen: () => Object.assign(new Error('relation "searchfn_docs_x" does not exist'), { code: "42P01" }),
    });
    const adapter = new PostgresAdapter({ driver });
    expect(await adapter.search({ resource: "x", query: "q" })).toEqual([]);
    await expect(adapter.remove({ resource: "x", ids: ["1"] })).resolves.toBeUndefined();
    await expect(adapter.clear("x")).resolves.toBeUndefined();
  });

  it("does not close the caller's driver on dispose, and works again after initialize", async () => {
    const end = vi.fn();
    const sql = Object.assign(
      async () => [],
      {
        end,
        unsafe: vi.fn(async (text: string) => (/SELECT doc_id, score/.test(text) ? [{ doc_id: "7", score: 1 }] : [])),
        begin: vi.fn(),
      },
    );
    const adapter = new PostgresAdapter({ driver: fromPostgresJs(sql) });
    await adapter.initialize({ resources: [{ name: "notes", searchFields: ["title"] }] });
    await adapter.dispose();

    await expect(adapter.search({ resource: "notes", query: "q" })).rejects.toMatchObject({ code: SEARCH_ADAPTER_DISPOSED });
    expect(end).not.toHaveBeenCalled();

    await adapter.initialize({ resources: [{ name: "notes", searchFields: ["title"] }] });
    expect(await adapter.search({ resource: "notes", query: "q" })).toEqual([7]);
  });
});

describe("fromPg", () => {
  function fakePool(failOn?: { sql: string; error: Error }[]) {
    const log: string[] = [];
    const released: Array<Error | boolean | undefined> = [];
    const query = async (text: string, values?: unknown[]) => {
      log.push(values === undefined ? text : `${text} ${JSON.stringify(values)}`);
      const failure = failOn?.find((entry) => entry.sql === text);
      if (failure) throw failure.error;
      return { rows: [{ text }] };
    };
    const client: PgPoolClientLike = { query, release: (err) => void released.push(err) };
    return { pool: { query, connect: async () => client }, log, released };
  }

  it("passes parameters through and calls query(text) without values when there are none", async () => {
    const { pool, log } = fakePool();
    const driver = fromPg(pool);
    expect(await driver.query("SELECT $1", ["a"])).toEqual({ rows: [{ text: "SELECT $1" }] });
    await driver.query("SELECT 1");
    expect(log).toEqual(['SELECT $1 ["a"]', "SELECT 1"]);
  });

  it("commits on success and releases the client", async () => {
    const { pool, log, released } = fakePool();
    const result = await fromPg(pool).transaction!(async (tx) => (await tx.query("UPDATE t", [1])).rows.length);
    expect(result).toBe(1);
    expect(log).toEqual(["BEGIN", "UPDATE t [1]", "COMMIT"]);
    expect(released).toEqual([undefined]);
  });

  it("rolls back on failure, rethrows the statement error and returns the client to the pool", async () => {
    const statementError = new Error("duplicate key");
    const { pool, log, released } = fakePool([{ sql: "INSERT", error: statementError }]);
    await expect(fromPg(pool).transaction!((tx) => tx.query("INSERT"))).rejects.toBe(statementError);
    expect(log).toEqual(["BEGIN", "INSERT", "ROLLBACK"]);
    expect(released).toEqual([undefined]);
  });

  it("keeps the statement error and discards the client when ROLLBACK also fails", async () => {
    const statementError = new Error("statement failed");
    const rollbackError = new Error("connection lost");
    const { pool, released } = fakePool([
      { sql: "INSERT", error: statementError },
      { sql: "ROLLBACK", error: rollbackError },
    ]);
    await expect(fromPg(pool).transaction!((tx) => tx.query("INSERT"))).rejects.toBe(statementError);
    expect(released).toEqual([rollbackError]);
  });
});

describe("fromPostgresJs", () => {
  it("runs prepared statements through sql.unsafe and transactions through sql.begin", async () => {
    type Options = { prepare?: boolean };
    const unsafe = vi.fn(async (_text: string, _params?: unknown[], _options?: Options) => Object.assign([{ n: 1 }], { count: 1, command: "SELECT" }));
    const txUnsafe = vi.fn(async (_text: string, _params?: unknown[], _options?: Options) => [{ n: 2 }]);
    const begin = vi.fn(async (fn: (tx: { unsafe: typeof txUnsafe }) => Promise<unknown>) => fn({ unsafe: txUnsafe }));
    const driver = fromPostgresJs({ unsafe, begin });

    const params = ["a", ["b", "c"]] as const;
    const result = await driver.query("SELECT $1, $2", params);
    expect(result).toEqual({ rows: [{ n: 1 }] });
    expect(Array.isArray(result.rows) && !("count" in result.rows)).toBe(true);
    expect(unsafe).toHaveBeenCalledWith("SELECT $1, $2", ["a", ["b", "c"]], { prepare: true });
    expect(unsafe.mock.calls[0][1]).not.toBe(params);

    await driver.query("SELECT 1");
    expect(unsafe).toHaveBeenLastCalledWith("SELECT 1", undefined, { prepare: true });

    expect(await driver.transaction!(async (tx) => (await tx.query("SELECT 2", [])).rows)).toEqual([{ n: 2 }]);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(txUnsafe).toHaveBeenCalledWith("SELECT 2", [], { prepare: true });
  });
});
