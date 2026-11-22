import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
