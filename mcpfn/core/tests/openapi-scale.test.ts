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

  it("settles the kinds of a recursive diamond of schemas once for 2,000 operations within 2 seconds", () => {
    // A -> (B, C) -> D, and D's items refer back to A: one cycle every response and body reaches.
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const schemas = {
      A: { properties: { x: { type: "string" } }, allOf: [ref("B"), ref("C")] },
      B: { anyOf: [ref("D"), { type: "object" }] },
      C: { allOf: [ref("D")] },
      D: { type: "object", items: ref("A") },
    };
    const names = Object.keys(schemas);
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 1000; index += 1) {
      const schema = ref(names[index % names.length]!);
      paths[`/d${index}`] = {
        get: { operationId: `get${index}`, responses: { "200": { description: "OK", content: { "application/json": { schema } } } } },
        post: { operationId: `post${index}`, requestBody: { content: { "application/json": { schema: { ...schema } } } }, responses: ok },
      };
    }
    const started = performance.now();
    const { tools, skipped } = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas } }, { executor: recordingExecutor(), allowMutations: true });
    const elapsed = performance.now() - started;
    expect(skipped).toEqual([]);
    expect(tools).toHaveLength(2000);
    expect(tools.filter((entry) => entry.outputSchema)).toHaveLength(1000);
    expect(elapsed).toBeLessThan(2000);
  });

  it("settles a wide productive cycle and a widely shared type list beside a broken $ref within 2 seconds", () => {
    // H = allOf of 3,000 members whose items refer back to H: each narrowing reaches the list once, not once per member.
    const members = Array.from({ length: 3000 }, () => ({ type: "object", items: { $ref: "#/components/schemas/H" } }));
    const response = { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/H" } } } } };
    let started = performance.now();
    const wide = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/h": { get: { operationId: "h", responses: response }, head: { operationId: "hh", responses: response } } }, components: { schemas: { H: { type: "object", allOf: members } } } },
      { executor: recordingExecutor() },
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(wide.skipped).toEqual([]);
    expect(wide.tools.map((entry) => [entry.name, entry.outputSchema !== undefined])).toEqual([["h", true], ["hh", false]]);
    // 2,000 roots share one 20,000-entry type list beside a $ref whose target fails: the list is read once.
    const type = Array.from({ length: 20_000 }, () => "object");
    const paths: Record<string, unknown> = { "/ok": { get: { operationId: "ok", responses: ok } } };
    for (let index = 0; index < 2000; index += 1) {
      paths[`/r${index}`] = { get: { operationId: `r${index}`, responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Broken", type } } } } } } };
    }
    started = performance.now();
    const broken = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas: { Broken: { $ref: "#/components/schemas/Missing" } } } }, { executor: recordingExecutor() });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(broken.tools.map((entry) => entry.name)).toEqual(["ok"]);
    expect(broken.skipped.map((entry) => entry.code)).toEqual(Array.from({ length: 2000 }, () => "unresolved-ref"));
    // The same list beside a resolvable $ref and inside distinct type-only `not` wrappers is reduced once.
    const resolvable: Record<string, unknown> = { "/ok": { get: { operationId: "ok", responses: ok } } };
    for (let index = 0; index < 2000; index += 1) {
      resolvable[`/r${index}`] = { get: { operationId: `r${index}`, responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/S", type, not: { type } } } } } } } };
    }
    started = performance.now();
    const reduced = fromOpenAPI({ openapi: "3.1.0", paths: resolvable, components: { schemas: { S: { type: "object" } } } }, { executor: recordingExecutor() });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(reduced.tools.map((entry) => entry.name)).toEqual(["ok"]);
    expect(reduced.skipped).toHaveLength(2000);
    // 20,000 enum entries that are one 20,000-item array: its item kinds are read once, not once per entry.
    const big = Array.from({ length: 20_000 }, () => 1);
    started = performance.now();
    const aliased = fromOpenAPI(
      {
        openapi: "3.1.0",
        paths: {
          "/r": { get: { operationId: "r", responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Broken", enum: Array.from({ length: 20_000 }, () => big) } } } } } } },
          "/ok": { get: { operationId: "ok", responses: ok } },
        },
        components: { schemas: { Broken: { $ref: "#/components/schemas/Missing" } } },
      },
      { executor: recordingExecutor() },
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(aliased.skipped.map((entry) => [entry.operation.operationId, entry.code])).toEqual([["r", "unresolved-ref"]]);
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
