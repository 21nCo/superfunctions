import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import type { Diagnostic } from "../src/diagnostics.js";
import { createDocumentOutput, MAX_WARNINGS_PER_KIND, type DocumentOutcome } from "../src/document-output.js";
import { classifyRunnerError } from "../src/errors.js";
import { createDocumentBudget, createWorkBudget, MAX_NESTING_DEPTH, serializeJsonMember } from "../src/json-value.js";
import {
  addReturnedDiagnostics,
  runAction,
  type RunnerActionResult,
  type RunnerContext,
  type RunnerOptions,
} from "../src/runner.js";

// CLI-22: the redaction boundary and the bounds of the result document (D8).

type Action = (options: Record<string, never>, ctx: RunnerContext) => Promise<RunnerActionResult> | RunnerActionResult;

async function runDocument(action: Action, extra: RunnerOptions = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runAction(action, {}, {
    color: false,
    ...extra,
    mode: "json",
    jsonStyle: "document",
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { exitCode, out: stdout.join(""), writes: stdout.length, stderr: stderr.join("") };
}

/** Parses stdout as exactly one JSON document followed by one newline, written in a single call. */
function parseOnlyDocument(result: { out: string; writes: number }): Record<string, unknown> {
  expect(result.writes).toBe(1);
  expect(result.out.indexOf("\n")).toBe(result.out.length - 1);
  return JSON.parse(result.out) as Record<string, unknown>;
}

function finishWith(maxLength: number, outcome: DocumentOutcome, diagnostics: Diagnostic[] = []) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output = createDocumentOutput({
    maxLength,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  for (const diagnostic of diagnostics) {
    output.diagnostics.add(diagnostic);
  }
  const exitCode = output.finish(outcome);
  return { exitCode, out: stdout.join(""), writes: stdout.length, stderr: stderr.join("") };
}

const FAILURE_DOCUMENT = {
  ok: false,
  error: { code: "CLIFN_RUNNER_FAILED", message: "Unable to serialize the result document" },
};

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Every sensitive key form the document covers, each with its own dummy value, so a leak names the key. The values
 * are built at runtime and are obviously fake.
 */
const SENSITIVE_KEYS = [
  "authorization",
  "Authorization",
  "token",
  "accessToken",
  "secret",
  "clientSecret",
  "password",
  "PASSWORD",
  "cookie",
  "Set-Cookie",
  "apiKey",
  "api_key",
  "api-key",
  "sessionId",
  "session_id",
  "accessKey",
  "access-key",
  "refreshToken",
  "refresh_token",
  "DOCKER_AUTH_CONFIG",
  "docker_auth_config",
  "dockerAuthConfig",
] as const;

const dummyValue = (key: string) => ["test", "dummy", key.toLowerCase().replace(/[^a-z]/g, ""), "value"].join("-");

function sensitiveRecord(): Record<string, string> {
  return Object.fromEntries(SENSITIVE_KEYS.map((key) => [key, dummyValue(key)]));
}

const redactedRecord = Object.fromEntries(SENSITIVE_KEYS.map((key) => [key, "[REDACTED]"]));

function expectNoDummyValue(text: string): void {
  for (const key of SENSITIVE_KEYS) {
    expect(text).not.toContain(dummyValue(key));
  }
}

describe("document redaction covers every sensitive key in every structured member", () => {
  it("redacts each covered key in data, the json() fallback, diagnostics and error details", async () => {
    const data = await runDocument(() => ({
      data: { visible: "kept", ...sensitiveRecord(), nested: [{ ...sensitiveRecord() }] },
    }));
    expect(parseOnlyDocument(data)).toEqual({
      ok: true,
      data: { visible: "kept", ...redactedRecord, nested: [redactedRecord] },
    });
    expectNoDummyValue(data.out);

    const fallback = await runDocument((_options, ctx) => {
      ctx.output.json({ visible: "kept", ...sensitiveRecord() });
    });
    expect(parseOnlyDocument(fallback)).toEqual({ ok: true, data: { visible: "kept", ...redactedRecord } });
    expectNoDummyValue(fallback.out);

    const failure = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: { visible: 1, ...sensitiveRecord() } });
      throw Object.assign(new Error("closed"), {
        code: "CLOSED",
        exitCode: 7,
        details: { visible: 2, inner: { ...sensitiveRecord() } },
      });
    });
    expect(failure.exitCode).toBe(7);
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "CLOSED", message: "closed", details: { visible: 2, inner: redactedRecord } },
      diagnostics: [{ code: "D", severity: "info", message: "m", details: { visible: 1, ...redactedRecord } }],
    });
    expectNoDummyValue(failure.out);
    expectNoDummyValue(failure.stderr);
  });

  it("redacts sensitive keys a toJSON projection creates, at any depth", async () => {
    const projected = () => ({
      toJSON: () => ({ visible: "kept", ...sensitiveRecord(), child: { toJSON: () => ({ ...sensitiveRecord() }) } }),
    });
    const expected = { visible: "kept", ...redactedRecord, child: redactedRecord };

    const result = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: { node: projected() } });
      return { data: projected() };
    });
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: expected,
      diagnostics: [{ code: "D", severity: "info", message: "m", details: { node: expected } }],
    });
    expectNoDummyValue(result.out);
  });

  it("states the boundary: a projected rename, an unrelated key and supplied messages print as given", async () => {
    // The contract is key-based on the emitted structure. A custom projection that renames `password` to `pw`, or
    // puts a secret under an unrelated key, is the caller's to make safe; so are messages, which are never parsed.
    const renamed = { password: "test-renamed-value", toJSON: () => ({ pw: "test-renamed-value" }) };
    const unrelated = { note: { toJSON: () => "test-unrelated-value" } };
    const result = await runDocument((_options, ctx) => {
      ctx.output.info("token=test-log-message-value");
      ctx.diagnostics.add({ code: "D", severity: "info", message: "password: test-diagnostic-message-value" });
      throw Object.assign(new Error("secret test-error-message-value"), {
        code: "MESSAGES",
        exitCode: 4,
        details: { renamed, unrelated, password: "test-password-value" },
      });
    });

    expect(result.exitCode).toBe(4);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: {
        code: "MESSAGES",
        message: "secret test-error-message-value",
        details: { renamed: { pw: "test-renamed-value" }, unrelated: { note: "test-unrelated-value" }, password: "[REDACTED]" },
      },
      diagnostics: [{ code: "D", severity: "info", message: "password: test-diagnostic-message-value" }],
    });
    expect(result.out).not.toContain("test-password-value");
    expect(result.stderr).toBe('{"level":"info","message":"token=test-log-message-value"}\n');
  });

  it("never matches a message or code longer than the document could print against the code patterns", () => {
    const test = vi.spyOn(RegExp.prototype, "test");
    const long = `CLIFN_${"X".repeat(10_000)}`;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ message: long, exitCode: 7 }, "CLIFN_RUNNER_FAILED"],
      [{ code: "BIG", message: long, exitCode: 7 }, "BIG"],
      [{ code: `C${"C".repeat(10_000)}`, message: long, exitCode: 7 }, "CLIFN_RUNNER_FAILED"],
    ];
    for (const [thrown, code] of cases) {
      const result = finishWith(300, { ok: false, error: thrown });
      expect(result.exitCode).toBe(7);
      expect(parseOnlyDocument(result)).toEqual({
        ok: false,
        error: { code, message: "The error message was too long to print." },
      });
    }
    // A regular expression flattens the string it scans: a rope far larger than the heap would be copied whole.
    expect(test.mock.calls.filter(([text]) => typeof text === "string" && text.length > 300)).toEqual([]);
  });

  it("states the stderr boundary: log details print as given while the stdout document stays redacted", async () => {
    const result = await runDocument((_options, ctx) => {
      ctx.output.info("logged", { password: "test-log-details-value" });
      return { data: { password: "test-log-details-value" } };
    });
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: { password: "[REDACTED]" } });
    expect(result.out).not.toContain("test-log-details-value");
    // Log lines are messages the caller supplies, details included: they are not key-redacted.
    expect(result.stderr).toContain("test-log-details-value");
  });

  it("keeps redaction when the error message falls back to the fixed too-long message", () => {
    const longMessage = "m".repeat(400);
    const result = finishWith(300, {
      ok: false,
      error: Object.assign(new Error(longMessage), {
        code: "LONG",
        exitCode: 9,
        details: { visible: 1, password: "test-fallback-password-value" },
      }),
    });
    expect(result.exitCode).toBe(9);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: {
        code: "LONG",
        message: "The error message was too long to print.",
        details: { visible: 1, password: "[REDACTED]" },
      },
    });
    expect(result.out).not.toContain("test-fallback-password-value");
  });

  it("keeps the kept diagnostics redacted when others are dropped for size", () => {
    const result = finishWith(
      260,
      { ok: true, data: null, exitCode: 2 },
      [
        { code: "BIG", severity: "info", message: "x".repeat(400) },
        { code: "SMALL", severity: "info", message: "s", details: { token: "test-small-token-value" } },
      ]
    );
    expect(result.exitCode).toBe(2);
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: null,
      diagnostics: [{ code: "SMALL", severity: "info", message: "s", details: { token: "[REDACTED]" } }],
    });
    expect(result.out).not.toContain("test-small-token-value");
  });
});

