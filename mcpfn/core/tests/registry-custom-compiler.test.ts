import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestExtra } from "./openapi-helpers.js";

afterEach(() => {
  vi.resetModules();
});

const info = { name: "test", version: "0.0.0" };
const handler = async () => ({ content: [], structuredContent: { ok: true } });

// SFNS-107 PR round 1 (reset in round 3): a registry with a custom
// compileSchema has no closure check of its own. The compiler's acceptance is
// the proof, so a schema in its dialect lists and manifests the same whether
// it was registered first or supplied by a server declaration, and a reference
// the compiler cannot resolve is refused at registration on both paths.
describe("McpFnRegistry closure with a custom draft 2020-12 compiler", () => {
  function compiler() {
    const ajv = new Ajv2020({ strict: false });
    return (schema: object) => ajv.compile(schema);
  }
  const modern = (name: string) => ({
    name,
    description: `Draft 2020-12 tool ${name}.`,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object" as const,
      properties: { items: { type: "array", prefixItems: [{ type: "string" }] } },
    },
    handler,
  });

  it("lists and manifests a declaration-supplied tool like a pre-registered one", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
    const preRegistered = defineMcpFnServer({
      info,
      registry: new McpFnRegistry({ compileSchema: compiler() }).register(modern("t")),
    });
    const declared = defineMcpFnServer({
      info,
      registry: new McpFnRegistry({ compileSchema: compiler() }),
      tools: [modern("t")],
    });

    for (const server of [preRegistered, declared]) {
      expect(server.registry.listTools().map((tool) => tool.name)).toEqual(["t"]);
      expect(server.manifest().tools?.map((tool) => tool.name)).toEqual(["t"]);
      await expect(server.registry.callTool("t", { items: ["a"] }, undefined, requestExtra()))
        .resolves.toMatchObject({ structuredContent: { ok: true } });
      await expect(server.registry.callTool("t", { items: [1] }, undefined, requestExtra()))
        .rejects.toThrow("Invalid arguments for t");
    }
    expect(declared.registry.listTools()).toEqual(preRegistered.registry.listTools());
    expect(declared.manifest()).toEqual(preRegistered.manifest());
  });

  it("refuses an unresolved reference at registration, pre-registered or declared", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
    for (const target of ["https://test.invalid/missing", "#/$defs/missing", "#missing"]) {
      const tool = () => ({
        name: "t",
        description: "Dangling reference.",
        inputSchema: { type: "object", properties: { p: { prefixItems: [{ $ref: target }] } } } as never,
        handler,
      });
      const registry = new McpFnRegistry({ compileSchema: compiler() });
      expect(() => registry.register(tool())).toThrow("Tool t contains an invalid JSON Schema");
      expect(() => defineMcpFnServer({
        info,
        registry: new McpFnRegistry({ compileSchema: compiler() }),
        tools: [tool()],
      })).toThrow("Tool t contains an invalid JSON Schema");
      expect(registry.listTools()).toEqual([]);
    }
  });

  // Ajv 8 resolves each of these under draft-07; the registry must not judge
  // them by any walk of its own.
  const d7 = "http://json-schema.org/draft-07/schema#";
  it.each([
    ["a $ref beside a sibling $id", { $schema: d7, type: "object", properties: { a: { $ref: "child", definitions: { child: { $id: "child", type: "string" } } } } }],
    ["a $ref to a plain-name $id", { $schema: d7, type: "object", properties: { a: { $ref: "#leaf", definitions: { leaf: { $id: "#leaf", type: "string" } } } } }],
    ["no $schema and a prefixItems the compiler ignores", { type: "object", properties: { a: { prefixItems: [{ $ref: "#/definitions/missing" }] } } }],
  ])("lists and manifests a draft-07 compiler's schema with %s like a pre-registered one", (_label, schema) => {
    return (async () => {
      const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
      const draft7 = () => {
        const ajv = new Ajv({ strict: false });
        return (value: object) => ajv.compile(value);
      };
      const tool = () => ({ name: "t", description: "Draft 07.", inputSchema: structuredClone(schema) as never, handler });
      const preRegistered = defineMcpFnServer({
        info,
        registry: new McpFnRegistry({ compileSchema: draft7() }).register(tool()),
      });
      const declared = defineMcpFnServer({
        info,
        registry: new McpFnRegistry({ compileSchema: draft7() }),
        tools: [tool()],
      });

      expect(declared.registry.listTools().map((listed) => listed.name)).toEqual(["t"]);
      expect(declared.registry.listTools()).toEqual(preRegistered.registry.listTools());
      expect(declared.manifest()).toEqual(preRegistered.manifest());
    })();
  });
});

