import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, FileArtifactStore, PANEL_CANCELED_REASON, PANEL_QUORUM_UNMET, PANEL_REPORT_COPY_NAMES, panelReportCanceled, parsePanelPolicy, type PanelPolicy, type PanelReport, type PanelSlot, type ReviewFnConfig } from "@superfunctions/reviewfn-core";
import { GitHubAdvisoryPublisher, GitHubApi } from "@superfunctions/reviewfn-github";
import { FakeExecutionAdapter, FakePanelHarness, abortableDelay, slotOutput, type SlotBehavior } from "@superfunctions/reviewfn-testing";

import { initializePanelPolicy, PANEL_POLICY_TEMPLATE } from "../src/config.js";
import { createReviewSnapshot, PANEL_EXIT_CODES, PANEL_HARNESS_PACKAGES, parseArguments, publication, renderStoredReport, resolvePanelHarnesses, runPanelCommand, savePanelRun, type PanelCommandDependencies, type PanelOutputLocations } from "../src/panel.js";

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

/** The real panel store, calling a step's hook (which may abort or throw) at retention cleanup, the Markdown copy write or the import. */
class ScriptedStore extends FileArtifactStore {
  public constructor(locations: PanelOutputLocations, private readonly hooks: { cleanup?: () => void; markdown?: () => void; importing?: () => void }) { super(locations.artifactsDirectory, locations.outputDirectory, PANEL_REPORT_COPY_NAMES); }
  public override async deleteExpired(now?: Date) { this.hooks.cleanup?.(); return super.deleteExpired(now); }
  public override async importFrom(sourceRoot: string) { this.hooks.importing?.(); return super.importFrom(sourceRoot); }
  protected override async writeCopyFile(file: string, content: string): Promise<void> {
    if (file.endsWith(".md")) this.hooks.markdown?.();
    await super.writeCopyFile(file, content);
  }
}

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
    // The finding has no anchor of its own; the evidence it cites locates it, in the Markdown and the published summary.
    expect(report.findings[0].anchor).toBeUndefined();
    const location = `(code): value; \`src/value.ts:1\` at \`${head}\``;
    expect(markdown).toContain(location);
    expect(publication(report, parseArguments(["publish"]).flags).rendered).toContain(location);
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

  it("exits 1 and prints no report line when the private snapshot cannot be removed after a complete run", async () => {
    await repository(panel([slot("one", 1)]));
    const removed: string[] = [];
    const removeSnapshot = async (directory: string) => { removed.push(directory); await rm(directory, { recursive: true, force: true }); throw new Error("ENOTEMPTY: fixture"); };
    const result = await invoke(["--base", base, "--head", head, "--json"], codex(), { removeSnapshot });
    expect(result.code).toBe(PANEL_EXIT_CODES.error);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "REVIEWFN_SNAPSHOT_CLEANUP_FAILED", details: { snapshot: removed[0] } });
    expect(removed).toHaveLength(1);
    // The report itself was saved; only the exit code and stdout reflect the cleanup failure.
    expect((await stored()).report.coverage).toBe("complete");
  });

  it("exits 1 and prints no report line when retention cleanup fails, while the report is saved", async () => {
    await repository(panel([slot("one", 1)]));
    // Metadata that cleanup cannot parse makes deleteExpired report an error without stopping the save.
    await mkdir(path.join(root, ".reviewfn", "artifacts"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, ".reviewfn", "artifacts", "broken.json"), "not json");
    const result = await invoke(["--base", base, "--head", head, "--json"], codex());
    expect(result.code).toBe(PANEL_EXIT_CODES.error);
    expect(JSON.parse(result.stderr).error).toBe("REVIEWFN_RETENTION_CLEANUP_FAILED");
    expect(result.stdout).toBe("");
    expect((await stored()).report.coverage).toBe("complete");
  });

  it("exits 2 for incomplete coverage even when quorum is met", async () => {
    await repository(panel([slot("one", 1)]));
    const result = await invoke(["--base", base, "--head", head], codex({ one: () => slotOutput({ inspectedPaths: [], uninspected: [{ scope: "src/value.ts", reason: "fixture skipped it" }] }) }));
    expect(result.code).toBe(PANEL_EXIT_CODES.incomplete);
    expect((await stored()).report.coverage).toBe("incomplete");
  });

  it("keeps panel-report.json and panel-report.md under report retention, so cleanup expires them", async () => {
    await repository(panel([slot("one", 1)]));
    expect((await invoke(["--base", base, "--head", head], codex())).code).toBe(PANEL_EXIT_CODES.complete);
    const output = path.join(root, ".reviewfn", "output");
    const store = new FileArtifactStore(path.join(root, ".reviewfn", "artifacts"), output, PANEL_REPORT_COPY_NAMES);
    const reportDays = Math.min(config.retention.reportDays, DEFAULT_POLICY.retention.reportDays);
    expect((await store.deleteExpired(new Date(Date.now() + (reportDays - 1) * 86_400_000))).errors).toEqual([]);
    expect((await readdir(output)).sort()).toEqual([".panel-report-copies", "panel-report.json", "panel-report.md"]);
    expect((await store.deleteExpired(new Date(Date.now() + (reportDays + 1) * 86_400_000))).errors).toEqual([]);
    expect(await readdir(output)).toEqual([]);
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

  it("lets two repositories alternate on one absolute --output, every run exiting 0 and keeping its own pair", async () => {
    const output = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-panel-shared-")); owned.push(output);
    const repositories: { root: string; base: string; head: string }[] = [];
    for (const _ of [1, 2]) { await repository(panel([slot("one", 1)])); repositories.push({ root, base, head }); }
    for (const run of [...repositories, ...repositories]) {
      ({ root, base, head } = run);
      const result = await invoke(["--base", base, "--head", head, "--output", output, "--json"], codex());
      expect([result.code, result.stderr]).toEqual([PANEL_EXIT_CODES.complete, ""]);
      const saved = JSON.parse(await readFile(path.join(output, "panel-report.json"), "utf8")) as PanelReport;
      expect(JSON.parse(result.stdout)).toEqual({ report: path.join(output, "panel-report.json"), runId: saved.runId });
      expect(await readFile(path.join(output, "panel-report.md"), "utf8")).toContain(saved.runId);
    }
    expect((await readdir(output)).sort()).toEqual([".panel-report-copies", "panel-report.json", "panel-report.md"]);
  });

  it("exits 3 before any harness runs, writing nothing, when the output directory's lock is still held", async () => {
    await repository(panel([slot("one", 1)]));
    const output = path.join(root, ".reviewfn", "output");
    await mkdir(output, { recursive: true });
    // A lock a killed run left behind: it is never reclaimed automatically.
    await writeFile(path.join(output, ".panel-report.lock"), JSON.stringify({ pid: 1, hostname: "crashed", acquiredAt: new Date().toISOString() }));
    const harness = codex();
    const result = await invoke(["--base", base, "--head", head, "--json"], harness);
    expect(result.code).toBe(PANEL_EXIT_CODES.preflight);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "REVIEWFN_OUTPUT_DIRECTORY_BUSY", details: { directory: output, lock: path.join(output, ".panel-report.lock") } });
    expect(harness.calls).toHaveLength(0);
    expect(result.stdout).toBe("");
    expect(await readdir(output)).toEqual([".panel-report.lock"]);
    expect((await readdir(path.join(root, ".reviewfn"))).sort()).toEqual(["config.json", "output", "panel.json", "policy.json"]);
  });

  it("exits 4 promptly, before any harness runs and saving nothing, when canceled while waiting for a held output lock", async () => {
    await repository(panel([slot("one", 1)]));
    const output = path.join(root, ".reviewfn", "output");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, ".panel-report.lock"), JSON.stringify({ pid: 1, hostname: "crashed", acquiredAt: new Date().toISOString() }));
    const controller = new AbortController();
    let waits = 0;
    class CancelingStore extends FileArtifactStore {
      // SIGINT arrives during the first wait for the held lock.
      protected override async outputLockRetry(signal?: AbortSignal): Promise<void> { waits++; controller.abort(); await super.outputLockRetry(signal); }
    }
    const harness = codex();
    const result = await invoke(["--base", base, "--head", head, "--json"], harness, { signal: controller.signal, reportCopiesStore: locations => new CancelingStore(locations.artifactsDirectory, locations.outputDirectory, PANEL_REPORT_COPY_NAMES) });
    expect(result.code).toBe(PANEL_EXIT_CODES.canceled);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "REVIEWFN_CANCELED", details: { lock: path.join(output, ".panel-report.lock") } });
    expect(waits).toBe(1);
    expect(harness.calls).toHaveLength(0);
    expect(result.stdout).toBe("");
    expect(await readdir(output)).toEqual([".panel-report.lock"]);
    expect((await readdir(path.join(root, ".reviewfn"))).sort()).toEqual(["config.json", "output", "panel.json", "policy.json"]);
  });

  it("exits 3 before any harness runs, writing nothing, when the output directory is the artifacts directory", async () => {
    await repository(panel([slot("one", 1)]));
    const harness = codex();
    const result = await invoke(["--base", base, "--head", head, "--output", ".reviewfn/artifacts", "--json"], harness);
    expect(result.code).toBe(PANEL_EXIT_CODES.preflight);
    expect(JSON.parse(result.stderr)).toMatchObject({ error: "REVIEWFN_ARTIFACT_UNSAFE", details: { directory: path.join(root, ".reviewfn", "artifacts") } });
    expect(harness.calls).toHaveLength(0);
    expect(result.stdout).toBe("");
    expect((await readdir(path.join(root, ".reviewfn"))).sort()).toEqual(["config.json", "panel.json", "policy.json"]);
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
    expect(() => publication(report, parseArguments(["publish"]).flags)).toThrow(/canceled panel report is never published/);
  });

  it("keeps the saved report of a canceled run recognizably canceled when a collected secret appears in the cancellation marker", async () => {
    await repository(panel([slot("one", 1), slot("two", 1)], { maxConcurrentSlots: 1 }));
    const controller = new AbortController();
    const harness = codex({ one: async input => { controller.abort(); await abortableDelay(60_000, input.signal); return slotOutput(); } });
    // "panel" is a substring of PANEL_CANCELED_REASON; the coordinator redacts collected secrets from every other reason.
    const result = await invoke(["--base", base, "--head", head, "--json"], harness, { signal: controller.signal, environment: { ...environment, DB_PASSWORD: "panel" } });
    expect(result.code).toBe(PANEL_EXIT_CODES.canceled);
    const { report } = await stored();
    expect(report.coverageReasons).toContain(PANEL_CANCELED_REASON);
    expect(panelReportCanceled(report)).toBe(true);
    expect(() => publication(report, parseArguments(["publish"]).flags)).toThrow(/canceled panel report is never published/);
    const requests: string[] = [];
    const api = new GitHubApi({ owner: "acme", repository: "repo", token: "secret", fetch: async (url: string | URL | Request) => { requests.push(String(url)); throw new Error("no request is expected"); } });
    // The publisher checks the publication identity first; the coverage reasons stay exactly as the coordinator stored them.
    const published = { ...report, change: { ...report.change, repositoryId: "https://github.com/acme/repo", pullRequest: 1 } };
    expect(await new GitHubAdvisoryPublisher({ api, pullRequest: 1 }).publish({ report: published, rendered: "canceled", expectedHead: head, profile: "panel" })).toEqual({ status: "failed", error: expect.stringMatching(/canceled/) });
    expect(requests).toEqual([]);
  });

  it("names the leftover snapshot on stderr, keeps exit 3 or 4 and prints no report when the snapshot cannot be removed", async () => {
    await repository(panel([slot("one", 1)]));
    const removeSnapshot = async (directory: string) => { await rm(directory, { recursive: true, force: true }); throw new Error("EBUSY: fixture"); };
    const errors = (stderr: string) => stderr.trim().split("\n").map(line => JSON.parse(line) as { error: string; details?: { snapshot?: string } });
    // After a preflight rejection by a component (the snapshot exists by then).
    const rejected = await invoke(["--base", base, "--head", head], new FakePanelHarness({ id: "codex", version: "2" }), { removeSnapshot });
    expect(rejected.code).toBe(PANEL_EXIT_CODES.preflight);
    expect(errors(rejected.stderr).map(item => item.error)).toEqual(["REVIEWFN_PREFLIGHT_FAILED", "REVIEWFN_SNAPSHOT_CLEANUP_FAILED"]);
    expect(errors(rejected.stderr)[1].details?.snapshot).toMatch(/reviewfn-panel-cli-/);
    // After a saved canceled run.
    await repository(panel([slot("one", 1), slot("two", 1)], { maxConcurrentSlots: 1 }));
    const controller = new AbortController();
    const harness = codex({ one: async input => { controller.abort(); await abortableDelay(60_000, input.signal); return slotOutput(); } });
    const canceledRun = await invoke(["--base", base, "--head", head, "--json"], harness, { signal: controller.signal, removeSnapshot });
    expect(canceledRun.code).toBe(PANEL_EXIT_CODES.canceled);
    expect(canceledRun.stdout).toBe("");
    expect(errors(canceledRun.stderr).map(item => item.error)).toEqual(["REVIEWFN_CANCELED", "REVIEWFN_SNAPSHOT_CLEANUP_FAILED"]);
    expect((await stored()).report.coverageReasons).toContain(PANEL_CANCELED_REASON);
  });

  it("exits 1, or 4 when canceled, when the private snapshot or the run's artifact store cannot be created", async () => {
    await repository(panel([slot("one", 1)]));
    const harness = codex();
    const cloneFails: typeof createReviewSnapshot = async () => { throw Object.assign(new Error("EIO: clone failed"), { code: "EIO" }); };
    // A file where the run's artifact store belongs makes its mkdir fail.
    const mkdirFails: typeof createReviewSnapshot = async (...args) => { const snapshot = await createReviewSnapshot(...args); await writeFile(path.join(args[1], "artifacts"), ""); return snapshot; };
    for (const createSnapshot of [cloneFails, mkdirFails]) {
      const result = await invoke(["--base", base, "--head", head], harness, { createSnapshot });
      expect(result.code).toBe(PANEL_EXIT_CODES.error);
      expect(JSON.parse(result.stderr).error).toBe("REVIEWFN_UNEXPECTED");
    }
    const controller = new AbortController();
    const abortedClone: typeof createReviewSnapshot = async () => { controller.abort(); throw new Error("clone was killed"); };
    const canceledSetup = await invoke(["--base", base, "--head", head], harness, { createSnapshot: abortedClone, signal: controller.signal });
    expect(canceledSetup.code).toBe(PANEL_EXIT_CODES.canceled);
    expect(harness.calls).toHaveLength(0);
    await expect(readFile(path.join(root, ".reviewfn", "output", "panel-report.json"))).rejects.toThrow();
  });

  it("exits 4, not 3, when the run is canceled while a harness preflight is running", async () => {
    await repository(panel([slot("one", 1)]));
    const controller = new AbortController();
    // A harness whose preflight observes the abort and rejects, as a real adapter does when its probe is killed.
    class AbortedPreflight extends FakePanelHarness {
      public override async preflight(_config: ReviewFnConfig): Promise<never> { controller.abort(); throw new Error("preflight probe was killed"); }
    }
    const harness = new AbortedPreflight({ id: "codex" });
    const result = await invoke(["--base", base, "--head", head], harness, { signal: controller.signal });
    expect(result.code).toBe(PANEL_EXIT_CODES.canceled);
    expect(JSON.parse(result.stderr).error).toBe("REVIEWFN_CANCELED");
    await expect(readFile(path.join(root, ".reviewfn", "output", "panel-report.json"))).rejects.toThrow();
  });

  it("saves and imports nothing and exits 4 when canceled after the run returned but before its report was saved", async () => {
    await repository(panel([slot("one", 1)]));
    expect((await invoke(["--base", base, "--head", head], codex())).code).toBe(PANEL_EXIT_CODES.complete);
    const { report } = await stored();
    const ownedArtifacts = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-owned-")); owned.push(ownedArtifacts);
    // The run's private store holds its completed report artifact, as after coordinator.run returns.
    const { id } = await new FileArtifactStore(ownedArtifacts).put("panel-report", JSON.stringify({ ...report, runId: "late-run" }), 30);
    const locations = { ownedArtifacts, artifactsDirectory: path.join(root, ".reviewfn", "artifacts"), outputDirectory: path.join(root, "late"), reportDays: 30 };
    const controller = new AbortController();
    controller.abort();
    const late = await savePanelRun(report, true, locations, controller.signal);
    expect(late).toMatchObject({ exitCode: PANEL_EXIT_CODES.canceled, error: expect.objectContaining({ code: "REVIEWFN_CANCELED" }) });
    expect(late.reportPath).toBeUndefined();
    expect(await readdir(locations.outputDirectory).catch(() => [])).toEqual([]);
    expect(await readdir(locations.artifactsDirectory)).not.toContain(`${id}.artifact`);
    // A report that records the cancellation is saved (it cannot be published) and still exits 4.
    const canceledReport = { ...report, coverage: "incomplete" as const, coverageReasons: [PANEL_CANCELED_REASON] };
    const recorded = await savePanelRun(canceledReport, true, locations, controller.signal);
    expect(recorded.exitCode).toBe(PANEL_EXIT_CODES.canceled);
    expect(JSON.parse(await readFile(recorded.reportPath!, "utf8")).coverageReasons).toEqual([PANEL_CANCELED_REASON]);
    // Saving to another output directory leaves the first directory's copies under their own retention.
    const output = path.join(root, ".reviewfn", "output");
    const first = new FileArtifactStore(locations.artifactsDirectory, output, PANEL_REPORT_COPY_NAMES);
    expect((await first.deleteExpired(new Date(Date.now() + 400 * 86_400_000))).errors).toEqual([]);
    expect(await readdir(output)).toEqual([]);
  });

  it("exits 4, not 1, when saving the report copies fails for a canceled run", async () => {
    await repository(panel([slot("one", 1)]));
    expect((await invoke(["--base", base, "--head", head], codex())).code).toBe(PANEL_EXIT_CODES.complete);
    const { report } = await stored();
    const empty = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-owned-")); owned.push(empty);
    // The output directory is a file, so writing the copies fails after the commit point.
    await writeFile(path.join(root, "blocked"), "");
    const locations = { ownedArtifacts: empty, artifactsDirectory: path.join(root, ".reviewfn", "artifacts"), outputDirectory: path.join(root, "blocked"), reportDays: 30 };
    const canceledReport = { ...report, coverage: "incomplete" as const, coverageReasons: [PANEL_CANCELED_REASON] };
    expect(await savePanelRun(canceledReport, true, locations)).toMatchObject({ exitCode: PANEL_EXIT_CODES.canceled, error: expect.objectContaining({ code: "REVIEWFN_CANCELED" }) });
  });

  it("saves the whole run or nothing of it, wherever a real cancellation or a failure lands while saving", async () => {
    await repository(panel([slot("one", 1)]));
    expect((await invoke(["--base", base, "--head", head], codex())).code).toBe(PANEL_EXIT_CODES.complete);
    const { report } = await stored();
    const fail = () => { throw new Error("simulated save failure"); };
    // [case, hooks given the controller, exit code, whether the run's copies are saved, whether its evidence is imported]
    const cases: [string, (controller: AbortController) => ConstructorParameters<typeof ScriptedStore>[1], number, boolean, boolean][] = [
      ["canceled during retention cleanup", controller => ({ cleanup: () => controller.abort() }), PANEL_EXIT_CODES.canceled, false, false],
      // Once saving has begun a cancellation no longer applies: a failure is exit 1, never an exit 4 with saved output.
      ["canceled while the import fails", controller => ({ importing: () => { controller.abort(); fail(); } }), PANEL_EXIT_CODES.error, false, false],
      ["the import fails", () => ({ importing: fail }), PANEL_EXIT_CODES.error, false, false],
      ["canceled while the Markdown copy fails", controller => ({ markdown: () => { controller.abort(); fail(); } }), PANEL_EXIT_CODES.error, false, true],
      ["canceled once the copies are being written", controller => ({ markdown: () => controller.abort() }), PANEL_EXIT_CODES.complete, true, true],
    ];
    for (const [name, hooks, exitCode, saved, imported] of cases) {
      const ownedArtifacts = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-owned-")); owned.push(ownedArtifacts);
      const { id } = await new FileArtifactStore(ownedArtifacts).put("panel-report", JSON.stringify({ ...report, runId: name }), 30);
      const locations = { ownedArtifacts, artifactsDirectory: path.join(root, ".reviewfn", "artifacts"), outputDirectory: path.join(root, name.replaceAll(" ", "-")), reportDays: 30 };
      const controller = new AbortController();
      const result = await savePanelRun(report, true, locations, controller.signal, new ScriptedStore(locations, hooks(controller)));
      expect([name, result.exitCode]).toEqual([name, exitCode]);
      expect([name, (await readdir(locations.outputDirectory).catch(() => [])).sort()]).toEqual([name, saved ? [".panel-report-copies", "panel-report.json", "panel-report.md"] : []]);
      expect([name, (await readdir(locations.artifactsDirectory)).includes(`${id}.artifact`)]).toEqual([name, imported]);
    }
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
    for (const name of ["base", "head", "since", "issue", "pull-request", "panel", "output", "root", "config", "policy", "target-branch"]) {
      // A bare value flag, last on the command line, or an empty inline value is rejected rather than ignored or
      // replaced by its default (`--output=` would otherwise write into the repository root).
      for (const flag of [`--${name}`, `--${name}=`]) {
        const bare = await invoke(["--base", base, "--head", head, flag], codex());
        expect(bare.code).toBe(PANEL_EXIT_CODES.error);
        expect(JSON.parse(bare.stderr).message).toBe(`--${name} requires a value.`);
      }
    }
    expect((await readdir(root)).sort()).toEqual([".git", ".gitignore", ".reviewfn", "README.md", "src"]);
    expect((await readdir(path.join(root, ".reviewfn"))).sort()).toEqual(["config.json", "panel.json", "policy.json"]);
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

  it("exits 3 when --base, --head or --since names a commit that does not exist", async () => {
    await repository(panel([slot("one", 1)]));
    const harness = codex();
    for (const argv of [["--base", "no-such-ref", "--head", head], ["--base", base, "--head", "no-such-ref"], ["--base", base, "--head", head, "--since", "no-such-ref"]]) {
      const result = await invoke(argv, harness);
      expect(result.code).toBe(PANEL_EXIT_CODES.preflight);
      expect(JSON.parse(result.stderr).message).toContain("no-such-ref");
    }
    expect(harness.calls).toHaveLength(0);
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
    const missing = async (name: string) => { throw Object.assign(new Error(`Cannot find package '${name}' imported from ${import.meta.url}`), { code: "ERR_MODULE_NOT_FOUND" }); };
    await expect(resolvePanelHarnesses(panel([slot("one", 1), slot("generic", 2, "model-generic", "cli")]), config, async name => name === "@superfunctions/reviewfn-harness-cli" ? missing(name) : import(name))).rejects.toMatchObject({ code: "REVIEWFN_HARNESS_NOT_INSTALLED", details: { packageName: "@superfunctions/reviewfn-harness-cli" } });
  });

  it("loads the installed generic CLI adapter with its contract version", async () => {
    const resolved = await resolvePanelHarnesses(panel([slot("one", 1), slot("generic", 2, "model-generic", "cli")]), config);
    expect(resolved.harnesses.map(harness => [harness.capabilities.id, harness.constructor.name])).toEqual([["codex", "CodexHarnessAdapter"], ["cli", "CliHarnessAdapter"]]);
    expect(resolved.contractVersions).toEqual({ cli: "1" });
  });

  it("loads the installed Claude Code adapter with its contract version", async () => {
    const resolved = await resolvePanelHarnesses(panel([slot("one", 1), slot("claude", 2, "model-claude", "claude-code")]), config);
    expect(resolved.harnesses.map(harness => [harness.capabilities.id, harness.constructor.name])).toEqual([["codex", "CodexHarnessAdapter"], ["claude-code", "ClaudeCodeHarnessAdapter"]]);
    expect(resolved.contractVersions).toEqual({ "claude-code": "1" });
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

  it("refuses a bare --input and a value given to --panel instead of rendering the default report", async () => {
    root = await mkdtemp(path.join(tmpdir(), "reviewfn-cli-report-flags-")); owned.push(root);
    await mkdir(path.join(root, ".reviewfn", "output"), { recursive: true });
    await writeFile(path.join(root, ".reviewfn", "output", "report.json"), "{}");
    await writeFile(path.join(root, "other.json"), "{}");
    for (const argv of [["report", "--input"], ["report", "--panel", "--input"], ["report", "--input="], ["report", "--panel", "--input="]]) await expect(renderStoredReport(parseArguments(argv).flags, root)).rejects.toThrow("--input requires a value.");
    await expect(renderStoredReport(parseArguments(["report", "--root="]).flags, root)).rejects.toThrow("--root requires a value.");
    await expect(renderStoredReport(parseArguments(["report", "--panel", "other.json"]).flags, root)).rejects.toThrow("--panel takes no value; use --input other.json to choose the report.");
  });
});

describe("reviewfn panel code references", () => {
  it("gives every slot the code-reference map, with the pairs of the panel policy", async () => {
    const policy = panel([slot("one", 1), slot("two", 1)], { contextPairs: [{ when: "src/**", include: ["README.md"] }] });
    await repository(policy);
    // A local run reads the working-tree configuration, which now asks for code references.
    await writeFile(path.join(root, ".reviewfn", "config.json"), JSON.stringify({ ...config, context: [{ adapter: "code-references" }] }));
    const harness = codex();
    const result = await invoke(["--base", base, "--head", head], harness);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(PANEL_EXIT_CODES.complete);
    expect(harness.calls.map(call => call.context.sources.map(source => [source.id, source.type]))).toEqual([[["code-references:map", "other"]], [["code-references:map", "other"]]]);
    for (const call of harness.calls) {
      const payload = JSON.parse(call.prompt.slice(call.prompt.indexOf("\n{\n") + 1)) as { codeReferences: Array<{ symbols: Array<{ name: string }>; references: Array<{ symbol: string; matches: Array<{ path: string }> }>; pairedFiles: Array<{ path: string }> }> };
      expect(payload.codeReferences).toHaveLength(1);
      expect(payload.codeReferences[0].symbols.map(symbol => symbol.name)).toEqual(["value"]);
      expect(payload.codeReferences[0].references[0].matches.map(match => match.path)).toEqual(["src/value.ts"]);
      expect(payload.codeReferences[0].pairedFiles.map(file => file.path)).toEqual(["README.md"]);
    }
  });
});