describe("document failures print fixed messages only", () => {
  const leak = ["test", "exception", "text"].join("-");

  it("omits the raw exception and member value when the data cannot be serialized", async () => {
    const result = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "kept until the data failed" });
      return {
        exitCode: 3,
        data: {
          visible: leak,
          get broken(): unknown {
            throw new Error(leak);
          },
        },
      };
    });
    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual(FAILURE_DOCUMENT);
    expect(result.out).not.toContain(leak);
    expect(result.stderr).not.toContain(leak);
  });

  it("drops a diagnostic whose details throw with a fixed warning that names only its index", async () => {
    const result = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({
        code: "THROWS",
        severity: "warning",
        message: "m",
        details: {
          toJSON() {
            throw new Error(leak);
          },
        },
      });
      ctx.diagnostics.add({ code: "BAD", severity: 3 as never, message: leak });
      return { data: "done" };
    });
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "done" });
    expect(result.stderr).not.toContain(leak);
    expect(result.stderr.trim().split("\n").map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        level: "warn",
        message: "diagnostic 0 was dropped from the result document: it could not be redacted or printed",
      },
      {
        level: "warn",
        message: "diagnostic 1 was dropped from the result document: it could not be redacted or printed",
      },
    ]);
  });
});

/** A proxy over `target` (and every object reached through it) that records each trap in `log`. */
function recorded<T extends object>(target: T, log: string[], path = "$"): T {
  return new Proxy(target, {
    get(object, key, receiver) {
      log.push(`get ${path}.${String(key)}`);
      const value: unknown = Reflect.get(object, key, receiver);
      return typeof value === "object" && value !== null ? recorded(value, log, `${path}.${String(key)}`) : value;
    },
    ownKeys(object) {
      log.push(`ownKeys ${path}`);
      return Reflect.ownKeys(object);
    },
    getOwnPropertyDescriptor(object, key) {
      log.push(`descriptor ${path}.${String(key)}`);
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
    has(object, key) {
      log.push(`has ${path}.${String(key)}`);
      return Reflect.has(object, key);
    },
    // JSON.stringify never asks for a prototype, so neither may the document.
    getPrototypeOf(object) {
      log.push(`getPrototypeOf ${path}`);
      return Reflect.getPrototypeOf(object);
    },
  });
}

describe("document serialization follows native JSON.stringify member order", () => {
  /** Undefined, function and symbol members, a sparse array, nested arrays and a sensitive subtree. */
  const fixture = () => {
    const sparse: unknown[] = [1];
    sparse[3] = { deep: true };
    return {
      first: 1,
      skipped: undefined,
      fn: () => 1,
      sym: Symbol("s"),
      sparse,
      nested: { list: [[2, { three: 3 }], null], text: "t" },
      password: { inner: ["test-inner-value"], more: { tokenish: 1 } },
      last: "z",
    };
  };

  it("reads keys, descriptors, lengths and members in native order and each once", async () => {
    const nativeLog: string[] = [];
    const nativeText = JSON.stringify(recorded(fixture(), nativeLog));
    const documentLog: string[] = [];
    const result = await runDocument(() => ({ data: recorded(fixture(), documentLog) }));

    expect(documentLog).toEqual(nativeLog);
    // The redacted subtree is still walked in native order, but none of it is printed.
    expect(documentLog).toContain("get $.password.inner.0");
    const expected = JSON.parse(nativeText) as Record<string, unknown>;
    expected.password = "[REDACTED]";
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: expected });
  });

  it("reads a proxied array length once and no index of an oversized one", async () => {
    const reads: string[] = [];
    const huge = new Proxy([], {
      get(target, key) {
        reads.push(String(key));
        return key === "length" ? 2 ** 32 - 1 : Reflect.get(target, key);
      },
    });
    const result = await runDocument(() => ({ data: { huge } }));
    expect(parseOnlyDocument(result)).toEqual(FAILURE_DOCUMENT);
    expect(reads).toEqual(["toJSON", "length"]);
  });

  it("prints a proxy whose getPrototypeOf trap throws, as JSON.stringify does, without calling the trap", async () => {
    const getPrototypeOf = vi.fn(() => {
      throw new Error("getPrototypeOf was called");
    });
    const data = { object: new Proxy({ kept: 1 }, { getPrototypeOf }), list: new Proxy([1, 2], { getPrototypeOf }) };
    expect(JSON.stringify(data)).toBe('{"object":{"kept":1},"list":[1,2]}');
    const result = await runDocument(() => ({ data, exitCode: 3 }));
    expect(result.exitCode).toBe(3);
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: { object: { kept: 1 }, list: [1, 2] } });
    expect(getPrototypeOf).not.toHaveBeenCalled();
  });
});

describe("document nesting depth", () => {
  const nested = (depth: number) => {
    let node: unknown = "leaf";
    for (let level = 0; level < depth; level += 1) {
      node = level % 2 === 0 ? { child: node } : [node];
    }
    return node;
  };

  it("prints values nested up to the limit as native JSON does", async () => {
    const value = nested(MAX_NESTING_DEPTH);
    const result = await runDocument(() => ({ data: value }));
    expect(result.out).toBe(`{"ok":true,"data":${JSON.stringify(value)}}\n`);
  });

  it("fails data nested past the limit with the bounded document and keeps the outcome for deep details", async () => {
    const data = await runDocument(() => ({ data: nested(MAX_NESTING_DEPTH + 1) }));
    expect(data.exitCode).toBe(1);
    expect(parseOnlyDocument(data)).toEqual(FAILURE_DOCUMENT);

    const failure = await runDocument(() => {
      throw Object.assign(new Error("deep"), { code: "DEEP", exitCode: 5, details: { value: nested(100_000) } });
    });
    expect(failure.exitCode).toBe(5);
    expect(parseOnlyDocument(failure)).toEqual({ ok: false, error: { code: "DEEP", message: "deep" } });
  });
});

describe("document string escapes", () => {
  it("prints escape-heavy text that fits and never builds escaped text that does not", () => {
    const frame = '{"ok":true,"data":}\n'.length;
    const text = "\u0000".repeat(100);
    const exact = 6 * 100 + 2 + frame;
    expect(parseOnlyDocument(finishWith(exact, { ok: true, data: text, exitCode: 0 }))).toEqual({ ok: true, data: text });

    const stringify = vi.spyOn(JSON, "stringify");
    const tooLong = finishWith(exact - 1, { ok: true, data: text, exitCode: 0 });
    expect(parseOnlyDocument(tooLong)).toEqual(FAILURE_DOCUMENT);
    expect(stringify.mock.calls.some(([value]) => value === text)).toBe(false);
  });

  it("omits details with escape-heavy text that does not fit and keeps the code, message and exit code", () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const text = "\n".repeat(1_000);
    const result = finishWith(1_500, {
      ok: false,
      error: Object.assign(new Error("escapes"), { code: "ESCAPES", exitCode: 6, details: { visible: 1, text } }),
    });
    expect(result.exitCode).toBe(6);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "ESCAPES", message: "escapes" } });
    expect(stringify.mock.calls.some(([value]) => value === text)).toBe(false);
  });
});

