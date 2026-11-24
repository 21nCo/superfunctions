import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpFnError,
  McpFnRegistry,
  createMcpFnServer,
  errorResult,
  structuredResult,
  type McpFnServerOptions,
} from "../src/index.js";
import { createSchemaCompiler } from "../src/validation.js";

// Regression tests for the McpFn security audit (MCP-21): MCP-SEC-06
// (validation work on untrusted arguments), MCP-SEC-08 (error text returned to
// clients), MCP-SEC-13 (subscription cap) and MCP-SEC-17 (completer lookup).

const closeables: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(closeables.splice(0).map((value) => value.close().catch(() => undefined)));
});

async function connect(
  registry: McpFnRegistry,
  options: Partial<McpFnServerOptions<undefined>> = {},
) {
  const server = createMcpFnServer({ info: { name: "security", version: "1.0.0" }, registry, ...options });
  const client = new Client({ name: "client", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeables.push(client, server);
  return client;
}

function systemError(): Error {
  return Object.assign(new Error("ENOENT: no such file or directory, open '/srv/app/secrets/tenant.json'"), {
    code: "ENOENT",
    errno: -2,
    syscall: "open",
    path: "/srv/app/secrets/tenant.json",
  });
}

describe("schema validation of untrusted arguments (MCP-SEC-06)", () => {
  it.each(["ajv", "cfworker"] as const)("stops at the first failure with %s", (engine) => {
    const validate = createSchemaCompiler(engine).compile({
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
    });
    expect(validate({ items: Array.from({ length: 10_000 }, (_, index) => index) })).toBe(false);
    // One failure path (cfworker reports its parent schemas too), not one per item.
    expect(validate.errors?.length).toBeLessThan(10);
  });
});

describe("tool error text (MCP-SEC-08)", () => {
  function failingRegistry(error: () => unknown) {
    return new McpFnRegistry().register({
      name: "read_file",
      description: "Fails.",
      inputSchema: { type: "object" },
      handler: async () => {
        throw error();
      },
    });
  }

  it("withholds unexpected error text and reports it to onError", async () => {
    const onError = vi.fn();
    const client = await connect(failingRegistry(systemError), { onError });
    const result = await client.callTool({ name: "read_file" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("/srv/app");
    expect(JSON.stringify(result)).not.toContain("ENOENT");
    expect(result.structuredContent).toMatchObject({
      error: { code: "MCPFN_TOOL_ERROR", message: "The tool failed", details: { errorId: expect.any(String) } },
    });
    const errorId = (result.structuredContent as { error: { details: { errorId: string } } }).error.details.errorId;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ errorId, method: "tools/call", tool: "read_file" }));
    expect(onError.mock.calls[0]![0].error.code).toBe("ENOENT");
  });

  it("withholds the text of plain Errors", async () => {
    const client = await connect(failingRegistry(() => new Error("connection to db.internal:5432 refused")));
    expect(JSON.stringify(await client.callTool({ name: "read_file" }))).not.toContain("db.internal");
  });

  it("keeps McpFnError, McpError and plain coded objects", async () => {
    const mcpfn = await connect(failingRegistry(() => new McpFnError("DOMAIN_DENIED", "Denied", { policy: "test" })));
    expect((await mcpfn.callTool({ name: "read_file" })).structuredContent).toMatchObject({
      error: { code: "DOMAIN_DENIED", message: "Denied", details: { policy: "test" } },
    });
    const protocol = await connect(failingRegistry(() => new McpError(ErrorCode.InvalidParams, "Bad input")));
    expect(JSON.stringify(await protocol.callTool({ name: "read_file" }))).toContain("Bad input");
  });

  it("returns error text verbatim with exposeErrors", async () => {
    const client = await connect(failingRegistry(systemError), { exposeErrors: true });
    expect((await client.callTool({ name: "read_file" })).structuredContent).toMatchObject({
      error: { code: "ENOENT" },
    });
  });

  it("ignores onError failures", async () => {
    const client = await connect(failingRegistry(systemError), { onError: () => { throw new Error("sink down"); } });
    expect((await client.callTool({ name: "read_file" })).isError).toBe(true);
  });

  it("withholds errorResult text unless verbatim", () => {
    expect(JSON.stringify(errorResult(systemError()))).not.toContain("/srv/app");
    expect(JSON.stringify(errorResult(systemError(), { verbatim: true }))).toContain("/srv/app");
  });

  it("withholds unexpected error text from resources, prompts and completions", async () => {
    const onError = vi.fn();
    const registry = new McpFnRegistry()
      .registerResource({ uri: "file:///report", name: "report", read: async () => { throw systemError(); } })
      .registerPrompt({
        name: "summary",
        description: "Summary",
        arguments: [{ name: "topic" }],
        get: async () => { throw systemError(); },
        complete: { topic: async () => { throw systemError(); } },
      });
    const client = await connect(registry, { onError });
    for (const run of [
      () => client.readResource({ uri: "file:///report" }),
      () => client.getPrompt({ name: "summary" }),
      () => client.complete({ ref: { type: "ref/prompt", name: "summary" }, argument: { name: "topic", value: "a" } }),
    ]) {
      const error = await run().then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(McpError);
      expect(String((error as Error).message)).not.toContain("/srv/app");
      expect((error as McpError).data).toEqual({ errorId: expect.any(String) });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError.mock.calls.map(([input]) => input.method)).toEqual([
      "resources/read",
      "prompts/get",
      "completion/complete",
    ]);
  });
});

describe("withheld errors outside tool handlers (MCP-SEC-08)", () => {
  it("keeps an McpError from another copy of the SDK", async () => {
    const foreign = Object.assign(new Error("MCP error -32602: Bad resource"), { name: "McpError", code: ErrorCode.InvalidParams, data: { field: "uri" } });
    const registry = new McpFnRegistry().registerResource({ uri: "file:///report", name: "report", read: async () => { throw foreign; } });
    const client = await connect(registry);
    const error = await client.readResource({ uri: "file:///report" }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toMatchObject({ code: ErrorCode.InvalidParams, data: { field: "uri" } });
  });

  it("withholds plain coded objects thrown by protocol handlers", async () => {
    const registry = new McpFnRegistry().registerResource({
      uri: "file:///report",
      name: "report",
      read: async () => { throw { code: "DB_ERROR", message: "db.internal refused", data: { host: "db.internal" } }; },
    });
    const client = await connect(registry);
    const error = await client.readResource({ uri: "file:///report" }).then(() => undefined, (failure: unknown) => failure);
    expect(JSON.stringify(error)).not.toContain("db.internal");
    expect(String((error as Error).message)).not.toContain("db.internal");
  });

  it("withholds context factory errors", async () => {
    const onError = vi.fn();
    const registry = new McpFnRegistry().register({
      name: "read_file",
      description: "Reads.",
      inputSchema: { type: "object" },
      handler: async () => structuredResult({ ok: true }),
    });
    const client = await connect(registry, { onError, context: () => { throw systemError(); } });
    const error = await client.callTool({ name: "read_file" }).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(McpError);
    expect(String((error as Error).message)).not.toContain("/srv/app");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ method: "tools/call" }));
  });

  it("withholds errors from task creation", async () => {
    const { InMemoryTaskStore } = await import("@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js");
    const { CreateTaskResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const registry = new McpFnRegistry().register({
      name: "slow",
      description: "Task tool.",
      inputSchema: { type: "object" },
      execution: { taskSupport: "required" },
      handler: async () => structuredResult({ ok: true }),
      taskHandler: { createTask: async () => { throw systemError(); }, getTask: vi.fn(), getTaskResult: vi.fn() } as never,
    });
    const client = await connect(registry, { taskStore: new InMemoryTaskStore() });
    const error = await client.request(
      { method: "tools/call", params: { name: "slow", arguments: {}, task: { ttl: 60_000 } } },
      CreateTaskResultSchema,
    ).then(() => undefined, (failure: unknown) => failure);
    expect(error).toMatchObject({ code: ErrorCode.InternalError, data: { errorId: expect.any(String) } });
    expect(String((error as Error).message)).not.toContain("/srv/app");
  });

  it("answers without waiting for a slow onError sink", async () => {
    const client = await connect(
      new McpFnRegistry().register({ name: "fail", description: "Fails.", inputSchema: { type: "object" }, handler: async () => { throw systemError(); } }),
      { onError: () => new Promise<void>(() => undefined) },
    );
    expect((await client.callTool({ name: "fail" })).isError).toBe(true);
  });
});

