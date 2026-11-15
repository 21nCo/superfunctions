import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, lensOutputSchema, type HarnessProfile, type ReviewFnConfig, type SlotHarnessInput } from "@superfunctions/reviewfn-core";

import { CliHarnessAdapter, cliArguments, cliEnvironment, lastJsonObjectLine, parseCliVersion, valueAtPath, withModelReportField } from "../src/index.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-cli.mjs");
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
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const environment = () => ({ PATH: process.env.PATH, HOME: "/home/operator", ALLOWED_ONE: "one", FIXTURE_API_KEY: ALLOWED_SECRET, OTHER_VAR: "other", GITHUB_TOKEN: "publication-private-token", REVIEW_AUTH: CREDENTIAL });

function profile(overrides: Partial<HarnessProfile> & { extra?: string[] } = {}): HarnessProfile {
  const { extra = [], ...rest } = overrides;
  const promptVia = rest.promptVia ?? "stdin";
  const outputVia = rest.outputVia ?? "stdout-last-json";
  return {
    argv: [FIXTURE, "--state", state, ...(promptVia === "file" ? ["--prompt", "{promptFile}"] : []), ...(outputVia === "file" ? ["--out", "{outputFile}"] : []), ...extra],
    promptVia, outputVia, envAllowlist: ["ALLOWED_ONE"], modelReport: "none",
    capabilities: { structuredOutput: false, sandbox: "tree-verified-only" }, versionArgv: [FIXTURE, "--version"],
    ...rest,
  };
}

function configuration(definition: HarnessProfile, model = MODEL): ReviewFnConfig {
  return { ...DEFAULT_CONFIG, harness: { adapter: "cli", version: "1", executable: process.execPath, profile: "fake", profileDefinition: definition }, inference: { provider: "fixture", model, auth: "api-key", credentialEnv: "REVIEW_AUTH" } };
}

function input(config: ReviewFnConfig, extra: Partial<SlotHarnessInput> = {}): SlotHarnessInput {
  return {
    runId: "run", workspace,
    change: { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: "a".repeat(40), headCommit: "b".repeat(40), mergeBaseCommit: "a".repeat(40), diffDigest: "c".repeat(64), changedPaths: ["src/index.ts"], capturedAt: "2026-01-01T00:00:00.000Z" },
    context: { version: 1, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 1, maxBytes: 1, maxDepth: 1 }, incompleteReasons: [], digest: "d".repeat(64) },
    policy: DEFAULT_POLICY, configuration: config, testReceipts: [], prompt: "Review the change.", outputSchema: lensOutputSchema,
    slot: { id: "slot", stage: 1, harness: { adapter: "cli", version: "1.2.3", executable: process.execPath, profile: "fake" }, inference: config.inference, lens: "general", budget: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 } },
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

  it("kills a CLI that keeps appending to its output file as soon as the file outgrows the budget, as a timeout", async () => {
    const started = Date.now();
    const output = await run(profile({ outputVia: "file", extra: ["--flood", "1"] }), undefined, { policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxOutputBytes: 200_000, harnessTimeoutMs: 60_000 } } });
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
    expect(call.argv).toHaveLength(definition.argv.length - 1);
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

  it.each([
    ["a relative executable", (config: ReviewFnConfig) => ({ ...config, harness: { ...config.harness, executable: "bin/agent" } }), "REVIEWFN_CLI_UNAVAILABLE"],
    ["no profile", (config: ReviewFnConfig) => ({ ...config, harness: { adapter: "cli", version: "1", executable: process.execPath } }), "REVIEWFN_HARNESS_PROFILE_REQUIRED"],
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

  it("keeps its contract version after preflight, for the CLI's harness contract versions", async () => {
    const harness = new CliHarnessAdapter({ environment: environment() });
    await harness.preflight(configuration(profile()));
    expect(harness.capabilities).toMatchObject({ id: "cli", version: "1", toolControls: false });
  }, 20_000);
});