describe("document work spent on redacted and dropped values", () => {
  it("charges a masked value only its placeholder, so shared and long secrets keep their siblings", () => {
    const secret = "s".repeat(1 << 20);
    const rows = Array.from({ length: 2_000 }, (_, index) => ({ index, token: secret }));
    const result = finishWith(100_000, { ok: true, data: { rows, visible: "kept" }, exitCode: 3 });
    expect(result.exitCode).toBe(3);
    const document = parseOnlyDocument(result) as { data: { rows: unknown[]; visible: string } };
    expect(document.data.rows).toHaveLength(2_000);
    expect(document.data.rows[1_999]).toEqual({ index: 1_999, token: "[REDACTED]" });
    expect(document.data.visible).toBe("kept");
  });

  it("bounds the walk of a redacted value separately and fails it before reading an oversized array", () => {
    let reads = 0;
    const generated = new Proxy([], {
      get: (target, key) => {
        if (key === "length") {
          return 50_000;
        }
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads += 1;
        }
        return Reflect.get(target, key);
      },
    });
    const result = finishWith(10_000, {
      ok: false,
      error: Object.assign(new Error("masked"), {
        code: "MASKED",
        exitCode: 8,
        details: { visible: 1, password: { toJSON: () => generated } },
      }),
    });
    expect(result.exitCode).toBe(8);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "MASKED", message: "masked" } });
    expect(reads).toBe(0);
  });

  it("fails a toJSON that branches back to itself under several keys on its budgets, one call per member", () => {
    let calls = 0;
    const branching = {
      toJSON(this: object) {
        calls += 1;
        return { a: this, b: this };
      },
    };
    expect(() => JSON.stringify(branching)).toThrow(RangeError);
    calls = 0;
    // Neither key's chain recurs 64 times on most paths, so the tree is walked until the text budget is spent.
    const data = finishWith(20_000, { ok: true, data: branching, exitCode: 0 });
    expect(data.exitCode).toBe(1);
    expect(data.out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
    // Each call prints at least one character, so the calls are bounded by the text budget.
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(2 * 20_000);

    calls = 0;
    const details = finishWith(20_000, {
      ok: false,
      error: Object.assign(new Error("branching"), { code: "BRANCHING", exitCode: 6, details: { loop: branching } }),
    });
    expect(details.exitCode).toBe(6);
    expect(parseOnlyDocument(details)).toEqual({ ok: false, error: { code: "BRANCHING", message: "branching" } });
    expect(calls).toBeLessThan(2 * 20_000);

    // Under a redacted key nothing prints: each value costs one unit of the work allowance (twice the limit).
    calls = 0;
    const masked = finishWith(20_000, { ok: true, data: { visible: 1, secret: branching }, exitCode: 0 });
    expect(masked.out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(2 * 20_000);
  });

  it("charges the text of dropped diagnostics to the work budget, so they cannot re-encode text without end", () => {
    const limit = 20_000;
    const encoded = { chars: 0 };
    const stringify = JSON.stringify;
    vi.spyOn(JSON, "stringify").mockImplementation((value: unknown, ...rest: unknown[]) => {
      if (typeof value === "string") {
        encoded.chars += value.length;
      }
      return Reflect.apply(stringify, JSON, [value, ...rest]) as string;
    });
    // Each code fits on its own, and each severity is too long, so every diagnostic is dropped after its code.
    const diagnostic = { code: "c".repeat(limit / 2), severity: "s".repeat(limit), message: "m" };
    const result = finishWith(limit, { ok: true, data: "kept", exitCode: 5 }, Array.from({ length: 512 }, () => diagnostic));
    expect(result.exitCode).toBe(5);
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "kept" });
    // Without the charge, all 512 codes would be encoded: about 512 * 10,000 characters.
    expect(encoded.chars).toBeLessThan(3 * limit);
  });

  it("does not charge a typed array rejected before its keys are listed, so later diagnostics are kept", () => {
    const result = finishWith(2_000, { ok: true, data: 1, exitCode: 0 }, [
      { code: "A", severity: "info", message: "m", details: { secret: new Uint8Array(100_000) } },
      { code: "B", severity: "info", message: "m" },
    ]);
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: 1,
      diagnostics: [
        { code: "A", severity: "info", message: "m" },
        { code: "B", severity: "info", message: "m" },
      ],
    });
  });

  it("walks a redacted subtree in time proportional to its size", async () => {
    const make = (count: number) => ({
      secret: Array.from({ length: count }, (_, index) => ({ index, nested: [index] })),
      visible: "kept",
    });
    const time = async (count: number) => {
      const value = make(count);
      const started = performance.now();
      const result = await runDocument(() => ({ data: value }));
      const elapsed = performance.now() - started;
      expect(parseOnlyDocument(result)).toEqual({ ok: true, data: { secret: "[REDACTED]", visible: "kept" } });
      return elapsed;
    };
    await time(10_000);
    const small = await time(50_000);
    const large = await time(200_000);
    // Four times the values: generous room for timer noise, far below a quadratic walk (16x).
    expect(large).toBeLessThan(small * 10 + 200);
  });
});

describe("document advisory stderr writes", () => {
  const throwingStderr = () => {
    throw new Error("stderr closed");
  };

  async function runWithStderr(action: Action, stderr: (text: string) => void) {
    const stdout: string[] = [];
    const exitCode = await runAction(action, {}, {
      color: false,
      mode: "json",
      jsonStyle: "document",
      stdout: (text) => stdout.push(text),
      stderr,
    });
    return { exitCode, out: stdout.join(""), writes: stdout.length };
  }

  it("keeps a success and its exit code when stderr throws on the unused-call and dropped-diagnostic warnings", async () => {
    const result = await runWithStderr((_options, ctx) => {
      ctx.output.json({ unused: true });
      ctx.output.table({ rows: [] } as never);
      ctx.diagnostics.add(undefined as never);
      return { data: "done", exitCode: 4 };
    }, throwingStderr);
    expect(result.exitCode).toBe(4);
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "done" });
  });

  it("keeps a mapped failure code and exit code when stderr throws on the warnings", async () => {
    const result = await runWithStderr((_options, ctx) => {
      ctx.output.json({ unused: true });
      ctx.diagnostics.add({ code: "BAD", severity: 1 as never, message: "m" });
      throw Object.assign(new Error("closed"), { code: "CLOSED", exitCode: 7 });
    }, throwingStderr);
    expect(result.exitCode).toBe(7);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "CLOSED", message: "closed" } });
  });

  it("keeps the result when stderr throws on streamed child output that has no writer of its own", async () => {
    // The forwarder runs in the child's stream listener: a throw escaping it is an uncaught exception, which Vitest
    // reports as an unhandled error that fails the run, and leaves the result document unwritten.
    const childScript = 'process.stdout.write("child-out"); process.stderr.write("child-err");';
    const result = await runWithStderr(async (_options, ctx) => {
      const run = await ctx.exec.command(process.execPath, ["-e", childScript], { streamOutput: true });
      return { data: { stdout: run.stdout, stderr: run.stderr }, exitCode: 4 };
    }, throwingStderr);
    expect(result.exitCode).toBe(4);
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: { stdout: "child-out", stderr: "child-err" } });
  });

  it("bounds the warnings for unused calls and dropped diagnostics", async () => {
    const result = await runDocument((_options, ctx) => {
      for (let index = 0; index < 50; index += 1) {
        ctx.output.json(index);
        ctx.diagnostics.add(undefined as never);
      }
      return { data: "done" };
    });
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "done" });
    const lines = result.stderr.trim().split("\n").map((line) => (JSON.parse(line) as { message: string }).message);
    expect(lines).toHaveLength(2 * (MAX_WARNINGS_PER_KIND + 1));
    expect(lines[MAX_WARNINGS_PER_KIND]).toBe("further output.json() and output.table() calls were not printed either");
    expect(lines.at(-1)).toBe("further diagnostics were dropped from the result document");
  });

  it("reads no diagnostic past what the document can print and warns once for the rest", () => {
    let reads = 0;
    const diagnostics = new Proxy([] as Diagnostic[], {
      get: (target, key) => {
        if (key === "length") {
          return 2e8;
        }
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads += 1;
          return { code: "D", severity: "info", message: "m" };
        }
        return Reflect.get(target, key);
      },
    });
    const { output, result } = documentWith(1_000);
    addReturnedDiagnostics(diagnostics, output.diagnostics);
    const exitCode = output.finish({ ok: true, data: 1, exitCode: 0 });
    // The text a document could print after its smallest data, 1000 - '{"ok":true,"data":0,"diagnostics":[]}\n' = 962
    // characters, keeps 21 of these 45-character diagnostics (with their separators) and no index past them is read.
    expect(reads).toBe(21);
    expect(exitCode).toBe(0);
    const document = parseOnlyDocument(result()) as { data: number; diagnostics: Diagnostic[] };
    expect(document.data).toBe(1);
    expect(document.diagnostics).toHaveLength(21);
    expect(result().stderr).toContain("diagnostics past the first 21 were dropped");
  });
});

