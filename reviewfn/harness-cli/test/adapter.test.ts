import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, lensOutputSchema, runProcessGroup, structuredOutputValidator, type CommandRunner, type HarnessProfile, type ReviewFnConfig, type SlotHarnessInput } from "@superfunctions/reviewfn-core";

import { AGENT, LAUNCH } from "./launcher.js";
import { CliHarnessAdapter, cliArguments, cliEnvironment, lastJsonObjectLine, matchReporter, parseCliVersion, valueAtPath, withModelReportField } from "../src/index.js";

// Lets a test replace the executable's file identity (its inode), as a reinstall at the same path would.
// `swap` stands for a same-user process that, once armed, swaps a directory for a link just after the adapter's `after`-th
// check of it, and puts it back just before the next check, so only a use bound to the checked directory can tell.
// `beforeRemove` runs just before the adapter removes its run directory. `prelude` runs first in each directory helper.
interface Swap { pattern: RegExp; outside: string; after: number; seen: number; state: "idle" | "armed" | "swapped" | "restored"; path?: string }
const identity = vi.hoisted(() => ({ shift: 0n, delayMs: 0, shiftOnAttemptDirectory: false, shiftOnAttemptCheck: false, attemptChecks: 0, runChecks: 0, lstatDelayMs: 0, swap: undefined as Swap | undefined, beforeRemove: undefined as ((directory: string) => Promise<void>) | undefined, prelude: undefined as string | undefined }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const spawn = ((command: string, args: string[], options: object) => actual.spawn(command, identity.prelude && args[0] === "-e" ? ["-e", `{${identity.prelude}}\n${args[1]}`] : args, options)) as typeof actual.spawn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const stat = (async (...args: Parameters<typeof actual.stat>) => {
    if (identity.delayMs) await new Promise(resolve => setTimeout(resolve, identity.delayMs));
    const info = await actual.stat(...args);
    return typeof info.ino === "bigint" && identity.shift ? Object.assign(info, { ino: info.ino + identity.shift }) : info;
  }) as typeof actual.stat;
  // Directory checks may be slow. A reinstall may finish while the first attempt's files are written (at the run
  // directory's check that starts them, after its check at creation), or during the first check of that attempt's directory.
  const lstat = (async (...args: Parameters<typeof actual.lstat>) => {
    const { swap } = identity;
    const target = String(args[0]);
    if (swap?.state === "swapped" && target === swap.path) { await actual.rm(target, { force: true }); await actual.rename(`${target}.real`, target); swap.state = "restored"; }
    if (identity.lstatDelayMs) await new Promise(resolve => setTimeout(resolve, identity.lstatDelayMs));
    if (identity.shiftOnAttemptDirectory && /reviewfn-cli-(?!test-)[^/]+$/.test(target) && ++identity.runChecks === 2) identity.shift = 1n;
    if (identity.shiftOnAttemptCheck && /attempt-1-[^/]+$/.test(target) && ++identity.attemptChecks === 1) identity.shift = 1n;
    const found = await actual.lstat(...args);
    if (swap?.state === "armed" && swap.pattern.test(target) && ++swap.seen === swap.after) {
      swap.path = target;
      await actual.rename(target, `${target}.real`);
      // An empty `outside` leaves the name missing.
      if (swap.outside) await actual.symlink(swap.outside, target);
      swap.state = "swapped";
    }
    return found;
  }) as typeof actual.lstat;
  return { ...actual, stat, lstat, default: { ...actual, stat, lstat } };
});
vi.mock("@superfunctions/reviewfn-core", async importOriginal => {
  const actual = await importOriginal<typeof import("@superfunctions/reviewfn-core")>();
  const runProcessGroup: typeof actual.runProcessGroup = async (command, args, options) => {
    if (identity.beforeRemove && args[0] === "-e" && (JSON.parse(options.stdin ?? "{}") as { op?: string }).op === "remove") await identity.beforeRemove(options.cwd);
    return actual.runProcessGroup(command, args, options);
  };
  return { ...actual, runProcessGroup };
});

const CREDENTIAL = "reviewfn-cli-fixture-credential-5521";
const ALLOWED_SECRET = "allowlisted-secret-value-9034";
const MODEL = "fake model; rm -rf ~";

interface Call { argv: string[]; env: Record<string, string>; cwd: string; prompt: string; stdin: string }

let directory: string, state: string, workspace: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-test-"));
  state = path.join(directory, "state");
  // A workspace path with spaces and `;` must still reach the CLI as one argument.
  workspace = path.join(directory, "work space; echo pwned");
  await mkdir(state);
  await mkdir(workspace);
});
afterEach(async () => { Object.assign(identity, { shift: 0n, delayMs: 0, shiftOnAttemptDirectory: false, shiftOnAttemptCheck: false, attemptChecks: 0, runChecks: 0, lstatDelayMs: 0, swap: undefined, beforeRemove: undefined, prelude: undefined }); await rm(directory, { recursive: true, force: true }); });

const environment = () => ({ PATH: process.env.PATH, HOME: "/home/operator", ALLOWED_ONE: "one", FIXTURE_API_KEY: ALLOWED_SECRET, OTHER_VAR: "other", GITHUB_TOKEN: "publication-private-token", REVIEW_AUTH: CREDENTIAL });

function profile(overrides: Partial<HarnessProfile> & { extra?: string[] } = {}): HarnessProfile {
  const { extra = [], ...rest } = overrides;
  const promptVia = rest.promptVia ?? "stdin";
  const outputVia = rest.outputVia ?? "stdout-last-json";
  return {
    argv: [...LAUNCH, "--state", state, ...(promptVia === "file" ? ["--prompt", "{promptFile}"] : []), ...(outputVia === "file" ? ["--out", "{outputFile}"] : []), ...extra],
    promptVia, outputVia, envAllowlist: ["ALLOWED_ONE"], modelReport: "none",
    capabilities: { structuredOutput: false, sandbox: "tree-verified-only" }, versionArgv: [...LAUNCH, "--version"],
    ...rest,
  };
}

function configuration(definition: HarnessProfile, model = MODEL): ReviewFnConfig {
  return { ...DEFAULT_CONFIG, harness: { adapter: "cli", version: "1", executable: AGENT, profile: "fake", profileDefinition: definition }, inference: { provider: "fixture", model, auth: "api-key", credentialEnv: "REVIEW_AUTH" } };
}

function input(config: ReviewFnConfig, extra: Partial<SlotHarnessInput> = {}): SlotHarnessInput {
  return {
    runId: "run", workspace,
    change: { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBaseCommit: "a".repeat(40), diffDigest: "c".repeat(64), changedPaths: ["src/index.ts"], capturedAt: "2026-01-01T00:00:00.000Z" },
    context: { version: 1, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 1, maxBytes: 1, maxDepth: 1 }, incompleteReasons: [], digest: "d".repeat(64) },
    policy: DEFAULT_POLICY, configuration: config, testReceipts: [], prompt: "Review the change.", outputSchema: lensOutputSchema,
    slot: { id: "slot", stage: 1, harness: { adapter: "cli", version: "1.2.3", executable: AGENT, profile: "fake" }, inference: config.inference, lens: "general", budget: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 } },
    ...extra,
  };
}

async function calls(): Promise<Call[]> {
  const text = await readFile(path.join(state, "calls.jsonl"), "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Call);
}

const run = (definition: HarnessProfile, model?: string, extra?: Partial<SlotHarnessInput>) => new CliHarnessAdapter({ environment: environment() }).run(input(configuration(definition, model), extra));

describe("CliHarnessAdapter prompt and output channels", () => {
  it.each([["stdin", "stdout-last-json"], ["stdin", "file"], ["file", "stdout-last-json"], ["file", "file"]] as const)("completes with promptVia %s and outputVia %s", async (promptVia, outputVia) => {
    const output = await run(profile({ promptVia, outputVia }));
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(output.inspectedPaths).toEqual(["src/index.ts"]);
    expect(output.observed).toEqual({ harnessVersion: "1.2.3", limitations: ["model_unverified", "sandbox_tree_verified_only"] });
    const [call] = await calls();
    expect(call.prompt).toContain("Review the change.");
    expect(call.prompt).toContain("Output contract");
    expect(call.stdin).toBe(promptVia === "stdin" ? call.prompt : "");
    expect(call.cwd).toBe(await realpath(workspace));
    expect(await calls()).toHaveLength(1);
  }, 20_000);

  it("takes the last stdout line that parses as a JSON object, ignoring progress lines before and text after it", async () => {
    expect(lastJsonObjectLine('Thinking...\n{"type":"progress"}\n{"answer":1}\n[1,2]\n{"broken": \ndone\n')).toEqual({ answer: 1 });
    expect(lastJsonObjectLine("only text\n[1]\n")).toBeUndefined();
    // The fixture prints a JSON progress object and a truncated object before its answer: the answer is what completes.
    const output = await run(profile());
    expect(output.terminal).toBe("completed");
    expect(output.transcript).toContain('{"type":"progress","step":1}');
  }, 20_000);

  it("refuses an output file that is too large for the output budget as an overrun", async () => {
    const output = await run(profile({ outputVia: "file" }), undefined, { policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 60 } } });
    expect(output.terminal).toBe("timed_out");
  }, 20_000);

  it.each([["without", []], ["with", ["--stderr", "rate limit exceeded"]]] as const)("ends an oversized output file timed_out even after a fast nonzero exit, %s quota stderr", async (_name, stderr) => {
    const output = await run(profile({ outputVia: "file", extra: ["--exit", "3", "--extra-json", JSON.stringify({ pad: "x".repeat(8_000) }), ...stderr] }), undefined, { policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 4_000 } } });
    expect(output.terminal).toBe("timed_out");
    // The run-time watcher or the post-exit size check may see the overrun first; either names the output file overrun.
    expect(output.error).toMatch(/output file .*(exceeded|grew past) the remaining/);
  }, 20_000);

  it("kills a CLI that keeps appending to its output file as soon as the file outgrows the budget, as a timeout", async () => {
    const started = Date.now();
    const output = await run(profile({ outputVia: "file", extra: ["--flood", "1"] }), undefined, { policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 200_000, harnessTimeoutMs: 60_000 } } });
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toContain("while it ran");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("kills a CLI whose stdout and output file are each under the budget but together over it, then hangs, as a timeout", async () => {
    const started = Date.now();
    const output = await run(profile({ outputVia: "file", extra: ["--mixed", "60000"] }), undefined, { policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 100_000, harnessTimeoutMs: 60_000 } } });
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/grew past the remaining .* of stdout and stderr while it ran/);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("kills a stdout-last-json CLI that floods the {outputFile} its argv is given, then hangs, as a timeout", async () => {
    const started = Date.now();
    const output = await run(profile({ extra: ["--out", "{outputFile}", "--flood", "1"] }), undefined, { policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 200_000, harnessTimeoutMs: 60_000 } } });
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toContain("while it ran");
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});

