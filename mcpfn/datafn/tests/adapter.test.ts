import { afterEach, describe, expect, it } from "vitest";
import { createDatafnServer } from "@datafn/server";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createMcpFnServer } from "@mcpfn/core";
import { McpFnTestClient } from "@mcpfn/testing";

import { createDatafnMcpRegistry } from "../src/index.js";

describe("DataFn McpFn adapter", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close().catch(() => undefined)));
  });

  it("exposes bounded reads and opt-in idempotent writes over MCP", async () => {
    const schema = {
      resources: [{
        name: "tasks",
        version: 1,
        fields: [
          { name: "title", type: "string" as const, required: true },
          { name: "secret", type: "string" as const, required: false },
        ],
        permissions: {
          read: { fields: ["title"] },
          write: { fields: ["title"] },
        },
      }],
    };
    const datafn = await createDatafnServer({ schema, db: memoryAdapter() });
    closeables.push(datafn);
    const registry = createDatafnMcpRegistry({
      schema,
      executor: datafn.executor,
      context: () => undefined,
      clientId: "mcpfn-test",
      expose: {
        tasks: {
          fields: ["id", "title"],
          list: { filterFields: ["title"], sortFields: ["id"], maxLimit: 10 },
          get: true,
          create: { fields: ["title"] },
        },
      },
    });
    const server = createMcpFnServer({
      info: { name: "datafn-test", version: "1.0.0" },
      registry,
    });
    const client = await McpFnTestClient.connect(server);
    closeables.push(client);

    expect((await client.listTools()).map((tool) => tool.name)).toEqual([
      "datafn_tasks_create",
      "datafn_tasks_get",
      "datafn_tasks_list",
    ]);
    const created = await client.callTool("datafn_tasks_create", {
      id: "task-1",
      mutationId: "create-1",
      record: { title: "First" },
    });
    expect(created.isError).not.toBe(true);
    const listed = await client.callTool("datafn_tasks_list", { limit: 10 });
    expect(listed.structuredContent).toMatchObject({
      resource: "tasks",
      operation: "list",
      result: { data: [expect.objectContaining({ id: "task-1", title: "First" })] },
    });
    expect(JSON.stringify(listed.structuredContent)).not.toContain("secret");
  });

  it("rejects exposure of fields outside DataFn policy", async () => {
    const schema = {
      resources: [{
        name: "tasks",
        version: 1,
        fields: [{ name: "secret", type: "string" as const, required: false }],
        permissions: { read: { fields: [] }, write: { fields: [] } },
      }],
    };
    const datafn = await createDatafnServer({ schema, db: memoryAdapter() });
    closeables.push(datafn);
    expect(() => createDatafnMcpRegistry({
      schema,
      executor: datafn.executor,
      context: () => undefined,
      clientId: "test",
      expose: { tasks: { fields: ["secret"] } },
    })).toThrow(/not readable/);
  });

  it("rejects ambiguous write allowlists and invalid list bounds", async () => {
    const schema = {
      resources: [{
        name: "tasks",
        version: 1,
        fields: [{ name: "title", type: "string" as const, required: true }],
        permissions: { read: { fields: ["title"] }, write: { fields: ["title"] } },
      }],
    };
    const datafn = await createDatafnServer({ schema, db: memoryAdapter() });
    closeables.push(datafn);
    const common = {
      schema,
      executor: datafn.executor,
      context: () => undefined,
      clientId: "test",
    };

    expect(() => createDatafnMcpRegistry({
      ...common,
      expose: { tasks: { fields: ["id", "title"], create: { fields: [] } } },
    })).toThrow(/non-empty, unique field list/);
    expect(() => createDatafnMcpRegistry({
      ...common,
      expose: {
        tasks: {
          fields: ["id", "title"],
          list: { maxLimit: 10, defaultLimit: 11 },
        },
      },
    })).toThrow(/defaultLimit cannot exceed maxLimit/);
  });
});
