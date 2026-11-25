import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import { CreateTaskResultSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  McpFnRegistry,
  McpFnValidationError,
  McpFnError,
  type McpFnClientProfileEvidence,
  type McpFnTaskRequestExtra,
  createMcpFnServer,
  structuredResult,
  enrichMcpFnClientProfileCall,
  type McpFnClientProfile,
  type McpFnObjectSchema,
  type McpFnRequestExtra,
} from "../src/index.js";
import { createSchemaCompiler } from "../src/validation.js";

interface RequestContext {
  subject?: string;
  tenantId?: string;
}

describe("McpFn client profiles", () => {
  it("reuses schema validation only for identical projection dependency graphs", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const compile = vi.spyOn(Ajv.prototype, "compile");
    const tool = { name: "cache_graph", inputSchema: { type: "object" as const, $id: "https://cache.invalid/unique", properties: { value: { type: "string" } } } };
    const input = { canonicalTools: [tool], resolved: { context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" }, profile: { id: "cache", version: "1", matches: () => true } } };
    try {
      await buildMcpFnEffectiveCatalog(input);
      expect(compile.mock.calls.length).toBeGreaterThan(0);
      compile.mockClear();
      await buildMcpFnEffectiveCatalog(input);
      expect(compile).not.toHaveBeenCalled();
      tool.inputSchema.properties.value.type = "not-a-json-schema-type";
      await expect(buildMcpFnEffectiveCatalog(input)).rejects.toThrow("Projected schema must be valid JSON Schema");
    } finally { compile.mockRestore(); }
  });

  it("retains registered external schemas in profiled list and call validation", async () => {
    const registry = new McpFnRegistry<RequestContext>()
      .register({ name: "z_provider", description: "Provides a shared schema", inputSchema: { type: "object", $id: "https://profile.invalid/shared", properties: { value: { type: "string" } }, required: ["value"] }, handler: async () => structuredResult({ ok: true }) })
      .register({ name: "a_consumer", description: "Uses shared schema", inputSchema: { type: "object", properties: { nested: { $ref: "https://profile.invalid/shared" } }, required: ["nested"] }, handler: async () => structuredResult({ ok: true }) });
    const { client } = await connect({ subject: "authenticated-client" }, { id: "external", version: "1", matches: () => true, projectCatalog: ({ tools }) => tools.filter(tool => tool.name === "a_consumer") }, registry);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["a_consumer"]);
    expect((await client.callTool({ name: "a_consumer", arguments: { nested: { value: "valid" } } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "a_consumer", arguments: { nested: { value: 42 } } })).isError).toBe(true);
  });

  // Authored relative IDs share one namespace with every registered resource, as
  // they do at runtime; an anonymous schema's private identity is only for its
  // own "#" references and must not rebase "shared".
  it.each([
    ["an anonymous consumer", {}],
    ["a consumer with its own relative $id", { $id: "consumer" }],
  ])("resolves a relative registered schema from %s in profiled list and call", async (_label, identity) => {
    const registry = new McpFnRegistry<RequestContext>()
      .register({ name: "z_provider", description: "Provides a relative shared schema", inputSchema: { $id: "shared", type: "object", properties: { value: { type: "string" } }, required: ["value"] }, handler: async () => structuredResult({ ok: true }) })
      .register({ name: "a_consumer", description: "Uses the relative shared schema", inputSchema: { ...identity, type: "object", properties: { nested: { $ref: "shared" } }, required: ["nested"] }, handler: async () => structuredResult({ ok: true }) });
    const { client } = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["a_consumer", "z_provider"]);
    expect((await client.callTool({ name: "a_consumer", arguments: { nested: { value: "valid" } } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "a_consumer", arguments: { nested: { value: 42 } } })).isError).toBe(true);
  });

  // Ajv registers root IDs "shared" and "/shared" as two resources, so the
  // profiled catalog check before tools/list and tools/call must as well.
  it.each([["\"shared\" first", false], ["\"/shared\" first", true]])("lists and calls tools whose root IDs are \"shared\" and \"/shared\" (%s)", async (_label, reversed) => {
    const handler = async () => structuredResult({ ok: true });
    const text = { name: "text_tool", description: "Text", inputSchema: { $id: "shared", type: "object" as const, properties: { v: { type: "string" } }, required: ["v"] }, handler };
    const number = { name: "number_tool", description: "Number", inputSchema: { $id: "/shared", type: "object" as const, properties: { v: { type: "number" } }, required: ["v"] }, handler };
    const consumer = { name: "consumer", description: "Uses both spellings", inputSchema: { type: "object" as const, properties: { text: { $ref: "shared" }, number: { $ref: "/shared" } }, required: ["text", "number"] }, handler };
    const registry = new McpFnRegistry<RequestContext>();
    for (const tool of reversed ? [number, text, consumer] : [text, number, consumer]) registry.register(tool);
    const { client } = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["consumer", "number_tool", "text_tool"]);
    for (const [name, valid, invalid] of [
      ["text_tool", { v: "x" }, { v: 1 }],
      ["number_tool", { v: 1 }, { v: "x" }],
      ["consumer", { text: { v: "x" }, number: { v: 1 } }, { text: { v: 1 }, number: { v: "x" } }],
    ] as const) {
      expect((await client.callTool({ name, arguments: valid })).isError).not.toBe(true);
      expect((await client.callTool({ name, arguments: invalid })).isError).toBe(true);
    }
  });

  // References followed inside a provider resolve in that provider, as Ajv
  // compiles them, even beside a root whose $id ".../%41" serializes to ".../A".
  it("lists and calls consumers of a provider beside a percent-encoded spelling of its $id", async () => {
    const handler = async () => structuredResult({ ok: true });
    const base = "https://profile.invalid/";
    const registry = new McpFnRegistry<RequestContext>()
      .register({ name: "provider", description: "Provider", inputSchema: { $id: `${base}A`, type: "object" as const, properties: { v: { $ref: `${base}A#/definitions/q` } }, definitions: { q: { $id: "#node", type: "string" } } }, handler })
      .register({ name: "encoded", description: "Encoded spelling", inputSchema: { $id: `${base}%41`, type: "object" as const, definitions: { q: { type: "number" } } }, handler })
      .register({ name: "by_pointer", description: "Pointer into the provider", inputSchema: { type: "object" as const, properties: { v: { $ref: `${base}A#/properties/v` } }, required: ["v"] }, handler })
      .register({ name: "by_resource", description: "Whole provider", inputSchema: { type: "object" as const, properties: { p: { $ref: `${base}A` } }, required: ["p"] }, handler })
      .register({ name: "by_anchor", description: "Provider anchor", inputSchema: { type: "object" as const, properties: { v: { $ref: `${base}A#node` } }, required: ["v"] }, handler });
    const { client } = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["by_anchor", "by_pointer", "by_resource", "encoded", "provider"]);
    for (const [name, valid, invalid] of [
      ["by_pointer", { v: "text" }, { v: 42 }],
      ["by_resource", { p: { v: "text" } }, { p: { v: 42 } }],
      ["by_anchor", { v: "text" }, { v: 42 }],
    ] as const) {
      expect((await client.callTool({ name, arguments: valid })).isError).not.toBe(true);
      expect((await client.callTool({ name, arguments: invalid })).isError).toBe(true);
    }
  });

  // Ajv registers the nested $id "nested" as an alias of "shared#/definitions/inner"
  // and resolves it inside the consumer, whose own $id is "shared": the consumer's
  // definition, not the provider's, validates tools/call.
  it("compares a nested-ID alias with the definition Ajv validates tools/call against", async () => {
    const handler = async () => structuredResult({ ok: true });
    const provider = { $id: "./shared", type: "object" as const, definitions: { inner: { $id: "nested", type: "string" } } };
    const consumer = (type: string) => ({ $id: "shared", type: "object" as const, properties: { value: { $ref: "nested" } }, required: ["value"], definitions: { inner: { type } } });
    const registry = new McpFnRegistry<RequestContext>()
      .register({ name: "provider", description: "Provider", inputSchema: provider, handler })
      .register({ name: "consumer", description: "Consumer", inputSchema: consumer("number"), handler });
    const noop = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await noop.client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["consumer", "provider"]);
    expect((await noop.client.callTool({ name: "consumer", arguments: { value: 1 } })).isError).not.toBe(true);
    expect((await noop.client.callTool({ name: "consumer", arguments: { value: "text" } })).isError).toBe(true);
    const projected = await connect({ subject: "authenticated-client" }, { id: "retyped", version: "1", matches: () => true,
      projectCatalog: ({ tools }) => tools.map(tool => tool.name === "consumer" ? { ...tool, inputSchema: consumer("string") } : tool),
    }, registry);
    await expect(projected.client.listTools()).rejects.toThrow(/canonical schema/);
  });

  // Ajv registers the same alias text for a nested $id that a tool's input and
  // output schema (or two anonymous tools) both declare; each resolves it at
  // that pointer in the schema being compiled.
  it("lists and calls tools whose schemas repeat one nested $id definition", async () => {
    const handler = async () => structuredResult({ ok: true });
    const definitions = { address: { $id: "address", type: "string" } };
    const input = { type: "object" as const, properties: { a: { $ref: "address" } }, required: ["a"], definitions };
    const registry = new McpFnRegistry<RequestContext>()
      .register({ name: "first", description: "First", inputSchema: input, outputSchema: { type: "object" as const, definitions }, handler })
      .register({ name: "second", description: "Second", inputSchema: input, handler });
    const { client } = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["first", "second"]);
    for (const name of ["first", "second"]) {
      expect((await client.callTool({ name, arguments: { a: "street" } })).isError).not.toBe(true);
      expect((await client.callTool({ name, arguments: { a: 1 } })).isError).toBe(true);
    }
  });

  // An empty $id names no resource, so each sibling keeps its own local pointers.
  // Ajv normalizes a top-level "#" or "#/" to the same empty key.
  it.each([["", false], ["", true], ["#", false], ["#", true], ["#/", false], ["#/", true]] as const)("lists and calls an anonymous tool beside two distinct siblings with $id %j (reversed %s)", async (id, reversed) => {
    const handler = async () => structuredResult({ ok: true });
    const sibling = (type: string) => ({ $id: id, type: "object" as const, properties: { a: { $ref: "#/definitions/d" } }, required: ["a"], definitions: { d: { type } } });
    const definitions = [
      { name: "anonymous", description: "Anonymous", inputSchema: { type: "object" as const, properties: { x: { type: "string" } }, required: ["x"] }, handler },
      { name: "text", description: "Text", inputSchema: sibling("string"), handler },
      { name: "number", description: "Number", inputSchema: sibling("number"), handler },
    ];
    const registry = new McpFnRegistry<RequestContext>().registerAll(reversed ? definitions.reverse() : definitions);
    const { client } = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["anonymous", "number", "text"]);
    for (const [name, valid, invalid] of [
      ["anonymous", { x: "x" }, { x: 1 }],
      ["text", { a: "x" }, { a: 1 }],
      ["number", { a: 1 }, { a: "x" }],
    ] as const) {
      expect((await client.callTool({ name, arguments: valid })).isError).not.toBe(true);
      expect((await client.callTool({ name, arguments: invalid })).isError).toBe(true);
    }
  });

  // Ajv stores a nested ID as an alias "<owner>#<pointer>" and parses it as a URI,
  // so within its own tool an ID under definitions["%41"] names definitions.A.
  it.each([["a named", { $id: "own" }], ["an anonymous", {}]] as const)("compares a nested-ID alias at a percent-encoded pointer inside %s tool as tools/call validates it", async (_label, identity) => {
    const handler = async () => structuredResult({ ok: true });
    const schema = (type: string) => ({ ...identity, type: "object" as const, properties: { v: { $ref: "nested" } }, required: ["v"], definitions: { "%41": { $id: "nested", type: "string" }, A: { type } } });
    const registry = new McpFnRegistry<RequestContext>().register({ name: "own", description: "Own", inputSchema: schema("number"), handler });
    const noop = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await noop.client.listTools()).tools.map(tool => tool.name)).toEqual(["own"]);
    expect((await noop.client.callTool({ name: "own", arguments: { v: 1 } })).isError).not.toBe(true);
    expect((await noop.client.callTool({ name: "own", arguments: { v: "text" } })).isError).toBe(true);
    const retyped = await connect({ subject: "authenticated-client" }, { id: "retyped", version: "1", matches: () => true,
      projectCatalog: ({ tools }) => tools.map(tool => ({ ...tool, inputSchema: schema("boolean") })),
    }, registry);
    await expect(retyped.client.listTools()).rejects.toThrow(/canonical schema/);
  });

  // The runtime compiles an anonymous tool with base "", where a dot-segment
  // reference names that tool itself.
  it.each(["./#/definitions/query", ".#/definitions/query", "../#/definitions/query"])("lists and calls an anonymous tool that references itself through %s", async (reference) => {
    const registry = new McpFnRegistry<RequestContext>().register({ name: "search", description: "Search", handler: async () => structuredResult({ ok: true }),
      inputSchema: { type: "object", properties: { query: { $ref: reference } }, required: ["query"], definitions: { query: { type: "string" } } } });
    const { client } = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["search"]);
    expect((await client.callTool({ name: "search", arguments: { query: "text" } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "search", arguments: { query: 1 } })).isError).toBe(true);
  });

  // Ajv caches compiled schemas by object: registering the declaring schema
  // object again leaves the runtime's "" entry on the schema compiled between.
  it.each([false, true])("lists and calls a named consumer of the anonymous entry after a reused schema object (reversed %s)", async (reversed) => {
    const handler = async () => structuredResult({ ok: true });
    const declaring = { type: "object" as const, definitions: { inner: { $id: "nested", type: "string" } } };
    const between = { type: "object" as const, definitions: { inner: { type: "number" } } };
    const [first, second] = reversed ? [between, declaring] : [declaring, between];
    const registry = new McpFnRegistry<RequestContext>()
      .register({ name: "first", description: "First", inputSchema: first, handler })
      .register({ name: "second", description: "Second", inputSchema: second, handler })
      .register({ name: "again", description: "Again", inputSchema: first, handler })
      .register({ name: "consumer", description: "Consumer", inputSchema: { $id: "shared", type: "object", properties: { value: { $ref: "nested" } }, required: ["value"] }, handler });
    const { client } = await connect({ subject: "authenticated-client" }, { id: "noop", version: "1", matches: () => true }, registry);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["again", "consumer", "first", "second"]);
    const [valid, invalid] = reversed ? ["text", 1] : [1, "text"];
    expect((await client.callTool({ name: "consumer", arguments: { value: valid } })).isError).not.toBe(true);
    expect((await client.callTool({ name: "consumer", arguments: { value: invalid } })).isError).toBe(true);
  });

  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      closeables.splice(0).map((value) => value.close().catch(() => undefined)),
    );
  });

  async function connect(
    context: RequestContext,
    profile: McpFnClientProfile<RequestContext>,
    registry: McpFnRegistry<RequestContext>,
    clientName = "reported-client",
    evidence?: (event: McpFnClientProfileEvidence) => void,
    unmatchedServerOwnedArguments?: "reject" | "allow",
  ) {
    const server = createMcpFnServer({
      info: { name: "profile-server", version: "1.0.0" },
      registry,
      context: () => context,
      clientProfiles: {
        profiles: [profile],
        evidence,
        unmatchedServerOwnedArguments,
        resolveVerifiedIdentity: ({ context: trusted }) =>
          trusted.subject ? { subject: trusted.subject } : undefined,
      },
    });
    const client = new Client(
      { name: clientName, version: "9.9.9" },
      { capabilities: { roots: { listChanged: true } } },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    return { client, server };
  }

  function tenantProfile(
    observeReportedClient: (name: string | undefined) => void = () => undefined,
  ): McpFnClientProfile<RequestContext> {
    return {
      id: "consumer/trusted",
      version: "1",
      matches: ({ subject }) => subject === "authenticated-client",
      serverOwnedArguments: { lookup: ["tenantId"] },
      projectCatalog: ({ tools, reportedClient }) => {
        observeReportedClient(reportedClient.info?.name);
        return tools.map((tool) => {
          if (tool.name !== "lookup") return tool;
          const { tenantId: _tenantId, ...properties } =
            tool.inputSchema.properties ?? {};
          return {
            ...tool,
            inputSchema: {
              ...tool.inputSchema,
              properties,
              required: tool.inputSchema.required?.filter(
                (name) => name !== "tenantId",
              ),
            },
          };
        });
      },
      enrichArguments: ({ arguments: args, context }) =>
        context.tenantId ? { ...args, tenantId: context.tenantId } : args,
    };
  }

  function lookupRegistry(
    handler = vi.fn(async (args: Record<string, unknown>) =>
      structuredResult(args),
    ),
  ) {
    return {
      handler,
      registry: new McpFnRegistry<RequestContext>().register({
        name: "lookup",
        description: "Look up a value in the authenticated tenant.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            tenantId: { type: "string" },
          },
          required: ["query", "tenantId"],
          additionalProperties: false,
        },
        handler,
      }),
    };
  }

  it("projects and enriches one authenticated production lifecycle", async () => {
    const reported = vi.fn();
    const { registry, handler } = lookupRegistry();
    const { client } = await connect(
      { subject: "authenticated-client", tenantId: "trusted-tenant" },
      tenantProfile(reported),
      registry,
    );

    const listed = await client.listTools();
    expect(listed.tools[0]?.inputSchema).toMatchObject({
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(listed.tools[0]?.inputSchema.properties).not.toHaveProperty(
      "tenantId",
    );
    await expect(
      client.callTool({
        name: "lookup",
        arguments: { query: "safe" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { query: "safe", tenantId: "trusted-tenant" },
    });
    expect(handler).toHaveBeenCalledWith(
      { query: "safe", tenantId: "trusted-tenant" },
      expect.objectContaining({ subject: "authenticated-client" }),
      expect.anything(),
    );
    expect(reported).toHaveBeenCalledWith("reported-client");
  });

  // Audit MCP-SEC-01: a client that matches no profile must not choose a
  // server-owned value (a tenant) just by not matching.
  it.each([
    ["an identity no profile matches", { subject: "generic-client" }],
    ["no verified identity", {}],
  ])("hides and refuses tools with server-owned arguments for a client with %s", async (_label, context) => {
    const { registry, handler } = lookupRegistry();
    const { client } = await connect(context, tenantProfile(), registry);
    expect((await client.listTools()).tools).toEqual([]);
    await expect(client.callTool({
      name: "lookup",
      arguments: { query: "safe", tenantId: "model-value" },
    })).rejects.toThrow(/Tool lookup not found/);
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects server-owned arguments of unmatched calls passed straight to enrichment", async () => {
    await expect(enrichMcpFnClientProfileCall({
      resolved: { context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {} },
      tool: { name: "lookup", description: "Lookup", inputSchema: { type: "object" } },
      arguments: { query: "safe", tenantId: "model-value" },
      clientProfiles: { profiles: [tenantProfile() as McpFnClientProfile<undefined>] },
    })).rejects.toMatchObject({ code: "MCPFN_FORGED_SERVER_ARGUMENT" });
  });

  it("reports tools hidden from an unmatched client as removed catalog changes", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const lookup = { name: "lookup", inputSchema: { type: "object" as const, properties: { tenantId: { type: "string" } }, required: ["tenantId"] } };
    const other = { name: "other", inputSchema: { type: "object" as const } };
    const result = await buildMcpFnEffectiveCatalog({
      canonicalTools: [lookup, other],
      resolved: { context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {} },
      clientProfiles: { profiles: [tenantProfile() as McpFnClientProfile<undefined>] },
    });
    expect(result.tools.map((tool) => tool.name)).toEqual(["other"]);
    expect(result.changes).toEqual([
      { kind: "removed", path: "tools.lookup", tool: "lookup", beforeHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it("keeps the McpFn code and JSON-safe details in task-augmented enrichment errors", async () => {
    const registry = new McpFnRegistry<RequestContext>().register({
      name: "lookup",
      description: "Look up a value in the authenticated tenant.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tenantId: { type: "string" } }, required: ["query", "tenantId"], additionalProperties: false },
      execution: { taskSupport: "optional" },
      handler: async (args) => structuredResult(args),
      taskHandler: { createTask: vi.fn(), getTask: vi.fn(), getTaskResult: vi.fn() } as never,
    });
    const profile = { ...tenantProfile(), enrichArguments: () => { throw new McpFnError("TENANT_LOOKUP_FAILED", "Tenant lookup failed", { code: "upstream-503", attempts: 2n, toJSON: () => ({ code: "upstream-503", attempts: "2", lifecycleStage: "handler" }) }); } };
    const server = createMcpFnServer({
      info: { name: "profile-server", version: "1.0.0" },
      registry,
      context: () => ({ subject: "authenticated-client", tenantId: "trusted-tenant" }),
      taskStore: new InMemoryTaskStore(),
      clientProfiles: { profiles: [profile], resolveVerifiedIdentity: ({ context: trusted }) => trusted.subject ? { subject: trusted.subject } : undefined },
    });
    const client = new Client({ name: "reported-client", version: "9.9.9" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    const error = await client.request(
      { method: "tools/call", params: { name: "lookup", arguments: { query: "safe" }, task: { ttl: 60_000 } } },
      CreateTaskResultSchema,
    ).then(() => undefined, (failure: unknown) => failure);
    expect(error).toMatchObject({
      code: ErrorCode.InternalError,
      data: { code: "TENANT_LOOKUP_FAILED", attempts: "2", lifecycleStage: "argument-enrichment", profile: { id: "consumer/trusted", version: "1" } },
    });
  });

  it.each([null, ["array"]])("treats an enricher returning %j as a server fault", async (returned) => {
    await expect(enrichMcpFnClientProfileCall({
      resolved: { context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" }, profile: { id: "p", version: "1", matches: () => true, enrichArguments: () => returned as never } },
      tool: { name: "lookup", description: "Lookup", inputSchema: { type: "object" } },
      arguments: { query: "safe" },
    })).rejects.toMatchObject({ code: "MCPFN_PROFILE_ARGUMENT_MUTATION" });
  });

  it("carries the unmatched-client policy through the public helper pipeline", async () => {
    const { buildMcpFnEffectiveCatalog, resolveMcpFnClientProfile } = await import("../src/client-profiles.js");
    const resolved = await resolveMcpFnClientProfile(
      { profiles: [tenantProfile() as McpFnClientProfile<undefined>], resolveVerifiedIdentity: () => ({ subject: "generic-client" }) },
      { context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {} },
    );
    const lookup = { name: "lookup", description: "Lookup", inputSchema: { type: "object" as const, properties: { tenantId: { type: "string" } }, required: ["tenantId"] } };
    expect((await buildMcpFnEffectiveCatalog({ canonicalTools: [lookup], resolved })).tools).toEqual([]);
    await expect(enrichMcpFnClientProfileCall({ resolved, tool: lookup, arguments: { tenantId: "model-value" } }))
      .rejects.toMatchObject({ code: "MCPFN_FORGED_SERVER_ARGUMENT" });
  });

  it.each([[["first", "second"]], ["scalar detail"], [42]])("keeps non-object enrichment details %j under data.details", async (details) => {
    const registry = new McpFnRegistry<RequestContext>().register({
      name: "lookup",
      description: "Look up a value in the authenticated tenant.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tenantId: { type: "string" } }, required: ["query", "tenantId"], additionalProperties: false },
      execution: { taskSupport: "optional" },
      handler: async (args) => structuredResult(args),
      taskHandler: { createTask: vi.fn(), getTask: vi.fn(), getTaskResult: vi.fn() } as never,
    });
    const profile = { ...tenantProfile(), enrichArguments: () => { throw new McpFnError("TENANT_LOOKUP_FAILED", "Tenant lookup failed", details); } };
    const server = createMcpFnServer({
      info: { name: "profile-server", version: "1.0.0" },
      registry,
      context: () => ({ subject: "authenticated-client", tenantId: "trusted-tenant" }),
      taskStore: new InMemoryTaskStore(),
      clientProfiles: { profiles: [profile], resolveVerifiedIdentity: ({ context: trusted }) => trusted.subject ? { subject: trusted.subject } : undefined },
    });
    const client = new Client({ name: "reported-client", version: "9.9.9" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    const error = await client.request(
      { method: "tools/call", params: { name: "lookup", arguments: { query: "safe" }, task: { ttl: 60_000 } } },
      CreateTaskResultSchema,
    ).then(() => undefined, (failure: unknown) => failure);
    expect(error).toMatchObject({ data: { code: "TENANT_LOOKUP_FAILED", details } });
  });

  it("answers a forged server-owned argument in a task-augmented call with InvalidParams", async () => {
    const createTask = vi.fn();
    const registry = new McpFnRegistry<RequestContext>().register({
      name: "lookup",
      description: "Look up a value in the authenticated tenant.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, tenantId: { type: "string" } }, required: ["query", "tenantId"], additionalProperties: false },
      execution: { taskSupport: "optional" },
      handler: async (args) => structuredResult(args),
      taskHandler: { createTask, getTask: vi.fn(), getTaskResult: vi.fn() } as never,
    });
    const server = createMcpFnServer({
      info: { name: "profile-server", version: "1.0.0" },
      registry,
      context: () => ({ subject: "authenticated-client", tenantId: "trusted-tenant" }),
      taskStore: new InMemoryTaskStore(),
      clientProfiles: {
        profiles: [tenantProfile()],
        resolveVerifiedIdentity: ({ context: trusted }) => trusted.subject ? { subject: trusted.subject } : undefined,
      },
    });
    const client = new Client({ name: "reported-client", version: "9.9.9" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    const error = await client.request(
      { method: "tools/call", params: { name: "lookup", arguments: { query: "safe", tenantId: "model-value" }, task: { ttl: 60_000 } } },
      CreateTaskResultSchema,
    ).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: ErrorCode.InvalidParams,
      data: { code: "MCPFN_FORGED_SERVER_ARGUMENT", rejectedProperty: "tenantId", lifecycleStage: "argument-enrichment" },
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("keeps generic calls canonical when unmatchedServerOwnedArguments is allow", async () => {
    const { registry } = lookupRegistry();
    const { client } = await connect(
      { subject: "generic-client" },
      tenantProfile(),
      registry,
      undefined,
      undefined,
      "allow",
    );
    await expect(
      client.callTool({
        name: "lookup",
        arguments: { query: "safe", tenantId: "model-value" },
      }),
    ).resolves.toMatchObject({
      structuredContent: { query: "safe", tenantId: "model-value" },
    });
  });

  it("leaves unmatched calls to tools without server-owned arguments unchanged", async () => {
    const handler = vi.fn(async (args: Record<string, unknown>) => structuredResult(args));
    const registry = new McpFnRegistry<RequestContext>().register({
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] },
      handler,
    });
    const { client } = await connect({ subject: "generic-client" }, tenantProfile(), registry);
    await expect(
      client.callTool({ name: "echo", arguments: { tenantId: "model-value" } }),
    ).resolves.toMatchObject({ structuredContent: { tenantId: "model-value" } });
  });

  it("rejects an unknown unmatchedServerOwnedArguments policy", () => {
    expect(() => createMcpFnServer({
      info: { name: "profile-server", version: "1.0.0" },
      registry: lookupRegistry().registry,
      clientProfiles: {
        profiles: [tenantProfile()],
        resolveVerifiedIdentity: () => undefined,
        unmatchedServerOwnedArguments: "canonical" as never,
      },
    })).toThrow(/unmatchedServerOwnedArguments/);
  });

  it("forwards non-object generic arguments to canonical validation", async () => {
    const argumentsValue = ["invalid"];
    expect(await enrichMcpFnClientProfileCall({
      resolved: { context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {} },
      tool: { name: "lookup", description: "Lookup", inputSchema: { type: "object" } },
      arguments: argumentsValue,
    })).toBe(argumentsValue);
  });

  it("fails forged and missing server-owned arguments before the handler", async () => {
    const first = lookupRegistry();
    const forged = await connect(
      { subject: "authenticated-client", tenantId: "trusted-tenant" },
      tenantProfile(),
      first.registry,
    );
    const forgedResult = await forged.client.callTool({
      name: "lookup",
      arguments: { query: "safe", tenantId: "forged" },
    });
    expect(forgedResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "MCPFN_FORGED_SERVER_ARGUMENT",
          details: {
            lifecycleStage: "argument-enrichment",
            rejectedProperty: "tenantId",
          },
        },
      },
    });
    expect(first.handler).not.toHaveBeenCalled();

    const second = lookupRegistry();
    const missing = await connect(
      { subject: "authenticated-client" },
      tenantProfile(),
      second.registry,
    );
    const missingResult = await missing.client.callTool({
      name: "lookup",
      arguments: { query: "safe" },
    });
    expect(missingResult).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "MCPFN_MISSING_TRUSTED_CONTEXT",
          details: { lifecycleStage: "argument-enrichment" },
        },
      },
    });
    expect(second.handler).not.toHaveBeenCalled();
  });

  it("rejects projection/enrichment asymmetry while listing", async () => {
    const { registry } = lookupRegistry();
    const asymmetric: McpFnClientProfile<RequestContext> = {
      id: "consumer/asymmetric",
      version: "1",
      matches: () => true,
      projectCatalog: ({ tools }) =>
        tools.map((tool) => ({
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        })),
    };
    const { client } = await connect(
      { subject: "authenticated-client" },
      asymmetric,
      registry,
    );
    await expect(client.listTools()).rejects.toThrow(
      /without trusted enrichment/,
    );
  });

  it("rejects invented and duplicate projected tools", async () => {
    const inventedRegistry = lookupRegistry();
    const invented = await connect(
      { subject: "authenticated-client" },
      {
        id: "consumer/invented",
        version: "1",
        matches: () => true,
        projectCatalog: ({ tools }) => [
          ...tools,
          { ...tools[0]!, name: "invented" },
        ],
      },
      inventedRegistry.registry,
    );
    await expect(invented.client.listTools()).rejects.toThrow(/unknown tool/);

    const duplicateRegistry = lookupRegistry();
    const duplicate = await connect(
      { subject: "authenticated-client" },
      {
        id: "consumer/duplicate",
        version: "1",
        matches: () => true,
        projectCatalog: ({ tools }) => [tools[0]!, tools[0]!],
      },
      duplicateRegistry.registry,
    );
    await expect(duplicate.client.listTools()).rejects.toThrow(
      /duplicate tool/,
    );
  });

  it("applies canonical visibility before projection and preserves call symmetry", async () => {
    const hidden = {
      name: "hidden",
      description: "Hidden.",
      inputSchema: {
        type: "object" as const,
        properties: { tenantId: { type: "string" } },
        required: ["tenantId"],
        additionalProperties: false,
      },
      handler: async () => structuredResult({ ok: true }),
    };
    const visible = lookupRegistry();
    visible.registry.register(hidden);
    const configured = tenantProfile();
    configured.serverOwnedArguments = {
      ...configured.serverOwnedArguments,
      hidden: ["tenantId"],
    };
    const order: string[] = [];
    const server = createMcpFnServer({
      info: { name: "visibility-profile", version: "1.0.0" },
      registry: visible.registry,
      context: () => ({ subject: "authenticated-client", tenantId: "trusted" }),
      toolVisibility: ({ tool }) => { order.push(`visibility:${tool.name}`); return tool.name !== "hidden"; },
      clientProfiles: {
        profiles: [configured],
        resolveVerifiedIdentity: ({ context }) => { order.push("identity"); return { subject: context.subject! }; },
      },
    });
    const client = new Client(
      { name: "visibility-client", version: "1.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual([
      "lookup",
    ]);
    expect(order[0]).toBe("identity");
    expect(order.slice(1)).toEqual(expect.arrayContaining(["visibility:hidden", "visibility:lookup"]));
    const beforeCall = order.length;
    await expect(
      client.callTool({ name: "hidden", arguments: {} }),
    ).rejects.toThrow(/not found/);
    expect(order[beforeCall]).toBe("identity");
  });

  it.each([false, true])("reports invalid input even when recovery throws: %s", async (throws) => {
    const evidence: McpFnClientProfileEvidence[] = [];
    const registry = new McpFnRegistry<RequestContext>().register({ name: "recover", description: "Recover invalid input", inputSchema: { type: "object", required: ["value"] },
      handleInvalidArguments: () => { if (throws) throw new Error("recovery failed"); return structuredResult({ recovered: true }); }, handler: async () => structuredResult({ recovered: false }) });
    const { client } = await connect({ subject: "trusted" }, { id: "test", version: "1", matches: () => true }, registry, "client", event => { evidence.push(event); });
    await client.callTool({ name: "recover", arguments: {} });
    expect(evidence).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "input-validation", outcome: "failed" }), expect.objectContaining({ stage: "invalid-arguments-handler", outcome: throws ? "failed" : "succeeded" })]));
    expect(evidence.some(event => event.stage === "handler")).toBe(false);
  });

  it("keeps validation responses independent from evidence mutation", async () => {
    let mutatedIssues = false;
    const registry = new McpFnRegistry<RequestContext>().register({ name: "strict", description: "Strict", inputSchema: { type: "object", additionalProperties: false }, handler: async () => structuredResult({}) });
    const { client } = await connect({ subject: "trusted" }, { id: "test", version: "1", matches: () => true }, registry, "client", event => { if (event.issues?.length) { mutatedIssues = true; event.issues.splice(0); } });
    const result = await client.callTool({ name: "strict", arguments: { unexpected: true } });
    expect(mutatedIssues).toBe(true);
    expect(JSON.stringify(result)).toContain("additionalProperties");
  });

  it("retains exact structured Ajv diagnostics without rejected values", async () => {
    const captured = vi.fn();
    const registry = new McpFnRegistry().register({
      name: "strict",
      description: "Strict input.",
      inputSchema: {
        type: "object",
        properties: {
          nested: { type: "object", properties: { count: { type: "number" } } },
        },
        additionalProperties: false,
      },
      handleInvalidArguments: async (_args, issues) => {
        captured(issues);
        return structuredResult({ issues });
      },
      handler: async () => structuredResult({ ok: true }),
    });
    await registry.callTool(
      "strict",
      { secretUnexpected: "must-not-leak" },
      undefined,
      {} as never,
    );
    expect(captured).toHaveBeenCalledWith([
      {
        path: "/",
        instancePath: "/",
        schemaPath: "#/additionalProperties",
        keyword: "additionalProperties",
        message: "must NOT have additional properties",
        rejectedProperty: "secretUnexpected",
      },
    ]);
    expect(JSON.stringify(captured.mock.calls)).not.toContain("must-not-leak");
  });

  it("attributes handler failures to the handler lifecycle stage", async () => {
    const registry = new McpFnRegistry<RequestContext>().register({
      name: "fails",
      description: "Fail inside the handler.",
      inputSchema: { type: "object", additionalProperties: false },
      handler: async () => {
        throw new McpFnValidationError("Domain validation failed");
      },
    });
    const { client } = await connect(
      { subject: "generic" },
      tenantProfile(),
      registry,
    );
    await expect(
      client.callTool({ name: "fails", arguments: {} }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: { details: { lifecycleStage: "handler" } },
      },
    });
  });
  it("rejects a projected type incompatible with canonical validation", async () => {
    const { registry } = lookupRegistry();
    const bad = tenantProfile();
    const project = bad.projectCatalog!;
    bad.projectCatalog = async (input) => (await project(input)).map(tool => ({
      ...tool, inputSchema: { ...tool.inputSchema, properties: { query: { type: "number" } } },
    }));
    const { client } = await connect({ subject: "authenticated-client", tenantId: "trusted" }, bad, registry);
    await expect(client.listTools()).rejects.toThrow(/canonical schema/);
  });

  it.each([[null], ["tenantId"], [["tenantId", "tenantId"]], [[42]], [["__proto__"]]])(
    "rejects malformed ownership declarations: %j", (value) => {
      const bad = tenantProfile();
      bad.serverOwnedArguments = { lookup: value } as never;
      expect(() => createMcpFnServer({
        info: { name: "bad", version: "1" }, registry: lookupRegistry().registry,
        context: () => ({}), clientProfiles: { profiles: [bad], resolveVerifiedIdentity: () => undefined },
      })).toThrow();
    },
  );

  it("requires sessions for hooks that consume initialization metadata", async () => {
    const server = createMcpFnServer({
      info: { name: "http-profile", version: "1" }, registry: lookupRegistry().registry,
      context: () => ({}), clientProfiles: { profiles: [tenantProfile()], resolveVerifiedIdentity: () => undefined },
    });
    await expect(server.createWebStandardHandler()).rejects.toThrow(/session/i);
    closeables.push(server);
  });

  it("bounds long rejected property names", async () => {
    const { client } = await connect({ subject: "generic" }, tenantProfile(), lookupRegistry().registry, undefined, undefined, "allow");
    const unknown = "unexpected".repeat(50);
    const result = await client.callTool({ name: "lookup", arguments: { query: "ok", tenantId: "ok", [unknown]: "secret" } });
    expect(JSON.stringify(result)).toContain(unknown.slice(0, 256));
    expect(JSON.stringify(result)).not.toContain(unknown);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("omits handler-supplied issue payloads from evidence", async () => {
    const events: McpFnClientProfileEvidence[] = [];
    const { registry } = lookupRegistry(vi.fn(async () => {
      throw new McpFnError("secret-input".repeat(10000), "secret-input", { issues: [{ message: "secret-input" }] });
    }));
    const { client } = await connect({ subject: "generic" }, tenantProfile(), registry, "reported", event => { events.push(event); }, "allow");
    await client.callTool({ name: "lookup", arguments: { query: "ok", tenantId: "ok" } });
    expect(events.filter(e => e.stage === "handler" && e.outcome === "failed")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("secret-input");
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ stage: "input-validation", outcome: "succeeded" })]));
  });

  it.each(["domain detail", ["domain", 1], 42, null])("preserves non-object domain error details: %j", async details => {
    const { registry } = lookupRegistry(vi.fn(async () => { throw new McpFnError("DOMAIN_ERROR", "Domain failure", details); }));
    const { client } = await connect({ subject: "generic" }, tenantProfile(), registry, undefined, undefined, "allow");
    const result = await client.callTool({ name: "lookup", arguments: { query: "ok", tenantId: "ok" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { details } });
  });

  it("reports validation when a delayed task result is stored", async () => {
    let finish!: () => Promise<unknown>;
    const stored = vi.fn();
    const outcome = vi.fn();
    const stages = vi.fn();
    const registry = new McpFnRegistry().register({
      name: "delayed", description: "Delayed result", inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
      execution: { taskSupport: "required" }, handler: async () => structuredResult({ value: "ok" }),
      taskHandler: { createTask: async (_args, _context, extra) => {
        finish = () => extra.taskStore.storeTaskResult("task", "completed", structuredResult({ value: 42 }));
        return { task: { taskId: "task", status: "working", createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: null } };
      } },
    });
    await registry.createToolTask("delayed", {}, undefined, { taskStore: { storeTaskResult: stored } } as unknown as McpFnTaskRequestExtra, { onStage: stages, onTaskOutput: outcome });
    expect(outcome).not.toHaveBeenCalled();
    await expect(finish()).rejects.toThrow(/Invalid output/);
    expect(stages).toHaveBeenCalledWith("output-validation");
    expect(stages).toHaveBeenLastCalledWith("handler");
    expect(outcome).toHaveBeenCalledWith("failed", expect.any(Error));
    expect(stored).not.toHaveBeenCalled();
  });

});

