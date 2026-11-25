import { describe, expect, it, vi } from "vitest";
import { fromOpenAPI } from "../src/openapi/index.js";
import { expectArguments, recordingExecutor, tool } from "./openapi-helpers.js";

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
});
