import { describe, expect, it, vi } from "vitest";
import { McpFnValidationError } from "../src/errors.js";
import { fromOpenAPI } from "../src/openapi/index.js";
import { McpFnRegistry } from "../src/registry.js";
import { OpenApiSkip, SchemaConverter } from "../src/openapi/schema.js";
import { createSchemaCompiler } from "../src/validation.js";
import { expectArguments, fixture, recordingExecutor, requestExtra, tool } from "./openapi-helpers.js";

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
    // HEAD is checked while converting, the GET tool when it registers.
    expect(result.skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason]).sort()).toEqual([
      ["deep", "schema-too-large", "a schema or reference chain nests too deeply"],
      ["deepHead", "schema-too-large", "a schema or reference chain nests too deeply"],
    ]);
    expect(result.tools.map(({ name }) => name)).toEqual(["short"]);
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

  it("stacks a child forced by required, type or minItems in another allOf member of the same schema", async () => {
    const schemas = {
      ...chain("Q", 2_500, (next) => ({ type: "object", properties: { next }, allOf: [{ required: ["next"] }] })),
      ...chain("Y", 2_500, (next) => ({ required: ["next"], properties: { next }, allOf: [{ type: ["object", "null"] }, { type: ["object", "string"] }] })),
      ...chain("M", 2_500, (items) => ({ allOf: [{ type: "array", minItems: 1 }, { items }] })),
      // An anyOf with another open member need not hold, and a nullable type lets null stop the chain.
      ...chain("V", 2_500, (next) => ({ type: "object", properties: { next }, anyOf: [{ required: ["next"] }, { maxProperties: 0 }] })),
      ...chain("W", 2_500, (next) => ({ required: ["next"], properties: { next }, allOf: [{ type: ["object", "null"] }] })),
      // A forced edge split across a $ref is not analysed (deferred): the registry reports a value too deep to validate.
      ...chain("X", 2_500, (next) => ({ allOf: [{ $ref: "#/components/schemas/Base" }], required: ["next"], properties: { next } })),
      Base: { type: "object" },
    };
    const executor = recordingExecutor();
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/q": body("allOfRequired", "Q0"),
          "/y": body("allOfType", "Y0"),
          "/m": body("allOfMinItems", "M0"),
          "/v": body("anyOfRequired", "V0"),
          "/w": body("nullableAllOf", "W0"),
          "/x": body("crossRef", "X0"),
        },
        components: { schemas },
      },
      { executor, allowMutations: true },
    );
    expect(verdicts(result)).toEqual([tooDeep("allOfMinItems"), tooDeep("allOfRequired"), tooDeep("allOfType")]);
    expect(result.tools.map(({ name }) => name)).toEqual(["anyOfRequired", "nullableAllOf", "crossRef"]);
    // Stay below the argument node limit so the validator reaches its depth limit.
    const deep = { body: nested(20_000) };
    await expect(result.registry.callTool("crossRef", deep, undefined, requestExtra())).rejects.toMatchObject({
      code: "MCPFN_INVALID_ARGUMENTS",
      details: { issues: [expect.objectContaining({ instancePath: "/", keyword: "depth" })] },
    });
    expect(executor.calls).toEqual([]);
  }, 120_000);

  it("measures an optional body as the tool input does, with or without fallback media, and charges wide allOf scans", () => {
    const loop = { $ref: "#/components/schemas/Loop" };
    const names = Array.from({ length: 2_000 }, (_, index) => `n${index}`);
    const members = Array.from({ length: 2_000 }, () => ({ additionalProperties: { type: "string" } }));
    const post = (operationId: string, required: boolean, content: Record<string, unknown>) => ({
      post: { operationId, requestBody: { required, content }, responses: { "204": { description: "Done" } } },
    });
    const started = performance.now();
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/sole": post("optionalSole", false, { "application/json": { schema: loop } }),
          "/media": post("optionalMedia", false, { "application/json": { schema: loop }, "application/example+json": { schema: { type: "string" } } }),
          "/required": post("requiredMedia", true, { "application/json": { schema: loop }, "application/example+json": { schema: { type: "string" } } }),
          "/wide": {
            ...post("wide", true, { "application/json": { schema: { type: "object", required: names, allOf: members } } }),
            // A response only checked is measured in place: its required names are never scanned.
            head: { operationId: "wideHead", responses: json({ type: "object", required: names, allOf: members }) },
          },
          "/ok": post("ok", true, { "application/json": { schema: { type: "object" } } }),
        },
        components: { schemas: { Loop: { type: "object", required: ["next"], properties: { next: loop } } } },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(result.tools.map(({ name, operation }) => [name, operation.requestBody?.contentType])).toEqual([
      ["optionalSole", "application/json"],
      ["optionalMedia", "application/json"],
      ["requiredMedia", "application/example+json"],
      ["wideHead", undefined],
      ["ok", "application/json"],
    ]);
    // 2,000 members each reading 2,000 required names are charged before the scan.
    expect(result.skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual([
      ["wide", "schema-too-large", expect.stringMatching(/^the document's schemas expand in total to more than \d+ nodes$/)],
    ]);
  }, 60_000);

  it("skips every holder of a shared schema whose reuse check the budget cannot pay for, holding no copies for it, so a valid later tool fits", () => {
    const names = Array.from({ length: 2_000 }, (_, index) => `n${index}`);
    const wide = { type: "object", required: names, patternProperties: Object.fromEntries(names.map((name) => [`^p${name}$`, { type: "string" }])) };
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 800; index += 1) paths[`/wide${index}`] = { get: { operationId: `wide${index}`, responses: json({ $ref: "#/components/schemas/Wide" }) } };
    const literal = Array.from({ length: 3_000 }, (_, index) => ({ k: index }));
    paths["/ok"] = { get: { operationId: "ok", responses: json({ type: "object", properties: { a: { type: "string" }, d: { type: "array", default: literal } } }) } };
    const result = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas: { Wide: wide } } }, { executor: recordingExecutor() });
    expect(result.tools.map(({ name }) => name)).toEqual(["ok"]);
    expect(result.registry.has("ok")).toBe(true);
    expect(result.skipped).toHaveLength(800);
    expect(new Set(result.skipped.map(({ code }) => code))).toEqual(new Set(["schema-too-large"]));
  }, 60_000);

  it("fails only the tool whose first reuse check the document budget refuses, and checks again once there is more room", () => {
    const shared = json({ $ref: "#/components/schemas/Shared" });
    const query = (values: number) => [{ name: "q", in: "query", schema: { type: "integer", enum: Array.from({ length: values }, (_, index) => index) } }];
    const document = {
      openapi: "3.1.0",
      paths: {
        "/a": { get: { operationId: "a", responses: shared } },
        // b's larger input leaves less room for the check than c's.
        "/b": { get: { operationId: "b", parameters: query(60), responses: shared } },
        "/c": { get: { operationId: "c", parameters: query(1), responses: shared } },
      },
      components: { schemas: { Shared: { type: "object", required: ["id"], properties: { id: { type: "string" }, tags: { type: "array", items: { type: "string" } } } } } },
    };
    // The first measurement is b's reuse check: the document budget has no room for it then.
    const frames = SchemaConverter.prototype.frames;
    let calls = 0;
    const spy = vi.spyOn(SchemaConverter.prototype, "frames").mockImplementation(function (this: SchemaConverter, ...args: Parameters<typeof frames>) {
      calls += 1;
      if (calls === 1) throw new OpenApiSkip("schema-too-large", "the document's schemas expand in total to more than 1 nodes", true);
      return frames.apply(this, args);
    });
    let result: ReturnType<typeof fromOpenAPI>;
    try {
      result = fromOpenAPI(document, { executor: recordingExecutor() });
    } finally {
      spy.mockRestore();
    }
    // The earlier holder keeps its verdict, and c checks again with the room b's larger input gave back.
    expect(result.tools.map(({ name }) => name)).toEqual(["a", "c"]);
    expect(result.skipped.map(({ operation, code, reason }) => [operation.operationId, code, reason])).toEqual([
      ["b", "schema-too-large", "the document's schemas expand in total to more than 1 nodes"],
    ]);
    expect(result.registry.has("a") && result.registry.has("c")).toBe(true);
  });

  it("matches required names against simple patterns, alone or across allOf members, and never runs patterns with groups", () => {
    const string = { type: "string" };
    const schemas = {
      ...chain("C", 2_500, (member) => ({ type: "object", required: ["x1"], patternProperties: { "^x[0-9]+$": member } })),
      ...chain("D", 2_500, (additionalProperties) => ({ type: "object", required: ["x1"], patternProperties: { "^y[0-9]+$": string }, additionalProperties })),
      ...chain("S", 2_500, (member) => ({ allOf: [{ type: "object", required: ["x1"] }, { patternProperties: { "^x[a-z0-9]$": member } }] })),
      ...chain("G", 2_500, (member) => ({ type: "object", required: ["x1"], patternProperties: { "^(x|y)[0-9]+$": member } })),
    };
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: { "/c": body("classPattern", "C0"), "/d": body("unmatchedClass", "D0"), "/s": body("splitPattern", "S0"), "/g": body("groupPattern", "G0") },
        components: { schemas },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(verdicts(result)).toEqual([tooDeep("classPattern"), tooDeep("splitPattern"), tooDeep("unmatchedClass")]);
    // A pattern with a group is not run while converting: the edge is left unforced.
    expect(result.tools.map(({ name }) => name)).toEqual(["groupPattern"]);
  }, 120_000);

  it("measures an output on its registered root, so the pure aliases inlined there stack no frames", () => {
    const schemas: Record<string, unknown> = chain("R", 50, required);
    for (let index = 0; index < 3_000; index += 1) schemas[`A${index}`] = { $ref: `#/components/schemas/${index + 1 < 3_000 ? `A${index + 1}` : "R0"}` };
    const result = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/aliased": { get: { operationId: "aliased", responses: json({ $ref: "#/components/schemas/A0" }) } } }, components: { schemas } },
      { executor: recordingExecutor() },
    );
    expect(verdicts(result)).toEqual([]);
    expectArguments(tool(result.tools, "aliased").outputSchema!, { valid: [nested(50)], invalid: [nested(49)] });
  }, 60_000);

  it("reports a value too deep for the validator's stack as invalid arguments and rethrows any other validator error", async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const registry = new McpFnRegistry().register({
      name: "tree",
      description: "A recursive value.",
      inputSchema: { type: "object", properties: { next: { $ref: "#/definitions/Node" } }, definitions: { Node: { type: "object", properties: { next: { $ref: "#/definitions/Node" } } } } },
      handler,
    });
    const error = await registry.callTool("tree", nested(20_000), undefined, requestExtra()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(McpFnValidationError);
    expect(error).toMatchObject({ details: { issues: [{ instancePath: "/", keyword: "depth", message: "must not nest too deeply to validate" }] } });
    await expect(registry.callTool("tree", nested(5), undefined, requestExtra())).resolves.toEqual({ content: [] });
    expect(handler).toHaveBeenCalledTimes(1);
    const plain = new McpFnRegistry().register({
      name: "plain",
      description: "Plain.",
      inputSchema: { type: "object", properties: { a: { type: "object", properties: { next: { type: "string" } } } } },
      handler,
    });
    const getter = { get next(): unknown { throw new RangeError("Invalid array length"); } };
    await expect(plain.callTool("plain", { a: getter }, undefined, requestExtra())).rejects.toThrow(new RangeError("Invalid array length"));
    const named = { get next(): unknown { throw new RangeError("call stack configuration is invalid"); } };
    await expect(plain.callTool("plain", { a: named }, undefined, requestExtra())).rejects.toThrow(new RangeError("call stack configuration is invalid"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

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

  it("stacks only the chain every valid input takes: optional bodies and properties, avoidable branches and integer-admitting types start again", () => {
    const schemas = {
      ...chain("R", 2_500, required),
      // number admits integers, so `1` is a valid value and `next` is not forced.
      Num: { allOf: [{ type: ["object", "number"] }, { type: ["object", "integer"] }], required: ["next"], properties: { next: { $ref: "#/components/schemas/Num" } } },
      Branch: { anyOf: [{ type: "string" }, { $ref: "#/components/schemas/R0" }] },
      Holder: { type: "object", properties: { deep: { $ref: "#/components/schemas/R0" } } },
      // A branch every valid value must take still stacks.
      ...chain("S", 2_500, (next) => ({ anyOf: [{ type: "object", required: ["next"], properties: { next } }] })),
      ...chain("G", 2_500, (next) => ({ oneOf: [{ type: "object", required: ["next"], properties: { next } }] })),
      ...chain("K", 2_500, (next) => ({ type: "object", anyOf: [{ type: "string" }, { required: ["next"], properties: { next } }] })),
      ...chain("F", 2_500, (next) => ({ if: true, then: { type: "object", required: ["next"], properties: { next } } })),
      // The type that rules out the other branch sits in an inline allOf member.
      ...chain("Z", 2_500, (next) => ({ allOf: [{ type: "object" }, { anyOf: [{ type: "string" }, { required: ["next"], properties: { next } }] }] })),
    };
    const post = (operationId: string, bodyRequired: boolean, content: Record<string, unknown>) => ({
      post: { operationId, requestBody: { required: bodyRequired, content }, responses: { "204": { description: "Done" } } },
    });
    const ref = (name: string) => ({ schema: { $ref: `#/components/schemas/${name}` } });
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/sole": post("optionalSole", false, { "application/json": ref("R0") }),
          "/media": post("optionalMedia", false, { "application/json": ref("R0"), "application/example+json": { schema: { type: "string" } } }),
          "/num": post("integerAllOf", true, { "application/json": ref("Num") }),
          "/branch": post("shallowBranch", true, { "application/json": ref("Branch") }),
          "/holder": post("optionalProperty", true, { "application/json": ref("Holder") }),
          "/required": post("requiredChain", true, { "application/json": ref("R0") }),
          "/sole-any": post("soleAnyOf", true, { "application/json": ref("S0") }),
          "/sole-one": post("soleOneOf", true, { "application/json": ref("G0") }),
          "/typed-any": post("contradictedAnyOf", true, { "application/json": ref("K0") }),
          "/if": post("alwaysIf", true, { "application/json": ref("F0") }),
          "/all-any": post("allOfTypedAnyOf", true, { "application/json": ref("Z0") }),
          "/fallback": post("soleAnyOfFallback", true, { "application/json": ref("S0"), "application/example+json": { schema: { type: "string" } } }),
          "/out": { get: { operationId: "soleAnyOfOutput", responses: json({ $ref: "#/components/schemas/S0" }) } },
        },
        components: { schemas },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(verdicts(result)).toEqual([
      tooDeep("allOfTypedAnyOf"), tooDeep("alwaysIf"), tooDeep("contradictedAnyOf"), tooDeep("requiredChain"), tooDeep("soleAnyOf"), tooDeep("soleAnyOfOutput"), tooDeep("soleOneOf"),
    ]);
    expect(result.tools.map(({ name, operation }) => [name, operation.requestBody?.contentType])).toEqual([
      ["optionalSole", "application/json"],
      ["optionalMedia", "application/json"],
      ["integerAllOf", "application/json"],
      ["shallowBranch", "application/json"],
      ["optionalProperty", "application/json"],
      ["soleAnyOfFallback", "application/example+json"],
    ]);
    for (const name of ["optionalSole", "optionalMedia", "integerAllOf", "shallowBranch", "optionalProperty"]) {
      expect(result.registry.has(name)).toBe(true);
    }
    const validate = (name: string) => createSchemaCompiler("cfworker").compile(tool(result.tools, name).inputSchema);
    expect([validate("optionalSole")({}), validate("optionalMedia")({}), validate("optionalMedia")({ body: "x" })]).toEqual([true, true, false]);
    expect([validate("integerAllOf")({ body: 1 }), validate("integerAllOf")({ body: 1.5 }), validate("integerAllOf")({ body: {} })]).toEqual([true, false, false]);
    expect([validate("shallowBranch")({ body: "x" }), validate("optionalProperty")({ body: {} })]).toEqual([true, true]);
    // Ajv decides by its compile, and the recursive integer form compiles there too.
    expectArguments(tool(result.tools, "integerAllOf").inputSchema, { valid: [{ body: 1 }, { body: { next: 2 } }], invalid: [{ body: 1.5 }, { body: {} }] });
  }, 120_000);

  it("stacks every declared property of a closed object minProperties forces, and every required name as an own property", () => {
    const closed = (next: unknown) => ({ type: "object", additionalProperties: false, minProperties: 1, properties: { next } });
    const schemas = {
      ...chain("C", 2_500, closed),
      // A second declared name or an open object lets a valid value leave `next` out.
      ...chain("D", 2_500, (next) => ({ type: "object", additionalProperties: false, minProperties: 1, properties: { next, v: { type: "integer" } } })),
      ...chain("O", 2_500, (next) => ({ type: "object", minProperties: 1, properties: { next } })),
      // A required name is an own property, `toString` included, so these chains never end.
      Inherited: { anyOf: [{ type: "object", required: ["toString"], additionalProperties: { $ref: "#/components/schemas/Inherited" } }] },
      Pattern: { type: "object", required: ["toString"], patternProperties: { "^to": { $ref: "#/components/schemas/Pattern" } } },
      // The closed member's `minProperties` forces `next` for the other member's recursion.
      Owned: { type: "object", allOf: [{ required: ["toString"] }, { properties: { toString: { type: "object" } } }, { patternProperties: { "^toString$": { $ref: "#/components/schemas/Owned" } } }] },
      // Two closed members admit only `next`, which `minProperties` then forces.
      // A name declared false is never owned.
      ...chain("X", 2_500, (next) => ({ type: "object", additionalProperties: false, minProperties: 1, properties: { next, dead: false } })),
      ...chain("I", 2_500, (next) => ({ type: "object", minProperties: 1, allOf: [
        { additionalProperties: false, properties: { next, a: { type: "integer" } } },
        { additionalProperties: false, properties: { next: true, b: { type: "integer" } } },
      ] })),
      ClosedAllOf: { type: "object", minProperties: 1, allOf: [{ additionalProperties: false, properties: { next: true } }, { properties: { next: { $ref: "#/components/schemas/ClosedAllOf" } } }] },
      // A name another allOf member declares false leaves the closed member only `next`;
      // a false name the closed member does not admit anyway leaves `alt` as a shallow choice.
      ...chain("F", 2_500, (next) => ({ type: "object", allOf: [{ additionalProperties: false, minProperties: 1, properties: { next, alt: {} } }, { properties: { alt: false } }] })),
      ...chain("G", 2_500, (next) => ({ type: "object", allOf: [{ additionalProperties: false, minProperties: 1, properties: { next, alt: {} } }, { properties: { other: false } }] })),
      Named: { type: "object", required: ["toString"] },
    };
    const post = (operationId: string, content: Record<string, unknown>) => ({
      post: { operationId, requestBody: { required: true, content }, responses: { "204": { description: "Done" } } },
    });
    const ref = (name: string) => ({ schema: { $ref: `#/components/schemas/${name}` } });
    const result = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/closed": post("closedMin", { "application/json": ref("C0") }),
          "/fallback": post("closedMinFallback", { "application/json": ref("C0"), "application/example+json": { schema: { type: "string" } } }),
          "/out": { get: { operationId: "closedMinOutput", responses: json({ $ref: "#/components/schemas/C0" }) } },
          "/choice": post("closedChoice", { "application/json": ref("D0") }),
          "/open": post("openMin", { "application/json": ref("O0") }),
          "/inherited": { ...post("inherited", { "application/json": ref("Inherited") }), get: { operationId: "inheritedOutput", responses: json({ $ref: "#/components/schemas/Inherited" }) } },
          "/pattern": post("inheritedPattern", { "application/json": ref("Pattern") }),
          "/owned": { ...post("ownedInherited", { "application/json": ref("Owned") }), get: { operationId: "ownedInheritedOutput", responses: json({ $ref: "#/components/schemas/Owned" }) } },
          "/closed-all-of": post("closedAllOf", { "application/json": ref("ClosedAllOf") }),
          "/intersection": post("closedIntersection", { "application/json": ref("I0") }),
          "/dead": post("closedDead", { "application/json": ref("X0") }),
          "/false-member": post("closedFalseMember", { "application/json": ref("F0") }),
          "/false-other": post("closedFalseOther", { "application/json": ref("G0") }),
          "/named": post("requiredToString", { "application/json": ref("Named") }),
        },
        components: { schemas },
      },
      { executor: recordingExecutor(), allowMutations: true },
    );
    expect(verdicts(result)).toEqual([
      tooDeep("closedAllOf"), tooDeep("closedDead"), tooDeep("closedFalseMember"), tooDeep("closedIntersection"), tooDeep("closedMin"), tooDeep("closedMinOutput"),
      tooDeep("inherited"), tooDeep("inheritedOutput"), tooDeep("inheritedPattern"), tooDeep("ownedInherited"), tooDeep("ownedInheritedOutput"),
    ]);
    expect(result.tools.map(({ name, operation }) => [name, operation.requestBody?.contentType])).toEqual([
      ["closedMinFallback", "application/example+json"],
      ["closedChoice", "application/json"],
      ["openMin", "application/json"],
      ["closedFalseOther", "application/json"],
      ["requiredToString", "application/json"],
    ]);
    const validate = (name: string) => createSchemaCompiler("cfworker").compile(tool(result.tools, name).inputSchema);
    expect([validate("closedChoice")({ body: { v: 1 } }), validate("openMin")({ body: { x: 1 } }), validate("closedFalseOther")({ body: { alt: 1 } })])
      .toEqual([true, true, true]);
    // Both engines check own properties only: the inherited `toString` does not satisfy `required`.
    for (const engine of ["cfworker", "ajv"] as const) {
      const named = createSchemaCompiler(engine).compile(tool(result.tools, "requiredToString").inputSchema);
      expect([named({ body: {} }), named({ body: { toString: "x" } })]).toEqual([false, true]);
    }
  }, 120_000);

  it("skips a schema that declares or requires __proto__ in a body, nested schema or response, as under Ajv", () => {
    const result = fromOpenAPI(fixture("skip-prototype-property-name"), { executor: recordingExecutor(), allowMutations: true });
    expect(verdicts(result).map(([operationId, code]) => [operationId, code])).toEqual([
      ["protoBody", "unsupported-property-name"], ["protoNested", "unsupported-property-name"], ["protoOptional", "unsupported-property-name"],
      ["protoOutput", "unsupported-property-name"], ["protoRequired", "unsupported-property-name"], ["protoSplit", "unsupported-property-name"],
    ]);
    expect(result.tools.map(({ name }) => name)).toEqual(["plainBody"]);
    const validate = createSchemaCompiler("cfworker").compile(tool(result.tools, "plainBody").inputSchema);
    expect([validate({ body: { proto: {} } }), validate({ body: {} })]).toEqual([true, false]);
    // A wide allOf beside the name is converted within the document budget, never scanned for it apart.
    const allOf = Array.from({ length: 20_000 }, (_, index) => ({ required: [`p${index % 10}`] }));
    const started = performance.now();
    const wide = fromOpenAPI(JSON.parse(JSON.stringify({
      openapi: "3.1.0",
      paths: {
        "/wide": { post: { operationId: "wideProto", requestBody: { required: true, content: { "application/json": { schema: { type: "object", allOf, properties: { PROTO: { type: "string" } } } } } }, responses: { "204": { description: "Done" } } } },
        "/flat": { post: { operationId: "wideFlat", requestBody: { required: true, content: { "application/json": { schema: { type: "object", allOf } } } }, responses: { "204": { description: "Done" } } } },
      },
    }).replaceAll("PROTO", "__proto__")) as Record<string, unknown>, { executor: recordingExecutor(), allowMutations: true });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(verdicts(wide).map(([operationId, code]) => [operationId, code])).toEqual([["wideProto", "unsupported-property-name"]]);
    expect(wide.tools.map(({ name }) => name)).toEqual(["wideFlat"]);
  });

  it("refuses tool arguments with an inherited enumerable property, as under Ajv", async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const registry = new McpFnRegistry().register({
      name: "closed",
      description: "Named object.",
      inputSchema: { type: "object", properties: { name: { type: "string" } }, additionalProperties: false },
      handler,
    });
    await expect(registry.callTool("closed", Object.assign(Object.create({ inherited: 1 }), { name: "ok" }), undefined, requestExtra()))
      .rejects.toMatchObject({ code: "MCPFN_INVALID_ARGUMENTS", details: { issues: [expect.objectContaining({ keyword: "ownProperties" })] } });
    expect(handler).not.toHaveBeenCalled();
  });

  it("skips a __proto__ parameter, required or optional, as under Ajv", () => {
    const result = fromOpenAPI(fixture("skip-prototype-parameter-name"), { executor: recordingExecutor() });
    const reason = "query parameter __proto__ cannot be declared: the validators do not read that property name alike";
    expect(verdicts(result)).toEqual([["listItems", "unsupported-parameter-name", reason], ["listRequired", "unsupported-parameter-name", reason]]);
    expect(result.tools.map(({ name }) => name)).toEqual(["listPlain"]);
  });
});
