import { describe, expect, it, vi } from "vitest";
import { fromOpenAPI } from "../src/openapi/index.js";
import { recordingExecutor } from "./openapi-helpers.js";

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
});
