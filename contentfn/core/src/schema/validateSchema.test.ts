/**
 * Schema validator tests (TV-SCHEMA-UPSERT-002: invalid schema duplicate type).
 */

import { describe, it, expect } from "vitest";
import { validateSchema } from "./validateSchema.js";

describe("validateSchema", () => {
  describe("TV-SCHEMA-UPSERT-002: invalid schema - duplicate document type name", () => {
    it("rejects duplicate document type name with SCHEMA_INVALID and details.path", () => {
      const input = {
        version: 1,
        documentTypes: [
          {
            name: "post",
            fields: [
              {
                name: "title",
                type: { kind: "primitive", type: "string" },
                required: true,
              },
            ],
          },
          {
            name: "post",
            fields: [],
          },
        ],
      };
      const result = validateSchema(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SCHEMA_INVALID");
        expect(result.error.details.path).toContain("name");
        expect(result.error.details.type).toBe("post");
      }
    });
  });

  it("accepts valid schema with unique type names", () => {
    const input = {
      version: 1,
      documentTypes: [
        { name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" }, required: true }] },
        { name: "author", fields: [{ name: "name", type: { kind: "primitive", type: "string" }, required: true }] },
      ],
    };
    const result = validateSchema(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.documentTypes).toHaveLength(2);
  });

  it("validates the explicit Markdown field contract", () => {
    const valid = validateSchema({
      version: 1,
      documentTypes: [{ name: "page", fields: [{ name: "body", type: { kind: "markdown", dialect: "gfm", allowRawHtml: false, extensions: ["callout"], schemaVersion: 1 } }] }],
    });
    expect(valid.ok).toBe(true);
    const invalid = validateSchema({
      version: 1,
      documentTypes: [{ name: "page", fields: [{ name: "body", type: { kind: "markdown", dialect: "unknown" } }] }],
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.details.path).toContain("dialect");
  });
});