// A stateful custom compiler keeps every $id it compiled, and the registry
// cannot roll that back. When a registration fails after its input compiled,
// a retry of the same definition (or with the same input schema object) and a
// corrected output reuses that compile instead of meeting a duplicate $id, and
// the failed attempt is never listed.
describe("McpFnRegistry retry after a failed registration with a stateful custom compiler", () => {
  function statefulCompiler() {
    const ajv = new Ajv2020({ strict: false });
    const compiled: object[] = [];
    const compileSchema = (schema: object) => {
      compiled.push(schema);
      return ajv.compile(schema);
    };
    return { compileSchema, compiled };
  }
  const input = () => ({
    $id: "https://test.invalid/input",
    type: "object" as const,
    properties: { name: { type: "string" } },
    required: ["name"],
  });

  it("accepts the corrected retry and validates with the reused input compile", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const { compileSchema, compiled } = statefulCompiler();
    const registry = new McpFnRegistry({ compileSchema });
    const definition = {
      name: "t",
      description: "Broken output.",
      inputSchema: input(),
      outputSchema: { type: "object", properties: { ok: { type: "nonsense" } } } as object,
      handler,
    };

    expect(() => registry.register(definition as never)).toThrow("Tool t contains an invalid JSON Schema");
    expect(registry.listTools()).toEqual([]);
    expect(registry.schemaDefinitions()).toEqual([]);

    definition.description = "Corrected output.";
    definition.outputSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    registry.register(definition as never);
    expect(compiled).toHaveLength(3);
    expect(registry.listTools().map((tool) => tool.description)).toEqual(["Corrected output."]);
    await expect(registry.callTool("t", { name: "x" }, undefined, requestExtra()))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(registry.callTool("t", { name: 1 }, undefined, requestExtra()))
      .rejects.toThrow("Invalid arguments for t");
  });

  it("does not reuse the failed compile for a different schema", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const { compileSchema } = statefulCompiler();
    const registry = new McpFnRegistry({ compileSchema });
    expect(() => registry.register({
      name: "t",
      description: "Broken output.",
      inputSchema: input(),
      outputSchema: { type: "object", properties: { ok: { type: "nonsense" } } } as never,
      handler,
    })).toThrow("Tool t contains an invalid JSON Schema");

    // The same $id with another body still meets the compiler's own rule.
    expect(() => registry.register({
      name: "t",
      description: "Changed input.",
      inputSchema: { ...input(), required: [] },
      handler,
    })).toThrow("Tool t contains an invalid JSON Schema");
  });
});