/** A document output with a small limit, written to arrays: `result()` reads what it printed. */
function documentWith(maxLength: number) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output = createDocumentOutput({
    maxLength,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { output, result: () => ({ out: stdout.join(""), writes: stdout.length, stderr: stderr.join("") }) };
}

describe("document diagnostics retained by size", () => {
  /** Fresh diagnostics, each with a new message of `size` characters, counting how many were read. */
  function freshDiagnostics(size: number, extra: (index: number) => Partial<Diagnostic> = () => ({})) {
    const counter = { reads: 0 };
    function* generate(): Generator<Diagnostic> {
      for (let index = 0; ; index += 1) {
        counter.reads += 1;
        yield { code: "D", severity: "info", message: `${index}:${"x".repeat(size)}`, ...extra(index) };
      }
    }
    return { counter, generate };
  }

  it("stops reading an endless iterable of large fresh diagnostics once their text fills the document", () => {
    const { counter, generate } = freshDiagnostics(1_000);
    const { output, result } = documentWith(10_000);
    addReturnedDiagnostics(generate(), output.diagnostics);
    // Nine kept ones fill the text; each one then dropped for size costs the work allowance (20,000 units) the text
    // that was left (about 580), so reading stops far below the 255 empty diagnostics the count allows.
    expect(counter.reads).toBeGreaterThan(9);
    expect(counter.reads).toBeLessThan(50);
    expect(output.diagnostics.full()).toBe(true);
    expect(output.finish({ ok: true, data: "done", exitCode: 2 })).toBe(2);
    const document = parseOnlyDocument(result()) as { data: string; diagnostics: Diagnostic[] };
    expect(document.data).toBe("done");
    expect(document.diagnostics.length).toBeGreaterThan(5);
    expect(document.diagnostics[0].message.startsWith("0:x")).toBe(true);
    expect(result().stderr).toContain(`diagnostics past the first ${counter.reads - 1} were dropped`);
  });

  it("drops a diagnostic added while another is being read, so it cannot spend a budget the reader gives back", async () => {
    const limit = 10_000;
    const inner = "i".repeat(limit / 2);
    // Each outer diagnostic adds one large diagnostic from its message getter, or from its details' toJSON.
    const reentrant = (add: (diagnostic: Diagnostic) => void, index: number): Diagnostic => {
      let added = false;
      const addOnce = () => {
        if (!added) {
          added = true;
          add({ code: `I${index}`, severity: "info", message: inner });
        }
      };
      return {
        code: `O${index}`,
        severity: "info",
        get message() {
          addOnce();
          return "o";
        },
        details: { toJSON: () => (addOnce(), { index }) },
      } as Diagnostic;
    };
    const listedChars = (list: readonly Diagnostic[]) => list.reduce((sum, item) => sum + JSON.stringify(item).length, 0);

    const { output, result } = documentWith(limit);
    for (let index = 0; index < 200; index += 1) {
      output.diagnostics.add(reentrant((diagnostic) => output.diagnostics.add(diagnostic), index));
    }
    const listed = output.diagnostics.list();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((diagnostic) => diagnostic.code.startsWith("O"))).toBe(true);
    expect(listedChars(listed)).toBeLessThan(limit);
    expect(output.finish({ ok: true, data: "done", exitCode: 3 })).toBe(3);
    expect(result().out.length).toBeLessThanOrEqual(limit);
    expect((parseOnlyDocument(result()) as { data: string }).data).toBe("done");
    expect(result().stderr).toContain("diagnostics added while another diagnostic was being read were dropped");

    // Through the runner, from the action's sink, with a listener that lists them.
    let listenerChars = -1;
    const run = await runDocument(
      (_options, ctx) => {
        for (let index = 0; index < 200; index += 1) {
          ctx.diagnostics.add(reentrant((diagnostic) => ctx.diagnostics.add(diagnostic), index));
        }
        return { data: "done", exitCode: 3 };
      },
      { onDiagnostics: (list) => (listenerChars = listedChars(list)) }
    );
    expect(run.exitCode).toBe(3);
    expect(listenerChars).toBeGreaterThan(0);
    // Only the 200 outer diagnostics (about 60 characters each); the inner ones would add 200 times 5,000.
    expect(listenerChars).toBeLessThan(20_000);
    const document = parseOnlyDocument(run) as { data: string; diagnostics: Diagnostic[] };
    expect(document.data).toBe("done");
    expect(document.diagnostics.every((diagnostic) => diagnostic.code.startsWith("O"))).toBe(true);
  });

  it("reads no diagnostic added once the document is full, from the action's sink or a returned list", async () => {
    const { generate } = freshDiagnostics(1_000);
    const late = vi.fn(() => "late");
    const lateDiagnostic = Object.defineProperty({ severity: "info", message: "m" }, "code", { get: late, enumerable: true });
    const { output } = documentWith(10_000);
    addReturnedDiagnostics(generate(), output.diagnostics);
    output.diagnostics.add(lateDiagnostic as Diagnostic);
    addReturnedDiagnostics([lateDiagnostic], output.diagnostics);
    expect(late).not.toHaveBeenCalled();
  });

  it("keeps the text of each diagnostic once, never the object, so later changes to it are not printed", async () => {
    const details: Record<string, unknown> = { region: "eu" };
    const diagnostic = { code: "SET", severity: "info" as const, message: "as added", details };
    const result = await runDocument((_options, ctx) => {
      ctx.diagnostics.add(diagnostic);
      diagnostic.message = "changed";
      details.region = "us";
      return { data: 1 };
    });
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: 1,
      diagnostics: [{ code: "SET", severity: "info", message: "as added", details: { region: "eu" } }],
    });
  });

  it("lists the diagnostics as the document prints them, redacted, once each, with no unusable entry", async () => {
    const toJSON = vi.fn(() => ({ apiKey: dummyValue("apiKey"), visible: "kept" }));
    const lists: Array<readonly Diagnostic[]> = [];
    const result = await runDocument(
      (_options, ctx) => {
        ctx.diagnostics.add({ code: "A", severity: "info", message: "a", details: { toJSON } as never });
        const first = ctx.diagnostics.list();
        // A listed copy changed by the caller does not change the document.
        (first[0] as { message: string }).message = "changed by the action";
        return { data: "ok", exitCode: 7, diagnostics: [undefined, { code: "B", severity: "info", message: "b" }] as never };
      },
      { onDiagnostics: (list) => lists.push(list) }
    );
    expect(toJSON).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(7);
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: "ok",
      diagnostics: [
        { code: "A", severity: "info", message: "a", details: { apiKey: "[REDACTED]", visible: "kept" } },
        { code: "B", severity: "info", message: "b" },
      ],
    });
    expect(lists).toEqual([
      [
        { code: "A", severity: "info", message: "changed by the action", details: { apiKey: "[REDACTED]", visible: "kept" } },
        { code: "B", severity: "info", message: "b" },
      ],
    ]);
    expectNoDummyValue(JSON.stringify(lists) + result.out + result.stderr);
    expect(result.stderr.trim().split("\n").map((line) => (JSON.parse(line) as { message: string }).message)).toEqual([
      "diagnostic 1 was dropped from the result document: it could not be redacted or printed",
    ]);
  });

  it("bounds the copies it lists by their details text, without changing what the document prints", () => {
    // 10,000 characters allow 10,000 copy units, 32 per character of details text: 2,000-item details (about 4,000
    // characters) are never copied, and 100-item details (about 220 characters) are copied once.
    const listedDetails = (items: number) => {
      const { output, result } = documentWith(10_000);
      const list = Array.from({ length: items }, () => 0);
      for (const code of ["FIRST", "SECOND"]) {
        output.diagnostics.add({ code, severity: "info", message: "m", details: { list } });
      }
      const listed = output.diagnostics.list().map((diagnostic) => diagnostic.details !== undefined);
      expect(output.finish({ ok: true, data: 1, exitCode: 0 })).toBe(0);
      const printed = (parseOnlyDocument(result()) as { diagnostics: Diagnostic[] }).diagnostics;
      // The document prints the details in full either way.
      expect(printed.map((diagnostic) => diagnostic.details)).toEqual([{ list }, { list }]);
      return listed;
    };
    expect(listedDetails(2_000)).toEqual([false, false]);
    expect(listedDetails(100)).toEqual([true, false]);
  });

  it("prints a kept diagnostic without its details when only they no longer fit after the data", () => {
    const { output, result } = documentWith(2_000);
    output.diagnostics.add({ code: "D", severity: "info", message: "m", details: { note: "n".repeat(900) } });
    expect(output.finish({ ok: true, data: "d".repeat(1_500), exitCode: 4 })).toBe(4);
    expect((parseOnlyDocument(result()) as { diagnostics: Diagnostic[] }).diagnostics).toEqual([
      { code: "D", severity: "info", message: "m" },
    ]);
  });
});

describe("document result reads", () => {
  const leak = ["test", "result", "getter", "text"].join("-");

  it("prints the fixed failure document with exit code 1 when a returned member getter throws", async () => {
    for (const member of ["data", "exitCode", "diagnostics"] as const) {
      const listener = vi.fn();
      const result = await runDocument(
        () =>
          Object.defineProperty({ data: "kept", exitCode: 9 }, member, {
            enumerable: true,
            get() {
              throw Object.assign(new Error(leak), { code: "MAPPED", exitCode: 6 });
            },
          }) as RunnerActionResult,
        { onDiagnostics: listener }
      );
      expect(result.exitCode).toBe(1);
      expect(parseOnlyDocument(result)).toEqual(FAILURE_DOCUMENT);
      expect(result.out + result.stderr).not.toContain(leak);
      expect(listener).toHaveBeenCalledTimes(1);
    }
  });

  it("prints the fixed failure document when the returned result is a throwing proxy", async () => {
    // Awaiting the action reads "then", which settles the action's own promise, so only the result members throw.
    const result = await runDocument(
      () =>
        new Proxy({}, {
          get(_target, key) {
            if (key === "then") {
              return undefined;
            }
            throw new Error(leak);
          },
        }) as RunnerActionResult
    );
    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual(FAILURE_DOCUMENT);
    expect(result.out).not.toContain(leak);
  });

  it("calls a throwing diagnostics listener once and reports its failure after a successful action", async () => {
    const listener = vi.fn(() => {
      throw Object.assign(new Error("listener failed"), { code: "LISTENER", exitCode: 5 });
    });
    const success = await runDocument(() => ({ data: "kept" }), { onDiagnostics: listener });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(success.exitCode).toBe(5);
    expect(parseOnlyDocument(success)).toEqual({ ok: false, error: { code: "LISTENER", message: "listener failed" } });

    listener.mockClear();
    const failure = await runDocument(
      () => {
        throw Object.assign(new Error("action failed"), { code: "ACTION", exitCode: 3 });
      },
      { onDiagnostics: listener }
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(failure.exitCode).toBe(3);
    expect(parseOnlyDocument(failure)).toEqual({ ok: false, error: { code: "ACTION", message: "action failed" } });
  });

  it("drops a returned diagnostic that cannot be read and keeps its siblings, the data and the exit code", async () => {
    const first = { code: "FIRST", severity: "info", message: "m" } as const;
    const last = { code: "LAST", severity: "info", message: "m" } as const;
    const throwingIndex = new Proxy([first, undefined, last] as unknown as Diagnostic[], {
      get: (target, key) => {
        if (key === "1") {
          throw new Error(leak);
        }
        return Reflect.get(target, key);
      },
    });
    function* failingIterator(): Generator<Diagnostic> {
      yield first;
      throw new Error(leak);
    }
    const cases: Array<[unknown, Diagnostic[]]> = [
      [throwingIndex, [first, last]],
      [failingIterator(), [first]],
      [5, []],
    ];
    for (const [diagnostics, kept] of cases) {
      // A listener that relies on its readonly Diagnostic[] type: an unreadable entry never reaches it.
      const codes: string[][] = [];
      const listener = vi.fn((list: readonly Diagnostic[]) => {
        codes.push(list.map((diagnostic) => diagnostic.code));
      });
      const result = await runDocument(
        () => ({ data: "ok", exitCode: 7, diagnostics: diagnostics as Diagnostic[] }),
        { onDiagnostics: listener }
      );
      expect(result.exitCode).toBe(7);
      expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "ok", ...(kept.length > 0 ? { diagnostics: kept } : {}) });
      expect(result.stderr.trim().split("\n")).toEqual([
        JSON.stringify({
          level: "warn",
          message: "a returned diagnostic was dropped from the result document: it could not be read",
        }),
      ]);
      expect(result.out + result.stderr).not.toContain(leak);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(codes).toEqual([kept.map((diagnostic) => diagnostic.code)]);
    }
  });

  it("warns for collected output calls when the result cannot be read either", async () => {
    const result = await runDocument((_options, ctx) => {
      ctx.output.json({ collected: true });
      return Object.defineProperty({}, "data", {
        get() {
          throw new Error("data getter failed");
        },
      }) as RunnerActionResult;
    });
    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual(FAILURE_DOCUMENT);
    expect(result.stderr).toContain("output.json() was not printed");
  });

  it("reads the stderr writer and a command's stream options once", async () => {
    const reads: string[] = [];
    const counted = <T extends object>(target: T, name: string, key: keyof T & string): T => {
      const value = target[key];
      return Object.defineProperty(target, key, {
        enumerable: true,
        get: () => (reads.push(`${name}.${key}`), value),
      });
    };
    const lines = counted({ mode: "json" as const, stdout: () => {}, stderr: () => {} }, "runner", "stderr");
    await runAction(() => ({ data: 1 }), {}, lines);
    expect(reads).toEqual(["runner.stderr"]);

    reads.length = 0;
    const childScript = 'process.stdout.write("child-out");';
    const result = await runDocument(async (_options, ctx) => {
      const options = counted(counted({ streamOutput: true, stdout: () => {} }, "exec", "streamOutput"), "exec", "stdout");
      const run = await ctx.exec.command(process.execPath, ["-e", childScript], options);
      return { data: run.stdout };
    });
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "child-out" });
    expect(reads).toEqual(["exec.streamOutput", "exec.stdout"]);
  });

  it("reads a returned sparse diagnostics array by index up to its length", async () => {
    const sparse: Diagnostic[] = [];
    sparse[2] = { code: "LAST", severity: "info", message: "m" };
    const result = await runDocument(() => ({ data: 1, diagnostics: sparse }));
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: 1,
      diagnostics: [{ code: "LAST", severity: "info", message: "m" }],
    });
    // The two holes are dropped with a warning each.
    expect(result.stderr.trim().split("\n")).toHaveLength(2);
  });
});

