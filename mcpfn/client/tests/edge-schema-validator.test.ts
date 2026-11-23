import { describe, expect, it } from "vitest";

import { EdgeJsonSchemaValidator, edgeSchemaDraft } from "../src/edge-schema-validator.js";

describe("edge tool output schema dialect", () => {
  it.each([
    [undefined, "2020-12"],
    ["http://json-schema.org/draft-04/schema#", "4"],
    ["https://json-schema.org/draft-04/schema", "4"],
    ["http://json-schema.org/draft-07/schema#", "7"],
    ["http://json-schema.org/draft-07/schema", "7"],
    ["https://json-schema.org/draft-07/schema#", "7"],
    ["https://json-schema.org/draft/2019-09/schema", "2019-09"],
    ["http://json-schema.org/draft/2019-09/schema#", "2019-09"],
    ["https://json-schema.org/draft/2020-12/schema", "2020-12"],
    ["https://json-schema.org/draft/2020-12/schema#", "2020-12"],
  ])("maps $schema %s to cfworker draft %s", (declared, draft) => {
    const schema = declared === undefined ? { type: "object" } : { $schema: declared, type: "object" };
    expect(edgeSchemaDraft(schema as never)).toBe(draft);
  });

  it.each([
    "http://json-schema.org/draft-06/schema#",
    "http://json-schema.org/draft-03/schema#",
    "https://example.test/custom-dialect",
    "",
    42,
  ])("reports %j as unsupported", (declared) => {
    expect(edgeSchemaDraft({ $schema: declared, type: "object" } as never)).toBeUndefined();
    const validate = new EdgeJsonSchemaValidator().getValidator({
      $schema: declared,
      type: "object",
    } as never);
    expect(validate({})).toMatchObject({
      valid: false,
      errorMessage: expect.stringContaining("unsupported JSON Schema dialect"),
    });
  });

  it("applies the declared draft, and 2020-12 when none is declared", () => {
    const validator = new EdgeJsonSchemaValidator();
    const refSibling = (declared?: string) =>
      validator.getValidator({
        ...(declared ? { $schema: declared } : {}),
        definitions: { name: { type: "string" } },
        $ref: "#/definitions/name",
        minLength: 2,
      } as never);
    expect(refSibling("http://json-schema.org/draft-07/schema#")("a").valid).toBe(true);
    expect(refSibling()("a").valid).toBe(false);
    expect(refSibling("https://json-schema.org/draft/2019-09/schema")("a").valid).toBe(false);

    const exclusive = validator.getValidator({
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "number",
      minimum: 5,
      exclusiveMinimum: true,
    } as never);
    expect(exclusive(5).valid).toBe(false);
    expect(exclusive(6).valid).toBe(true);
  });
});
