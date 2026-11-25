import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, PanelCoordinator, applyRepositoryPanelPolicy, type CommandRunner, type HarnessOutput, type HarnessProfile, type PanelPolicy, type PanelRunRequest, type PanelSlot, type SlotHarnessInput, type SlotHarnessOutput } from "@superfunctions/reviewfn-core";
import { FakeContextAdapter, FakeExecutionAdapter, FakeSourceControlAdapter, MemoryArtifactStore } from "@superfunctions/reviewfn-testing";

import { AGENT, LAUNCH } from "./launcher.js";
import { CliHarnessAdapter } from "../src/index.js";

const environment = { PATH: process.env.PATH, FIXTURE_KEY: "panel-fixture-credential" };
const manifest = { version: 1 as const, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 10, maxBytes: 1000, maxDepth: 2 }, incompleteReasons: [] };
const config = { ...DEFAULT_CONFIG, harness: { adapter: "codex", version: "1" }, context: [{ adapter: "fixture" }], execution: { ...DEFAULT_CONFIG.execution, adapter: "fake-execution" } };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

let repo: string, base: string, head: string, workspaceRoot: string, states: string;
beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-panel-repo-"));
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-panel-run-"));
  states = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-panel-state-"));
  git(repo, "init", "--quiet");
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src", "index.ts"), "export const value = 0;\n");
  git(repo, "add", "--all"); git(repo, "commit", "--quiet", "-m", "base");
  base = git(repo, "rev-parse", "HEAD");
  await writeFile(path.join(repo, "src", "index.ts"), "export function parse(body) {\n  return body.length;\n}\n");
  git(repo, "commit", "--quiet", "-am", "head");
  head = git(repo, "rev-parse", "HEAD");
});
afterAll(async () => { for (const directory of [repo, workspaceRoot, states]) await rm(directory, { recursive: true, force: true }); });

async function profile(name: string, modelReport: string, extra: string[] = []): Promise<HarnessProfile> {
  const state = path.join(states, name);
  await mkdir(state, { recursive: true });
  return { argv: [...LAUNCH, "--state", state, ...extra], promptVia: "stdin", outputVia: "stdout-last-json", envAllowlist: [], modelReport, capabilities: { structuredOutput: false, sandbox: "tree-verified-only" }, versionArgv: [...LAUNCH, "--version"] };
}

function slot(id: string, profileName: string, model: string, provider = "fixture"): PanelSlot {
  return { id, stage: 1, harness: { adapter: "cli", version: "1.2.3", executable: AGENT, profile: profileName }, inference: { provider, model, auth: "api-key", credentialEnv: "FIXTURE_KEY" }, lens: "general", budget: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 } };
}

/** A CLI harness that ends with `terminal` and reports a raw model mismatch while its recorded model reads as configured. */
class FlaggingHarness extends CliHarnessAdapter {
  public constructor(private readonly terminal: HarnessOutput["terminal"]) { super({ environment }); }

  public override async run(input: SlotHarnessInput): Promise<SlotHarnessOutput> {
    const reason = this.terminal === "completed" ? {} : { error: `The CLI ended ${this.terminal}.` };
    return { terminal: this.terminal, requirements: [], assessments: [], evidence: [], findings: [], inspectedPaths: ["src/index.ts"], uninspected: [], events: [], ...reason, observed: { harnessVersion: "1.2.3", model: input.configuration.inference.model, modelMismatch: true } };
  }
}

function coordinator(harness: CliHarnessAdapter = new CliHarnessAdapter({ environment }), abortGraceMs = 100): PanelCoordinator {
  return new PanelCoordinator({
    sourceControl: new FakeSourceControlAdapter({ baseCommit: base, headCommit: head, changedPaths: ["src/index.ts"] }), contexts: [new FakeContextAdapter("fixture", manifest)],
    execution: new FakeExecutionAdapter(), artifacts: new MemoryArtifactStore(), harnesses: [harness], harnessContractVersions: { cli: "1" }, workspaceRoot, abortGraceMs, environment,
  });
}

