import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatafnServer } from "@datafn/server";
import { memoryAdapter } from "@superfunctions/db/adapters";
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
  type McpFnToolVisibilityInput,
} from "@mcpfn/core";
import { McpFnTestClient } from "@mcpfn/testing";

import {
  DATAFN_INSUFFICIENT_SCOPE,
  createDatafnMcpAdapter,
  createDatafnMcpRegistry,
  type CreateDatafnMcpRegistryOptions,
  type DatafnMcpAdapter,
} from "../src/index.js";

interface Session {
  scopes?: unknown;
}

const schema = {
  resources: [{
    name: "notes",
    version: 1,
    fields: [{ name: "title", type: "string" as const, required: true }],
    permissions: { read: { fields: ["title"] }, write: { fields: ["title"] } },
  }],
};

const ALL_NOTE_TOOLS = [
  "datafn_notes_create",
  "datafn_notes_get",
  "datafn_notes_list",
  "datafn_notes_update",
];

/** The tool error a gated tool answers with (as JSON text: these tools declare an output schema). */
function errorOf(result: { isError?: boolean; content?: unknown }): unknown {
  expect(result.isError).toBe(true);
  const [first] = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(first!.text);
}

function insufficientScope(requiredScopes: string[], missingScopes: string[]) {
  return {
    ok: false,
    error: {
      code: "insufficient_scope",
      message: expect.stringContaining(missingScopes.join(", ")),
      details: { requiredScopes, missingScopes },
    },
  };
}

