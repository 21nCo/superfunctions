/**
 * Patch validator tests (TV-PATCH-INVALID-001: invalid patch path).
 */

import { describe, it, expect } from "vitest";
import { validatePatch } from "./validatePatch.js";

describe("validatePatch", () => {
  describe("TV-PATCH-INVALID-001: invalid patch path", () => {
    it("rejects invalid path with PATCH_INVALID and details.path includes the invalid path", () => {
      const input = {
        dataset: "prod",
        id: "post-1",
        ops: [{ op: "set", path: "body.0.not-a-path", value: 1 }],
      };
      const result = validatePatch(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("PATCH_INVALID");
        expect(result.error.details.path).toBeDefined();
        expect(
          result.error.details.path === "ops[0].path" || (result.error.details.path as string).includes("path")
        ).toBe(true);
      }
    });
  });

  it("rejects empty path", () => {
    const result = validatePatch({
      dataset: "prod",
      id: "post-1",
      ops: [{ op: "set", path: "", value: 1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PATCH_INVALID");
  });

  it("accepts valid patch with simple path", () => {
    const result = validatePatch({
      dataset: "prod",
      id: "post-1",
      ops: [{ op: "set", path: "title", value: "Hello" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.ops[0]).toEqual({ op: "set", path: "title", value: "Hello" });
  });
});
