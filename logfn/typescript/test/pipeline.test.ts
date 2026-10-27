import { describe, expect, it } from "vitest";
import {
  enrichContext,
  isSensitiveKey,
  MAX_REDACTION_DEPTH,
  parseW3CTraceContext,
  redactEvent,
  redactSecFn,
  sinkHttp,
  sample,
  withRequestIds,
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

describe("redaction", () => {
  it.each([
    ["password", true],
    ["DB_PASSWORD", true],
    ["x-api-key", true],
    ["refreshToken", true],
    ["Set-Cookie", true],
    ["sid", true],
    ["maxTokens", false],
    ["token_count", false],
    ["author", false],
    ["keyboard", false],
  ])("isSensitiveKey(%s) is %s", (key, expected) => {
    expect(isSensitiveKey(key)).toBe(expected);
  });

  it("treats extra keys as sensitive after normalization", () => {
    expect(isSensitiveKey("card-number", ["cardNumber"])).toBe(true);
  });

  it("replaces only the default extra patterns when custom patterns are given", () => {
    const stage = redactSecFn({ patterns: [/secret-\d+/] });
    const result = stage(event({ msg: "ada@example.com secret-123 token=abc" })) as LogEvent;
    expect(result.msg).toBe("ada@example.com [redacted] token=[redacted]");
  });

  it("supports a custom replacement", () => {
    expect(redactEvent(event({ ctx: { apiKey: "k" } }), { replacement: "***" }).ctx).toEqual({ apiKey: "***" });
  });

  it("does not modify the input event", () => {
    const input = event({ msg: "token=abc", ctx: { nested: { password: "pw" } }, tags: ["token=x"] });
    const snapshot = structuredClone(input);
    redactEvent(input);
    expect(input).toEqual(snapshot);
  });

  it("handles error cause cycles and deep nesting", () => {
    const first = new Error("first token=a");
    const second = new Error("second", { cause: first });
    (first as Error & { cause?: unknown }).cause = second;
    const ctx = redactEvent(event({ ctx: { error: first } })).ctx as Record<string, any>;
    expect(ctx.error.message).toBe("first token=[redacted]");
    expect(ctx.error.cause.cause).toBe("[circular]");

    let deep: Record<string, unknown> = { leaf: "password=x" };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 5; i++) deep = { next: deep };
    const out = JSON.stringify(redactEvent(event({ ctx: deep })).ctx);
    expect(out).toContain("[max-depth]");
    expect(out).not.toContain("password=x");
  });

  it("rejects an empty replacement, which would make redacted text ambiguous", () => {
    expect(() => redactSecFn({ replacement: "" })).toThrow("non-empty");
    expect(() => redactEvent(event({ msg: "password=x" }), { replacement: "" })).toThrow("non-empty");
    expect(() => sinkHttp({ url: "https://collector.test/ingest", redact: { replacement: "" } })).toThrow("non-empty");
  });

  it("runs in linear time on adversarial input", () => {
    const inputs = [
      "a".repeat(200_000),
      "a.".repeat(100_000),
      "a=".repeat(100_000),
      "https://".repeat(25_000),
      "x@".repeat(100_000),
      "bearer ".repeat(30_000),
      "\\".repeat(200_000),
      "\\".repeat(200_000) + '"',
      'password="' + '\\"'.repeat(100_000),
      "?token=" + "\\".repeat(200_000) + "'",
      "&token=".repeat(30_000),
      '\\"token\\":'.repeat(20_000),
      "password=" + "[".repeat(200_000),
      "token=[" + '\\"'.repeat(100_000),
      "secret={" + '"a\\'.repeat(60_000),
      "token=[redacted]".repeat(15_000),
      "%3Fa".repeat(50_000),
      "%3Fapi_key%3D" + "%2F".repeat(60_000),
      '"a '.repeat(60_000),
      '"' + "a ".repeat(100_000),
      "\\".repeat(100_000) + '"a b',
    ];
    const started = Date.now();
    for (const msg of inputs) redactEvent(event({ msg }));
    // Linear on these ~200 KB inputs takes well under a second; quadratic would take hours.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("enrichContext", () => {
  it("adds static and dynamic fields with event context taking precedence", () => {
    let n = 0;
    const stage = enrichContext({ app: "a", env: "dev" }, () => ({ seq: ++n, env: "dynamic" }));
    expect(stage(event({ ctx: { app: "override" } }))).toMatchObject({ ctx: { app: "override", env: "dynamic", seq: 1 } });
    expect(stage(event())).toMatchObject({ ctx: { app: "a", env: "dynamic", seq: 2 } });
  });
});

describe("sample", () => {
  it("keeps or drops by level rate using the supplied random source", () => {
    const values = [0.05, 0.5, 0.05];
    const stage = sample({ info: 0.1 }, { random: () => values.shift() ?? 0 });
    expect(stage(event())).not.toBeNull();
    expect(stage(event())).toBeNull();
    expect(stage(event({ level: "error" }))).not.toBeNull();
    expect(stage(event({ level: "trace" }))).toBeNull();
  });

  it("keeps about the configured fraction", () => {
    const stage = sample({ info: 0.25 });
    let kept = 0;
    for (let i = 0; i < 20_000; i++) if (stage(event())) kept++;
    expect(kept / 20_000).toBeGreaterThan(0.22);
    expect(kept / 20_000).toBeLessThan(0.28);
  });

  it("treats a non-numeric rate as zero", () => {
    expect(sample({ info: Number.NaN })(event())).toBeNull();
  });
});

describe("request ids", () => {
  it("generates W3C-sized hex ids without overriding existing ones", () => {
    const generated = withRequestIds()(event()) as LogEvent;
    expect(generated.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(generated.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(generated.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(withRequestIds()(event({ requestId: "r1" }))).toEqual(event({ requestId: "r1" }));
  });

  it("parses valid traceparent headers only", () => {
    expect(parseW3CTraceContext("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
    });
    expect(parseW3CTraceContext("00-00000000000000000000000000000000-b7ad6b7169203331-01")).toBeNull();
    expect(parseW3CTraceContext("00-0AF7651916CD43DD8448EB211C80319Z-b7ad6b7169203331-01")).toBeNull();
    expect(parseW3CTraceContext("01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")).toBeNull();
    for (const flags of ["", "1", "001", "zz", "0A"]) {
      expect(parseW3CTraceContext(`00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-${flags}`)).toBeNull();
    }
  });
});
