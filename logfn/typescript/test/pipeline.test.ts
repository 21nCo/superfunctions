import { describe, expect, it, vi } from "vitest";
import {
  createLogger,
  enrichContext,
  isSensitiveKey,
  MAX_EVENT_SIZE,
  MAX_REDACTION_DEPTH,
  parseW3CTraceContext,
  redactEvent,
  redactSecFn,
  REDACTED,
  sanitizeEvent,
  sanitizeValue,
  serverLogger,
  sinkHttp,
  sample,
  withRequestIds,
  type HttpSinkFetch,
  type HttpSinkRequest,
  type LogEvent,
  type RedactionOptions,
  type Sink,
} from "../src/index.js";
import { MAX_SIZE } from "../src/pipeline/redact.js";
import { MAX_TRAVERSAL } from "../src/validation.js";

function capture() {
  const events: LogEvent[] = [];
  const sink: Sink = (batch) => void events.push(...batch);
  return { events, sink };
}

function fetchSpy() {
  const requests: HttpSinkRequest[] = [];
  const fetch: HttpSinkFetch = async (_url, init) => {
    requests.push(init);
    return { ok: true, status: 200 };
  };
  return { fetch, requests };
}

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

  it("redacts dates as the text sanitization writes, so its output is final", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    date.toISOString = () => "token=DATE_SECRET";
    const invalid = new Date(Number.NaN);
    invalid.toString = () => "password=INVALID_SECRET";
    const plain = new Date("2026-01-01T00:00:00.000Z");
    const expected = { date: "token=[redacted]", invalid: "password=[redacted]", plain: "2026-01-01T00:00:00.000Z" };
    expect(redactEvent(event({ ctx: { date, invalid, plain } })).ctx).toEqual(expected);
    expect((redactSecFn()(event({ ctx: { date, invalid, plain } })) as LogEvent).ctx).toEqual(expected);
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
      "x" + "\\n".repeat(100_000),
      "a" + " \n".repeat(100_000),
      "n:" + "\\n".repeat(100_000),
      "https://" + "a@".repeat(100_000),
      ("a://" + "b:".repeat(10) + " ").repeat(10_000),
      'password="x"' + "a".repeat(200_000),
      // Quoted values that span lines, terminated late or never.
      'password="a\n'.repeat(50_000),
      "token='a\r\n".repeat(40_000),
      'token=\\"a\n'.repeat(40_000),
      'token="' + "a\n".repeat(100_000),
      "token={" + '"a\n'.repeat(60_000),
      '{"api key": "' + "a\n".repeat(100_000),
      Array.from({ length: 600 }, (_, n) => "token=" + "\\".repeat(n) + '"a\n').join(""),
      // Quoted names with spaces followed by `=` and no value, or a late one.
      '"api key" ='.repeat(20_000),
      "'private key'=".repeat(20_000),
      '"a b c"= "'.repeat(20_000),
      '"api key" = "' + "a\n".repeat(100_000),
    ];
    const started = Date.now();
    for (const msg of inputs) redactEvent(event({ msg }));
    // Linear on these ~200 KB inputs takes well under a second; quadratic would take hours.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("keeps both values when an allowlisted top-level name collides with a redacted one", () => {
    const input = { ...event(), "a@example.com": 1, "[redacted]": 2 } as LogEvent;
    expect(redactEvent(input, { allowlist: ["[redacted]"] })).toMatchObject({ "[redacted]": 1, "[redacted]#2": 2 });
    const reversed = { ...event(), "[redacted]": 2, "a@example.com": 1 } as LogEvent;
    expect(redactEvent(reversed, { allowlist: ["[redacted]"] })).toMatchObject({ "[redacted]": 2, "[redacted]#2": 1 });
  });

  describe("error fields obey the sensitive-key rules and the allowlist, like record keys", () => {
    const failure = () => {
      const cause = new Error("cause PRIVATE_CAUSE");
      return new Error("message PRIVATE_MESSAGE", { cause });
    };
    const keys = ["message", "stack"];
    const outputs = (options: RedactionOptions) => {
      const captured = capture();
      createLogger({ name: "k", pipeline: [redactSecFn(options)], sinks: [captured.sink] }).error("m", { err: failure() });
      return [redactEvent(event({ ctx: { err: failure() } }), options).ctx, captured.events[0].ctx];
    };

    it("redactEvent and a logger's redactSecFn stage redact message and stack, also of a nested cause", () => {
      for (const ctx of outputs({ keys })) {
        expect(ctx).toEqual({
          err: { name: "Error", message: REDACTED, stack: REDACTED, cause: { name: "Error", message: REDACTED, stack: REDACTED } },
        });
        expect(JSON.stringify(ctx)).not.toContain("PRIVATE");
      }
    });

    it("an allowlisted error field path is kept, as for a record", () => {
      for (const ctx of outputs({ keys, allowlist: ["err.message", "err.cause.stack"] })) {
        const err = (ctx as { err: { message: string; stack: string; cause: { message: string; stack: string } } }).err;
        expect(err.message).toBe("message PRIVATE_MESSAGE");
        expect(err.cause.stack).toContain("PRIVATE_CAUSE");
        expect([err.stack, err.cause.message]).toEqual([REDACTED, REDACTED]);
      }
    });
  });
});

