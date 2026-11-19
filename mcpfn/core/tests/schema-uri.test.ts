import { describe, expect, it } from "vitest";
import uri from "fast-uri";
import { schemaUriResolver } from "../src/schema-uri.js";
import { createSchemaCompiler, validateSchemaCollection } from "../src/validation.js";

describe("patched URI resolver JSON Pointer compatibility", () => {
  describe.each(["ajv", "cfworker"] as const)("%s", engine => {
    it.each([
      ["#%2F$defs%2Fnode", "node"],
      ["#%2f%24defs%2fnode", "node"],
      ["#/$defs/a%7E1b", "a/b"],
      ["#/$defs/%257E1", "%7E1"],
      ["#/$defs/a%20b", "a b"],
      ["#/$defs/", ""],
      ["#/$defs/%252F", "%2F"],
      ["#/$defs/a~1b", "a/b"],
      ["#/$defs/%E2%9C%93", "✓"],
      ["#/$defs/~0value", "~value"],
    ])("resolves %s without decoding tokens twice", (reference, key) => {
      const schema = {
        type: "object",
        $defs: { [key]: { type: "string" } },
        properties: { value: { $ref: reference } },
      };
      const before = structuredClone(schema);
      const validate = createSchemaCompiler(engine).compile(schema);
      expect(() => validateSchemaCollection([schema], engine)).not.toThrow();
      expect(schema).toEqual(before);
      expect(validate({ value: "correct" })).toBe(true);
      expect(validate({ value: 42 })).toBe(false);
    });
    it("resolves encoded pointers into previously registered resources", () => {
      const target = { $id: "https://example.test/target", $defs: { "a/b": { type: "string" } } };
      const consumer = { $ref: "https://example.test/target#%2F$defs%2Fa~1b" };
      const compiler = createSchemaCompiler(engine);
      compiler.compile(target);
      const validate = compiler.compile(consumer);
      expect(validate("ok")).toBe(true);
      expect(validate(42)).toBe(false);
      expect(() => validateSchemaCollection([consumer, target], engine)).not.toThrow();
    });
    it("does not decode percent-escaped pointer content twice", () => {
      expect(() => createSchemaCompiler(engine).compile({
        $defs: { node: { type: "string" } }, $ref: "#%252F$defs%252Fnode",
      })).toThrow();
    });
  });
  it.each([
    "https://EXAMPLE.test/path#%2F$defs%2Fnode",
    "https://%65xample.test/path#%2F$defs%2Fnode",
    "https://[::1]/path#%2F$defs%2Fnode",
  ])("preserves patched authority handling for %s", reference => {
    const { fragment: originalFragment, ...original } = uri.parse(reference);
    const { fragment, ...adapted } = schemaUriResolver.parse(reference);
    expect(adapted).toEqual(original);
    expect(fragment).toBe("/%24defs/node");
    expect(originalFragment).toBeDefined();
  });
});

describe("URI scheme authority validation", () => {
  it.each(["%6Aavascript:alert(1)", "%u006Aavascript:alert(1)"])("rejects encoded scheme %s before schema resolution", reference => {
    expect(schemaUriResolver.parse(reference)).toMatchObject({ error: "URI scheme is malformed.", scheme: reference.split(":")[0] });
    expect(() => createSchemaCompiler("ajv").compile({ type: "object", $ref: reference })).toThrow();
  });
});

it("limits anonymous-root adaptation to literal relative dot segments", () => {
  for (const reference of [".", "./", "../", "../../", "./../"]) {
    expect(schemaUriResolver.resolve("", reference)).toBe("");
    expect(schemaUriResolver.resolve("#", reference + "#node")).toBe("#node");
  }
  for (const reference of ["/", "//authority.test/", "%2e", ".?query", "a/..", "https://schema-collection.mcpfn.invalid/0-0"]) {
    expect(schemaUriResolver.resolve("", reference)).toBe(uri.resolve("", reference));
    expect(schemaUriResolver.resolve("", reference)).not.toBe("");
  }
  expect(schemaUriResolver.resolve("https://example.test/path/", "../")).toBe(uri.resolve("https://example.test/path/", "../"));
});
