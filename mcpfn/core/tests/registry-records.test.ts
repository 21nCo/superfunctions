import { afterEach, describe, expect, it, vi } from "vitest";

import { requestExtra } from "./openapi-helpers.js";

// Each accepted tool or prompt is a record: the caller definition (the only
// receiver its handlers run on) and a frozen view of the fields read once at
// registration. Listings, manifests, clones and declarations use the record and
// never re-read the caller definition, so no caller code runs during a copy and
// every copy advertises exactly the source's contract.
type Mode = "ajv" | "cfworker" | "custom";

async function load(mode: Mode) {
  const engine = mode === "cfworker" ? "cfworker" : "ajv";
  if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
  vi.resetModules();
  const mcpfn = await import("../src/index.js");
  const { createSchemaCompiler } = await import("../src/validation.js");
  const shared = createSchemaCompiler();
  expect(shared.engine).toBe(engine);
  const options = mode === "custom" ? { compileSchema: (schema: object) => shared.compile(schema) } : {};
  const registry = () => new mcpfn.McpFnRegistry(options);
  return { ...mcpfn, registry };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const info = { name: "test", version: "0.0.0" };
const handler = async () => ({ content: [], structuredContent: { ok: true } });

class PrivateTool {
  #description = "Private description.";
  #answer = "private-answer";
  name = "private-tool";
  inputSchema = { type: "object" as const, properties: { q: { type: "string" } } };
  get description() {
    return this.#description;
  }
  async handler() {
    return { content: [], structuredContent: { answer: this.#answer } };
  }
}

class PrivatePrompt {
  #title = "Private title";
  #text = "private-text";
  name = "private-prompt";
  arguments = [{ name: "topic", required: true }];
  get title() {
    return this.#title;
  }
  async get(args: Record<string, string>) {
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text: `${this.#text}:${args.topic}` } }] };
  }
}