describe("CliHarnessAdapter process boundary", () => {
  it("passes every placeholder value, even with spaces or ';', as exactly one argument", async () => {
    const definition = profile({ extra: ["--schema", "{schemaFile}", "--workspace", "{workspace}", "--model", "{model}", "--literal", "a b; c"] });
    expect((await run(definition)).terminal).toBe("completed");
    const [call] = await calls();
    expect(call.argv).toHaveLength(definition.argv.length - LAUNCH.length);
    expect(call.argv.slice(2)).toEqual(["--schema", expect.stringMatching(/schema\.json$/), "--workspace", workspace, "--model", MODEL, "--literal", "a b; c"]);
    expect(cliArguments(["{model}", "x{model}", "{workspace}", "{unknown}"], { promptFile: "p", schemaFile: "s", outputFile: "o", workspace: "/w s;x", model: "m; n" })).toEqual(["m; n", "x{model}", "/w s;x", "{unknown}"]);
  }, 20_000);

  it("gives the CLI only the allowlisted variables and the credential", async () => {
    expect((await run(profile())).terminal).toBe("completed");
    const [call] = await calls();
    // macOS may add its own __CF_* variable to a process at launch; nothing else may appear.
    expect(Object.keys(call.env).filter(name => !name.startsWith("__CF_")).sort()).toEqual(["ALLOWED_ONE", "REVIEW_AUTH"]);
    expect(cliEnvironment({ A: "1", B: "2", C: undefined }, ["A", "C", "bad-name"], "B")).toEqual({ A: "1", B: "2" });
  }, 20_000);

  it("redacts the credential and secret-named allowlisted values from the error and transcript", async () => {
    const definition = profile({ envAllowlist: ["ALLOWED_ONE", "FIXTURE_API_KEY"], extra: ["--stderr", `failed with ${CREDENTIAL} and ${ALLOWED_SECRET}`, "--exit", "3"] });
    const output = await run(definition);
    expect(output.terminal).toBe("failed");
    const stored = JSON.stringify(output);
    expect(stored).not.toContain(CREDENTIAL);
    expect(stored).not.toContain(ALLOWED_SECRET);
    expect(output.error).toContain("[REDACTED]");
  }, 20_000);

  it.skipIf(process.platform === "win32")("ends timed_out and kills the whole process group", async () => {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const output = await run(profile({ extra: ["--hang", "1"] }), undefined, { policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 1_500 } } });
    expect(output.terminal).toBe("timed_out");
    const pid = Number((await readFile(path.join(state, "descendant.pid"), "utf8")).trim());
    expect(pid).toBeGreaterThan(0);
    let dead = false;
    for (const started = Date.now(); !dead && Date.now() - started < 5_000; await new Promise(resolve => setTimeout(resolve, 25))) dead = !alive(pid);
    expect(dead).toBe(true);
  }, 20_000);

  it("refuses pull-request reviews before any process starts", async () => {
    const base = input(configuration(profile()));
    const output = await new CliHarnessAdapter({ environment: environment() }).run({ ...base, change: { ...base.change, pullRequest: 4 } });
    expect(output.terminal).toBe("failed");
    expect(await calls()).toEqual([]);
  });
  it.skipIf(process.platform === "win32")("writes each attempt's prompt to a new file, never through a link the CLI planted for the repair attempt", async () => {
    const target = path.join(directory, "target.txt");
    await writeFile(target, "untouched");
    const prompts: string[] = [];
    const runner: CommandRunner = async (command, args, options) => {
      const result = await runProcessGroup(command, args, options);
      if (!args.includes("--prompt")) return result;
      const prompt = args[args.indexOf("--prompt") + 1];
      prompts.push(prompt);
      if (prompts.length === 1) {
        // The CLI can write its run directory: it replaces its prompt file and plants links at every name it can guess.
        for (const file of [prompt, ...["prompt.md", "prompt-2.md", "schema.json", "output.json"].flatMap(name => [path.join(path.dirname(prompt), name), path.join(path.dirname(path.dirname(prompt)), name)])]) {
          await rm(file, { force: true });
          await symlink(target, file);
        }
      }
      return result;
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ promptVia: "file", extra: ["--answer", "invalid-once"] }))));
    expect(await readFile(target, "utf8")).toBe("untouched");
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(path.dirname(prompts[1])).not.toBe(path.dirname(prompts[0]));
    expect((await calls())[1].prompt).toContain("Repair: your previous answer was rejected");
  }, 30_000);

  it("never completes a repair attempt with an answer the first attempt planted at a path it could predict", async () => {
    const outputs: string[] = [];
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      const out = args[args.indexOf("--out") + 1];
      outputs.push(out);
      if (outputs.length === 1) {
        // A malformed answer, and a valid one at the next attempt's predictable name, beside its own and in the run directory.
        await writeFile(out, JSON.stringify({ findings: "none" }));
        const valid = JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
        for (const dir of [path.dirname(out), path.dirname(path.dirname(out))]) for (const name of ["output-2.json", "output.json"]) await writeFile(path.join(dir, name), valid, { flag: "a" });
      }
      // The repair attempt exits 0 without writing its output file.
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(outputs).toHaveLength(2);
    expect(path.dirname(outputs[1])).not.toBe(path.dirname(outputs[0]));
    expect(output.terminal).toBe("malformed");
    expect(output.error).toContain("wrote no output file");
  });

  it("shows the repair attempt the original schema even when the first attempt rewrote its schema file", async () => {
    const schemas: string[] = [];
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      const schemaFile = args[args.indexOf("--schema") + 1];
      schemas.push(await readFile(schemaFile, "utf8"));
      if (schemas.length === 1) await writeFile(schemaFile, JSON.stringify({ type: "object", description: "tampered" }));
      const answer = schemas.length === 1 ? { findings: "none" } : { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] };
      return { code: 0, signal: null, stdout: `${JSON.stringify(answer)}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ extra: ["--schema", "{schemaFile}"] }))));
    expect(output.terminal).toBe("completed");
    expect(schemas).toHaveLength(2);
    expect(schemas[1]).toBe(schemas[0]);
    expect(schemas[1]).not.toContain("tampered");
  });

  it.each(["stdin", "file"] as const)("redacts the credential from the rejected answer the repair prompt echoes (prompt via %s)", async promptVia => {
    const prompts: string[] = [];
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      prompts.push(promptVia === "file" ? await readFile(args[args.indexOf("--prompt") + 1], "utf8") : options.stdin ?? "");
      const answer = prompts.length === 1 ? { findings: `leaked ${CREDENTIAL} and ${ALLOWED_SECRET}` } : { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] };
      return { code: 0, signal: null, stdout: `${JSON.stringify(answer)}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ promptVia, envAllowlist: ["ALLOWED_ONE", "FIXTURE_API_KEY"] }))));
    expect(output.terminal).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Repair: your previous answer was rejected");
    expect(prompts[1]).toContain('{"findings":"leaked [REDACTED] and [REDACTED]"}');
    expect(prompts[1]).not.toContain(CREDENTIAL);
    expect(prompts[1]).not.toContain(ALLOWED_SECRET);
  });

  it.each(["stdout-last-json", "file"] as const)("redacts a credential the CLI echoes JSON-escaped, from the transcript and the repair prompt (output via %s)", async outputVia => {
    // A credential with a quote, a backslash and a slash, which a JSON string writes escaped.
    const credential = ["test-credential", '"quoted"', "\\back\\slash/x", "<&>\u00e9"].join("-");
    const prompts: string[] = [];
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      prompts.push(options.stdin ?? "");
      const echoed = JSON.stringify({ echo: credential });
      const answer = JSON.stringify(prompts.length === 1 ? { findings: `leaked ${credential}` } : { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
      if (outputVia === "file") await writeFile(args[args.indexOf("--out") + 1], answer);
      // As other encoders write it too: HTML-safe escapes of <, > and & (Go), and every unit as an uppercase \uXXXX.
      const htmlSafe = echoed.replaceAll(/[<>&]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
      const upper = `{"echo":"${[...credential].map(char => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`).join("")}"}`;
      const stdout = [echoed, echoed.replaceAll("/", "\\/"), htmlSafe, upper, ...(outputVia === "file" ? [] : [answer])].join("\n");
      return { code: 0, signal: null, stdout: `${stdout}\n`, stderr: `${echoed}\n`, timedOut: false, canceled: false };
    };
    // An allowlisted secret that is a prefix of the credential must not hide the rest of it from the JSON-aware pass.
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: credential, FIXTURE_API_KEY: "test-credential" }, runner }).run(input(configuration(profile({ outputVia, envAllowlist: ["ALLOWED_ONE", "FIXTURE_API_KEY"] }))));
    expect(output.terminal).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('{"findings":"leaked [REDACTED]"}');
    for (const text of [output.transcript ?? "", prompts[1]]) {
      expect(text).not.toContain(credential);
      expect(text).not.toContain(JSON.stringify(credential).slice(1, -1));
      // No JSON object line, once parsed, holds the credential either.
      const lines = text.split("\n").filter(line => line.startsWith("{"));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(Object.values(JSON.parse(line) as Record<string, unknown>).map(String).join("\n")).not.toMatch(/quoted|slash|credential/);
    }
  });

  it("redacts in linear time, without throwing, a credential of many backslashes the output nearly repeats and a long secret", async () => {
    const credential = `test-${"\\".repeat(22)}x`;
    const long = `test-${"long-value-".repeat(400)}`;
    const text = `${`test-${"\\\\".repeat(22)}y `.repeat(20)}${JSON.stringify({ echo: `${long}"` })}`;
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout: `${text}\n${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    const started = Date.now();
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: credential, FIXTURE_API_KEY: long }, runner }).run(input(configuration(profile({ envAllowlist: ["ALLOWED_ONE", "FIXTURE_API_KEY"] }))));
    expect(output.terminal).toBe("completed");
    expect(output.transcript).not.toContain("long-value-");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("redacts the whole span where two secrets overlap, as written and JSON-escaped", async () => {
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout: `test-prefix-long-value\n{"echo":"test-prefix\\u002Dlong-value"}\n${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: "test-prefix", FIXTURE_API_KEY: "prefix-long-value" }, runner }).run(input(configuration(profile({ envAllowlist: ["ALLOWED_ONE", "FIXTURE_API_KEY"] }))));
    expect(output.terminal).toBe("completed");
    expect(output.transcript).toContain('[REDACTED]\n{"echo":"[REDACTED]"}');
    expect(output.transcript).not.toMatch(/test-|long-value/);
  });

  it("ends a run canceled when the caller aborts after the CLI exited, while its answer is read", async () => {
    const controller = new AbortController();
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      await writeFile(args[args.indexOf("--out") + 1], JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] }));
      // The process has exited successfully; the caller cancels before the adapter reads its answer.
      controller.abort();
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" })), { signal: controller.signal }));
    expect(output.terminal).toBe("canceled");
    expect(output.findings).toEqual([]);
  });

  it.each([["aborts", 60_000], ["lets the deadline pass", 300]] as const)("keeps the mismatched model a file answer reported when the caller %s before it is read", async (_case, harnessTimeoutMs) => {
    const controller = new AbortController();
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      await writeFile(args[args.indexOf("--out") + 1], JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [], model: "other-model" }));
      if (harnessTimeoutMs === 60_000) controller.abort(); else await new Promise(resolve => setTimeout(resolve, 400));
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file", modelReport: "json-path:model" }), "fake-model-1"), { signal: controller.signal, policy }));
    expect(output.terminal).toBe(harnessTimeoutMs === 60_000 ? "canceled" : "timed_out");
    expect(output.observed).toMatchObject({ model: "other-model", modelMismatch: true });
  });

  it("writes no prompt file when the CLI reads its prompt on stdin and is not given {promptFile}", async () => {
    const listed: string[][] = [];
    const runner: CommandRunner = async (command, args, options) => {
      const result = await runProcessGroup(command, args, options);
      if (args.includes("--out")) listed.push(await readdir(path.dirname(args[args.indexOf("--out") + 1])));
      return result;
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ promptVia: "stdin", outputVia: "file", extra: ["--answer", "invalid-once"] }))));
    expect(output.terminal).toBe("completed");
    expect(listed).toHaveLength(2);
    for (const names of listed) expect(names.filter(name => name.startsWith("prompt"))).toEqual([]);
  }, 30_000);
});