describe("projected contract boundaries", () => {
  it.each(["additionalProperties", "minProperties", "outputSchema", "taskSupport"])("rejects changed %s", async (change) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const tool = { name: "test", description: "test", inputSchema: { type: "object" as const, properties: {}, additionalProperties: false } };
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [tool], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true, projectCatalog: ({ tools }) => tools.map((entry) => ({ ...entry,
        ...(change === "outputSchema" ? { outputSchema: { type: "object" as const } } :
          change === "taskSupport" ? { execution: { taskSupport: "required" as const } } :
          { inputSchema: { ...entry.inputSchema, [change]: change === "additionalProperties" ? true : 2 } }),
      })) },
    } })).rejects.toThrow(/preserve root constraints/);
  });

  it("accepts an unchanged local root reference", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: { type: "object", $ref: "#" } }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true },
    } })).resolves.toMatchObject({ changes: [] });
  });

  it("persists failed task results without applying success output requirements", async () => {
    const stored = vi.fn();
    const registry = new McpFnRegistry().register({ name: "task", description: "test", inputSchema: { type: "object" },
      outputSchema: { type: "object", required: ["answer"] }, execution: { taskSupport: "required" },
      handler: async () => structuredResult({ answer: true }),
      taskHandler: { createTask: async (_args, _context, extra) => {
        await extra.taskStore.storeTaskResult("task:1", "failed", { content: [{ type: "text", text: "Failed" }] });
        return { task: { taskId: "task:1", status: "failed", createdAt: new Date().toISOString(), lastUpdatedAt: new Date().toISOString(), ttl: null } };
      } },
    });
    await registry.createToolTask("task", {}, undefined, { taskStore: { storeTaskResult: stored } } as unknown as McpFnTaskRequestExtra);
    expect(stored).toHaveBeenCalledWith("task:1", "failed", expect.objectContaining({ isError: true }));
  });
});