describe.each(["ajv", "cfworker", "custom"] as const)("McpFnRegistry definition records (%s)", (mode) => {
  type Registry = ReturnType<Awaited<ReturnType<typeof load>>["registry"]>;

  async function expectPrivateRecords(registry: Registry, createManifest: (info: { name: string; version: string }, registry: Registry) => { tools: unknown[]; prompts: unknown[] }) {
    expect(registry.listTools()).toEqual([
      { name: "private-tool", description: "Private description.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ]);
    expect(registry.listPrompts()).toEqual([
      { name: "private-prompt", title: "Private title", arguments: [{ name: "topic", required: true }] },
    ]);
    const manifest = createManifest(info, registry);
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.prompts).toHaveLength(1);
    await expect(registry.callTool("private-tool", { q: "x" }, undefined, requestExtra()))
      .resolves.toMatchObject({ structuredContent: { answer: "private-answer" } });
    await expect(registry.getPrompt("private-prompt", { topic: "t" }, undefined, requestExtra()))
      .resolves.toMatchObject({ messages: [{ content: { text: "private-text:t" } }] });
  }

  it("serves class definitions with private fields on the source, clone(), a declaration and the cloneEmpty() replay", async () => {
    const { registry, createManifest, defineMcpFnServer, validateManifest } = await load(mode);
    const source = registry().register(new PrivateTool() as never).registerPrompt(new PrivatePrompt() as never);
    const replay = source.cloneEmpty();
    for (const definition of source.definitions()) replay.register(definition);
    for (const definition of source.promptDefinitions()) replay.registerPrompt(definition);
    const declaration = defineMcpFnServer({ info, registry: source });
    for (const copy of [source, source.clone(), declaration.registry, replay, replay.clone()]) {
      await expectPrivateRecords(copy, createManifest as never);
      expect(() => validateManifest(createManifest(info, copy))).not.toThrow();
    }
    expect(declaration.manifest().tools).toEqual(createManifest(info, source).tools);
    // A view's handler and get() are bound to the caller definition.
    const [tool] = source.definitions();
    await expect(tool!.handler({}, undefined, requestExtra())).resolves.toMatchObject({ structuredContent: { answer: "private-answer" } });
    const [prompt] = source.promptDefinitions();
    await expect(prompt!.get({ topic: "d" }, undefined, requestExtra())).resolves.toMatchObject({ messages: [{ content: { text: "private-text:d" } }] });
  });

  it("runs no caller getter during clone(), so a getter cannot register on the source mid-clone", async () => {
    const { registry, defineMcpFnServer } = await load(mode);
    const source = registry();
    let armed = false;
    const title = vi.fn(() => {
      if (armed) source.register({ name: "late", description: "Registered by a getter.", inputSchema: { type: "object" }, handler });
      return "Title";
    });
    const definition = Object.defineProperty(
      { name: "t", description: "Getter title.", inputSchema: { type: "object" as const }, handler },
      "title",
      { enumerable: true, get: title },
    );
    source.register(definition as never);
    expect(title).toHaveBeenCalledTimes(1);
    armed = true;
    const copy = source.clone();
    const declared = defineMcpFnServer({ info, registry: source });
    expect(title).toHaveBeenCalledTimes(1);
    expect(source.has("late")).toBe(false);
    expect(copy.listTools()).toEqual(source.listTools());
    expect(declared.registry.listTools()).toEqual(source.listTools());
    expect(source.listTools()[0]).toMatchObject({ title: "Title" });
  });

  it("advertises the registered description and task support after the caller edits them in place", async () => {
    const { registry, defineMcpFnServer, createManifest } = await load(mode);
    const definition = {
      name: "t",
      description: "Registered.",
      inputSchema: { type: "object" as const },
      execution: { taskSupport: "optional" as "optional" | "forbidden" },
      handler,
      taskHandler: { createTask: vi.fn(), getTask: vi.fn(), getTaskResult: vi.fn() } as never,
    };
    const source = registry().register(definition);
    const listed = source.listTools();
    definition.description = "Edited.";
    definition.execution.taskSupport = "forbidden";
    const copies = [source, source.clone(), defineMcpFnServer({ info, registry: source }).registry];
    for (const copy of copies) {
      expect(copy.listTools()).toEqual(listed);
      expect(copy.listTools()[0]).toMatchObject({ description: "Registered.", execution: { taskSupport: "optional" } });
      expect(copy.taskSupport("t")).toBe("optional");
      expect(copy.capabilities().tasks).toBeDefined();
      expect(createManifest(info, copy).tools).toEqual(createManifest(info, source).tools);
    }
  });

  it("rejects a function root as a schema or execution before compiling", async () => {
    const mcpfn = await load(mode);
    const { createSchemaCompiler } = await import("../src/validation.js");
    const shared = createSchemaCompiler();
    const compileSchema = vi.fn((schema: object) => shared.compile(schema));
    const source = mode === "custom" ? new mcpfn.McpFnRegistry({ compileSchema }) : mcpfn.registry();
    const objectSchema = { type: "object" as const };
    // A function root is not JSON data (JSON.stringify drops it), so it fails
    // like a nested non-JSON value instead of staying live in the listing.
    const fn = <T extends object>(fields: T) => Object.assign(function schemaLike() {}, fields);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["inputSchema", { inputSchema: fn({ type: "object" }) }, "Tool t inputSchema must be JSON data"],
      ["outputSchema", { inputSchema: objectSchema, outputSchema: fn({ type: "object" }) }, "Tool t outputSchema must be JSON data"],
      ["execution", { inputSchema: objectSchema, execution: fn({ taskSupport: "optional" }), taskHandler: handler }, "Tool t execution must be JSON data"],
    ];
    for (const [label, fields, message] of cases) {
      const register = () => source.register({ name: "t", description: label, handler, ...fields } as never);
      expect(register, label).toThrow(mcpfn.McpFnValidationError);
      expect(register, label).toThrow(message);
    }
    expect(() => source.registerPrompt({ name: "p", argumentsSchema: fn({ type: "object" }) as never, get: async () => ({ messages: [] }) }))
      .toThrow("Prompt p argumentsSchema must be JSON data");
    expect(compileSchema).not.toHaveBeenCalled();
    expect(source.listTools()).toEqual([]);
    expect(source.listPrompts()).toEqual([]);
  });

  it("rejects schema data that is not plain JSON before compiling", async () => {
    const { registry, McpFnValidationError } = await load(mode);
    const source = registry();
    const nonJson: Array<[string, unknown]> = [
      ["Date", { type: "object", properties: { at: { type: "string", default: new Date(0) } } }],
      ["Map", { type: "object", properties: { m: { type: "string", examples: new Map() } } }],
      ["RegExp", { type: "object", properties: { s: { type: "string", default: /x/ } } }],
      ["typed array", { type: "object", properties: { s: { type: "array", default: new Uint8Array(1) } } }],
      ["class instance", { type: "object", properties: { s: new (class Schema { type = "string"; })() } }],
      ["non-finite number", { type: "object", properties: { n: { type: "number", maximum: Number.POSITIVE_INFINITY } } }],
      ["accessor", Object.defineProperty({ type: "object" }, "properties", { enumerable: true, get: () => ({}) })],
    ];
    for (const [label, inputSchema] of nonJson) {
      const register = () => source.register({ name: "t", description: label, inputSchema: inputSchema as never, handler });
      expect(register, label).toThrow(McpFnValidationError);
      expect(register, label).toThrow("Tool t inputSchema must be JSON data");
      expect(() => source.registerPrompt({ name: "p", argumentsSchema: inputSchema as never, get: async () => ({ messages: [] }) }), label)
        .toThrow("Prompt p argumentsSchema must be JSON data");
    }
    const circular: Record<string, unknown> = { type: "object" };
    circular.properties = { self: circular };
    expect(() => source.register({ name: "t", description: "Circular.", inputSchema: circular as never, handler }))
      .toThrow("Tool t inputSchema must be JSON data");
    expect(source.listTools()).toEqual([]);
    expect(source.schemaDefinitions()).toEqual([]);
    // Plain JSON still registers; a shared (non-circular) subschema is fine, and
    // an undefined property is left out as JSON.stringify does.
    const shared = { type: "string" };
    source.register({
      name: "t",
      description: "Plain.",
      inputSchema: { type: "object", description: undefined, properties: { a: shared, b: shared } } as never,
      handler,
    });
    expect(source.definitions()[0]!.inputSchema).toEqual({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } } });
    expect(Object.hasOwn(source.definitions()[0]!.inputSchema, "description")).toBe(false);
  });
});
