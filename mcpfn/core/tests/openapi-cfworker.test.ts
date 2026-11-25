import { describe, expect, it, vi } from "vitest";
import { fromOpenAPI } from "../src/openapi/index.js";
import { createSchemaCompiler } from "../src/validation.js";
import { expectArguments, recordingExecutor, requestExtra, tool } from "./openapi-helpers.js";

// The edge runtime's engine: every compiler mcpFn creates without naming one is @cfworker/json-schema.
vi.mock("../src/validation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validation.js")>();
  return { ...actual, createSchemaCompiler: (engine?: "ajv" | "cfworker") => actual.createSchemaCompiler(engine ?? "cfworker") };
});

const json = (schema: unknown) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });

describe("fromOpenAPI under @cfworker/json-schema", () => {
  it("skips a reference chain too deep to validate, though the engine compiles it, and keeps a short one", () => {
    const schemas: Record<string, unknown> = { C19999: { type: "object", properties: { n: { type: "integer" } } } };
    for (let index = 0; index < 19_999; index += 1) schemas[`C${index}`] = { allOf: [{ $ref: `#/components/schemas/C${index + 1}` }] };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/deep": { get: { operationId: "deep", responses: json({ $ref: "#/components/schemas/C0" }) }, head: { operationId: "deepHead", responses: json({ $ref: "#/components/schemas/C0" }) } },
          "/short": { get: { operationId: "short", responses: json({ $ref: "#/components/schemas/C19990" }) } },
        },
        components: { schemas },
      },
      { executor: recordingExecutor() },
    );
    // The GET tool is checked when it registers. The HEAD response is
    // discarded, so no value is ever validated against it here.
    expect(result.skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason]).sort()).toEqual([
      ["deep", "schema-too-large", "a schema or reference chain nests too deeply"],
    ]);
    expect(result.tools.map(({ name }) => name)).toEqual(["deepHead", "short"]);
    expect(result.registry.has("short")).toBe(true);
  }, 60_000);

  it("measures chains behind parameters, request bodies and child values from the schema, not from a sample value", () => {
    // Every link states a type, so a value of another type stops at the first one: only the schema tells the depth.
    const schemas: Record<string, unknown> = { S20000: { type: "string" }, O20000: { type: "object", properties: { n: { type: "integer" } } } };
    for (let index = 0; index < 20_000; index += 1) {
      schemas[`S${index}`] = { type: "string", allOf: [{ $ref: `#/components/schemas/S${index + 1}` }] };
      schemas[`O${index}`] = { type: "object", allOf: [{ $ref: `#/components/schemas/O${index + 1}` }] };
    }
    const query = (operationId: string, name: string) => ({
      get: { operationId, parameters: [{ name: "q", in: "query", schema: { $ref: `#/components/schemas/${name}` } }], responses: json({ type: "object" }) },
    });
    const body = (operationId: string, content: Record<string, unknown>) => ({ post: { operationId, requestBody: { required: true, content }, responses: json({ type: "object" }) } });
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/query": query("deepQuery", "S0"),
          "/body": body("deepBody", { "application/json": { schema: { $ref: "#/components/schemas/O0" } } }),
          "/map": { get: { operationId: "deepMap", responses: json({ type: "object", additionalProperties: { $ref: "#/components/schemas/O0" } }) } },
          "/fallback": body("fallback", {
            "application/json": { schema: { type: "object", additionalProperties: { $ref: "#/components/schemas/O0" } } },
            "application/example+json": { schema: { type: "string" } },
          }),
          "/short": query("shortQuery", "S19990"),
        },
        components: { schemas },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(result.skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason]).sort()).toEqual([
      ["deepBody", "schema-too-large", "a schema or reference chain nests too deeply"],
      ["deepMap", "schema-too-large", "a schema or reference chain nests too deeply"],
      ["deepQuery", "schema-too-large", "a schema or reference chain nests too deeply"],
    ]);
    expect(result.tools.map(({ name, operation }) => [name, operation.requestBody?.contentType])).toEqual([
      ["fallback", "application/example+json"],
      ["shortQuery", undefined],
    ]);
    expect(result.registry.has("shortQuery")).toBe(true);
    expect(result.registry.has("fallback")).toBe(true);
    expectArguments(tool(result.tools, "shortQuery").inputSchema, { valid: [{ query: { q: "ok" } }], invalid: [{ query: { q: 1 } }] });
    expectArguments(tool(result.tools, "fallback").inputSchema, { valid: [{ body: "ok" }], invalid: [{ body: {} }] });
  }, 120_000);

  /** A chain of `length` components named `prefix<n>`, each link written by `link` around a reference to the next. */
  const chain = (prefix: string, length: number, link: (next: unknown) => unknown) => {
    const schemas: Record<string, unknown> = { [`${prefix}${length}`]: { type: "object", properties: { v: { type: "integer" } } } };
    for (let index = 0; index < length; index += 1) schemas[`${prefix}${index}`] = link({ $ref: `#/components/schemas/${prefix}${index + 1}` });
    return schemas;
  };
  const nested = (depth: number): unknown => {
    let value: unknown = { v: 1 };
    for (let index = 0; index < depth; index += 1) value = { next: value };
    return value;
  };
  const required = (next: unknown) => ({ type: "object", required: ["next"], properties: { next } });
  const body = (operationId: string, name: string) => ({
    post: { operationId, requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } } }, responses: { "204": { description: "Done" } } },
  });
  const verdicts = (result: { skipped: Array<{ operation: { operationId?: string }; code: string; reason: string }> }) =>
    result.skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason]).sort();
  const tooDeep = (operationId: string) => [operationId, "schema-too-large", "a schema or reference chain nests too deeply"];

  it("stacks the frames of children every valid value must have, and lets optional ones and shallow recursion start again", async () => {
    const schemas = {
      ...chain("R", 2_500, required),
      ...chain("T", 10, required),
      ...chain("O", 2_500, (next) => ({ type: "object", properties: { next } })),
      // A null value or a string stops these at once: nothing is forced.
      ...chain("N", 2_500, (next) => ({ type: ["object", "null"], required: ["next"], properties: { next } })),
      ...chain("U", 2_500, (next) => ({ required: ["next"], properties: { next } })),
      Loop: { type: "object", required: ["next"], properties: { next: { $ref: "#/components/schemas/Loop" } } },
      Tree: { type: "object", properties: { next: { $ref: "#/components/schemas/Tree" } } },
    };
    const executor = recordingExecutor();
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/r": body("requiredChain", "R0"),
          "/t": body("shortChain", "T0"),
          "/o": body("optionalChain", "O0"),
          "/n": body("nullableChain", "N0"),
          "/u": body("untypedChain", "U0"),
          "/loop": body("forcedLoop", "Loop"),
          "/tree": body("tree", "Tree"),
          "/out": { get: { operationId: "requiredOutput", responses: json({ $ref: "#/components/schemas/R0" }) } },
        },
        components: { schemas },
      },
      { executor, allowMutations: true },
    );
    expect(verdicts(result)).toEqual([tooDeep("forcedLoop"), tooDeep("requiredChain"), tooDeep("requiredOutput")]);
    expect(result.tools.map(({ name }) => name)).toEqual(["shortChain", "optionalChain", "nullableChain", "untypedChain", "tree"]);
    const args = { body: nested(10) };
    expectArguments(tool(result.tools, "shortChain").inputSchema, { valid: [args], invalid: [{ body: nested(9) }] });
    await result.registry.callTool("shortChain", args, undefined, requestExtra());
    expect(executor.calls.map((call) => call.args)).toEqual([args]);
    // Ajv refuses this chain when it compiles it; the edge engine validates short values.
    const optional = createSchemaCompiler("cfworker").compile(tool(result.tools, "optionalChain").inputSchema);
    expect([optional({ body: {} }), optional({ body: nested(20) })]).toEqual([true, true]);
  }, 120_000);

  it("stacks items up to minItems and required names behind patternProperties or additionalProperties, in either catalog order", () => {
    const schemas = {
      ...chain("I", 2_500, (items) => ({ type: "array", minItems: 1, items })),
      ...chain("E", 2_500, (items) => ({ type: "array", items })),
      ...chain("A", 2_500, (additionalProperties) => ({ type: "object", required: ["x"], additionalProperties })),
      ...chain("P", 2_500, (member) => ({ type: "object", required: ["x1"], patternProperties: { "^x": member } })),
      ...chain("Q", 2_500, (member) => ({ type: "object", required: ["y"], patternProperties: { "^x": member } })),
    };
    const get = (operationId: string, name: string) => ({ get: { operationId, responses: json({ type: "object", required: ["v"], properties: { v: { $ref: `#/components/schemas/${name}` } } }) } });
    const paths: Record<string, unknown> = {
      "/i": get("minItemsChain", "I0"),
      "/e": get("emptyItemsChain", "E0"),
      "/a": get("additionalChain", "A0"),
      "/p": get("patternChain", "P0"),
      "/q": get("unmatchedPatternChain", "Q0"),
    };
    const run = (order: Record<string, unknown>) => fromOpenAPI({ openapi: "3.1.0", paths: order, components: { schemas } }, { executor: recordingExecutor() });
    const forward = run(paths);
    const reverse = run(Object.fromEntries(Object.entries(paths).reverse()));
    expect(verdicts(forward)).toEqual([tooDeep("additionalChain"), tooDeep("minItemsChain"), tooDeep("patternChain")]);
    expect(verdicts(reverse)).toEqual(verdicts(forward));
    expect(forward.tools.map(({ name }) => name).sort()).toEqual(["emptyItemsChain", "unmatchedPatternChain"]);
    expect(reverse.tools.map(({ name }) => name).sort()).toEqual(["emptyItemsChain", "unmatchedPatternChain"]);
  }, 120_000);

  it("keeps a forced cycle a valid value can bypass or projection removes, and never runs document patterns as expressions", () => {
    const names = Array.from({ length: 2_000 }, (_, index) => `n${index}`);
    const started = performance.now();
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/alt": body("bypassable", "Alt"),
          "/projected": body("projected", "Node"),
          "/patterns": body("patterns", "Wide"),
          "/backtracking": body("backtracking", "Backtracking"),
        },
        components: {
          schemas: {
            Loop: { type: "object", required: ["next"], properties: { next: { $ref: "#/components/schemas/Loop" } } },
            Alt: { anyOf: [{ type: "null" }, { $ref: "#/components/schemas/Loop" }] },
            // The request drops the read-only link, so `{}` is a valid body.
            Node: { type: "object", required: ["next"], properties: { next: { allOf: [{ $ref: "#/components/schemas/Node" }], readOnly: true } } },
            Wide: { type: "object", required: names, patternProperties: Object.fromEntries(names.map((name) => [`^p${name}$`, { type: "string" }])) },
            Backtracking: { type: "object", required: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!"], patternProperties: { "^(a|a)*$": { type: "string" } } },
          },
        },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    // Matching 2,000 required names against 2,000 patterns is charged before it runs.
    expect(result.skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual([
      ["patterns", "schema-too-large", expect.stringMatching(/^the document's schemas expand in total to more than \d+ nodes$/)],
    ]);
    expect(result.tools.map(({ name }) => name)).toEqual(["bypassable", "projected", "backtracking"]);
    expectArguments(tool(result.tools, "bypassable").inputSchema, { valid: [{ body: null }] });
    expectArguments(tool(result.tools, "projected").inputSchema, { valid: [{ body: {} }] });
  }, 60_000);
});
