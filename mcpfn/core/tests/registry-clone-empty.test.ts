import { afterEach, describe, expect, it, vi } from "vitest";

import { requestExtra } from "./openapi-helpers.js";

// cloneEmpty() (ported from 615d6f44e) returns a self-contained registry: a
// fresh built-in compiler that received no source compiles, so every `$ref` a
// copy makes must resolve to a schema registered on the copy and its manifest
// validates on its own. No registration leaks in either direction.
describe.each(["ajv", "cfworker"] as const)("McpFnRegistry.cloneEmpty() with the built-in %s compiler", (engine) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
    vi.resetModules();
    const { McpFnRegistry, McpFnValidationError, structuredResult, createManifest, validateManifest, defineMcpFnServer } =
      await import("../src/index.js");
    const { createSchemaCompiler } = await import("../src/validation.js");
    expect(createSchemaCompiler().engine).toBe(engine);
    return { McpFnRegistry, McpFnValidationError, structuredResult, createManifest, validateManifest, defineMcpFnServer };
  }

  const info = { name: "test", version: "0.0.0" };
  const sharedId = "https://test.invalid/shared";
  const sharedSchema = {
    $id: sharedId,
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  const refTo = (id: string) => ({ type: "object", properties: { item: { $ref: id } }, required: ["item"] });

  it("rejects a $ref to a source $id that was not re-registered on the copy", async () => {
    const { McpFnRegistry, McpFnValidationError, structuredResult } = await load();
    const handler = async () => structuredResult({ ok: true });
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: sharedSchema, handler })
      .registerPrompt({ name: "p", get: async () => ({ messages: [] }) });

    const empty = source.cloneEmpty();
    expect(empty.listTools()).toEqual([]);
    expect(empty.listPrompts()).toEqual([]);
    expect(empty.definitions()).toEqual([]);
    expect(empty.promptDefinitions()).toEqual([]);
    expect(empty.schemaDefinitions()).toEqual([]);

    expect(() => empty.register({ name: "b", description: "Refers to the shared schema.", inputSchema: refTo(sharedId), handler }))
      .toThrow(McpFnValidationError);
    expect(empty.has("b")).toBe(false);
    // The failed registration does not reach the source either.
    expect(source.has("b")).toBe(false);
  });

  it("keeps the 615d6f44e pattern valid: re-registering source definitions gives a valid manifest", async () => {
    const { McpFnRegistry, structuredResult, createManifest, validateManifest } = await load();
    const handler = async () => structuredResult({ ok: true });
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: sharedSchema, handler })
      .register({ name: "b", description: "Refers to it.", inputSchema: refTo(sharedId), handler })
      .registerPrompt({ name: "p", arguments: [{ name: "topic" }], get: async () => ({ messages: [] }) });

    const copy = source.cloneEmpty();
    for (const tool of source.definitions()) copy.register(tool);
    for (const prompt of source.promptDefinitions()) copy.registerPrompt(prompt);
    expect(copy.listTools().map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(copy.schemaDefinitions()).toEqual(source.schemaDefinitions());

    await expect(copy.callTool("b", { item: { name: "x" } }, undefined, requestExtra()))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(copy.callTool("b", { item: { name: 1 } }, undefined, requestExtra()))
      .rejects.toThrow("Invalid arguments for b");
    expect(() => validateManifest(createManifest(info, copy))).not.toThrow();
  });

  it("gives a declaration over a cloneEmpty() registry a valid manifest", async () => {
    const { McpFnRegistry, structuredResult, defineMcpFnServer, validateManifest } = await load();
    const handler = async () => structuredResult({ ok: true });
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: sharedSchema, handler });
    const ownId = "https://test.invalid/own";
    const empty = source.cloneEmpty()
      .register({ name: "own", description: "Owns a schema.", inputSchema: { ...sharedSchema, $id: ownId }, handler })
      .register({ name: "b", description: "Refers to it.", inputSchema: refTo(ownId), handler });
    const declaration = defineMcpFnServer({ info, registry: empty });
    expect(declaration.registry.listTools().map((tool) => tool.name)).toEqual(["b", "own"]);
    expect(() => validateManifest(declaration.manifest())).not.toThrow();
    // clone() of the copy replays only the copy's own registrations.
    expect(empty.clone().listTools().map((tool) => tool.name)).toEqual(["b", "own"]);
  });

  it("leaks no registration in either direction", async () => {
    const { McpFnRegistry, structuredResult } = await load();
    const handler = async () => structuredResult({ ok: true });
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: sharedSchema, handler });
    const empty = source.cloneEmpty();

    // The source $id registers on the copy without a duplicate-id collision.
    empty.register({ name: "a", description: "Same id on the copy.", inputSchema: { ...sharedSchema }, handler });

    const cloneOnlyId = "https://test.invalid/clone-only";
    empty.register({ name: "c", description: "Clone-only schema.", inputSchema: { ...sharedSchema, $id: cloneOnlyId }, handler });
    expect(() => source.register({ name: "d", description: "Unknown ref.", inputSchema: refTo(cloneOnlyId), handler }))
      .toThrow("invalid JSON Schema");
    source.register({ name: "c", description: "Same id on the source.", inputSchema: { ...sharedSchema, $id: cloneOnlyId }, handler });

    const sourceLaterId = "https://test.invalid/source-later";
    source.register({ name: "e", description: "Later source schema.", inputSchema: { ...sharedSchema, $id: sourceLaterId }, handler });
    expect(() => empty.register({ name: "f", description: "Unknown ref.", inputSchema: refTo(sourceLaterId), handler }))
      .toThrow("invalid JSON Schema");
    expect(source.listTools().map((tool) => tool.name)).toEqual(["a", "c", "e"]);
    expect(empty.listTools().map((tool) => tool.name)).toEqual(["a", "c"]);
  });
});

