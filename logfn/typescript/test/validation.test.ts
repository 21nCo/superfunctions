import { describe, expect, it } from "vitest";
import {
  isValidLogEvent,
  MAX_EVENT_SIZE,
  MAX_TAGS,
  sanitizeValue,
  validateAndSerialize,
  type LogEvent,
} from "../src/index.js";

const event = (overrides: Partial<LogEvent> = {}): LogEvent => ({
  ts: "2026-01-14T12:00:00.000Z",
  level: "info",
  msg: "m",
  name: "test",
  version: "0",
  ...overrides,
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe("sanitizeValue", () => {
  it("replaces unserializable values and normalizes dates, errors and non-finite numbers", () => {
    const cause = new Error("inner");
    const error = new Error("outer", { cause });
    const result = sanitizeValue({
      fn: () => 1,
      sym: Symbol("s"),
      big: BigInt(1),
      date: new Date("2026-01-01T00:00:00.000Z"),
      nan: Number.NaN,
      gone: undefined,
      list: [undefined, 1],
      error,
    }) as Record<string, any>;
    expect(result).toMatchObject({
      fn: "[unserializable]",
      sym: "[unserializable]",
      big: "[unserializable]",
      date: "2026-01-01T00:00:00.000Z",
      nan: "NaN",
      list: [null, 1],
    });
    expect("gone" in result).toBe(false);
    expect(result.error).toMatchObject({ name: "Error", message: "outer", cause: { name: "Error", message: "inner" } });
  });

  it("replaces cycles but keeps shared references", () => {
    const shared = { v: 1 };
    const root: Record<string, unknown> = { a: shared, b: shared };
    root.self = root;
    expect(sanitizeValue(root)).toEqual({ a: { v: 1 }, b: { v: 1 }, self: "[circular]" });
  });
});

describe("validateAndSerialize", () => {
  it("caps tags and removes undefined fields", () => {
    const tags = Array.from({ length: MAX_TAGS + 5 }, (_, i) => `t${i}`);
    const { event: out, truncated } = validateAndSerialize(event({ tags, traceId: undefined }));
    expect(out.tags).toHaveLength(MAX_TAGS);
    expect("traceId" in out).toBe(false);
    expect(truncated).toBe(false);
  });

  it("bounds the UTF-8 size of oversized events", () => {
    const { event: out, truncated } = validateAndSerialize(event({ ctx: { blob: "é".repeat(MAX_EVENT_SIZE) } }));
    expect(truncated).toBe(true);
    expect(out.ctx).toMatchObject({ _truncated: true, _reason: "size_limit" });
    expect(bytes(out)).toBeLessThanOrEqual(MAX_EVENT_SIZE);

    const huge = validateAndSerialize(event({ msg: "€".repeat(MAX_EVENT_SIZE) }));
    expect(huge.truncated).toBe(true);
    expect(huge.event.msg.endsWith("...[truncated]")).toBe(true);
    expect(bytes(huge.event)).toBeLessThanOrEqual(MAX_EVENT_SIZE);
  });
});

describe("isValidLogEvent", () => {
  it("requires the v0 fields", () => {
    expect(isValidLogEvent(event())).toBe(true);
    expect(isValidLogEvent({ ...event(), msg: "" })).toBe(false);
    expect(isValidLogEvent("event")).toBe(false);
  });
});
