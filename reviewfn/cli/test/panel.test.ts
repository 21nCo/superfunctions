import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, PANEL_CANCELED_REASON, PANEL_QUORUM_UNMET, parsePanelPolicy, type PanelPolicy, type PanelReport, type PanelSlot } from "@superfunctions/reviewfn-core";
import { FakeExecutionAdapter, FakePanelHarness, abortableDelay, slotOutput, type SlotBehavior } from "@superfunctions/reviewfn-testing";

import { initializePanelPolicy, PANEL_POLICY_TEMPLATE } from "../src/config.js";
import { PANEL_EXIT_CODES, PANEL_HARNESS_PACKAGES, parseArguments, publication, renderStoredReport, resolvePanelHarnesses, runPanelCommand, type PanelCommandDependencies } from "../src/panel.js";

const environment = { PATH: process.env.PATH, HOME: process.env.HOME };
const config = { ...DEFAULT_CONFIG, context: [{ adapter: "repository-markdown", paths: ["README.md"] }], harness: { adapter: "codex", version: "1" }, execution: { ...DEFAULT_CONFIG.execution, tests: [] } };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

function slot(id: string, stage: 1 | 2, model = `model-${id}`, adapter = "codex"): PanelSlot {
  return { id, stage, harness: { adapter, version: "1" }, inference: { provider: "openai", model, auth: "api-key" }, lens: "general", budget: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 } };
}