describe("optional projected tool metadata", () => {
  it.each([false, true])("treats forbidden task support as the default (%s)", async (explicit) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const tool = { name: "test", inputSchema: { type: "object" as const }, ...(explicit ? { execution: { taskSupport: "forbidden" as const } } : {}) };
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [tool], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true, projectCatalog: ({ tools }) => tools.map(({ execution, ...entry }) => ({ ...entry, ...(!explicit ? { execution: { taskSupport: "forbidden" as const } } : {}) })) },
    } })).resolves.toBeDefined();
  });
  it("rejects a null projected output schema when the canonical schema is absent", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: { type: "object" } }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true, projectCatalog: ({ tools }) => tools.map((tool) => ({ ...tool, outputSchema: null as any })) },
    } })).rejects.toThrow(/MCP tool definitions/);
  });
});

describe("reference and ownership projection safety", () => {
  async function project(inputSchema: any, projected: any, execution?: any) {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    return buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true,
        serverOwnedArguments: { test: ["tenantId"] }, enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: "trusted" }),
        projectCatalog: () => [{ name: "test", inputSchema: projected, ...(execution === undefined ? {} : { execution }) }],
      },
    } });
  }
  const canonical = { type: "object", additionalProperties: false, properties: { tenantId: { type: "string" }, query: { type: "string" } }, required: ["tenantId"] };
  const visible = { type: "object", additionalProperties: false, properties: { query: { type: "string" } } };
  it.each(["dependencies", "dependentRequired"])("rejects owned-field %s even when copied unchanged", async keyword => {
    const constraint = { [keyword]: { tenantId: ["query"] } };
    await expect(project({ ...canonical, ...constraint }, { ...visible, ...constraint })).rejects.toThrow(/whole-object constraints/);
  });
  it("allows ownership projection inside local root definitions", async () => {
    await expect(project({ type: "object", $ref: "#/$defs/input", $defs: { input: canonical } },
      { type: "object", $ref: "#/$defs/input", $defs: { input: visible } })).resolves.toBeDefined();
  });
  it("accepts reordered allOf branches without moving constraints", async () => {
    const branches = [{ properties: { a: { type: "string" } }, additionalProperties: false }, { properties: { b: { type: "string" } } }];
    await expect(project({ ...canonical, allOf: branches }, { ...visible, allOf: [...branches].reverse() })).resolves.toBeDefined();
  });
  it("preserves allOf constraint ownership", async () => {
    const branches = [{ properties: { a: { type: "string" } }, additionalProperties: false }, { properties: { b: { type: "string" } } }];
    await expect(project({ ...canonical, allOf: branches }, { ...visible, allOf: [
      { properties: branches[0].properties }, { ...branches[1], additionalProperties: false },
    ] })).rejects.toThrow(/preserve root constraints/);
  });
  it("resolves percent-encoded definition names", async () => {
    await expect(project({ type: "object", $ref: "#/$defs/first%20name", $defs: { "first name": canonical } },
      { type: "object", $ref: "#/$defs/first%20name", $defs: { "first name": visible } })).resolves.toBeDefined();
  });
  it("keeps recursive fragments inside their embedded resource", async () => {
    const child = { $id: "https://example.test/child", type: "object", properties: { next: { $ref: "#" } } };
    await expect(project({ ...canonical, properties: { ...canonical.properties, child } },
      { ...visible, properties: { ...visible.properties, child } })).resolves.toBeDefined();
  });
  it("rejects a changed referenced model-owned property", async () => {
    await expect(project({ ...canonical, properties: { ...canonical.properties, query: { $ref: "#/$defs/query" } }, $defs: { query: { type: "string" } } },
      { ...visible, properties: { query: { $ref: "#/$defs/query" } }, $defs: { query: { type: "number" } } })).rejects.toThrow(/canonical schema/);
  });
  it.each([[null], [{ taskSupport: null }]])("rejects null execution metadata %j", async execution => {
    await expect(project(canonical, visible, execution)).rejects.toThrow(/MCP tool definitions/);
  });
});

