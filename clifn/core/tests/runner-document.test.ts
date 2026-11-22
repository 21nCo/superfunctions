import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createCredentialStore, MissingProfileError } from "../src/credentials.js";
import { runAction, type RunnerActionResult, type RunnerContext, type RunnerOptions } from "../src/runner.js";

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
  const out = stdout.join("");
  return { exitCode, out, writes: stdout.length, stderr: stderr.join("") };
}

/** Parses stdout as exactly one JSON document followed by one newline, written in a single call. */
function parseOnlyDocument(result: { out: string; writes: number }): Record<string, unknown> {
  expect(result.writes).toBe(1);
  expect(result.out.endsWith("\n")).toBe(true);
  expect(result.out.indexOf("\n")).toBe(result.out.length - 1);
  return JSON.parse(result.out) as Record<string, unknown>;
}

function stderrLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runAction with jsonStyle 'document'", () => {
  it("prints the returned data as the one success document", async () => {
    const result = await runDocument(async (_options, ctx) => {
      ctx.output.info("working");
      return { data: { id: 7, big: 2n } };
    });

    expect(result.exitCode).toBe(0);
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: { id: 7, big: "2" } });
    expect(stderrLines(result.stderr)).toEqual([{ level: "info", message: "working" }]);
  });

  it("uses the last json() value as data when the action returns none, without printing it", async () => {
    const result = await runDocument(async (_options, ctx) => {
      ctx.output.json({ draft: true });
      ctx.output.json({ final: true });
    });

    expect(result.exitCode).toBe(0);
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: { final: true } });
    expect(stderrLines(result.stderr)).toEqual([
      {
        level: "warn",
        message: "output.json() was not printed: document mode prints one result document; return the value as data",
      },
    ]);
  });

  it("collects table() and json() calls and warns on stderr when the action returns data", async () => {
    const result = await runDocument(async (_options, ctx) => {
      ctx.output.table({ columns: ["id"], rows: [{ id: 1 }] });
      ctx.output.json({ ignored: true });
      return { data: "result" };
    });

    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "result" });
    expect(stderrLines(result.stderr).map((line) => [line.level, String(line.message).split(" ")[0]])).toEqual([
      ["warn", "output.table()"],
      ["warn", "output.json()"],
    ]);
  });

  it("prints data null when the action returns no data and makes no json() call", async () => {
    const result = await runDocument(async () => undefined);

    expect(result.exitCode).toBe(0);
    expect(result.out).toBe('{"ok":true,"data":null}\n');
    expect(result.stderr).toBe("");
  });

  it("keeps the returned exit code of a successful action", async () => {
    const result = await runDocument(async () => ({ exitCode: 2, data: [] }));

    expect(result.exitCode).toBe(2);
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: [] });
  });

  it("maps a plain thrown Error to CLIFN_RUNNER_FAILED with exit code 1", async () => {
    const result = await runDocument(async (_options, ctx) => {
      ctx.output.json({ partial: true });
      throw new Error("boom");
    });

    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "CLIFN_RUNNER_FAILED", message: "boom" } });
    expect(stderrLines(result.stderr)).toEqual([expect.objectContaining({ level: "warn" })]);
  });

  it.each([
    ["a non-Error string", "plain failure", { code: "CLIFN_RUNNER_FAILED", message: "plain failure" }],
    ["undefined", undefined, { code: "CLIFN_RUNNER_FAILED", message: "Unknown runner failure" }],
    ["an Error without a message", new TypeError(), { code: "CLIFN_RUNNER_FAILED", message: "TypeError" }],
    ["a lowercase code", Object.assign(new Error("m"), { code: "bad_code" }), { code: "CLIFN_RUNNER_FAILED", message: "m" }],
    ["a one-letter code", Object.assign(new Error("m"), { code: "A" }), { code: "CLIFN_RUNNER_FAILED", message: "m" }],
    ["a 65-character code", Object.assign(new Error("m"), { code: `A${"B".repeat(64)}` }), { code: "CLIFN_RUNNER_FAILED", message: "m" }],
    ["a numeric code", Object.assign(new Error("m"), { code: 42 }), { code: "CLIFN_RUNNER_FAILED", message: "m" }],
    ["a CLIFN_ message with trailing text", new Error("CLIFN_X failed"), { code: "CLIFN_RUNNER_FAILED", message: "CLIFN_X failed" }],
    ["an unlisted CLIFN_ message", new Error("CLIFN_SOMETHING_NEW"), { code: "CLIFN_SOMETHING_NEW", message: "The operation failed." }],
  ])("maps %s", async (_label, thrown, error) => {
    const result = await runDocument(async () => {
      throw thrown;
    });

    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error });
  });

  it("uses a string code that matches the code pattern, ahead of a CLIFN_ message", async () => {
    const result = await runDocument(async () => {
      throw Object.assign(new Error("CLIFN_CREDENTIAL_STORE_BUSY"), { code: "DEPLOY_REJECTED" });
    });

    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "DEPLOY_REJECTED", message: "CLIFN_CREDENTIAL_STORE_BUSY" },
    });
  });

  it.each([
    [3, 3],
    [125, 125],
    [300, 1],
    [126, 1],
    [0, 1],
    [-2, 1],
    [2.5, 1],
    ["3", 1],
  ])("uses exitCode %j as exit code %i", async (exitCode, expected) => {
    const result = await runDocument(async () => {
      throw Object.assign(new Error("failed"), { code: "TASK_FAILED", exitCode });
    });

    expect(result.exitCode).toBe(expected);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "TASK_FAILED", message: "failed" } });
  });

  it("includes plain-object details, redacted, and drops any other details", async () => {
    const withDetails = await runDocument(async () => {
      throw Object.assign(new Error("rejected"), {
        code: "REQUEST_REJECTED",
        details: { status: 403, token: "test-token-value", nested: { password: "test-password" } },
      });
    });
    expect(parseOnlyDocument(withDetails)).toEqual({
      ok: false,
      error: {
        code: "REQUEST_REJECTED",
        message: "rejected",
        details: { status: 403, token: "[REDACTED]", nested: { password: "[REDACTED]" } },
      },
    });

    for (const details of [["array"], "text", new Map([["a", 1]]), new (class Details { a = 1; })()]) {
      const result = await runDocument(async () => {
        throw Object.assign(new Error("rejected"), { code: "REQUEST_REJECTED", details });
      });
      expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "REQUEST_REJECTED", message: "rejected" } });
    }
  });

  it("maps a MissingProfileError from the credential store to CLIFN_MISSING_PROFILE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clifn-doc-"));
    try {
      const store = createCredentialStore(join(dir, "credentials"));
      const result = await runDocument(async () => {
        store.getProfile("absent");
      });

      expect(result.exitCode).toBe(1);
      const document = parseOnlyDocument(result) as { ok: boolean; error: { code: string; message: string } };
      expect(document.ok).toBe(false);
      expect(document.error.code).toBe("CLIFN_MISSING_PROFILE");
      expect(document.error.message).toContain('Profile "absent" was not found');
      expect(new MissingProfileError("a", "b").code).toBe("CLIFN_MISSING_PROFILE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps a busy credential store to CLIFN_CREDENTIAL_STORE_BUSY with its fixed description", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clifn-doc-"));
    try {
      const path = join(dir, "credentials");
      const store = createCredentialStore(path);
      writeFileSync(`${path}.lock`, "other-writer");
      const result = await runDocument(async () => {
        store.setProfile("one", { backend: "https://example.test", key: "test-key" });
      });

      expect(result.exitCode).toBe(1);
      expect(parseOnlyDocument(result)).toEqual({
        ok: false,
        error: {
          code: "CLIFN_CREDENTIAL_STORE_BUSY",
          message: "The credential store is locked by another writer; try again when it has finished.",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a thrown value whose properties throw as CLIFN_RUNNER_FAILED", async () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      }
    );
    const result = await runDocument(async () => {
      throw hostile;
    });

    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "CLIFN_RUNNER_FAILED", message: "Unknown runner failure" },
    });
  });

  it("adds redacted diagnostics on success and failure, and omits them when there are none", async () => {
    const diagnostic = {
      code: "AUTH",
      severity: "warning" as const,
      message: "token used",
      details: { apiKey: "test-api-key", region: "eu" },
    };
    const seen: unknown[] = [];

    const success = await runDocument(
      async (_options, ctx) => {
        ctx.diagnostics.add(diagnostic);
        return { data: 1, diagnostics: [{ code: "MORE", severity: "info", message: "more" }] };
      },
      { onDiagnostics: (list) => seen.push(list.map((entry) => entry.details)) }
    );
    expect(parseOnlyDocument(success)).toEqual({
      ok: true,
      data: 1,
      diagnostics: [
        { code: "AUTH", severity: "warning", message: "token used", details: { apiKey: "[REDACTED]", region: "eu" } },
        { code: "MORE", severity: "info", message: "more" },
      ],
    });
    // The listener still receives the diagnostics as the action recorded them.
    expect(seen).toEqual([[{ apiKey: "test-api-key", region: "eu" }, undefined]]);

    const failure = await runDocument(async (_options, ctx) => {
      ctx.diagnostics.add(diagnostic);
      throw new Error("failed");
    });
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "CLIFN_RUNNER_FAILED", message: "failed" },
      diagnostics: [
        { code: "AUTH", severity: "warning", message: "token used", details: { apiKey: "[REDACTED]", region: "eu" } },
      ],
    });
  });

  it("still prints one failure document when the diagnostics listener throws", async () => {
    const result = await runDocument(
      async () => {
        throw new Error("action failed");
      },
      {
        onDiagnostics: () => {
          throw new Error("listener failed");
        },
      }
    );

    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "CLIFN_RUNNER_FAILED", message: "action failed" },
    });
  });

  it("prints a failure document when the data cannot be serialized", async () => {
    const result = await runDocument(async () => ({
      data: {
        toJSON() {
          throw new Error("no");
        },
      },
    }));

    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "CLIFN_RUNNER_FAILED", message: "Unable to serialize the result document" },
    });
  });

  it.each([
    ["a json(undefined) call", (ctx: RunnerContext) => ctx.output.json(undefined), undefined],
    ["function data", undefined, () => 1],
    ["symbol data", undefined, Symbol("data")],
    ["data whose toJSON returns undefined", undefined, { toJSON: () => undefined }],
  ])("keeps the data member as null for %s", async (_name, call, data) => {
    const result = await runDocument(async (_options, ctx) => {
      call?.(ctx);
      return data === undefined ? undefined : { data };
    });

    expect(result.exitCode).toBe(0);
    const document = parseOnlyDocument(result);
    expect(Object.hasOwn(document, "data")).toBe(true);
    expect(document).toEqual({ ok: true, data: null });
  });

  it("drops a diagnostic that cannot be redacted and still prints the one document", async () => {
    const result = await runDocument(async (_options, ctx) => {
      ctx.diagnostics.add(null as never);
      ctx.diagnostics.add({
        code: "THROWING_DETAILS",
        severity: "warning",
        message: "details getter throws",
        details: {
          get value() {
            throw new Error("getter failed");
          },
        },
      });
      ctx.diagnostics.add({ code: "KEPT", severity: "info", message: "kept" });
      return { data: { done: true } };
    });

    expect(result.exitCode).toBe(0);
    const document = parseOnlyDocument(result);
    expect(document.ok).toBe(true);
    expect(document.data).toEqual({ done: true });
    expect((document.diagnostics as Array<{ code: string }>).map((entry) => entry.code)).toEqual(["KEPT"]);
    const warnings = stderrLines(result.stderr).filter((line) => line.level === "warn");
    expect(warnings).toHaveLength(2);
  });
});