function panel(slots: PanelSlot[], overrides: Partial<PanelPolicy> = {}): PanelPolicy {
  return { version: 1, slots, quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", ...overrides };
}

let root: string, base: string, middle: string, head: string;
const owned: string[] = [];

/** A repository whose base commit carries the ReviewFn configuration and whose head changes `src/value.ts`. */
async function repository(panelPolicy: PanelPolicy): Promise<void> {
  root = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-panel-")); owned.push(root);
  git(root, "init", "--quiet");
  await mkdir(path.join(root, ".reviewfn"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await writeFile(path.join(root, ".reviewfn", "config.json"), JSON.stringify(config));
  await writeFile(path.join(root, ".reviewfn", "policy.json"), JSON.stringify(DEFAULT_POLICY));
  await writeFile(path.join(root, ".reviewfn", "panel.json"), JSON.stringify(panelPolicy));
  await writeFile(path.join(root, ".gitignore"), ".reviewfn/output/\n.reviewfn/artifacts/\n");
  await writeFile(path.join(root, "src", "value.ts"), "export const value = 0;\n");
  git(root, "add", "--all"); git(root, "commit", "--quiet", "-m", "base");
  base = git(root, "rev-parse", "HEAD");
  await writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\n");
  git(root, "commit", "--quiet", "-am", "middle");
  middle = git(root, "rev-parse", "HEAD");
  await writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n");
  git(root, "commit", "--quiet", "-am", "head");
  head = git(root, "rev-parse", "HEAD");
}

interface Invocation { code: number; stdout: string; stderr: string; imported: string[] }

/** Run `reviewfn panel` with `harness` installed as the fake module for every package in the fixed table. */
async function invoke(argv: string[], harness: FakePanelHarness | undefined, extra: PanelCommandDependencies = {}): Promise<Invocation> {
  let stdout = "", stderr = "";
  const imported: string[] = [];
  const importHarnessModule = async (name: string) => {
    imported.push(name);
    if (!harness || name !== PANEL_HARNESS_PACKAGES.codex.packageName) throw Object.assign(new Error(`Cannot find package '${name}' imported from fixture`), { code: "ERR_MODULE_NOT_FOUND" });
    // A constructor returning the shared fake, so tests can script and observe it.
    return { CodexHarnessAdapter: function CodexHarnessAdapter() { return harness; } };
  };
  const code = await runPanelCommand(parseArguments(["panel", "--root", root, ...argv]).flags, { importHarnessModule, execution: () => new FakeExecutionAdapter(), environment, stdout: text => { stdout += text; }, stderr: text => { stderr += text; }, ...extra });
  return { code, stdout, stderr, imported };
}

const codex = (behaviors: Record<string, SlotBehavior> = {}) => new FakePanelHarness({ id: "codex", behaviors });
const finding = (title: string) => ({ fingerprint: "", severity: "high" as const, category: "correctness" as const, title, trigger: `when ${title}`, impact: "wrong value", direction: "return the right value", evidenceIds: ["E1"], basis: "inferred" as const, requirementIds: [], lifecycle: "new" as const });
const reporting = (title: string): SlotBehavior => () => slotOutput({ evidence: [{ id: "E1", kind: "code", description: "value", code: { commit: head, path: "src/value.ts", startLine: 1 } }], findings: [finding(title)] });

async function stored(): Promise<{ report: PanelReport; markdown: string }> {
  const output = path.join(root, ".reviewfn", "output");
  return { report: JSON.parse(await readFile(path.join(output, "panel-report.json"), "utf8")), markdown: await readFile(path.join(output, "panel-report.md"), "utf8") };
}

beforeEach(() => { owned.length = 0; });
afterEach(async () => { await Promise.all(owned.map(directory => rm(directory, { recursive: true, force: true }))); });

describe("reviewfn panel exit codes", () => {
  it("exits 0 for a complete run, writes both reports and the evidence, and prints only the path and run ID with --json", async () => {
    await repository(panel([slot("one", 1)]));
    const harness = codex({ one: reporting("Wrong value") });
    const result = await invoke(["--base", base, "--head", head, "--json"], harness);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(PANEL_EXIT_CODES.complete);
    const { report, markdown } = await stored();
    expect(report.coverage).toBe("complete");
    expect(report.change.headCommit).toBe(head);
    expect(report.findings.map(item => item.title)).toEqual(["Wrong value"]);
    expect(result.stdout.endsWith("\n") && result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({ report: path.join(root, ".reviewfn", "output", "panel-report.json"), runId: report.runId });
    expect(markdown).toContain("Wrong value");
    // The evidence of the run is retained under .reviewfn/artifacts, including the stored panel report and slot output.
    const artifacts = await readdir(path.join(root, ".reviewfn", "artifacts"));
    expect(artifacts.some(name => name.startsWith("panel-report-") && name.endsWith(".artifact"))).toBe(true);
    expect(artifacts.some(name => name.startsWith("panel-slot-output-") && name.endsWith(".artifact"))).toBe(true);
    // Only the fixed table's package for the slot's adapter is ever requested.
    expect(result.imported).toEqual([PANEL_HARNESS_PACKAGES.codex.packageName]);
    // `reviewfn report --panel` re-renders the stored report exactly.
    expect(await renderStoredReport(parseArguments(["report", "--panel"]).flags, root)).toBe(markdown);
    // `reviewfn publish` publishes it as the single panel summary, and only under the panel profile.
    expect(publication(report, parseArguments(["publish"]).flags)).toEqual({ report, rendered: markdown, profile: "panel" });
    expect(() => publication(report, parseArguments(["publish", "--profile", "requirements"]).flags)).toThrow(/panel profile/);
    expect(() => publication({ ...report, slots: [] }, parseArguments(["publish"]).flags)).toThrow(/not a valid panel report/);
  });

  it("exits 2 when a stage's quorum is not met, and renders collapsed and void slots with their reasons", async () => {
    await repository(panel([slot("first", 1, "shared"), slot("twin", 1, "shared"), slot("swapped", 1)], { quorum: { stage1: 2, stage2: 0 } }));
    const harness = codex({ swapped: () => slotOutput({ observed: { model: "cheaper-model" } }) });
    const result = await invoke(["--base", base, "--head", head], harness);
    expect(result.code).toBe(PANEL_EXIT_CODES.incomplete);
    const { report, markdown } = await stored();
    expect(report.slotRuns.map(run => [run.slotId, run.terminal])).toEqual([["first", "completed"], ["twin", "collapsed"], ["swapped", "void"]]);
    expect(report.coverageReasons.some(reason => reason.startsWith(`${PANEL_QUORUM_UNMET}: stage 1`))).toBe(true);
    expect(markdown).toContain("collapsed: same identity as first");
    expect(markdown).toContain("void: model\\_mismatch");
    // Without --json, stdout is the rendered report.
    expect(result.stdout).toBe(`${markdown}\n`);
  });

  it("exits 2 for incomplete coverage even when quorum is met", async () => {
    await repository(panel([slot("one", 1)]));
    const result = await invoke(["--base", base, "--head", head], codex({ one: () => slotOutput({ inspectedPaths: [], uninspected: [{ scope: "src/value.ts", reason: "fixture skipped it" }] }) }));
    expect(result.code).toBe(PANEL_EXIT_CODES.incomplete);
    expect((await stored()).report.coverage).toBe("incomplete");
  });

  it("exits 3 with REVIEWFN_HARNESS_NOT_INSTALLED when a slot's adapter package is missing, before any harness runs", async () => {
    await repository(panel([slot("one", 1), slot("claude", 1, "model-claude", "claude-code")]));
    const harness = codex();
    const result = await invoke(["--base", base, "--head", head], harness);
    expect(result.code).toBe(PANEL_EXIT_CODES.preflight);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "REVIEWFN_HARNESS_NOT_INSTALLED", details: { adapter: "claude-code", packageName: "@superfunctions/reviewfn-harness-claude-code", slots: ["claude"] } });
    expect(harness.calls).toHaveLength(0);
    await expect(readFile(path.join(root, ".reviewfn", "output", "panel-report.json"))).rejects.toThrow();
  });

  it("exits 3 for an adapter outside the fixed table without loading any module for it", async () => {
    await repository(panel([slot("one", 1, "model-one", "./evil.js")]));
    const result = await invoke(["--base", base, "--head", head], codex());
    expect(result.code).toBe(PANEL_EXIT_CODES.preflight);
    expect(JSON.parse(result.stderr).error).toBe("REVIEWFN_HARNESS_UNSUPPORTED");
    expect(result.imported).toEqual([]);
  });

  it("exits 3 when a component's preflight refuses the run", async () => {
    await repository(panel([slot("one", 1)]));
    const harness = new FakePanelHarness({ id: "codex", version: "2" });
    const result = await invoke(["--base", base, "--head", head], harness);
    expect(result.code).toBe(PANEL_EXIT_CODES.preflight);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "REVIEWFN_PREFLIGHT_FAILED", details: { diagnostics: [expect.objectContaining({ code: "REVIEWFN_HARNESS_VERSION" })] } });
    expect(harness.calls).toHaveLength(0);
  });

  it("exits 4 when the run is canceled, and keeps the report that records the cancellation", async () => {
    await repository(panel([slot("one", 1), slot("two", 1)], { maxConcurrentSlots: 1 }));
    const controller = new AbortController();
    const harness = codex({ one: async input => { controller.abort(); await abortableDelay(60_000, input.signal); return slotOutput(); } });
    const result = await invoke(["--base", base, "--head", head, "--json"], harness, { signal: controller.signal });
    expect(result.code).toBe(PANEL_EXIT_CODES.canceled);
    const { report } = await stored();
    expect(report.coverageReasons).toContain(PANEL_CANCELED_REASON);
    expect(report.slotRuns.map(run => run.terminal)).toEqual(["canceled", "canceled"]);
    expect(JSON.parse(result.stdout).runId).toBe(report.runId);
    expect(() => publication(report, parseArguments(["publish"]).flags)).toThrow(/not canceled/);
  });

  it("exits 4 when canceled before the run starts", async () => {
    await repository(panel([slot("one", 1)]));
    const controller = new AbortController();
    controller.abort();
    const harness = codex();
    const result = await invoke(["--base", base, "--head", head], harness, { signal: controller.signal });
    expect(result.code).toBe(PANEL_EXIT_CODES.canceled);
    expect(JSON.parse(result.stderr).error).toBe("REVIEWFN_CANCELED");
    expect(harness.calls).toHaveLength(0);
  });

  it("exits 1 for an invalid argument and for an output directory it cannot write", async () => {
    await repository(panel([slot("one", 1)]));
    const invalid = await invoke(["--base", base, "--head", head, "--pull-request", "1x"], codex());
    expect(invalid.code).toBe(PANEL_EXIT_CODES.error);
    expect(JSON.parse(invalid.stderr).message).toMatch(/pull-request/);
    await writeFile(path.join(root, "not-a-directory"), "");
    const unwritable = await invoke(["--base", base, "--head", head, "--output", "not-a-directory"], codex());
    expect(unwritable.code).toBe(PANEL_EXIT_CODES.error);
  });

  it("passes --since and --pull-request to the run", async () => {
    await repository(panel([slot("one", 1)], { incremental: "delta" }));
    const harness = codex();
    const result = await invoke(["--base", base, "--head", head, "--since", middle, "--issue", "ISS-7", "--pull-request", "12"], harness);
    // Pull-request review with Codex requires action-proxy authentication: preflight refuses it.
    expect(result.code).toBe(PANEL_EXIT_CODES.preflight);
    expect(JSON.stringify(JSON.parse(result.stderr))).toContain("REVIEWFN_PR_AUTH_REQUIRED");
    const local = await invoke(["--base", base, "--head", head, "--since", "HEAD~1", "--issue", "ISS-7"], harness);
    expect(local.code).toBe(PANEL_EXIT_CODES.complete);
    const { report } = await stored();
    expect(report.changeDetail?.since).toBe(middle);
    expect(harness.input("one").change.headCommit).toBe(head);
  });

  it("reads the panel policy from the base revision in trusted mode, so the head cannot weaken it", async () => {
    await repository(panel([slot("one", 1), slot("two", 1)], { quorum: { stage1: 2, stage2: 0 } }));
    await writeFile(path.join(root, ".reviewfn", "panel.json"), JSON.stringify(panel([slot("one", 1), slot("two", 1)])));
    git(root, "commit", "--quiet", "-am", "weaken");
    const weakened = git(root, "rev-parse", "HEAD");
    const result = await invoke(["--base", base, "--head", weakened, "--trusted-config-from-base"], codex({ two: () => slotOutput({ terminal: "failed", inspectedPaths: [] }) }));
    expect(result.code).toBe(PANEL_EXIT_CODES.preflight);
    expect(JSON.parse(result.stderr).error).toBe("REVIEWFN_PANEL_POLICY_WEAKENED");
  });
});