it.each(['optional', 'root-ref', 'const', 'enum'])('rejects asymmetric projection %s', async kind => {
  const { buildMcpFnEffectiveCatalog } = await import('../src/client-profiles.js');
  const inputSchema: any = { type: 'object', properties: { tenantId: { type: 'string' }, query: kind === 'root-ref' ? { $ref: '#' } : { type: 'string' } }, required: ['tenantId'], additionalProperties: false };
  if (kind === 'const') inputSchema.const = { tenantId: 'trusted' };
  if (kind === 'enum') inputSchema.enum = [{ tenantId: 'trusted' }];
  const visible = { ...inputSchema, properties: kind === 'optional' ? {} : { query: inputSchema.properties.query }, required: [] };
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: 'test', inputSchema }], resolved: { context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: 'trusted' }, profile: { id: 'test', version: '1', matches: () => true, serverOwnedArguments: { test: ['tenantId'] }, enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: 'trusted' }), projectCatalog: () => [{ name: 'test', inputSchema: visible }] } } })).rejects.toThrow();
});
it('preserves an unchanged recursive property schema', async () => {
  const { buildMcpFnEffectiveCatalog } = await import('../src/client-profiles.js');
  const tool: any = { name: 'test', inputSchema: { type: 'object', properties: { child: { $ref: '#' } } } };
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [tool], resolved: { context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: 'trusted' }, profile: { id: 'test', version: '1', matches: () => true } } })).resolves.toMatchObject({ changes: [] });
});

it("accepts unchanged required keys without property declarations", async () => {
  const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: { type: "object", required: ["token"] } }], resolved: {
    context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" }, profile: { id: "test", version: "1", matches: () => true },
  } })).resolves.toMatchObject({ changes: [] });
});


it("rejects open ownership projections and malformed unused definitions", async () => {
  const { buildMcpFnEffectiveCatalog } = await import('../src/client-profiles.js');
  for (const patternProperties of [undefined, { '^tenant': {} }]) {
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: 'test', inputSchema: { type: 'object', properties: { tenantId: { type: 'string' } }, required: ['tenantId'], ...(patternProperties ? { patternProperties } : {}) } }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: 'trusted' },
      profile: { id: 'test', version: '1', matches: () => true, serverOwnedArguments: { test: ['tenantId'] },
        projectCatalog: () => [{ name: 'test', inputSchema: { type: 'object', ...(patternProperties ? { patternProperties } : {}) } }] },
    } })).rejects.toThrow(/model-visible/);
  }
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: 'test', inputSchema: { type: 'object' } }], resolved: {
    context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: 'trusted' },
    profile: { id: 'test', version: '1', matches: () => true, projectCatalog: () => [{ name: 'test', inputSchema: { type: 'object', $defs: { unused: { type: 123 } } } as any }] },
  } })).rejects.toThrow(/valid JSON Schema/);
});

it("compares boolean and embedded-resource schemas and equivalent branch references", async () => {
  const { buildMcpFnEffectiveCatalog } = await import('../src/client-profiles.js');
  const run = (before: any, after: any, name = 'test') => buildMcpFnEffectiveCatalog({ canonicalTools: [{ name, inputSchema: before }], resolved: {
    context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: 'trusted' },
    profile: { id: 'test', version: '1', matches: () => true, serverOwnedArguments: {}, projectCatalog: () => [{ name, inputSchema: after }] },
  } });
  await expect(run({ type: 'object', allOf: [true] }, { type: 'object', allOf: [false] })).rejects.toThrow(/preserve root constraints/);
  const schema = (type: string) => ({ type: 'object', properties: { value: { $ref: 'https://example.test/value' } }, $defs: { value: { $id: 'https://example.test/value', type } } });
  await expect(run(schema('string'), schema('number'))).rejects.toThrow(/canonical schema/);
  const defs = { a: { properties: { a: { type: 'string' } } }, z: { properties: { z: { type: 'string' } } } };
  await expect(run({ type: 'object', $defs: defs, allOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/z' }] },
    { type: 'object', $defs: defs, allOf: [{ $ref: '#/$defs/z' }, { $ref: '#/$defs/%61' }] })).resolves.toBeDefined();
  for (const name of ['constructor', 'toString', '__proto__']) await expect(run({ type: 'object' }, { type: 'object' }, name)).resolves.toBeDefined();
});

it("marks invalid-argument callbacks as handlers and bounds diagnostic paths", async () => {
  const { formatMcpFnSchemaIssues } = await import('../src/validation.js');
  const issue = formatMcpFnSchemaIssues([{ instancePath: '/' + 'x'.repeat(1000), schemaPath: '#/' + 'x'.repeat(1000), keyword: 'type', params: {}, message: 'bad' }])[0];
  expect(issue.instancePath).toBe('/');
  expect(issue.schemaPath).toBe('#');
  expect(issue.truncated).toBe(true);
  const stages: string[] = [];
  const registry = new McpFnRegistry().register({ name: 'test', description: 'Test validation observer', inputSchema: { type: 'object', required: ['value'] },
    handleInvalidArguments: () => { throw new McpFnValidationError('private', { issues: [{ secret: 'private' }] }); },
    handler: async () => structuredResult({}) });
  await expect(registry.callTool('test', {}, undefined, {} as any, { onStage: stage => stages.push(stage) })).rejects.toThrow('private');
  expect(stages.at(-1)).toBe('invalid-arguments-handler');
});

it("accepts embedded root references, modern dialects and literal ref data", async () => {
  const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
  for (const schema of [
    { type: "object", $defs: { payload: { $id: "payload", type: "object", properties: { value: { type: "string" } } } }, $ref: "payload" },
    { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { values: { type: "array", prefixItems: [{ type: "string" }] } } },
    { type: "object", properties: { value: { const: { $ref: "literal-not-schema" }, default: { $id: "data-id", $ref: "literal" } } } },
  ]) {
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: schema }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true, projectCatalog: () => [{ name: "test", inputSchema: schema }] },
    } })).resolves.toBeDefined();
  }
});

it("normalizes invalid ownership pattern failures", async () => {
  const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: { type: "object", properties: { tenant: { type: "string" } }, required: ["tenant"] } }], resolved: {
    context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
    profile: { id: "test", version: "1", matches: () => true, serverOwnedArguments: { test: ["tenant"] }, projectCatalog: () => [{ name: "test", inputSchema: { type: "object", additionalProperties: false, patternProperties: { "[": {} } } }] },
  } })).rejects.toMatchObject({ code: "MCPFN_INVALID_PROJECTED_CATALOG" });
});