describe("document mode resolves each member to JSON once", () => {
  const leakingDetails = () => ({
    status: "visible",
    toJSON: () => ({ status: "visible", password: "test-password", nested: { token: "test-token-value" } }),
  });
  const redactedDetails = { status: "visible", password: "[REDACTED]", nested: { token: "[REDACTED]" } };

  it("redacts error details after their toJSON runs", async () => {
    const result = await runDocument(async () => {
      throw Object.assign(new Error("rejected"), { code: "REQUEST_REJECTED", details: leakingDetails() });
    });

    expect(result.out).not.toContain("test-password");
    expect(result.out).not.toContain("test-token-value");
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "REQUEST_REJECTED", message: "rejected", details: redactedDetails },
    });
  });

  it("redacts added and returned diagnostics after their toJSON runs, including nested ones", async () => {
    const result = await runDocument(async (_options, ctx) => {
      ctx.diagnostics.add({ code: "ADDED", severity: "info", message: "added", details: leakingDetails() });
      return {
        data: null,
        diagnostics: [
          {
            code: "RETURNED",
            severity: "warning",
            message: "returned",
            details: { outer: { toJSON: () => ({ apiKey: "test-api-key", kept: 1 }) } },
          },
        ],
      };
    });

    expect(result.out).not.toContain("test-password");
    expect(result.out).not.toContain("test-api-key");
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: null,
      diagnostics: [
        { code: "ADDED", severity: "info", message: "added", details: redactedDetails },
        {
          code: "RETURNED",
          severity: "warning",
          message: "returned",
          details: { outer: { apiKey: "[REDACTED]", kept: 1 } },
        },
      ],
    });
  });

  it.each([
    [
      "throws in a getter inside the details",
      () => ({
        get value() {
          throw new Error("getter failed");
        },
      }),
    ],
    [
      "throws in its toJSON",
      () => ({
        toJSON() {
          throw new Error("toJSON failed");
        },
      }),
    ],
    ["resolves to a non-object", () => ({ toJSON: () => "text" })],
  ])("keeps the code, message and exit code and omits details that %s", async (_label, makeDetails) => {
    const result = await runDocument(async () => {
      throw Object.assign(new Error("conflict"), { code: "CONFLICT", exitCode: 12, details: makeDetails() });
    });

    expect(result.exitCode).toBe(12);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "CONFLICT", message: "conflict" } });
  });

  it("keeps the code and exit code when reading the details property throws", async () => {
    const thrown = Object.assign(new Error("conflict"), { code: "CONFLICT", exitCode: 12 });
    Object.defineProperty(thrown, "details", {
      get() {
        throw new Error("unreadable");
      },
    });
    const result = await runDocument(async () => {
      throw thrown;
    });

    expect(result.exitCode).toBe(12);
    expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "CONFLICT", message: "conflict" } });
  });

  it.each([
    ["an Error whose name is undefined", Object.assign(new Error(), { code: "TASK_FAILED", name: undefined })],
    ["an Error whose name is empty", Object.assign(new Error(), { code: "TASK_FAILED", name: "" })],
  ])("prints a non-empty message for %s", async (_label, thrown) => {
    const result = await runDocument(async () => {
      throw thrown;
    });

    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "TASK_FAILED", message: "Unknown runner failure" },
    });
  });

  // toJSON(key) returns a value at the top level and undefined for the member key "data".
  const keyedToJson = (key: string) => (key === "data" ? undefined : { leaked: true });
  const keyedFunction = () => Object.assign(() => 1, { toJSON: keyedToJson });
  class KeyedArray extends Array<number> {
    toJSON(key: string) {
      return keyedToJson(key);
    }
  }

  it.each([
    ["returned function data", undefined, keyedFunction],
    ["a json() fallback", (ctx: RunnerContext) => ctx.output.json(keyedFunction()), undefined],
    ["returned array-subclass data", undefined, () => KeyedArray.from([1, 2])],
  ])("keeps the data member as null when toJSON drops it for the key data: %s", async (_label, call, makeData) => {
    const result = await runDocument(async (_options, ctx) => {
      call?.(ctx);
      return makeData === undefined ? undefined : { data: makeData() };
    });

    expect(result.exitCode).toBe(0);
    const document = parseOnlyDocument(result);
    expect(Object.hasOwn(document, "data")).toBe(true);
    expect(document).toEqual({ ok: true, data: null });
  });

  // A class whose prototype serializer leaves out a private field and emits a sensitive key.
  class Account {
    user = "ada";
    privateNote = "internal-only-note";
    toJSON() {
      return { user: this.user, password: "test-password" };
    }
  }
  const classDetails = () => ({ when: new Date(0), account: new Account() });
  const classDetailsPrinted = {
    when: "1970-01-01T00:00:00.000Z",
    account: { user: "ada", password: "[REDACTED]" },
  };

  it.each([
    [
      "added on success",
      (ctx: RunnerContext): RunnerActionResult => {
        ctx.diagnostics.add({ code: "D", severity: "warning", message: "m", details: classDetails() });
        return { data: 1 };
      },
      { ok: true, data: 1 },
      0,
    ],
    [
      "returned on success",
      (): RunnerActionResult => ({
        data: 1,
        diagnostics: [{ code: "D", severity: "warning", message: "m", details: classDetails() }],
      }),
      { ok: true, data: 1 },
      0,
    ],
    [
      "added on failure",
      (ctx: RunnerContext): RunnerActionResult => {
        ctx.diagnostics.add({ code: "D", severity: "warning", message: "m", details: classDetails() });
        throw Object.assign(new Error("failed"), { code: "TASK_FAILED", exitCode: 4 });
      },
      { ok: false, error: { code: "TASK_FAILED", message: "failed" } },
      4,
    ],
  ])("serializes diagnostic details through their own toJSON, then redacts them: %s", async (_label, act, base, exit) => {
    const result = await runDocument(async (_options, ctx) => act(ctx));

    expect(result.exitCode).toBe(exit);
    expect(result.out).not.toContain("internal-only-note");
    expect(result.out).not.toContain("test-password");
    expect(parseOnlyDocument(result)).toEqual({
      ...base,
      diagnostics: [{ code: "D", severity: "warning", message: "m", details: classDetailsPrinted }],
    });
  });

  // An ordinary object serializer that answers only for one key, and ones that echo the key they receive.
  const onlyFor = (wanted: string) => ({ toJSON: (key: string) => (key === wanted ? { keyed: wanted } : undefined) });
  const echoKey = () => ({ toJSON: (key: string) => `key:${key}` });

  it("passes the member key data to an ordinary object's toJSON, returned or from json()", async () => {
    const returned = await runDocument(async () => ({ data: onlyFor("data") }));
    expect(parseOnlyDocument(returned)).toEqual({ ok: true, data: { keyed: "data" } });

    const fallback = await runDocument(async (_options, ctx) => {
      ctx.output.json(onlyFor("data"));
    });
    expect(parseOnlyDocument(fallback)).toEqual({ ok: true, data: { keyed: "data" } });
  });

  it("passes nested keys and array indices to toJSON in data, error details and diagnostics", async () => {
    const nested = () => ({ inner: echoKey(), list: [echoKey(), echoKey()], big: 5n });

    const success = await runDocument(async (_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: nested() });
      return { data: nested() };
    });
    const printed = { inner: "key:inner", list: ["key:0", "key:1"], big: "5" };
    expect(parseOnlyDocument(success)).toEqual({
      ok: true,
      data: printed,
      diagnostics: [{ code: "D", severity: "info", message: "m", details: printed }],
    });

    const failure = await runDocument(async () => {
      throw Object.assign(new Error("conflict"), { code: "CONFLICT", exitCode: 9, details: nested() });
    });
    expect(failure.exitCode).toBe(9);
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "conflict", details: printed },
    });
  });

  it("keeps bigint strings and marks cycles in data, error details and diagnostics", async () => {
    const cyclic = () => {
      const value: Record<string, unknown> = { id: 1n, list: [2n] };
      value.self = value;
      (value.list as unknown[]).push(value);
      return value;
    };
    const printed = { id: "1", list: ["2", "[Circular]"], self: "[Circular]" };

    const success = await runDocument(async (_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: cyclic() });
      return { data: cyclic() };
    });
    expect(parseOnlyDocument(success)).toEqual({
      ok: true,
      data: printed,
      diagnostics: [{ code: "D", severity: "info", message: "m", details: printed }],
    });

    const failure = await runDocument(async () => {
      throw Object.assign(new Error("cyclic"), { code: "CYCLIC", details: cyclic() });
    });
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "CYCLIC", message: "cyclic", details: printed },
    });
  });
});

