/**
 * DFN-18: unexpected adapter failures stay in logs.
 * The client sees a generic message, including when debug is on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../src/server.js";
import { DbDataStore } from "../src/execution/db-store.js";
import type { DatafnSchema } from "../src/core-types.js";

const INSERT_PHRASE = "driver-test-failure-insert";
const RELATE_PHRASE = "driver-test-failure-relate";
const TXN_PHRASE = "driver-test-failure-txn";

const schema: DatafnSchema = {
  resources: [
    {
      name: "users",
      version: 1,
      fields: [{ name: "name", type: "string", required: true }],
    },
    {
      name: "employers",
      version: 1,
      idPrefix: "emp",
      fields: [{ name: "name", type: "string", required: true }],
    },
    {
      name: "people",
      version: 1,
      idPrefix: "per",
      fields: [
        { name: "name", type: "string", required: true },
        { name: "employerId", type: "string", required: false },
      ],
    },
  ],
  relations: [
    {
      from: "people",
      relation: "employer",
      to: "employers",
      type: "many-one",
      fkField: "employerId",
    },
  ],
};

describe("driver error redaction", () => {
  const servers: Array<{ close: () => Promise<void> | void }> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (servers.length > 0) {
      await servers.pop()?.close?.();
    }
  });

  async function start(database: ReturnType<typeof memoryAdapter>, debug?: boolean) {
    const server = await createDatafnServer({
      allowUnknownResources: true,
      schema,
      database,
      ...(debug ? { debug: true } : {}),
    });
    servers.push(server);
    return server;
  }

  async function mutate(server: Awaited<ReturnType<typeof start>>, body: unknown) {
    const response = await server.router.handle(
      new Request("http://localhost/datafn/mutation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      {},
    );
    const raw = await response.text();
    return { response, raw, body: JSON.parse(raw) };
  }

  it("omits insert driver text from the response and keeps it in the log", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const server = await start(db);
    const original = db.create.bind(db);
    db.create = async (input) => {
      if (input?.model === "users") throw new Error(INSERT_PHRASE);
      return original(input);
    };
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    const { response, raw, body } = await mutate(server, {
      resource: "users",
      version: 1,
      operation: "insert",
      id: "user-1",
      clientId: "c1",
      mutationId: "m-insert",
      record: { name: "Ada" },
    });

    expect(response.status).toBe(200);
    expect(raw).not.toContain(INSERT_PHRASE);
    expect(body.result.ok).toBe(false);
    expect(body.result.errors[0].message).toBe("Internal error");
    expect(logged.join("\n")).toContain(INSERT_PHRASE);
  });

  it("omits relate driver text and leaves the row unchanged", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    await db.create({
      model: "employers",
      data: { id: "emp_1", name: "Acme" },
      namespace: "datafn",
    });
    await db.create({
      model: "people",
      data: { id: "per_1", name: "Ada" },
      namespace: "datafn",
    });
    const server = await start(db);
    const original = db.findMany.bind(db);
    db.findMany = async (input) => {
      if (input?.model === "employers") throw new Error(RELATE_PHRASE);
      return original(input);
    };

    const { response, raw, body } = await mutate(server, {
      resource: "people",
      version: 1,
      operation: "relate",
      id: "per_1",
      clientId: "c1",
      mutationId: "m-relate",
      relations: { employer: { $ref: "emp_1" } },
    });

    expect(response.status).toBe(200);
    expect(raw).not.toContain(RELATE_PHRASE);
    expect(body.result.errors[0].message).toBe("Internal error");
    const person = await db.findOne({
      model: "people",
      where: [{ field: "id", operator: "eq", value: "per_1" }],
      namespace: "datafn",
    });
    expect(person?.employerId).toBeUndefined();
  });

  it("omits transaction driver text when the transaction throws", async () => {
    const db = memoryAdapter() as ReturnType<typeof memoryAdapter> & {
      capabilities: { transactions: { supported?: boolean } };
      transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    };
    await db.initialize?.();
    const server = await start(db);
    db.capabilities = {
      ...db.capabilities,
      transactions: { ...db.capabilities.transactions, supported: true },
    };
    db.transaction = async () => {
      throw new Error(TXN_PHRASE);
    };

    const { response, raw, body } = await mutate(server, {
      resource: "users",
      version: 1,
      operation: "insert",
      id: "user-txn",
      clientId: "c1",
      mutationId: "m-txn",
      record: { name: "Ada" },
    });

    expect(response.status).toBe(200);
    expect(raw).not.toContain(TXN_PHRASE);
    expect(body.result.errors[0].message).toBe("Transaction failed");
  });

  it.each([true, false])("redacts driver failures from transact with atomic: %s", async (atomic) => {
    const db = memoryAdapter();
    await db.initialize?.();
    const server = await start(db, true);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    if (atomic) {
      vi.spyOn(db, "transaction").mockRejectedValueOnce(new Error(TXN_PHRASE));
    } else {
      vi.spyOn(DbDataStore, "forQuery").mockRejectedValueOnce(new Error(TXN_PHRASE));
    }

    const response = await server.router.handle(new Request("http://localhost/datafn/transact", {
      method: "POST",
      body: JSON.stringify({ atomic, steps: [{ query: { resource: "users", version: 1 } }] }),
    }), {});
    const body = await response.json();
    const error = atomic ? body.error : body.result.results[0].error;
    expect(error).toMatchObject({
      code: "INTERNAL",
      message: atomic ? "Transaction failed" : "Internal error",
    });
    expect(JSON.stringify(body)).not.toContain(TXN_PHRASE);
    expect(JSON.stringify(logged.mock.calls)).toContain(TXN_PHRASE);
  });

  it("keeps driver text out of the response when debug is enabled", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    const server = await start(db, true);
    const original = db.create.bind(db);
    db.create = async (input) => {
      if (input?.model === "users") throw new Error(INSERT_PHRASE);
      return original(input);
    };

    const { raw, body } = await mutate(server, {
      resource: "users",
      version: 1,
      operation: "insert",
      id: "user-debug",
      clientId: "c1",
      mutationId: "m-debug",
      record: { name: "Ada" },
    });

    expect(raw).not.toContain(INSERT_PHRASE);
    expect(body.result.errors[0].message).toBe("Internal error");
  });

  it("returns a generic validation message unless debug is on", async () => {
    const hidden = memoryAdapter();
    await hidden.initialize?.();
    const hiddenServer = await start(hidden);
    const hiddenRes = await hiddenServer.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "users", version: 1, filters: { unknown_field: "x" } }),
      }),
      {},
    );
    const hiddenBody = await hiddenRes.json();
    expect(hiddenRes.status).toBe(400);
    expect(hiddenBody.error.message).toBe("Validation error");

    const shown = memoryAdapter();
    await shown.initialize?.();
    const shownServer = await start(shown, true);
    const shownRes = await shownServer.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource: "users", version: 1, filters: { unknown_field: "x" } }),
      }),
      {},
    );
    const shownBody = await shownRes.json();
    expect(shownBody.error.message).toBe("Unknown field: filters.unknown_field");
  });
});