describe("document diagnostic envelope", () => {
  it("writes the code, severity, message and path directly, unaffected by an inherited toJSON", async () => {
    const leak = ["test", "inherited", "token"].join("-");
    const prototype = Object.prototype as { toJSON?: unknown };
    Object.defineProperty(prototype, "toJSON", {
      configurable: true,
      writable: true,
      value(this: Record<string, unknown>) {
        return "code" in this ? { leakedToken: leak } : this;
      },
    });
    try {
      const result = await runDocument((_options, ctx) => {
        ctx.diagnostics.add({ code: "D", severity: "info", message: "m", path: "p", details: { visible: 1 } });
        return { data: { code: "projected" } };
      });
      expect(result.out).not.toContain(leak);
      expect(parseOnlyDocument(result)).toEqual({
        ok: true,
        data: { leakedToken: "[REDACTED]" },
        diagnostics: [{ code: "D", severity: "info", message: "m", path: "p", details: { visible: 1 } }],
      });
    } finally {
      delete prototype.toJSON;
    }
  });
});

describe("document typed arrays and bigints", () => {
  it("prints a small typed array with its own members as JSON.stringify does", () => {
    const typed = Object.assign(new Uint8Array([1, 2, 3]), { label: "bytes" });
    const result = finishWith(1_000, { ok: true, data: { typed, big: new BigInt64Array([1n]) }, exitCode: 0 });
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: { typed: { 0: 1, 1: 2, 2: 3, label: "bytes" }, big: { 0: "1" } },
    });
  });

  it("fails an oversized typed array of any realm from its length, before listing its keys, redacted or not", () => {
    const keys = vi.spyOn(Object, "keys");
    const values = [new Uint8Array(3e6), runInNewContext("new Float64Array(3e6)") as object];
    for (const typed of values) {
      expect(finishWith(200, { ok: true, data: typed, exitCode: 0 }).out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
      const masked = finishWith(200, { ok: true, data: { visible: 1, password: typed }, exitCode: 0 });
      expect(masked.out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
    }
    expect(keys.mock.calls.some(([value]) => ArrayBuffer.isView(value))).toBe(false);
  });

  it("never converts a bigint under a redacted key, and rejects an oversized one by bit length", () => {
    const toString = vi.spyOn(BigInt.prototype, "toString");
    const huge = 2n ** 200_000n;
    const masked = finishWith(200, { ok: true, data: { visible: 1, secret: huge }, exitCode: 2 });
    expect(masked.exitCode).toBe(2);
    expect(parseOnlyDocument(masked)).toEqual({ ok: true, data: { visible: 1, secret: "[REDACTED]" } });
    expect(finishWith(200, { ok: true, data: huge, exitCode: 0 }).out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
    expect(toString).not.toHaveBeenCalled();
    // A bigint whose text fits prints as a string, as before.
    expect(parseOnlyDocument(finishWith(200, { ok: true, data: -(2n ** 64n), exitCode: 0 }))).toEqual({
      ok: true,
      data: "-18446744073709551616",
    });
  });
});

describe("document error names", () => {
  it("reads an Error's name once, so the message is always the string that was checked", async () => {
    let reads = 0;
    const named = () => {
      const error = Object.assign(new Error(""), { code: "CLOSED", exitCode: 7 });
      Object.defineProperty(error, "name", {
        get: () => {
          reads += 1;
          return reads === 1 ? "First" : { token: dummyValue("token") };
        },
      });
      return error;
    };
    const result = await runDocument(() => {
      throw named();
    });
    expect(result.exitCode).toBe(7);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "CLOSED", message: "First" } });
    expect(reads).toBe(1);
    expectNoDummyValue(result.out);

    // JSON lines classify through the same reader, so they print the same string.
    reads = 0;
    expect(classifyRunnerError(named())).toEqual({ error: { code: "CLOSED", message: "First" }, exitCode: 7 });
    expect(reads).toBe(1);
  });

  it("classifies the code, message, name and exit code before the details, so a details getter cannot change them", async () => {
    const reads: string[] = [];
    const thrown = () => {
      const error = new Error("");
      const fields: Record<string, unknown> = { code: "CLOSED", exitCode: 7, name: "Closed" };
      for (const key of ["code", "exitCode", "name"]) {
        Object.defineProperty(error, key, {
          get: () => (reads.push(key), fields[key]),
        });
      }
      Object.defineProperty(error, "details", {
        get: () => {
          reads.push("details");
          // Changes every field the classification read, after it read them.
          Object.assign(fields, { code: "CHANGED", exitCode: 1, name: "Changed" });
          return {
            visible: "kept",
            toJSON() {
              Object.assign(fields, { code: "PROJECTED", exitCode: 2, name: "Projected" });
              return { visible: "kept", token: dummyValue("token") };
            },
          };
        },
      });
      return error;
    };
    const result = await runDocument(() => {
      throw thrown();
    });
    expect(result.exitCode).toBe(7);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "CLOSED", message: "Closed", details: { visible: "kept", token: "[REDACTED]" } },
    });
    expect(reads).toEqual(["code", "exitCode", "name", "details"]);
    expectNoDummyValue(result.out);

    // JSON lines never read the details: the same classification, from the same reads.
    reads.length = 0;
    expect(classifyRunnerError(thrown())).toEqual({ error: { code: "CLOSED", message: "Closed" }, exitCode: 7 });
    expect(reads).toEqual(["code", "exitCode", "name"]);
  });
});

