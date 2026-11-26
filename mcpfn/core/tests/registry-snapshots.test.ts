import { afterEach, describe, expect, it, vi } from "vitest";

import { requestExtra } from "./openapi-helpers.js";

// The registry's contract is immutable: each accepted registration keeps
// deep-frozen snapshots of its schemas, and the registry compiles, validates
// with, advertises and copies only those. Its copies are never less
// self-contained than it is.
type Mode = "ajv" | "cfworker" | "custom";

async function load(mode: Mode, engine: "ajv" | "cfworker" = mode === "cfworker" ? "cfworker" : "ajv") {
  if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
  vi.resetModules();
  const mcpfn = await import("../src/index.js");
  const { createSchemaCompiler } = await import("../src/validation.js");
  const shared = createSchemaCompiler();
  expect(shared.engine).toBe(engine);
  const compiled: object[] = [];
  // One schema store shared by every registry that uses this compiler: it
  // resolves any `$id` it compiled before and rejects a repeated `$id`.
  const compileSchema = (schema: object) => {
    compiled.push(schema);
    return shared.compile(schema);
  };
  const options = mode === "custom" ? { compileSchema } : {};
  const registry = () => new mcpfn.McpFnRegistry(options);
  return { ...mcpfn, registry, compiled };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const info = { name: "test", version: "0.0.0" };
const handler = async () => ({ content: [], structuredContent: { ok: true } });
const objectWithId = (id: string) => ({
  $id: id,
  type: "object",
  properties: { name: { type: "string" } },
  required: ["name"],
});
const refTo = (id: string) => ({ type: "object", properties: { item: { $ref: id } }, required: ["item"] });

describe.each(["ajv", "cfworker", "custom"] as const)("McpFnRegistry schema snapshots (%s)", (mode) => {
  it("keeps advertising and enforcing the schemas it accepted after the caller edits them", async () => {
    const { registry, defineMcpFnServer, createManifest, validateManifest } = await load(mode);
    const inputSchema: Record<string, unknown> = { type: "object", properties: { a: { type: "string" } } };
    const tool: { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema?: object; handler: typeof handler } =
      { name: "t", description: "Edited later.", inputSchema, handler };
    const argumentsSchema: Record<string, unknown> = { type: "object", properties: { topic: { type: "string" } } };
    const source = registry()
      .register(tool as never)
      .registerPrompt({ name: "p", argumentsSchema: argumentsSchema as never, get: async () => ({ messages: [] }) });
    const advertised = source.listTools();
    const prompts = source.listPrompts();

    inputSchema.required = ["a"];
    (inputSchema.properties as Record<string, unknown>).a = { type: "integer" };
    tool.inputSchema = { type: "object", required: ["b"] };
    tool.outputSchema = { type: "object", required: ["x"] };
    argumentsSchema.required = ["topic"];

    const declaration = defineMcpFnServer({ info, registry: source });
    for (const copy of [source, source.clone(), declaration.registry]) {
      expect(copy.listTools()).toEqual(advertised);
      expect(copy.listTools()[0]).not.toHaveProperty("outputSchema");
      expect(copy.definitions()[0]!.inputSchema).toEqual({ type: "object", properties: { a: { type: "string" } } });
      expect(copy.listPrompts()).toEqual(prompts);
      await expect(copy.callTool("t", {}, undefined, requestExtra())).resolves.toMatchObject({ structuredContent: { ok: true } });
      await expect(copy.callTool("t", { a: "x" }, undefined, requestExtra())).resolves.toMatchObject({ structuredContent: { ok: true } });
      await expect(copy.callTool("t", { a: 1 }, undefined, requestExtra())).rejects.toThrow("Invalid arguments for t");
      await expect(copy.getPrompt("p", {}, undefined, requestExtra())).resolves.toEqual({ messages: [] });
      expect(() => validateManifest(createManifest(info, copy))).not.toThrow();
    }
    // What the registry hands out is frozen, so a listing cannot change it either.
    expect(() => {
      (source.definitions()[0]!.inputSchema as Record<string, unknown>).required = ["a"];
    }).toThrow(TypeError);
  });

  it("lets the upstream cloneEmpty() pattern replay definitions in name order", async () => {
    const { registry, compiled, createManifest, validateManifest } = await load(mode);
    const ownerId = `https://test.invalid/${mode}/owner`;
    const promptId = `https://test.invalid/${mode}/prompt`;
    const source = registry()
      .registerPrompt({
        name: "p",
        argumentsSchema: { $id: promptId, type: "object", properties: { name: { type: "string" } }, required: ["name"] } as never,
        get: async () => ({ messages: [] }),
      })
      .register({ name: "z-owner", description: "Owns the id.", inputSchema: objectWithId(ownerId) as never, handler })
      // Both refer to a schema that sorts after them, one across kinds.
      .register({ name: "a-user", description: "Refers to the owner.", inputSchema: refTo(ownerId) as never, handler })
      .register({ name: "m-prompt-user", description: "Refers to the prompt.", inputSchema: refTo(promptId) as never, handler })
      .registerResource({ uri: "test://r", name: "r", read: async () => ({ contents: [] }) });
    const compiledBefore = compiled.length;

    // 615d6f44e's consumer pattern: tools by name, then resources and prompts.
    const copy = source.cloneEmpty();
    for (const tool of source.definitions()) copy.register(tool);
    for (const resource of source.resourceDefinitions()) copy.registerResource(resource);
    for (const prompt of source.promptDefinitions()) copy.registerPrompt(prompt);
    if (mode === "custom") expect(compiled).toHaveLength(compiledBefore);

    expect(copy.listTools()).toEqual(source.listTools());
    expect(copy.listPrompts()).toEqual(source.listPrompts());
    expect(() => validateManifest(createManifest(info, copy))).not.toThrow();
    for (const target of [source, copy]) {
      for (const name of ["a-user", "m-prompt-user"]) {
        await expect(target.callTool(name, { item: { name: "x" } }, undefined, requestExtra()))
          .resolves.toMatchObject({ structuredContent: { ok: true } });
        await expect(target.callTool(name, { item: { name: 1 } }, undefined, requestExtra()))
          .rejects.toThrow(`Invalid arguments for ${name}`);
      }
      await expect(target.getPrompt("p", {}, undefined, requestExtra())).rejects.toThrow("Invalid arguments for prompt p");
    }
  });

  it("registers tools that share one schema object with an $id", async () => {
    const { registry, defineMcpFnServer } = await load(mode);
    const sharedSchema = objectWithId(`https://test.invalid/${mode}/shared-object`);
    const source = registry()
      .register({ name: "a", description: "First user.", inputSchema: sharedSchema as never, handler })
      .register({ name: "b", description: "Second user.", inputSchema: sharedSchema as never, handler });
    for (const copy of [source, source.clone(), defineMcpFnServer({ info, registry: source }).registry]) {
      expect(copy.listTools().map((tool) => tool.name)).toEqual(["a", "b"]);
      await expect(copy.callTool("b", { name: 1 }, undefined, requestExtra())).rejects.toThrow("Invalid arguments for b");
    }
  });

  it("rejects schema data that cannot be copied, leaving no partial state", async () => {
    const { registry, McpFnValidationError } = await load(mode);
    const source = registry();
    const withFunction = { type: "object", properties: { a: { type: "string", default: () => "a" } } };
    expect(() => source.register({ name: "t", description: "Has a function.", inputSchema: withFunction as never, handler }))
      .toThrow(McpFnValidationError);
    expect(() => source.register({ name: "t", description: "Has a function.", inputSchema: withFunction as never, handler }))
      .toThrow("Tool t inputSchema must be JSON data");
    expect(() => source.registerPrompt({ name: "p", argumentsSchema: withFunction as never, get: async () => ({ messages: [] }) }))
      .toThrow("Prompt p argumentsSchema must be JSON data");
    expect(source.has("t")).toBe(false);
    expect(source.listPrompts()).toEqual([]);
    expect(source.schemaDefinitions()).toEqual([]);
    source.register({ name: "t", description: "Plain now.", inputSchema: { type: "object" } as never, handler });
    expect(source.clone().listTools().map((tool) => tool.name)).toEqual(["t"]);
  });
});

// A custom compiler is shared and opaque: it may resolve a `$id` that the copy
// never registered. A copy of a self-contained source refuses to expose that.
describe.each(["ajv", "cfworker"] as const)("McpFnRegistry copies over a shared custom store (%s)", (engine) => {
  it("refuses a cloneEmpty() copy that refers to a source-only $id", async () => {
    const { registry, McpFnValidationError, createManifest, defineMcpFnServer, createMcpFnServer } = await load("custom", engine);
    const ownerId = `https://test.invalid/${engine}/source-only`;
    const source = registry().register({ name: "owner", description: "Owns the id.", inputSchema: objectWithId(ownerId) as never, handler });
    const copy = source.cloneEmpty()
      .register({ name: "user", description: "Refers to the source.", inputSchema: refTo(ownerId) as never, handler });
    for (const expose of [
      () => copy.definitions(),
      () => copy.promptDefinitions(),
      () => copy.schemaDefinitions(),
      () => copy.clone(),
      () => createManifest(info, copy),
      () => defineMcpFnServer({ info, registry: copy }),
      () => createMcpFnServer({ info, registry: copy }),
    ]) {
      expect(expose).toThrow(McpFnValidationError);
      expect(expose).toThrow("Registry schema collection is not self-contained");
    }
  });

  it("refuses a clone that refers to a $id the source registered after clone()", async () => {
    const { registry, McpFnValidationError, createManifest } = await load("custom", engine);
    const source = registry()
      .register({ name: "base", description: "Plain.", inputSchema: { type: "object" } as never, handler });
    const replayed = source.clone();
    const laterId = `https://test.invalid/${engine}/source-later`;
    source.register({ name: "later", description: "Registered after clone().", inputSchema: objectWithId(laterId) as never, handler });
    replayed.register({ name: "user", description: "Refers to the later id.", inputSchema: refTo(laterId) as never, handler });
    expect(() => replayed.listTools()).toThrow(McpFnValidationError);
    expect(() => createManifest(info, replayed)).toThrow("Registry schema collection is not self-contained");
    // The source itself stays self-contained and usable.
    expect(source.listTools().map((tool) => tool.name)).toEqual(["base", "later"]);
  });
});

describe("McpFnRegistry custom validator promise results", () => {
  async function withUnhandledRejections(run: () => Promise<void>) {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }

  class SubPromise<T> extends Promise<T> {}

  function shadowedThen(message: string): Promise<never> {
    const promise = Promise.reject(new Error(message));
    Object.defineProperty(promise, "then", { value: undefined });
    return promise;
  }

  const results: Array<[string, () => unknown]> = [
    ["a rejected promise whose own then is undefined", () => shadowedThen("shadowed")],
    ["a rejected Promise subclass instance", () => SubPromise.reject(new Error("subclass"))],
  ];

  it.each(results)("fails a validator returning %s closed with no unhandled rejection", async (_label, result) => {
    const { McpFnRegistry } = await import("../src/index.js");
    await withUnhandledRejections(async () => {
      const handled = vi.fn(async () => ({ content: [] }));
      const registry = new McpFnRegistry({ compileSchema: () => (() => result()) as never })
        .register({ name: "t", description: "Promise validator.", inputSchema: { type: "object" }, handler: handled });
      await expect(registry.callTool("t", {}, undefined, requestExtra())).rejects.toThrow("Invalid arguments for t");
      expect(handled).not.toHaveBeenCalled();
    });
  });

  it.each(results)("rejects a compiler returning %s with no unhandled rejection", async (_label, result) => {
    const { McpFnRegistry } = await import("../src/index.js");
    await withUnhandledRejections(async () => {
      const registry = new McpFnRegistry({ compileSchema: () => result() as never });
      let thrown: unknown;
      try {
        registry.register({ name: "t", description: "Promise compiler.", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        message: "Tool t contains an invalid JSON Schema",
        details: { cause: "compileSchema must return a validator function" },
      });
      expect(registry.has("t")).toBe(false);
    });
  });

  it("fails closed on a promise whose constructor getter throws", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    // No JavaScript code can mark this promise handled: the intrinsic then()
    // reads `constructor` first. The getter throws once, so the test can
    // handle the rejection afterwards; only the fail-closed result is asserted.
    const promise = Promise.reject(new Error("species"));
    let thrown = false;
    Object.defineProperty(promise, "constructor", {
      get() {
        if (thrown) return Promise;
        thrown = true;
        throw new Error("constructor getter");
      },
    });
    const registry = new McpFnRegistry({ compileSchema: () => (() => promise) as never })
      .register({ name: "t", description: "Hostile promise.", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) });
    await expect(registry.callTool("t", {}, undefined, requestExtra())).rejects.toMatchObject({
      message: "Invalid arguments for t",
      details: { issues: [expect.objectContaining({ message: "compileSchema validators must be synchronous" })] },
    });
    Promise.prototype.then.call(promise, undefined, () => undefined);
  });
});
