import { afterEach, describe, expect, it, vi } from "vitest";

import { requestExtra } from "./openapi-helpers.js";

// cloneEmpty() (ported from 615d6f44e) must keep resolving `$ref`s to schemas
// the source registry's built-in compiler already knows, on both engines,
// without sharing later registrations in either direction.
describe.each(["ajv", "cfworker"] as const)("McpFnRegistry.cloneEmpty() with the built-in %s compiler", (engine) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
    vi.resetModules();
    const { McpFnRegistry, structuredResult } = await import("../src/index.js");
    const { createSchemaCompiler } = await import("../src/validation.js");
    expect(createSchemaCompiler().engine).toBe(engine);
    return { McpFnRegistry, structuredResult };
  }

  const sharedId = "https://test.invalid/shared";
  const sharedSchema = {
    $id: sharedId,
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  const refTo = (id: string) => ({ type: "object", properties: { item: { $ref: id } }, required: ["item"] });

  it("resolves source $id schemas, copies no definitions and keeps later registrations separate", async () => {
    const { McpFnRegistry, structuredResult } = await load();
    const handler = async () => structuredResult({ ok: true });
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: sharedSchema, handler })
      .registerPrompt({ name: "p", get: async () => ({ messages: [] }) });

    const empty = source.cloneEmpty();
    expect(empty.listTools()).toEqual([]);
    expect(empty.listPrompts()).toEqual([]);
    expect(empty.definitions()).toEqual([]);
    expect(empty.promptDefinitions()).toEqual([]);

    // A $ref to the source's $id registers and validates against it.
    empty.register({ name: "b", description: "Refers to the shared schema.", inputSchema: refTo(sharedId), handler });
    await expect(empty.callTool("b", { item: { name: "x" } }, undefined, requestExtra()))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(empty.callTool("b", { item: { name: 1 } }, undefined, requestExtra()))
      .rejects.toThrow("Invalid arguments for b");
    expect(source.has("b")).toBe(false);

    // A clone-only $id stays out of the source, and the same $id can still be
    // registered on the source without a duplicate-id collision.
    const cloneOnlyId = "https://test.invalid/clone-only";
    empty.register({ name: "c", description: "Clone-only schema.", inputSchema: { ...sharedSchema, $id: cloneOnlyId }, handler });
    expect(() => source.register({ name: "d", description: "Unknown ref.", inputSchema: refTo(cloneOnlyId), handler }))
      .toThrow("invalid JSON Schema");
    source.register({ name: "c", description: "Same id on the source.", inputSchema: { ...sharedSchema, $id: cloneOnlyId }, handler });

    // A later source $id does not leak into the existing empty clone.
    const sourceLaterId = "https://test.invalid/source-later";
    source.register({ name: "e", description: "Later source schema.", inputSchema: { ...sharedSchema, $id: sourceLaterId }, handler });
    expect(() => empty.register({ name: "f", description: "Unknown ref.", inputSchema: refTo(sourceLaterId), handler }))
      .toThrow("invalid JSON Schema");
  });

  it("keeps seeded schemas through clone() and nested cloneEmpty(), and clone() still replays", async () => {
    const { McpFnRegistry, structuredResult } = await load();
    const handler = async () => structuredResult({ ok: true });
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: sharedSchema, handler })
      .register({ name: "b", description: "Refers to it.", inputSchema: refTo(sharedId), handler });

    const replayed = source.clone();
    expect(replayed.listTools().map((tool) => tool.name)).toEqual(["a", "b"]);

    const empty = source.cloneEmpty()
      .register({ name: "b", description: "Refers to the seeded schema.", inputSchema: refTo(sharedId), handler });
    expect(empty.schemaDefinitions()).toEqual([sharedSchema, refTo(sharedId), refTo(sharedId)]);

    const emptyClone = empty.clone();
    expect(emptyClone.listTools().map((tool) => tool.name)).toEqual(["b"]);
    await expect(emptyClone.callTool("b", { item: {} }, undefined, requestExtra()))
      .rejects.toThrow("Invalid arguments for b");

    const nested = empty.cloneEmpty();
    expect(nested.listTools()).toEqual([]);
    nested.register({ name: "g", description: "Refers to the seeded schema.", inputSchema: refTo(sharedId), handler });
    expect(nested.has("g")).toBe(true);
  });
});