// The nested handler tables are read once at registration: a taskHandler or
// completer added, replaced or removed afterwards changes neither execution,
// completion nor clone().
describe("McpFnRegistry nested handlers after registration", () => {
  it("keeps the registered createTask", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const registered = vi.fn(async () => ({ task: { taskId: "registered" } }));
    const replacement = vi.fn(async () => ({ task: { taskId: "replacement" } }));
    const taskHandler = { createTask: registered as (...args: unknown[]) => unknown };
    const source = new McpFnRegistry().register({
      name: "t",
      description: "Task tool.",
      inputSchema: { type: "object" },
      execution: { taskSupport: "optional" },
      handler,
      taskHandler: taskHandler as never,
    });
    taskHandler.createTask = replacement;

    for (const registry of [source, source.clone()]) {
      await registry.createToolTask("t", {}, undefined, { ...requestExtra(), taskStore: {} } as never);
    }
    expect(registered).toHaveBeenCalledTimes(2);
    expect(registered.mock.contexts[0]).toBe(taskHandler);
    expect(replacement).not.toHaveBeenCalled();
  });

  it("keeps the registered completers, and clone() accepts the registered prompt", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const topic = vi.fn(async () => ({ completion: { values: ["registered"] } }));
    const complete: Record<string, (...args: unknown[]) => unknown> = { topic };
    const source = new McpFnRegistry().registerPrompt({
      name: "p",
      arguments: [{ name: "topic" }],
      get: async () => ({ messages: [] }),
      complete: complete as never,
    });
    complete.undeclared = vi.fn(async () => ({ completion: { values: ["late"] } }));
    complete.topic = vi.fn(async () => ({ completion: { values: ["replaced"] } }));

    for (const registry of [source, source.clone()]) {
      await expect(registry.complete({ type: "ref/prompt", name: "p" }, { name: "topic", value: "" }, undefined, undefined, requestExtra()))
        .resolves.toMatchObject({ completion: { values: ["registered"] } });
      await expect(registry.complete({ type: "ref/prompt", name: "p" }, { name: "undeclared", value: "" }, undefined, undefined, requestExtra()))
        .resolves.toEqual({ completion: { values: [], total: 0, hasMore: false } });
    }
    expect(topic.mock.contexts[0]).toBe(complete);
  });
});

// Delta-review follow-ups for the round-1 repairs.
describe("McpFnRegistry custom compiler edge cases", () => {
  it("still lists a declaration-supplied draft-07 schema whose annotation carries $ref text", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
    const { createSchemaCompiler } = await import("../src/validation.js");
    const shared = createSchemaCompiler();
    const declared = defineMcpFnServer({
      info,
      registry: new McpFnRegistry({ compileSchema: (schema) => shared.compile(schema) as never }),
      tools: [{
        name: "t",
        description: "Annotated.",
        inputSchema: { type: "object", "x-documentation": { $ref: "https://docs.test.invalid/page" } } as never,
        handler,
      }],
    });

    expect(declared.registry.listTools().map((tool) => tool.name)).toEqual(["t"]);
  });

  it("retries a declaration whose output failed after its input compiled on the shared compiler", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
    const ajv = new Ajv2020({ strict: false });
    const registry = new McpFnRegistry({ compileSchema: (schema: object) => ajv.compile(schema) });
    const inputSchema = { $id: "https://test.invalid/declared", type: "object" as const };
    const tool = (ok: string) => ({
      name: "t",
      description: "Declared.",
      inputSchema,
      outputSchema: { type: "object", properties: { ok: { type: ok } } } as never,
      handler,
    });

    expect(() => defineMcpFnServer({ info, registry, tools: [tool("nonsense")] })).toThrow();
    const declared = defineMcpFnServer({ info, registry, tools: [tool("boolean")] });
    expect(declared.registry.listTools().map((listed) => listed.name)).toEqual(["t"]);
  });

  it("keeps createTask of a callable task handler and a non-enumerable completer", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const registered = vi.fn(async () => ({ task: { taskId: "registered" } }));
    const callable = Object.assign(() => undefined, { createTask: registered as (...args: unknown[]) => unknown });
    const source = new McpFnRegistry().register({
      name: "t",
      description: "Task tool.",
      inputSchema: { type: "object" },
      execution: { taskSupport: "optional" },
      handler,
      taskHandler: callable as never,
    });
    callable.createTask = vi.fn();
    await source.clone().createToolTask("t", {}, undefined, { ...requestExtra(), taskStore: {} } as never);
    expect(registered).toHaveBeenCalledTimes(1);

    const complete = {};
    Object.defineProperty(complete, "topic", {
      value: async () => ({ completion: { values: ["hidden"] } }),
      enumerable: false,
    });
    const prompts = new McpFnRegistry().registerPrompt({
      name: "p",
      arguments: [{ name: "topic" }],
      get: async () => ({ messages: [] }),
      complete: complete as never,
    });
    for (const registry of [prompts, prompts.clone()]) {
      await expect(registry.complete({ type: "ref/prompt", name: "p" }, { name: "topic", value: "" }, undefined, undefined, requestExtra()))
        .resolves.toMatchObject({ completion: { values: ["hidden"] } });
    }
  });
});

