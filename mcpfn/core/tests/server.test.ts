import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, ListToolsRequestSchema, LoggingMessageNotificationSchema, McpError, ResourceUpdatedNotificationSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
  type McpFnSchemaValidator,
} from "../src/index.js";

describe("McpFnServer", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close().catch(() => undefined)));
  });

  it("round-trips a validated tool over the official in-memory transport", async () => {
    const registry = new McpFnRegistry().register({
      name: "add",
      description: "Add two numbers.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { result: { type: "number" } },
        required: ["result"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async ({ a, b }) =>
        structuredResult({ result: Number(a) + Number(b) }),
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]).toMatchObject({
      name: "add",
      annotations: { readOnlyHint: true, openWorldHint: false },
    });
    await expect(
      client.callTool({ name: "add", arguments: { a: 2, b: 3 } }),
    ).resolves.toMatchObject({
      structuredContent: { result: 5 },
    });
  });

  it("returns handler McpErrors as tool errors while preserving routing errors", async () => {
    const registry = new McpFnRegistry().register({
      name: "handler_error",
      description: "Throw a handler error.",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => { throw new McpError(ErrorCode.InternalError, "handler failed"); },
    });
    const server = createMcpFnServer({ info: { name: "error-server", version: "1" }, registry });
    const client = new Client({ name: "error-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    await expect(client.callTool({ name: "handler_error", arguments: {} })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "MCPFN_TOOL_ERROR" } },
    });
    await expect(client.callTool({ name: "missing", arguments: {} })).rejects.toBeInstanceOf(McpError);
  });

  it("preserves protocol errors from profile resolution", async () => {
    const registry = new McpFnRegistry().register({
      name: "echo", description: "Echo.", inputSchema: { type: "object" },
      handler: async () => structuredResult({ ok: true }),
    });
    const server = createMcpFnServer({
      info: { name: "profile-error-server", version: "1" }, registry,
      clientProfiles: {
        profiles: [],
        resolveVerifiedIdentity: () => { throw new McpError(ErrorCode.InvalidRequest, "denied"); },
      },
    });
    const client = new Client({ name: "profile-error-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    await expect(client.callTool({ name: "echo", arguments: {} })).rejects.toBeInstanceOf(McpError);
  });

  it("accepts a runtime-safe schema compiler without using Ajv compilation", async () => {
    let compileCount = 0;
    let handlerCalls = 0;
    const registry = new McpFnRegistry({
      compileSchema: () => {
        compileCount += 1;
        const validate: McpFnSchemaValidator = (data: unknown) => {
          const valid = Boolean(data && typeof data === "object" &&
            (data as Record<string, unknown>).value === "allowed");
          validate.errors = valid ? null : [{ keyword: "const", message: "value is not allowed" }];
          return valid;
        };
        return validate;
      },
    }).register({
      name: "safe",
      description: "Validate without generated code.",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      handler: async () => {
        handlerCalls += 1;
        return structuredResult({ ok: true });
      },
    });
    const server = createMcpFnServer({ info: { name: "safe", version: "1.0.0" }, registry });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    expect(compileCount).toBe(1);
    const denied = await client.callTool({ name: "safe", arguments: { value: "denied" } });
    expect(denied).toMatchObject({ isError: true });
    expect(JSON.stringify(denied)).toContain("value is not allowed");
    expect(handlerCalls).toBe(0);
    await expect(client.callTool({ name: "safe", arguments: { value: "allowed" } }))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    expect(handlerCalls).toBe(1);
  });

  it("fails closed when a supplied schema validator returns a non-true value", async () => {
    let handlerCalls = 0;
    const registry = new McpFnRegistry({
      // A terse validator: a truthy non-boolean result and no error details.
      compileSchema: () => (() => "yes") as unknown as McpFnSchemaValidator,
    }).register({
      name: "terse",
      description: "Validate with a terse validator.",
      inputSchema: { type: "object" },
      handler: async () => {
        handlerCalls += 1;
        return structuredResult({ ok: true });
      },
    });
    const server = createMcpFnServer({ info: { name: "terse", version: "1.0.0" }, registry });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({ name: "terse", arguments: {} });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Schema validation failed");
    expect(handlerCalls).toBe(0);
  });

  it("reports a schema compiler failure as an invalid tool schema", () => {
    const registry = new McpFnRegistry({
      compileSchema: () => { throw new Error("unsupported keyword"); },
    });
    expect(() => registry.register({
      name: "broken",
      description: "Has a schema the compiler rejects.",
      inputSchema: { type: "object" },
      handler: async () => structuredResult({ ok: true }),
    })).toThrow("Tool broken contains an invalid JSON Schema");
    expect(registry.listTools()).toEqual([]);
  });

  it("cloneEmpty() keeps the schema compiler and copies no definitions", async () => {
    const compiledSchemas: object[] = [];
    const source = new McpFnRegistry({
      compileSchema: (schema) => {
        compiledSchemas.push(schema);
        const validate: McpFnSchemaValidator = (data: unknown) => {
          const valid = Boolean(data && typeof data === "object" &&
            (data as Record<string, unknown>).value === "allowed");
          validate.errors = valid ? null : [{ keyword: "const", message: "value is not allowed" }];
          return valid;
        };
        return validate;
      },
    })
      .register({
        name: "existing",
        description: "An existing tool.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ ok: true }),
      })
      .registerResource({ uri: "file:///existing", name: "existing", read: async () => ({ contents: [] }) })
      .registerResourceTemplate({
        uriTemplate: "file:///items/{id}",
        name: "item",
        read: async (uri) => ({ contents: [{ uri: uri.href, text: "item" }] }),
      })
      .registerPrompt({ name: "existing", get: async () => ({ messages: [] }) });
    const sourceTools = source.listTools();
    expect(sourceTools).toHaveLength(1);
    expect(await source.listResources()).toHaveLength(1);
    expect(source.listResourceTemplates()).toHaveLength(1);
    expect(source.listPrompts()).toHaveLength(1);
    const compiledBefore = compiledSchemas.length;

    const empty = source.cloneEmpty();
    expect(empty).not.toBe(source);
    expect(compiledSchemas).toHaveLength(compiledBefore);
    expect(empty.listTools()).toEqual([]);
    expect(await empty.listResources()).toEqual([]);
    expect(empty.listResourceTemplates()).toEqual([]);
    expect(empty.listPrompts()).toEqual([]);

    let handlerCalls = 0;
    const inputSchema = { type: "object", properties: { value: { type: "string" } } };
    empty.register({
      name: "safe",
      description: "Validated by the inherited compiler.",
      inputSchema,
      handler: async () => {
        handlerCalls += 1;
        return structuredResult({ ok: true });
      },
    });
    expect(compiledSchemas.at(-1)).toBe(inputSchema);
    expect(source.listTools()).toEqual(sourceTools);

    const server = createMcpFnServer({ info: { name: "empty", version: "1.0.0" }, registry: empty });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    const denied = await client.callTool({ name: "safe", arguments: { value: "denied" } });
    expect(denied).toMatchObject({ isError: true });
    expect(JSON.stringify(denied)).toContain("value is not allowed");
    expect(handlerCalls).toBe(0);
  });

  it("normalizes structured results without treating repeated references as cycles", () => {
    const shared = { value: 1 };
    const circular: Record<string, unknown> = { shared };
    circular.self = circular;
    expect(structuredResult({ first: shared, second: shared, circular })).toMatchObject({
      structuredContent: {
        first: { value: 1 },
        second: { value: 1 },
        circular: { shared: { value: 1 }, self: "[Circular]" },
      },
    });
    expect(structuredResult({ count: 1n }).structuredContent).toEqual({ count: "1" });
    expect(() => structuredResult({ toJSON: () => null })).toThrow(
      /structuredContent must serialize to an object/,
    );
  });

  it("lists prompt arguments derived from argumentsSchema", () => {
    const registry = new McpFnRegistry().registerPrompt({
      name: "schema_prompt",
      argumentsSchema: {
        type: "object",
        properties: { topic: { type: "string", description: "Topic to explain." } },
        required: ["topic"],
        additionalProperties: false,
      },
      get: async () => ({ messages: [] }),
    });
    const prompts = registry.listPrompts();
    expect(prompts).toEqual([expect.objectContaining({
      name: "schema_prompt",
      arguments: [{ name: "topic", description: "Topic to explain.", required: true }],
    })]);
    expect(createMcpFnServer({
      info: { name: "schema-prompt", version: "1.0.0" },
      registry,
    }).manifest().prompts).toEqual([expect.objectContaining({
      name: "schema_prompt",
      arguments: [{ name: "topic", description: "Topic to explain.", required: true }],
    })]);
  });

  it("resolves percent-encoded local references in prompt argument schemas", () => {
    for (const reference of ["#/definitions/first%20name", "#%2Fdefinitions%2Ffirst%20name"]) {
      const registry = new McpFnRegistry().registerPrompt({
        name: "encoded_reference_prompt",
        argumentsSchema: {
          type: "object",
          definitions: { "first name": { type: "string", description: "Given name." } },
          properties: { name: { $ref: reference } },
          required: ["name"],
          additionalProperties: false,
        },
        get: async () => ({ messages: [] }),
      });
      expect(registry.listPrompts()[0]?.arguments).toEqual([
        expect.objectContaining({ name: "name", required: true }),
      ]);
    }
  });

  it("lists required-only prompt arguments derived from argumentsSchema", () => {
    const registry = new McpFnRegistry().registerPrompt({
      name: "required_only_prompt",
      argumentsSchema: {
        type: "object",
        required: ["token"],
      },
      get: async () => ({ messages: [] }),
    });
    expect(registry.listPrompts()).toEqual([expect.objectContaining({
      name: "required_only_prompt",
      arguments: [{ name: "token", required: true }],
    })]);
  });

  it("rejects malformed prompt required lists through validation", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "invalid_required",
      argumentsSchema: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: "topic",
      } as never,
      get: async () => ({ messages: [] }),
    })).toThrow(/invalid arguments JSON Schema/);
  });

  it("rejects conflicting prompt argument declarations", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "conflicting_prompt",
      arguments: [{ name: "topic", required: false }],
      argumentsSchema: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/arguments and argumentsSchema disagree/);
  });

  it("derives and compares prompt inventories from composed schemas", () => {
    const registry = new McpFnRegistry().registerPrompt({
      name: "composed_prompt",
      arguments: [{ name: "topic", required: true }],
      argumentsSchema: {
        type: "object",
        allOf: [{
          properties: { topic: { type: "string" } },
          required: ["topic"],
        }],
      },
      get: async () => ({ messages: [] }),
    }).registerPrompt({
      name: "referenced_prompt",
      argumentsSchema: {
        type: "object",
        $defs: {
          arguments: {
            properties: { token: { type: "string", description: "Access token." } },
            required: ["token"],
          },
        },
        $ref: "#/$defs/arguments",
      },
      get: async () => ({ messages: [] }),
    });
    expect(registry.listPrompts()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "composed_prompt",
        arguments: [{ name: "topic", required: true }],
      }),
      expect.objectContaining({
        name: "referenced_prompt",
        arguments: [{ name: "token", description: "Access token.", required: true }],
      }),
    ]));

    expect(() => new McpFnRegistry().registerPrompt({
      name: "conflicting_composed_prompt",
      arguments: [{ name: "topic", required: true }],
      argumentsSchema: {
        type: "object",
        allOf: [{
          properties: { other: { type: "string" } },
          required: ["other"],
        }],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/arguments and argumentsSchema disagree/);
  });

  it("rejects prompt schemas that cannot expose string-valued inventories", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "numeric_prompt",
      argumentsSchema: {
        type: "object",
        properties: { age: { type: "number" } },
        required: ["age"],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/argument age must accept string values/);

    expect(() => new McpFnRegistry().registerPrompt({
      name: "contradictory_prompt",
      argumentsSchema: {
        type: "object",
        properties: {
          value: { allOf: [{ const: "a" }, { const: "b" }] },
        },
        required: ["value"],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/argument value must accept string values/);

    expect(() => new McpFnRegistry().registerPrompt({
      name: "conditional_prompt",
      arguments: [{ name: "topic" }],
      argumentsSchema: {
        type: "object",
        anyOf: [{ properties: { topic: { type: "string" } } }],
      },
      get: async () => ({ messages: [] }),
    })).toThrow(/must use derivable properties/);
  });

  it("rejects prompts without callable get handlers", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "missing_get",
    } as never)).toThrow(/requires a get handler function/);
    expect(() => new McpFnRegistry().registerPrompt({
      name: "invalid_get",
      get: true,
    } as never)).toThrow(/requires a get handler function/);
  });

  it("rejects malformed prompt argument inventories with a validation error", () => {
    expect(() => new McpFnRegistry().registerPrompt({
      name: "malformed_prompt",
      arguments: false,
      get: async () => ({ messages: [] }),
    } as never)).toThrow(/arguments must be an array/);
  });

  it("rejects malformed prompt argument fields and non-object schemas", () => {
    const register = (argumentsValue: unknown) => new McpFnRegistry().registerPrompt({
      name: "malformed_prompt",
      arguments: argumentsValue,
      get: async () => ({ messages: [] }),
    } as never);

    expect(() => register([{ name: "contains whitespace" }])).toThrow(/Invalid MCP prompt argument name/);
    expect(() => register([{ name: "topic", description: 42 }])).toThrow(/description must be a string/);
    expect(() => register([{ name: "topic", required: "yes" }])).toThrow(/required must be a boolean/);
    expect(() => new McpFnRegistry().registerPrompt({
      name: "non_object_schema",
      argumentsSchema: { type: "string" },
      get: async () => ({ messages: [] }),
    } as never)).toThrow(/argumentsSchema must be an object schema/);
    expect(() => new McpFnRegistry().registerPrompt({
      name: "null_schema",
      argumentsSchema: null,
      get: async () => ({ messages: [] }),
    } as never)).toThrow(/argumentsSchema must be an object schema/);
  });

  it("rejects unknown task support values at registration", () => {
    expect(() => new McpFnRegistry().register({
      name: "unknown_task_support",
      description: "Reject invalid task support.",
      inputSchema: { type: "object" },
      execution: { taskSupport: "sometimes" },
      handler: async () => structuredResult({ ok: true }),
    } as never)).toThrow(/invalid taskSupport=sometimes/);
  });

  it("rejects non-object tool output schemas at registration", () => {
    expect(() => new McpFnRegistry().register({
      name: "non_object_output",
      description: "Reject a non-object structured output contract.",
      inputSchema: { type: "object" },
      outputSchema: { type: "string" },
      handler: async () => structuredResult({ ok: true }),
    } as never)).toThrow(/outputSchema must be an object schema/);

    expect(() => new McpFnRegistry().register({
      name: "null_output",
      description: "Reject a null structured output contract.",
      inputSchema: { type: "object" },
      outputSchema: null,
      handler: async () => structuredResult({ ok: true }),
    } as never)).toThrow(/outputSchema must be an object schema/);
  });

  it("rejects missing and non-function tool handlers at registration", () => {
    const definition = {
      name: "invalid_handler",
      description: "Reject an invalid handler.",
      inputSchema: { type: "object" },
    };
    expect(() => new McpFnRegistry().register(definition as never))
      .toThrow(/requires a handler function/);
    expect(() => new McpFnRegistry().register({ ...definition, handler: "invalid" } as never))
      .toThrow(/requires a handler function/);
  });

  it("rejects resources and templates without callable read handlers", () => {
    expect(() => new McpFnRegistry().registerResource({
      uri: "docs://missing-read",
      name: "missing-read",
    } as never)).toThrow(/requires a read handler function/);
    expect(() => new McpFnRegistry().registerResourceTemplate({
      uriTemplate: "docs://missing-read/{id}",
      name: "missing-read-template",
      read: "invalid",
    } as never)).toThrow(/requires a read handler function/);
  });

  it("filters tools per request and makes hidden calls indistinguishable from unknown tools", async () => {
    const invoked: string[] = [];
    const registry = new McpFnRegistry<{ permissions: readonly string[] }>()
      .register({
        name: "visible",
        description: "Visible to readers.",
        inputSchema: { type: "object" },
        metadata: { permission: "records.read" },
        handler: async () => { invoked.push("visible"); return structuredResult({ ok: true }); },
      })
      .register({
        name: "hidden",
        description: "Hidden from readers.",
        inputSchema: { type: "object" },
        metadata: { permission: "records.delete" },
        handler: async () => { invoked.push("hidden"); return structuredResult({ ok: true }); },
      });
    const server = createMcpFnServer({
      info: { name: "visibility", version: "1.0.0" },
      registry,
      context: () => ({ permissions: ["records.read"] }),
      toolVisibility: ({ tool, context }) =>
        context.permissions.includes(String(tool._meta?.permission)),
    });
    const client = new Client(
      { name: "visibility-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["visible"]);
    await expect(client.callTool({ name: "hidden" })).rejects.toMatchObject({ code: -32601 });
    await expect(client.callTool({ name: "missing" })).rejects.toMatchObject({ code: -32601 });
    expect(invoked).toEqual([]);
    await expect(client.callTool({ name: "visible" })).resolves.toMatchObject({
      structuredContent: { ok: true },
    });
    expect(invoked).toEqual(["visible"]);
    expect(server.manifest().tools.map(({ name }) => name)).toEqual(["hidden", "visible"]);
  });

  it("checks only the requested tool on calls without client profiles", async () => {
    const checked: string[] = [];
    const registry = new McpFnRegistry()
      .register({
        name: "available",
        description: "Available tool.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ ok: true }),
      })
      .register({
        name: "unrelated",
        description: "Unrelated tool.",
        inputSchema: { type: "object" },
        handler: async () => structuredResult({ ok: true }),
      });
    const server = createMcpFnServer({
      info: { name: "visibility-scope", version: "1.0.0" },
      registry,
      toolVisibility: ({ tool }) => {
        checked.push(tool.name);
        if (tool.name === "unrelated") throw new Error("unrelated policy unavailable");
        return true;
      },
    });
    const client = new Client(
      { name: "visibility-scope-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await expect(client.callTool({ name: "available" })).resolves.toMatchObject({
      structuredContent: { ok: true },
    });
    expect(checked).toEqual(["available"]);
  });

  it("resolves verified identity before running list visibility hooks", async () => {
    const order: string[] = [];
    const registry = new McpFnRegistry().register({
      name: "private", description: "Private tool.", inputSchema: { type: "object" },
      handler: async () => structuredResult({ ok: true }),
    });
    const server = createMcpFnServer({
      info: { name: "profile-visibility-order", version: "1" }, registry,
      toolVisibility: () => { order.push("visibility"); return true; },
      clientProfiles: { profiles: [], resolveVerifiedIdentity: () => {
        order.push("identity");
        throw new Error("identity rejected");
      } },
    });
    const client = new Client({ name: "profile-visibility-client", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(right); await client.connect(left);
    closeables.push(client, server);

    // The hook's own error text is withheld (MCP-SEC-08).
    await expect(client.listTools()).rejects.toThrow(/Internal error/);
    expect(order).toEqual(["identity"]);
  });

  it("returns a tool error for invalid arguments without invoking the handler", async () => {
    let called = false;
    const registry = new McpFnRegistry().register({
      name: "required",
      description: "Require one value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      handler: async () => {
        called = true;
        return structuredResult({ ok: true });
      },
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({ name: "required", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "MCPFN_INVALID_ARGUMENTS" },
    });
    expect(called).toBe(false);
  });

  it("allows domain packages to retain their stable invalid-argument envelope", async () => {
    const registry = new McpFnRegistry().register({
      name: "domain_validation",
      description: "Map validation failures.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      handler: async () => structuredResult({ ok: true }),
      handleInvalidArguments: async (_args, issues) => ({
        content: [{ type: "text", text: "domain invalid" }],
        structuredContent: { ok: false, code: "DOMAIN_INVALID", issues },
        isError: true,
      }),
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await expect(client.callTool({
      name: "domain_validation",
      arguments: {},
    })).resolves.toMatchObject({
      isError: true,
      structuredContent: { ok: false, code: "DOMAIN_INVALID" },
    });
  });

  it("keeps error results valid when a tool declares a success output schema", async () => {
    const registry = new McpFnRegistry().register({
      name: "success_schema",
      description: "Declare a success-only schema.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
      handler: async ({ value }) => structuredResult({ value }),
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({ name: "success_schema", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      error: { code: "MCPFN_INVALID_ARGUMENTS" },
    });
  });

  it("preserves coded plain-object domain errors", async () => {
    const registry = new McpFnRegistry().register({
      name: "plain_error",
      description: "Throw a coded object.",
      inputSchema: { type: "object" },
      handler: async () => {
        throw { code: "DOMAIN_DENIED", message: "Denied", metadata: { policy: "test" } };
      },
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await expect(client.callTool({ name: "plain_error" })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: "DOMAIN_DENIED", message: "Denied", details: { policy: "test" } },
      },
    });
  });

  it("serializes circular and bigint error details safely", async () => {
    const details: Record<string, unknown> = { count: 2n };
    details.self = details;
    const registry = new McpFnRegistry().register({
      name: "complex_error",
      description: "Throw complex details.",
      inputSchema: { type: "object" },
      handler: async () => {
        throw { code: "COMPLEX", message: "Complex", details };
      },
    });
    const server = createMcpFnServer({
      info: { name: "test", version: "1.0.0" },
      registry,
    });
    const client = new Client(
      { name: "test-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await expect(client.callTool({ name: "complex_error" })).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { details: { count: "2", self: "[Circular]" } },
      },
    });
  });

  it("passes validated HTTP authInfo into trusted context", async () => {
    const registry = new McpFnRegistry<{ clientId: string }>().register({
      name: "whoami",
      description: "Return the authenticated client.",
      inputSchema: { type: "object" },
      handler: async (_args, context) => structuredResult({ clientId: context.clientId }),
    });
    const server = createMcpFnServer({
      info: { name: "http-auth", version: "1.0.0" },
      registry,
      context: (extra) => ({ clientId: extra.authInfo?.clientId ?? "anonymous" }),
    });
    const handler = await server.createWebStandardHandler({ enableJsonResponse: true });
    closeables.push(server);
    const authInfo = {
      token: "verified-token",
      clientId: "client-42",
      scopes: ["mcp:read"],
      resource: new URL("https://example.com/mcp"),
    };
    const post = (body: unknown) => handler(new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }), { authInfo });

    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(initialized.status).toBe(200);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const called = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "whoami", arguments: {} },
    });
    expect(await called.json()).toMatchObject({
      result: { structuredContent: { clientId: "client-42" } },
    });
  });

  it("configures every isolated stateless request server before connecting it", async () => {
    const registry = new McpFnRegistry().register({
      name: "visible_without_configuration",
      description: "Prove request-server configuration can wrap live protocol handlers.",
      inputSchema: { type: "object" },
      handler: async () => structuredResult({ ok: true }),
    });
    const server = createMcpFnServer({
      info: { name: "configured-stateless", version: "1.0.0" },
      registry,
    });
    const configuredServers: Array<typeof server> = [];
    const handler = await server.createWebStandardHandler({
      enableJsonResponse: true,
      configureRequestServer: (requestServer) => {
        configuredServers.push(requestServer);
        requestServer.protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [],
        }));
      },
    });
    closeables.push(server);
    const post = (body: unknown) => handler(new Request("https://example.com/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }));

    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    expect(initialized.status).toBe(200);
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await expect(listed.json()).resolves.toMatchObject({ result: { tools: [] } });
    expect(configuredServers).toHaveLength(2);
    expect(new Set(configuredServers).size).toBe(2);
    expect(configuredServers).not.toContain(server);
  });

  it("delivers notifications sent through the server to session HTTP clients", async () => {
    const server = createMcpFnServer({
      info: { name: "notify-test", version: "1.0.0" },
      registry: new McpFnRegistry().register({
        name: "noop",
        description: "Does nothing.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => structuredResult({}),
      }),
    });
    let nextSession = 0;
    const handler = await server.createWebStandardHandler({
      sessionIdGenerator: () => `session-${++nextSession}`,
    });
    const client = new Client({ name: "notify-client", version: "1.0.0" });
    const received = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => resolve());
    });
    const transport = new StreamableHTTPClientTransport(new URL("https://example.com/mcp"), {
      fetch: (input, init) => handler(new Request(input, init)),
    });
    closeables.push(client, server);
    await client.connect(transport);
    // Wait until the client's standalone event stream is open on the session server.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await server.sendToolListChanged();
    await expect(Promise.race([
      received.then(() => "received"),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 2_000)),
    ])).resolves.toBe("received");
  });

  it("delivers log messages only to the named HTTP session at its logging level", async () => {
    const server = createMcpFnServer({
      info: { name: "log-test", version: "1.0.0" },
      additionalCapabilities: { logging: {} },
      registry: new McpFnRegistry().register({
        name: "noop",
        description: "Does nothing.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => structuredResult({}),
      }),
    });
    let nextSession = 0;
    const handler = await server.createWebStandardHandler({
      sessionIdGenerator: () => `session-${++nextSession}`,
    });
    const open = async (name: string) => {
      const client = new Client({ name, version: "1.0.0" });
      const messages: unknown[] = [];
      client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
        messages.push(notification.params.data);
      });
      const transport = new StreamableHTTPClientTransport(new URL("https://example.com/mcp"), {
        fetch: (input, init) => handler(new Request(input, init)),
      });
      closeables.push(client);
      await client.connect(transport);
      return { client, messages, sessionId: transport.sessionId! };
    };
    closeables.push(server);
    const first = await open("first");
    const second = await open("second");
    await first.client.setLoggingLevel("error");
    await new Promise((resolve) => setTimeout(resolve, 50));

    await server.sendLoggingMessage({ level: "error", data: "no session named" });
    await server.sendLoggingMessage({ level: "debug", data: "below first's level" }, first.sessionId);
    await server.sendLoggingMessage({ level: "error", data: "for first" }, first.sessionId);
    await server.sendLoggingMessage({ level: "info", data: "for second" }, second.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(first.messages).toEqual(["for first"]);
    expect(second.messages).toEqual(["for second"]);
  });

  it("delivers resource updates only to HTTP sessions subscribed to that URI", async () => {
    const resource = (uri: string) => ({
      uri,
      name: uri.slice("memory://".length),
      read: async () => ({ contents: [{ uri, text: "ready" }] }),
      subscribe: async () => undefined,
      unsubscribe: async () => undefined,
    });
    const server = createMcpFnServer({
      info: { name: "subscription-test", version: "1.0.0" },
      registry: new McpFnRegistry()
        .registerResource(resource("memory://status"))
        .registerResource(resource("memory://other"))
        .registerResource({
          ...resource("memory://refused"),
          subscribe: async () => { throw new Error("subscription refused"); },
        }),
    });
    let nextSession = 0;
    const handler = await server.createWebStandardHandler({
      sessionIdGenerator: () => `session-${++nextSession}`,
    });
    const open = async (name: string) => {
      const client = new Client({ name, version: "1.0.0" });
      const updates: string[] = [];
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
        updates.push(notification.params.uri);
      });
      closeables.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL("https://example.com/mcp"), {
        fetch: (input, init) => handler(new Request(input, init)),
      }));
      return { client, updates };
    };
    closeables.push(server);
    const subscriber = await open("subscriber");
    const bystander = await open("bystander");
    await subscriber.client.subscribeResource({ uri: "memory://status" });
    await bystander.client.subscribeResource({ uri: "memory://other" });
    await expect(bystander.client.subscribeResource({ uri: "memory://refused" })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await server.sendResourceUpdated({ uri: "memory://status" });
    await server.sendResourceUpdated({ uri: "memory://refused" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(subscriber.updates).toEqual(["memory://status"]);
    expect(bystander.updates).toEqual([]);

    await subscriber.client.unsubscribeResource({ uri: "memory://status" });
    await server.sendResourceUpdated({ uri: "memory://status" });
    await server.sendResourceUpdated({ uri: "memory://other" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(subscriber.updates).toEqual(["memory://status"]);
    expect(bystander.updates).toEqual(["memory://other"]);
  });

  it("lets a later unsubscribe win over a subscribe that is still running", async () => {
    let subscribeCalls = 0;
    let subscribeEntered!: () => void;
    const entered = new Promise<void>((resolve) => { subscribeEntered = resolve; });
    let releaseSubscribe!: () => void;
    const released = new Promise<void>((resolve) => { releaseSubscribe = resolve; });
    const server = createMcpFnServer({
      info: { name: "subscription-race-test", version: "1.0.0" },
      registry: new McpFnRegistry().registerResource({
        uri: "memory://status",
        name: "status",
        read: async () => ({ contents: [{ uri: "memory://status", text: "ready" }] }),
        subscribe: async () => {
          if (++subscribeCalls > 1) return;
          subscribeEntered();
          await released;
        },
        unsubscribe: async () => undefined,
      }),
    });
    const handler = await server.createWebStandardHandler({ sessionIdGenerator: () => "session-1" });
    const client = new Client({ name: "racer", version: "1.0.0" });
    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, async (notification) => {
      updates.push(notification.params.uri);
    });
    closeables.push(client, server);
    await client.connect(new StreamableHTTPClientTransport(new URL("https://example.com/mcp"), {
      fetch: (input, init) => handler(new Request(input, init)),
    }));

    const slowSubscribe = client.subscribeResource({ uri: "memory://status" });
    await entered;
    await client.unsubscribeResource({ uri: "memory://status" });
    releaseSubscribe();
    await slowSubscribe;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await server.sendResourceUpdated({ uri: "memory://status" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(updates).toEqual([]);

    // A subscribe that starts after the unsubscribe is recorded as usual.
    await client.subscribeResource({ uri: "memory://status" });
    await server.sendResourceUpdated({ uri: "memory://status" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(updates).toEqual(["memory://status"]);
  });

  it("keeps broadcasting when one HTTP session's transport fails", async () => {
    const server = createMcpFnServer({
      info: { name: "broadcast-test", version: "1.0.0" },
      registry: new McpFnRegistry().register({
        name: "noop",
        description: "Does nothing.",
        inputSchema: { type: "object", properties: {} },
        handler: async () => structuredResult({}),
      }),
    });
    let nextSession = 0;
    const handler = await server.createWebStandardHandler({
      sessionIdGenerator: () => `session-${++nextSession}`,
      configureRequestServer: (requestServer) => {
        if (nextSession === 1) {
          // The second session's transport fails every send, like a client
          // that disappeared without closing its session.
          requestServer.protocol.sendToolListChanged = () => Promise.reject(new Error("transport gone"));
        }
      },
    });
    const healthy = new Client({ name: "healthy", version: "1.0.0" });
    const received = new Promise<void>((resolve) => {
      healthy.setNotificationHandler(ToolListChangedNotificationSchema, async () => resolve());
    });
    const broken = new Client({ name: "broken", version: "1.0.0" });
    const connect = (client: Client) => client.connect(new StreamableHTTPClientTransport(new URL("https://example.com/mcp"), {
      fetch: (input, init) => handler(new Request(input, init)),
    }));
    closeables.push(healthy, broken, server);
    await connect(healthy);
    await connect(broken);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(server.sendToolListChanged()).resolves.toBeUndefined();
    await expect(Promise.race([
      received.then(() => "received"),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 2_000)),
    ])).resolves.toBe("received");
  });

  it("points client requests without a direct transport to the per-request APIs", async () => {
    const server = createMcpFnServer({
      info: { name: "client-request-test", version: "1.0.0" },
      registry: new McpFnRegistry(),
    });
    closeables.push(server);
    await server.createWebStandardHandler({ sessionIdGenerator: () => "session-1" });
    await expect(server.sample({ messages: [], maxTokens: 1 })).rejects.toMatchObject({
      code: "MCPFN_CLIENT_REQUEST_NEEDS_REQUEST",
      message: expect.stringContaining("sampleForRequest"),
    });
    await expect(server.elicit({ message: "?", requestedSchema: { type: "object", properties: {} } })).rejects.toMatchObject({
      code: "MCPFN_CLIENT_REQUEST_NEEDS_REQUEST",
    });
    await expect(server.listRoots()).rejects.toMatchObject({ code: "MCPFN_CLIENT_REQUEST_NEEDS_REQUEST" });
  });

  it("routes sessionful HTTP clients to isolated transports", async () => {
    const registry = new McpFnRegistry().register({
      name: "echo",
      description: "Echo a value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      handler: async ({ value }) => structuredResult({ value }),
    });
    const server = createMcpFnServer({
      info: { name: "session-test", version: "1.0.0" },
      registry,
    });
    let nextSession = 0;
    let signalCloseStarted: () => void;
    let finishClose: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    const closeCanFinish = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const configuredServers: Array<typeof server> = [];
    const closeCalls = new Map<typeof server, number>();
    const handler = await server.createWebStandardHandler({
      enableJsonResponse: true,
      sessionIdGenerator: () => `session-${++nextSession}`,
      onsessionclosed: async (id) => {
        if (id === "session-1") {
          signalCloseStarted();
          await closeCanFinish;
        }
      },
      configureRequestServer: (requestServer) => {
        configuredServers.push(requestServer);
        const close = requestServer.close.bind(requestServer);
        requestServer.close = async () => {
          closeCalls.set(requestServer, (closeCalls.get(requestServer) ?? 0) + 1);
          await close();
        };
      },
    });
    closeables.push(server);
    const post = (body: unknown, sessionId?: string) => handler(new Request(
      "https://example.com/mcp",
      {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        },
        body: JSON.stringify(body),
      },
    ));
    const initialize = (id: number) => post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: `client-${id}`, version: "1.0.0" },
      },
    });

    const rejected = await post({
      jsonrpc: "2.0",
      id: 0,
      method: "tools/list",
    });
    expect(rejected.status).toBe(400);
    await rejected.text();
    expect(configuredServers).toHaveLength(1);
    expect(configuredServers).not.toContain(server);
    expect(closeCalls.get(configuredServers[0]!)).toBe(1);

    const first = await initialize(1);
    const second = await initialize(2);
    const firstSession = first.headers.get("mcp-session-id");
    const secondSession = second.headers.get("mcp-session-id");
    expect(firstSession).toBe("session-1");
    expect(secondSession).toBe("session-2");
    expect(configuredServers).toHaveLength(3);
    expect(configuredServers).not.toContain(server);

    for (const [id, sessionId] of [[3, firstSession], [4, secondSession]] as const) {
      const response = await post({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "echo", arguments: { value: sessionId } },
      }, sessionId!);
      expect(await response.json()).toMatchObject({
        result: { structuredContent: { value: sessionId } },
      });
    }
    expect(configuredServers).toHaveLength(3);

    const remove = (sessionId: string) => handler(new Request("https://example.com/mcp", {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": sessionId,
        },
      }));
    const firstRemoval = remove(firstSession!);
    await closeStarted;
    const whileClosing = await post({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "echo", arguments: { value: "too-late" } },
    }, firstSession!);
    expect(whileClosing.status).toBe(404);
    finishClose();
    expect((await firstRemoval).status).toBe(200);
    expect(closeCalls.get(configuredServers[1]!)).toBe(1);

    expect((await remove(secondSession!)).status).toBe(200);
    expect(closeCalls.get(configuredServers[2]!)).toBe(1);
  });
});