describe("harness resolution through installed packages", () => {
  it("loads the installed Codex adapter and reports a missing adapter package as not installed", async () => {
    const installed = await resolvePanelHarnesses(panel([slot("one", 1)]), config);
    expect(installed.harnesses.map(harness => harness.capabilities.id)).toEqual(["codex"]);
    expect(installed.contractVersions).toEqual({});
    await expect(resolvePanelHarnesses(panel([slot("one", 1), slot("claude", 2, "model-claude", "claude-code")]), config)).rejects.toMatchObject({ code: "REVIEWFN_HARNESS_NOT_INSTALLED", details: { packageName: "@superfunctions/reviewfn-harness-claude-code" } });
  });

  it("records the contract version of an adapter other than the configured one before any preflight", async () => {
    const module = { CodexHarnessAdapter: function CodexHarnessAdapter() { return new FakePanelHarness({ id: "codex", version: "7", overwriteVersionOnPreflight: true, reportedVersion: "codex-cli 9" }); } };
    const resolved = await resolvePanelHarnesses(panel([slot("one", 1)]), { ...config, harness: { adapter: "cli", version: "1" } }, async () => module);
    expect(resolved.contractVersions).toEqual({ codex: "7" });
  });
});

describe("reviewfn init --panel and report --panel", () => {
  it("writes a valid panel policy template once", async () => {
    root = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-init-")); owned.push(root);
    const file = await initializePanelPolicy(root);
    expect(file).toBe(path.join(root, ".reviewfn", "panel.json"));
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(parsePanelPolicy(written)).toEqual(PANEL_POLICY_TEMPLATE);
    expect(written.slots.every((item: PanelSlot) => Object.hasOwn(PANEL_HARNESS_PACKAGES, item.harness.adapter) && item.lens === "general")).toBe(true);
    await expect(initializePanelPolicy(root)).rejects.toThrow(/overwrite/);
  });

  it("refuses to re-render a document that is not a panel report", async () => {
    root = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-report-")); owned.push(root);
    await writeFile(path.join(root, "bad.json"), JSON.stringify({ kind: "reviewfn-panel", schemaVersion: 1 }));
    await expect(renderStoredReport(parseArguments(["report", "--panel", "--input", "bad.json"]).flags, root)).rejects.toMatchObject({ code: "REVIEWFN_REPORT_INVALID" });
    await expect(renderStoredReport(parseArguments(["report", "--input", "bad.json"]).flags, root)).rejects.toThrow(/use reviewfn report --panel/);
  });
});