describe("document mode follows JSON.stringify for arrays, toJSON calls and boxed primitives", () => {
  /** Native JSON for a fresh copy of the same input, built by `make`. */
  const native = (make: () => unknown) => JSON.parse(JSON.stringify({ data: make() })).data as unknown;

  it.each<[string, () => unknown[]]>([
    [
      "an append",
      () => {
        const list: unknown[] = [];
        list.push({ toJSON: () => (list.push(2), 1) });
        return list;
      },
    ],
    [
      "a shrink",
      () => {
        const list: unknown[] = [];
        list.push({ toJSON: () => ((list.length = 1), 1) }, 2);
        return list;
      },
    ],
    [
      "repeated growth",
      () => {
        let calls = 0;
        const list: unknown[] = [];
        const grow = { toJSON: () => (calls < 10_000 && (calls += 1, list.push(grow)), 1) };
        list.push(grow);
        return list;
      },
    ],
  ])("reads an array's length once when a toJSON causes %s", async (_label, make) => {
    const expected = native(make);
    const data = await runDocument(() => ({ data: make() }));
    expect(parseOnlyDocument(data)).toEqual({ ok: true, data: expected });

    const failure = await runDocument(() => {
      throw Object.assign(new Error("resized"), { code: "RESIZED", details: { list: make() } });
    });
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "RESIZED", message: "resized", details: { list: expected } },
    });
  });

  it.each<[string, () => unknown]>([
    [
      "a fractional length",
      () => new Proxy([1, 2], { get: (target, key) => (key === "length" ? 1.5 : Reflect.get(target, key)) }),
    ],
    [
      "a length that changes on every read",
      () => {
        let reads = 0;
        return new Proxy([1, 2, 3], {
          get: (target, key) => (key === "length" ? (reads += 1) : Reflect.get(target, key)),
        });
      },
    ],
    [
      "a length object",
      () => {
        const length = { valueOf: () => 2.9 };
        return new Proxy([1, 2, 3], { get: (target, key) => (key === "length" ? length : Reflect.get(target, key)) });
      },
    ],
  ])("converts %s once, as JSON.stringify does", async (_label, make) => {
    const expected = native(make);
    const data = await runDocument(() => ({ data: make() }));
    expect(parseOnlyDocument(data)).toEqual({ ok: true, data: expected });

    const failure = await runDocument(() => {
      throw Object.assign(new Error("length"), { code: "LENGTH", details: { list: make() } });
    });
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "LENGTH", message: "length", details: { list: expected } },
    });
  });

  /** Two nodes that point at each other and serialize as fresh shallow copies of themselves. */
  const projectedCycle = () => {
    const parent: Record<string, unknown> = { name: "parent", password: "test-password" };
    const child: Record<string, unknown> = { name: "child", parent };
    parent.child = child;
    for (const node of [parent, child]) {
      node.toJSON = function (this: Record<string, unknown>) {
        return { ...this, toJSON: undefined };
      };
    }
    return parent;
  };
  // Each toJSON returns a fresh copy, so the cycle is marked where an original value comes back under the same key.
  const printedCycle = {
    name: "parent",
    password: "[REDACTED]",
    child: { name: "child", parent: { name: "parent", password: "[REDACTED]", child: "[Circular]" } },
  };

  it("marks a cycle through toJSON projections in data, the json() fallback, diagnostics and error details", async () => {
    // data is not redacted; diagnostics and error details are.
    const returned = await runDocument(() => ({ data: projectedCycle() }));
    const unredacted = {
      name: "parent",
      password: "test-password",
      child: { name: "child", parent: { name: "parent", password: "test-password", child: "[Circular]" } },
    };
    expect(parseOnlyDocument(returned)).toEqual({ ok: true, data: unredacted });

    const fallback = await runDocument((_options, ctx) => {
      ctx.output.json(projectedCycle());
    });
    expect(parseOnlyDocument(fallback)).toEqual({ ok: true, data: unredacted });

    const diagnostics = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: projectedCycle() });
      return { data: null, diagnostics: [{ code: "R", severity: "warn", message: "r", details: projectedCycle() }] };
    });
    expect(parseOnlyDocument(diagnostics).diagnostics).toEqual([
      { code: "D", severity: "info", message: "m", details: printedCycle },
      { code: "R", severity: "warn", message: "r", details: printedCycle },
    ]);

    const failure = await runDocument(() => {
      throw Object.assign(new Error("cyclic"), { code: "CYCLIC", exitCode: 4, details: projectedCycle() });
    });
    expect(failure.exitCode).toBe(4);
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "CYCLIC", message: "cyclic", details: printedCycle },
    });
  });

  it("follows a keyed toJSON that projects itself for one key and a leaf for another, as native JSON does", async () => {
    const keyed = (leaf: () => unknown) => ({
      toJSON(this: object, key: string): unknown {
        return key === "child" ? leaf() : { child: this };
      },
    });
    for (const leaf of [() => "leaf", () => ({ leaf: true, password: "test-password" })]) {
      const expected = native(() => keyed(leaf));
      expect(expected).toEqual({ child: leaf() });
      const redacted = JSON.parse(JSON.stringify(expected).replace('"test-password"', '"[REDACTED]"')) as unknown;

      const returned = await runDocument(() => ({ data: keyed(leaf) }));
      expect(parseOnlyDocument(returned)).toEqual({ ok: true, data: expected });

      const fallback = await runDocument((_options, ctx) => {
        ctx.output.json(keyed(leaf));
      });
      expect(parseOnlyDocument(fallback)).toEqual({ ok: true, data: expected });

      const failure = await runDocument((_options, ctx) => {
        ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: { node: keyed(leaf) } });
        throw Object.assign(new Error("keyed"), { code: "KEYED", exitCode: 5, details: { node: keyed(leaf) } });
      });
      expect(failure.exitCode).toBe(5);
      // As a member named "node", the toJSON projects { child: this } and then the leaf for "child".
      expect(parseOnlyDocument(failure)).toEqual({
        ok: false,
        error: { code: "KEYED", message: "keyed", details: { node: redacted } },
        diagnostics: [{ code: "D", severity: "info", message: "m", details: { node: redacted } }],
      });
    }
  });

  it("does not mark repeated acyclic references, with or without toJSON, as circular", async () => {
    const plain = { v: 1 };
    const projected = { v: 2, toJSON: (key: string) => ({ v: 2, key }) };
    const result = await runDocument(() => ({ data: { a: plain, b: plain, c: projected, d: [projected, projected] } }));
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: { a: { v: 1 }, b: { v: 1 }, c: { v: 2, key: "c" }, d: [{ v: 2, key: "0" }, { v: 2, key: "1" }] },
    });
  });

  it("calls a toJSON that has its own call property with its receiver and member key", async () => {
    const holder = <T extends object>(target: T) => {
      const serializer = function (this: unknown, key: string) {
        return { key, receiver: this === target };
      };
      Object.defineProperty(serializer, "call", { value: 1 });
      return Object.assign(target, { toJSON: serializer });
    };

    const object = await runDocument(() => ({ data: holder({}) }));
    expect(parseOnlyDocument(object)).toEqual({ ok: true, data: { key: "data", receiver: true } });

    const fn = await runDocument(() => ({ data: holder(() => undefined) }));
    expect(parseOnlyDocument(fn)).toEqual({ ok: true, data: { key: "data", receiver: true } });

    const nested = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: { inner: holder({}) } });
      throw Object.assign(new Error("failed"), { code: "FAILED", details: { list: [holder({})] } });
    });
    expect(parseOnlyDocument(nested)).toEqual({
      ok: false,
      error: { code: "FAILED", message: "failed", details: { list: [{ key: "0", receiver: true }] } },
      diagnostics: [{ code: "D", severity: "info", message: "m", details: { inner: { key: "inner", receiver: true } } }],
    });
  });

  it("unwraps boxed primitives by internal slot, as JSON.stringify does, in this and another realm", async () => {
    const make = () => {
      const numberLike = Object.assign(Object.create(Number.prototype) as object, { a: 1 });
      const stringLike = Object.assign(Object.create(String.prototype) as object, { b: "x" });
      const booleanLike = Object.assign(Object.create(Boolean.prototype) as object, { c: true });
      const falseBox = Object.assign(new Boolean(false), { valueOf: () => true });
      const numberBox = Object.assign(new Number(1), { valueOf: () => 7 });
      const stringBox = Object.assign(new String("s"), { toString: () => "shown" });
      return {
        boxes: [new Number(5), new String("s"), new Boolean(false), new Boolean(true)],
        foreign: runInNewContext("[new Number(5), new String('s'), new Boolean(false)]") as unknown[],
        lookalikes: [numberLike, stringLike, booleanLike],
        overridden: [falseBox, numberBox, stringBox],
      };
    };
    const expected = {
      boxes: [5, "s", false, true],
      foreign: [5, "s", false],
      lookalikes: [{ a: 1 }, { b: "x" }, { c: true }],
      overridden: [false, 7, "shown"],
    };
    expect(native(make)).toEqual(expected);

    const result = await runDocument(() => ({ data: { ...make(), bigint: Object(3n) as object } }));
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: { ...expected, bigint: "3" } });

    const failure = await runDocument(() => {
      throw Object.assign(new Error("boxed"), { code: "BOXED", details: make() });
    });
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "BOXED", message: "boxed", details: expected },
    });
  });
});

