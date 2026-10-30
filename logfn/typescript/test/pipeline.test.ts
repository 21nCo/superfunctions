import { describe, expect, it, vi } from "vitest";
import {
  createLogger,
  enrichContext,
  isSensitiveKey,
  isValidLogEvent,
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
import { MAX_TRAVERSAL, mergeContext } from "../src/validation.js";

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

  it("an allowlisted msg exempts the top-level message like any other field name", async () => {
    const input = event({ msg: "mail ada@example.com", ctx: { msg: "mail ada@example.com" } });
    const captured = capture();
    for (const [allowlist, msg] of [[["msg"], "mail ada@example.com"], [["userId"], "mail [redacted]"]] as const) {
      const options = { allowlist: [...allowlist] };
      const outputs = [redactEvent(input, options), redactSecFn(options)(input) as LogEvent];
      createLogger({ name: "test", pipeline: [redactSecFn(options)], sinks: [captured.sink] }).info(input.msg, input.ctx);
      for (const output of [...outputs, captured.events.at(-1)!]) expect([output.msg, output.ctx?.msg]).toEqual([msg, msg]);
    }
    expect(redactEvent(input).msg).toBe("mail [redacted]");
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

  it("redacts dates as the built-in text sanitization writes, so an override cannot add text", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    date.toISOString = () => "token=DATE_SECRET";
    const invalid = new Date(Number.NaN);
    invalid.toString = () => "password=INVALID_SECRET";
    const plain = new Date("2026-01-01T00:00:00.000Z");
    const expected = { date: "2026-01-01T00:00:00.000Z", invalid: "Invalid Date", plain: "2026-01-01T00:00:00.000Z" };
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
      // Keys glued into a value, which is read again for them.
      "password=" + "token=".repeat(30_000) + "\\x",
      'password="v"' + "xtoken=".repeat(30_000) + " a",
      'secret="v"' + 'xtoken="a"'.repeat(20_000),
      "secret=[a]" + "xtoken=[".repeat(25_000),
      '"v"' + "-Bearer".repeat(30_000),
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

  it("schema fields keep their name and value in any key order; an extra field that redacts to a schema name is kept beside it", () => {
    const schema = event({ ctx: { a: 1 }, tags: ["t"] });
    const extra = { "ada@example.com": "extra" };
    for (const replacement of ["level", "msg", "ctx", "tags", "version", "name"]) {
      const options = { replacement };
      const kept = { [`${replacement}#2`]: "extra" };
      for (const input of [{ ...extra, ...schema }, { ...schema, ...extra }] as LogEvent[]) {
        for (const output of [redactEvent(input, options), redactSecFn(options)(input) as LogEvent]) {
          expect(output).toEqual({ ...schema, ...kept });
          expect(isValidLogEvent(output)).toBe(true);
          expect(redactEvent(output, options)).toEqual(output);
        }
      }
      const captured = capture();
      const addExtra = (input: LogEvent) => ({ ...extra, ...input }) as LogEvent;
      createLogger({ name: "test", pipeline: [addExtra, redactSecFn(options)], sinks: [captured.sink] }).info("m", { a: 1 });
      expect(captured.events[0]).toMatchObject({ level: "info", msg: "m", name: "test", ctx: { a: 1 }, ...kept });
      expect(isValidLogEvent(captured.events[0])).toBe(true);
    }
    // A pattern that matches a schema name redacts its value only.
    expect(redactEvent(schema, { patterns: [/name|level|test/] })).toEqual({ ...schema, name: REDACTED });
  });

  it("a marker written by one rule is never read by a later one, so a credential URL keeps its host for any replacement", () => {
    const text = "see https://user:pw@host.example/path or ada@example.com";
    for (const replacement of ["MASK", "x", REDACTED]) {
      const options = { replacement };
      const expected = `see https://${replacement}@host.example/path or ${replacement}`;
      const input = event({ msg: text, ctx: { url: text, [text]: 1 } });
      const captured = capture();
      createLogger({ name: "test", pipeline: [redactSecFn(options)], sinks: [captured.sink] }).info(text, input.ctx);
      for (const output of [redactEvent(input, options), redactSecFn(options)(input) as LogEvent, captured.events[0]]) {
        expect([output.msg, output.ctx]).toEqual([expected, { url: expected, [expected]: 1 }]);
        expect(redactEvent(output, options)).toEqual(output);
      }
    }
  });

  it.each([
    ["password=https://u:p@h/x next", "password=MASK next"],
    ["Cookie: s=1; next=https://u:p@h/x; other=secret\nkeep", "Cookie: MASK\nkeep"],
    ["?token=a&next=https://u:p@h.example/x ada@example.com", "?token=MASK&next=https://MASK@h.example/x MASK"],
    ["Bearer abc%ada@example.com tail", "Bearer MASK tail"],
    ["tok_1tok_2 tok_3", "MASK MASK"],
  ])("a sensitive value still runs past a marker, and touching markers join, so redacting twice is stable: %j", (msg, expected) => {
    const options = { replacement: "MASK", patterns: [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /tok_\d/] };
    const output = redactEvent(event({ msg }), options);
    expect(output.msg).toBe(expected);
    expect(redactEvent(output, options).msg).toBe(expected);
  });

  it("empty matches of u and v patterns step over whole surrogate pairs, so every redaction path ends", async () => {
    // Throws instead of looping forever when a rule stops making progress.
    class Bounded extends RegExp {
      calls = 0;
      exec(text: string) {
        if (++this.calls > 1_000) throw new Error("no progress");
        return super.exec(text);
      }
    }
    const hasV = (() => {
      try {
        return new RegExp("", "v").flags === "v";
      } catch {
        return false;
      }
    })();
    const loneSurrogates = (text: string) => text.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g)?.length ?? 0;
    for (const source of ["(?:)", "(?=.)", "a*"]) {
      for (const flags of ["gu", ...(hasV ? ["gv"] : []), "g"]) {
        for (const msg of ["\u{1F600}", "a \u{1F600} b", "\uD83D", "\uDE00x"]) {
          // One marker per match, as String.prototype.replace writes them (per code point in u/v mode, per
          // UTF-16 unit otherwise, as before), with touching markers joined.
          const expected = msg.replace(new RegExp(source, flags), "X").replace(/X+/g, "X");
          const options = () => ({ replacement: "X", patterns: [new Bounded(source, flags)] });
          const spy = fetchSpy();
          const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch, redact: options() });
          const captured = capture();
          const logger = createLogger({ name: "test", pipeline: [redactSecFn(options())], sinks: [captured.sink] });
          logger.info(msg);
          createLogger({ name: "test", sinks: [sink] }).info(msg);
          await sink.flush();
          const sent = (JSON.parse(spy.requests[0].body) as { events: LogEvent[] }).events[0];
          const outputs = [redactEvent(event({ msg }), options()), redactSecFn(options())(event({ msg })) as LogEvent, captured.events[0], sent];
          for (const output of outputs) {
            expect([source, flags, output.msg]).toEqual([source, flags, expected]);
            if (flags !== "g") expect(loneSurrogates(output.msg)).toBe(loneSurrogates(msg));
          }
        }
      }
    }
  });

  it.each([
    ['password="v"https://user:pw@host.example/path', 'password="R"'],
    ['"secret":"v"https://user:pw@host.example/path', '"secret":"R"'],
    ['token: "a"https://u:p@h.io/x', 'token: "R"'],
  ])("a value glued to a marker is redacted to the same text again: %j", (msg, template) => {
    for (const replacement of [REDACTED, "MASK", "x"]) {
      const options = { replacement };
      const expected = template.replace(/R/g, replacement);
      for (const redact of [(input: LogEvent) => redactEvent(input, options), (input: LogEvent) => redactSecFn(options)(input) as LogEvent]) {
        const once = redact(event({ msg }));
        expect(once.msg).toBe(expected);
        expect(redact(once)).toEqual(once);
      }
    }
  });

  it("redacting twice changes nothing, for seeded concatenations of rule inputs with and without separators", () => {
    // mulberry32, so every run checks the same inputs.
    let seed = 0x5eed;
    const random = (n: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) % n;
    };
    const parts = [
      "https://user:pw@host.example/path", "ftp://bob:x@h.io", "ada@example.com", "user@", "password=hunter2", 'password="v"',
      '"secret":"v"', "token: 'a'", "Bearer abcDEF123", "?token=s3cr3t&x=1", "%3Ftoken%3Dabc", "Authorization: Basic Zm9v",
      "Cookie: sid=1; b=2", "\n", REDACTED, "MASK", "x", "a", "@", ":", "=", "/", ",", "{", "}", "tok_1",
    ];
    for (const separator of ["", " "]) {
      for (const replacement of [REDACTED, "MASK", "x", "***"]) {
        const options = { replacement, patterns: [/tok_\d/g, /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z0-9])/g] };
        for (let run = 0; run < 1_000; run++) {
          const msg = Array.from({ length: 1 + random(6) }, () => parts[random(parts.length)]).join(separator);
          for (const redact of [(input: LogEvent) => redactEvent(input, options), (input: LogEvent) => redactSecFn(options)(input) as LogEvent]) {
            const once = redact(event({ msg, ctx: { [msg]: msg } }));
            expect([msg, redact(once)]).toEqual([msg, once]);
          }
        }
      }
    }
  });

  it("a value is replaced when the key it is written under is sensitive, so redacting again keeps it", () => {
    const options = { replacement: "***" };
    // `%3Ftoken%3Dabc` is not a sensitive name, but its redacted text `%3Ftoken%3D***` reads as `token`.
    const input = { ...event({ ctx: { "%3Ftoken%3Dabc": "v" } }), "%3Ftoken%3Dabc": "v" } as LogEvent;
    for (const output of [redactEvent(input, options), redactSecFn(options)(input) as LogEvent]) {
      expect(output).toMatchObject({ ctx: { "%3Ftoken%3D***": "***" }, "%3Ftoken%3D***": "***" });
      expect(redactEvent(output, options)).toEqual(output);
    }
  });

  it("a replacement the rules would redact is never redacted over and over", () => {
    const options = { replacement: "<a a>", patterns: [/a/g] };
    expect(redactEvent(event({ msg: "a b" }), options).msg).toBe("<a a> b");
  });

  // Every way an event is redacted: direct, as a stage, through a logger stage and by sinkHttp before delivery.
  async function redactEverywhere(msg: string, options: RedactionOptions): Promise<string[]> {
    const spy = fetchSpy();
    const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch, redact: options });
    const captured = capture();
    createLogger({ name: "test", pipeline: [redactSecFn(options)], sinks: [captured.sink] }).info(msg);
    createLogger({ name: "test", sinks: [sink] }).info(msg);
    await sink.flush();
    const sent = (JSON.parse(spy.requests[0].body) as { events: LogEvent[] }).events[0];
    return [redactEvent(event({ msg }), options).msg, (redactSecFn(options)(event({ msg })) as LogEvent).msg, captured.events[0].msg, sent.msg];
  }

  it("a replacement that reads as a credential name is rejected, so a marker never turns caller words into a value", async () => {
    for (const replacement of ["SECRET", "TOKEN", "password", "Authorization", "api-key", "[auth]"]) {
      expect(() => redactEvent(event(), { replacement })).toThrow("sensitive key name");
      expect(() => redactSecFn({ replacement })).toThrow("sensitive key name");
      expect(() => sinkHttp({ url: "https://collector.test/ingest", redact: { replacement } })).toThrow("sensitive key name");
    }
    expect(() => redactSecFn({ replacement: "MASK", keys: ["mask"] })).toThrow("sensitive key name");
    for (const replacement of ["MASK", "x", "***", REDACTED]) {
      const options = { replacement };
      for (const output of await redactEverywhere("alice@example.com: upload completed", options)) {
        expect(output).toBe(`${replacement}: upload completed`);
        expect(redactEvent(event({ msg: output }), options).msg).toBe(output);
      }
    }
  });

  it.each([
    ["abbbbb", { replacement: "a", patterns: [/ab/g] }, "a"],
    [`a${"b".repeat(50)}`, { replacement: "a", patterns: [/ab/g] }, "a"],
    ["xa", { replacement: "xx", patterns: [/x(?=a)/g] }, "xx"],
  ])("text the rules keep changing fails closed to the replacement, so redacting again changes nothing: %j", async (msg, options, expected) => {
    for (const output of await redactEverywhere(msg, options)) {
      expect(output).toBe(expected);
      expect(await redactEverywhere(output, options)).toEqual([expected, expected, expected, expected]);
    }
  });

  it("a credential glued to a quoted or bracketed value is redacted as it is after a separator", async () => {
    const credentials = ["Authorization: Basic Zm9v", "Authorization:Basic Zm9v", "Authorization: Bearer abc123", "token=abc123", "token =abc123", 'token="Zm9v abc123"', "Bearer abc123"];
    for (const value of ['"v"', "'v'", String.raw`\"v\"`, "[a]", "{a: 1}"]) {
      for (const separator of ["", "x", " "]) {
        for (const credential of credentials.filter((text) => separator !== "x" || !text.startsWith("Bearer"))) {
          const msg = `"secret": ${value}${separator}${credential} tail`;
          for (const output of await redactEverywhere(msg, {})) {
            expect([msg, output]).toEqual([msg, expect.not.stringMatching(/Zm9v|abc123/)]);
            expect([msg, redactEvent(event({ msg: output }), {}).msg]).toEqual([msg, output]);
          }
        }
      }
    }
    expect(redactEvent(event({ msg: '"secret":"v"xAuthorization: Basic Zm9v' })).msg).toBe('"secret":"[redacted]"');
    expect(redactEvent(event({ msg: "password=vxtoken: abc123 tail" })).msg).toBe("password=[redacted] tail");
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
    // ctx has its own budget: ctx costs 1, the key "fill" 4, fill its length plus 1, "late" 4, its value 18.
    const fill = "f".repeat(MAX_TRAVERSAL - 20);
    const ctx = redactEvent(event({ ctx: { fill, late: "token=LATE_SECRET", nested: { password: "LATE_PASSWORD" } } })).ctx;
    expect(ctx).toEqual({ fill, late: MAX_SIZE });
    expect(JSON.stringify(ctx)).not.toMatch(/LATE_/);
    const within = { list: [1, "token=x", { password: "p" }], text: "y".repeat(MAX_EVENT_SIZE) };
    expect(redactEvent(event({ ctx: within })).ctx).toEqual({ list: [1, "token=[redacted]", { password: REDACTED }], text: within.text });
  });

  // A whole budget in the first value, then 1000 counted getters: own fields of a record, or items of a list.
  const exhausting = () => {
    let reads = 0;
    const getter = { enumerable: true, get: () => (reads++, "token=GETTER_SECRET") };
    const object: Record<string, unknown> = { big: "x".repeat(MAX_TRAVERSAL) };
    const items: unknown[] = ["x".repeat(MAX_TRAVERSAL)];
    for (let index = 0; index < 1000; index++) {
      Object.defineProperty(object, `k${index}`, getter);
      Object.defineProperty(items, index + 1, getter);
    }
    return { cases: [object, { items }], reads: () => reads };
  };

  it("no value past the budget is read, through every path that walks caller values", async () => {
    const spy = fetchSpy();
    const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
    const captured = capture();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const runs: Array<(ctx: Record<string, unknown>) => unknown> = [
      (ctx) => sanitizeValue(ctx),
      (ctx) => sanitizeEvent(event({ ctx, extra: ctx } as Partial<LogEvent>)),
      (ctx) => redactEvent(event({ ctx })),
      (ctx) => createLogger({ name: "w", pipeline: [redactSecFn()], sinks: [captured.sink] }).info("m", ctx),
      (ctx) => createLogger({ name: "w", baseContext: { big: "x".repeat(MAX_TRAVERSAL) }, sinks: [captured.sink] }).info("m", ctx),
      (ctx) => serverLogger({ name: "w" }).info("m", ctx),
      async (ctx) => (sink([event({ ctx })]), await sink.flush()),
    ];
    try {
      for (const run of runs) {
        for (const index of [0, 1]) {
          const { cases, reads } = exhausting();
          await run(cases[index]);
          expect(reads()).toBe(0);
        }
      }
      expect([...lines, ...spy.requests.map((request) => request.body)].join()).not.toMatch(/GETTER_SECRET/);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("listing keys is linear in width; value reads, output and per-key work stay bounded by the budget", async () => {
    const ids = { level: "warn", traceId: "t-w", requestId: "r-w" } as const;
    const outputs = new Map<number, string[]>();
    const keyWork = new Map<number, number>();
    // Yields between the long synchronous steps, so the test runner's own calls are answered.
    const tick = () => new Promise((resolve) => setTimeout(resolve));
    for (const width of [1e4, 1e5, 1e6]) {
      // width enumerable getters, then the schema fields last in key order.
      let reads = 0;
      const wide: Record<string, unknown> = {};
      const getter = { enumerable: true, get: () => (reads++, "v") };
      for (let index = 0; index < width; index++) Object.defineProperty(wide, `k${index}`, getter);
      Object.assign(wide, event(), ids);
      await tick();
      const spy = fetchSpy();
      const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
      const captured = capture();
      const logger = createLogger({ name: "w", now: () => new Date(0), pipeline: [redactSecFn()], sinks: [captured.sink] });
      const runs: Array<() => unknown> = [
        () => sanitizeValue(wide),
        () => {
          // Past the shared budget sanitizeEvent looks up only the schema fields, whatever the width.
          const has = vi.spyOn(Set.prototype, "has");
          try {
            const output = sanitizeEvent(wide as unknown as LogEvent);
            keyWork.set(width, has.mock.calls.length);
            expect(output).toMatchObject(ids);
            expect(isValidLogEvent(output)).toBe(true);
            return output;
          } finally {
            has.mockRestore();
          }
        },
        () => redactEvent(event({ ctx: wide })),
        () => (logger.info("m", wide), captured.events[0]),
        async () => (sink([event({ ctx: wide })]), await sink.flush(), spy.requests[0].body),
      ];
      const texts: string[] = [];
      for (const run of runs) {
        reads = 0;
        texts.push(JSON.stringify(await run()));
        expect(reads).toBeLessThanOrEqual(Math.min(width, MAX_TRAVERSAL / 4));
        await tick();
      }
      outputs.set(width, texts);
    }
    expect(outputs.get(1e6)).toEqual(outputs.get(1e5));
    expect(keyWork.get(1e6)).toBe(keyWork.get(1e5));
  }, 120_000);

  it("ctx and each schema field have their own budget, so no field order turns level or ids into markers", async () => {
    const graph = shared(24);
    const ids = { traceId: "t-1", spanId: "s-1", requestId: "r-1", userId: "u-1", tenantId: "n-1" };
    const inputs: LogEvent[] = [
      { ctx: { graph }, ...event(), ...ids },
      { extra: graph, ...ids, ...event({ ctx: { kept: true } }) } as LogEvent,
      { ...event(), ...ids, ctx: { graph }, extra: graph } as LogEvent,
    ];
    for (const input of inputs) {
      const spy = fetchSpy();
      const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
      const captured = capture();
      const reorder = (current: LogEvent) => ({ ...input, ...current, ctx: input.ctx });
      createLogger({ name: "test", now: () => new Date(input.ts), pipeline: [reorder, redactSecFn()], sinks: [captured.sink] }).info("m");
      sink([input]);
      await sink.flush();
      const sent = (JSON.parse(spy.requests[0].body) as { events: LogEvent[] }).events[0];
      for (const output of [sanitizeEvent(input), redactEvent(input), captured.events[0], sent]) {
        expect(output).toMatchObject({ ts: "2026-01-14T12:00:00.000Z", level: "info", name: "test", version: "0", ...ids });
        expect(isValidLogEvent(output)).toBe(true);
      }
      if ((input.ctx as { kept?: boolean }).kept) expect(sanitizeEvent(input).ctx).toEqual({ kept: true });
    }
  });

  // Every path that writes caller dates or tags: sanitization, redaction, the logger's stage and the HTTP sink.
  const writers = (ctx: Record<string, unknown>, tags?: string[]) => {
    const spy = fetchSpy();
    const sink = sinkHttp({ url: "https://collector.test/ingest", fetch: spy.fetch });
    const captured = capture();
    const logger = createLogger({ name: "w", pipeline: [redactSecFn()], sinks: [captured.sink] });
    return [
      () => sanitizeValue({ ...ctx, tags }),
      () => sanitizeEvent(event({ ctx, tags })),
      () => redactEvent(event({ ctx, tags })),
      () => (logger.info("m", ctx, tags), captured.events[0]),
      async () => (sink([event({ ctx, tags })]), await sink.flush(), spy.requests[0].body),
    ];
  };

  it("dates are written by the built-in methods only: no caller override runs and the output stays plain", async () => {
    let calls = 0;
    const override = (date: Date) => {
      for (const method of ["toISOString", "toString", "getTime", "valueOf", "toJSON", Symbol.toPrimitive]) {
        Object.defineProperty(date, method, { value: () => (calls++, { toJSON: () => (calls++, "token=OVERRIDE_SECRET") }) });
      }
      return date;
    };
    const ctx = { valid: override(new Date(0)), invalid: override(new Date(Number.NaN)) };
    for (const run of writers(ctx)) {
      const output = JSON.stringify(await run());
      expect(output).toContain("1970-01-01T00:00:00.000Z");
      expect(output).toContain("Invalid Date");
      expect(output).not.toContain("OVERRIDE_SECRET");
    }
    expect(calls).toBe(0);
  });

  it.each([100, 1e5])("%i references to one date are charged by their text and stop at the budget", async (count) => {
    const date = new Date(0);
    // 10 MB of override text in all, whatever the count.
    date.toISOString = () => "x".repeat(10_000_000 / count);
    for (const run of writers({ items: Array(count).fill(date) })) {
      const output = JSON.stringify(await run());
      expect(output.length).toBeLessThan(2 * MAX_TRAVERSAL);
      expect(output).not.toContain("xxxx");
    }
    const items = (sanitizeValue({ items: Array(count).fill(date) }) as { items: string[] }).items;
    if (count === 100) expect(items).toEqual(Array(100).fill("1970-01-01T00:00:00.000Z"));
    else expect([items.length < count, items.at(-1)]).toEqual([true, MAX_SIZE]);
  });

  it("tags are charged on their own budget: shared long tags stop at it, and tags within it are unchanged", async () => {
    const long = "t".repeat(1_000_000);
    for (const run of writers({}, Array(1000).fill(long))) {
      const { elapsed, size } = await timed(run);
      expect(elapsed).toBeLessThan(5000);
      expect(size).toBeLessThan(2 * MAX_TRAVERSAL);
    }
    const half = "h".repeat(MAX_TRAVERSAL / 2);
    const fill = { fill: "f".repeat(MAX_TRAVERSAL - 100) };
    expect(sanitizeEvent(event({ ctx: fill, tags: [half, half, "late"] })).tags).toEqual([half, MAX_SIZE, MAX_SIZE]);
    expect(redactEvent(event({ ctx: fill, tags: ["a", "token=x"] })).tags).toEqual(["a", "token=[redacted]"]);
  });

  it("the logger merges context layers like object spread", () => {
    const merged = mergeContext({ a: 1, b: 2 }, undefined, JSON.parse('{"b": 3, "__proto__": 4, "c": 5}'));
    expect(Object.entries(merged)).toEqual([["a", 1], ["b", 3], ["__proto__", 4], ["c", 5]]);
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
