import { describe, expect, it } from "vitest";
import { fromOpenAPI } from "../src/openapi/index.js";
import { recordingExecutor } from "./openapi-helpers.js";

// vitest.config.ts runs this file after the other test files, so the timing
// is not shared with their module collection and tests.

const ok = { "200": { description: "OK" } };

describe("fromOpenAPI scale", () => {
  // End to end: every tool goes through McpFnRegistry.register, which
  // compiles its input and output schemas with the runtime validator.
  it("converts and registers a 2,000-operation document within 2 seconds", () => {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 1000; index += 1) {
      paths[`/resources${index}/{id}`] = {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          operationId: `getResource${index}`,
          parameters: [{ name: `fields${index}`, in: "query", schema: { type: "array", items: { type: "string" } } }],
          responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Resource" } } } } },
        },
        put: {
          operationId: `putResource${index}`,
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Resource" } } } },
          responses: ok,
        },
      };
    }
    const document = {
      openapi: "3.0.3",
      paths,
      components: {
        schemas: {
          Resource: { type: "object", properties: { id: { type: "string", readOnly: true }, name: { type: "string" }, children: { type: "array", items: { $ref: "#/components/schemas/Resource" } } } },
        },
      },
    };
    const started = performance.now();
    const { registry, tools, skipped } = fromOpenAPI(document, { executor: recordingExecutor(), allowMutations: true });
    const elapsed = performance.now() - started;
    expect(tools).toHaveLength(2000);
    expect(skipped).toEqual([]);
    expect(registry.listTools()).toHaveLength(2000);
    expect(tools.filter((entry) => entry.outputSchema)).toHaveLength(1000);
    expect(elapsed).toBeLessThan(2000);
  });

  it("suffixes 2,000 colliding names within 2 seconds", () => {
    const shared = "o".repeat(128);
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 2000; index += 1) {
      paths[`/r${index}`] = { get: { operationId: `${shared}${index}`, responses: ok } };
    }
    const started = performance.now();
    const { tools } = fromOpenAPI({ openapi: "3.1.0", paths }, { executor: recordingExecutor() });
    const elapsed = performance.now() - started;
    expect(tools.map((entry) => entry.name)).toEqual(
      Array.from({ length: 2000 }, (_, index) => (index === 0 ? shared : `${shared.slice(0, 128 - `_${index + 1}`.length)}_${index + 1}`)),
    );
    expect(elapsed).toBeLessThan(2000);
  });
});