describe("document mode number boxes and throughput", () => {
  const bigintNumberBox = () => Object.assign(new Number(1), { valueOf: () => 9007199254740993n });

  it("rejects a Number box whose valueOf returns a bigint, as JSON.stringify does", async () => {
    expect(() => JSON.stringify(bigintNumberBox())).toThrow(TypeError);

    const data = await runDocument(() => ({ data: { count: bigintNumberBox() } }));
    expect(data.exitCode).toBe(1);
    expect(parseOnlyDocument(data)).toEqual({
      ok: false,
      error: { code: "CLIFN_RUNNER_FAILED", message: "Unable to serialize the result document" },
    });

    const failure = await runDocument(() => {
      const details = { count: bigintNumberBox() };
      throw Object.assign(new Error("bad details"), { code: "BAD_DETAILS", exitCode: 6, details });
    });
    expect(failure.exitCode).toBe(6);
    expect(parseOnlyDocument(failure)).toEqual({ ok: false, error: { code: "BAD_DETAILS", message: "bad details" } });
  });

  it("coerces a Number box through its numeric valueOf and keeps bigints as strings", async () => {
    const result = await runDocument(() => ({
      data: {
        box: Object.assign(new Number(1), { valueOf: () => 2.5 }),
        big: 9007199254740993n,
        bigBox: Object(9007199254740993n) as object,
      },
    }));
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: { box: 2.5, big: "9007199254740993", bigBox: "9007199254740993" },
    });
  });

  it("resolves 100,000 ordinary records within a bounded multiple of native JSON", async () => {
    const records = Array.from({ length: 100_000 }, (_, index) => ({ id: index, name: `n${index}`, tags: ["a"] }));
    let started = performance.now();
    JSON.parse(JSON.stringify(records));
    const nativeMs = performance.now() - started;

    started = performance.now();
    const result = await runDocument(() => ({ data: records }));
    const documentMs = performance.now() - started;

    expect((parseOnlyDocument(result).data as unknown[]).length).toBe(100_000);
    // Generous: the slot-probing walker took about 90 times native; the native walk with a replacer takes about 3.
    expect(documentMs).toBeLessThan(nativeMs * 25 + 500);
  });
});