describe("document Buffer projections", () => {
  it("prints a small Buffer as JSON.stringify does, and redacts one under a sensitive key", () => {
    const bytes = Buffer.from([1, 2, 3]);
    const result = finishWith(1_000, { ok: true, data: { bytes, token: bytes }, exitCode: 4 });
    expect(result.exitCode).toBe(4);
    expect(result.out).toBe(`${JSON.stringify({ ok: true, data: { bytes, token: "[REDACTED]" } })}\n`);
  });

  it("prints Buffers, views and an inherited data toJSON exactly as JSON.stringify does", () => {
    const backing = Buffer.from([0, 1, 127, 128, 255, 9]);
    const floats = Object.setPrototypeOf(new Float64Array([1.5, Number.NaN, -0]), Buffer.prototype) as Float64Array;
    const values = { empty: Buffer.alloc(0), view: backing.subarray(2, 5), floats, list: [backing] };
    expect(String(serializeJsonMember("data", values))).toBe(JSON.stringify(values));

    // A toJSON the data array inherits receives the real array, so the native projection runs.
    const arrayPrototype = Array.prototype as { toJSON?: unknown };
    Object.defineProperty(arrayPrototype, "toJSON", {
      configurable: true,
      writable: true,
      value(this: unknown[]) {
        return `items:${this.length}`;
      },
    });
    try {
      const inherited = { bytes: Buffer.from([1, 2, 3]) };
      expect(String(serializeJsonMember("data", inherited))).toBe(JSON.stringify(inherited));
    } finally {
      delete arrayPrototype.toJSON;
    }
  });

  it("charges a Buffer under a sensitive key only its placeholder, at any depth, in data, details and diagnostics", () => {
    // 1,500 bytes print at least 3,001 characters, more than a 2,000 limit, but walking them masked costs 1,500 units
    // of the 4,000-unit work allowance: masked, they cost only the placeholder, as an Array(1500) does.
    const bytes = () => Buffer.alloc(1_500);
    for (const token of [bytes(), { inner: bytes() }, new Array(1_500)]) {
      const data = finishWith(2_000, { ok: true, data: { visible: "kept", token }, exitCode: 3 });
      expect(data.exitCode).toBe(3);
      expect(parseOnlyDocument(data)).toEqual({ ok: true, data: { visible: "kept", token: "[REDACTED]" } });
    }
    const details = finishWith(2_000, {
      ok: false,
      error: Object.assign(new Error("closed"), {
        code: "CLOSED",
        exitCode: 7,
        details: { visible: "kept", token: bytes() },
      }),
    });
    expect(details.exitCode).toBe(7);
    expect(parseOnlyDocument(details)).toEqual({
      ok: false,
      error: { code: "CLOSED", message: "closed", details: { visible: "kept", token: "[REDACTED]" } },
    });
    const diagnosticOutput = finishWith(2_000, { ok: true, data: "done", exitCode: 4 }, [
      { code: "D", severity: "info", message: "m", details: { visible: "kept", token: bytes() } },
    ]);
    expect(diagnosticOutput.exitCode).toBe(4);
    expect(parseOnlyDocument(diagnosticOutput)).toEqual({
      ok: true,
      data: "done",
      diagnostics: [{ code: "D", severity: "info", message: "m", details: { visible: "kept", token: "[REDACTED]" } }],
    });

    // Visible, the same bytes cannot fit the text budget and fail before their first byte is read.
    const visible = finishWith(2_000, { ok: true, data: { visible: "kept", bytes: bytes() }, exitCode: 3 });
    expect(visible.out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
  });

  it("never runs the built-in Buffer toJSON on a receiver whose length it cannot bound", () => {
    let lengthReads = 0;
    const countedLength = {
      get: () => {
        lengthReads += 1;
        return 2 ** 26;
      },
    };
    // Buffer.prototype.toJSON reads `this.length`; each of these would hand it a length other than the internal one.
    const receivers = () => [
      Object.defineProperty(Buffer.alloc(1), "length", countedLength),
      Object.defineProperty(Buffer.alloc(1), "length", { value: 2 ** 26 }),
      new Proxy(Buffer.alloc(1), {}),
      Object.defineProperty({ toJSON: Buffer.prototype.toJSON }, "length", countedLength),
    ];
    for (const receiver of receivers()) {
      for (const data of [{ bytes: receiver }, { visible: "kept", token: receiver }]) {
        const result = finishWith(2_000, { ok: true, data, exitCode: 3 });
        expect(result.exitCode).toBe(1);
        expect(result.out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
      }
    }
    for (const receiver of receivers()) {
      const details = finishWith(2_000, {
        ok: false,
        error: Object.assign(new Error("closed"), {
          code: "CLOSED",
          exitCode: 7,
          details: { visible: "kept", token: receiver },
        }),
      });
      expect(details.exitCode).toBe(7);
      expect(parseOnlyDocument(details)).toEqual({ ok: false, error: { code: "CLOSED", message: "closed" } });
    }
    expect(lengthReads).toBe(0);
  });
});

describe("document sensitive-key matching", () => {
  it("never matches the key of a member JSON drops, or of one whose key does not fit", () => {
    const isSensitive = vi.fn((key: string) => key === "token");
    const long = "x".repeat(5_000);
    const shared = { [long]: undefined, fn: () => 1, token: "dummy", kept: 1 };
    const text = serializeJsonMember("data", [shared, shared], { isSensitive });
    expect(String(text)).toBe('[{"token":"[REDACTED]","kept":1},{"token":"[REDACTED]","kept":1}]');
    expect(isSensitive.mock.calls.map(([key]) => key)).toEqual(["token", "kept", "token", "kept"]);

    isSensitive.mockClear();
    expect(() =>
      serializeJsonMember("data", { [long]: 1 }, { budget: createDocumentBudget(100), isSensitive })
    ).toThrow(RangeError);
    expect(isSensitive).not.toHaveBeenCalled();
  });

  it("charges each dropped member one unit of work, so dropped keys stay bounded", () => {
    const shared = { ["x".repeat(5_000)]: undefined };
    const rows = Array.from({ length: 2_000 }, () => shared);
    // Each row prints "{}" and costs one unit for its dropped member: 2,000 units of a 20,000 allowance.
    const fits = finishWith(10_000, { ok: true, data: rows, exitCode: 2 });
    expect(fits.exitCode).toBe(2);
    expect(fits.out).toBe(`${JSON.stringify({ ok: true, data: rows })}\n`);
    // 1,000 rows of 25 dropped members print 3,001 characters but cost 25,000 units, past the allowance.
    const dropped = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`k${index}`, undefined]));
    const many = Array.from({ length: 1_000 }, () => dropped);
    expect(finishWith(10_000, { ok: true, data: many, exitCode: 2 }).out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
  });
});

describe("document keys JSON skips", () => {
  it("lists keys as JSON.stringify does and charges each symbol or non-enumerable key one unit of work", () => {
    const record: Record<string | symbol, unknown> = { b: 2 };
    Object.defineProperty(record, "hidden", { value: "not printed", enumerable: false });
    record[Symbol("s")] = "not printed";
    record.a = 1;
    const reads: string[] = [];
    const proxied = new Proxy(record, {
      ownKeys: (target) => (reads.push("ownKeys"), Reflect.ownKeys(target)),
      getOwnPropertyDescriptor: (target, key) => (reads.push(`describe ${String(key)}`), Reflect.getOwnPropertyDescriptor(target, key)),
      get: (target, key) => (reads.push(`get ${String(key)}`), Reflect.get(target, key)),
    });
    const native = JSON.stringify({ record, proxied });
    const nativeReads = [...reads];
    reads.length = 0;
    const work = createWorkBudget(100);
    expect(String(serializeJsonMember("data", { record, proxied }, { work }))).toBe(native);
    expect(reads).toEqual(nativeReads);
    // Two skipped keys in each of the two objects.
    expect(work.unitsLeft).toBe(196);
  });

  it("fails an object referenced many times whose hidden keys outrun the work allowance", () => {
    const hidden: object = {};
    for (let index = 0; index < 5_000; index += 1) {
      Object.defineProperty(hidden, `h${index}`, { value: index, enumerable: false });
    }
    // Each reference prints "{}" but sweeps 5,000 keys JSON skips: the fourth sweep is past the 20,000-unit allowance.
    const few = finishWith(10_000, { ok: true, data: [hidden, hidden, hidden], exitCode: 2 });
    expect(few.exitCode).toBe(2);
    expect(parseOnlyDocument(few)).toEqual({ ok: true, data: [{}, {}, {}] });
    const many = finishWith(10_000, { ok: true, data: Array.from({ length: 100 }, () => hidden), exitCode: 2 });
    expect(many.exitCode).toBe(1);
    expect(many.out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
  });
});

describe("document key lists open on the path", () => {
  /**
   * Nested proxies that return one shared list of `count` keys at every level, as constant memory of their own; only
   * k0 holds a value (the next level, or "end" at `depth`), so every other member is dropped and prints nothing.
   */
  function sharedKeyLevels(count: number, depth: number) {
    const keys = Array.from({ length: count }, (_, index) => `k${index}`);
    const counter = { ownKeys: 0 };
    const level = (index: number): object =>
      new Proxy({}, {
        ownKeys: () => (counter.ownKeys += 1, keys),
        getOwnPropertyDescriptor: () => ({ value: undefined, enumerable: true, configurable: true, writable: true }),
        get: (_target, key) => (key === "k0" ? (index === depth ? "end" : level(index + 1)) : undefined),
      });
    return { counter, level };
  }

  it("prints nested objects whose open key lists fit together, as JSON.stringify does", () => {
    // Three levels of 1,000 keys: 3,002 open keys at the deepest, within a quarter of the 20,000-character text.
    const { counter, level } = sharedKeyLevels(1_000, 2);
    const native = JSON.stringify({ ok: true, data: { visible: "kept", nested: level(0) } });
    counter.ownKeys = 0;
    const result = finishWith(20_000, { ok: true, data: { visible: "kept", nested: level(0) }, exitCode: 3 });
    expect(result.exitCode).toBe(3);
    expect(result.out).toBe(`${native}\n`);
    expect(counter.ownKeys).toBe(3);
  });

  it("fails before listing a nested object once the lists open above it pass the bound, in data, details and diagnostics", () => {
    // 10,000 characters: the lists open on the path may hold about 2,500 keys, so the fourth level is never listed.
    // Each level drops 999 members (999 units of a 20,000-unit allowance), so only the open lists stop it this early.
    const { counter, level } = sharedKeyLevels(1_000, 1_000);
    const data = finishWith(10_000, { ok: true, data: { visible: "kept", nested: level(0) }, exitCode: 3 });
    expect(data.exitCode).toBe(1);
    expect(data.out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
    expect(counter.ownKeys).toBe(3);

    counter.ownKeys = 0;
    const details = finishWith(10_000, {
      ok: false,
      error: Object.assign(new Error("closed"), { code: "CLOSED", exitCode: 7, details: { visible: "kept", nested: level(0) } }),
    });
    expect(details.exitCode).toBe(7);
    expect(parseOnlyDocument(details)).toEqual({ ok: false, error: { code: "CLOSED", message: "closed" } });
    expect(counter.ownKeys).toBeLessThanOrEqual(3);

    counter.ownKeys = 0;
    const diagnostics = finishWith(10_000, { ok: true, data: "done", exitCode: 3 }, [
      { code: "DEEP", severity: "info", message: "m", details: { nested: level(0) } },
      { code: "KEPT", severity: "info", message: "m" },
    ]);
    expect(diagnostics.exitCode).toBe(3);
    expect(parseOnlyDocument(diagnostics)).toEqual({
      ok: true,
      data: "done",
      // Details that do not fit are left out; the diagnostic itself is kept.
      diagnostics: [
        { code: "DEEP", severity: "info", message: "m" },
        { code: "KEPT", severity: "info", message: "m" },
      ],
    });
    expect(counter.ownKeys).toBeLessThanOrEqual(3);
  });
});

describe("document work allowance next to printed text", () => {
  const keyed = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, index]));

  it("prints a document that fits next to a redacted walk within its own allowance", () => {
    const visible = "v".repeat(8_000);
    // The text is 8,058 characters of a 10,000 limit; the redacted object is 1 + 19,000 units of a 20,000 allowance.
    const fits = finishWith(10_000, { ok: true, data: { password: keyed(19_000), visible }, exitCode: 3 });
    expect(fits.exitCode).toBe(3);
    expect(parseOnlyDocument(fits)).toEqual({ ok: true, data: { password: "[REDACTED]", visible } });

    const over = finishWith(10_000, { ok: true, data: { password: keyed(20_000), visible }, exitCode: 3 });
    expect(over.exitCode).toBe(1);
    expect(over.out).toBe(`${JSON.stringify(FAILURE_DOCUMENT)}\n`);
  });

  it("keeps a mapped failure next to large redacted details within the allowance", () => {
    const details = { visible: "d".repeat(7_000), secret: keyed(19_000) };
    const result = finishWith(10_000, {
      ok: false,
      error: Object.assign(new Error("closed"), { code: "CLOSED", exitCode: 7, details }),
    });
    expect(result.exitCode).toBe(7);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "CLOSED", message: "closed", details: { visible: details.visible, secret: "[REDACTED]" } },
    });
  });
});