it("resolves named anchors and rejects unsupported dynamic projection references", async () => {
  const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
  const run = (before: any, after = before) => buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: before }], resolved: { context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" }, profile: { id: "test", version: "1", matches: () => true, projectCatalog: () => [{ name: "test", inputSchema: after }] } } });
  await expect(run({ $schema: "http://json-schema.org/draft-07/schema#", type: "object", definitions: { node: { $id: "#node", type: "string" } }, properties: { value: { $ref: "#node" } } })).resolves.toBeDefined();
  await expect(run({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", $defs: { node: { $anchor: "node", type: "string" } }, properties: { value: { $ref: "#node" } } })).resolves.toBeDefined();
  for (const schema of [
    { type: "object", properties: { values: { type: "array", items: [{ type: "string" }] } } },
    { type: "object", properties: { value: { contentSchema: { $ref: "literal-extension-value" } } } },
    { type: "object", $defs: { node: { type: "string" } }, properties: { value: { $ref: "#%2F$defs%2Fnode" } } },
    { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", $defs: { node: { $dynamicAnchor: "node", type: "string" } }, properties: { value: { $ref: "#node" } } },
  ]) await expect(run(schema)).resolves.toBeDefined();
  await expect(run({ $schema: "https://json-schema.org/draft/2019-09/schema", type: "object", $defs: { node: { $dynamicAnchor: "node", type: "string" } }, properties: { value: { $ref: "#node" } } })).rejects.toThrow(/named schema anchor/);
  const content = (type: string) => ({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", $defs: { body: { type } }, properties: { value: { type: "string", contentSchema: { $ref: "#/$defs/body" } } } });
  await expect(run(content("string"), content("number"))).rejects.toThrow(/canonical schema/);
  await expect(run({ type: "object", properties: { value: { $dynamicRef: "#node" } } })).rejects.toMatchObject({ code: "MCPFN_INVALID_PROJECTED_CATALOG" });
  const { formatMcpFnSchemaIssues } = await import("../src/validation.js");
  expect(formatMcpFnSchemaIssues([{ instancePath: "", schemaPath: "", keyword: "type", params: {} }])[0].schemaPath).toBe("#");
});

it("rejects a draft-07 named-fragment projection that changes nested call validation", async () => {
  const canonical = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://example.test/root",
    type: "object" as const,
    additionalProperties: false,
    properties: { tenantId: { type: "string" }, child: { $ref: "#node" } },
    required: ["tenantId"],
    definitions: { node: { $id: "#node", type: "object", properties: { root: { $ref: "#" } } } },
  };
  const visible = { ...canonical, properties: { child: canonical.properties.child }, required: [] };
  const registry = new McpFnRegistry<RequestContext>().register({
    name: "fragment", description: "Fragment projection", inputSchema: canonical,
    handler: async () => structuredResult({ ok: true }),
  });
  const server = createMcpFnServer({
    info: { name: "fragment-server", version: "1" }, registry,
    context: () => ({ subject: "trusted" }),
    clientProfiles: { profiles: [{ id: "fragment", version: "1", matches: () => true,
      serverOwnedArguments: { fragment: ["tenantId"] },
      enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: "trusted" }),
      projectCatalog: () => [{ name: "fragment", inputSchema: visible }],
    }], resolveVerifiedIdentity: () => ({ subject: "trusted" }) },
  });
  const client = new Client({ name: "fragment-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    await expect(client.listTools()).rejects.toThrow(/canonical schema|root constraints/);
  } finally { await client.close(); await server.close(); }
});

it("rejects a draft-07 reference projection whose ignored sibling appears to hide an owned argument", async () => {
  const canonical = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object" as const,
    $ref: "#/definitions/input",
    additionalProperties: false,
    definitions: { input: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] } },
  };
  const visible = { ...canonical, definitions: { input: { type: "object" } } };
  const registry = new McpFnRegistry<RequestContext>().register({
    name: "lookup", description: "Lookup", inputSchema: canonical,
    handler: async () => structuredResult({ ok: true }),
  });
  const server = createMcpFnServer({
    info: { name: "sibling-server", version: "1" }, registry,
    context: () => ({ subject: "trusted" }),
    clientProfiles: { profiles: [{ id: "sibling", version: "1", matches: () => true,
      serverOwnedArguments: { lookup: ["tenantId"] },
      enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: "trusted" }),
      projectCatalog: () => [{ name: "lookup", inputSchema: visible }],
    }], resolveVerifiedIdentity: () => ({ subject: "trusted" }) },
  });
  const client = new Client({ name: "sibling-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    await expect(client.listTools()).rejects.toThrow(/owned|model-visible|root constraints/);
  } finally { await client.close(); await server.close(); }
});

async function withNoopProfileClient(
  name: string,
  schema: McpFnObjectSchema,
  check: (client: Client) => Promise<void>,
): Promise<void> {
  const registry = new McpFnRegistry().register({
    name, description: "Reference contract", inputSchema: schema,
    handler: async () => structuredResult({ ok: true }),
  });
  const server = createMcpFnServer({ info: { name: `${name}-server`, version: "1" }, registry,
    clientProfiles: { profiles: [{ id: "noop", version: "1", matches: () => true }],
      resolveVerifiedIdentity: () => ({ subject: "trusted" }) } });
  const client = new Client({ name: `${name}-client`, version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    await check(client);
  } finally { await client.close(); await server.close(); }
}

function ignoredRefSchema(keyword: string, value: unknown, target: Record<string, unknown>): McpFnObjectSchema {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { query: { $ref: "#/definitions/value", [keyword]: value } },
    definitions: { value: target },
  };
}

async function expectIgnoredRefListsAndCalls(schema: McpFnObjectSchema, query: unknown): Promise<void> {
  await withNoopProfileClient("ignored", schema, async client => {
    expect((await client.listTools()).tools[0].name).toBe("ignored");
    expect(await client.callTool({ name: "ignored", arguments: { query } })).toMatchObject({ structuredContent: { ok: true } });
  });
}

it("lists and calls a draft-07 reference with an ignored extension beside it", async () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object" as const,
    $ref: "#/definitions/input",
    "x-doc": "Application annotation",
    definitions: {
      input: { type: "object", properties: { query: { $ref: "#/definitions/text", "x-doc": "Nested annotation" } }, required: ["query"] },
      text: { type: "string" },
    },
  };
  await withNoopProfileClient("annotated", schema, async client => {
    expect((await client.listTools()).tools[0].name).toBe("annotated");
    expect(await client.callTool({ name: "annotated", arguments: { query: "hello" } })).toMatchObject({ structuredContent: { ok: true } });
  });
});

it("ignores a draft-07 reference with a nested format assertion sibling", async () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object" as const,
    properties: { query: { $ref: "#/definitions/name", format: "email" } },
    definitions: { name: { type: "string" } },
  };
  await withNoopProfileClient("formatted", schema, async client => {
    expect((await client.listTools()).tools[0].name).toBe("formatted");
    expect(await client.callTool({ name: "formatted", arguments: { query: "plain-text" } })).toMatchObject({ structuredContent: { ok: true } });
  });
});

it("rejects a draft-07 reference whose sibling resource ID changes relative reference scope", async () => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://example.test/root/main",
    type: "object" as const,
    definitions: {
      rootTarget: { $id: "https://example.test/root/target", definitions: { value: { type: "string" } } },
      altTarget: { $id: "https://example.test/alt/target", definitions: { value: { type: "number" } } },
    },
    properties: { query: { $id: "https://example.test/alt/child", $ref: "target#/definitions/value" } },
  };
  await withNoopProfileClient("scoped", schema, async client => {
    await expect(client.listTools()).rejects.toThrow(/Draft-07 \$ref assertion siblings/);
  });
});

it.each([
  ["dependentRequired", { flag: ["missing"] }, { type: "object" }, { flag: true }],
  ["dependentSchemas", { flag: { required: ["missing"] } }, { type: "object" }, { flag: true }],
  ["prefixItems", [{ type: "number" }], { type: "array" }, ["text"]],
  ["unevaluatedItems", false, { type: "array" }, ["text"]],
  ["unevaluatedProperties", false, { type: "object" }, { extra: true }],
] as const)("ignores a draft-07 %s sibling for an input it would reject in 2020-12", async (keyword, value, target, query) => {
  const schema = ignoredRefSchema(keyword, value, target);
  const modernValidator = new Ajv2020({ strict: false });
  expect(modernValidator.validate({ ...schema, $schema: "https://json-schema.org/draft/2020-12/schema" }, { query })).toBe(false);
  await expectIgnoredRefListsAndCalls(schema, query);
});

it.each([
  ["maxContains", 0],
  ["minContains", 2],
] as const)("lists a draft-07 %s sibling without contains beside the reference", async (keyword, value) => {
  // max/minContains have no independent effect without a same-object contains.
  // That evaluated draft-07 sibling is covered by the fail-closed $ref gate.
  const schema = ignoredRefSchema(keyword, value, { type: "array", contains: { const: "match" } });
  await expectIgnoredRefListsAndCalls(schema, ["match"]);
});

it.each([
  ["maxContains", 0],
  ["minContains", 2],
] as const)("ignores a draft-07 %s paired with a contains sibling beside a reference", async (keyword, value) => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object" as const,
    properties: { query: { $ref: "#/definitions/value", contains: { const: "match" }, [keyword]: value } },
    definitions: { value: { type: "array" } },
  };
  await expectIgnoredRefListsAndCalls(schema, ["match"]);
});

it.each([
  ["dependentSchemas", { flag: { $ref: "#/missing" } }],
  ["prefixItems", [{ $ref: "#/missing", type: "not-a-type" }]],
  ["unevaluatedProperties", { $ref: "#/missing" }],
] as const)("does not traverse an ignored draft-07 %s container", async (keyword, value) => {
  const schema = ignoredRefSchema(keyword, value, { type: "string" });
  await expectIgnoredRefListsAndCalls(schema, "hello");
});

it("accepts a draft-07 reference projection when its target closes the owned argument", async () => {
  const canonical = {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object" as const,
    $ref: "#/definitions/input",
    definitions: { input: { type: "object", additionalProperties: false,
      properties: { tenantId: { type: "string" }, query: { type: "string" } }, required: ["tenantId"] } },
  };
  const visible = { ...canonical, definitions: { input: { type: "object", additionalProperties: false,
    properties: { query: { type: "string" } }, required: [] as string[] } } };
  const registry = new McpFnRegistry<RequestContext>().register({
    name: "lookup", description: "Lookup", inputSchema: canonical,
    handler: async () => structuredResult({ ok: true }),
  });
  const server = createMcpFnServer({
    info: { name: "closed-reference-server", version: "1" }, registry,
    context: () => ({ subject: "trusted" }),
    clientProfiles: { profiles: [{ id: "closed-reference", version: "1", matches: () => true,
      serverOwnedArguments: { lookup: ["tenantId"] },
      enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: "trusted" }),
      projectCatalog: () => [{ name: "lookup", inputSchema: visible }],
    }], resolveVerifiedIdentity: () => ({ subject: "trusted" }) },
  });
  const client = new Client({ name: "closed-reference-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    expect((await client.listTools()).tools[0].name).toBe("lookup");
    expect(await client.callTool({ name: "lookup", arguments: { query: "hello" } })).toMatchObject({ structuredContent: { ok: true } });
  } finally { await client.close(); await server.close(); }
});

it.each([
  ["identified", "#", true],
  ["identified", "#/properties/child", true],
  ["anonymous", "#", false],
  ["anonymous", "#/properties/child", false],
])("keeps draft-07 %s resource references and %s through list and call", async (_label, reference, identified) => {
  const schema = {
    $schema: "http://json-schema.org/draft-07/schema#", ...(identified ? { $id: "https://example.test/root" } : {}), type: "object" as const,
    properties: { child: { $ref: "#node" } },
    definitions: { node: { $id: "#node", type: "object", properties: { root: { $ref: reference } } } },
  };
  const registry = new McpFnRegistry().register({
    name: "fragment", description: "Fragment", inputSchema: schema,
    handler: async () => structuredResult({ ok: true }),
  });
  const server = createMcpFnServer({ info: { name: "fragment-server", version: "1" }, registry,
    clientProfiles: { profiles: [{ id: "noop", version: "1", matches: () => true }],
      resolveVerifiedIdentity: () => ({ subject: "trusted" }) } });
  const client = new Client({ name: "fragment-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    expect((await client.listTools()).tools[0].name).toBe("fragment");
    expect(await client.callTool({ name: "fragment", arguments: { child: { root: {} } } })).toMatchObject({ structuredContent: { ok: true } });
  } finally { await client.close(); await server.close(); }
});

it.each(["2019-09", "2020-12"])("resolves %s anchors within the containing projected resource", async dialect => {
  const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
  const schema = {
    $schema: `https://json-schema.org/draft/${dialect}/schema`, $id: "https://example.test/root",
    type: "object" as const, properties: { child: { $ref: "#node" } },
    $defs: { node: { $anchor: "node", type: "object", properties: { root: { $ref: "#" } } } },
  };
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "fragment", inputSchema: schema }],
    resolved: { context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "noop", version: "1", matches: () => true, projectCatalog: () => [{ name: "fragment", inputSchema: schema }] } } })).resolves.toMatchObject({ changes: [] });
});

it("bounds request-controlled property names in diagnostics", async () => {
  const { formatMcpFnSchemaIssues } = await import("../src/validation.js");
  const issues = formatMcpFnSchemaIssues([{ keyword: "additionalProperties", instancePath: "", schemaPath: "#", params: { additionalProperty: "x".repeat(10000) } }]);
  expect(issues[0].rejectedProperty?.length).toBe(256);
  expect(issues[0].truncated).toBe(true);
  const exact = formatMcpFnSchemaIssues([{ keyword: "additionalProperties", instancePath: "/a", schemaPath: "#", params: { additionalProperty: "tenantId" } }]);
  expect(exact[0]).toMatchObject({ rejectedProperty: "tenantId", instancePath: "/a" });
  expect(exact[0].truncated).toBeUndefined();
});

