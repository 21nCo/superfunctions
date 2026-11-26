import { afterEach, describe, expect, it, vi } from "vitest";

import { requestExtra } from "./openapi-helpers.js";

// A registry reuses an accepted schema entry only for the same object: the
// registry-issued snapshot or the unchanged caller object. Any other schema
// meets the copy's engine, which holds the source's accepted snapshots, so a
// copy accepts and rejects exactly what the source would.
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
const rootId = "https://test.invalid/root";
const withRootId = () => ({ $id: rootId, type: "object", properties: { name: { type: "string" } }, required: ["name"] });
const refTo = (id: string) => ({ type: "object", properties: { item: { $ref: id } }, required: ["item"] });

type Outcome = "ok" | string;
function outcome(run: () => unknown): Outcome {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
}

describe.each(["ajv", "cfworker"] as const)("McpFnRegistry schema identity on copies (%s)", (mode) => {
  // Each case registers tool a with the string variant, then tool b with the
  // number variant of the same local id on a copy.
  const cases: Array<[string, (type: string) => object]> = [
    ["a document-local anchor", (type) => ({
      type: "object", properties: { v: { $ref: "#node" } }, definitions: { q: { $id: "#node", type } },
    })],
    ["a nested relative id", (type) => ({ type: "object", properties: { v: { $id: "item", type } } })],
    ["an $id inside const data", (type) => ({
      type: "object", properties: { v: { const: { $id: "https://test.invalid/data", type } } },
    })],
  ];

  it.each(cases)("registers %s on clone(), cloneEmpty() and a declaration exactly as on a fresh source", async (_label, schema) => {
    const { registry, defineMcpFnServer, createManifest, validateManifest } = await load(mode);
    const tool = (name: string, type: string) => ({ name, description: name, inputSchema: schema(type), handler });
    // cfworker already rejects a repeated nested relative id on one registry;
    // a copy must give whatever a fresh source gives.
    const fresh = outcome(() => registry().register(tool("a", "string")).register(tool("b", "number")));
    if (mode === "ajv") expect(fresh).toBe("ok");
    const source = () => registry().register(tool("a", "string"));
    const copies: Array<[string, () => unknown]> = [
      ["clone", () => source().clone().register(tool("b", "number"))],
      ["cloneEmpty", () => source().cloneEmpty().register(tool("b", "number"))],
      ["declaration", () => defineMcpFnServer({ info, registry: source(), tools: [tool("b", "number")] })],
    ];
    for (const [, copy] of copies) expect(outcome(copy)).toBe(fresh);
    if (fresh !== "ok") return;
    const declaration = defineMcpFnServer({ info, registry: source(), tools: [tool("b", "number")] });
    expect(() => validateManifest(createManifest(info, declaration.registry))).not.toThrow();
  });

  it("rejects a separately built equal root-$id schema on the source and on clone() and cloneEmpty() copies", async () => {
    const { registry, McpFnValidationError } = await load(mode);
    const source = registry().register({ name: "a", description: "Owns the id.", inputSchema: withRootId(), handler });
    for (const target of [source.clone(), source.cloneEmpty(), source]) {
      expect(() => target.register({ name: "a2", description: "Equal copy.", inputSchema: withRootId(), handler }))
        .toThrow(McpFnValidationError);
      expect(() => target.register({ name: "a2", description: "Equal copy.", inputSchema: withRootId(), handler }))
        .toThrow("Tool a2 contains an invalid JSON Schema");
      expect(target.has("a2")).toBe(false);
    }
  });

  it("accepts one schema object shared by several tools and the upstream replay pattern, with valid manifests", async () => {
    const { registry, createManifest, validateManifest } = await load(mode);
    const shared = withRootId();
    // As on dev, several tools may register one schema object with an $id
    // (their joint manifest repeating the $id is a known dev limitation).
    const sharing = registry()
      .register({ name: "a", description: "Owns the id.", inputSchema: shared, handler })
      .register({ name: "a2", description: "Same object.", inputSchema: shared, handler });
    expect(sharing.clone().listTools().map((tool) => tool.name)).toEqual(["a", "a2"]);

    const source = registry()
      .register({ name: "a", description: "Owns the id.", inputSchema: shared, handler })
      .register({ name: "b", description: "Refers to it.", inputSchema: refTo(rootId), handler });
    const viaCloneEmpty = source.cloneEmpty()
      .register({ name: "b", description: "Registered first.", inputSchema: refTo(rootId), handler })
      .register({ name: "a3", description: "Same object.", inputSchema: shared, handler });
    const replayed = source.cloneEmpty();
    for (const tool of source.definitions()) replayed.register(tool);
    for (const target of [source, source.clone(), viaCloneEmpty, replayed]) {
      expect(() => validateManifest(createManifest(info, target))).not.toThrow();
    }
    await expect(replayed.callTool("b", { item: { name: 1 } }, undefined, requestExtra()))
      .rejects.toThrow("Invalid arguments for b");
  });
});