describe("traversal budget", () => {
  // n = {a: n1, b: n1}: depth objects, 2^depth paths.
  const shared = (depth: number) => {
    let node: Record<string, unknown> = { leaf: "token=DAG_SECRET" };
    for (let level = 0; level < depth; level++) node = { a: node, b: node };
    return node;
  };
  const timed = async (run: () => unknown) => {
    const started = Date.now();
    const output = JSON.stringify(await run());
    return { elapsed: Date.now() - started, size: output.length, output };
  };

  it.each([20, 30])("a shared graph of depth %i is walked once per budget through every path", async (depth) => {
    const node = shared(depth);
    const captured = capture();
    const logger = createLogger({ name: "dag", pipeline: [redactSecFn()], sinks: [captured.sink] });
    const spy = fetchSpy();
    const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const runs = [
      () => sanitizeValue({ node }),
      () => sanitizeEvent(event({ ctx: { node } })),
      () => redactEvent(event({ ctx: { node } })),
      () => (logger.info("m", { node }), captured.events[0]),
      () => (serverLogger({ name: "dag" }).info("m", { node }), lines[0]),
      async () => (sink([event({ ctx: { node } })]), await sink.flush(), spy.requests[0].body),
    ];
    try {
      for (const [index, run] of runs.entries()) {
        const { elapsed, size, output } = await timed(run);
        expect(elapsed).toBeLessThan(5000);
        expect(size).toBeLessThan(2 * MAX_TRAVERSAL);
        // Sanitization alone does not redact; every other path does.
        if (index > 1) expect(output.includes("DAG_SECRET")).toBe(false);
      }
      // The sinks still bound what they write by MAX_EVENT_SIZE.
      for (const text of [lines[0], spy.requests[0].body]) expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_EVENT_SIZE + 20);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("wide arrays, sparse arrays, wide objects and long strings stop at the budget", () => {
    const wide = Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [`k${index}`, index]));
    for (const value of [Array.from({ length: 300_000 }, (_, index) => index), new Array(2 ** 32 - 1), wide, ["x".repeat(MAX_TRAVERSAL)]]) {
      const started = Date.now();
      const ctx = redactEvent(event({ ctx: { value } })).ctx as { value: unknown[] | Record<string, unknown> };
      const output = JSON.stringify(ctx);
      expect(Date.now() - started).toBeLessThan(5000);
      // A value costs 1 and writes at most a number's text.
      expect(output.length).toBeLessThan(8 * MAX_TRAVERSAL);
      // An array ends with MAX_SIZE; an object ends at the first key past the budget.
      if (Array.isArray(ctx.value)) expect(ctx.value.at(-1)).toBe(MAX_SIZE);
      else expect(Object.keys(ctx.value).length).toBeLessThan(MAX_TRAVERSAL / 4);
    }
  });

  it("values past the budget are never written, redacted or not, and values within it are unchanged", () => {
    // ts, level, name, version, ctx and the key "fill" cost 42; fill costs its length plus 1, "late" 4.
    const fill = "f".repeat(MAX_TRAVERSAL - 50);
    const ctx = redactEvent(event({ ctx: { fill, late: "token=LATE_SECRET", nested: { password: "LATE_PASSWORD" } } })).ctx;
    expect(ctx).toEqual({ fill, late: MAX_SIZE });
    expect(JSON.stringify(ctx)).not.toMatch(/LATE_/);
    const within = { list: [1, "token=x", { password: "p" }], text: "y".repeat(MAX_EVENT_SIZE) };
    expect(redactEvent(event({ ctx: within })).ctx).toEqual({ list: [1, "token=[redacted]", { password: REDACTED }], text: within.text });
  });

  it("each walk has its own budget, also one started by a getter inside another, and the outer one resumes", () => {
    const half = "o".repeat(MAX_TRAVERSAL / 2);
    const inner = { get length() {
      return (sanitizeValue("i".repeat(MAX_TRAVERSAL - 100)) as string).length;
    } };
    const output = sanitizeValue({ half, inner, after: "a".repeat(MAX_TRAVERSAL / 4) });
    expect(output).toEqual({ half, inner: { length: MAX_TRAVERSAL - 100 }, after: "a".repeat(MAX_TRAVERSAL / 4) });
    expect(sanitizeValue("s".repeat(MAX_TRAVERSAL - 1))).toHaveLength(MAX_TRAVERSAL - 1);
    expect(sanitizeValue("s".repeat(MAX_TRAVERSAL))).toBe(MAX_SIZE);
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

  it("has no header option: ids come from generate or the event, never a header", () => {
    // @ts-expect-error header was documented but never read, so it is not an option
    expect(withRequestIds({ header: "traceparent" })(event({ requestId: "r1" }))).toEqual(event({ requestId: "r1" }));
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