describe("McpFnRegistry custom compiler declaration retries and dynamic references", () => {
  it("retries a declaration whose later tool failed after an earlier tool was accepted", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
    const ajv = new Ajv2020({ strict: false });
    const registry = new McpFnRegistry({ compileSchema: (schema: object) => ajv.compile(schema) });
    const first = { name: "a", description: "First.", inputSchema: { $id: "https://test.invalid/first", type: "object" as const }, handler };
    const tools = (ok: string) => [
      first,
      {
        name: "b",
        description: "Second.",
        inputSchema: { type: "object" as const },
        outputSchema: { type: "object", properties: { ok: { type: ok } } } as never,
        handler,
      },
    ];

    expect(() => defineMcpFnServer({ info, registry, tools: tools("nonsense") })).toThrow();
    const declared = defineMcpFnServer({ info, registry, tools: tools("boolean") });
    expect(declared.registry.listTools().map((tool) => tool.name)).toEqual(["a", "b"]);
  });

  it("takes a permissive compiler's acceptance as final, pre-registered or declared", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
    const permissive = () => Object.assign(() => true, { errors: null });
    const tool = () => ({
      name: "t",
      description: "Dynamic reference.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { a: { $dynamicRef: "#missing" } },
      } as never,
      handler,
    });
    const preRegistered = new McpFnRegistry({ compileSchema: permissive }).register(tool());
    const declared = defineMcpFnServer({ info, registry: new McpFnRegistry({ compileSchema: permissive }), tools: [tool()] });

    expect(declared.registry.listTools().map((listed) => listed.name)).toEqual(["t"]);
    expect(declared.registry.listTools()).toEqual(preRegistered.listTools());
  });
});