describe("generic CLI slots in the panel", () => {
  it("collapses unverified-model slots of one executable and profile, and voids a reporter mismatch", async () => {
    const panelPolicy: PanelPolicy = {
      version: 1,
      slots: [slot("quiet-a", "quiet", "model-a"), slot("quiet-b", "quiet", "model-b", "other-provider"), slot("reported", "reported", "model-r"), slot("wrong", "wrong", "model-r")],
      quorum: { stage1: 2, stage2: 0 }, requirementsSlot: null, incremental: "full",
      profiles: { quiet: await profile("quiet", "none"), reported: await profile("reported", "json-path:model", ["--model-json", "model-r"]), wrong: await profile("wrong", "json-path:model", ["--model-json", "model-x"]) },
    };
    const request: PanelRunRequest = { root: repo, base, head, config, policy: DEFAULT_POLICY, panelPolicy };
    expect((await coordinator().preflight(request)).filter(item => item.level === "error")).toEqual([]);
    const result = await coordinator().run(request);
    expect(result.validation).toMatchObject({ valid: true });
    const runs = Object.fromEntries(result.report.slotRuns.map(run => [run.slotId, run]));
    expect(runs["quiet-a"]).toMatchObject({ terminal: "completed", limitations: ["model_unverified", "sandbox_tree_verified_only"], identity: { harnessExecutable: AGENT, harnessProfile: "quiet", modelVerified: false, model: "model-a", harnessVersion: "1.2.3" } });
    // Another model and provider, but the same executable and profile with no model report: never a distinct identity.
    expect(runs["quiet-b"]).toMatchObject({ terminal: "collapsed", limitations: ["model_unverified", "sandbox_tree_verified_only"], identity: { modelVerified: false, model: "model-b" } });
    expect(runs.reported).toMatchObject({ terminal: "completed", limitations: ["sandbox_tree_verified_only"], identity: { model: "model-r", harnessProfile: "reported" } });
    expect(runs.reported.identity.modelVerified).toBeUndefined();
    expect(runs.wrong).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: "model-x" } });
    expect(result.quorum[0]).toMatchObject({ required: 2, completed: 2, met: true });
  }, 120_000);

  it("voids a slot whose CLI reported another model and then hung or exited nonzero", async () => {
    const panelPolicy: PanelPolicy = {
      version: 1,
      slots: [slot("hung", "hung", "model-r"), slot("exited", "exited", "model-r")],
      quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full",
      profiles: {
        hung: await profile("hung", "stderr-regex:served model: (\\S+)", ["--model-stderr", "model-x", "--hang", "1"]),
        exited: await profile("exited", "json-path:model", ["--model-json", "model-x", "--exit", "3"]),
      },
    };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 3_000 } };
    const result = await coordinator().run({ root: repo, base, head, config, policy, panelPolicy });
    expect(result.validation).toMatchObject({ valid: true });
    for (const run of result.report.slotRuns) expect(run).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: "model-x" } });
  }, 120_000);

  it("voids a slot whose CLI wrote a file answer reporting another model and then hung, within a short abort grace", async () => {
    const lingering: HarnessProfile = { ...await profile("lingering", "json-path:model", ["--out", "{outputFile}", "--model-json", "model-x", "--linger", "1"]), outputVia: "file" };
    const panelPolicy: PanelPolicy = { version: 1, slots: [slot("lingering", "lingering", "model-r")], quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", profiles: { lingering } };
    const policy = { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 2_000 } };
    const result = await coordinator(undefined, 50).run({ root: repo, base, head, config, policy, panelPolicy });
    expect(result.report.slotRuns[0]).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: "model-x" } });
  }, 60_000);

  it("voids a timed-out slot whose file model report fits its raw budget but not one narrowed by a withheld tail's marker", async () => {
    // 1,000 stdout bytes and a 19-byte report fit the 1,021 bytes a 1,024-byte budget leaves; with a 4-character
    // credential the cut stream's last 3 characters are withheld behind a marker 7 bytes longer than them.
    const runner: CommandRunner = async (_command, args, options) => {
      if (args.includes("--version")) return { code: 0, signal: null, stdout: "fake-cli version 1.2.3\n", stderr: "", timedOut: false, canceled: false };
      await writeFile(args[args.indexOf("--out") + 1], JSON.stringify({ model: "model-x" }));
      options.onOutput?.(1_000);
      return { code: null, signal: null, stdout: `${"z".repeat(998)}\nz`, stderr: "", timedOut: true, canceled: false };
    };
    const cut: HarnessProfile = { ...await profile("cut", "json-path:model", ["--out", "{outputFile}"]), outputVia: "file" };
    const panelPolicy: PanelPolicy = { version: 1, slots: [{ ...slot("cut", "cut", "model-r"), budget: { timeoutMs: 60_000, maxOutputBytes: 1_024 } }], quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", profiles: { cut } };
    const harness = new CliHarnessAdapter({ environment: { PATH: process.env.PATH, FIXTURE_KEY: "test" }, runner });
    const result = await coordinator(harness).run({ root: repo, base, head, config, policy: DEFAULT_POLICY, panelPolicy });
    expect(result.report.slotRuns[0]).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: "model-x" } });
  }, 60_000);

  it.each(["completed", "failed", "timed_out", "canceled"] as const)("voids a %s slot whose harness reported a mismatch that its recorded model hides", async terminal => {
    const panelPolicy: PanelPolicy = { version: 1, slots: [slot("flagged", "flagged", "model-r")], quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", profiles: { flagged: await profile("flagged", "json-path:model") } };
    const result = await coordinator(new FlaggingHarness(terminal)).run({ root: repo, base, head, config, policy: DEFAULT_POLICY, panelPolicy });
    expect(result.validation).toMatchObject({ valid: true });
    expect(result.report.slotRuns[0]).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: "model-r", modelMismatch: true } });
  }, 60_000);

  it("voids a slot whose CLI reported a model that differs from the configured one only past the stored length", async () => {
    const configured = `${"a".repeat(256)}…`;
    const panelPolicy: PanelPolicy = { version: 1, slots: [slot("long", "long", configured)], quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", profiles: { long: await profile("long", "json-path:model", ["--model-json", `${"a".repeat(256)}b`]) } };
    const result = await coordinator().run({ root: repo, base, head, config, policy: DEFAULT_POLICY, panelPolicy });
    expect(result.validation).toMatchObject({ valid: true });
    expect(result.report.slotRuns[0]).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: configured, modelMismatch: true } });
  }, 60_000);

  it("ends a slot whose CLI hangs after printing input that stalls its model reporter timed_out, within the stage deadline", async () => {
    const panelPolicy: PanelPolicy = { version: 1, slots: [slot("stalled", "stalled", "model-r")], quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", profiles: { stalled: await profile("stalled", String.raw`stderr-regex:^(?:a+)+(b)$`, ["--stderr", `${"a".repeat(40)}!`, "--hang", "1"]) } };
    const started = Date.now();
    const result = await coordinator().run({ root: repo, base, head, config, policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 2_000 } }, panelPolicy });
    expect(result.validation).toMatchObject({ valid: true });
    expect(result.report.slotRuns[0]).toMatchObject({ terminal: "timed_out" });
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);

  it("voids a slot whose CLI reported another model, printed text that stalls its reporter, and hung past its deadline", async () => {
    const panelPolicy: PanelPolicy = { version: 1, slots: [slot("stalling", "stalling", "model-r")], quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", profiles: { stalling: await profile("stalling", String.raw`stderr-regex:served model: (\S+)|(?:a+)+$`, ["--model-stderr", "model-x", "--stderr", `${"a".repeat(40)}!`, "--hang", "1"]) } };
    const result = await coordinator().run({ root: repo, base, head, config, policy: { ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, harnessTimeoutMs: 3_000 } }, panelPolicy });
    expect(result.validation).toMatchObject({ valid: true });
    expect(result.report.slotRuns[0]).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: "model-x" } });
  }, 120_000);

  it("refuses a pull-request review in preflight", async () => {
    const panelPolicy: PanelPolicy = { version: 1, slots: [slot("quiet-a", "quiet", "model-a")], quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", profiles: { quiet: await profile("quiet", "none") } };
    const diagnostics = await coordinator().preflight({ root: repo, base, head, config, policy: DEFAULT_POLICY, panelPolicy, pullRequest: 9 });
    expect(diagnostics.filter(item => item.level === "error").map(item => item.code)).toContain("REVIEWFN_PR_AUTH_REQUIRED");
  }, 60_000);

  it("rejects a repository panel copy that adds or changes a profile", async () => {
    const quiet = await profile("quiet", "none");
    const trusted: PanelPolicy = { version: 1, slots: [slot("quiet-a", "quiet", "model-a")], quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", profiles: { quiet } };
    expect(() => applyRepositoryPanelPolicy(trusted, { ...trusted, profiles: { quiet, extra: quiet } })).toThrow(expect.objectContaining({ code: "REVIEWFN_PANEL_POLICY_WEAKENED", message: expect.stringContaining("adds harness profile extra") }));
    expect(() => applyRepositoryPanelPolicy(trusted, { ...trusted, profiles: { quiet: { ...quiet, envAllowlist: ["AWS_SECRET_ACCESS_KEY"] } } })).toThrow(expect.objectContaining({ code: "REVIEWFN_PANEL_POLICY_WEAKENED", message: expect.stringContaining("changes harness profile quiet") }));
  });
});