// Architecture reset (SFNS-107): clone() and cloneEmpty() give a fresh
// built-in compiler the same ordered compiles the source compiler received,
// including compiles from failed registrations, so they resolve exactly the
// `$id`s the source resolves on each engine.
describe.each(["ajv", "cfworker"] as const)("McpFnRegistry derived compilers replay the %s compile log", (engine) => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    if (engine === "cfworker") vi.stubGlobal("WebSocketPair", class {});
    vi.resetModules();
    const { McpFnRegistry, structuredResult } = await import("../src/index.js");
    const { createSchemaCompiler } = await import("../src/validation.js");
    expect(createSchemaCompiler().engine).toBe(engine);
    return { McpFnRegistry, structuredResult };
  }

  const handler = async () => ({ content: [], structuredContent: { ok: true } });
  const objectWithId = (id: string) => ({
    $id: id,
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  });
  const refTo = (id: string) => ({ type: "object", properties: { item: { $ref: id } }, required: ["item"] });

  type Registry = InstanceType<Awaited<ReturnType<typeof load>>["McpFnRegistry"]>;

  async function expectRefValidates(registry: Registry, tool: string) {
    await expect(registry.callTool(tool, { item: { name: "x" } }, undefined, requestExtra()))
      .resolves.toMatchObject({ structuredContent: { ok: true } });
    await expect(registry.callTool(tool, { item: { name: 1 } }, undefined, requestExtra()))
      .rejects.toThrow(`Invalid arguments for ${tool}`);
  }

  async function expectDerivedMatchSource(source: Registry, refId: string) {
    source.register({ name: "uses-ref", description: "Refers to residue.", inputSchema: refTo(refId), handler });
    await expectRefValidates(source, "uses-ref");

    const replayed = source.clone();
    expect(replayed.listTools().map((tool) => tool.name)).toEqual(
      source.listTools().map((tool) => tool.name),
    );
    await expectRefValidates(replayed, "uses-ref");

    const empty = source.cloneEmpty();
    expect(empty.definitions()).toEqual([]);
    empty.register({ name: "uses-ref", description: "Refers to residue.", inputSchema: refTo(refId), handler });
    await expectRefValidates(empty, "uses-ref");
    // clone() of the empty copy keeps the replayed compiles too.
    await expectRefValidates(empty.clone(), "uses-ref");
  }

  it("keeps an input $id from a tool registration whose output schema failed", async () => {
    const { McpFnRegistry } = await load();
    const id = "https://test.invalid/failed-tool-input";
    const source = new McpFnRegistry();
    expect(() => source.register({
      name: "broken",
      description: "Valid input, invalid output.",
      inputSchema: objectWithId(id),
      outputSchema: { type: "object", properties: { a: { type: "not-a-type" } } },
      handler,
    })).toThrow("invalid JSON Schema");
    expect(source.has("broken")).toBe(false);
    await expectDerivedMatchSource(source, id);
    // Residue is not a schema resource of any definition.
    expect(source.schemaDefinitions()).toEqual([refTo(id)]);
    expect(source.cloneEmpty().schemaDefinitions()).toEqual([refTo(id)]);
  });

  it("keeps an arguments $id from a prompt registration that failed after compiling", async () => {
    const { McpFnRegistry } = await load();
    const id = "https://test.invalid/failed-prompt-arguments";
    const source = new McpFnRegistry();
    expect(() => source.registerPrompt({
      name: "broken",
      argumentsSchema: { ...objectWithId(id), properties: { name: { type: "string" } } },
      complete: { unknown: async () => [] },
      get: async () => ({ messages: [] }),
    })).toThrow("completer for unknown argument");
    expect(source.listPrompts()).toEqual([]);
    await expectDerivedMatchSource(source, id);
  });

  it("matches the source after a failed compile, its dependency and a $ref to it", async () => {
    const { McpFnRegistry } = await load();
    const dependencyId = "https://test.invalid/dependency";
    const dependentId = "https://test.invalid/dependent";
    const dependent = { $id: dependentId, type: "object", properties: { name: { $ref: dependencyId } }, required: ["name"] };
    const source = new McpFnRegistry();
    expect(() => source.register({ name: "early", description: "Unresolved ref.", inputSchema: dependent, handler }))
      .toThrow("invalid JSON Schema");
    source.register({ name: "dependency", description: "Owns the dependency.", inputSchema: objectWithId(dependencyId), handler });

    // Whether the failed compile left the dependent's $id behind is up to the
    // engine; derived registries must resolve it exactly as the source does.
    let sourceAccepts = true;
    try {
      source.register({ name: "late", description: "Refers to the dependent.", inputSchema: refTo(dependentId), handler });
    } catch {
      sourceAccepts = false;
    }
    if (engine === "ajv") expect(sourceAccepts).toBe(true);
    for (const derived of [source.clone(), source.cloneEmpty()]) {
      const register = () => derived.register({
        name: derived.has("late") ? "late-again" : "late",
        description: "Refers to the dependent.",
        inputSchema: refTo(dependentId),
        handler,
      });
      if (sourceAccepts) expect(register).not.toThrow();
      else expect(register).toThrow("invalid JSON Schema");
    }
  });

  it("supports the 615d6f44e pattern: cloneEmpty() then re-register every source definition", async () => {
    const { McpFnRegistry } = await load();
    const sharedId = "https://test.invalid/pattern-shared";
    const shared = objectWithId(sharedId);
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: shared, handler })
      .register({ name: "b", description: "Refers to it.", inputSchema: refTo(sharedId), handler })
      .registerResource({ uri: "test://r", name: "r", read: async () => ({ contents: [] }) })
      .registerResourceTemplate({ name: "t", uriTemplate: "test://t/{id}", read: async () => ({ contents: [] }) })
      .registerPrompt({ name: "p", arguments: [{ name: "topic" }], get: async () => ({ messages: [] }) });

    const copy = source.cloneEmpty();
    for (const tool of source.definitions()) copy.register(tool);
    for (const resource of source.resourceDefinitions()) copy.registerResource(resource);
    for (const template of source.resourceTemplateDefinitions()) copy.registerResourceTemplate(template);
    for (const prompt of source.promptDefinitions()) copy.registerPrompt(prompt);

    expect(copy.listTools().map((tool) => tool.name)).toEqual(["a", "b"]);
    expect(copy.listPrompts().map((prompt) => prompt.name)).toEqual(["p"]);
    await expectRefValidates(copy, "b");
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
    const derivedOnly = "https://test.invalid/derived-only";
    empty.register({ name: "d", description: "Derived-only schema.", inputSchema: objectWithId(derivedOnly), handler });
    expect(() => source.register({ name: "y", description: "Unknown ref.", inputSchema: refTo(derivedOnly), handler }))
      .toThrow("invalid JSON Schema");
    source.register({ name: "d", description: "Same id here.", inputSchema: objectWithId(derivedOnly), handler });
  });

  it("builds a server declaration over a cloneEmpty() registry that refers to a source $id", async () => {
    const { McpFnRegistry } = await load();
    const { defineMcpFnServer } = await import("../src/index.js");
    const sharedId = "https://test.invalid/declaration-shared";
    const source = new McpFnRegistry()
      .register({ name: "a", description: "Owns the shared schema.", inputSchema: objectWithId(sharedId), handler });
    const empty = source.cloneEmpty()
      .register({ name: "b", description: "Refers to it.", inputSchema: refTo(sharedId), handler });
    const declaration = defineMcpFnServer({ info: { name: "test", version: "0.0.0" }, registry: empty });
    expect(declaration.registry.listTools().map((tool) => tool.name)).toEqual(["b"]);
    await expectRefValidates(declaration.registry, "b");
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
