import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { requestExtra } from "./openapi-helpers.js";

// cloneEmpty() (ported from 615d6f44e) returns a registry with no definitions
// that inherits the schemas the source accepted so far: re-registering the same
// schema object (a registry-issued snapshot or the unchanged caller object) in
// any order reuses the source snapshot, any other schema meets the engine as it
// would on the source, and a copy of a self-contained source never exposes a
// collection that does not resolve on its own. No later registration leaks in
// either direction.
describe.each(["ajv", "cfworker"] as const)("McpFnRegistry.cloneEmpty() with the built-in %s compiler", (engine) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
    vi.resetModules();
    const {
      McpFnRegistry, McpFnValidationError, structuredResult, createManifest, validateManifest, defineMcpFnServer, createMcpFnServer,
    } = await import("../src/index.js");
    const { createSchemaCompiler } = await import("../src/validation.js");
    expect(createSchemaCompiler().engine).toBe(engine);
    return {
      McpFnRegistry, McpFnValidationError, structuredResult, createManifest, validateManifest, defineMcpFnServer, createMcpFnServer,
    };
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

  it("never exposes a copy whose $ref resolves only to a schema the copy did not register", async () => {
    const { McpFnRegistry, McpFnValidationError, structuredResult, createManifest, validateManifest, defineMcpFnServer, createMcpFnServer } =
      await load();
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

    // The inherited schema resolves the $ref, but the copy's own collection
    // would not: every listing, manifest, clone and server refuses it.
    empty.register({ name: "b", description: "Refers to the shared schema.", inputSchema: refTo(sharedId), handler });
    const unclosed = [
      () => empty.definitions(),
      () => empty.listTools(),
      () => empty.schemaDefinitions(),
      () => empty.clone(),
      () => createManifest(info, empty),
      () => defineMcpFnServer({ info, registry: empty }),
      () => createMcpFnServer({ info, registry: empty }),
    ];
    for (const expose of unclosed) {
      expect(expose).toThrow(McpFnValidationError);
      expect(expose).toThrow("Registry schema collection is not self-contained");
    }
    expect(source.has("b")).toBe(false);

    // Registering the inherited schema object unchanged closes the copy.
    empty.register({ name: "a", description: "Same schema on the copy.", inputSchema: sharedSchema, handler });
    expect(empty.listTools().map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(() => validateManifest(createManifest(info, empty))).not.toThrow();
    await expect(empty.callTool("b", { item: { name: "x" } }, undefined, requestExtra()))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(empty.callTool("b", { item: { name: 1 } }, undefined, requestExtra()))
      .rejects.toThrow("Invalid arguments for b");
  });

  it("rejects a different schema under an inherited $id", async () => {
    const { McpFnRegistry, McpFnValidationError, structuredResult } = await load();
    const handler = async () => structuredResult({ ok: true });
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: sharedSchema, handler });
    for (const derived of [source.cloneEmpty(), source.clone()]) {
      let thrown: unknown;
      try {
        derived.register({ name: "z", description: "Changed schema.", inputSchema: { ...sharedSchema, required: [] }, handler });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(McpFnValidationError);
      // The copy's engine holds the inherited schema, as the source's does.
      expect((thrown as Error).message).toBe("Tool z contains an invalid JSON Schema");
      expect(() => source.register({ name: "z", description: "Changed schema.", inputSchema: { ...sharedSchema, required: [] }, handler }))
        .toThrow("Tool z contains an invalid JSON Schema");
      expect(derived.has("z")).toBe(false);
    }
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

    // The source schema object registers on the copy without a duplicate-id collision.
    empty.register({ name: "a", description: "Same id on the copy.", inputSchema: sharedSchema, handler });

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

// clone() replays every successful registration in registration order from
// the source's record (its frozen view and accepted schema snapshots) on a
// fresh built-in compiler (or the shared custom compiler). Failed registrations are not replayed, so
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
    // The failed registration left no compiler residue, so the retry succeeds
    // on both engines (on dev cfworker rejected the repeated $id).
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
  ] as const)("rejects a $ref to the schema of %s at registration", async (_label, registerBroken, message) => {
    const { McpFnRegistry, McpFnValidationError, defineMcpFnServer } = await load();
    const { createManifest, validateManifest } = await import("../src/index.js");
    const id = "https://test.invalid/residue";
    const source = new McpFnRegistry()
      .register({ name: "base", description: "Plain.", inputSchema: objectWithId("https://test.invalid/base"), handler });
    expect(() => registerBroken(source, id)).toThrow(message);
    expect(source.has("broken")).toBe(false);
    expect(source.listPrompts()).toEqual([]);
    // The failed registration left nothing in the compiler, so a $ref to its
    // schema does not resolve on the source either (on dev it did).
    expect(() => source.register({ name: "uses-residue", description: "Refers to residue.", inputSchema: refTo(id), handler }))
      .toThrow(McpFnValidationError);
    expect(source.has("uses-residue")).toBe(false);
    // Earlier registrations still validate, and every copy matches the source.
    const declaration = defineMcpFnServer({ info, registry: source });
    for (const registry of [source, source.clone(), declaration.registry]) {
      expect(registry.listTools().map((tool) => tool.name)).toEqual(["base"]);
      await expectNameValidates(registry, "base");
    }
    expect(() => validateManifest(createManifest(info, source))).not.toThrow();
    // The same $id registers cleanly afterwards.
    source.register({ name: "owner", description: "Owns the id now.", inputSchema: objectWithId(id), handler });
    source.register({ name: "uses", description: "Refers to it.", inputSchema: refTo(id), handler });
    expect(source.clone().listTools().map((tool) => tool.name)).toEqual(["base", "owner", "uses"]);
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
      // Each outer schema is new, so the registry compiles it (an equal
      // accepted schema would be reused without calling the compiler).
      reenter = attempt;
      swallow = false;
      expect(() => source.register({ name: "outer", description: "Outer.", inputSchema: { type: "object", title: `propagate-${kind}` }, handler }))
        .toThrow("Tool outer contains an invalid JSON Schema");
      // The compiler swallows it: the outer registration succeeds alone.
      reenter = attempt;
      swallow = true;
      source.register({ name: `outer-${kind}`, description: "Outer.", inputSchema: { type: "object", title: `swallow-${kind}` }, handler });
    }
    expect(inner).toHaveLength(8);
    for (const error of inner) {
      expect(error).toBeInstanceOf(McpFnValidationError);
      expect((error as Error).message).toMatch(/while this registry is registering another definition/);
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

// A custom compileSchema is shared by every clone, so clone() reuses the
// validators the source registration compiled and never calls it again: a
// stateful compiler that rejects a repeated $id clones like the source.
describe.each(["ajv", "cfworker"] as const)("McpFnRegistry.clone() with a stateful custom compiler over %s", (engine) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
    vi.resetModules();
    const { McpFnRegistry, McpFnValidationError, defineMcpFnServer } = await import("../src/index.js");
    const { createSchemaCompiler } = await import("../src/validation.js");
    const builtIn = createSchemaCompiler();
    expect(builtIn.engine).toBe(engine);
    const compiled: object[] = [];
    const ids = new Set<string>();
    // One shared schema store that rejects a repeated $id, like a cfworker Validator.
    const compileSchema = (schema: object) => {
      compiled.push(schema);
      const id = (schema as { $id?: unknown }).$id;
      if (typeof id === "string") {
        if (ids.has(id)) throw new Error(`schema ${id} already exists`);
        ids.add(id);
      }
      return builtIn.compile(schema);
    };
    return { McpFnRegistry, McpFnValidationError, defineMcpFnServer, compileSchema, compiled };
  }

  const info = { name: "test", version: "0.0.0" };
  const handler = async (args: { name?: unknown }) => ({
    content: [],
    structuredContent: args.name === "bad-output" ? { ok: "no" } : { ok: true },
  });
  const objectWithId = (id: string) => ({
    $id: id,
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  const output = () => ({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] });
  const prompt = () => ({
    name: "p",
    argumentsSchema: { type: "object", properties: { topic: { type: "string", enum: ["a", "b"] } }, required: ["topic"] },
    get: async () => ({ messages: [] }),
  });

  type Registry = InstanceType<Awaited<ReturnType<typeof load>>["McpFnRegistry"]>;

  async function expectSameAnswers(registry: Registry) {
    await expect(registry.callTool("t", { name: "x" }, undefined, requestExtra()))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(registry.callTool("t", { name: 1 }, undefined, requestExtra()))
      .rejects.toThrow("Invalid arguments for t");
    await expect(registry.callTool("t", { name: "bad-output" }, undefined, requestExtra()))
      .rejects.toThrow("Invalid output from t");
    await expect(registry.getPrompt("p", { topic: "a" }, undefined, requestExtra())).resolves.toEqual({ messages: [] });
    await expect(registry.getPrompt("p", { topic: "c" }, undefined, requestExtra())).rejects.toThrow();
  }

  it("clones and declares without calling the compiler again for source schemas", async () => {
    const { McpFnRegistry, defineMcpFnServer, compileSchema, compiled } = await load();
    const source = new McpFnRegistry({ compileSchema })
      .register({ name: "t", description: "Has an $id input.", inputSchema: objectWithId("https://test.invalid/s"), outputSchema: output(), handler })
      .registerPrompt(prompt());
    expect(compiled).toHaveLength(3);

    const replayed = source.clone();
    const declared = defineMcpFnServer({ info, registry: source });
    expect(compiled).toHaveLength(3);
    const extended = defineMcpFnServer({
      info,
      registry: source,
      tools: [{ name: "u", description: "Added.", inputSchema: objectWithId("https://test.invalid/u"), handler }],
    });
    expect(compiled).toHaveLength(4);

    for (const registry of [source, replayed, declared.registry, extended.registry, replayed.clone()]) {
      await expectSameAnswers(registry);
    }
    expect(extended.registry.listTools().map((tool) => tool.name)).toEqual(["t", "u"]);
    expect(replayed.schemaDefinitions()).toEqual(source.schemaDefinitions());
  });

  it("replays the registered record, not a definition edited in place, without compiling", async () => {
    const { McpFnRegistry, compileSchema, compiled } = await load();
    const definition = { name: "t", description: "Valid at registration.", inputSchema: objectWithId("https://test.invalid/s"), handler };
    const source = new McpFnRegistry({ compileSchema }).register(definition);
    definition.description = " ";
    const replayed = source.clone();
    expect(replayed.listTools()).toEqual(source.listTools());
    expect(replayed.listTools()[0]!.description).toBe("Valid at registration.");
    expect(compiled).toHaveLength(1);
  });

  it("leaks no later registration in either direction", async () => {
    const { McpFnRegistry, compileSchema, compiled } = await load();
    const source = new McpFnRegistry({ compileSchema })
      .register({ name: "t", description: "Has an $id input.", inputSchema: objectWithId("https://test.invalid/s"), outputSchema: output(), handler })
      .registerPrompt(prompt());
    const replayed = source.clone();
    source.register({ name: "source-only", description: "Later.", inputSchema: { type: "object" }, handler });
    replayed.register({ name: "clone-only", description: "Later.", inputSchema: { type: "object" }, handler });
    replayed.registerPrompt({ name: "clone-prompt", get: async () => ({ messages: [] }) });
    expect(source.listTools().map((tool) => tool.name)).toEqual(["source-only", "t"]);
    expect(replayed.listTools().map((tool) => tool.name)).toEqual(["clone-only", "t"]);
    expect(source.listPrompts().map((entry) => entry.name)).toEqual(["p"]);
    expect(replayed.listPrompts().map((entry) => entry.name)).toEqual(["clone-prompt", "p"]);
    expect(compiled).toHaveLength(6);
    await expectSameAnswers(source);
    await expectSameAnswers(replayed);
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

describe("McpFnRegistry custom compileSchema thenable results", () => {
  async function withUnhandledRejections(run: (unhandled: unknown[]) => Promise<void>) {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await run(unhandled);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }

  // T1.then returns T2, whose then returns a rejected promise: every call into
  // foreign then() code can create another rejection, so it is never called.
  function chainedThenable() {
    const second = { then: vi.fn(() => Promise.reject(new Error("rejected from T2.then()"))) };
    const first = { then: vi.fn(() => second) };
    return { first, second };
  }

  it("fails a non-native thenable validator result closed without calling its then()", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    await withUnhandledRejections(async () => {
      const { first, second } = chainedThenable();
      const handler = vi.fn(async () => ({ content: [] }));
      const registry = new McpFnRegistry({
        compileSchema: () => (() => first) as never,
      }).register({ name: "t", description: "Thenable validator.", inputSchema: { type: "object" }, handler });
      await expect(registry.callTool("t", {}, undefined, requestExtra())).rejects.toMatchObject({
        message: "Invalid arguments for t",
        details: { issues: [expect.objectContaining({ message: "compileSchema validators must be synchronous" })] },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(first.then).not.toHaveBeenCalled();
      expect(second.then).not.toHaveBeenCalled();
    });
  });

  it("rejects a non-native thenable compiler result without calling its then()", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    await withUnhandledRejections(async () => {
      const { first, second } = chainedThenable();
      const registry = new McpFnRegistry({ compileSchema: () => first as never });
      let thrown: unknown;
      try {
        registry.register({ name: "t", description: "Thenable compiler.", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        message: "Tool t contains an invalid JSON Schema",
        details: { cause: "compileSchema must return a validator function" },
      });
      expect(registry.has("t")).toBe(false);
      expect(first.then).not.toHaveBeenCalled();
      expect(second.then).not.toHaveBeenCalled();
    });
  });

  // A promise from another realm (vm context, iframe) fails `instanceof Promise`
  // but is still a genuine native promise whose rejection must be handled.
  function crossRealmRejection(message: string): Promise<never> {
    const promise = runInNewContext(`Promise.reject(new Error(${JSON.stringify(message)}))`) as Promise<never>;
    expect(promise).not.toBeInstanceOf(Promise);
    return promise;
  }

  it("contains a rejected promise from another realm returned by a validator", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    await withUnhandledRejections(async () => {
      const handler = vi.fn(async () => ({ content: [] }));
      const registry = new McpFnRegistry({
        compileSchema: () => (() => crossRealmRejection("cross-realm validator")) as never,
      }).register({ name: "t", description: "Cross-realm validator.", inputSchema: { type: "object" }, handler });
      await expect(registry.callTool("t", {}, undefined, requestExtra())).rejects.toMatchObject({
        message: "Invalid arguments for t",
        details: { issues: [expect.objectContaining({ message: "compileSchema validators must be synchronous" })] },
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  it("contains a rejected promise from another realm returned by the compiler", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    await withUnhandledRejections(async () => {
      const registry = new McpFnRegistry({ compileSchema: () => crossRealmRejection("cross-realm compiler") as never });
      let thrown: unknown;
      try {
        registry.register({ name: "t", description: "Cross-realm compiler.", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) });
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

  it("never calls then() on a Proxy that wraps a native promise", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    await withUnhandledRejections(async () => {
      const then = vi.fn(() => Promise.reject(new Error("rejected from proxy then()")));
      const target = Promise.resolve(true);
      const lookalike = new Proxy(target, { get: (object, key) => (key === "then" ? then : Reflect.get(object, key)) });
      const registry = new McpFnRegistry({
        compileSchema: () => (() => lookalike) as never,
      }).register({ name: "t", description: "Proxy validator.", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) });
      await expect(registry.callTool("t", {}, undefined, requestExtra())).rejects.toMatchObject({
        message: "Invalid arguments for t",
        details: { issues: [expect.objectContaining({ message: "compileSchema validators must be synchronous" })] },
      });
      expect(then).not.toHaveBeenCalled();
    });
  });

  it("contains a native rejected promise returned by the compiler", async () => {
    const { McpFnRegistry } = await import("../src/index.js");
    await withUnhandledRejections(async () => {
      const registry = new McpFnRegistry({ compileSchema: () => Promise.reject(new Error("async compiler")) as never });
      expect(() => registry.register({ name: "t", description: "Async compiler.", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) }))
        .toThrow("Tool t contains an invalid JSON Schema");
    });
  });
});
