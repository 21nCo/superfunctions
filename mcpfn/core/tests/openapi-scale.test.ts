import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { McpFnRegistry } from "../src/index.js";
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

  // SFNS-107 PR round 2: with a custom compileSchema, each of 2,000
  // operations whose input and output schemas are all equal still reaches the
  // compiler (4,000 compiles), and checking for a reusable validator stays
  // constant time per schema, so registration stays linear.
  it("registers 2,000 operations with equal schemas on a custom compiler within 2 seconds", () => {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 2000; index += 1) {
      paths[`/ping${index}`] = {
        get: {
          operationId: `ping${index}`,
          responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object", properties: { ok: { type: "boolean" } } } } } } },
        },
      };
    }
    const ajv = new Ajv({ strict: false });
    const compiled: object[] = [];
    const registry = new McpFnRegistry({
      compileSchema: (schema) => {
        compiled.push(schema);
        return ajv.compile(schema);
      },
    });
    const started = performance.now();
    const { tools, skipped } = fromOpenAPI({ openapi: "3.0.3", paths }, { executor: recordingExecutor(), registry });
    const copy = registry.clone();
    const elapsed = performance.now() - started;
    expect(tools).toHaveLength(2000);
    expect(skipped).toEqual([]);
    expect(copy.listTools()).toHaveLength(2000);
    expect(compiled).toHaveLength(4000);
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
    // Registration compiles H with the runtime validator, so time is measured
    // where only the kinds are settled: a query parameter that can be an object is skipped uncompiled.
    const members = Array.from({ length: 3000 }, () => ({ type: "object", items: { $ref: "#/components/schemas/H" } }));
    const response = { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/H" } } } } };
    const query = { name: "q", in: "query", schema: { $ref: "#/components/schemas/H" } };
    let started = performance.now();
    const settled = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/q": { get: { operationId: "q", parameters: [query], responses: ok } } }, components: { schemas: { H: { type: "object", allOf: members } } } },
      { executor: recordingExecutor() },
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(settled.skipped.map((entry) => entry.code)).toEqual(["unsupported-parameter-schema"]);
    const wide = fromOpenAPI(
      { openapi: "3.1.0", paths: { "/h": { get: { operationId: "h", responses: response }, head: { operationId: "hh", responses: response } } }, components: { schemas: { H: { type: "object", allOf: members } } } },
      { executor: recordingExecutor() },
    );
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

  it("checks shared security requirements and a shared malformed enum once for 4,000 operations within 2 seconds", () => {
    // One document-level requirement with 4,000 schemes, inherited by every operation.
    const requirement = Object.fromEntries(Array.from({ length: 4000 }, (_, index) => [`scheme${index}`, []]));
    const inherited: Record<string, unknown> = {};
    for (let index = 0; index < 4000; index += 1) inherited[`/g${index}`] = { get: { operationId: `g${index}`, responses: ok } };
    let started = performance.now();
    const secured = fromOpenAPI({ openapi: "3.1.0", security: [requirement], paths: inherited }, { executor: recordingExecutor() });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(secured.tools).toHaveLength(4000);
    expect(secured.tools[0]!.operation.security).toEqual([requirement]);
    // 4,000 wrappers share one 4,000-entry enum whose last literal is a sparse array: its failure is kept.
    const sparse: unknown[] = [];
    sparse[0] = 1;
    sparse.length = 3;
    const shared = [...Array.from({ length: 4000 }, (_, index) => index), sparse];
    const paths: Record<string, unknown> = { "/ok": { get: { operationId: "ok", responses: ok } } };
    for (let index = 0; index < 4000; index += 1) {
      paths[`/r${index}`] = { get: { operationId: `r${index}`, responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Broken", enum: shared } } } } } } };
    }
    started = performance.now();
    const malformed = fromOpenAPI({ openapi: "3.1.0", paths, components: { schemas: { Broken: { $ref: "#/components/schemas/Missing" } } } }, { executor: recordingExecutor() });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(malformed.tools.map((entry) => entry.name)).toEqual(["ok"]);
    expect(malformed.skipped).toHaveLength(4000);
    // A chain A1..A2000 ($ref forward, items back; A1's back link missing) ending in a 3,000-member recursive allOf:
    // the nodes left open by A1's failure keep it, so later roots do not walk the wide list again.
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
    const chain: Record<string, unknown> = {
      A2000: { allOf: Array.from({ length: 3000 }, () => ({ items: ref("A2000") })), items: ref("A1999") },
    };
    for (let index = 1; index < 2000; index += 1) chain[`A${index}`] = { ...ref(`A${index + 1}`), items: ref(index === 1 ? "Missing" : `A${index - 1}`) };
    const roots: Record<string, unknown> = {};
    for (let index = 1; index <= 2000; index += 1) {
      roots[`/a${index}`] = { get: { operationId: `a${index}`, responses: { "200": { description: "OK", content: { "application/json": { schema: { ...ref(`A${index}`), prefixItems: [] } } } } } } };
    }
    started = performance.now();
    const chained = fromOpenAPI({ openapi: "3.1.0", paths: roots, components: { schemas: chain } }, { executor: recordingExecutor() });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(chained.skipped).toHaveLength(2000);
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
