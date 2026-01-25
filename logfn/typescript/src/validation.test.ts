/**
 * Validation tests
 */

import { describe, it, expect } from "vitest";
import {
  sanitizeValue,
  validateAndSerialize,
  isValidLogEvent,
} from "./validation.js";
import type { LogEvent } from "./types.js";

describe("Validation", () => {
  describe("sanitizeValue", () => {
    it("should preserve null values", () => {
      expect(sanitizeValue(null)).toBe(null);
    });

    it("should preserve undefined values", () => {
      expect(sanitizeValue(undefined)).toBe(undefined);
    });

    it("should preserve primitives", () => {
      expect(sanitizeValue("string")).toBe("string");
      expect(sanitizeValue(123)).toBe(123);
      expect(sanitizeValue(true)).toBe(true);
    });

    it("should replace functions with placeholder", () => {
      expect(sanitizeValue(() => {})).toBe("[unserializable]");
    });

    it("should replace symbols with placeholder", () => {
      expect(sanitizeValue(Symbol("test"))).toBe("[unserializable]");
    });

    it("should replace BigInt with placeholder", () => {
      expect(sanitizeValue(BigInt(123))).toBe("[unserializable]");
    });

    it("should sanitize arrays", () => {
      const result = sanitizeValue([1, "test", () => {}, Symbol("s")]);
      expect(result).toEqual([
        1,
        "test",
        "[unserializable]",
        "[unserializable]",
      ]);
    });

    it("should sanitize nested objects", () => {
      const result = sanitizeValue({
        name: "test",
        fn: () => {},
        nested: {
          value: 123,
          sym: Symbol("test"),
        },
      });

      expect(result).toEqual({
        name: "test",
        fn: "[unserializable]",
        nested: {
          value: 123,
          sym: "[unserializable]",
        },
      });
    });

    it("should convert dates to ISO strings", () => {
      const date = new Date("2026-01-14T12:00:00.000Z");
      expect(sanitizeValue(date)).toBe("2026-01-14T12:00:00.000Z");
    });

    it("should convert errors to objects", () => {
      const error = new Error("test error");
      const result = sanitizeValue(error) as any;

      expect(result.name).toBe("Error");
      expect(result.message).toBe("test error");
      expect(result.stack).toBeDefined();
    });

    it("should drop undefined object properties", () => {
      const result = sanitizeValue({
        a: 1,
        b: undefined,
        c: "test",
      });

      expect(result).toEqual({ a: 1, c: "test" });
    });
  });

  describe("validateAndSerialize", () => {
    const createValidEvent = (): LogEvent => ({
      ts: new Date().toISOString(),
      level: "info",
      msg: "test",
      name: "test-logger",
      version: "0",
    });

    it("should validate and return valid events", () => {
      const event = createValidEvent();
      const { event: result, truncated } = validateAndSerialize(event);

      expect(result).toBeDefined();
      expect(truncated).toBe(false);
      expect(result.msg).toBe("test");
    });

    it("should remove undefined fields", () => {
      const event: LogEvent = {
        ...createValidEvent(),
        ctx: undefined,
        tags: undefined,
      };

      const { event: result } = validateAndSerialize(event);

      expect(result.ctx).toBeUndefined();
      expect(result.tags).toBeUndefined();
    });

    it("should preserve null fields", () => {
      const event: LogEvent = {
        ...createValidEvent(),
        ctx: { value: null },
      };

      const { event: result } = validateAndSerialize(event);

      expect(result.ctx).toEqual({ value: null });
    });

    it("should limit tags to 20 entries", () => {
      const event: LogEvent = {
        ...createValidEvent(),
        tags: Array.from({ length: 30 }, (_, i) => `tag${i}`),
      };

      const { event: result } = validateAndSerialize(event);

      expect(result.tags).toHaveLength(20);
    });

    it("should truncate events exceeding 64KB", () => {
      const largeContext: Record<string, unknown> = {};
      for (let i = 0; i < 10000; i++) {
        largeContext[`key${i}`] = "x".repeat(100);
      }

      const event: LogEvent = {
        ...createValidEvent(),
        ctx: largeContext,
      };

      const { event: result, truncated } = validateAndSerialize(event);

      expect(truncated).toBe(true);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(64 * 1024);
      expect((result.ctx as any)._truncated).toBe(true);
    });

    it("should sanitize context values", () => {
      const event: LogEvent = {
        ...createValidEvent(),
        ctx: {
          fn: () => {},
          valid: "test",
          sym: Symbol("test"),
        },
      };

      const { event: result } = validateAndSerialize(event);

      expect(result.ctx).toEqual({
        fn: "[unserializable]",
        valid: "test",
        sym: "[unserializable]",
      });
    });
  });

  describe("isValidLogEvent", () => {
    it("should validate complete events", () => {
      const event: LogEvent = {
        ts: new Date().toISOString(),
        level: "info",
        msg: "test",
        name: "test-logger",
        version: "0",
      };

      expect(isValidLogEvent(event)).toBe(true);
    });

    it("should reject non-objects", () => {
      expect(isValidLogEvent(null)).toBe(false);
      expect(isValidLogEvent("string")).toBe(false);
      expect(isValidLogEvent(123)).toBe(false);
    });

    it("should reject events missing required fields", () => {
      expect(isValidLogEvent({ level: "info", msg: "test" })).toBe(false);
      expect(isValidLogEvent({ ts: "2026-01-14", msg: "test" })).toBe(false);
      expect(isValidLogEvent({ ts: "2026-01-14", level: "info" })).toBe(false);
    });

    it("should accept events with optional fields", () => {
      const event: LogEvent = {
        ts: new Date().toISOString(),
        level: "info",
        msg: "test",
        name: "test-logger",
        version: "0",
        ctx: { user: "123" },
        tags: ["http"],
        traceId: "trace-123",
      };

      expect(isValidLogEvent(event)).toBe(true);
    });
  });
});