describe("CliHarnessAdapter model reporting", () => {
  it("reports no model and records model_unverified with modelReport none", async () => {
    const clean = await run(profile());
    expect(clean.observed?.model).toBeUndefined();
    expect(clean.observed?.limitations).toContain("model_unverified");
  }, 30_000);

  it.each([
    ["json-path:model", ["--model-json"]],
    ["stderr-regex:served model: (\\S+)", ["--model-stderr"]],
  ] as const)("with %s, confirms the configured model and reports a mismatch as the served model", async (modelReport, flag) => {
    const matching = await run(profile({ modelReport, extra: [...flag, "fake-model-1"] }), "fake-model-1");
    expect(matching.terminal).toBe("completed");
    expect(matching.observed).toMatchObject({ model: "fake-model-1" });
    expect(matching.observed?.limitations).toEqual(["sandbox_tree_verified_only"]);
    const mismatched = await run(profile({ modelReport, extra: [...flag, "other-model"] }), "fake-model-1");
    expect(mismatched.terminal).toBe("failed");
    expect(mismatched.error).toMatch(/^model_mismatch/);
    expect(mismatched.observed).toMatchObject({ model: "other-model" });
    const silent = await run(profile({ modelReport }), "fake-model-1");
    expect(silent.terminal).toBe("failed");
    expect(silent.error).toContain("not confirmed");
  }, 30_000);

  it.each([
    ["a stderr report, then a hang", "stderr-regex:served model: (\\S+)", ["--model-stderr", "other-model", "--hang", "1"], "timed_out"],
    ["a json report, then a nonzero exit", "json-path:model", ["--model-json", "other-model", "--exit", "3"], "failed"],
    ["a json report in the output file, then a nonzero exit", "json-path:model", ["--model-json", "other-model", "--exit", "3"], "failed", "file"],
  ] as const)("reports the served model of %s, so the panel voids it", async (_name, modelReport, extra, terminal, outputVia = "stdout-last-json") => {
    const output = await run(profile({ modelReport, outputVia, extra: [...extra] }), "fake-model-1", { policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 1_500 } } });
    expect(output.terminal).toBe(terminal);
    expect(output.observed).toMatchObject({ model: "other-model" });
  }, 30_000);

  it.each([
    ["json-path:model", "--model-json", "truncation", `${"a".repeat(256)}…`, `${"a".repeat(256)}b`],
    ["stderr-regex:served model: (\\S+)", "--model-stderr", "truncation", `${"a".repeat(256)}…`, `${"a".repeat(256)}b`],
    ["json-path:model", "--model-json", "redaction", "[REDACTED]", CREDENTIAL],
    ["stderr-regex:served model: (\\S+)", "--model-stderr", "redaction", "[REDACTED]", CREDENTIAL],
  ] as const)("with %s, flags a mismatch whose stored model reads as the configured one after %s", async (modelReport, flag, _collision, configured, reported) => {
    const output = await run(profile({ modelReport, extra: [flag, reported] }), configured);
    expect(output.error).toMatch(/^model_mismatch/);
    expect(output.observed).toMatchObject({ model: configured, modelMismatch: true });
    expect(JSON.stringify(output)).not.toContain(CREDENTIAL);
    const matching = await run(profile({ modelReport, extra: [flag, "fake-model-1"] }), "fake-model-1");
    expect(matching.terminal).toBe("completed");
    expect(matching.observed?.modelMismatch).toBeUndefined();
  }, 30_000);

  it("ends a run whose stderr-regex reporter backtracks without end timed_out, without blocking the event loop", async () => {
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 50);
    const started = Date.now();
    const output = await run(profile({ modelReport: String.raw`stderr-regex:^(?:a+)+(b)$`, extra: ["--stderr", `${"a".repeat(40)}!`] }), "fake-model-1");
    clearInterval(ticker);
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toContain("model reporter did not finish");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(ticks).toBeGreaterThan(10);
  }, 30_000);

  it("stops a stalled reporter as soon as the run is canceled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const stalled = matchReporter(`${"a".repeat(40)}!`, "^(?:a+)+(b)$", "fake-model-1", 60_000, controller.signal);
    setTimeout(() => controller.abort(), 200);
    expect(await stalled).toMatchObject({ terminal: "canceled" });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it("keeps only the first, first mismatching and last captures, so overlapping captures cannot grow quadratically", async () => {
    expect(await matchReporter("served model: m1\nserved model: m2\nserved model: m1\n", String.raw`served model: (\S+)`, "m1", 60_000)).toEqual({ first: "m1", mismatch: "m2", last: "m1" });
    const overlapping = await matchReporter("a".repeat(4_000), "(?=(a+))", "m1", 60_000);
    expect(overlapping).toMatchObject({ first: "a".repeat(4_000), last: "a" });
    expect(JSON.stringify(overlapping).length).toBeLessThan(3 * 4_000 + 200);
  }, 20_000);

  it("keeps the models a reporter matched before it stalled, so an earlier mismatch still voids the run", async () => {
    const reporter = String.raw`served model: (\S+)|(?:a+)+$`;
    const partial = await matchReporter(`served model: other-model\n${"a".repeat(40)}!`, reporter, "fake-model-1", 500);
    expect(partial).toMatchObject({ first: "other-model", mismatch: "other-model", terminal: "timed_out" });
    const output = await run(profile({ modelReport: `stderr-regex:${reporter}`, extra: ["--model-stderr", "other-model", "--stderr", `${"a".repeat(40)}!`] }), "fake-model-1");
    expect(output.terminal).toBe("timed_out");
    expect(output.observed).toMatchObject({ model: "other-model", modelMismatch: true });
  }, 30_000);

  it("returns the reporter's captures promptly after an abort at the panel's slot deadline", async () => {
    const controller = new AbortController();
    // The panel's deadline aborts with a TimeoutError just as the CLI finishes.
    const runner: CommandRunner = async (command, args, options) => {
      const result = await runProcessGroup(command, args, { ...options, signal: undefined });
      if (args.includes("--state")) controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
      return result;
    };
    const started = Date.now();
    const config = configuration(profile({ modelReport: String.raw`stderr-regex:served model: (\S+)|(?:a+)+$`, extra: ["--model-stderr", "other-model", "--stderr", `${"a".repeat(40)}!`] }), "fake-model-1");
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(config, { signal: controller.signal }));
    expect(output.terminal).toBe("timed_out");
    expect(output.observed).toMatchObject({ model: "other-model", modelMismatch: true });
    expect(output.error).toContain("deadline");
    expect(Date.now() - started).toBeLessThan(1_900);
  }, 30_000);

  it("bounds a stderr-regex reporter by the run's own deadline, with no caller signal, keeping its earlier mismatch", async () => {
    // The CLI returns at once, so only the stalled reporter can use up the 1.2 s harness timeout.
    const runner: CommandRunner = async (_command, args) => ({ code: 0, signal: null, stdout: args.includes("--version") ? "fake-cli version 1.2.3\n" : "", stderr: args.includes("--version") ? "" : `served model: other-model\n${"a".repeat(40)}!`, timedOut: false, canceled: false });
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 1_200 } };
    const config = configuration(profile({ modelReport: String.raw`stderr-regex:served model: (\S+)|(?:a+)+$` }), "fake-model-1");
    const started = Date.now();
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(config, { policy }));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toContain("model reporter did not finish");
    expect(output.observed).toMatchObject({ model: "other-model", modelMismatch: true });
    expect(Date.now() - started).toBeLessThan(1_200 + 500);
  }, 30_000);

  it("repairs an invalid answer that lacks its model report, and confirms the model only on the answer it accepts", async () => {
    const repaired = await run(profile({ modelReport: "json-path:model", extra: ["--answer", "invalid-once", "--model-json", "fake-model-1"] }), "fake-model-1");
    expect(repaired.terminal).toBe("completed");
    expect(repaired.observed).toMatchObject({ model: "fake-model-1" });
    expect(await calls()).toHaveLength(2);
    await rm(path.join(state, "calls.jsonl"));
    const malformed = await run(profile({ modelReport: "json-path:model", extra: ["--answer", "invalid", "--model-json", "fake-model-1"] }), "fake-model-1");
    expect(malformed.terminal).toBe("malformed");
    expect(await calls()).toHaveLength(2);
  }, 30_000);

  it("attributes a completed run to the model its accepted repair attempt reported, not the rejected attempt's", async () => {
    let attempt = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      attempt += 1;
      const answer = attempt === 1 ? { findings: "none", model: "model-a" } : { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [], model: "model-b" };
      return { code: 0, signal: null, stdout: `${JSON.stringify(answer)}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ modelReport: "json-path:model" }), "configured")));
    expect(output.terminal).toBe("completed");
    expect(attempt).toBe(2);
    expect(output.observed?.model).toBe("model-b");
    expect(output.observed?.modelMismatch).toBeUndefined();
  });

  it("shows a schema-enforcing CLI a schema that declares its json-path model report, and validates the answer without it", async () => {
    const enforcing = (extra: string[]) => profile({ modelReport: "json-path:model", capabilities: { structuredOutput: true, sandbox: "tree-verified-only" }, extra: ["--enforce-schema", "{schemaFile}", ...extra] });
    const matching = await run(enforcing(["--model-json", "fake-model-1"]), "fake-model-1");
    expect(matching.error).toBeUndefined();
    expect(matching.terminal).toBe("completed");
    expect(matching.observed).toMatchObject({ model: "fake-model-1" });
    const [call] = await calls();
    expect(call.prompt).toContain('"model":{"type":"string"}');
    const mismatched = await run(enforcing(["--model-json", "other-model"]), "fake-model-1");
    expect(mismatched.error).toMatch(/^model_mismatch/);
    expect(mismatched.observed).toMatchObject({ model: "other-model" });
    expect(lensOutputSchema.properties).not.toHaveProperty("model");
  }, 30_000);

  it("declares a nested json-path report field without changing a schema that already declares it", () => {
    const schema = { type: "object", additionalProperties: false, properties: { findings: { type: "array" } }, required: ["findings"] };
    expect(withModelReportField(schema, "json-path:meta.models.0")).toEqual({ ...schema, properties: { ...schema.properties, meta: { type: "object", properties: { models: { type: "array", minItems: 1, items: { type: "string" } } }, required: ["models"] } }, required: ["findings", "meta"] });
    expect(withModelReportField(schema, "json-path:findings")).toBe(schema);
    expect(withModelReportField(schema, "none")).toBe(schema);
    expect(schema.properties).not.toHaveProperty("meta");
  });

  it("declares a reporter leaf inside a closed parent object or array items the schema already declares", () => {
    const schema = { type: "object", properties: { meta: { type: "object", additionalProperties: false, properties: { source: { type: "string" } } }, runs: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] } } }, required: [] };
    const original = structuredClone(schema);
    expect(withModelReportField(schema, "json-path:meta.model")).toEqual({ ...schema, properties: { ...schema.properties, meta: { ...schema.properties.meta, properties: { source: { type: "string" } , model: { type: "string" } }, required: ["model"] } }, required: ["meta"] });
    expect(withModelReportField(schema, "json-path:runs.0.model")).toEqual({ ...schema, properties: { ...schema.properties, runs: { type: "array", items: { ...schema.properties.runs.items, properties: { id: { type: "string" }, model: { type: "string" } }, required: ["id", "model"] } } }, required: ["runs"] });
    expect(withModelReportField(schema, "json-path:meta.source")).toBe(schema);
    expect(schema).toEqual(original);
  });

  it("removes only the undeclared reporter leaf of a closed nested object, keeping its declared siblings", async () => {
    const outputSchema = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, meta: { type: "object", additionalProperties: false, properties: { source: { type: "string" } } } } };
    const output = await run(profile({ modelReport: "json-path:meta.model", extra: ["--extra-json", JSON.stringify({ meta: { source: "fixture", model: "fake-model-1" } })] }), "fake-model-1", { outputSchema });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(output.observed).toMatchObject({ model: "fake-model-1" });
    expect(await calls()).toHaveLength(1);
  }, 30_000);

  it("removes an array-item reporter from every item, and reads a numeric key of an object as a property", async () => {
    const item = { type: "object", additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"] };
    const listed = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, runs: { type: "array", items: item } } };
    const runs = [{ id: "a", model: "fake-model-1" }, { id: "b", model: "fake-model-1" }];
    const arrayReport = await run(profile({ modelReport: "json-path:runs.0.model", extra: ["--extra-json", JSON.stringify({ runs })] }), "fake-model-1", { outputSchema: listed });
    expect(arrayReport.error).toBeUndefined();
    expect(arrayReport.terminal).toBe("completed");
    expect(withModelReportField(lensOutputSchema, "json-path:0").properties).toHaveProperty("0", { type: "string" });
    await rm(path.join(state, "calls.jsonl"));
    const keyed = await run(profile({ modelReport: "json-path:0", extra: ["--extra-json", JSON.stringify({ 0: "fake-model-1" })] }), "fake-model-1");
    expect(keyed.error).toBeUndefined();
    expect(keyed.observed).toMatchObject({ model: "fake-model-1" });
    expect(await calls()).toHaveLength(1);
  }, 30_000);

  it("declares and removes a reporter inside a closed object without properties, and keeps one a $ref declares", async () => {
    const closed = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, meta: { type: "object", additionalProperties: false } } };
    expect(withModelReportField(closed, "json-path:meta.model").properties).toHaveProperty("meta", { type: "object", additionalProperties: false, properties: { model: { type: "string" } }, required: ["model"] });
    const answer = ["--extra-json", JSON.stringify({ meta: { model: "fake-model-1" } })];
    const closedRun = await run(profile({ modelReport: "json-path:meta.model", extra: answer }), "fake-model-1", { outputSchema: closed });
    expect(closedRun.error).toBeUndefined();
    expect(closedRun.terminal).toBe("completed");
    const referenced = { ...lensOutputSchema, $defs: { ...(lensOutputSchema as { $defs?: Record<string, unknown> }).$defs, meta: { type: "object", additionalProperties: false, properties: { model: { type: "string" } }, required: ["model"] } }, properties: { ...lensOutputSchema.properties, meta: { $ref: "#/$defs/meta" } } };
    expect(withModelReportField(referenced, "json-path:meta.model")).toBe(referenced);
    const referencedRun = await run(profile({ modelReport: "json-path:meta.model", extra: answer }), "fake-model-1", { outputSchema: referenced });
    expect(referencedRun.error).toBeUndefined();
    expect(referencedRun.terminal).toBe("completed");
  }, 30_000);

  it("declares the report on a closed schema whose allOf entries are trivial, and in a closing allOf branch", async () => {
    const wrapped = { ...lensOutputSchema, allOf: [{}, true] };
    expect(withModelReportField(wrapped, "json-path:model").properties).toHaveProperty("model", { type: "string" });
    const enforcing = (model: string) => profile({ modelReport: "json-path:model", capabilities: { structuredOutput: true, sandbox: "tree-verified-only" }, extra: ["--enforce-schema", "{schemaFile}", "--model-json", model] });
    const matching = await run(enforcing("fake-model-1"), "fake-model-1", { outputSchema: wrapped });
    expect(matching.error).toBeUndefined();
    expect(matching.terminal).toBe("completed");
    expect(matching.observed).toMatchObject({ model: "fake-model-1" });
    expect(await calls()).toHaveLength(1);
    expect((await calls())[0].prompt).toContain('"model":{"type":"string"}');
    expect((await run(enforcing("other-model"), "fake-model-1", { outputSchema: wrapped })).error).toMatch(/^model_mismatch/);
    const branch = { type: "object", additionalProperties: false, properties: { source: { type: "string" } } };
    const composed = { type: "object", properties: { meta: { type: "object", allOf: [branch] } } };
    const declaredBranch = { ...branch, properties: { source: { type: "string" }, model: { type: "string" } }, required: ["model"] };
    expect(withModelReportField(composed, "json-path:meta.model")).toEqual({ ...composed, properties: { meta: { type: "object", allOf: [declaredBranch], properties: { model: { type: "string" } }, required: ["model"] } }, required: ["meta"] });
  }, 30_000);

  it.each([
    ["schema-valued additionalProperties", { type: "object", additionalProperties: { type: "string" }, minProperties: 1 }],
    ["patternProperties", { type: "object", patternProperties: { "^model$": { type: "string" } }, additionalProperties: false, minProperties: 1 }],
    ["additionalProperties: true", { type: "object", additionalProperties: true, minProperties: 1 }],
  ])("keeps a nested report field the schema allows through %s, completing in one call", async (name, meta) => {
    const outputSchema = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, meta }, required: [...lensOutputSchema.required, "meta"] };
    const shown = withModelReportField(outputSchema, "json-path:meta.model");
    // A pattern schema is shared by every key it matches, so a pattern-owned report is shown as the slot wrote it.
    if (name === "patternProperties") expect(shown).toBe(outputSchema);
    else expect(shown.properties).toHaveProperty("meta", expect.objectContaining({ properties: expect.objectContaining({ model: expect.objectContaining({ type: "string" }) }), required: ["model"] }));
    const answer = (model: string) => profile({ modelReport: "json-path:meta.model", extra: ["--extra-json", JSON.stringify({ meta: { model } })] });
    const output = await run(answer("fake-model-1"), "fake-model-1", { outputSchema });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(output.observed).toMatchObject({ model: "fake-model-1" });
    expect(await calls()).toHaveLength(1);
    const mismatched = await run(answer("other-model"), "fake-model-1", { outputSchema });
    expect(mismatched.error).toMatch(/^model_mismatch/);
    expect(mismatched.observed).toMatchObject({ model: "other-model", modelMismatch: true });
  }, 30_000);

  it.each([
    ["open to any property", { ...lensOutputSchema, additionalProperties: true }],
    ["open to string properties", { ...lensOutputSchema, additionalProperties: { type: "string" } }],
    ["without additionalProperties", (({ additionalProperties: _open, ...rest }) => rest)(lensOutputSchema)],
  ])("declares the report to a CLI that emits only declared properties when the schema is %s", async (_name, outputSchema) => {
    const enforcing = (model: string) => profile({ modelReport: "json-path:model", capabilities: { structuredOutput: true, sandbox: "tree-verified-only" }, extra: ["--enforce-schema", "{schemaFile}", "--model-json", model] });
    expect(withModelReportField(outputSchema, "json-path:model")).toMatchObject({ properties: { model: { type: "string" } }, required: expect.arrayContaining(["model"]) });
    const matching = await run(enforcing("fake-model-1"), "fake-model-1", { outputSchema });
    expect(matching.error).toBeUndefined();
    expect(matching.terminal).toBe("completed");
    expect(await calls()).toHaveLength(1);
    expect((await run(enforcing("other-model"), "fake-model-1", { outputSchema })).error).toMatch(/^model_mismatch/);
  }, 30_000);

  it.each([
    ["an uninspected item", "uninspected", { scope: "review", reason: "fixture" }, { type: "object", required: ["scope", "reason"], properties: { scope: { type: "string" }, reason: { type: "string" } } }],
    ["an evidence item", "evidence", { id: "e1", kind: "diff", description: "fixture" }, { type: "object", required: ["id", "kind", "description"], properties: { id: { type: "string" }, kind: { type: "string" }, description: { type: "string" } } }],
  ] as const)("keeps a report the caller's schema allows inside %s out of the payload", async (_name, section, item, items) => {
    const outputSchema = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, [section]: { type: "array", items } } };
    const answer = (model: string) => profile({ modelReport: `json-path:${section}.0.model`, extra: ["--extra-json", JSON.stringify({ [section]: [{ ...item, model }] })] });
    const output = await run(answer("fake-model-1"), "fake-model-1", { outputSchema });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(output.observed).toMatchObject({ model: "fake-model-1" });
    expect(output[section]).toEqual([item]);
    expect(await calls()).toHaveLength(1);
    const mismatched = await run(answer("other-model"), "fake-model-1", { outputSchema });
    expect(mismatched.error).toMatch(/^model_mismatch/);
    expect(mismatched.observed).toMatchObject({ model: "other-model", modelMismatch: true });
  }, 30_000);

  it.each([
    ["in the items of an allOf-wrapped array", "runs", "runs.0.model", { allOf: [{ type: "array", items: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } }] }, (model: string) => [{ id: "r1", model }]],
    ["in the items of an array's allOf branch", "runs", "runs.0.model", { type: "array", allOf: [{ items: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } }] }, (model: string) => [{ id: "r1", model }]],
    ["in both an array's own items and its allOf branch's", "runs", "runs.0.model", { type: "array", items: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false }, allOf: [{ items: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } }] }, (model: string) => [{ id: "r1", model }]],
  ] as const)("shows a contract that accepts a report %s, and removes it where the slot's schema forbids it", async (_name, field, dotted, schema, value) => {
    const outputSchema = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, [field]: schema } };
    const valid = { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] };
    const shown = withModelReportField(outputSchema, `json-path:${dotted}`);
    expect(structuredOutputValidator(shown)({ ...valid, [field]: value("m") })).toEqual([]);
    const answer = (model: string) => profile({ modelReport: `json-path:${dotted}`, extra: ["--extra-json", JSON.stringify({ [field]: value(model) })] });
    const output = await run(answer("fake-model-1"), "fake-model-1", { outputSchema });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(await calls()).toHaveLength(1);
    expect((await run(answer("other-model"), "fake-model-1", { outputSchema })).error).toMatch(/^model_mismatch/);
  }, 30_000);

  it("shows a top-level report a pattern owns unchanged, and confirms the model a CLI reports there", async () => {
    const outputSchema = { ...lensOutputSchema, patternProperties: { "^model$": { type: "string" } } };
    expect(withModelReportField(outputSchema, "json-path:model")).toBe(outputSchema);
    const reporting = (model: string) => profile({ modelReport: "json-path:model", extra: ["--model-json", model] });
    const matching = await run(reporting("fake-model-1"), "fake-model-1", { outputSchema });
    expect(matching.error).toBeUndefined();
    expect(matching.terminal).toBe("completed");
    expect(await calls()).toHaveLength(1);
    expect((await run(reporting("other-model"), "fake-model-1", { outputSchema })).error).toMatch(/^model_mismatch/);
  }, 30_000);

  it("keeps a pattern's restrictions on every sibling key, removing only the named report where the pattern closes it", async () => {
    const meta = { type: "object", patternProperties: { "^run": { type: "object", properties: { source: { type: "string" } }, additionalProperties: false } }, additionalProperties: false };
    const outputSchema = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, meta } };
    const shown = withModelReportField(outputSchema, "json-path:meta.run1.model");
    expect(shown).toBe(outputSchema);
    // The schema shown to the CLI compiles under strict Ajv and still refuses a report under a sibling key.
    const valid = { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] };
    expect(structuredOutputValidator({ ...shown })({ ...valid, meta: { run1: { source: "a" }, run2: { source: "b" } } })).toEqual([]);
    expect(structuredOutputValidator({ ...shown })({ ...valid, meta: { run1: { source: "a" }, run2: { source: "b", model: "m" } } })).not.toEqual([]);
    const answer = (value: unknown) => profile({ modelReport: "json-path:meta.run1.model", extra: ["--extra-json", JSON.stringify({ meta: value })] });
    const named = await run(answer({ run1: { source: "a", model: "fake-model-1" }, run2: { source: "b" } }), "fake-model-1", { outputSchema });
    expect(named.error).toBeUndefined();
    expect(named.terminal).toBe("completed");
    expect(named.observed).toMatchObject({ model: "fake-model-1" });
    const sibling = await run(answer({ run1: { source: "a", model: "fake-model-1" }, run2: { source: "b", model: "fake-model-1" } }), "fake-model-1", { outputSchema });
    expect(sibling.terminal).toBe("malformed");
  }, 30_000);

  it("removes the report of a schema-invalid answer too deep to copy without walking it, then repairs and ends malformed", async () => {
    const deep = JSON.parse(`${"[".repeat(3_000)}${"]".repeat(3_000)}`) as unknown;
    const output = await run(profile({ modelReport: "json-path:model", extra: ["--model-json", "fake-model-1", "--extra-json", JSON.stringify({ findings: deep })] }), "fake-model-1");
    expect(output.terminal).toBe("malformed");
    expect(await calls()).toHaveLength(2);
  }, 30_000);

  it("shows a node whose ownership is not settled unchanged, and removes nothing from it", async () => {
    const meta = { anyOf: [{ type: "object", additionalProperties: false, properties: { model: { type: "string" } }, required: ["model"] }] };
    const outputSchema = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, meta } };
    expect(withModelReportField(outputSchema, "json-path:meta.model")).toBe(outputSchema);
    expect(withModelReportField({ ...outputSchema, unevaluatedProperties: false, allOf: [{ properties: { x: {} } }] }, "json-path:model")).toHaveProperty("properties", outputSchema.properties);
    const composedArray = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, runs: { type: "array", anyOf: [{ minItems: 1 }], items: { type: "object", properties: { id: { type: "string" } } } } } };
    expect(withModelReportField(composedArray, "json-path:runs.0.model")).toBe(composedArray);
    const output = await run(profile({ modelReport: "json-path:meta.model", extra: ["--extra-json", JSON.stringify({ meta: { model: "fake-model-1" } })] }), "fake-model-1", { outputSchema });
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(await calls()).toHaveLength(1);
  }, 30_000);

  it("reads dotted json paths of own properties only", () => {
    expect(valueAtPath({ meta: { models: ["m"] } }, "meta.models.0")).toBe("m");
    expect(valueAtPath({}, "constructor")).toBeUndefined();
  });
});

describe("CliHarnessAdapter output validation", () => {
  it.each(["stdout-last-json", "file"] as const)("repairs one malformed %s answer, then ends malformed after a second", async outputVia => {
    const repaired = await run(profile({ outputVia, extra: ["--answer", "invalid-once"] }));
    expect(repaired.terminal).toBe("completed");
    const attempts = await calls();
    expect(attempts).toHaveLength(2);
    expect(attempts[1].prompt).toContain("Repair: your previous answer was rejected");
    expect(attempts[1].prompt).toContain('{"findings":"none"}');
    await rm(path.join(state, "calls.jsonl"));
    const malformed = await run(profile({ outputVia, extra: ["--answer", "invalid"] }));
    expect(malformed.terminal).toBe("malformed");
    expect(malformed.error).toContain("after one repair attempt");
    expect(await calls()).toHaveLength(2);
  }, 30_000);

  it("gives a schema-invalid answer too deep to normalize its repair attempt, then ends malformed", async () => {
    const deep = JSON.parse(`${"[".repeat(4_000)}${"]".repeat(4_000)}`) as unknown;
    const output = await run(profile({ extra: ["--extra-json", JSON.stringify({ findings: deep })] }));
    expect(output.terminal).toBe("malformed");
    expect(await calls()).toHaveLength(2);
  }, 30_000);

  it("echoes the rejected answer's own stdout line, even one too deep to re-serialize, and still repairs it", async () => {
    const deep = `{"findings":"none","nested":${'{"a":'.repeat(10_000)}1${"}".repeat(10_000)}}`;
    expect(() => JSON.stringify(JSON.parse(deep))).toThrow(RangeError);
    const prompts: string[] = [];
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      prompts.push(options.stdin ?? "");
      const answer = prompts.length === 1 ? deep : JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
      return { code: 0, signal: null, stdout: `progress\n${answer}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile())));
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Repair: your previous answer was rejected");
    expect(prompts[1]).toContain(`{"findings":"none","nested":{"a":{"a":`);
  }, 30_000);

  it("treats a null requirements or assessments section the caller schema allows as empty", async () => {
    const nullable = { ...lensOutputSchema, properties: { ...lensOutputSchema.properties, requirements: { type: "null" }, assessments: { type: "null" } } };
    const output = await run(profile({ extra: ["--extra-json", JSON.stringify({ requirements: null, assessments: null })] }), undefined, { outputSchema: nullable });
    expect(output.error).toBeUndefined();
    expect(output).toMatchObject({ terminal: "completed", requirements: [], assessments: [] });
  }, 30_000);

  it("treats a missing output file as a malformed answer", async () => {
    const definition = profile({ outputVia: "file" });
    // The CLI is told the output file, but answers on stdout instead.
    const output = await run({ ...definition, argv: definition.argv.map(item => item === "--out" ? "--unused" : item) });
    expect(output.terminal).toBe("malformed");
    expect(output.error).toContain("wrote no output file");
  }, 30_000);
});

