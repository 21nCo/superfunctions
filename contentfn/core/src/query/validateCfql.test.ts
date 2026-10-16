/**
 * CFQL validator tests (TV-QRY-INVALID-001: invalid operator).
 */

import { describe, it, expect } from "vitest";
import { validateCfql } from "./validateCfql.js";

describe("validateCfql", () => {
  describe("TV-QRY-INVALID-001: invalid operator", () => {
    it("rejects unknown filter operator with QUERY_INVALID and details.path includes filter.op", () => {
      const input = {
        dataset: "prod",
        types: ["post"],
        filter: { field: "title", op: "wat", value: "A" },
      };
      const result = validateCfql(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("QUERY_INVALID");
        expect(result.error.details.path).toContain("filter");
        expect(result.error.details.path).toContain("op");
      }
    });
  });

  it("accepts valid query with known operator", () => {
    const input = {
      dataset: "prod",
      types: ["post"],
      filter: { field: "title", op: "eq", value: "A" },
      limit: 10,
    };
    const result = validateCfql(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.filter).toEqual({ field: "title", op: "eq", value: "A" });
  });
});
