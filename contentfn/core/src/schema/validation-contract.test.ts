import { describe, expect, it } from "vitest";
import { validateSchema } from "./validateSchema.js";
const schema = (field: unknown) => ({ version: 1, documentTypes: [{ name: "post", fields: [field] }] });
describe("declarative schema contract", () => {
  it("accepts forward and recursive reference declarations", () => {
    expect(validateSchema({ version: 1, documentTypes: [
      { name: "post", fields: [{ name: "author", type: { kind: "reference", to: ["author"] } }] },
      { name: "author", fields: [{ name: "posts", type: { kind: "array", of: [{ kind: "reference", to: ["post"] }] } }] },
    ] }).ok).toBe(true);
  });
  it.each([
    { name: "x", type: { kind: "array", of: [null] } },
    { name: "x", type: { kind: "array", of: [{ kind: "primitive", type: "number" }], maxLength: 1.5 } },
    { name: "x", type: { kind: "primitive", type: "number" }, validation: [{ rule: "min", value: Infinity }] },
    { name: "x", type: { kind: "primitive", type: "number" }, validation: [{ rule: "regex", value: "x" }] },
    { name: "x", type: { kind: "primitive", type: "string" }, validation: [{ rule: "regex", value: "[" }] },
    { name: "x", type: { kind: "primitive", type: "string" }, validation: [{ rule: "unique" }] },
    { name: "x", type: { kind: "primitive", type: "string" }, required: "yes" },
    { name: "x", type: { kind: "richtext", allowMarks: [false] } },
    { name: "x", type: { kind: "reference", to: ["post"], weak: "yes" } },
  ])("rejects malformed or inapplicable rules %#", field => {
    expect(validateSchema(schema(field))).toMatchObject({ ok: false, error: { code: "SCHEMA_INVALID" } });
  });
  it.each([Infinity, NaN, 1.5])("rejects non-integer schema version %s", version => {
    expect(validateSchema({ ...schema({ name: "x", type: { kind: "primitive", type: "string" } }), version }).ok).toBe(false);
  });
});