describe("CliHarnessAdapter preflight and configuration", () => {
  it("reads the pinned version with versionArgv and resolves the configured model", async () => {
    const result = await new CliHarnessAdapter({ environment: environment() }).preflight(configuration(profile()));
    expect(result).toMatchObject({ ok: true, resolved: { harnessVersion: "1.2.3", model: MODEL } });
    expect(result.diagnostics.map(item => item.code)).toEqual(["REVIEWFN_HARNESS_SANDBOX_UNENFORCED", "REVIEWFN_HARNESS_MODEL_UNVERIFIED"]);
    expect(parseCliVersion("cursor-agent 2025.08.25-896bbe1\n")).toBe("2025.08.25-896bbe1");
    expect(parseCliVersion("v0.9.0")).toBe("0.9.0");
  }, 20_000);

  // Built at runtime: a credential the reported version holds whole, and one it overlaps only up to the "!" that ends it.
  it.each([
    ["holds", ["version", "fixture", "credential"].join("-"), "1.2.3+build.", "1.2.3+build.version-fixture-credential"],
    ["overlaps", ["partial", "fixture!value"].join("-"), "1.2.3+build.", "1.2.3+build.partial-fixture"],
  ])("refuses a reported version that %s a registered secret, in preflight and run, without storing it", async (_label, secret, prefix, parsed) => {
    expect(parseCliVersion(`fake-cli version ${prefix}${secret}`)).toBe(parsed);
    const runner: CommandRunner = async () => ({ code: 0, signal: null, stdout: `fake-cli version ${prefix}${secret}\n`, stderr: "", timedOut: false, canceled: false });
    const harness = new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: secret }, runner });
    const result = await harness.preflight(configuration(profile()));
    const output = await harness.run(input(configuration(profile())));
    expect(result.ok).toBe(false);
    expect(result.resolved?.harnessVersion).toBeUndefined();
    expect(output.terminal).toBe("failed");
    expect(output.error).toBe("The CLI reported a version that overlaps a registered secret, so it was refused.");
    expect(output.observed?.harnessVersion).toBeUndefined();
    for (const text of [JSON.stringify(result), JSON.stringify(output)]) expect(text).not.toContain(secret.slice(0, 15));
  });

  it.each([
    ["a later token repeats its value", "1.2.3!test-suffix", "fixture 1.2.3!test-suffix\n", "fixture 1.2.3\n"],
    ["the secret spans both streams", ["fixture-cred", "split-part"].join("\n"), "fake-cli version 1.2.3+fixture-cred", "split-part\n"],
    ["the output JSON-escapes the secret", ["test-fragment", "continued"].join("\n"), `${JSON.stringify({ version: `1.2.3+build.${["test-fragment", "continued"].join("\n")}` })}\n`, ""],
    ["the output \\u-escapes the secret", "build-credential", "fake-cli version 1.2.3+build\\u002dcredential\n", ""],
    ["it is a credential shape core redacts with no secret registered", "unrelated-fixture-value", "Bearer 1.2.3+build.test\n", ""],
    ["a token shape crosses a line break into it", "unrelated-fixture-value", "token\n1.2.3+build.fixture\n", ""],
  ])("refuses a version whose reported occurrence overlaps a secret when %s", async (_label, secret, stdout, stderr) => {
    const runner: CommandRunner = async () => ({ code: 0, signal: null, stdout, stderr, timedOut: false, canceled: false });
    const result = await new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: secret }, runner }).preflight(configuration(profile()));
    expect(result.ok).toBe(false);
    expect(result.resolved).toBeUndefined();
    expect(result.diagnostics.map(item => item.message)).toContain("The CLI reported a version that overlaps a registered secret, so it was refused.");
  });

  it("keeps the version token the output reports when redacting a secret elsewhere would expose another", async () => {
    const runner: CommandRunner = async () => ({ code: 0, signal: null, stdout: "test-banner9.8.7\nfixture version 1.2.3\n", stderr: "", timedOut: false, canceled: false });
    const result = await new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: "test-banner" }, runner }).preflight(configuration(profile()));
    expect(result.resolved?.harnessVersion).toBe("1.2.3");
  });

  it("accepts the reported token when its spelling also occurs inside an unrelated credential later in the output", async () => {
    const runner: CommandRunner = async () => ({ code: 0, signal: null, stdout: "tool 1.2.3\nconfigured testX1.2.3Yvalue\n", stderr: "", timedOut: false, canceled: false });
    const result = await new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: "testX1.2.3Yvalue" }, runner }).preflight(configuration(profile()));
    expect(result.resolved?.harnessVersion).toBe("1.2.3");
  });

  it("checks a large in-budget version output in linear time", async () => {
    const stdout = `fake-cli version 1.2.3\n${"1.2.3 test ".repeat(5_740)}`;
    const runner: CommandRunner = async () => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false, canceled: false });
    const started = performance.now();
    const result = await new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: "test" }, runner }).preflight(configuration(profile()));
    expect(result.resolved?.harnessVersion).toBe("1.2.3");
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("keeps each run's own approved version when a concurrent probe of the same invocation is refused", async () => {
    const secret = ["racing", "fixture", "credential"].join("-");
    const versions = ["1.2.3", `1.2.3+build.${secret}`];
    let release!: () => void;
    let started!: () => void;
    const both = new Promise<void>(resolve => { release = resolve; });
    const firstProbe = new Promise<void>(resolve => { started = resolve; });
    let probes = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (!args.includes("--version")) return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
      const stdout = `fake-cli version ${versions[probes]}\n`;
      probes += 1;
      (probes === 1 ? started : release)();
      await both;
      return { code: 0, signal: null, stdout, stderr: "", timedOut: false, canceled: false };
    };
    const harness = new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: secret }, runner });
    const designated = configuration(profile({ envAllowlist: ["REVIEW_AUTH"] }));
    const allowlisted = { ...designated, inference: { ...designated.inference, credentialEnv: undefined } };
    // The second run starts once the first is reading the version, so the probes overlap in a fixed order.
    const running = harness.run(input(allowlisted));
    await firstProbe;
    const [first, second] = await Promise.all([running, harness.run(input(designated))]);
    expect(second.error).toBe("The CLI reported a version that overlaps a registered secret, so it was refused.");
    expect(first.observed?.harnessVersion).toBe("1.2.3");
    expect(JSON.stringify(first)).not.toContain(secret);
  });

  it("refuses a cached version that overlaps a secret only the later run's configuration registers", async () => {
    const secret = ["cached", "fixture", "credential"].join("-");
    let probes = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) { probes += 1; return { code: 0, signal: null, stdout: `fake-cli version 1.2.3+build.${secret}\n`, stderr: "", timedOut: false, canceled: false }; }
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const harness = new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: secret }, runner });
    // The same effective environment: allowlisted only, then also designated the credential.
    const designated = configuration(profile({ envAllowlist: ["REVIEW_AUTH"] }));
    const allowlisted = { ...designated, inference: { ...designated.inference, credentialEnv: undefined } };
    expect((await harness.preflight(allowlisted)).resolved?.harnessVersion).toBe(`1.2.3+build.${secret}`);
    const output = await harness.run(input(designated));
    // The run's own secrets refuse the cached observation, so it reads the version again and is refused on its own probe.
    expect(probes).toBe(2);
    expect(output.terminal).toBe("failed");
    expect(output.error).toBe("The CLI reported a version that overlaps a registered secret, so it was refused.");
    expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("publishes a version token core redaction leaves as written, a label it keeps before a redacted value included", async () => {
    const answer = JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
    const runner: CommandRunner = async (_command, args) => ({ code: 0, signal: null, stdout: args.includes("--version") ? "tool version 1.2.3-token linux-x64\n" : `${answer}\n`, stderr: "", timedOut: false, canceled: false });
    const harness = new CliHarnessAdapter({ environment: environment(), runner });
    expect((await harness.preflight(configuration(profile()))).resolved?.harnessVersion).toBe("1.2.3-token");
    const base = input(configuration(profile()));
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run({ ...base, slot: { ...base.slot!, harness: { ...base.slot!.harness, version: "1.2.3-token" } } });
    expect(output.observed?.harnessVersion).toBe("1.2.3-token");
    expect(output.error ?? "").not.toContain("pinned");
  });

  it("refuses a version token a credential shape reaches only once a registered secret is redacted before it", async () => {
    const runner: CommandRunner = async () => ({ code: 0, signal: null, stdout: "test-bannerBearer 1.2.3+build.test\n", stderr: "", timedOut: false, canceled: false });
    const harness = new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: "test-banner" }, runner });
    const result = await harness.preflight(configuration(profile()));
    const output = await harness.run(input(configuration(profile())));
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(item => item.message)).toContain("The CLI reported a version that overlaps a registered secret, so it was refused.");
    expect(output.terminal).toBe("failed");
    expect(output.error).toBe("The CLI reported a version that overlaps a registered secret, so it was refused.");
    for (const text of [JSON.stringify(result), JSON.stringify(output)]) for (const hidden of ["build.test", "test-banner"]) expect(text).not.toContain(hidden);
  });

  it("caches only an accepted version: a refusal neither sticks nor replaces an accepted observation", async () => {
    const secret = ["refused", "fixture", "credential"].join("-");
    const reported = [`1.2.3+build.${secret}`, "1.2.3", `1.2.3+build.${secret}`];
    let probes = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: `fake-cli version ${reported[Math.min((probes += 1) - 1, 2)]}\n`, stderr: "", timedOut: false, canceled: false };
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const harness = new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: secret }, runner });
    const config = configuration(profile());
    const first = await harness.run(input(config));
    expect(first.error).toBe("The CLI reported a version that overlaps a registered secret, so it was refused.");
    // No preflight in between: the refusal was not cached, so the next run reads the version again.
    expect((await harness.run(input(config))).observed?.harnessVersion).toBe("1.2.3");
    expect(probes).toBe(2);
    // A refused refresh leaves the accepted observation in place for the next run.
    expect((await harness.preflight(config)).ok).toBe(false);
    const third = await harness.run(input(config));
    expect(third.observed?.harnessVersion).toBe("1.2.3");
    expect(probes).toBe(3);
    for (const output of [first, third]) expect(JSON.stringify(output)).not.toContain(secret);
  });

  it("ends canceled an aborted run whose cached version its own secrets refuse, as on a cold cache", async () => {
    const secret = ["aborted", "fixture", "credential"].join("-");
    const runner: CommandRunner = async (_command, args, options) => args.includes("--version")
      ? { code: 0, signal: null, stdout: `fake-cli version 1.2.3+build.${secret}\n`, stderr: "", timedOut: false, canceled: options.signal?.aborted ?? false }
      : { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    const designated = configuration(profile({ envAllowlist: ["REVIEW_AUTH"] }));
    const allowlisted = { ...designated, inference: { ...designated.inference, credentialEnv: undefined } };
    const controller = new AbortController();
    controller.abort();
    const results: Array<[string, string | undefined]> = [];
    for (const warm of [false, true]) {
      const harness = new CliHarnessAdapter({ environment: { PATH: process.env.PATH, REVIEW_AUTH: secret }, runner });
      if (warm) expect((await harness.preflight(allowlisted)).ok).toBe(true);
      const output = await harness.run(input(designated, { signal: controller.signal }));
      results.push([output.terminal, output.error]);
      expect(JSON.stringify(output)).not.toContain(secret);
    }
    expect(results).toEqual([["canceled", "The CLI run was canceled while its version was read."], ["canceled", "The CLI run was canceled while its version was read."]]);
  });

  it("keeps an ordinary version with pre-release and build suffixes exact next to a registered secret", async () => {
    const runner: CommandRunner = async () => ({ code: 0, signal: null, stdout: "fake-cli version 1.2.3-rc.1+build.7\n", stderr: "", timedOut: false, canceled: false });
    const result = await new CliHarnessAdapter({ environment: environment(), runner }).preflight(configuration(profile()));
    expect(result.resolved?.harnessVersion).toBe("1.2.3-rc.1+build.7");
  });

  it("parses version tokens with a linear scan, as the documented token rule reads them", () => {
    expect(parseCliVersion("tool 1.2.3+build.7 (x)")).toBe("1.2.3+build.7");
    expect(parseCliVersion("tool 1.2.3-rc.1+build.7 (x)")).toBe("1.2.3-rc.1+build.7");
    expect(parseCliVersion("1.2.3-rc.1+")).toBe("1.2.3-rc.1");
    expect(parseCliVersion("1.2.3-rc.1+build.")).toBe("1.2.3-rc.1");
    expect(parseCliVersion("1.2.3-rc.1-")).toBe("1.2.3-rc.1");
    expect(parseCliVersion("1.2.3-beta.")).toBe("1.2.3");
    expect(parseCliVersion("1.2.3.")).toBeUndefined();
    expect(parseCliVersion("a1.2.3 b.1.2 2.0")).toBe("2.0");
    expect(parseCliVersion("version 7", "cli v4.5\n")).toBe("4.5");
    expect(parseCliVersion("1.2_3 x")).toBeUndefined();
    const started = Date.now();
    // A long suffix is kept whole, never cut to a shorter version, and adversarial input still scans in linear time.
    expect(parseCliVersion(`1.2.3-${"a".repeat(129)}`)).toBe(`1.2.3-${"a".repeat(129)}`);
    expect(parseCliVersion(`${"1.1-".repeat(20_000)}_`, `${"9.".repeat(30_000)}_`)).toBe("1.1-".repeat(20_000).slice(0, -1));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.each([["hangs", { timedOut: true, code: null, signal: "SIGKILL" as const }], ["overruns its output bound", { timedOut: true, code: null, signal: "SIGTERM" as const }]])("ends a cold-cache run timed_out when the version command %s", async (_name, outcome) => {
    const runner: CommandRunner = async () => ({ stdout: "", stderr: "", canceled: false, ...outcome });
    const config = configuration(profile());
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(config));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/version command exceeded/);
    const preflight = await new CliHarnessAdapter({ environment: environment(), runner }).preflight(config);
    expect(preflight.ok).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses an absolute executable in a Git repository or under a world-writable directory before reading its version", async () => {
    const repository = path.join(directory, "target");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(path.join(repository, "tools"));
    const open = path.join(directory, "open");
    await mkdir(open);
    await chmod(open, 0o777);
    const spawned: string[] = [];
    const runner: CommandRunner = async (command, args, options) => { spawned.push(command); return runProcessGroup(command, args, options); };
    for (const executable of [path.join(repository, "tools", "agent"), path.join(open, "agent")]) {
      await writeFile(executable, "#!/bin/sh\necho 1.2.3\n");
      await chmod(executable, 0o755);
      const config = configuration(profile());
      const placed = { ...config, harness: { ...config.harness, executable } };
      const preflight = await new CliHarnessAdapter({ environment: environment(), runner }).preflight(placed);
      expect(preflight.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "REVIEWFN_CLI_UNAVAILABLE", message: expect.stringMatching(/world-writable or Git-repository ancestor/) })]));
      const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(placed));
      expect(output.terminal).toBe("failed");
      expect(output.error).toMatch(/world-writable or Git-repository ancestor/);
    }
    expect(spawned).toEqual([]);
  }, 30_000);

  it.skipIf(process.platform === "win32")("refuses an absolute executable that resolves into the review workspace, directly or through a link", async () => {
    const inside = path.join(workspace, "agent");
    await writeFile(inside, "#!/bin/sh\necho 1.2.3\n");
    await chmod(inside, 0o755);
    const link = path.join(directory, "agent-link");
    await symlink(inside, link);
    for (const executable of [inside, link]) {
      const config = configuration(profile());
      const output = await new CliHarnessAdapter({ environment: environment() }).run(input({ ...config, harness: { ...config.harness, executable } }));
      expect(output.terminal).toBe("failed");
      expect(output.error).toMatch(/inside the repository under review/);
    }
    expect(await calls()).toEqual([]);
    // An installed executable outside the workspace, even through a link, still runs.
    const installed = path.join(directory, "agent-installed");
    await symlink(AGENT, installed);
    const config = configuration(profile());
    expect((await new CliHarnessAdapter({ environment: environment() }).run(input({ ...config, harness: { ...config.harness, executable: installed } }))).terminal).toBe("completed");
  }, 30_000);

  it.each([["the credential", CREDENTIAL], ["a secret-named allowlisted value", ALLOWED_SECRET]])("redacts %s from a failed version read before cutting its stderr", async (_name, secret) => {
    // The secret crosses the 500-character cut, so truncating before redaction would leave its prefix unmatched.
    const runner: CommandRunner = async () => ({ code: 2, signal: null, stdout: "", stderr: `${"x".repeat(490)}${secret}`, timedOut: false, canceled: false });
    const config = configuration(profile({ envAllowlist: ["ALLOWED_ONE", "FIXTURE_API_KEY"] }));
    const preflight = await new CliHarnessAdapter({ environment: environment(), runner }).preflight(config);
    const diagnostic = preflight.diagnostics.find(item => item.code === "REVIEWFN_HARNESS_VERSION");
    expect(diagnostic?.message).toContain("exited with 2");
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(config));
    expect(output.terminal).toBe("failed");
    expect(output.error).toContain("exited with 2");
    for (const text of [diagnostic!.message, output.error!, JSON.stringify(output)]) { expect(text).not.toContain(`x${secret.slice(0, 6)}`); expect(text).not.toContain(secret.slice(0, 10)); }
  });

  it.each([
    ["a relative executable", (config: ReviewFnConfig) => ({ ...config, harness: { ...config.harness, executable: "bin/agent" } }), "REVIEWFN_CLI_UNAVAILABLE"],
    ["no profile", (config: ReviewFnConfig) => ({ ...config, harness: { adapter: "cli", version: "1", executable: AGENT } }), "REVIEWFN_HARNESS_PROFILE_REQUIRED"],
    ["an invalid profile", (config: ReviewFnConfig) => ({ ...config, harness: { ...config.harness, profileDefinition: { ...config.harness.profileDefinition!, argv: ["--model={model}"] } } }), "REVIEWFN_HARNESS_PROFILE_INVALID"],
    ["an option-like model", (config: ReviewFnConfig) => ({ ...config, inference: { ...config.inference, model: "--yolo" } }), "REVIEWFN_MODEL_INVALID"],
    ["{model} with the configured model", (config: ReviewFnConfig) => ({ ...config, harness: { ...config.harness, profileDefinition: { ...config.harness.profileDefinition!, argv: ["{model}"] } }, inference: { ...config.inference, model: "configured" } }), "REVIEWFN_MODEL_REQUIRED"],
    ["another contract version", (config: ReviewFnConfig) => ({ ...config, harness: { ...config.harness, version: "2" } }), "REVIEWFN_HARNESS_VERSION"],
  ] as const)("refuses %s", async (_name, change, code) => {
    const config = change(configuration(profile()));
    const harness = new CliHarnessAdapter({ environment: environment() });
    const result = await harness.preflight(config);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map(item => item.code)).toContain(code);
    expect((await harness.run(input(config))).terminal).toBe("failed");
    expect(await calls()).toEqual([]);
  }, 20_000);

  it("satisfies a slot's pin only with the version its own environment reported, never another profile's observation", async () => {
    // A shim selected by an environment variable reports another version: the two profiles differ only in that variable.
    let probes = 0;
    const runner: CommandRunner = async (command, args, options) => {
      if (!args.includes("--version")) return runProcessGroup(command, args, options);
      probes += 1;
      return { code: 0, signal: null, stdout: `fake-cli version ${options.env?.SHIM_VERSION ?? "1.2.3"}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const harness = new CliHarnessAdapter({ environment: { ...environment(), SHIM_VERSION: "9.9.9" }, runner });
    const plain = configuration(profile());
    const shimmed = configuration(profile({ envAllowlist: ["ALLOWED_ONE", "SHIM_VERSION"] }));
    expect((await harness.preflight(plain)).resolved?.harnessVersion).toBe("1.2.3");
    expect((await harness.preflight(shimmed)).resolved?.harnessVersion).toBe("9.9.9");
    expect((await harness.run(input(plain))).observed?.harnessVersion).toBe("1.2.3");
    expect((await harness.run(input(shimmed))).observed?.harnessVersion).toBe("9.9.9");
    // Each run reuses the observation its own preflight made.
    expect(probes).toBe(2);
  }, 30_000);

  it("ends a run whose version probe used up the deadline timed_out before the CLI started", async () => {
    let spawned = 0;
    const runner: CommandRunner = async (_command, args) => {
      spawned += 1;
      await new Promise(resolve => setTimeout(resolve, 150));
      return { code: 0, signal: null, stdout: args.includes("--version") ? "fake-cli version 1.2.3\n" : "", stderr: "", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 50 } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile()), { policy }));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toBe("The CLI exceeded its configured bound before the CLI started.");
    expect(spawned).toBe(1);
  });

  it.each(["cold", "warm"] as const)("never runs the review with a version other than the slot's pin, on a %s version cache", async cache => {
    const commands: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      commands.push(args);
      return { code: 0, signal: null, stdout: args.includes("--version") ? "fake-cli version 9.9.9\n" : "", stderr: "", timedOut: false, canceled: false };
    };
    const harness = new CliHarnessAdapter({ environment: environment(), runner });
    if (cache === "warm") expect((await harness.preflight(configuration(profile()))).resolved?.harnessVersion).toBe("9.9.9");
    const output = await harness.run(input(configuration(profile())));
    expect(output.terminal).toBe("failed");
    expect(output.error).toBe("The CLI reported version 9.9.9, not the pinned 1.2.3, so the review was not run.");
    expect(output.observed?.harnessVersion).toBe("9.9.9");
    // Only the one version probe ran: the review command never did.
    expect(commands).toEqual([[...LAUNCH, "--version"]]);
  });

  it.each([["malformed", { findings: "none" }], ["valid", { findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] }]] as const)("refuses a %s answer from an executable replaced while the attempt ran, and runs no repair", async (_name, answer) => {
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      // The CLI is reinstalled at the same path while the first attempt runs.
      identity.shift = 1n;
      return { code: 0, signal: null, stdout: `${JSON.stringify(answer)}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile())));
    expect(reviews).toBe(1);
    expect(output.terminal).toBe("failed");
    expect(output.error).toBe("The CLI executable changed while the attempt ran, so its answer was refused.");
  });

  it("keeps a caller's cancellation authoritative over an executable also replaced while the attempt ran", async () => {
    const controller = new AbortController();
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      identity.shift = 1n;
      controller.abort();
      return { code: 0, signal: null, stdout: `${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile()), { signal: controller.signal }));
    expect(output.terminal).toBe("canceled");
  });

  it("ends canceled a valid answer whose caller aborted while the executable's identity was read after the CLI ended", async () => {
    const controller = new AbortController();
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      // The identity read that follows the CLI is slow, and the caller aborts during it.
      identity.delayMs = 200;
      setTimeout(() => controller.abort(), 100);
      return { code: 0, signal: null, stdout: `${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile()), { signal: controller.signal }));
    expect(output.terminal).toBe("canceled");
  });

  it("reads the deadline after the executable's identity is re-read, so a slow read cannot start the CLI past it", async () => {
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      // Every identity read after the version probe takes longer than the whole run may.
      if (args.includes("--version")) { identity.delayMs = 300; return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }; }
      reviews += 1;
      return { code: 0, signal: null, stdout: `${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 200 } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile()), { policy }));
    expect(reviews).toBe(0);
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toBe("The CLI exceeded its configured bound before the CLI started.");
  });

  it("ends timed_out a CLI whose output file was measured over the budget with its streams, even after it shrank the file and completed", async () => {
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      const out = args[args.indexOf("--out") + 1];
      await writeFile(out, "x".repeat(60_000));
      await new Promise(resolve => setTimeout(resolve, 400));
      await writeFile(out, JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] }));
      await new Promise(resolve => setTimeout(resolve, 400));
      // 50,000 stream bytes, reported as the shared runner reports them.
      options.onOutput?.(50_000);
      return { code: 0, signal: null, stdout: "z".repeat(50_000), stderr: "", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 100_000 } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" })), { policy }));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/at its largest\) grew past the remaining/);
  });

  /**
   * A CLI that writes `file` to its output file and `stdout`, reported as the shared runner reports it (or as `reported`
   * bytes, such as a chunk the runner then dropped at its cap), then ends as `ending`.
   */
  const writing = (file: string, stdout: string, ending: { timedOut?: boolean; canceled?: boolean; stderr?: string; reported?: number; kept?: number } = {}): CommandRunner => async (_command, args, options) => {
    if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
    if (file) await writeFile(args[args.indexOf("--out") + 1], file);
    const stderr = ending.stderr ?? "";
    const reported = ending.reported ?? Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
    if (reported) options.onOutput?.(reported);
    return { code: ending.timedOut || ending.canceled ? null : 0, signal: null, stdout, stderr, timedOut: ending.timedOut ?? false, canceled: ending.canceled ?? false, ...(ending.kept === undefined ? {} : { stdoutBytes: ending.kept, stderrBytes: 0 }) };
  };
  const limited = (maxOutputBytes: number) => ({ policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes } } });
  // With only a 4-character credential, a cut stream withholds its last 3 characters behind the longer "[REDACTED]".
  const shortSecret = () => ({ PATH: process.env.PATH, REVIEW_AUTH: "test" });

  it("reads a timed-out run's file model report against the raw allowance, even when a withheld tail's marker is longer than the tail", async () => {
    // 1,000 stdout bytes and a 19-byte report fit the 1,021 bytes left of a 1,024-byte budget; the "[REDACTED]" that
    // withholds the cut stream's last 3 characters is 7 bytes longer than them, which once narrowed the file read to 13.
    const runner = writing(JSON.stringify({ model: "model-x" }), `${"z".repeat(998)}\nz`, { timedOut: true });
    const output = await new CliHarnessAdapter({ environment: shortSecret(), runner }).run(input(configuration(profile({ outputVia: "file", modelReport: "json-path:model" })), limited(1_024)));
    expect(output.terminal).toBe("timed_out");
    expect(output.observed).toMatchObject({ model: "model-x", modelMismatch: true });
    expect(Buffer.byteLength(output.transcript ?? "")).toBeLessThanOrEqual(1_024);
  });

  it("reads a file model report against the raw stream bytes the runner kept, not their decoded length", async () => {
    // 1,003 raw stdout bytes, whose cut last character and invalid byte decode to two 3-byte U+FFFD, and a 19-byte report
    // fill the 1,022 bytes a 1,025-byte budget leaves; measured on the decoded text, the file allowance was 16.
    const runner = writing(JSON.stringify({ model: "model-x" }), `${"z".repeat(1_000)}\uFFFD\uFFFD`, { timedOut: true, kept: 1_003 });
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file", modelReport: "json-path:model" })), limited(1_025)));
    expect(output.terminal).toBe("timed_out");
    expect(output.observed).toMatchObject({ model: "model-x", modelMismatch: true });
  });

  it.each([
    ["characters its decoder replaced", "\uFFFD".repeat(10), 10, environment],
    ["a transcript redaction lengthened", "test\n".repeat(20), undefined, shortSecret],
  ] as const)("gives a repair attempt the raw budget the first left, whatever %s", async (_label, noise, raw, env) => {
    const budgets: number[] = [];
    const invalid = `${JSON.stringify({ findings: "none" })}\n`;
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      budgets.push(options.maxOutputBytes);
      return { code: 0, signal: null, stdout: `${noise}\n${invalid}`, stderr: "", timedOut: false, canceled: false, ...(raw === undefined ? {} : { stdoutBytes: raw + 1 + invalid.length, stderrBytes: 0 }) };
    };
    await new CliHarnessAdapter({ environment: env(), runner }).run(input(configuration(profile()), limited(1_024)));
    // The limit less the first attempt's raw stream bytes, its stdout/stderr and transcript separators, and the next's.
    expect(budgets).toEqual([1_021, 1_024 - ((raw ?? Buffer.byteLength(noise)) + 1 + invalid.length) - 2 - 3]);
  });

  it("accepts an output file one byte under the allowance the live check gives it next to the streams", async () => {
    const answer = JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
    // 1,021 bytes left of a 1,024-byte budget, 500 of them on stdout: the file may have up to 521.
    const runner = writing(answer.padEnd(520, " "), `${"z".repeat(499)}\n`);
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" })), limited(1_024)));
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
  });

  it("reads a file model report within the budget when the runner dropped the stream chunk that crossed its cap", async () => {
    const runner = writing(JSON.stringify({ model: "model-x" }), "", { timedOut: true, reported: 2_048 });
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file", modelReport: "json-path:model" })), limited(1_024)));
    expect(output.terminal).toBe("timed_out");
    expect(output.observed).toMatchObject({ model: "model-x", modelMismatch: true });
  });

  it("refuses an output file over what the kept stream bytes leave of the budget when the runner did not report them", async () => {
    const answer = JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
    const runner = writing(answer.padEnd(500, " "), "z".repeat(700), { reported: 0 });
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" })), limited(1_024)));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/output file .*exceeded the remaining 321-byte output budget/);
  });

  it("refuses, in stdout-last-json mode, an output file over what a runner that never reported its streams kept", async () => {
    const answer = JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
    // 700 stdout bytes holding a valid answer and a 500-byte file: 1,200 bytes under a 1,024-byte cap, never seen live.
    const runner = writing("f".repeat(500), `${answer}\n`.padStart(700, " "), { reported: 0 });
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ extra: ["--out", "{outputFile}"] })), limited(1_024)));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/output file \(500 bytes at its largest\) exceeded the remaining 321-byte output budget/);
  });

  it("pays for no repair attempt once the first attempt's stored transcript is already over the limit", async () => {
    let reviews = 0;
    const invalid = `${JSON.stringify({ findings: "none" })}\n`;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      // 550 malformed raw bytes, decoded to 1,650 bytes of U+FFFD, then a schema-invalid answer: raw headroom remains.
      return { code: 0, signal: null, stdout: `${"\uFFFD".repeat(550)}\n${invalid}`, stderr: "", timedOut: false, canceled: false, stdoutBytes: 551 + invalid.length, stderrBytes: 0 };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile()), limited(1_024)));
    expect(reviews).toBe(1);
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/^The CLI output exceeded its 1024-byte budget once stored \(transcript \d+ bytes/);
  });

  it("ends timed_out, within the limit, a completed run whose stored transcript is over it only through redaction", async () => {
    const answer = JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
    // 832 raw stdout bytes; each of the 150 "test" credentials becomes a "[REDACTED]" 6 bytes longer.
    const runner = writing("", `${"test\n".repeat(150)}${answer}\n`);
    const output = await new CliHarnessAdapter({ environment: shortSecret(), runner }).run(input(configuration(profile()), limited(1_024)));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/^The CLI output exceeded its 1024-byte budget once stored \(transcript \d+ bytes/);
    expect(Buffer.byteLength(output.transcript ?? "")).toBeLessThanOrEqual(1_024);
    expect(output.transcript).not.toContain("\uFFFD");
  });

  it.each([["timed_out", { timedOut: true }], ["canceled", { canceled: true }]] as const)("returns a %s run's redaction-expanded transcript within the output limit", async (terminal, ending) => {
    const controller = new AbortController();
    // 1,021 raw stream bytes; each stream's withheld last 3 characters become a marker 7 bytes longer.
    const cli = writing("", `${"z".repeat(1_008)}\nz`, { ...ending, stderr: "e".repeat(9) + "\ne" });
    const runner: CommandRunner = async (command, args, options) => {
      const result = await cli(command, args, options);
      if (ending.canceled && !args.includes("--version")) controller.abort();
      return result;
    };
    const output = await new CliHarnessAdapter({ environment: shortSecret(), runner }).run(input(configuration(profile()), { ...limited(1_024), signal: controller.signal }));
    expect(output.terminal).toBe(terminal);
    expect(Buffer.byteLength(output.transcript ?? "")).toBeLessThanOrEqual(1_024);
    expect(Buffer.byteLength(JSON.stringify(output.events))).toBeLessThanOrEqual(1_024);
    expect(output.transcript).toMatch(/^z{1007}\[REDACTED\]\n/);
  });

  it("never starts an executable replaced while its attempt's files were written", async () => {
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) { identity.shiftOnAttemptDirectory = true; return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }; }
      reviews += 1;
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile())));
    expect(reviews).toBe(0);
    expect(output.terminal).toBe("failed");
    expect(output.error).toBe("The CLI executable changed after its version was read, so it was refused before the CLI started.");
  });

  it("charges the repair attempt for an output file measured larger while the first attempt ran than the file it left", async () => {
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      const out = args[args.indexOf("--out") + 1];
      if (reviews === 1) {
        // 60,000 bytes, left long enough to be measured, then replaced by a small malformed answer.
        await writeFile(out, "x".repeat(60_000));
        await new Promise(resolve => setTimeout(resolve, 400));
        await writeFile(out, JSON.stringify({ findings: "none" }));
      } else {
        // A valid answer of about 50,000 bytes: within the budget alone, over it with the first attempt's 60,000.
        await writeFile(out, `${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}${" ".repeat(50_000)}`);
      }
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 100_000 } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" })), { policy }));
    expect(reviews).toBe(2);
    expect(output.terminal).toBe("timed_out");
    // The watcher's measurement after exit or the answer read may see the overrun first; either names the output file.
    expect(output.error).toMatch(/output file .*(exceeded|grew past) the remaining/);
  });

  it("ends timed_out a valid answer from an unchanged executable whose identity read after the CLI crosses the deadline", async () => {
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      // The identity read that follows the CLI is slower than the time left, and no caller signal will end the run.
      identity.delayMs = 400;
      return { code: 0, signal: null, stdout: `${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 300 } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile()), { policy }));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toBe("The CLI exceeded its configured bound before its answer was accepted.");
  });

  it("ends canceled, never starting the CLI, when the caller aborts while the identity read before the spawn finds a replaced executable", async () => {
    const controller = new AbortController();
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) {
        // The executable is replaced while the attempt's files are written, and the identity read before the spawn is slow.
        Object.assign(identity, { shiftOnAttemptDirectory: true, delayMs: 300 });
        setTimeout(() => controller.abort(), 100);
        return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      }
      reviews += 1;
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile()), { signal: controller.signal }));
    expect(reviews).toBe(0);
    expect(output.terminal).toBe("canceled");
  });

  it("refuses a valid answer read through an attempt directory the CLI replaced with a link, and runs no repair", async () => {
    const outside = path.join(directory, "outside");
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      // The CLI swaps its attempt directory for a link to one where it planted a valid answer.
      const attemptDirectory = path.dirname(args[args.indexOf("--out") + 1]);
      await mkdir(outside);
      await writeFile(path.join(outside, "output.json"), JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] }));
      await rm(attemptDirectory, { recursive: true });
      await symlink(outside, attemptDirectory);
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(reviews).toBe(1);
    expect(output.terminal).toBe("failed");
    expect(output.error).toBe("The CLI's run or attempt directory was replaced, so the attempt was refused before its answer was accepted.");
  });

  it("creates no repair attempt through a run directory the CLI replaced with a link", async () => {
    const outside = path.join(directory, "outside");
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      // A malformed answer, which earns a repair, then the run directory moved away and replaced with a link to it.
      const out = args[args.indexOf("--out") + 1];
      await writeFile(out, JSON.stringify({ findings: "none" }));
      const runDirectory = path.dirname(path.dirname(out));
      await rename(runDirectory, outside);
      await symlink(outside, runDirectory);
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(reviews).toBe(1);
    expect(output.terminal).toBe("failed");
    expect(output.error).toMatch(/run or attempt directory was replaced/);
    expect((await readdir(outside)).filter(name => name.startsWith("attempt-2-"))).toEqual([]);
  });

  it("never starts an executable replaced while the attempt's directories are checked before the spawn", async () => {
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) { identity.shiftOnAttemptCheck = true; return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }; }
      reviews += 1;
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile())));
    expect(reviews).toBe(0);
    expect(output.error).toBe("The CLI executable changed after its version was read, so it was refused before the CLI started.");
  });

  it("ends timed_out a nonzero exit whose directory checks after the CLI cross the deadline", async () => {
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      identity.lstatDelayMs = 400;
      return { code: 1, signal: null, stdout: "", stderr: "failure", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 300 } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile()), { policy }));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toBe("The CLI exceeded its configured bound before its answer was judged.");
  });

  it("charges a stdout-last-json CLI for an {outputFile} it wrote after the last measurement, and ends timed_out", async () => {
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      await writeFile(args[args.indexOf("--out") + 1], "y".repeat(60_000));
      const stdout = `${"z".repeat(50_000)}\n${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`;
      options.onOutput?.(Buffer.byteLength(stdout));
      return { code: 0, signal: null, stdout, stderr: "", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 100_000 } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ extra: ["--out", "{outputFile}"] })), { policy }));
    expect(output.terminal).toBe("timed_out");
    expect(output.error).toMatch(/60000 bytes at its largest\) grew past the remaining/);
  });

  it("charges no output bytes for a link a stdout-last-json CLI leaves at its {outputFile}", async () => {
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      // A link whose target text (900 bytes) is larger than the budget left after the answer.
      await symlink("x/".repeat(450), args[args.indexOf("--out") + 1]);
      const stdout = `${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`;
      options.onOutput?.(Buffer.byteLength(stdout));
      return { code: 0, signal: null, stdout, stderr: "", timedOut: false, canceled: false };
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 900 } };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ extra: ["--out", "{outputFile}"] })), { policy }));
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
  });

  it("leaves a directory that took the run directory's place, removing nothing from it", async () => {
    const moved = path.join(directory, "moved");
    let runDirectory = "";
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      // The CLI renames its run directory away and puts another real directory, with content, in its place.
      runDirectory = path.dirname(path.dirname(args[args.indexOf("--out") + 1]));
      await rename(runDirectory, moved);
      await mkdir(runDirectory);
      await writeFile(path.join(runDirectory, "kept.txt"), "kept");
      return { code: 0, signal: null, stdout: `${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ extra: ["--out", "{outputFile}"] }))));
    expect(output.terminal).toBe("failed");
    expect(await readFile(path.join(runDirectory, "kept.txt"), "utf8")).toBe("kept");
    await rm(runDirectory, { recursive: true, force: true });
  });

  it("never reads an answer through an attempt directory swapped for a link between its check and the read", async () => {
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "output.json"), JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["planted"], uninspected: [] }));
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      await writeFile(args[args.indexOf("--out") + 1], JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] }));
      identity.swap = { pattern: /attempt-1-[^/]+$/, outside, after: 1, seen: 0, state: "armed" };
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(identity.swap?.state).not.toBe("armed");
    expect(reviews).toBe(1);
    expect(output.terminal).toBe("failed");
    expect(output.error).toBe("The CLI's run or attempt directory was replaced, so the attempt was refused before its answer was accepted.");
  });

  it("refuses an answer it cannot read because the attempt directory's name stopped resolving, and runs no repair", async () => {
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      await writeFile(args[args.indexOf("--out") + 1], JSON.stringify({ findings: "none" }));
      // A dangling link at the name just after its check, until the next check would find the directory restored.
      identity.swap = { pattern: /attempt-1-[^/]+$/, outside: path.join(directory, "missing"), after: 1, seen: 0, state: "armed" };
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(reviews).toBe(1);
    expect(identity.swap?.state).not.toBe("armed");
    expect(output.terminal).toBe("failed");
  });

  it("refuses an answer whose attempt directory's name is missing when it is read, and runs no repair", async () => {
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      await writeFile(args[args.indexOf("--out") + 1], JSON.stringify({ findings: "none" }));
      identity.swap = { pattern: /attempt-1-[^/]+$/, outside: "", after: 1, seen: 0, state: "armed" };
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(reviews).toBe(1);
    expect(output.terminal).toBe("failed");
  });

  it("removes an attempt directory whose creation failed after it was made, and the whole run directory", async () => {
    const report = path.join(directory, "run-directory.txt");
    identity.prelude = `const fs = require("node:fs"), write = fs.writeFileSync; write(${JSON.stringify(report)}, process.cwd()); fs.writeFileSync = (file, ...rest) => { write(file, ...rest); throw Object.assign(new Error("no space"), { code: "ENOSPC" }); };`;
    const output = await run(profile({ outputVia: "file" }));
    expect(output).toMatchObject({ terminal: "failed", error: "The CLI attempt's files could not be created: ENOSPC" });
    await expect(readdir(await readFile(report, "utf8"))).rejects.toThrow(/ENOENT/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("writes nothing into a directory linked in at a new attempt's name before it is entered", async () => {
    const report = path.join(directory, "run-directory.txt");
    // The decoy is an empty child of the run directory that nobody may write to: a write would fail with EACCES.
    identity.prelude = `const fs = require("node:fs"), made = fs.mkdtempSync; fs.mkdtempSync = prefix => { const name = made(prefix); fs.writeFileSync(${JSON.stringify(report)}, process.cwd()); fs.mkdirSync("decoy", { mode: 0o500 }); fs.renameSync(name, "displaced"); fs.symlinkSync("decoy", name); return name; };`;
    const output = await run(profile({ outputVia: "file" }));
    expect(output).toMatchObject({ terminal: "failed", error: "The CLI attempt's files could not be created: the run or attempt directory was replaced" });
    expect(await calls()).toEqual([]);
    await expect(readdir(await readFile(report, "utf8"))).rejects.toThrow(/ENOENT/);
  });

  it("leaves a link that took a recorded attempt's name, never unlinking it, when it removes the run directory", async () => {
    let replaced = "";
    identity.beforeRemove = async found => {
      replaced = path.join(found, (await readdir(found))[0]);
      await rename(replaced, path.join(found, "displaced"));
      await symlink(directory, replaced);
    };
    const output = await run(profile({ outputVia: "file" }));
    expect(output.terminal).toBe("completed");
    expect(await realpath(replaced)).toBe(await realpath(directory));
    await rm(path.dirname(replaced), { recursive: true, force: true });
  });

  it("leaves a directory moved in at a recorded attempt's name, with its contents, when it removes the run directory", async () => {
    let replacement = "";
    identity.beforeRemove = async found => {
      replacement = path.join(found, (await readdir(found))[0]);
      await rename(replacement, path.join(found, "displaced"));
      await mkdir(replacement);
      await writeFile(path.join(replacement, "kept.txt"), "kept");
    };
    const output = await run(profile({ outputVia: "file" }));
    expect(output.terminal).toBe("completed");
    expect(await readFile(path.join(replacement, "kept.txt"), "utf8")).toBe("kept");
    await rm(path.dirname(replacement), { recursive: true, force: true });
  });

  it.each([
    ["an overlapping occurrence", "test-test", { stdout: "echo test-test-test\n" }],
    ["a credential cut at the output bound", CREDENTIAL, { stdout: `progress\n${CREDENTIAL.slice(0, 20)}`, stderr: CREDENTIAL.slice(0, 12), timedOut: true }],
    ["a whole multi-line credential ending a cut stream", "test-line-one\ntest-line-two", { stdout: "progress\ntest-line-one\ntest-line-two", timedOut: true }],
    ["a multi-line credential cut after its first line", "test-line-one\ntest-line-two", { stdout: "progress\ntest-line-one\ntest-li", timedOut: true }],
    ["a multi-line credential split across stdout and stderr", "test-line-one\ntest-line-two", { stdout: "test-line-one", stderr: "test-line-two" }],
    ["a cut credential holding short secrets that redaction lengthens", "test-lead beep beep beep beep\ntest-line-two", { stdout: "progress\ntest-lead beep beep beep beep\ntest-li", timedOut: true }, "beep"],
  ])("leaves no part of %s in the transcript", async (_case, credential, result, allowlisted?: string) => {
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false, ...result };
    const extra = allowlisted === undefined ? {} : { FIXTURE_API_KEY: allowlisted };
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: credential, ...extra }, runner }).run(input(configuration(profile({ envAllowlist: ["ALLOWED_ONE", "FIXTURE_API_KEY"] }))));
    expect(output.transcript).toContain("[");
    for (const part of [credential.slice(-4), credential.slice(0, 4), CREDENTIAL.slice(0, 12), "line-one", "lead", ...(allowlisted ? [allowlisted] : [])]) expect(output.transcript).not.toContain(part);
  });

  it("refuses a credential too short to redact before any process starts", async () => {
    const runner = vi.fn<CommandRunner>();
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: "q9z" }, runner }).run(input(configuration(profile())));
    expect(output).toMatchObject({ terminal: "failed", error: "credentialEnv REVIEW_AUTH holds fewer than 4 characters, too few to redact." });
    expect(runner).not.toHaveBeenCalled();
  });

  it("redacts only whole occurrences, keeping the JSON around a credential that its own first character follows", async () => {
    const credential = '"test-quoted';
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout: `${JSON.stringify({ echo: credential })}\n${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: credential }, runner }).run(input(configuration(profile())));
    expect(output.terminal).toBe("completed");
    expect(output.transcript).toContain('{"echo":"[REDACTED]"}');
  });

  it("withholds a credential cut short in the output file of a stopped CLI", async () => {
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      await writeFile(args[args.indexOf("--out") + 1], `{"token":"${CREDENTIAL.slice(0, 20)}`);
      return { code: null, signal: "SIGTERM", stdout: "", stderr: "", timedOut: true, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(output.terminal).toBe("timed_out");
    expect(output.transcript).not.toContain(CREDENTIAL.slice(0, 12));
  });

  it("redacts a credential that overlaps itself throughout a long log in linear time", async () => {
    const credential = "a".repeat(4_096);
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout: `${"a".repeat(1_048_576)}\nend\n`, stderr: "", timedOut: false, canceled: false };
    const started = performance.now();
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: credential }, runner }).run(input(configuration(profile())));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(output.transcript).not.toContain("a".repeat(4));
  });

  it("creates nothing through a run directory swapped for a link between its check and the repair attempt's creation", async () => {
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    let reviews = 0;
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      reviews += 1;
      // A malformed answer earns the repair; the swap follows the run directory's third check after the CLI, which starts it.
      await writeFile(args[args.indexOf("--out") + 1], JSON.stringify({ findings: "none" }));
      identity.swap = { pattern: /reviewfn-cli-(?!test-)[^/]+$/, outside, after: 3, seen: 0, state: "armed" };
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(identity.swap?.state).toBe("swapped");
    expect(reviews).toBe(1);
    expect(output.terminal).toBe("failed");
    expect(await readdir(outside)).toEqual([]);
    // The link and the run directory it displaced are left where they are, and removed here.
    await rm(identity.swap!.path!, { force: true });
    await rm(`${identity.swap!.path!}.real`, { recursive: true, force: true });
  });

  it("removes nothing from a directory swapped into the run directory's place just before its removal", async () => {
    let runDirectory = "";
    identity.beforeRemove = async found => {
      runDirectory = found;
      await rename(found, `${found}.real`);
      await mkdir(found);
      await writeFile(path.join(found, "kept.txt"), "kept");
    };
    const output = await run(profile({ outputVia: "file" }));
    expect(output.terminal).toBe("completed");
    expect(await readFile(path.join(runDirectory, "kept.txt"), "utf8")).toBe("kept");
    await rm(runDirectory, { recursive: true, force: true });
    await rm(`${runDirectory}.real`, { recursive: true, force: true });
  });

  it("empties a run directory moved behind a link, removing no unrelated directory of its name beside it", async () => {
    const elsewhere = path.join(directory, "elsewhere");
    let runDirectory = "";
    identity.beforeRemove = async found => {
      runDirectory = found;
      await mkdir(elsewhere);
      await rename(found, path.join(elsewhere, "moved"));
      await mkdir(path.join(elsewhere, path.basename(found)));
      await symlink(path.join(elsewhere, "moved"), found);
    };
    const output = await run(profile({ outputVia: "file" }));
    expect(output.terminal).toBe("completed");
    expect((await readdir(elsewhere)).sort()).toEqual([path.basename(runDirectory), "moved"].sort());
    expect(await readdir(path.join(elsewhere, "moved"))).toEqual([]);
    await rm(runDirectory, { force: true });
  });

  it("removes only the link a CLI left in its attempt directory, never its target, and the whole run directory", async () => {
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "kept.txt"), "kept");
    let runDirectory = "";
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      const out = args[args.indexOf("--out") + 1];
      runDirectory = path.dirname(path.dirname(out));
      await mkdir(path.join(path.dirname(out), "nested", "deeper"), { recursive: true });
      await writeFile(path.join(path.dirname(out), "nested", "deeper", "note.txt"), "note");
      await symlink(outside, path.join(path.dirname(out), "nested", "link"));
      await symlink(path.join(directory, "missing"), path.join(path.dirname(out), "dangling"));
      await writeFile(out, JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] }));
      return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(output.terminal).toBe("completed");
    expect(await readFile(path.join(outside, "kept.txt"), "utf8")).toBe("kept");
    await expect(readdir(runDirectory)).rejects.toThrow(/ENOENT/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("still settles a run whose run directory cannot be removed", async () => {
    let attemptDirectory = "";
    identity.beforeRemove = async found => {
      attemptDirectory = (await readdir(found)).map(name => path.join(found, name))[0];
      await chmod(attemptDirectory, 0o500);
    };
    const output = await run(profile({ outputVia: "file" }));
    expect(output.terminal).toBe("completed");
    await chmod(attemptDirectory, 0o700);
    await rm(path.dirname(attemptDirectory), { recursive: true, force: true });
  });

  it("redacts a credential echoed under nested JSON escaping from the transcript, the repair prompt, the payload and the events", async () => {
    const credential = ["test-credential", '"quoted"', "\\back\\slash"].join("-");
    const nested = (depth: number) => Array.from({ length: depth }).reduce<string>(text => JSON.stringify(text), credential);
    const prompts: string[] = [];
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      prompts.push(options.stdin ?? "");
      const valid = { ...{ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] }, uninspected: [{ scope: "review", reason: `echo ${nested(3)}` }] };
      await writeFile(args[args.indexOf("--out") + 1], JSON.stringify(prompts.length === 1 ? { findings: `leaked ${nested(2)}` } : valid));
      return { code: 0, signal: null, stdout: `${JSON.stringify({ echo: nested(2) })}\n${JSON.stringify({ echo: nested(4) })}\n`, stderr: `${nested(3)}\n`, timedOut: false, canceled: false };
    };
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: credential }, runner }).run(input(configuration(profile({ outputVia: "file" }))));
    expect(output.terminal).toBe("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Repair: your previous answer was rejected");
    expect(JSON.stringify(output.uninspected)).toContain("[REDACTED]");
    // Escaping never changes the credential's letters, so none of them may survive in any form.
    for (const text of [output.transcript ?? "", prompts[1], JSON.stringify(output.uninspected), JSON.stringify(output.events)]) expect(text).not.toMatch(/quoted|slash/);
  });

  it("redacts a credential under eight levels of JSON escaping in linear time, beside a long run of backslashes", async () => {
    const credential = 'test-"deep"-value';
    const deep = Array.from({ length: 8 }).reduce<string>(text => JSON.stringify(text), credential);
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout: `${deep}\n${"\\".repeat(100_000)}\n${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    const started = Date.now();
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: credential }, runner }).run(input(configuration(profile())));
    expect(output.terminal).toBe("completed");
    expect(output.transcript).not.toContain("deep");
    expect(output.transcript).toContain('"inspectedPaths"');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("withholds only the line whose credential is nested past the redaction depth, so it is never stored recoverable", async () => {
    const credential = 'test-"deep"-value';
    const deeper = Array.from({ length: 9 }).reduce<string>(text => JSON.stringify(text), credential);
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout: `${deeper}\n${JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] })}\n`, stderr: "", timedOut: false, canceled: false };
    const output = await new CliHarnessAdapter({ environment: { ...environment(), REVIEW_AUTH: credential }, runner }).run(input(configuration(profile())));
    expect(output.terminal).toBe("completed");
    expect(output.transcript).not.toContain("deep");
    expect(output.transcript).toContain("[REDACTED]");
    // Only the line still escaped past the limit is withheld; the answer's line is kept.
    expect(output.transcript).toContain('"inspectedPaths"');
  });

  it("withholds 150,000 short lines escaped past the redaction depth and still completes", async () => {
    // Each `\u005c` decodes to a backslash that starts the next one, so this line is still escaped after nine levels.
    const line = `\\u005c${"u005c".repeat(9)}n`;
    const answer = JSON.stringify({ findings: [], evidence: [], inspectedPaths: ["src/index.ts"], uninspected: [] });
    const runner: CommandRunner = async (_command, args) => args.includes("--version")
      ? { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false }
      : { code: 0, signal: null, stdout: `${`${line}\n`.repeat(150_000)}${answer}\n`, stderr: "", timedOut: false, canceled: false };
    const output = await new CliHarnessAdapter({ environment: environment(), runner }).run(input(configuration(profile())));
    expect(output.error).toBeUndefined();
    expect(output.terminal).toBe("completed");
  }, 30_000);

  it("keeps its contract version after preflight, for the CLI's harness contract versions", async () => {
    const harness = new CliHarnessAdapter({ environment: environment() });
    await harness.preflight(configuration(profile()));
    expect(harness.capabilities).toMatchObject({ id: "cli", version: "1", toolControls: false });
  }, 20_000);
});