describe.each(["ajv", "cfworker", "custom"] as const)("McpFnRegistry copy gates and registration (%s)", (mode) => {
  it("keeps a copy of a gated copy gated through chained cloneEmpty()", async () => {
    const { registry, McpFnValidationError, createManifest, defineMcpFnServer } = await load(mode);
    const consumer = { name: "b", description: "Refers to a.", inputSchema: refTo(rootId), handler };
    const source = registry().register({ name: "a", description: "Owns the id.", inputSchema: withRootId(), handler });
    const middle = source.cloneEmpty();
    middle.register(consumer);
    const grandchild = middle.cloneEmpty();
    grandchild.register(consumer);
    for (const expose of [
      () => grandchild.definitions(),
      () => createManifest(info, grandchild),
      () => defineMcpFnServer({ info, registry: grandchild }),
    ]) {
      expect(expose).toThrow(McpFnValidationError);
      expect(expose).toThrow("Registry schema collection is not self-contained");
    }
  });

  type Registry = ReturnType<Awaited<ReturnType<typeof load>>["registry"]>;
  const inner = (target: Registry) =>
    target.register({ name: "inner", description: "Inner.", inputSchema: { type: "object" }, handler });

  it.each(["propagate", "swallow"] as const)(
    "refuses registration from a schema proxy trap or definition getter run during a registration (%s)",
    async (policy) => {
      const { McpFnValidationError, registry } = await load(mode);
      const source = registry();
      const errors: unknown[] = [];
      const reenter = () => {
        try {
          inner(source);
        } catch (error) {
          errors.push(error);
          if (policy === "propagate") throw error;
        }
      };
      // Schema data must be plain JSON data (an accessor is refused unread),
      // but a Proxy around a plain object still runs caller code as it is read.
      const schemaWithGetter = (title: string) => new Proxy({ type: "object", title, properties: {} }, {
        ownKeys(target) {
          reenter();
          return Reflect.ownKeys(target);
        },
      });
      const definitionWithGetter = <T extends object>(definition: T) => Object.defineProperty(definition, "title", {
        enumerable: true,
        get() {
          reenter();
          return "Title";
        },
      });
      const outcomes = [
        outcome(() => source.register({ name: "tool-schema", description: "Getter.", inputSchema: schemaWithGetter("t1") as never, handler })),
        outcome(() => source.register(definitionWithGetter({ name: "tool-view", description: "Getter.", inputSchema: { type: "object" }, handler }) as never)),
        outcome(() => source.registerPrompt({ name: "prompt-schema", argumentsSchema: schemaWithGetter("p1") as never, get: async () => ({ messages: [] }) })),
        outcome(() => source.registerPrompt(definitionWithGetter({ name: "prompt-view", get: async () => ({ messages: [] }) }) as never)),
      ];
      expect(errors).toHaveLength(4);
      for (const error of errors) {
        expect(error).toBeInstanceOf(McpFnValidationError);
        expect((error as Error).message).toBe("Cannot register an MCP tool while this registry is registering another definition");
      }
      expect(source.has("inner")).toBe(false);
      if (policy === "propagate") {
        expect(outcomes.every((result) => result !== "ok")).toBe(true);
        expect(source.listTools()).toEqual([]);
        expect(source.listPrompts()).toEqual([]);
      } else {
        expect(outcomes).toEqual(["ok", "ok", "ok", "ok"]);
        expect(source.listTools().map((tool) => tool.name)).toEqual(["tool-schema", "tool-view"]);
        expect(source.listPrompts().map((prompt) => prompt.name)).toEqual(["prompt-schema", "prompt-view"]);
      }
      const copy = source.clone();
      expect(copy.listTools()).toEqual(source.listTools());
      expect(copy.listPrompts()).toEqual(source.listPrompts());
    },
  );

  it("advertises frozen views that cannot change listings, manifests or validation", async () => {
    const { registry, createManifest } = await load(mode);
    const source = registry().register({
      name: "t", description: "Frozen.", inputSchema: { type: "object", properties: { a: { type: "string" } } }, handler,
    });
    const listed = source.listTools();
    const manifest = JSON.stringify(createManifest(info, source));
    const view = source.definitions()[0] as unknown as Record<string, unknown>;
    expect(() => { view.inputSchema = { type: "object", required: ["a"] }; }).toThrow(TypeError);
    expect(() => { view.outputSchema = { type: "object" }; }).toThrow(TypeError);
    expect(source.listTools()).toEqual(listed);
    expect(JSON.stringify(createManifest(info, source))).toBe(manifest);
    await expect(source.callTool("t", {}, undefined, requestExtra())).resolves.toMatchObject({ structuredContent: { ok: true } });
  });

  it("advertises no output schema from a prototype getter, matching hasOutputSchema", async () => {
    const { registry, createManifest } = await load(mode);
    let output: object | undefined;
    class Tool {
      name = "t";
      description = "Prototype getter.";
      inputSchema = { type: "object" as const };
      handler = handler;
      get outputSchema() {
        return output;
      }
    }
    const source = registry().register(new Tool() as never);
    output = { type: "object", properties: { y: { type: "string" } }, required: ["y"] };
    expect(source.hasOutputSchema("t")).toBe(false);
    expect(source.definitions()[0]!.outputSchema).toBeUndefined();
    expect(source.listTools()[0]).not.toHaveProperty("outputSchema");
    expect(createManifest(info, source).tools[0]).not.toHaveProperty("outputSchema");
    expect(source.clone().listTools()).toEqual(source.listTools());
  });

  it("keeps listTools() and taskSupport() in agreement after the caller replaces execution", async () => {
    const { registry } = await load(mode);
    const definition = {
      name: "t",
      description: "Task tool.",
      inputSchema: { type: "object" as const },
      execution: { taskSupport: "optional" as const },
      handler,
      taskHandler: { createTask: vi.fn(), getTask: vi.fn(), getTaskResult: vi.fn() } as never,
    };
    const source = registry().register(definition);
    (definition as { execution: unknown }).execution = { taskSupport: "forbidden" };
    expect(source.listTools()[0]!.execution).toEqual({ taskSupport: "optional" });
    expect(source.taskSupport("t")).toBe("optional");
    expect(source.capabilities().tasks).toBeDefined();
  });
});