describe("scope-aware DataFn tools", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close().catch(() => undefined)));
  });

  async function setup(
    overrides: Partial<CreateDatafnMcpRegistryOptions<Session, undefined>> = {},
  ) {
    const datafn = await createDatafnServer({ schema, db: memoryAdapter() });
    closeables.push(datafn);
    const query = vi.spyOn(datafn.executor, "query");
    const mutate = vi.spyOn(datafn.executor, "mutate");
    const sessionScopes = vi.fn((session: Session) => session.scopes as string[]);
    const adapter = createDatafnMcpAdapter<Session, undefined>({
      executor: datafn.executor,
      context: () => undefined,
      clientId: () => "mcpfn-scope-test",
      sessionScopes,
      expose: {
        notes: {
          fields: ["id", "title"],
          scopes: { read: ["memotron:read"], write: ["memotron:write"] },
          create: { fields: ["title"] },
          update: { fields: ["title"] },
        },
      },
      ...overrides,
    });
    return { adapter, query, mutate, sessionScopes };
  }

  async function connect(
    adapter: DatafnMcpAdapter<Session>,
    scopes: unknown,
    toolVisibility: ((input: McpFnToolVisibilityInput<Session>) => boolean | Promise<boolean>) | null =
      adapter.toolVisibility,
  ) {
    const server = createMcpFnServer<Session>({
      info: { name: "datafn-scope-test", version: "1.0.0" },
      registry: adapter.registry,
      context: () => ({ scopes }),
      ...(toolVisibility ? { toolVisibility } : {}),
    });
    const client = await McpFnTestClient.connect(server);
    closeables.push(client);
    return client;
  }

  async function toolNames(client: McpFnTestClient<Session>) {
    return (await client.listTools()).map((tool) => tool.name).sort();
  }

  it("lists and runs list, get, create and update for a session holding read and write", async () => {
    const { adapter, query, mutate } = await setup();
    const client = await connect(adapter, ["memotron:read", "memotron:write"]);

    expect(await toolNames(client)).toEqual(ALL_NOTE_TOOLS);
    const created = await client.callTool("datafn_notes_create", {
      id: "note-1",
      mutationId: "create-1",
      record: { title: "First" },
    });
    expect(created.isError).not.toBe(true);
    const updated = await client.callTool("datafn_notes_update", {
      id: "note-1",
      mutationId: "update-1",
      record: { title: "Renamed" },
    });
    expect(updated.isError).not.toBe(true);
    const fetched = await client.callTool("datafn_notes_get", { id: "note-1" });
    expect(fetched.structuredContent).toMatchObject({
      result: { data: [expect.objectContaining({ id: "note-1", title: "Renamed" })] },
    });
    const listed = await client.callTool("datafn_notes_list", { limit: 10 });
    expect(listed.structuredContent).toMatchObject({
      result: { data: [expect.objectContaining({ id: "note-1", title: "Renamed" })] },
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(mutate).toHaveBeenCalledTimes(2);
  });

  it("hides write tools from a read-only session and refuses direct calls before DataFn runs", async () => {
    const { adapter, mutate } = await setup();
    const client = await connect(adapter, ["memotron:read"]);

    expect(await toolNames(client)).toEqual(["datafn_notes_get", "datafn_notes_list"]);
    expect(errorOf(await client.callTool("datafn_notes_create", {
      id: "note-1",
      mutationId: "create-1",
      record: { title: "First" },
    }))).toMatchObject(insufficientScope(["memotron:write"], ["memotron:write"]));
    expect(errorOf(await client.callTool("datafn_notes_update", {
      id: "note-1",
      mutationId: "update-1",
      record: { title: "Renamed" },
    }))).toMatchObject(insufficientScope(["memotron:write"], ["memotron:write"]));
    expect(mutate).not.toHaveBeenCalled();
    const listed = await client.callTool("datafn_notes_list", {});
    expect(listed.isError).not.toBe(true);
  });

  it("hides every gated tool from an unscoped session and refuses list, get, create and update", async () => {
    const { adapter, query, mutate } = await setup();
    const client = await connect(adapter, []);

    expect(await toolNames(client)).toEqual([]);
    expect(errorOf(await client.callTool("datafn_notes_list", {})))
      .toMatchObject(insufficientScope(["memotron:read"], ["memotron:read"]));
    expect(errorOf(await client.callTool("datafn_notes_get", { id: "note-1" })))
      .toMatchObject(insufficientScope(["memotron:read"], ["memotron:read"]));
    expect(errorOf(await client.callTool("datafn_notes_create", {
      id: "note-1",
      mutationId: "create-1",
      record: { title: "First" },
    }))).toMatchObject(insufficientScope(["memotron:write"], ["memotron:write"]));
    expect(errorOf(await client.callTool("datafn_notes_update", {
      id: "note-1",
      mutationId: "update-1",
      record: { title: "Renamed" },
    }))).toMatchObject(insufficientScope(["memotron:write"], ["memotron:write"]));
    expect(query).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("answers insufficient_scope before reporting invalid arguments", async () => {
    const { adapter } = await setup();
    const invalid = { id: "note-1", mutationId: "update-1", record: { title: 7 } };

    expect(errorOf(await (await connect(adapter, ["memotron:read"]))
      .callTool("datafn_notes_update", invalid)))
      .toMatchObject(insufficientScope(["memotron:write"], ["memotron:write"]));
    expect(errorOf(await (await connect(adapter, ["memotron:write"]))
      .callTool("datafn_notes_update", invalid)))
      .toMatchObject({ error: { code: "MCPFN_INVALID_ARGUMENTS", details: { issues: expect.any(Array) } } });
  });

  it("keeps a host tool's own invalid-arguments handler behind the scope check", async () => {
    const { adapter } = await setup();
    adapter.registerTool({
      name: "memotron_tag",
      description: "Tag a note.",
      inputSchema: { type: "object", properties: { tag: { type: "string" } }, required: ["tag"] },
      handler: async () => structuredResult({ tagged: true }),
      handleInvalidArguments: async () => structuredResult({ hint: "pass a tag" }),
    }, { scopes: ["memotron:write"] });

    expect(errorOf(await (await connect(adapter, [])).callTool("memotron_tag", {})))
      .toMatchObject(insufficientScope(["memotron:write"], ["memotron:write"]));
    expect((await (await connect(adapter, ["memotron:write"])).callTool("memotron_tag", {}))
      .structuredContent).toEqual({ hint: "pass a tag" });
  });

  it("keeps the unknown-tool error for names the server does not register", async () => {
    const { adapter } = await setup();
    const client = await connect(adapter, []);

    await expect(client.callTool("datafn_notes_delete", { id: "note-1", mutationId: "m" }))
      .rejects.toThrow(/Tool datafn_notes_delete not found/);
  });

  it("grants a needed scope through <owner>:* and *, but not through another owner", async () => {
    const { adapter } = await setup();

    expect(await toolNames(await connect(adapter, ["memotron:*"]))).toEqual(ALL_NOTE_TOOLS);
    expect(await toolNames(await connect(adapter, ["*"]))).toEqual(ALL_NOTE_TOOLS);
    const other = await connect(adapter, ["pointron:*", "memotron"]);
    expect(await toolNames(other)).toEqual([]);
    expect(errorOf(await other.callTool("datafn_notes_list", {})))
      .toMatchObject(insufficientScope(["memotron:read"], ["memotron:read"]));
  });

  it("requires every declared scope and reports only the missing ones", async () => {
    const { adapter } = await setup({
      expose: {
        notes: {
          fields: ["id", "title"],
          scopes: { read: ["memotron:read", "nucleum:read"] },
        },
      },
    });
    const client = await connect(adapter, ["memotron:read"]);

    expect(await toolNames(client)).toEqual([]);
    expect(errorOf(await client.callTool("datafn_notes_list", {}))).toMatchObject(
      insufficientScope(["memotron:read", "nucleum:read"], ["nucleum:read"]),
    );
  });

  it("grants nothing when the host resolves something other than a scope list", async () => {
    const { adapter, query } = await setup();
    const client = await connect(adapter, "memotron:read");

    expect(await toolNames(client)).toEqual([]);
    expect(errorOf(await client.callTool("datafn_notes_list", {})))
      .toMatchObject(insufficientScope(["memotron:read"], ["memotron:read"]));
    expect(query).not.toHaveBeenCalled();
  });

  it("resolves the session scopes once per tools/list request", async () => {
    const { adapter, sessionScopes } = await setup();
    const client = await connect(adapter, ["memotron:read"]);

    await client.listTools();
    expect(sessionScopes).toHaveBeenCalledTimes(1);
  });

  it("still refuses out-of-scope calls when the host serves the registry without the hook", async () => {
    const { adapter, mutate } = await setup();
    const client = await connect(adapter, ["memotron:read"], null);

    expect(await toolNames(client)).toEqual(ALL_NOTE_TOOLS);
    expect(errorOf(await client.callTool("datafn_notes_create", {
      id: "note-1",
      mutationId: "create-1",
      record: { title: "First" },
    }))).toMatchObject(insufficientScope(["memotron:write"], ["memotron:write"]));
    expect(mutate).not.toHaveBeenCalled();
  });

  it("serves host domain tools beside the generated ones, gated or not", async () => {
    const hostRegistry = new McpFnRegistry<Session>().register({
      name: "host_status",
      description: "A host tool registered before the adapter.",
      inputSchema: { type: "object" },
      handler: async () => structuredResult({ ok: true }),
    });
    const { adapter } = await setup({ registry: hostRegistry });
    const summarize = vi.fn(async () => structuredResult({ summary: "two notes" }));
    adapter
      .registerTool({
        name: "memotron_summarize",
        description: "A scope-gated domain tool.",
        inputSchema: { type: "object" },
        handler: summarize,
      }, { scopes: ["memotron:read"] })
      .registerTool({
        name: "memotron_ping",
        description: "An ungated domain tool.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ pong: true }),
      });
    expect(adapter.registry).toBe(hostRegistry);
    expect(adapter.requiredScopes("memotron_summarize")).toEqual(["memotron:read"]);
    expect(adapter.requiredScopes("memotron_ping")).toBeUndefined();
    expect(adapter.requiredScopes("datafn_notes_update")).toEqual(["memotron:write"]);

    const unscoped = await connect(adapter, []);
    expect(await toolNames(unscoped)).toEqual(["host_status", "memotron_ping"]);
    expect(errorOf(await unscoped.callTool("memotron_summarize", {})))
      .toMatchObject(insufficientScope(["memotron:read"], ["memotron:read"]));
    expect(summarize).not.toHaveBeenCalled();
    expect((await unscoped.callTool("host_status", {})).isError).not.toBe(true);

    const reader = await connect(adapter, ["memotron:read"]);
    expect(await toolNames(reader)).toEqual([
      "datafn_notes_get",
      "datafn_notes_list",
      "host_status",
      "memotron_ping",
      "memotron_summarize",
    ]);
    expect((await reader.callTool("memotron_summarize", {})).structuredContent)
      .toEqual({ summary: "two notes" });
  });

  it("composes with a host visibility hook", async () => {
    const { adapter } = await setup();
    const client = await connect(adapter, ["memotron:read", "memotron:write"], async (input) =>
      (await adapter.toolVisibility(input)) && input.tool.name !== "datafn_notes_update");

    expect(await toolNames(client)).toEqual([
      "datafn_notes_create",
      "datafn_notes_get",
      "datafn_notes_list",
    ]);
  });

  describe("configuration", () => {
    const executor = { schema } as never;
    const base = {
      executor,
      context: () => undefined,
      clientId: () => "test",
    };

    it("refuses declared scopes without a sessionScopes resolver", () => {
      const registry = new McpFnRegistry<Session>();
      expect(() => createDatafnMcpRegistry<Session, undefined>({
        ...base,
        registry,
        expose: { notes: { fields: ["id"], scopes: { read: ["memotron:read"] } } },
      })).toThrow(/declares scopes, which need a sessionScopes resolver/);
      expect(registry.listTools()).toEqual([]);
      expect(() => createDatafnMcpAdapter<Session, undefined>({
        ...base,
        expose: { notes: { fields: ["id"] } },
      }).registerTool({
        name: "host_tool",
        description: "Host tool.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({}),
      }, { scopes: ["memotron:read"] })).toThrow(/declares scopes, which need a sessionScopes resolver/);
    });

    it("requires scopes for every enabled operation once sessionScopes is set", () => {
      const registry = new McpFnRegistry<Session>();
      expect(() => createDatafnMcpAdapter<Session, undefined>({
        ...base,
        registry,
        sessionScopes: () => ["*"],
        expose: { notes: { fields: ["id"] } },
      })).toThrow(/notes scopes\.read must be/);
      expect(() => createDatafnMcpAdapter<Session, undefined>({
        ...base,
        registry,
        sessionScopes: () => ["*"],
        expose: {
          notes: {
            fields: ["id", "title"],
            scopes: { read: ["memotron:read"] },
            update: { fields: ["title"] },
          },
        },
      })).toThrow(/notes scopes\.write must be/);
      expect(registry.listTools()).toEqual([]);
    });

    it.each([
      [[]],
      [["*"]],
      [["memotron:*"]],
      [["memotron:read", "memotron:read"]],
      [["memotron read"]],
      [[""]],
    ])("refuses the needed scope list %j", (read) => {
      expect(() => createDatafnMcpAdapter<Session, undefined>({
        ...base,
        sessionScopes: () => ["*"],
        expose: { notes: { fields: ["id"], scopes: { read } } },
      })).toThrow(/without wildcards/);
    });
  });
});

it("exports the error code the gated tools answer with", () => {
  expect(DATAFN_INSUFFICIENT_SCOPE).toBe("insufficient_scope");
});