it("rejects invalid projected MCP metadata and ignores schema object aliasing", async () => {
  const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
  const shared = { properties: { value: { type: "string" } } };
  const tool = { name: "test", inputSchema: { type: "object" as const, allOf: [shared, shared] } };
  const run = (projected: any) => buildMcpFnEffectiveCatalog({ canonicalTools: [tool], resolved: { context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" }, profile: { id: "test", version: "1", matches: () => true, projectCatalog: () => [projected] } } });
  await expect(run(JSON.parse(JSON.stringify(tool)))).resolves.toBeDefined();
  for (const metadata of [{ _meta: { missing: undefined } }, { _meta: { sparse: new Array(2) } }, { _meta: { callback: () => {} } }, { _meta: { number: BigInt(1) } }, { description: 5 }, { annotations: { readOnlyHint: "yes" } }]) await expect(run({ ...tool, ...metadata })).rejects.toMatchObject({ code: "MCPFN_INVALID_PROJECTED_CATALOG" });
});

it("matches Unicode schema patterns with Ajv semantics", async () => {
  const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
  await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "test", inputSchema: { type: "object", properties: { tenantId: { type: "string" } }, required: ["tenantId"] } }], resolved: { context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" }, profile: { id: "test", version: "1", matches: () => true, serverOwnedArguments: { test: ["tenantId"] }, projectCatalog: () => [{ name: "test", inputSchema: { type: "object", additionalProperties: false, patternProperties: { "\\p{L}": {} } } }] } } })).rejects.toMatchObject({ code: "MCPFN_PROFILE_ASYMMETRIC" });
});


it("resolves shared relative references independently in each embedded resource", async () => {
  const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
  const shared = { $ref: "#/$defs/value" };
  const schema = (secondType: string) => ({ type: "object" as const, properties: {
    first: { $id: "first", type: "object", $defs: { value: { type: "string" } }, properties: { value: shared } },
    second: { $id: "second", type: "object", $defs: { value: { type: secondType } }, properties: { value: shared } },
  } });
  const run = (type: string) => buildMcpFnEffectiveCatalog({
    canonicalTools: [{ name: "shared", inputSchema: schema("string") }], resolved: {
      context: undefined, extra: {} as any, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "test", version: "1", matches: () => true, projectCatalog: () => [{ name: "shared", inputSchema: schema(type) }] },
    },
  });
  await expect(run("string")).resolves.toBeDefined();
  await expect(run("number")).rejects.toMatchObject({ code: "MCPFN_PROFILE_ASYMMETRIC" });
});


it.each(["storage", "wrapped-storage", "retried-storage", "handler", "invalid-output"])("orders task output evidence after predecessor stages on %s failure", async failure => {
  const { InMemoryTaskStore } = await import("@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js");
  const taskStore = new InMemoryTaskStore();
  if (!["handler", "invalid-output"].includes(failure)) vi.spyOn(taskStore, "storeTaskResult").mockRejectedValue(new Error("storage failed"));
  const evidence: McpFnClientProfileEvidence[] = [];
  const registry = new McpFnRegistry().register({
    name: "task", description: "Task", outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, inputSchema: { type: "object" }, execution: { taskSupport: "required" },
    handler: async () => structuredResult({ ok: true }),
    taskHandler: { createTask: async (_args, _context, extra) => {
      const task = await extra.taskStore.createTask({ ttl: 1000 });
      try {
        await extra.taskStore.storeTaskResult(task.taskId, "completed", structuredResult({ ok: failure === "invalid-output" ? "bad" : true }));
      } catch (error) {
        if (failure === "wrapped-storage") throw new Error("wrapped storage failure", { cause: error });
        if (failure === "retried-storage") await extra.taskStore.storeTaskResult(task.taskId, "completed", structuredResult({ ok: failure === "invalid-output" ? "bad" : true }));
        throw error;
      }
      throw new Error("handler failed after output");
    } },
  });
  const server = createMcpFnServer({ info: { name: "test", version: "1" }, registry, taskStore,
    clientProfiles: { profiles: [], resolveVerifiedIdentity: () => undefined, evidence: event => { evidence.push(event); } } });
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left); await client.listTools();
    try { for await (const _message of client.experimental.tasks.callToolStream({ name: "task", arguments: {} }, undefined, { task: { ttl: 1000 } })) { /* drain */ } } catch { /* Expected task failure. */ }
    const stages = evidence.filter(event => ["input-validation", "handler", "output-validation"].includes(event.stage)).map(event => [event.stage, event.outcome]);
    expect(stages).toEqual([["input-validation", "succeeded"], ["output-validation", failure === "invalid-output" ? "failed" : "succeeded"], ...(failure === "retried-storage" ? [["output-validation", "succeeded"]] : []), ["handler", "failed"]]);
    expect(evidence.filter(event => event.stage === "task-result-storage")).toHaveLength(["handler", "invalid-output"].includes(failure) ? 0 : 1);
  } finally { await client.close(); await server.close(); }
});


it("reports output validation of a result written during task creation before the handler outcome", async () => {
  const { InMemoryTaskStore } = await import("@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js");
  const { CreateTaskResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const taskStore = new InMemoryTaskStore();
  const evidence: McpFnClientProfileEvidence[] = [];
  const registry = new McpFnRegistry().register({
    name: "immediate", description: "Immediate task", inputSchema: { type: "object" },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    execution: { taskSupport: "required" }, handler: async () => structuredResult({ ok: true }),
    taskHandler: { createTask: async (_args, _context, extra) => {
      const task = await extra.taskStore.createTask({ ttl: 1000 });
      await extra.taskStore.storeTaskResult(task.taskId, "completed", structuredResult({ ok: true }));
      return { task };
    } },
  });
  const server = createMcpFnServer({ info: { name: "test", version: "1" }, registry, taskStore,
    clientProfiles: { profiles: [], resolveVerifiedIdentity: () => undefined, evidence: event => { evidence.push(event); } } });
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    await client.request({ method: "tools/call", params: { name: "immediate", arguments: {}, task: { ttl: 1000 } } }, CreateTaskResultSchema);
    expect(evidence.filter(event => ["input-validation", "handler", "output-validation"].includes(event.stage)).map(event => [event.stage, event.outcome])).toEqual([
      ["input-validation", "succeeded"], ["output-validation", "succeeded"], ["handler", "succeeded"],
    ]);
  } finally { await client.close(); await server.close(); }
});

it("reports a rejected task-store promise after the creation request has settled", async () => {
  const { InMemoryTaskStore } = await import("@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js");
  const { CreateTaskResultSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const taskStore = new InMemoryTaskStore();
  const failure = new McpFnError("private-storage-diagnosis".repeat(10000), "private-storage-diagnosis");
  vi.spyOn(taskStore, "storeTaskResult").mockRejectedValue(failure);
  const evidence: McpFnClientProfileEvidence[] = [];
  let persist!: () => Promise<void>;
  const registry = new McpFnRegistry().register({
    name: "delayed", description: "Delayed task", inputSchema: { type: "object" },
    execution: { taskSupport: "required" }, handler: async () => structuredResult({ ok: true }),
    taskHandler: { createTask: async (_args, _context, extra) => {
      const task = await extra.taskStore.createTask({ ttl: 1000 });
      persist = () => extra.taskStore.storeTaskResult(task.taskId, "completed", structuredResult({ ok: true }));
      return { task };
    } },
  });
  const server = createMcpFnServer({ info: { name: "test", version: "1" }, registry, taskStore,
    clientProfiles: { profiles: [], resolveVerifiedIdentity: () => undefined, evidence: event => { evidence.push(event); } } });
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    const created = await client.request({ method: "tools/call", params: { name: "delayed", arguments: {}, task: { ttl: 1000 } } }, CreateTaskResultSchema);
    expect(created.task.status).toBe("working");
    const beforeStorage = evidence.length;
    await expect(persist()).rejects.toBe(failure);
    expect(evidence.slice(beforeStorage).map(event => [event.stage, event.outcome])).toEqual([
      ["output-validation", "succeeded"], ["task-result-storage", "failed"],
    ]);
    await expect(persist()).rejects.toBe(failure);
    expect(evidence.filter(event => event.stage === "task-result-storage")).toHaveLength(1);
    expect(evidence.filter(event => event.stage === "handler").map(event => event.outcome)).toEqual(["succeeded"]);
    expect(JSON.stringify(evidence)).not.toContain("private-storage-diagnosis");
  } finally { await client.close(); await server.close(); }
});

it.each(["", "https://example.test/input"])("preserves equivalent resource references through list and call: %s", async reference => {
  const registry = new McpFnRegistry().register({ name: "recursive", description: "Recursive schema", inputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#", $id: "https://example.test/input#",
    type: "object", properties: { child: { $ref: reference } },
  }, handler: async () => structuredResult({ ok: true }) });
  const server = createMcpFnServer({ info: { name: "empty-ref", version: "1" }, registry,
    clientProfiles: { profiles: [{ id: "noop", version: "1", matches: () => true }], resolveVerifiedIdentity: () => ({ subject: "trusted" }) } });
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    expect((await client.listTools()).tools[0].name).toBe("recursive");
    expect(await client.callTool({ name: "recursive", arguments: { child: { child: {} } } })).toMatchObject({ structuredContent: { ok: true } });
  } finally { await client.close(); await server.close(); }
});

it.each(["resolver", "projector"])("preserves framework fallback evidence from a throwing %s", async hook => {
  const evidence: McpFnClientProfileEvidence[] = [];
  const fail = () => { throw new Error("hook failure"); };
  const registry = new McpFnRegistry().register({ name: "test", description: "test", inputSchema: { type: "object" }, handler: () => structuredResult({ ok: true }) });
  const server = createMcpFnServer({ info: { name: "test", version: "1" }, registry,
    clientProfiles: { profiles: [{ id: "test", version: "1", matches: () => true, ...(hook === "projector" ? { projectCatalog: fail } : {}) }],
      resolveVerifiedIdentity: hook === "resolver" ? fail : () => ({ subject: "trusted" }), evidence: event => { evidence.push(event); } } });
  const client = new Client({ name: "test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    await expect(client.listTools()).rejects.toThrow();
    expect(evidence).toContainEqual(expect.objectContaining({ outcome: "failed", code: hook === "resolver" ? "MCPFN_PROFILE_RESOLUTION_FAILED" : "MCPFN_CATALOG_PROJECTION_FAILED" }));
  } finally { await client.close(); await server.close(); }
});

it("resolves embedded external resources in edge profile validation", async () => {
  vi.stubGlobal("WebSocketPair", class {});
  vi.resetModules();
  try {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const dependency = { type: "object" as const, $defs: { shared: { $id: "https://edge-profile.invalid/shared", type: "string" } } };
    const tool = { name: "edge_external", inputSchema: { type: "object" as const, properties: { value: { $ref: "https://edge-profile.invalid/shared" } } } };
    const result = await buildMcpFnEffectiveCatalog({ canonicalTools: [tool], schemaResources: [dependency, tool.inputSchema], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "edge", version: "1", matches: () => true },
    } });
    expect(result.tools).toEqual([tool]);
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
  }
});

it("lists and calls a visible tool beside a hidden tool whose unreferenced draft-07 schema the projection would reject", async () => {
  const registry = new McpFnRegistry()
    .register({
      name: "visible", description: "Independent visible tool",
      inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      handler: async () => structuredResult({ ok: true }),
    })
    .register({
      name: "hidden", description: "Hidden tool with a scope-changing sibling",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        $id: "https://example.test/hidden/main",
        type: "object",
        definitions: { target: { $id: "https://example.test/hidden/target", definitions: { value: { type: "string" } } } },
        properties: { query: { $id: "https://example.test/hidden/child", $ref: "target#/definitions/value" } },
      },
      handler: async () => structuredResult({ ok: true }),
    });
  const server = createMcpFnServer({ info: { name: "hidden-sibling-server", version: "1" }, registry,
    toolVisibility: ({ tool }) => tool.name !== "hidden",
    clientProfiles: { profiles: [{ id: "noop", version: "1", matches: () => true }],
      resolveVerifiedIdentity: () => ({ subject: "trusted" }) } });
  const client = new Client({ name: "hidden-sibling-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    expect((await client.listTools()).tools.map(({ name }) => name)).toEqual(["visible"]);
    expect(await client.callTool({ name: "visible", arguments: { query: "hello" } })).toMatchObject({ structuredContent: { ok: true } });
  } finally { await client.close(); await server.close(); }
});

it("rejects a visible tool that references an unsupported construct in another tool's schema resource", async () => {
  const registry = new McpFnRegistry()
    .register({
      name: "hidden", description: "Owns the referenced resource",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        $id: "https://example.test/shared/target",
        definitions: { value: { type: "string", $recursiveRef: "#" } },
      },
      handler: async () => structuredResult({ ok: true }),
    })
    .register({
      name: "visible", description: "References the hidden resource",
      inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { query: { $ref: "https://example.test/shared/target#/definitions/value" } } },
      handler: async () => structuredResult({ ok: true }),
    });
  const server = createMcpFnServer({ info: { name: "reached-sibling-server", version: "1" }, registry,
    toolVisibility: ({ tool }) => tool.name !== "hidden",
    clientProfiles: { profiles: [{ id: "noop", version: "1", matches: () => true }],
      resolveVerifiedIdentity: () => ({ subject: "trusted" }) } });
  const client = new Client({ name: "reached-sibling-client", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right); await client.connect(left);
    await expect(client.listTools()).rejects.toThrow(/Dynamic and recursive references/);
  } finally { await client.close(); await server.close(); }
});

