import { constants } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createCredentialStore, MissingProfileError } from "../src/credentials.js";
import type { Diagnostic } from "../src/diagnostics.js";
import { createDocumentOutput, type DocumentOutcome } from "../src/document-output.js";
import { createDocumentBudget, PROJECTION_REPEAT_LIMIT, serializeJsonMember } from "../src/json-value.js";
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
    // The listener receives the diagnostics as the document prints them: redacted, and never the objects it was
    // given, so what a run retains for them stays bounded.
    expect(seen).toEqual([[{ apiKey: "[REDACTED]", region: "eu" }, undefined]]);

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
    [
      "a data getter that throws",
      (): RunnerActionResult => ({
        get data(): unknown {
          throw new Error("getter-failure-text");
        },
      }),
      ["output.table()"],
    ],
    [
      "a data toJSON that throws",
      (): RunnerActionResult => ({
        data: {
          toJSON() {
            throw new Error("tojson-failure-text");
          },
        },
      }),
      ["output.table()"],
    ],
    [
      "a json() value whose toJSON throws",
      (ctx: RunnerContext): undefined => {
        ctx.output.json({
          toJSON() {
            throw new Error("json-failure-text");
          },
        });
      },
      ["output.table()", "output.json()"],
    ],
  ])("warns for every diagnostic and output call the fixed failure document leaves out: %s", async (_name, finish, calls) => {
    const action: Action = async (_options, ctx) => {
      ctx.diagnostics.add({ code: 1 } as never);
      ctx.diagnostics.add({ code: "KEPT", severity: "info", message: "kept" });
      ctx.output.table({ columns: ["id"], rows: [{ id: 1 }] });
      return finish(ctx);
    };
    const result = await runDocument(action);

    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "CLIFN_RUNNER_FAILED", message: "Unable to serialize the result document" },
    });
    expect(stderrLines(result.stderr)).toEqual([
      ...calls.map((call) => ({
        level: "warn",
        message: `${call} was not printed: document mode prints one result document; return the value as data`,
      })),
      { level: "warn", message: "diagnostic 0 was dropped from the result document: it could not be redacted or printed" },
      { level: "warn", message: "1 diagnostics were dropped: the result document could not be prepared" },
    ]);
    expect(result.stderr).not.toContain("failure-text");

    const quiet = await runDocument(action, { quiet: true });
    expect(quiet.exitCode).toBe(1);
    expect(quiet.out).toBe(result.out);
    expect(quiet.stderr).toBe("");
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
    [
      "throws when their prototype is read",
      () =>
        new Proxy(
          {},
          {
            getPrototypeOf() {
              throw new Error("prototype failed");
            },
          }
        ),
    ],
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
        let coercions = 0;
        // Each copy may be converted once; a second ToLength (or ToNumber) of the same length throws.
        const length = {
          valueOf: () => {
            coercions += 1;
            if (coercions > 1) {
              throw new Error("length converted twice");
            }
            return 2.9;
          },
        };
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
  /**
   * `wrap` applied `times` times around `innermost`. A projection loop is cut in place once one value has
   * PROJECTION_REPEAT_LIMIT projections open for the same key: the member's own projection (for its own key) and 64
   * more for the recurring key print, so by default 65 levels wrap "[Circular]".
   */
  const nest = (wrap: (inner: unknown) => unknown, times = PROJECTION_REPEAT_LIMIT + 1, innermost: unknown = "[Circular]") => {
    let node: unknown = innermost;
    for (let depth = 0; depth < times; depth += 1) {
      node = wrap(node);
    }
    return node;
  };
  // The member's parent projection, then 64 child and parent projections each; the 65th "child" is cut.
  const printCycle = (password: string) =>
    nest(
      (inner) => ({ name: "parent", password, child: { name: "child", parent: inner } }),
      PROJECTION_REPEAT_LIMIT,
      { name: "parent", password, child: "[Circular]" }
    );
  const printedCycle = printCycle("[REDACTED]");

  it("marks a cycle through toJSON projections in data, the json() fallback, diagnostics and error details", async () => {
    // Data, diagnostics and error details are all redacted.
    const returned = await runDocument(() => ({ data: projectedCycle() }));
    expect(parseOnlyDocument(returned)).toEqual({ ok: true, data: printedCycle });

    const fallback = await runDocument((_options, ctx) => {
      ctx.output.json(projectedCycle());
    });
    expect(parseOnlyDocument(fallback)).toEqual({ ok: true, data: printedCycle });

    const diagnostics = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: projectedCycle() });
      return { data: null, diagnostics: [{ code: "R", severity: "warning", message: "r", details: projectedCycle() }] };
    });
    expect(parseOnlyDocument(diagnostics).diagnostics).toEqual([
      { code: "D", severity: "info", message: "m", details: printedCycle },
      { code: "R", severity: "warning", message: "r", details: printedCycle },
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
      expect(parseOnlyDocument(returned)).toEqual({ ok: true, data: redacted });

      const fallback = await runDocument((_options, ctx) => {
        ctx.output.json(keyed(leaf));
      });
      expect(parseOnlyDocument(fallback)).toEqual({ ok: true, data: redacted });

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

  /**
   * Runs `make()` as returned data, the json() fallback, diagnostic details and error details, expecting `redacted`
   * everywhere; `printed` is what native JSON prints before redaction.
   */
  const expectEveryMember = async (make: () => unknown, printed: unknown, redacted: unknown = printed) => {
    expect(parseOnlyDocument(await runDocument(() => ({ data: make() })))).toEqual({ ok: true, data: redacted });
    const fallback = await runDocument((_options, ctx) => {
      ctx.output.json(make());
    });
    expect(parseOnlyDocument(fallback)).toEqual({ ok: true, data: redacted });
    const failure = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: { value: make() } });
      throw Object.assign(new Error("failed"), { code: "FAILED", exitCode: 7, details: { value: make() } });
    });
    expect(failure.exitCode).toBe(7);
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "FAILED", message: "failed", details: { value: redacted } },
      diagnostics: [{ code: "D", severity: "info", message: "m", details: { value: redacted } }],
    });
  };

  it("marks fresh toJSON projections that reach their source through a getter or a proxy's indexed get", async () => {
    const throughGetter = () => ({
      toJSON(this: object) {
        const self = this;
        return {
          name: "n",
          get child() {
            return self;
          },
        };
      },
    });
    expect(() => JSON.stringify(throughGetter())).toThrow(RangeError);
    await expectEveryMember(throughGetter, nest((inner) => ({ name: "n", child: inner })));

    const throughProxy = () => {
      const source: object = {
        toJSON: () => new Proxy([0], { get: (target, key) => (key === "0" ? source : Reflect.get(target, key)) }),
      };
      return source;
    };
    expect(() => JSON.stringify(throughProxy())).toThrow(RangeError);
    await expectEveryMember(throughProxy, nest((inner) => [inner]));
  });

  it("keeps finite toJSON recursion and members a toJSON reassigns as native JSON prints them", async () => {
    const stateful = () => {
      let calls = 0;
      const source: object = { toJSON: () => ((calls += 1) < 4 ? { next: source } : "leaf") };
      return source;
    };
    expect(native(stateful)).toEqual({ next: { next: { next: "leaf" } } });
    await expectEveryMember(stateful, { next: { next: { next: "leaf" } } });

    const reassigning = () => {
      const leaf: { toJSON?: () => unknown } = {};
      // The leaf's toJSON puts the source back into the member being serialized; that member was already read.
      const source = {
        toJSON() {
          const projection: Record<string, unknown> = { member: leaf };
          leaf.toJSON = () => {
            projection.member = source;
            return { leaf: true };
          };
          return projection;
        },
      };
      return source;
    };
    expect(native(reassigning)).toEqual({ member: { leaf: true } });
    await expectEveryMember(reassigning, { member: { leaf: true } });
  });

  it("serializes in one pass: a one-shot getter beside a projection loop runs once and the loop is cut at the cap", async () => {
    // Each projection carries the same 76 KiB string: 64 of them fit the document, so the run keeps its outcome.
    const text = "t".repeat(76 * 1024);
    const created: Array<{ getter: number; toJSON: number }> = [];
    const make = () => {
      const counts = { getter: 0, toJSON: 0 };
      created.push(counts);
      const loop = {
        toJSON(this: object) {
          counts.toJSON += 1;
          return { again: this, password: "test-password", text };
        },
      };
      return {
        get once() {
          counts.getter += 1;
          if (counts.getter > 1) {
            throw new Error("replayed");
          }
          return "once";
        },
        loop,
      };
    };
    const printed = (password: string) => ({ once: "once", loop: nest((inner) => ({ again: inner, password, text })) });

    await expectEveryMember(make, printed("test-password"), printed("[REDACTED]"));
    // Data, the json() fallback, and the diagnostic and error details of the failing run: four values, each read once.
    expect(created).toHaveLength(4);
    for (const counts of created) {
      // The member's toJSON ("loop") and one call per "again" recurrence up to the cut one: never a second walk.
      expect(counts).toEqual({ getter: 1, toJSON: PROJECTION_REPEAT_LIMIT + 2 });
    }
  });

  it("prints finite and key-dependent chains up to the cap as native JSON does and cuts longer ones in place", async () => {
    const stateful = (depth: number, calls = { count: 0 }) => {
      const source: object = {
        toJSON: () => ((calls.count += 1) <= depth ? { next: source, password: "test-password" } : "leaf"),
      };
      return source;
    };
    const chain = (depth: number, leaf: unknown, password: string) => {
      let node = leaf;
      for (let level = 0; level < depth; level += 1) {
        node = { next: node, password };
      }
      return node;
    };

    expect(native(() => stateful(PROJECTION_REPEAT_LIMIT))).toEqual(
      chain(PROJECTION_REPEAT_LIMIT, "leaf", "test-password")
    );
    await expectEveryMember(
      () => stateful(PROJECTION_REPEAT_LIMIT),
      chain(PROJECTION_REPEAT_LIMIT, "leaf", "test-password"),
      chain(PROJECTION_REPEAT_LIMIT, "leaf", "[REDACTED]")
    );

    // Natively 70 levels; here the projection for the member's own key and 64 for "next" print, and the 65th "next"
    // projection of the same value is "[Circular]", after 66 toJSON calls.
    const calls = { count: 0 };
    expect(native(() => stateful(70))).toEqual(chain(70, "leaf", "test-password"));
    const beyond = await runDocument(() => ({ data: stateful(70, calls) }));
    expect(parseOnlyDocument(beyond)).toEqual({
      ok: true,
      data: chain(PROJECTION_REPEAT_LIMIT + 1, "[Circular]", "[REDACTED]"),
    });
    expect(calls.count).toBe(PROJECTION_REPEAT_LIMIT + 2);
    await expectEveryMember(
      () => stateful(70),
      chain(PROJECTION_REPEAT_LIMIT + 1, "[Circular]", "test-password"),
      chain(PROJECTION_REPEAT_LIMIT + 1, "[Circular]", "[REDACTED]")
    );

    // The key carries the depth: k0 projects { k1: this }, and so on, until the key that names the last level. No
    // value recurs under the same key, so even past the cap the chain prints as native JSON prints it.
    const keyed = (last: number) => ({
      toJSON(this: object, key: string): unknown {
        const level = key.startsWith("k") ? Number(key.slice(1)) : 0;
        return level >= last ? `leaf ${level}` : { [`k${level + 1}`]: this };
      },
    });
    const keyedChain = (depth: number, leaf: unknown) => {
      let node = leaf;
      for (let level = depth; level >= 1; level -= 1) {
        node = { [`k${level}`]: node };
      }
      return node;
    };
    const keyedLeaf = keyedChain(PROJECTION_REPEAT_LIMIT, `leaf ${PROJECTION_REPEAT_LIMIT}`);
    expect(native(() => keyed(PROJECTION_REPEAT_LIMIT))).toEqual(keyedLeaf);
    await expectEveryMember(() => keyed(PROJECTION_REPEAT_LIMIT), keyedLeaf);
    expect(native(() => keyed(100))).toEqual(keyedChain(100, "leaf 100"));
    await expectEveryMember(() => keyed(100), keyedChain(100, "leaf 100"));

    // A loop referenced twice is cut at the same depth in both places.
    const loop = { toJSON: (key: string) => ({ again: loop, key }) };
    const twice = await runDocument(() => ({ data: { a: loop, b: [loop] } }));
    // The member's own projection, then 64 "again" projections; the 65th is cut.
    const cut = (key: string) => ({ again: nest((inner) => ({ again: inner, key: "again" }), PROJECTION_REPEAT_LIMIT), key });
    expect(parseOnlyDocument(twice)).toEqual({ ok: true, data: { a: cut("a"), b: [cut("0")] } });
  });

  it("keeps the output of finite siblings of a cut loop at every level, including the cut one, in either order", async () => {
    // A sibling projected for another key terminates, so it prints in full whatever the member order: only the value
    // recurring under the same key ("again") is cut.
    const run = async (order: "again-first" | "leaf-first", leaf: (self: object) => (key: string) => unknown) => {
      const keys: string[] = [];
      const looping: { toJSON(key: string): unknown } = {
        toJSON(key: string) {
          keys.push(key);
          const finite = leaf(looping)(key);
          if (finite !== undefined) {
            return finite;
          }
          return order === "again-first" ? { again: looping, leaf: looping } : { leaf: looping, again: looping };
        },
      };
      expect(() => JSON.stringify(looping)).toThrow(RangeError);
      keys.length = 0;
      const result = await runDocument(() => ({ data: looping }));
      return { document: parseOnlyDocument(result), keys };
    };
    const kept = () => (key: string) => (key === "leaf" ? { kept: true } : undefined);
    // leaf -> { inner: L }, inner -> { deeper: L }, deeper -> "end": a finite chain through the looping value itself.
    const chained = (self: object) => (key: string) =>
      key === "leaf" ? { inner: self } : key === "inner" ? { deeper: self } : key === "deeper" ? "end" : undefined;
    const level = (order: string, leafText: unknown) => (inner: unknown) =>
      order === "again-first" ? { again: inner, leaf: leafText } : { leaf: leafText, again: inner };

    for (const order of ["again-first", "leaf-first"] as const) {
      for (const [leaf, leafText, leafCalls] of [
        [kept, { kept: true }, 1],
        [chained, { inner: { deeper: "end" } }, 3],
      ] as const) {
        const { document, keys } = await run(order, leaf);
        // The member's projection and 64 "again" projections print, each with its leaf, and the 65th "again" is cut.
        expect(document).toEqual({
          ok: true,
          data: nest(level(order, leafText), PROJECTION_REPEAT_LIMIT, level(order, leafText)("[Circular]")),
        });
        // One toJSON call per member: "data", 65 "again" (the last one cut), and each of the 65 leaves' chain.
        expect(keys.filter((key) => key === "again")).toHaveLength(PROJECTION_REPEAT_LIMIT + 1);
        expect(keys).toHaveLength(1 + (PROJECTION_REPEAT_LIMIT + 1) * (1 + leafCalls));
      }
    }

    // Two independent finite projections of one value side by side print as JSON.stringify prints them.
    const twice = { toJSON: (key: string) => ({ key }) };
    const pair = await runDocument(() => ({ data: { left: twice, right: [twice, twice] } }));
    expect(parseOnlyDocument(pair)).toEqual(JSON.parse(JSON.stringify({ ok: true, data: { left: twice, right: [twice, twice] } })));
  });

  it("rejects an array length that cannot be printed before reading any item, as JSON.stringify does", async () => {
    const huge = (reads: { count: number }) =>
      new Proxy([], {
        get: (target, key) => {
          if (key === "length") {
            return 2 ** 32;
          }
          if (typeof key === "string" && /^\d+$/.test(key)) {
            reads.count += 1;
          }
          return Reflect.get(target, key);
        },
      });
    const nativeReads = { count: 0 };
    expect(() => JSON.stringify({ data: huge(nativeReads) })).toThrow(RangeError);
    expect(nativeReads.count).toBe(0);

    const reads = { count: 0 };
    const data = await runDocument(() => ({ data: { list: huge(reads) } }));
    expect(data.exitCode).toBe(1);
    expect(parseOnlyDocument(data)).toEqual({
      ok: false,
      error: { code: "CLIFN_RUNNER_FAILED", message: "Unable to serialize the result document" },
    });

    const failure = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: { list: huge(reads) } });
      ctx.diagnostics.add({ code: "KEPT", severity: "info", message: "kept" });
      throw Object.assign(new Error("huge"), { code: "HUGE", exitCode: 8, details: { list: huge(reads) } });
    });
    expect(failure.exitCode).toBe(8);
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "HUGE", message: "huge" },
      diagnostics: [
        { code: "D", severity: "info", message: "m" },
        { code: "KEPT", severity: "info", message: "kept" },
      ],
    });
    expect(reads.count).toBe(0);
  });

  it("rejects an array whose text cannot fit the engine's string limit before reading it", async () => {
    const reads = { count: 0 };
    // 2n + 1 characters (brackets, separators and one per item) are more than the engine can print.
    const tooMany = new Proxy([], {
      get: (target, key) => {
        if (key === "length") {
          return Math.ceil(constants.MAX_STRING_LENGTH / 2);
        }
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads.count += 1;
          return 0;
        }
        return Reflect.get(target, key);
      },
    });
    const data = await runDocument(() => ({ data: tooMany }));
    expect(data.exitCode).toBe(1);
    expect(parseOnlyDocument(data)).toEqual({
      ok: false,
      error: { code: "CLIFN_RUNNER_FAILED", message: "Unable to serialize the result document" },
    });
    expect(reads.count).toBe(0);
  });

  it("prints large ordinary data byte for byte as JSON.stringify does", { timeout: 60_000 }, async () => {
    const dense = Array.from({ length: 5_000_000 }, (_, index) => index % 10);
    const denseResult = await runDocument(() => ({ data: dense }));
    expect(denseResult.exitCode).toBe(0);
    expect(denseResult.writes).toBe(1);
    expect(denseResult.out).toBe(`${JSON.stringify({ ok: true, data: dense })}\n`);

    const wide = Object.fromEntries(
      Array.from({ length: 200_000 }, (_, id) => [
        `key-${id}`,
        { id, name: `name-${id}`, tags: ["a", "b"], on: id % 2 === 0, none: null, ratio: id / 7 },
      ])
    );
    const wideResult = await runDocument(() => ({ data: wide }));
    expect(wideResult.exitCode).toBe(0);
    expect(wideResult.writes).toBe(1);
    expect(wideResult.out).toBe(`${JSON.stringify({ ok: true, data: wide })}\n`);
  });

  it("keeps the outcome when optional members outgrow the document", async () => {
    // 64 nested projections of a shared 9 MiB headline are more text than the engine can print.
    const headline = "h".repeat(9 * 2 ** 20);
    const loop = () => ({
      toJSON(this: object) {
        return { headline, next: this };
      },
    });
    const failure = await runDocument(() => {
      throw Object.assign(new Error("closed"), { code: "CLOSED", exitCode: 7, details: { loop: loop() } });
    });
    expect(failure.exitCode).toBe(7);
    expect(parseOnlyDocument(failure)).toEqual({ ok: false, error: { code: "CLOSED", message: "closed" } });

    // Diagnostic details that do not fit, or are not an object, are left out and give their budget back.
    const success = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "BIG", severity: "info", message: "big", details: { loop: loop() } });
      ctx.diagnostics.add({ code: "TEXT", severity: "info", message: "text", details: { toJSON: () => headline } });
      ctx.diagnostics.add({ code: "SMALL", severity: "info", message: "small", details: { n: 1 } });
      return { data: { done: true } };
    });
    expect(success.exitCode).toBe(0);
    expect(parseOnlyDocument(success)).toEqual({
      ok: true,
      data: { done: true },
      diagnostics: [
        { code: "BIG", severity: "info", message: "big" },
        { code: "TEXT", severity: "info", message: "text" },
        { code: "SMALL", severity: "info", message: "small", details: { n: 1 } },
      ],
    });

    // Strings and keys are charged at the exact length of their printed text, escapes included.
    for (const text of ["plain", 'q"b\\', "\u0000\u001f\n\t", "😀", "\ud800x\udc00", "end\ud83d"]) {
      for (const value of [[text], { [text]: 1 }]) {
        const budget = createDocumentBudget();
        const before = budget.charsLeft;
        const printed = String(serializeJsonMember("k", value, { budget }));
        expect(printed).toBe(JSON.stringify(value));
        expect(before - budget.charsLeft).toBe(printed.length);
      }
    }
  });

  it("counts a sensitive value as the redacted text it prints, so long shared secrets keep the details", async () => {
    // 512 rows share one 1 MiB string under a redacted key: unredacted, they would be more than the engine can print.
    const secret = "x".repeat(2 ** 20);
    const rows = () => ({ rows: Array.from({ length: 512 }, () => ({ password: secret })), visible: "kept" });
    const redactedRows = { rows: Array.from({ length: 512 }, () => ({ password: "[REDACTED]" })), visible: "kept" };
    const failure = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: rows() });
      throw Object.assign(new Error("rows"), { code: "ROWS", exitCode: 9, details: rows() });
    });
    expect(failure.exitCode).toBe(9);
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "ROWS", message: "rows", details: redactedRows },
      diagnostics: [{ code: "D", severity: "info", message: "m", details: redactedRows }],
    });

    const success = await runDocument(() => ({
      data: null,
      diagnostics: [{ code: "R", severity: "info", message: "r", details: rows() }],
    }));
    expect(parseOnlyDocument(success)).toEqual({
      ok: true,
      data: null,
      diagnostics: [{ code: "R", severity: "info", message: "r", details: redactedRows }],
    });
  });

  it("resolves error and diagnostic details completely before redacting them", async () => {
    const make = (counts: { inner: number; visible: number }) => {
      const state = { value: "before" };
      const details = {
        token: {
          get inner() {
            counts.inner += 1;
            state.value = "after";
            return "test-token-value";
          },
        },
      };
      Object.defineProperty(details, "visible", {
        enumerable: true,
        get() {
          counts.visible += 1;
          return state.value;
        },
      });
      return details;
    };
    const nativeCounts = { inner: 0, visible: 0 };
    expect(JSON.parse(JSON.stringify(make(nativeCounts)))).toEqual({
      token: { inner: "test-token-value" },
      visible: "after",
    });
    expect(nativeCounts).toEqual({ inner: 1, visible: 1 });

    const redacted = { token: "[REDACTED]", visible: "after" };
    const counts = { inner: 0, visible: 0 };
    const failure = await runDocument((_options, ctx) => {
      ctx.diagnostics.add({ code: "D", severity: "info", message: "m", details: make(counts) });
      throw Object.assign(new Error("failed"), { code: "BAD_THING", exitCode: 5, details: make(counts) });
    });
    expect(failure.exitCode).toBe(5);
    expect(failure.out).not.toContain("test-token-value");
    expect(parseOnlyDocument(failure)).toEqual({
      ok: false,
      error: { code: "BAD_THING", message: "failed", details: redacted },
      diagnostics: [{ code: "D", severity: "info", message: "m", details: redacted }],
    });
    expect(counts).toEqual({ inner: 2, visible: 2 });

    const returnedCounts = { inner: 0, visible: 0 };
    const success = await runDocument(() => ({
      data: null,
      diagnostics: [{ code: "R", severity: "warning", message: "r", details: make(returnedCounts) }],
    }));
    expect(parseOnlyDocument(success)).toEqual({
      ok: true,
      data: null,
      diagnostics: [{ code: "R", severity: "warning", message: "r", details: redacted }],
    });
    expect(returnedCounts).toEqual({ inner: 1, visible: 1 });
  });

  it("reads array items without descriptor lookups, as JSON.stringify does", async () => {
    const make = () =>
      new Proxy([{ x: 1 }, 2], {
        getOwnPropertyDescriptor: (target, key) => {
          if (key === "0") {
            target[1] = 99;
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    expect(native(make)).toEqual([{ x: 1 }, 2]);
    await expectEveryMember(make, [{ x: 1 }, 2]);
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

  const rawJSON = (JSON as { rawJSON?: (text: string) => object }).rawJSON;
  it.skipIf(rawJSON === undefined)("prints JSON.rawJSON values as their raw text, as JSON.stringify does", async () => {
    const make = rawJSON as (text: string) => object;
    const data = { big: make("12345678901234567890"), list: [make("1e400"), make('"text"')], password: make("1") };
    const result = await runDocument(async () => ({ data }));
    expect(result.out).toBe(
      `${JSON.stringify({ ok: true, data: { ...data, password: "[REDACTED]" } })}\n`
    );
    expect(result.out).toContain('"big":12345678901234567890');
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
    // Generous: the walker that probed slots by throwing took about 90 times native; this one takes about 3.
    expect(documentMs).toBeLessThan(nativeMs * 25 + 500);
  });
});

describe("document mode text limit", () => {
  const failureDocument = {
    ok: false,
    error: { code: "CLIFN_RUNNER_FAILED", message: "Unable to serialize the result document" },
  };
  const finishWith = (maxLength: number, outcome: DocumentOutcome, diagnostics: Diagnostic[] = []) => {
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
  };
  const warnings = (stderr: string) =>
    stderrLines(stderr)
      .filter((line) => line.level === "warn")
      .map((line) => line.message);

  it("prints data whose text and newline are exactly the limit and fails one character below it", () => {
    const data = { list: [1, 22, 333], name: "plain", on: true, none: null, nested: { ratio: 0.5 } };
    const text = JSON.stringify({ ok: true, data });
    // The newline counts, so a document that fits the engine's limit can always be written with it.
    const fits = finishWith(text.length + 1, { ok: true, data, exitCode: 0 });
    expect(fits.exitCode).toBe(0);
    expect(fits.out).toBe(`${text}\n`);

    const over = finishWith(text.length, { ok: true, data, exitCode: 0 });
    expect(over.exitCode).toBe(1);
    expect(parseOnlyDocument(over)).toEqual(failureDocument);
  });

  it("fails data whose escapes make the printed text longer than the limit", () => {
    // 22 characters are counted, 122 would be printed.
    const data = "\u0000".repeat(20);
    const result = finishWith(100, { ok: true, data, exitCode: 0 });
    expect(result.exitCode).toBe(1);
    expect(parseOnlyDocument(result)).toEqual(failureDocument);
  });

  it("omits error details over the limit and keeps the code, message and exit code", () => {
    for (const details of [{ text: "x".repeat(300) }, { text: "\u0000".repeat(30) }]) {
      const error = Object.assign(new Error("big"), { code: "BIG", exitCode: 6, details });
      const result = finishWith(150, { ok: false, error });
      expect(result.exitCode).toBe(6);
      expect(parseOnlyDocument(result)).toEqual({ ok: false, error: { code: "BIG", message: "big" } });
    }
  });

  it("drops diagnostics or their details over the limit with a warning and keeps the outcome", () => {
    const diagnostics: Diagnostic[] = [
      { code: "LONG", severity: "info", message: "x".repeat(300) },
      { code: "DETAILS", severity: "info", message: "d", details: { text: "y".repeat(300) } },
      { code: "SMALL", severity: "info", message: "s", details: { n: 1 } },
    ];
    const result = finishWith(200, { ok: true, data: { done: true }, exitCode: 3 }, diagnostics);
    expect(result.exitCode).toBe(3);
    expect(parseOnlyDocument(result)).toEqual({
      ok: true,
      data: { done: true },
      diagnostics: [
        { code: "DETAILS", severity: "info", message: "d" },
        { code: "SMALL", severity: "info", message: "s", details: { n: 1 } },
      ],
    });
    expect(warnings(result.stderr)).toEqual([
      "diagnostic 0 was dropped from the result document: it could not be redacted or printed",
    ]);

    // Escapes are counted: a diagnostic whose escaped text does not fit is dropped, and the outcome still stands.
    const escaped = finishWith(150, { ok: true, data: { done: true }, exitCode: 0 }, [
      { code: "NUL", severity: "info", message: "\u0000".repeat(30) },
      { code: "OK", severity: "info", message: "ok" },
    ]);
    expect(escaped.exitCode).toBe(0);
    expect(parseOnlyDocument(escaped)).toEqual({
      ok: true,
      data: { done: true },
      diagnostics: [{ code: "OK", severity: "info", message: "ok" }],
    });
    expect(warnings(escaped.stderr)).toEqual([
      "diagnostic 0 was dropped from the result document: it could not be redacted or printed",
    ]);
  });

  it("replaces an error message over the limit with a fixed one and keeps the code and exit code", () => {
    const tooLong = { code: "LONG", message: "The error message was too long to print." };
    const longError = Object.assign(new Error("m".repeat(500)), { code: "LONG", exitCode: 4 });
    const long = finishWith(200, { ok: false, error: longError });
    expect(long.exitCode).toBe(4);
    expect(parseOnlyDocument(long)).toEqual({ ok: false, error: tooLong });

    // An escaped message is counted at its printed length: it is replaced, the details still fit, a diagnostic does not.
    const escaped = finishWith(
      150,
      {
        ok: false,
        error: Object.assign(new Error("\u0000".repeat(30)), { code: "LONG", exitCode: 4, details: { n: 1 } }),
      },
      [{ code: "D", severity: "info", message: "d" }]
    );
    expect(escaped.exitCode).toBe(4);
    expect(parseOnlyDocument(escaped)).toEqual({ ok: false, error: { ...tooLong, details: { n: 1 } } });
  });

  it("prints a sensitive value as the redacted text alone, so long secrets keep the details within the limit", () => {
    const calls = { password: 0, toJSON: 0 };
    const details = () => ({
      get password() {
        calls.password += 1;
        return "x".repeat(256);
      },
      apiKey: {
        toJSON() {
          calls.toJSON += 1;
          return "y".repeat(256);
        },
      },
      token: undefined,
      visible: "keep",
    });
    const redacted = { password: "[REDACTED]", apiKey: "[REDACTED]", visible: "keep" };
    const diagnostic = (): Diagnostic => ({ code: "D", severity: "info", message: "m", details: details() });

    const failure = finishWith(240, {
      ok: false,
      error: Object.assign(new Error("boom"), { code: "TEST_FAILED", exitCode: 4, details: details() }),
    });
    expect(failure.exitCode).toBe(4);
    expect(parseOnlyDocument(failure)).toEqual({ ok: false, error: { code: "TEST_FAILED", message: "boom", details: redacted } });
    expect(calls).toEqual({ password: 1, toJSON: 1 });

    const failureWithDiagnostic = finishWith(
      240,
      { ok: false, error: Object.assign(new Error("boom"), { code: "TEST_FAILED", exitCode: 4 }) },
      [diagnostic()]
    );
    expect(failureWithDiagnostic.exitCode).toBe(4);
    expect(parseOnlyDocument(failureWithDiagnostic)).toEqual({
      ok: false,
      error: { code: "TEST_FAILED", message: "boom" },
      diagnostics: [{ code: "D", severity: "info", message: "m", details: redacted }],
    });
    expect(calls).toEqual({ password: 2, toJSON: 2 });

    const success = finishWith(240, { ok: true, data: { done: true }, exitCode: 2 }, [diagnostic()]);
    expect(success.exitCode).toBe(2);
    expect(parseOnlyDocument(success)).toEqual({
      ok: true,
      data: { done: true },
      diagnostics: [{ code: "D", severity: "info", message: "m", details: redacted }],
    });
    expect(calls).toEqual({ password: 3, toJSON: 3 });
    expect(warnings(success.stderr)).toEqual([]);
  });

  it("omits redacted details whose value JSON.stringify could not print, before reading any of its items", () => {
    const reads = { count: 0 };
    const huge = () =>
      new Proxy([], {
        get: (target, key) => {
          if (key === "length") {
            return 2 ** 32;
          }
          if (typeof key === "string" && /^\d+$/.test(key)) {
            reads.count += 1;
          }
          return Reflect.get(target, key);
        },
      });
    const result = finishWith(
      10_000,
      {
        ok: false,
        error: Object.assign(new Error("boom"), { code: "TEST_FAILED", exitCode: 5, details: { token: huge(), n: 1 } }),
      },
      [{ code: "D", severity: "info", message: "m", details: { secret: huge() } }]
    );
    expect(result.exitCode).toBe(5);
    expect(parseOnlyDocument(result)).toEqual({
      ok: false,
      error: { code: "TEST_FAILED", message: "boom" },
      diagnostics: [{ code: "D", severity: "info", message: "m" }],
    });
    expect(reads.count).toBe(0);
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

  it("keeps the result, its exit code and stdout when the stderr writer throws on every level and spinner result", async () => {
    for (const quiet of [false, true]) {
      const attempted: string[] = [];
      const stdout: string[] = [];
      const exitCode = await runAction(
        async (options: Record<string, never>, ctx: RunnerContext) => {
          await everyLevel(options, ctx);
          return { data: "done", exitCode: 4 };
        },
        {},
        {
          color: false,
          verbose: true,
          quiet,
          mode: "json",
          jsonStyle: "document",
          stdout: (text) => stdout.push(text),
          stderr: (text) => {
            attempted.push(text);
            throw new Error("stderr closed");
          },
        }
      );

      expect(exitCode).toBe(4);
      expect(stdout).toEqual(['{"ok":true,"data":"done"}\n']);
      // Every level and both spinner results were written, one at a time, each throw swallowed; quiet still filters.
      expect(stderrLines(attempted.join("")).map((line) => line.level)).toEqual(
        quiet ? ["error", "error"] : ["debug", "info", "success", "warn", "error", "success", "error"]
      );
    }
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
