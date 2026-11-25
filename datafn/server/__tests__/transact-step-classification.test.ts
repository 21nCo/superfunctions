/**
 * DFN-11: bare and wrapped transact steps share one classification.
 * A rejected step is a route error and must not reach the adapter.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../src/server.js";
import type { DatafnSchema } from "../src/core-types.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "txn",
      version: 1,
      fields: [{ name: "amount", type: "number", required: false }],
    },
  ],
  relations: [],
};

describe("transact step classification", () => {
  let server: { close: () => Promise<void> | void; router: { handle: (req: Request, ctx?: unknown) => Promise<Response> } };
  let adapter: ReturnType<typeof memoryAdapter>;

  afterEach(async () => {
    await server?.close?.();
  });

  async function post(steps: unknown[], atomic = true, supportsTransactions = true) {
    adapter = memoryAdapter();
    await adapter.initialize?.();
    if (!supportsTransactions) {
      adapter.capabilities = { ...adapter.capabilities, transactions: { supported: false } };
      await adapter.create({
        model: "txn",
        data: { id: "txn-seeded", amount: 1 },
        namespace: "datafn",
      });
    }
    const create = vi.spyOn(adapter, "create");
    server = await createDatafnServer({
      allowUnknownResources: true,
      debug: true,
      schema,
      database: adapter,
    });
    const response = await server.router.handle(
      new Request("http://localhost/datafn/transact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ atomic, steps }),
      }),
      {},
    );
    const body = await response.json();
    return { response, body, create };
  }

  it("rejects a bare mutation with a non-string id before any write", async () => {
    const { response, body, create } = await post([
      { resource: "txn", operation: "insert", id: 42, record: { amount: 1 } },
      { resource: "txn", operation: "insert", id: "txn-later", record: { amount: 2 } },
    ]);

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
    expect(body.error.message).toBe("Invalid DFQL: id must be string");
    expect(body.error.details.path).toBe("steps[0].id");
    expect(create).not.toHaveBeenCalled();
    await expect(adapter.findOne({
      model: "txn",
      where: [{ field: "id", operator: "eq", value: "txn-later" }],
      namespace: "datafn",
    })).resolves.toBeNull();
  });

  it("rejects the same mutation when it is wrapped, with the wrapped path", async () => {
    const record = { amount: 1 };
    const { response, body, create } = await post([
      { mutation: { resource: "txn", operation: "insert", id: 42, record } },
      { mutation: { resource: "txn", operation: "insert", id: "txn-later", record: { amount: 2 } } },
    ]);

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
    expect(body.error.message).toBe("Invalid DFQL: id must be string");
    expect(body.error.details.path).toBe("steps[0].mutation.id");
    expect(create).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves query validation errors with atomic: %s", async (atomic) => {
    const { response, body } = await post([
      { resource: "txn", operation: "insert", id: "txn-1", record: { amount: 1 } },
      { resource: "txn", filters: { amount: { between: [1] } } },
    ], atomic);

    expect(response.status).toBe(200);
    expect(body.result.results[1].error).toMatchObject({ code: "DFQL_INVALID" });
    expect(body.result.results[0].rolledBack ?? false).toBe(atomic);
  });

  it("returns the same step error for a read-only atomic request without transactions", async () => {
    const { response, body } = await post([
      { resource: "txn", filters: { amount: { between: [1] } } },
    ], true, false);

    expect(response.status).toBe(200);
    expect(body.result.results[0].error).toMatchObject({ code: "DFQL_INVALID" });
  });
});
