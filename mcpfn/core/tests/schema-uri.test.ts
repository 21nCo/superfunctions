import { describe, expect, it } from "vitest";
import uri from "fast-uri";
import { schemaUriResolver } from "../src/schema-uri.js";
import { createSchemaCompiler } from "../src/validation.js";

describe("patched URI resolver JSON Pointer compatibility", () => {
  it.each([
    ["#%2F$defs%2Fnode", "node"],
    ["#/$defs/%252F", "%2F"],
    ["#/$defs/a~1b", "a/b"],
    ["#/$defs/%E2%9C%93", "✓"],
    ["#/$defs/~0value", "~value"],
  ])("resolves %s without decoding tokens twice", (reference, key) => {
    const validate = createSchemaCompiler("ajv").compile({
      type: "object",
      $defs: { [key]: { type: "string" } },
      properties: { value: { $ref: reference } },
    });
    expect(validate({ value: "correct" })).toBe(true);
    expect(validate({ value: 42 })).toBe(false);
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
