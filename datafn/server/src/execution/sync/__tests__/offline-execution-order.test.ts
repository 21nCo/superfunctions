/**
 * DFN-23: unguarded offline writes apply in server execution order.
 * The server does not compare the client's editedAt clocks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createDatafnServer } from "../../../server.js";
import type { DatafnSchema } from "../../../core-types.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "todos",
      version: 1,
      fields: [
        { name: "title", type: "string", required: true },
        { name: "editedAt", type: "number", required: false },
      ],
    },
  ],
  relations: [],
};

describe("offline execution order", () => {
  let server: Awaited<ReturnType<typeof createDatafnServer>>;

  afterEach(async () => {
    await server?.close?.();
  });

  it("stores the later unguarded update and acknowledges both", async () => {
    const db = memoryAdapter();
    await db.initialize?.();
    server = await createDatafnServer({
      schema,
      database: db,
      allowUnknownResources: true,
      namespaceProvider: {
        getNamespace: () => "ns:1",
        getActorId: () => "user:alice" as any,
      },
    });

    const push = async (mutations: unknown[]) => {
      const response = await server.router.handle(
        new Request("http://localhost/datafn/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: "client:1", mutations }),
        }),
      );
      const body = (await response.json()) as {
        ok: boolean;
        result: { errors: unknown[]; applied?: string[] };
      };
      return { response, body };
    };

    const seeded = await push([
      {
        resource: "todos",
        version: 1,
        operation: "insert",
        clientId: "client:1",
        mutationId: "m-seed",
        id: "todo:1",
        record: { title: "seed", editedAt: 0 },
      },
    ]);
    expect(seeded.response.status).toBe(200);
    expect(seeded.body.result.errors).toEqual([]);

    const updated = await push([
      {
        resource: "todos",
        version: 1,
        operation: "merge",
        clientId: "client:1",
        mutationId: "m-later-clock",
        id: "todo:1",
        record: { title: "later-clock", editedAt: 9000 },
      },
      {
        resource: "todos",
        version: 1,
        operation: "merge",
        clientId: "client:1",
        mutationId: "m-earlier-clock",
        id: "todo:1",
        record: { title: "earlier-clock", editedAt: 1 },
      },
    ]);

    expect(updated.response.status).toBe(200);
    expect(updated.body.ok).toBe(true);
    expect(updated.body.result.errors).toEqual([]);
    expect(updated.body.result.applied).toEqual(expect.arrayContaining([
      "m-later-clock",
      "m-earlier-clock",
    ]));

    const row = await db.findOne({
      model: "todos",
      where: [{ field: "id", operator: "eq", value: "todo:1" }],
      namespace: "ns:1",
    });
    expect(row.title).toBe("earlier-clock");
    expect(row.editedAt).toBe(1);
  });
});
