import { describe, expect, it } from "vitest";
import {
  isValidLogEvent,
  MAX_EVENT_SIZE,
  MAX_METADATA_CHARS,
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
  it("keeps an own __proto__ key as data without changing prototypes", () => {
    const json = '{"__proto__":{"marker":"keep"},"a":1,"nested":{"__proto__":2}}';
    const out = sanitizeValue(JSON.parse(json)) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out.nested)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe(json);
  });

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

  it("replaces binary data instead of expanding it byte by byte", () => {
    const bytes = new TextEncoder().encode("token=SECRET");
    expect(
      sanitizeValue({
        buffer: Buffer.from(bytes),
        u8: bytes,
        i16: new Int16Array(2),
        view: new DataView(bytes.buffer),
        array: bytes.buffer,
        shared: new SharedArrayBuffer(4),
      })
    ).toEqual({
      buffer: "[unserializable]",
      u8: "[unserializable]",
      i16: "[unserializable]",
      view: "[unserializable]",
      array: "[unserializable]",
      shared: "[unserializable]",
    });
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

  it.each([
    ["name", { name: "x".repeat(70_000) }],
    ["requestId", { requestId: "€".repeat(30_000) }],
    ["a field outside the schema", { extra: "x".repeat(70_000) } as Partial<LogEvent>],
    ["tags", { tags: Array.from({ length: MAX_TAGS }, () => "t".repeat(4_000)) }],
    ["control characters", { name: "\u0001".repeat(20_000), msg: "\u0002".repeat(20_000) }],
  ])("bounds an event whose %s alone is over the limit", (_field, overrides) => {
    const { event: out, truncated } = validateAndSerialize(event({ msg: "keep this message", ...overrides }));
    expect(truncated).toBe(true);
    expect(bytes(out)).toBeLessThanOrEqual(MAX_EVENT_SIZE);
    expect(out.ts).toBe("2026-01-14T12:00:00.000Z");
    expect(out.level).toBe("info");
  });

  it("keeps the message and small metadata when only the context is large", () => {
    const { event: out } = validateAndSerialize(
      event({ msg: "keep", requestId: "req-1", tags: ["a"], ctx: { blob: "x".repeat(MAX_EVENT_SIZE) } })
    );
    expect(out).toMatchObject({ msg: "keep", requestId: "req-1", tags: ["a"] });
  });

  it("caps metadata at MAX_METADATA_CHARS when it does not fit", () => {
    const { event: out } = validateAndSerialize(event({ name: "x".repeat(70_000), msg: "keep" }));
    expect(out.name).toHaveLength(MAX_METADATA_CHARS);
    expect(out.name.endsWith("...[truncated]")).toBe(true);
    expect(out.msg).toBe("keep");
  });

  it("makes every field JSON-safe", () => {
    const { event: out } = validateAndSerialize({
      ...event(),
      tags: [1, true, { a: 1 }, ["b"], null, new String("s")] as unknown as string[],
      userId: 10n as unknown as string,
    });
    // A tag that is not a string, number or boolean has no text form redaction could read.
    expect(out.tags).toEqual(["1", "true", "[unserializable]", "[unserializable]", "[unserializable]", "s"]);
    expect(out.userId).toBe("[unserializable]");
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});

describe("isValidLogEvent", () => {
  it("requires the v0 fields", () => {
    expect(isValidLogEvent(event())).toBe(true);
    // sanitizeEvent writes an empty msg for an event without one.
    expect(isValidLogEvent({ ...event(), msg: "" })).toBe(true);
    const ids = { traceId: "t", spanId: "s", requestId: "r", userId: "u", tenantId: "x" };
    expect(isValidLogEvent(event({ ctx: { a: 1 }, tags: ["t"], ...ids }))).toBe(true);
    expect(isValidLogEvent(event({ ctx: Object.assign(Object.create(null), { a: 1 }), tags: [] }))).toBe(true);
    expect(isValidLogEvent("event")).toBe(false);
  });

  it.each([
    ["an unknown level", { level: "verbose" }],
    ["an inherited level name", { level: "toString" }],
    ["a missing msg", { msg: undefined }],
    ["a non-string msg", { msg: 1 }],
    ["an empty name", { name: "" }],
    ["a numeric traceId", { traceId: 123 }],
    ["a numeric spanId", { spanId: 1 }],
    ["an object requestId", { requestId: {} }],
    ["a numeric userId", { userId: 7 }],
    ["a boolean tenantId", { tenantId: true }],
    ["an array ctx", { ctx: [] }],
    ["a null ctx", { ctx: null }],
    ["a string ctx", { ctx: "x" }],
    ["a non-string tag", { tags: ["a", 1] }],
    ["string tags", { tags: "a" }],
    // Containers that JSON writes as something other than their own keys
    ["a Date ctx", { ctx: new Date(0) }],
    ["a String wrapper ctx", { ctx: new String("x") }],
    ["a Number wrapper ctx", { ctx: new Number(1) }],
    ["a Buffer ctx", { ctx: Buffer.from("x") }],
    ["a Uint8Array ctx", { ctx: new Uint8Array([1]) }],
    ["an Error ctx", { ctx: new Error("x") }],
    ["empty tag slots", { tags: new Array(2) }],
    ["a sparse tag array", { tags: ["a", , "b"] }],
  ])("rejects %s", (_name, overrides) => {
    expect(isValidLogEvent({ ...event(), ...overrides })).toBe(false);
  });
});