/**
 * Transpiles the package sources into a fresh directory and returns its runner module, so the child process runs the
 * current sources without a prior build.
 */
function transpiledRunner(): string {
  const sources = fileURLToPath(new URL("../src/", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "clifn-core-heap-"));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  for (const name of readdirSync(sources).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
    const { outputText } = ts.transpileModule(readFileSync(join(sources, name), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    writeFileSync(join(directory, name.replace(/\.ts$/, ".js")), outputText);
  }
  return join(directory, "runner.js");
}

describe("document memory in a constrained heap", () => {
  let runnerModule = "";

  beforeAll(() => {
    runnerModule = transpiledRunner();
  });

  afterAll(() => {
    if (runnerModule) {
      rmSync(dirname(runnerModule), { recursive: true, force: true });
    }
  });

  it("prints one bounded document for every case in a 32 MiB heap", () => {
    // Each case prints one line: its name, how many stdout writes it made, its exit code and its stdout.
    const script = String.raw`
      const { runAction } = await import(process.argv[1]);
      const run = async (name, action, extra = {}) => {
        const chunks = [];
        const exitCode = await runAction(action, {}, {
          mode: "json", jsonStyle: "document", color: false,
          stdout: (text) => chunks.push(text), stderr: () => {}, ...extra,
        });
        process.stdout.write(JSON.stringify({ name, writes: chunks.length, exitCode, out: chunks.join("").slice(0, 400) }) + "\n");
        // What runs next starts from what is still alive, not from garbage V8 has yet to collect from this case.
        await new Promise((resolve) => setImmediate(resolve));
        globalThis.gc();
      };
      // First, on a fresh heap: these need most of it. 16 MiB, built negative by one shift inside the action, so no
      // other large bigint (an intermediate power or a negated copy) is alive: a second copy would not fit this heap.
      await run("bigint-negative", () => ({ data: -1n << (2n ** 27n) }));
      {
        // Block-scoped, so its 16 MiB are released before the cases below; one shift, with no intermediate powers.
        const huge = 1n << (2n ** 27n);
        await run("bigint-redacted", () => ({ exitCode: 4, data: { visible: "kept", secret: huge } }));
        await run("bigint", () => ({ data: huge }));
      }
      let indexReads = 0;
      const countIndex = (key) => { if (typeof key === "string" && /^\d+$/.test(key)) indexReads += 1; };
      await run("sparse", () => ({ data: new Array(120e6) }));
      await run("proxy", () => ({
        data: new Proxy([], { get: (target, key) => (countIndex(key), key === "length" ? 2e8 : Reflect.get(target, key)) }),
      }));
      await run("index-reads", () => ({ data: indexReads }));
      const tree = (depth) => ({ toJSON: () => (depth === 0 ? "leaf" : Array.from({ length: 64 }, () => tree(depth - 1))) });
      await run("generated", () => ({ data: tree(5) }));
      // Ropes: cheap to hold, 256 MiB and 64 MiB of text when flattened, far past this heap.
      const rope = "x".repeat(2 ** 28);
      const escapes = "\0".repeat(2 ** 26);
      await run("redacted", () => ({
        exitCode: 3,
        data: { visible: "kept", password: rope, secret: escapes, rows: Array.from({ length: 512 }, (_, i) => ({ i, token: rope })) },
      }));
      await run("details", () => {
        throw Object.assign(new Error("closed"), { code: "CLOSED", exitCode: 7, details: { visible: "kept", apiKey: rope, note: escapes } });
      });
      await run("redacted-details", () => {
        throw Object.assign(new Error("closed"), { code: "CLOSED", exitCode: 7, details: { visible: "kept", apiKey: rope, password: escapes } });
      });
      await run("diagnostics", () => ({
        data: "done",
        diagnostics: [
          { code: "BIG", severity: "info", message: "m", details: { note: rope } },
          { code: "SMALL", severity: "info", message: "m", details: { token: rope, visible: "kept" } },
        ],
      }));
      await run("records", () => ({ data: Array.from({ length: 50_000 }, (_, id) => ({ id, name: "n" + id })) }));
      // 64 MiB outside the heap; listing its keys would create 2^26 strings.
      const bytes = new Uint8Array(2 ** 26);
      await run("typed", () => ({ data: bytes }));
      await run("typed-redacted", () => ({ exitCode: 3, data: { visible: "kept", secret: bytes } }));
      // The same 64 MiB as a Buffer, whose built-in toJSON would copy every byte into a 2^26-item array.
      const buffer = Buffer.from(bytes.buffer);
      await run("buffer", () => ({ exitCode: 3, data: buffer }));
      await run("buffer-redacted", () => ({ exitCode: 3, data: { visible: "kept", token: buffer } }));
      await run("buffer-details", () => {
        throw Object.assign(new Error("closed"), { code: "CLOSED", exitCode: 7, details: { visible: "kept", token: buffer } });
      });
      // Under a redacted ancestor, a Buffer the work allowance can walk (1.9 times the document limit): its built-in
      // toJSON would allocate an array of 8 or more bytes per byte, past this heap.
      const limit = Math.floor((await import("node:v8")).getHeapStatistics().heap_size_limit / 16);
      const walkable = Buffer.alloc(Math.floor(1.9 * limit));
      await run("buffer-nested-redacted", () => ({ exitCode: 3, data: { visible: "kept", token: { b: walkable } } }));
      // A one-byte Buffer whose own length tells the built-in toJSON to copy 2^26 items.
      const shadowed = () => Object.defineProperty(Buffer.alloc(1), "length", { value: 2 ** 26 });
      await run("buffer-shadowed", () => ({ exitCode: 3, data: { visible: "kept", bytes: shadowed() } }));
      await run("buffer-shadowed-redacted", () => ({ exitCode: 3, data: { visible: "kept", token: shadowed() } }));
      await run("diagnostics-sparse", () => ({ data: "done", diagnostics: new Array(120e6) }));
      let diagnosticReads = 0;
      const many = new Proxy([], {
        get: (target, key) => {
          if (key === "length") return 2e8;
          if (typeof key === "string" && /^\d+$/.test(key)) {
            diagnosticReads += 1;
            return { code: "D", severity: "info", message: "m" };
          }
          return Reflect.get(target, key);
        },
      });
      await run("diagnostics-proxy", () => ({ exitCode: 2, data: "done", diagnostics: many }));
      await run("diagnostic-reads", () => ({ data: diagnosticReads < 2e6 }));
      // Thrown messages far larger than this heap, which a code-pattern scan would flatten.
      await run("message", () => {
        throw { message: rope, exitCode: 7 };
      });
      await run("message-coded", () => {
        throw { code: "BIG", message: rope, exitCode: 7 };
      });
      await run("message-code-like", () => {
        throw { message: "CLIFN_" + "X".repeat(2 ** 28), exitCode: 7 };
      });
      // Fresh diagnostics, each holding new text or details, that the runner would retain if it kept them as given:
      // an endless generator, a 2e8-item proxy and the action's own sink, with and without a listener that lists them.
      const fresh = (index) => ({ code: "D", severity: "info", message: index + ":" + "x".repeat(4096) });
      const endless = function* (make) { for (let index = 0; ; index += 1) yield make(index); };
      const freshProxy = (make) => new Proxy([], {
        get: (target, key) => key === "length" ? 2e8 : typeof key === "string" && /^\d+$/.test(key) ? make(Number(key)) : Reflect.get(target, key),
      });
      let listed = 0;
      const listener = { onDiagnostics: (list) => { listed = list.length; } };
      await run("densify", () => ({ data: "done", exitCode: 2, diagnostics: endless(fresh) }));
      await run("densify-listed", () => ({ data: "done", exitCode: 2, diagnostics: endless(fresh) }), listener);
      await run("densify-listed-count", () => ({ data: listed > 0 }));
      await run("densify-proxy", () => ({ data: "done", exitCode: 2, diagnostics: freshProxy(fresh) }), listener);
      await run("densify-sink", (_options, ctx) => {
        for (let index = 0; index < 200_000; index += 1) ctx.diagnostics.add(fresh(index));
        return { data: "done", exitCode: 2 };
      }, listener);
      const freshDetails = (index) => ({ code: "D", severity: "info", message: "m", details: { note: index + "x".repeat(4096), token: "t".repeat(65536) + index } });
      await run("densify-details", () => ({ data: "done", exitCode: 2, diagnostics: endless(freshDetails) }), listener);
      // Details whose text is mostly nodes: each "{}" parses to a whole object in a listed copy.
      const nodes = Array.from({ length: 4096 }, () => ({}));
      await run("densify-nodes", () => ({ data: "done", exitCode: 2, diagnostics: endless(() => ({ code: "N", severity: "info", message: "m", details: { nodes } })) }), listener);
      // A diagnostic whose getter adds a large one while it is being read, 2,000 times, with a listener.
      await run("reentrant", (_options, ctx) => {
        const inner = "i".repeat(65536);
        for (let index = 0; index < 2000; index += 1) {
          let added = false;
          ctx.diagnostics.add({ code: "O", severity: "info", get message() {
            if (!added) { added = true; ctx.diagnostics.add({ code: "I", severity: "info", message: index + inner }); }
            return "o";
          } });
        }
        return { data: "done", exitCode: 2 };
      }, listener);
      // Proxies returning one shared list of 100,000 keys at every level: no level holds the list itself.
      const sharedKeys = Array.from({ length: 100_000 }, (_, index) => "k" + index);
      const sharedLevel = () => new Proxy({}, {
        ownKeys: () => sharedKeys,
        getOwnPropertyDescriptor: () => ({ value: 1, enumerable: true, configurable: true, writable: true }),
        get: (_target, key) => (key === "k0" ? sharedLevel() : 1),
      });
      await run("open-keys", () => ({ exitCode: 3, data: { visible: "kept", nested: sharedLevel() } }));
      await run("open-keys-details", () => {
        throw Object.assign(new Error("closed"), { code: "CLOSED", exitCode: 7, details: { visible: "kept", nested: sharedLevel() } });
      });
    `;
    const runnerUrl = pathToFileURL(runnerModule).href;
    const child = spawnSync(process.execPath, ["--max-old-space-size=32", "--expose-gc", "--input-type=module", "-e", script, runnerUrl], {
      encoding: "utf8",
      maxBuffer: 16 * 2 ** 20,
      timeout: 120_000,
    });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    const cases = Object.fromEntries(
      child.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { name: string; writes: number; exitCode: number; out: string })
        .map((entry) => [entry.name, entry])
    );
    const failure = `${JSON.stringify(FAILURE_DOCUMENT)}\n`;
    for (const name of ["sparse", "proxy", "generated"]) {
      expect(cases[name]).toEqual({ name, writes: 1, exitCode: 1, out: failure });
    }
    // The oversized proxy array failed before its first index was read.
    expect(cases["index-reads"].out).toBe('{"ok":true,"data":0}\n');
    expect(cases.redacted.exitCode).toBe(3);
    expect(cases.redacted.out.startsWith(
      '{"ok":true,"data":{"visible":"kept","password":"[REDACTED]","secret":"[REDACTED]","rows":[{"i":0,"token":"[REDACTED]"},'
    )).toBe(true);
    expect(cases.details).toMatchObject({ writes: 1, exitCode: 7, out: '{"ok":false,"error":{"code":"CLOSED","message":"closed"}}\n' });
    expect(cases["redacted-details"]).toMatchObject({
      writes: 1,
      exitCode: 7,
      out: '{"ok":false,"error":{"code":"CLOSED","message":"closed","details":{"visible":"kept","apiKey":"[REDACTED]","password":"[REDACTED]"}}}\n',
    });
    expect(cases.diagnostics).toMatchObject({
      writes: 1,
      exitCode: 0,
      out:
        '{"ok":true,"data":"done","diagnostics":[{"code":"BIG","severity":"info","message":"m"},' +
        '{"code":"SMALL","severity":"info","message":"m","details":{"token":"[REDACTED]","visible":"kept"}}]}\n',
    });
    expect(cases.records).toMatchObject({ writes: 1, exitCode: 0 });
    expect(cases.records.out.startsWith('{"ok":true,"data":[{"id":0,"name":"n0"},')).toBe(true);
    for (const name of ["densify", "densify-listed", "densify-proxy", "densify-sink"]) {
      expect(cases[name]).toMatchObject({ writes: 1, exitCode: 2 });
      expect(cases[name].out.startsWith('{"ok":true,"data":"done","diagnostics":[{"code":"D","severity":"info","message":"0:xxx')).toBe(true);
    }
    expect(cases["densify-listed-count"].out).toBe('{"ok":true,"data":true}\n');
    expect(cases["densify-details"]).toMatchObject({ writes: 1, exitCode: 2 });
    expect(cases["densify-details"].out.startsWith(
      '{"ok":true,"data":"done","diagnostics":[{"code":"D","severity":"info","message":"m","details":{"note":"0xxx'
    )).toBe(true);
    expect(cases["densify-nodes"]).toMatchObject({ writes: 1, exitCode: 2 });
    expect(cases["densify-nodes"].out.startsWith(
      '{"ok":true,"data":"done","diagnostics":[{"code":"N","severity":"info","message":"m","details":{"nodes":[{},'
    )).toBe(true);
    expect(cases.reentrant).toMatchObject({ writes: 1, exitCode: 2 });
    expect(cases.reentrant.out.startsWith('{"ok":true,"data":"done","diagnostics":[{"code":"O","severity":"info","message":"o"}')).toBe(true);
    expect(cases["open-keys"]).toEqual({ name: "open-keys", writes: 1, exitCode: 1, out: failure });
    expect(cases["open-keys-details"]).toMatchObject({
      writes: 1,
      exitCode: 7,
      out: '{"ok":false,"error":{"code":"CLOSED","message":"closed"}}\n',
    });
    for (const name of ["typed", "bigint"]) {
      expect(cases[name]).toEqual({ name, writes: 1, exitCode: 1, out: failure });
    }
    expect(cases["typed-redacted"]).toEqual({ name: "typed-redacted", writes: 1, exitCode: 1, out: failure });
    for (const name of ["buffer", "buffer-redacted"]) {
      expect(cases[name]).toEqual({ name, writes: 1, exitCode: 1, out: failure });
    }
    expect(cases["buffer-details"]).toMatchObject({
      writes: 1,
      exitCode: 7,
      out: '{"ok":false,"error":{"code":"CLOSED","message":"closed"}}\n',
    });
    expect(cases["buffer-nested-redacted"]).toMatchObject({
      writes: 1,
      exitCode: 3,
      out: '{"ok":true,"data":{"visible":"kept","token":"[REDACTED]"}}\n',
    });
    for (const name of ["buffer-shadowed", "buffer-shadowed-redacted"]) {
      expect(cases[name]).toEqual({ name, writes: 1, exitCode: 1, out: failure });
    }
    expect(cases["bigint-redacted"]).toMatchObject({
      writes: 1,
      exitCode: 4,
      out: '{"ok":true,"data":{"visible":"kept","secret":"[REDACTED]"}}\n',
    });
    // Holes are dropped with bounded warnings; the result is kept.
    expect(cases["diagnostics-sparse"]).toMatchObject({ writes: 1, exitCode: 0, out: '{"ok":true,"data":"done"}\n' });
    expect(cases["diagnostics-proxy"]).toMatchObject({ writes: 1, exitCode: 2 });
    expect(cases["diagnostics-proxy"].out.startsWith('{"ok":true,"data":"done","diagnostics":[{"code":"D"')).toBe(true);
    expect(cases["diagnostic-reads"].out).toBe('{"ok":true,"data":true}\n');
    expect(cases["bigint-negative"]).toEqual({ name: "bigint-negative", writes: 1, exitCode: 1, out: failure });
    const tooLong = (code: string) => ({
      writes: 1,
      exitCode: 7,
      out: `{"ok":false,"error":{"code":"${code}","message":"The error message was too long to print."}}\n`,
    });
    expect(cases.message).toMatchObject(tooLong("CLIFN_RUNNER_FAILED"));
    expect(cases["message-coded"]).toMatchObject(tooLong("BIG"));
    expect(cases["message-code-like"]).toMatchObject(tooLong("CLIFN_RUNNER_FAILED"));
  }, 150_000);
});
