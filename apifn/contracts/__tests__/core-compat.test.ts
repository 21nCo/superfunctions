import { stringify } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { buildOperationCatalog } from "../src/index.js";
import { clone, fixture } from "./helpers.js";

/**
 * The published @apifn/core 0.0.3, which a packed @apifn/contracts installs,
 * upconverts OpenAPI 3.0 by plain assignment and so loses own "__proto__" keys.
 * The catalog must not depend on which core is installed.
 */
vi.mock("@apifn/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@apifn/core")>();
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const upconvertNode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(upconvertNode);
    if (!isObject(value)) return value;
    const output: Record<string, unknown> = {};
    for (const [key, nodeValue] of Object.entries(value)) {
      if (key === "nullable" && nodeValue === true) continue;
      output[key] = upconvertNode(nodeValue);
    }
    if (value.nullable === true && typeof output.type === "string") output.type = [output.type, "null"];
    return output;
  };
  const parseOpenAPI = (input: string | Record<string, unknown>) => {
    if (typeof input === "string" || !String(input.openapi).startsWith("3.0.")) return actual.parseOpenAPI(input);
    return { ...(upconvertNode(input) as Record<string, unknown>), openapi: "3.1.0" };
  };
  return { ...actual, parseOpenAPI };
});

const PROTO_SCHEMAS: Array<[name: string, schema: string, member: string, keys: string[]]> = [
  ["a literal", '{"type":"object","default":{"__proto__":"x","a":1}}', "default", ["__proto__", "a"]],
  ["an object literal", '{"type":"object","default":{"__proto__":{"b":2},"a":1}}', "default", ["__proto__", "a"]],
  ["a property name", '{"type":"object","properties":{"__proto__":{"type":"string"},"a":{"type":"string"}}}', "properties", ["__proto__", "a"]],
  ["a property beside the stand-in name", '{"type":"object","properties":{"__proto__":{"type":"string"},"__proto__\\u0000":{"type":"integer"}}}', "properties", ["__proto__", "__proto__\u0000"]],
];

describe("OpenAPI 3.0 __proto__ keys with the published @apifn/core upconvert", () => {
  const versioned = (version: string, schema: string) => {
    const spec = clone(fixture("catalog/openapi.json"));
    spec.openapi = version;
    spec.components.schemas.ProjectInput.properties.meta = JSON.parse(schema);
    return spec;
  };

  it.each(PROTO_SCHEMAS)("keeps a __proto__ key in %s as 3.1 does", (_name, schema, member, keys) => {
    const current = buildOperationCatalog(versioned("3.1.0", schema), clone(fixture("catalog/manifest.json")));
    expect(current.diagnostics).toEqual([]);
    for (const input of [versioned("3.0.3", schema), JSON.stringify(versioned("3.0.3", schema)), stringify(versioned("3.0.3", schema))]) {
      const legacy = buildOperationCatalog(input, clone(fixture("catalog/manifest.json")));
      expect(legacy.diagnostics).toEqual([]);
      expect(Object.keys((legacy.catalog!.schemas.ProjectInput as any).properties.meta[member])).toEqual(keys);
      expect(canonicalJson(legacy)).toBe(canonicalJson(current));
    }
  });

  it("still upconverts nullable through the installed core", () => {
    const schema = '{"type":"object","properties":{"__proto__":{"type":"string","nullable":true}}}';
    const legacy = buildOperationCatalog(versioned("3.0.3", schema), clone(fixture("catalog/manifest.json")));
    expect(legacy.diagnostics).toEqual([]);
    expect((legacy.catalog!.schemas.ProjectInput as any).properties.meta.properties.__proto__).toEqual({ type: ["string", "null"] });
  });
});