describe("resource subscriptions (MCP-SEC-13)", () => {
  it("caps subscriptions per client", async () => {
    const registry = new McpFnRegistry().registerResourceTemplate({
      uriTemplate: "file:///items/{id}",
      name: "item",
      read: async (uri) => ({ contents: [{ uri: uri.href, text: "item" }] }),
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    });
    const client = await connect(registry, { maxResourceSubscriptions: 2 });
    await client.subscribeResource({ uri: "file:///items/1" });
    await client.subscribeResource({ uri: "file:///items/2" });
    await client.subscribeResource({ uri: "file:///items/2" });
    await expect(client.subscribeResource({ uri: "file:///items/3" })).rejects.toThrow(/Too many resource subscriptions/);
    await client.unsubscribeResource({ uri: "file:///items/1" });
    await client.subscribeResource({ uri: "file:///items/3" });
  });

  it("counts a URI being re-subscribed once", async () => {
    let release!: () => void;
    let calls = 0;
    const registry = new McpFnRegistry().registerResourceTemplate({
      uriTemplate: "file:///items/{id}",
      name: "item",
      read: async (uri) => ({ contents: [{ uri: uri.href, text: "item" }] }),
      subscribe: async () => {
        calls += 1;
        if (calls === 2) await new Promise<void>((resolve) => { release = resolve; });
      },
      unsubscribe: async () => undefined,
    });
    const client = await connect(registry, { maxResourceSubscriptions: 2 });
    await client.subscribeResource({ uri: "file:///items/a" });
    const again = client.subscribeResource({ uri: "file:///items/a" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.subscribeResource({ uri: "file:///items/b" });
    release();
    await again;
  });

  it("rejects an invalid maxResourceSubscriptions", () => {
    expect(() => createMcpFnServer({
      info: { name: "security", version: "1.0.0" },
      registry: new McpFnRegistry(),
      maxResourceSubscriptions: 0,
    })).toThrow(/maxResourceSubscriptions/);
  });
});

describe("completer lookup (MCP-SEC-17)", () => {
  it("calls own completers as methods", async () => {
    const complete = {
      topic(this: { values: string[] }) { return { completion: { values: this.values, total: 1, hasMore: false } }; },
    };
    Object.defineProperty(complete, "values", { value: ["a"], enumerable: false });
    const registry = new McpFnRegistry().registerPrompt({
      name: "summary",
      description: "Summary",
      arguments: [{ name: "topic" }],
      get: async () => ({ messages: [] }),
      complete: complete as never,
    });
    const client = await connect(registry);
    await expect(client.complete({ ref: { type: "ref/prompt", name: "summary" }, argument: { name: "topic", value: "a" } }))
      .resolves.toMatchObject({ completion: { values: ["a"] } });
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("ignores inherited name %s", async (name) => {
    const registry = new McpFnRegistry().registerPrompt({
      name: "summary",
      description: "Summary",
      arguments: [{ name: "topic" }],
      get: async () => ({ messages: [] }),
      complete: { topic: async () => ({ completion: { values: ["a"], total: 1, hasMore: false } }) },
    });
    const client = await connect(registry);
    await expect(client.complete({ ref: { type: "ref/prompt", name: "summary" }, argument: { name, value: "a" } }))
      .resolves.toMatchObject({ completion: { values: [] } });
  });
});
