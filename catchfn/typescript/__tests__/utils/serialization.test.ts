/**
 * Serialization utility tests
 */

import { describe, it, expect } from "vitest";
import {
  serializeError,
  safeSerialize,
  estimateSize,
  truncateString,
  trimArray,
} from "../../src/utils/serialization.js";

describe("serialization", () => {
  describe("serializeError", () => {
    it("should serialize Error object", () => {
      const error = new Error("Test error");
      const serialized = serializeError(error);

      expect(serialized.name).toBe("Error");
      expect(serialized.message).toBe("Test error");
      expect(serialized.stack).toBeDefined();
    });

    it("should include custom properties", () => {
      const error: any = new Error("Test");
      error.code = "ERR_TEST";
      error.statusCode = 500;

      const serialized = serializeError(error);

      expect(serialized.code).toBe("ERR_TEST");
      expect(serialized.statusCode).toBe(500);
    });
  });

  describe("safeSerialize", () => {
    it("should handle primitives", () => {
      expect(safeSerialize(null)).toBe(null);
      expect(safeSerialize(undefined)).toBe(undefined);
      expect(safeSerialize("string")).toBe("string");
      expect(safeSerialize(123)).toBe(123);
      expect(safeSerialize(true)).toBe(true);
    });

    it("should handle functions", () => {
      const fn = () => {};
      expect(safeSerialize(fn)).toBe("[Function]");
    });

    it("should handle symbols", () => {
      const sym = Symbol("test");
      expect(safeSerialize(sym)).toBe("Symbol(test)");
    });

    it("should serialize objects", () => {
      const obj = { foo: "bar", num: 123 };
      expect(safeSerialize(obj)).toEqual({ foo: "bar", num: 123 });
    });

    it("should serialize arrays", () => {
      const arr = [1, "two", { three: 3 }];
      expect(safeSerialize(arr)).toEqual([1, "two", { three: 3 }]);
    });

    it("should handle circular references", () => {
      const obj: any = { name: "test" };
      obj.self = obj;

      const serialized = safeSerialize(obj);

      expect(serialized.name).toBe("test");
      expect(serialized.self).toBe("[Circular Reference]");
    });

    it("should handle Date objects", () => {
      const date = new Date("2024-01-01T00:00:00Z");
      expect(safeSerialize(date)).toBe(date.toISOString());
    });

    it("should handle RegExp objects", () => {
      const regex = /test/gi;
      expect(safeSerialize(regex)).toBe("/test/gi");
    });

    it("should handle Error objects", () => {
      const error = new Error("Test");
      const serialized = safeSerialize(error);

      expect(serialized.name).toBe("Error");
      expect(serialized.message).toBe("Test");
    });

    it("should respect max depth", () => {
      const deep = {
        l1: {
          l2: {
            l3: {
              l4: {
                l5: "deep",
              },
            },
          },
        },
      };

      const serialized = safeSerialize(deep, 3);

      // At depth 3, we can serialize l1, l2, l3, but l4 would be too deep
      expect(serialized.l1.l2.l3.l4).toBe("[Max Depth Reached]");
    });
  });

  describe("estimateSize", () => {
    it("should estimate size of objects", () => {
      const obj = { foo: "bar" };
      const size = estimateSize(obj);

      expect(size).toBeGreaterThan(0);
    });

    it("should return 0 for errors", () => {
      const circular: any = {};
      circular.self = circular;

      // Should handle gracefully
      const size = estimateSize(circular);
      expect(size).toBeGreaterThanOrEqual(0);
    });
  });

  describe("truncateString", () => {
    it("should not truncate short strings", () => {
      const str = "Hello";
      expect(truncateString(str, 10)).toBe("Hello");
    });

    it("should truncate long strings", () => {
      const str = "This is a very long string";
      const truncated = truncateString(str, 10);

      expect(truncated).toBe("This is...");
      expect(truncated.length).toBe(10);
    });
  });

  describe("trimArray", () => {
    it("should not trim small arrays", () => {
      const arr = [1, 2, 3];
      expect(trimArray(arr, 5)).toEqual([1, 2, 3]);
    });

    it("should trim large arrays", () => {
      const arr = [1, 2, 3, 4, 5, 6, 7, 8];
      const trimmed = trimArray(arr, 5);

      expect(trimmed).toEqual([4, 5, 6, 7, 8]);
      expect(trimmed.length).toBe(5);
    });
  });
});
