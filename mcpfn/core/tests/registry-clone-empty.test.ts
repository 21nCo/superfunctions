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