// clone() keeps the dev contract: a fresh built-in compiler (or the shared
// custom compiler) replays every successful registration with its live
// definition, in registration order. Failed registrations are not replayed, so
// a definition that only resolved through their compiler residue fails loudly
// at clone() and at declaration time, as on dev. cloneEmpty() replays nothing.
describe.each(["ajv", "cfworker"] as const)("McpFnRegistry.clone() with the built-in %s compiler", (engine) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
    vi.resetModules();
    const { McpFnRegistry, McpFnValidationError, structuredResult, defineMcpFnServer } = await import("../src/index.js");
    const { createSchemaCompiler } = await import("../src/validation.js");
    expect(createSchemaCompiler().engine).toBe(engine);
    return { McpFnRegistry, McpFnValidationError, structuredResult, defineMcpFnServer, createSchemaCompiler };
  }

  const info = { name: "test", version: "0.0.0" };
  const handler = async () => ({ content: [], structuredContent: { ok: true } });
  const invalidOutput = () => ({ type: "object", properties: { a: { type: "not-a-type" } } });
  const objectWithId = (id: string) => ({
    $id: id,
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  const refTo = (id: string) => ({ type: "object", properties: { item: { $ref: id } }, required: ["item"] });

  type Registry = InstanceType<Awaited<ReturnType<typeof load>>["McpFnRegistry"]>;

  async function expectNameValidates(registry: Registry, tool: string) {
    await expect(registry.callTool(tool, { name: "x" }, undefined, requestExtra()))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(registry.callTool(tool, { name: 1 }, undefined, requestExtra()))
      .rejects.toThrow(`Invalid arguments for ${tool}`);
  }

  it("clones a tool whose $id input was edited in place before a successful retry", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await load();
    const inputSchema: Record<string, unknown> = objectWithId("https://test.invalid/edited-in-place");
    const definition = { name: "t", description: "Valid input, invalid output.", inputSchema, outputSchema: invalidOutput() as object, handler };
    const source = new McpFnRegistry();
    expect(() => source.register(definition)).toThrow("invalid JSON Schema");
    // Same object, same $id, edited in place; then the output is fixed.
    inputSchema.title = "Edited";
    definition.outputSchema = { type: "object" };
    if (engine === "cfworker") {
      // cfworker keeps the $id from the input's successful compile and rejects
      // it again (same on dev); there is nothing more to clone.
      expect(() => source.register(definition)).toThrow("invalid JSON Schema");
      expect(source.clone().listTools()).toEqual([]);
      return;
    }
    source.register(definition);

    const replayed = source.clone();
    const declaration = defineMcpFnServer({ info, registry: source });
    for (const registry of [source, replayed, declaration.registry]) {
      expect(registry.listTools().map((tool) => tool.name)).toEqual(["t"]);
      await expectNameValidates(registry, "t");
    }
  });

  it("clones a schema fixed in place after a failed compile", async () => {
    const { McpFnRegistry, defineMcpFnServer } = await load();
    const source = new McpFnRegistry();
    const plain = { type: "object", properties: { name: { type: "bogus" } }, required: ["name"] };
    const withId = { ...objectWithId("https://test.invalid/fixed-in-place"), properties: { name: { type: "bogus" } } };
    for (const [name, inputSchema] of [["plain", plain], ["with-id", withId]] as const) {
      expect(() => source.register({ name, description: "Invalid nested type.", inputSchema, handler }))
        .toThrow("invalid JSON Schema");
      inputSchema.properties.name.type = "string";
      source.register({ name, description: "Fixed in place.", inputSchema, handler });
    }

    const declaration = defineMcpFnServer({ info, registry: source });
    for (const registry of [source, source.clone(), declaration.registry]) {
      expect(registry.listTools().map((tool) => tool.name)).toEqual(["plain", "with-id"]);
      for (const name of ["plain", "with-id"]) await expectNameValidates(registry, name);
    }
  });

  it.each([
    ["a tool whose output schema failed", (registry: Registry, id: string) => registry.register({
      name: "broken",
      description: "Valid input, invalid output.",
      inputSchema: objectWithId(id),
      outputSchema: invalidOutput(),
      handler,
    }), "invalid JSON Schema"],
    ["a prompt that failed after compiling", (registry: Registry, id: string) => registry.registerPrompt({
      name: "broken",
      argumentsSchema: objectWithId(id),
      complete: { unknown: async () => [] },
      get: async () => ({ messages: [] }),
    }), "completer for unknown argument"],
  ] as const)("fails clone() and declaration loudly for a $ref resolved only by %s", async (_label, registerBroken, message) => {
    const { McpFnRegistry, McpFnValidationError, defineMcpFnServer } = await load();
    const id = "https://test.invalid/residue";
    const source = new McpFnRegistry();
    expect(() => registerBroken(source, id)).toThrow(message);
    expect(source.has("broken")).toBe(false);
    expect(source.listPrompts()).toEqual([]);
    // The source compiler kept the $id, so the source accepts the $ref.
    source.register({ name: "uses-residue", description: "Refers to residue.", inputSchema: refTo(id), handler });
    expect(source.schemaDefinitions()).toEqual([refTo(id)]);

    expect(() => source.clone()).toThrow(McpFnValidationError);
    expect(() => source.clone()).toThrow("Tool uses-residue contains an invalid JSON Schema");
    expect(() => defineMcpFnServer({ info, registry: source })).toThrow(McpFnValidationError);
    expect(() => source.cloneEmpty().register({ name: "uses-residue", description: "Refers to residue.", inputSchema: refTo(id), handler }))
      .toThrow("invalid JSON Schema");
  });

  it("rejects registration from inside this registry's schema compile without partial state", async () => {
    const { McpFnRegistry, McpFnValidationError, createSchemaCompiler } = await load();
    const builtIn = createSchemaCompiler();
    const inner: unknown[] = [];
    let registry: Registry | undefined;
    let reenter: ((target: Registry) => unknown) | undefined;
    let swallow = false;
    registry = new McpFnRegistry({
      compileSchema: (schema) => {
        if (reenter && registry) {
          const attempt = reenter;
          reenter = undefined;
          try {
            attempt(registry);
          } catch (error) {
            inner.push(error);
            if (!swallow) throw error;
          }
        }
        return builtIn.compile(schema);
      },
    });
    const source = registry;
    // No $id: the custom compiler (and its schema store) is shared by clones.
    source.register({ name: "base", description: "Plain.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, handler });

    const attempts: Array<[string, (target: Registry) => unknown]> = [
      ["tool", (target) => target.register({ name: "inner", description: "Inner.", inputSchema: { type: "object" }, handler })],
      ["prompt", (target) => target.registerPrompt({ name: "inner", get: async () => ({ messages: [] }) })],
      ["resource", (target) => target.registerResource({ uri: "test://inner", name: "inner", read: async () => ({ contents: [] }) })],
      ["resource-template", (target) => target.registerResourceTemplate({ name: "inner", uriTemplate: "test://inner/{id}", read: async () => ({ contents: [] }) })],
    ];
    for (const [kind, attempt] of attempts) {
      // The compiler propagates the rejection: the outer registration fails.
      reenter = attempt;
      swallow = false;
      expect(() => source.register({ name: "outer", description: "Outer.", inputSchema: { type: "object" }, handler }))
        .toThrow("Tool outer contains an invalid JSON Schema");
      // The compiler swallows it: the outer registration succeeds alone.
      reenter = attempt;
      swallow = true;
      source.register({ name: `outer-${kind}`, description: "Outer.", inputSchema: { type: "object" }, handler });
    }
    expect(inner).toHaveLength(8);
    for (const error of inner) {
      expect(error).toBeInstanceOf(McpFnValidationError);
      expect((error as Error).message).toMatch(/while this registry is compiling a schema/);
    }

    const toolNames = ["base", "outer-prompt", "outer-resource", "outer-resource-template", "outer-tool"];
    expect(source.listTools().map((tool) => tool.name)).toEqual(toolNames);
    expect(source.listPrompts()).toEqual([]);
    expect(source.resourceDefinitions()).toEqual([]);
    expect(source.listResourceTemplates()).toEqual([]);
    const replayed = source.clone();
    expect(replayed.listTools().map((tool) => tool.name)).toEqual(toolNames);
    expect(replayed.listPrompts()).toEqual([]);
    expect(replayed.resourceDefinitions()).toEqual([]);
    expect(replayed.listResourceTemplates()).toEqual([]);
    expect(replayed.schemaDefinitions()).toEqual(source.schemaDefinitions());
    await expectNameValidates(replayed, "base");
  });

  it("leaks no later registration in either direction", async () => {
    const { McpFnRegistry } = await load();
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns a schema.", inputSchema: objectWithId("https://test.invalid/base"), handler });
    const replayed = source.clone();
    const empty = source.cloneEmpty();

    const sourceLater = "https://test.invalid/source-later";
    source.register({ name: "s", description: "Later source schema.", inputSchema: objectWithId(sourceLater), handler });
    for (const derived of [replayed, empty]) {
      expect(() => derived.register({ name: "x", description: "Unknown ref.", inputSchema: refTo(sourceLater), handler }))
        .toThrow("invalid JSON Schema");
      // The same new $id registers on the derived registry without collision.
      derived.register({ name: "s", description: "Same id here.", inputSchema: objectWithId(sourceLater), handler });
    }
    for (const [label, derived] of [["clone", replayed], ["empty", empty]] as const) {
      const derivedOnly = `https://test.invalid/derived-only-${label}`;
      derived.register({ name: `d-${label}`, description: "Derived-only schema.", inputSchema: objectWithId(derivedOnly), handler });
      expect(() => source.register({ name: `y-${label}`, description: "Unknown ref.", inputSchema: refTo(derivedOnly), handler }))
        .toThrow("invalid JSON Schema");
      source.register({ name: `d-${label}`, description: "Same id here.", inputSchema: objectWithId(derivedOnly), handler });
    }
  });
});

describe("McpFnRegistry custom compileSchema validators", () => {
  it("fails closed without an unhandled rejection when a validator returns a promise", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handler = vi.fn(async () => ({ content: [] }));
      const registry = new McpFnRegistry({
        compileSchema: () => (() => Promise.reject(new Error("async validator"))) as never,
      }).register({ name: "t", description: "Async validator.", inputSchema: { type: "object" }, handler });
      await expect(registry.callTool("t", {}, undefined, requestExtra())).rejects.toMatchObject({
        message: "Invalid arguments for t",
        details: { issues: [expect.objectContaining({ message: "compileSchema validators must be synchronous" })] },
      });
      expect(handler).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("McpFnRegistry custom compileSchema thenable validators", () => {
  it("contains a rejected promise returned by a thenable's own then()", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const handler = vi.fn(async () => ({ content: [] }));
      // then() ignores its handlers and returns a fresh rejected promise.
      const thenable = { then: () => Promise.reject(new Error("rejected from then()")) };
      const registry = new McpFnRegistry({
        compileSchema: () => (() => thenable) as never,
      }).register({ name: "t", description: "Thenable validator.", inputSchema: { type: "object" }, handler });
      await expect(registry.callTool("t", {}, undefined, requestExtra())).rejects.toMatchObject({
        message: "Invalid arguments for t",
        details: { issues: [expect.objectContaining({ message: "compileSchema validators must be synchronous" })] },
      });
      expect(handler).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