describe("document mode exec streaming", () => {
  const childScript = 'process.stdout.write("child-out\\n"); process.stderr.write("child-err\\n");';

  it("sends streamed child output to stderr so stdout holds only the document", async () => {
    const result = await runDocument(async (_options, ctx) => {
      const run = await ctx.exec.command(process.execPath, ["-e", childScript], { streamOutput: true });
      return { data: { exitCode: run.exitCode, captured: run.stdout } };
    });

    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: { exitCode: 0, captured: "child-out\n" } });
    expect(result.stderr).toContain("child-out\n");
    expect(result.stderr).toContain("child-err\n");
  });

  it("keeps explicit per-command writers", async () => {
    const childOut: string[] = [];
    const childErr: string[] = [];
    const result = await runDocument(async (_options, ctx) => {
      await ctx.exec.command(process.execPath, ["-e", childScript], {
        streamOutput: true,
        stdout: (chunk) => childOut.push(chunk),
        stderr: (chunk) => childErr.push(chunk),
      });
      return { data: "done" };
    });

    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "done" });
    expect(childOut.join("")).toBe("child-out\n");
    expect(childErr.join("")).toBe("child-err\n");
    expect(result.stderr).toBe("");
  });
});

describe("document mode log routing", () => {
  const everyLevel: Action = async (_options, ctx) => {
    ctx.output.debug("d");
    ctx.output.info("i");
    ctx.output.success("s", { step: 1 });
    ctx.output.warn("w");
    ctx.output.error("e");
    const spinner = ctx.output.spinner("spinning");
    spinner.start();
    spinner.stop();
    spinner.succeed();
    ctx.output.spinner("failing").fail("spinner failed");
    return { data: "done" };
  };

  it("writes every level and the spinner result as JSON lines on stderr only", async () => {
    const result = await runDocument(everyLevel, { verbose: true });

    expect(result.out).toBe('{"ok":true,"data":"done"}\n');
    expect(result.stderr).toBe(
      [
        '{"level":"debug","message":"d"}',
        '{"level":"info","message":"i"}',
        '{"level":"success","message":"s","details":{"step":1}}',
        '{"level":"warn","message":"w"}',
        '{"level":"error","message":"e"}',
        '{"level":"success","message":"spinning"}',
        '{"level":"error","message":"spinner failed"}',
        "",
      ].join("\n")
    );
  });

  it("keeps quiet and verbose rules: quiet leaves only errors, debug needs verbose", async () => {
    const quiet = await runDocument(everyLevel, { quiet: true, verbose: true });
    expect(quiet.out).toBe('{"ok":true,"data":"done"}\n');
    expect(stderrLines(quiet.stderr)).toEqual([
      { level: "error", message: "e" },
      { level: "error", message: "spinner failed" },
    ]);

    const normal = await runDocument(everyLevel);
    expect(stderrLines(normal.stderr).map((line) => line.level)).toEqual([
      "info",
      "success",
      "warn",
      "error",
      "success",
      "error",
    ]);
  });

  it("reports mode json to the action", async () => {
    const result = await runDocument(async (_options, ctx) => ({ data: ctx.output.mode }));
    expect(parseOnlyDocument(result)).toEqual({ ok: true, data: "json" });
  });

  it("writes to process.stdout and process.stderr when no writers are given", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const exitCode = await runAction(
        async (_options: object, ctx) => {
          ctx.output.info("to stderr");
          return { data: { ok: 1 } };
        },
        {},
        { mode: "json", jsonStyle: "document" }
      );
      expect(exitCode).toBe(0);
      expect(out.mock.calls).toEqual([['{"ok":true,"data":{"ok":1}}\n']]);
      expect(err.mock.calls).toEqual([['{"level":"info","message":"to stderr"}\n']]);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});