describe("anonymous schema scopes beside registered schema resources", () => {
  // The canonical tool's local references must resolve inside its own schema.
  // Before each anonymous resource got its own synthetic base, a sibling could
  // claim the shared base and both projections resolved into the sibling, so a
  // changed model-owned type compared as unchanged.
  async function projectBeside(sibling: Record<string, unknown>) {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const schema = (type: string, owned: boolean) => ({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object" as const,
      additionalProperties: false,
      properties: { ...(owned ? { tenantId: { type: "string" } } : {}), query: { $ref: "#/definitions/query" } },
      ...(owned ? { required: ["tenantId"] } : {}),
      definitions: { query: { type } },
    });
    const tool = { name: "search", inputSchema: schema("string", true) };
    return buildMcpFnEffectiveCatalog({ canonicalTools: [tool], schemaResources: [sibling, tool.inputSchema], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true,
        serverOwnedArguments: { search: ["tenantId"] }, enrichArguments: ({ arguments: args }) => ({ ...args, tenantId: "trusted" }),
        projectCatalog: () => [{ name: "search", inputSchema: schema("number", false) }],
      },
    } });
  }

  it("rejects a changed local reference beside a sibling whose authored $id equals the former synthetic root", async () => {
    const sibling = { $id: "https://mcpfn.invalid/schema", type: "object", definitions: { query: { type: "string" } } };
    await expect(projectBeside(sibling)).rejects.toThrow(/must retain its canonical schema/);
  });

  it("validates an anonymous projected schema beside a sibling whose $id looks like an internal registry key", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const inputSchema = { type: "object" as const, properties: { query: { type: "string" } } };
    // The projected graph is [sibling, inputSchema]; index 1 was the anonymous
    // schema's former registry key, so Ajv refused the catalog as a duplicate.
    for (const sibling of [
      { $id: "mcpfn-profile-1", type: "object" },
      { type: "object", definitions: { key: { $id: "mcpfn-profile-1", type: "string" } } },
    ]) {
      const catalog = await buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "search", inputSchema }], schemaResources: [sibling, inputSchema], resolved: {
        context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
        profile: { id: "noop", version: "1", matches: () => true },
      } });
      expect(catalog.tools.map((tool) => tool.name)).toEqual(["search"]);
    }
  });

  // A nested relative $id names its own resource in the shared namespace; it
  // must neither take over the root's "#/" pointers nor be refused.
  it("keeps an anonymous root's local references beside a nested relative $id", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const schema = (type: string) => ({ type: "object" as const, properties: { query: { $ref: "#/definitions/query" }, nested: { $id: "schema", definitions: { query: { type: "number" } } } }, definitions: { query: { type } } });
    const resolved = (projected?: ReturnType<typeof schema>) => ({
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true, ...(projected ? { projectCatalog: () => [{ name: "search", inputSchema: projected }] } : {}) },
    });
    const canonicalTools = [{ name: "search", inputSchema: schema("string") }];
    expect((await buildMcpFnEffectiveCatalog({ canonicalTools, resolved: resolved() })).tools.map((tool) => tool.name)).toEqual(["search"]);
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools, resolved: resolved(schema("number")) })).rejects.toThrow(/must retain its canonical schema/);
  });

  // An empty $id leaves the root anonymous, and a schema with different content
  // can never take over an ID another resource already owns.
  it.each([
    // Valid schema: the projection changes the root's own definition, so it is asymmetric.
    ["an empty root $id beside a nested $id \"/\"", { $id: "" }, "/", "MCPFN_PROFILE_ASYMMETRIC"],
    // A nested schema with different content claiming the root's $id is refused outright.
    ["an identified root beside a nested duplicate of its $id", { $id: "https://profile.invalid/root" }, "https://profile.invalid/root", "MCPFN_INVALID_PROJECTED_CATALOG"],
  ])("keeps the root's local references with %s", async (_label, identity, nestedId, code) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const schema = (type: string) => ({ ...identity, type: "object" as const, properties: { query: { $ref: "#/definitions/query" }, nested: { $id: nestedId, definitions: { query: { type: "string" } } } }, definitions: { query: { type } } });
    const resolved = (projected?: ReturnType<typeof schema>) => ({
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true, ...(projected ? { projectCatalog: () => [{ name: "search", inputSchema: projected }] } : {}) },
    });
    const canonicalTools = [{ name: "search", inputSchema: schema("string") }];
    if (code === "MCPFN_PROFILE_ASYMMETRIC") {
      expect((await buildMcpFnEffectiveCatalog({ canonicalTools, resolved: resolved() })).tools.map((tool) => tool.name)).toEqual(["search"]);
    }
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools, resolved: resolved(schema("number")) })).rejects.toMatchObject({ code });
  });

  // The runtime resolves an anonymous schema's literal dot-segment references
  // ("./#/x", ".#/x", "../#/x") to that schema itself, so a sibling whose $id is
  // "/" must not supply their target on either validation engine.
  describe.each(["ajv", "cfworker"])("dot-segment self references (%s)", (engine) => {
    afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
    it.each(["./#/definitions/query", ".#/definitions/query", "../#/definitions/query"])("keeps %s on the anonymous root", async (reference) => {
      if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
      vi.resetModules();
      const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
      const sibling = { $id: "/", type: "object", definitions: { query: { type: "string" } } };
      const schema = (type: string) => ({ type: "object" as const, properties: { query: { $ref: reference } }, definitions: { query: { type } } });
      const run = (projected?: ReturnType<typeof schema>) => buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "search", inputSchema: schema("string") }], schemaResources: [sibling, schema("string")], resolved: {
        context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
        profile: { id: "scoped", version: "1", matches: () => true, ...(projected ? { projectCatalog: () => [{ name: "search", inputSchema: projected }] } : {}) },
      } });
      if (engine === "ajv") {
        // The runtime compiles the tool with base "" and resolves the reference in it.
        const validate = createSchemaCompiler("ajv").compile(schema("string"));
        expect([validate({ query: "text" }), validate({ query: 1 })]).toEqual([true, false]);
      }
      // Both engines resolve it on the anonymous root and compare shapes.
      expect((await run()).tools.map((tool) => tool.name)).toEqual(["search"]);
      await expect(run(schema("number"))).rejects.toMatchObject({ code: "MCPFN_PROFILE_ASYMMETRIC" });
    });
  });

  // Ajv engine only: the runtime collection validator does not return for this
  // schema on either engine (pre-existing at next e42232591, deferred to SFNS-158),
  // and the edge engine runs it before the structural comparison.
  it("refuses a dot-segment $id that would rename the anonymous root", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const inputSchema = { type: "object" as const, properties: { query: { $ref: "#/definitions/query" }, nested: { $id: "./", definitions: { query: { type: "number" } } } }, definitions: { query: { type: "string" } } };
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "search", inputSchema }], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "noop", version: "1", matches: () => true },
    } })).rejects.toThrow(/anonymous schema scope/);
  });

  it("lists a tool whose own root $id is a dot segment", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const inputSchema = { $id: "./", type: "object" as const, properties: { query: { type: "string" } } };
    const catalog = await buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "search", inputSchema }], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "noop", version: "1", matches: () => true },
    } });
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["search"]);
  });

  // Resource identity follows the active validator. Ajv keys a top-level $id by
  // its literal text, so "shared", "/shared" and "./shared" are three resources;
  // the edge runtime resolves every ID against one base, where "shared" and
  // "/shared" are one. The structural comparison must agree with each engine.
  describe.each(["ajv", "cfworker"] as const)("relative resource ID spellings (%s)", (engine) => {
    afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
    const load = async () => {
      if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
      vi.resetModules();
      return import("../src/client-profiles.js");
    };
    const resolved = (projectCatalog?: () => Array<{ name: string; inputSchema: McpFnObjectSchema }>) => ({
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true, ...(projectCatalog ? { projectCatalog } : {}) },
    });

    it.each(["/shared", "./shared"])("lists root IDs \"shared\" and %s exactly when the engine registers both", async (other) => {
      const { buildMcpFnEffectiveCatalog } = await load();
      const text = { $id: "shared", type: "object" as const, properties: { v: { type: "string" } } };
      const number = { $id: other, type: "object" as const, properties: { v: { type: "number" } } };
      for (const order of [[text, number], [number, text]]) {
        // Oracle: the runtime compiler of this engine, independent of the profile code.
        let registered = true;
        try { const compiler = createSchemaCompiler(engine); for (const schema of order) compiler.compile(schema); }
        catch { registered = false; }
        expect(registered).toBe(engine === "ajv");
        const run = buildMcpFnEffectiveCatalog({ canonicalTools: order.map((inputSchema, index) => ({ name: `tool_${index}`, inputSchema })), resolved: resolved() });
        if (registered) expect((await run).tools.map((tool) => tool.name).sort()).toEqual(["tool_0", "tool_1"]);
        else await expect(run).rejects.toMatchObject({ code: "MCPFN_INVALID_PROJECTED_CATALOG" });
      }
    });

    it("refuses a reference to a schema ID that two different schemas claim", async () => {
      const { buildMcpFnEffectiveCatalog } = await load();
      const text = { $id: "shared", type: "string" };
      const number = { $id: "/shared", type: "number" };
      const consumer = (reference: string) => ({ type: "object" as const, properties: { value: { $ref: reference } } });
      for (const schemaResources of [[text, number, consumer("/shared")], [number, text, consumer("/shared")]]) {
        await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "consumer", inputSchema: consumer("/shared") }], schemaResources,
          resolved: resolved(() => [{ name: "consumer", inputSchema: consumer("shared") }]),
        })).rejects.toMatchObject({ code: engine === "ajv" ? "MCPFN_PROFILE_ASYMMETRIC" : "MCPFN_INVALID_PROJECTED_CATALOG" });
      }
    });
  });

  // Ajv keys a root by its literal $id ("./shared") but resolves references to
  // normalized URIs ("shared#/..."), and binds one inside that root to the root
  // itself, even beside a sibling that owns "shared". An anchor that both
  // define has no fixed target, so it is refused.
  it.each([
    ["./shared", "#/definitions/query", false, "plain", "MCPFN_PROFILE_ASYMMETRIC"],
    ["./shared", "#node", true, "plain", "MCPFN_PROFILE_ASYMMETRIC"],
    ["./shared", "shared#/definitions/query", false, "plain", "MCPFN_PROFILE_ASYMMETRIC"],
    ["./shared", "shared#node", true, "plain", "MCPFN_PROFILE_ASYMMETRIC"],
    ["./shared", "shared#node", true, "anchored", "MCPFN_PROFILE_ASYMMETRIC"],
    ["./shared", "shared#/definitions/query", false, "none", "MCPFN_PROFILE_ASYMMETRIC"],
    ["./shared", "./shared#/definitions/query", false, "none", "MCPFN_PROFILE_ASYMMETRIC"],
    ["./shared", "shared#node", true, "none", "MCPFN_PROFILE_ASYMMETRIC"],
    ["https://profile.invalid:443/shared", "https://profile.invalid/shared#/definitions/query", false, "none", "MCPFN_PROFILE_ASYMMETRIC"],
  ] as const)("compares a root $id %s referenced as %s (anchor %s, sibling %s)", async (id, reference, anchored, sibling, code) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const other = { $id: "shared", type: "object", definitions: { query: { ...(sibling === "anchored" ? { $id: "#node" } : {}), type: "number" } } };
    const schema = (type: string) => ({ $id: id, type: "object" as const, properties: { query: { $ref: reference } }, definitions: { query: { ...(anchored ? { $id: "#node" } : {}), type } } });
    if (code === "MCPFN_PROFILE_ASYMMETRIC") {
      // Oracle: the runtime Ajv compiler binds the reference to this root's own definition.
      const compiler = createSchemaCompiler("ajv");
      if (sibling !== "none") compiler.compile(other);
      const validate = compiler.compile(schema("string"));
      expect([validate({ query: "text" }), validate({ query: 1 })]).toEqual([true, false]);
    }
    const run = (projected?: ReturnType<typeof schema>) => buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "search", inputSchema: schema("string") }], schemaResources: [...(sibling === "none" ? [] : [other]), schema("string")], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true, ...(projected ? { projectCatalog: () => [{ name: "search", inputSchema: projected }] } : {}) },
    } });
    if (code === "MCPFN_PROFILE_ASYMMETRIC") expect((await run()).tools.map((tool) => tool.name)).toEqual(["search"]);
    await expect(run(schema("number"))).rejects.toMatchObject({ code });
  });

  // Ajv serializes "%41" as "A": a separate consumer of ".../A#/..." reaches the
  // root whose $id is exactly ".../A", as it does at runtime.
  it("lists a consumer beside root IDs that differ only in percent-encoding", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const text = { $id: "https://profile.invalid/A", type: "object" as const, definitions: { q: { type: "string" } } };
    const number = { $id: "https://profile.invalid/%41", type: "object" as const, definitions: { q: { type: "number" } } };
    const consumer = { type: "object" as const, properties: { v: { $ref: "https://profile.invalid/A#/definitions/q" } } };
    const compiler = createSchemaCompiler("ajv");
    compiler.compile(text); compiler.compile(number);
    const validate = compiler.compile(consumer);
    expect([validate({ v: "text" }), validate({ v: 1 })]).toEqual([true, false]);
    const catalog = await buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "text", inputSchema: text }, { name: "number", inputSchema: number }, { name: "consumer", inputSchema: consumer }], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "noop", version: "1", matches: () => true },
    } });
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual(["consumer", "number", "text"]);
  });

  // Ajv registers a nested $id or anchor as an alias of "<top-level path>#<pointer>"
  // and resolves it in the resource being compiled. The oracle is the runtime
  // Ajv compiler, independent of the profile code: a projection that changes
  // only the consumer's own definition at that pointer must be rejected exactly
  // when that definition decides runtime validation.
  it.each([
    ["./shared", "shared", "nested", "nested", "consumer"],
    ["shared", "./shared", "nested", "nested", "consumer"],
    ["https://profile.invalid/a/b", "https://profile.invalid/a/./b", "nested", "nested", "consumer"],
    ["shared", "other", "nested", "nested", "provider"],
    ["shared", undefined, "nested", "nested", "provider"],
    [undefined, undefined, "nested", "nested", "consumer"],
    ["./shared", "shared", "#node", "shared#node", "consumer"],
    ["./shared", "shared", "#node", "./shared#node", "consumer"],
    ["shared", "other", "#node", "shared#node", "provider"],
  ] as const)("compares provider %s and consumer %s, nested $id %s referenced as %s (%s decides), as Ajv does", async (providerId, consumerId, nestedId, reference, decides) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const provider = { ...(providerId ? { $id: providerId } : {}), type: "object" as const, definitions: { inner: { $id: nestedId, type: "string" } } };
    const consumer = (type: string) => ({ ...(consumerId ? { $id: consumerId } : {}), type: "object" as const, properties: { value: { $ref: reference } }, definitions: { inner: { type } } });
    const runtime = (type: string) => { const compiler = createSchemaCompiler("ajv"); compiler.compile(provider); return compiler.compile(consumer(type))({ value: "text" }); };
    expect(runtime("string") !== runtime("number")).toBe(decides === "consumer");
    const run = (projected?: ReturnType<typeof consumer>) => buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "provider", inputSchema: provider }, { name: "consumer", inputSchema: consumer("string") }], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true, ...(projected ? { projectCatalog: ({ tools }: { tools: Array<{ name: string; inputSchema: McpFnObjectSchema }> }) => tools.map((tool) => tool.name === "consumer" ? { ...tool, inputSchema: projected } : tool) } : {}) },
    } });
    expect((await run()).tools.map((tool) => tool.name).sort()).toEqual(["consumer", "provider"]);
    if (decides === "consumer") await expect(run(consumer("number"))).rejects.toMatchObject({ code: "MCPFN_PROFILE_ASYMMETRIC" });
    else expect((await run(consumer("number"))).tools.map((tool) => tool.name).sort()).toEqual(["consumer", "provider"]);
  });

  // At runtime an anonymous tool's nested $id aliases "#/<pointer>", which a named
  // consumer resolves in the runtime's "" entry: the last anonymous schema
  // registered before it. The catalog lists exactly when the runtime registers.
  it.each([
    ["only the declaring provider", undefined, "string"],
    ["a later anonymous schema with that pointer", { type: "number" }, "number"],
    ["a later anonymous schema without that pointer", undefined, undefined],
  ] as const)("resolves an anonymous provider's nested ID from a named consumer after %s", async (label, laterInner, accepted) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const declaring = { type: "object" as const, definitions: { inner: { $id: "nested", type: "string" } } };
    const later = { type: "object" as const, properties: { other: { type: "boolean" } }, ...(laterInner ? { definitions: { inner: laterInner } } : {}) };
    const consumer = { $id: "shared", type: "object" as const, properties: { value: { $ref: "nested" } } };
    const schemas = label === "only the declaring provider" ? [declaring, consumer] : [declaring, later, consumer];
    let registered = true;
    try {
      const compiler = createSchemaCompiler("ajv");
      const validators = schemas.map((schema) => compiler.compile(schema));
      const validate = validators.at(-1)!;
      expect([validate({ value: "text" }), validate({ value: 1 })]).toEqual([accepted === "string", accepted === "number"]);
    } catch (error) {
      if (error instanceof Error && error.name === "AssertionError") throw error;
      registered = false;
    }
    expect(registered).toBe(accepted !== undefined);
    const run = buildMcpFnEffectiveCatalog({ canonicalTools: schemas.map((inputSchema, index) => ({ name: `tool_${index}`, inputSchema })), resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "noop", version: "1", matches: () => true },
    } });
    if (registered) expect((await run).tools).toHaveLength(schemas.length);
    else await expect(run).rejects.toMatchObject({ code: "MCPFN_INVALID_PROJECTED_CATALOG" });
  });

  it.each(["ajv", "cfworker"] as const)("rejects the nested-ID alias retyping on %s", async (engine) => {
    vi.resetModules();
    if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
    try {
      const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
      const provider = { $id: "./shared", type: "object" as const, definitions: { inner: { $id: "nested", type: "string" } } };
      const consumer = (type: string) => ({ $id: "shared", type: "object" as const, properties: { value: { $ref: "nested" } }, definitions: { inner: { type } } });
      await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "provider", inputSchema: provider }, { name: "consumer", inputSchema: consumer("string") }], resolved: {
        context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
        profile: { id: "retyped", version: "1", matches: () => true, projectCatalog: ({ tools }) => tools.map((tool) => tool.name === "consumer" ? { ...tool, inputSchema: consumer("number") } : tool) },
      } })).rejects.toMatchObject({ code: engine === "ajv" ? "MCPFN_PROFILE_ASYMMETRIC" : "MCPFN_INVALID_PROJECTED_CATALOG" });
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });

  // Ajv does not recompile a schema object it has seen, so registering one
  // anonymous object again leaves the runtime's "" entry on the schema between,
  // while a copy takes it again. The comparison follows the object identity.
  it.each([["a reused object", true], ["a copy", false]] as const)("compares a named consumer of the anonymous entry after %s as Ajv resolves it", async (_label, reused) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const declaring = { type: "object" as const, definitions: { inner: { $id: "nested", type: "string" } } };
    const between = { type: "object" as const, definitions: { inner: { type: "number" } } };
    const consumer = { $id: "shared", type: "object" as const, properties: { value: { $ref: "nested" } } };
    const types = { $id: "types", type: "object" as const, definitions: { number: { type: "number" } } };
    const order = [types, declaring, between, reused ? declaring : structuredClone(declaring), consumer];
    const compiler = createSchemaCompiler("ajv");
    for (const schema of order.slice(0, -1)) compiler.compile(schema);
    const validate = compiler.compile(consumer);
    expect([validate({ value: 1 }), validate({ value: "text" })]).toEqual(reused ? [true, false] : [false, true]);
    const run = (projected?: object) => buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "consumer", inputSchema: consumer }], schemaResources: order, resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "inline", version: "1", matches: () => true, ...(projected ? { projectCatalog: () => [{ name: "consumer", inputSchema: projected as McpFnObjectSchema }] } : {}) },
    } });
    expect((await run()).tools.map((tool) => tool.name)).toEqual(["consumer"]);
    // Pointing at an equal number schema is symmetric only when the runtime target is that number.
    const renamed = run({ $id: "shared", type: "object", properties: { value: { $ref: "types#/definitions/number" } } });
    if (reused) expect((await renamed).tools.map((tool) => tool.name)).toEqual(["consumer"]);
    else await expect(renamed).rejects.toMatchObject({ code: "MCPFN_PROFILE_ASYMMETRIC" });
  });

  it.each(["ajv", "cfworker"] as const)("compares retyping beside a same-tool nested ID at a percent-encoded pointer as the %s runtime resolves it", async (engine) => {
    vi.resetModules();
    if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
    try {
      const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
      const schema = (type: string) => ({ $id: "own", type: "object" as const, properties: { v: { $ref: "nested" } }, definitions: { "%41": { $id: "nested", type: "string" }, A: { type } } });
      // Ajv follows the decoded alias to definitions.A; the edge engine names the node itself.
      const { createSchemaCompiler: engineCompiler } = await import("../src/validation.js");
      const validate = engineCompiler(engine).compile(schema("number"));
      expect([validate({ v: 1 }), validate({ v: "text" })]).toEqual(engine === "ajv" ? [true, false] : [false, true]);
      const retyped = buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "own", inputSchema: schema("number") }], resolved: {
        context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
        profile: { id: "retyped", version: "1", matches: () => true, projectCatalog: () => [{ name: "own", inputSchema: schema("boolean") }] },
      } });
      if (engine === "ajv") await expect(retyped).rejects.toMatchObject({ code: "MCPFN_PROFILE_ASYMMETRIC" });
      else expect((await retyped).tools.map((tool) => tool.name)).toEqual(["own"]);
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });

  // Ajv stores an alias pointer unencoded but parses it as a URI, so the token
  // "%41" names definitions.A in the resource being compiled.
  it.each([true, false])("compares a nested-ID alias at a percent-encoded pointer as Ajv decodes it (literal %%41 sibling %s)", async (literalSibling) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const provider = { $id: "./shared", type: "object" as const, definitions: { "%41": { $id: "nested", type: "string" } } };
    const consumer = (type: string) => ({ $id: "shared", type: "object" as const, properties: { v: { $ref: "nested" } }, definitions: { A: { type }, ...(literalSibling ? { "%41": { type: "number" } } : {}) } });
    const compiler = createSchemaCompiler("ajv");
    compiler.compile(provider);
    const validate = compiler.compile(consumer("number"));
    expect([validate({ v: 1 }), validate({ v: true })]).toEqual([true, false]);
    const run = (projected?: ReturnType<typeof consumer>) => buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "provider", inputSchema: provider }, { name: "consumer", inputSchema: consumer("number") }], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true, ...(projected ? { projectCatalog: ({ tools }: { tools: Array<{ name: string; inputSchema: McpFnObjectSchema }> }) => tools.map((tool) => tool.name === "consumer" ? { ...tool, inputSchema: projected } : tool) } : {}) },
    } });
    expect((await run()).tools.map((tool) => tool.name).sort()).toEqual(["consumer", "provider"]);
    await expect(run(consumer("boolean"))).rejects.toMatchObject({ code: "MCPFN_PROFILE_ASYMMETRIC" });
  });

  // The runtime URI resolver escapes a stray "%" in a stored alias pointer, so
  // these keys name their literal definitions; retyping that definition matters.
  it.each([
    ["a named tool", { $id: "own" }, "100%", "nested", "nested"],
    ["an anonymous tool", {}, "%zz", "nested", "nested"],
    ["a named anchor", { $id: "own" }, "a%4", "#node", "#node"],
  ] as const)("compares a nested ID under a key with a stray percent sign in %s as Ajv resolves it", async (_label, identity, key, id, reference) => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const schema = (type: string) => ({ ...identity, type: "object" as const, properties: { v: { $ref: reference } }, definitions: { [key]: { $id: id, type } } });
    const validate = createSchemaCompiler("ajv").compile(schema("string"));
    expect([validate({ v: "ok" }), validate({ v: 1 })]).toEqual([true, false]);
    const run = (projected?: object) => buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "own", inputSchema: schema("string") }], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true, ...(projected ? { projectCatalog: () => [{ name: "own", inputSchema: projected as McpFnObjectSchema }] } : {}) },
    } });
    expect((await run()).tools.map((tool) => tool.name)).toEqual(["own"]);
    await expect(run(schema("number"))).rejects.toMatchObject({ code: "MCPFN_PROFILE_ASYMMETRIC" });
  });

  // The edge engine keeps a root $id "#/" and binds the reference "#/" to the root
  // itself, so the comparison must not treat that root as anonymous and walk
  // "#/" as a pointer to the empty-name field: it refuses the root fragment.
  it("refuses a root $id of #/ on the edge engine instead of walking it as a pointer", async () => {
    vi.resetModules();
    vi.stubGlobal("WebSocketPair", class {});
    try {
      const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
      const { createSchemaCompiler: edgeCompiler } = await import("../src/validation.js");
      const schema = { $id: "#/", type: "object" as const, "": { type: "string" }, properties: { v: { $ref: "#/" } } };
      const validate = edgeCompiler("cfworker").compile(schema);
      expect([validate({ v: {} }), validate({ v: "text" })]).toEqual([true, false]);
      await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "own", inputSchema: schema }], resolved: {
        context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
        profile: { id: "noop", version: "1", matches: () => true },
      } })).rejects.toMatchObject({ code: "MCPFN_INVALID_PROJECTED_CATALOG" });
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });

  // Named tools "a" and "b" each register "address" with a different alias text,
  // so the target is the last registered one: references to it are refused.
  it("refuses a nested ID that two named resources register at different aliases", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const owner = (id: string, type: string) => ({ $id: id, type: "object" as const, definitions: { address: { $id: "address", type } } });
    const consumer = { type: "object" as const, properties: { v: { $ref: "address" } } };
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "consumer", inputSchema: consumer }], schemaResources: [owner("a", "string"), owner("b", "number"), consumer], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "noop", version: "1", matches: () => true },
    } })).rejects.toMatchObject({ code: "MCPFN_INVALID_PROJECTED_CATALOG" });
  });

  // Empty IDs stay anonymous; a genuine named ID that two schemas claim is still refused.
  it("lists distinct empty-ID siblings and refuses a reference to a doubly claimed named ID", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const resolved = { context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" }, profile: { id: "noop", version: "1", matches: () => true } };
    const sibling = (id: string, type: string) => ({ $id: id, type: "object" as const, properties: { a: { $ref: "#/definitions/d" } }, definitions: { d: { type } } });
    const anonymous = { type: "object" as const, properties: { x: { type: "string" } } };
    const catalog = await buildMcpFnEffectiveCatalog({ canonicalTools: [anonymous, sibling("", "string"), sibling("", "number")].map((inputSchema, index) => ({ name: `tool_${index}`, inputSchema })), resolved });
    expect(catalog.tools.map((tool) => tool.name)).toEqual(["tool_0", "tool_1", "tool_2"]);
    const consumer = { type: "object" as const, properties: { v: { $ref: "dup#/definitions/d" } } };
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools: [{ name: "consumer", inputSchema: consumer }], schemaResources: [sibling("dup", "string"), sibling("dup", "number"), consumer], resolved }))
      .rejects.toMatchObject({ code: "MCPFN_INVALID_PROJECTED_CATALOG" });
  });

  it("compares a relative shared target when a projection changes it", async () => {
    const { buildMcpFnEffectiveCatalog } = await import("../src/client-profiles.js");
    const provider = { $id: "shared", type: "object" as const, properties: { value: { type: "string" } } };
    const consumer = { type: "object" as const, properties: { nested: { $ref: "shared#/properties/value" } } };
    const canonicalTools = [{ name: "provider", inputSchema: provider }, { name: "consumer", inputSchema: consumer }];
    await expect(buildMcpFnEffectiveCatalog({ canonicalTools, schemaResources: [provider, consumer], resolved: {
      context: undefined, extra: {} as McpFnRequestExtra, reportedClient: {}, verifiedIdentity: { subject: "trusted" },
      profile: { id: "scoped", version: "1", matches: () => true,
        projectCatalog: ({ tools }) => tools.map((tool) => tool.name === "consumer" ? { ...tool, inputSchema: { type: "object", properties: { nested: { type: "number" } } } } : tool),
      },
    } })).rejects.toThrow(/must retain its canonical schema/);
  });
});