// SFNS-107 PR rounds 2 and 3 (architecture resets): the custom compiler is the
// authority for `$id` uniqueness, dialect and reference resolution. Every
// registration of a schema reaches it, except the retry of a failed
// registration of the same definition or schema object, and nothing is shared
// between independent registries.
describe("McpFnRegistry custom compiler authority", () => {
  const sharedId = "https://test.invalid/shared";
  const tool = (name: string) => ({
    name,
    description: `Tool ${name}.`,
    inputSchema: { $id: sharedId, type: "object" as const },
    handler,
  });
  const ajvCompiler = () => {
    const ajv = new Ajv2020({ strict: false });
    return (schema: object) => ajv.compile(schema);
  };

  it("rejects an equal schema with a registered $id in the registry, its clone and a declaration", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
    const source = new McpFnRegistry({ compileSchema: ajvCompiler() }).register(tool("a"));

    expect(() => source.register(tool("b"))).toThrow("Tool b contains an invalid JSON Schema");
    expect(() => source.clone().register(tool("b"))).toThrow("Tool b contains an invalid JSON Schema");
    expect(() => defineMcpFnServer({ info, registry: source, tools: [tool("b")] }))
      .toThrow("Tool b contains an invalid JSON Schema");
    expect(source.listTools().map((listed) => listed.name)).toEqual(["a"]);
  });

  it("compiles an equal schema again on a registry that holds one, even after a copy registered it", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    // Accepts two schemas with one $id and rejects the third.
    const seen = new Map<unknown, number>();
    const compileSchema = vi.fn((schema: object) => {
      const id = (schema as { $id?: unknown }).$id;
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      if (count > 2) throw new Error(`schema with key or id "${String(id)}" already exists`);
      return Object.assign(() => true, { errors: null });
    });
    const source = new McpFnRegistry({ compileSchema }).register(tool("a"));
    source.clone().register(tool("b"));

    expect(() => source.register(tool("c"))).toThrow("Tool c contains an invalid JSON Schema");
    expect(compileSchema).toHaveBeenCalledTimes(3);
  });

  it("reuses a failed registration's compile for its retry while another tool holds an equal schema", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    // Accepts two schemas with one $id and rejects the third.
    const seen = new Map<unknown, number>();
    const compileSchema = vi.fn((schema: object) => {
      const id = (schema as { $id?: unknown }).$id;
      const count = (seen.get(id) ?? 0) + 1;
      seen.set(id, count);
      if (count > 2) throw new Error(`schema with key or id "${String(id)}" already exists`);
      if ((schema as { properties?: { ok?: { type?: unknown } } }).properties?.ok?.type === "nonsense") {
        throw new Error("invalid output schema");
      }
      return Object.assign(() => true, { errors: null });
    });
    const registry = new McpFnRegistry({ compileSchema }).register(tool("a"));
    const output = (type: string) => ({ type: "object", properties: { ok: { type } } }) as never;
    const retried = { ...tool("b"), outputSchema: output("nonsense") };
    expect(() => registry.register(retried)).toThrow("Tool b contains an invalid JSON Schema");

    retried.outputSchema = output("boolean");
    registry.register(retried);
    expect(() => registry.register(tool("c"))).toThrow("Tool c contains an invalid JSON Schema");
    expect(registry.listTools().map((listed) => listed.name)).toEqual(["a", "b"]);
  });

  it("compiles in each independent registry that shares one compiler", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const compileSchema = vi.fn((schema: object) => new Ajv2020({ strict: false }).compile(schema));
    new McpFnRegistry({ compileSchema }).register(tool("a"));
    new McpFnRegistry({ compileSchema }).register(tool("a"));

    expect(compileSchema).toHaveBeenCalledTimes(2);
  });

  it("rejects a further registration of a retried schema's $id", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const registry = new McpFnRegistry({ compileSchema: ajvCompiler() });
    const retried: Record<string, unknown> = {
      ...tool("t"),
      outputSchema: { type: "object", properties: { ok: { type: "nonsense" } } },
    };
    expect(() => registry.register(retried as never)).toThrow("Tool t contains an invalid JSON Schema");
    delete retried.outputSchema;
    registry.register(retried as never);

    expect(() => registry.register(tool("u"))).toThrow("Tool u contains an invalid JSON Schema");
    expect(registry.listTools().map((listed) => listed.name)).toEqual(["t"]);
  });

  const rootId = "https://test.invalid/root";
  const modern = (keyword: "prefixItems" | "dependentSchemas" | "unevaluatedProperties" | "anchor") => {
    const toRoot = { $ref: rootId };
    const applicators = {
      prefixItems: { properties: { p: { type: "array", prefixItems: [toRoot, { $ref: "#/$defs/leaf" }] } } },
      dependentSchemas: { dependentSchemas: { p: { properties: { q: toRoot } } } },
      unevaluatedProperties: { unevaluatedProperties: toRoot },
      anchor: { properties: { p: { $ref: "#leaf" } } },
    }[keyword];
    return {
      name: "t",
      description: `Draft 2020-12 ${keyword}.`,
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: rootId,
        type: "object" as const,
        $defs: { leaf: { $anchor: "leaf", type: "string" } },
        ...applicators,
      },
      handler,
    };
  };

  it.each(["prefixItems", "dependentSchemas", "unevaluatedProperties", "anchor"] as const)(
    "lists and manifests a declaration-supplied %s reference like a pre-registered one",
    async (keyword) => {
      const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
      const preRegistered = defineMcpFnServer({
        info,
        registry: new McpFnRegistry({ compileSchema: ajvCompiler() }).register(modern(keyword)),
      });
      const declared = defineMcpFnServer({
        info,
        registry: new McpFnRegistry({ compileSchema: ajvCompiler() }),
        tools: [modern(keyword)],
      });

      expect(declared.registry.listTools().map((listed) => listed.name)).toEqual(["t"]);
      expect(declared.registry.listTools()).toEqual(preRegistered.registry.listTools());
      expect(declared.manifest()).toEqual(preRegistered.manifest());
      await expect(declared.registry.callTool("t", {}, undefined, requestExtra()))
        .resolves.toMatchObject({ structuredContent: { ok: true } });
    },
  );

  const counting = () => {
    const ajv = new Ajv2020({ strict: false });
    return vi.fn((schema: object) => ajv.compile(schema));
  };
  const failing = (name: string) => ({
    ...tool(name),
    outputSchema: { type: "object", properties: { ok: { type: "nonsense" } } } as object,
  });

  it("compiles an unrelated tool's equal schema after a failed registration, and still retries it", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const compileSchema = counting();
    const registry = new McpFnRegistry({ compileSchema });
    const a = failing("a");
    expect(() => registry.register(a as never)).toThrow("Tool a contains an invalid JSON Schema");

    const before = compileSchema.mock.calls.length;
    expect(() => registry.register(tool("b"))).toThrow("Tool b contains an invalid JSON Schema");
    expect(compileSchema.mock.calls.length).toBeGreaterThan(before);
    expect(() => registry.register(failing("c") as never)).toThrow("Tool c contains an invalid JSON Schema");

    delete (a as { outputSchema?: object }).outputSchema;
    registry.register(a as never);
    expect(registry.listTools().map((listed) => listed.name)).toEqual(["a"]);
  });

  it("compiles a sibling copy's equal schema after a failed registration in another copy", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    for (const derive of ["clone", "cloneEmpty"] as const) {
      const compileSchema = counting();
      const source = new McpFnRegistry({ compileSchema });
      const first = source[derive]();
      const sibling = source[derive]();
      expect(() => first.register(failing("a") as never)).toThrow("Tool a contains an invalid JSON Schema");

      const before = compileSchema.mock.calls.length;
      expect(() => sibling.register(tool("b"))).toThrow("Tool b contains an invalid JSON Schema");
      expect(compileSchema.mock.calls.length).toBe(before + 1);
    }
  });

  it("reuses every compile of an interrupted multi-tool declaration on its retry", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await import("../src/index.js");
    const compileSchema = counting();
    const registry = new McpFnRegistry({ compileSchema });
    const plain = () => ({ type: "object" as const, properties: { v: { type: "string" } } });
    const a = { name: "a", description: "First.", inputSchema: plain(), outputSchema: plain(), handler };
    const b = { name: "b", description: "Second.", inputSchema: plain(), handler };
    const c = failing("c");

    expect(() => defineMcpFnServer({ info, registry, tools: [a, b, c as never] }))
      .toThrow("Tool c contains an invalid JSON Schema");
    expect(compileSchema).toHaveBeenCalledTimes(5);

    delete (c as { outputSchema?: object }).outputSchema;
    const declared = defineMcpFnServer({ info, registry, tools: [a, b, c as never] });
    expect(compileSchema).toHaveBeenCalledTimes(5);
    expect(declared.registry.listTools().map((listed) => listed.name)).toEqual(["a", "b", "c"]);
    await expect(declared.registry.callTool("b", { v: 1 }, undefined, requestExtra()))
      .rejects.toThrow("Invalid arguments for b");
  });
});
