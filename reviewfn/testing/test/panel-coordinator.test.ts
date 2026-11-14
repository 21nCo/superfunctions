import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG, DEFAULT_POLICY, GENERAL_LENS, GitSlotWorkspaceProvider, LensRegistry, PANEL_QUORUM_UNMET, PanelCoordinator, validatePanelReport,
  type ChangeHunks, type Evidence, type Finding, type HarnessOutput, type PanelCoordinatorDependencies, type PanelHarnessAdapter, type PanelPolicy, type PanelRunRequest, type PanelSlot, type SlotHarnessOutput, type WorkspaceCheck,
} from "@superfunctions/reviewfn-core";
import { FakeContextAdapter, FakeExecutionAdapter, FakePanelHarness, FakeSourceControlAdapter, MemoryArtifactStore, abortableDelay, slotOutput } from "../src/index.js";

const manifest = { version: 1 as const, sources: [{ id: "issue:1", type: "issue" as const, retrievedAt: "2026-01-01T00:00:00.000Z", digest: "d".repeat(64), status: "available" as const, content: "must return value" }], selection: { candidates: ["ISS-1"], selected: ["issue:1"], rule: "explicit" }, limits: { maxSources: 10, maxBytes: 1000, maxDepth: 2 }, incompleteReasons: [] };
const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, categories: ["behavior" as const] }, harness: { adapter: "fake", version: "1" }, inference: { provider: "fake", model: "fixture", auth: "none" }, context: [{ adapter: "fixture", issue: "ISS-1" }], execution: { ...DEFAULT_CONFIG.execution, adapter: "fake-execution" } };
const policy = { ...DEFAULT_POLICY, requiredCategories: ["behavior" as const] };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

let repo: string, base: string, middle: string, head: string;
beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "reviewfn-panel-repo-"));
  git(repo, "init", "--quiet");
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src", "value.ts"), "export const value = 0;\n");
  git(repo, "add", "--all"); git(repo, "commit", "--quiet", "-m", "base");
  base = git(repo, "rev-parse", "HEAD");
  await writeFile(path.join(repo, "src", "value.ts"), "export const value = 1;\n");
  git(repo, "commit", "--quiet", "-am", "middle");
  middle = git(repo, "rev-parse", "HEAD");
  await writeFile(path.join(repo, "src", "other.ts"), "export const other = 2;\n");
  git(repo, "add", "--all"); git(repo, "commit", "--quiet", "-m", "head");
  head = git(repo, "rev-parse", "HEAD");
});
afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

let workspaceRoot: string;
beforeEach(async () => { workspaceRoot = await mkdtemp(path.join(tmpdir(), "reviewfn-panel-run-")); });
afterEach(async () => { await rm(workspaceRoot, { recursive: true, force: true }); });

function slot(id: string, stage: 1 | 2, model = `model-${id}`, overrides: Partial<PanelSlot> = {}): PanelSlot {
  return { id, stage, harness: { adapter: "fake", version: "1" }, inference: { provider: "fake", model, auth: "none" }, lens: "general", budget: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 }, ...overrides };
}

function panel(slots: PanelSlot[], overrides: Partial<PanelPolicy> = {}): PanelPolicy {
  return { version: 1, slots, quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full", ...overrides };
}

const evidence = (id = "E1"): Evidence => ({ id, kind: "code", description: "value", code: { commit: head, path: "src/value.ts", startLine: 1 } });
function finding(title: string, severity: Finding["severity"] = "high", evidenceId = "E1"): Finding {
  return { fingerprint: "", severity, category: "correctness", title, trigger: `when ${title}`, impact: "wrong value", direction: "return the right value", evidenceIds: [evidenceId], basis: "inferred", requirementIds: [], lifecycle: "new" };
}
const reporting = (...titles: string[]) => () => slotOutput({ evidence: [evidence()], findings: titles.map(title => finding(title)), inspectedPaths: ["src/value.ts", "src/other.ts"] });
const clean = () => slotOutput({ inspectedPaths: ["src/value.ts", "src/other.ts"] });
const failing = (terminal: HarnessOutput["terminal"] = "failed") => () => slotOutput({ terminal, inspectedPaths: [], error: `${terminal} fixture` });

function coordinator(harness: FakePanelHarness, overrides: Partial<PanelCoordinatorDependencies> = {}): { coordinator: PanelCoordinator; artifacts: MemoryArtifactStore; source: FakeSourceControlAdapter } {
  const artifacts = new MemoryArtifactStore();
  const source = new FakeSourceControlAdapter({ baseCommit: base, headCommit: head, changedPaths: ["src/other.ts", "src/value.ts"] });
  return { coordinator: new PanelCoordinator({ sourceControl: source, contexts: [new FakeContextAdapter("fixture", manifest)], execution: new FakeExecutionAdapter(), artifacts, harnesses: [harness], workspaceRoot, abortGraceMs: 100, ...overrides }), artifacts, source };
}

function request(panelPolicy: PanelPolicy, extra: Partial<PanelRunRequest> = {}): PanelRunRequest {
  return { root: repo, base, head, config, policy, issue: "ISS-1", panelPolicy, ...extra };
}

async function expectValid(result: Awaited<ReturnType<PanelCoordinator["run"]>>, setup: ReturnType<typeof coordinator>, panelPolicy: PanelPolicy): Promise<void> {
  const contextKey = [...setup.artifacts.values.keys()].find(key => key.startsWith("context-manifest-"))!;
  const context = JSON.parse(Buffer.from((await setup.artifacts.get(contextKey))!).toString("utf8"));
  const validation = await validatePanelReport(result.report, policy, { sourceControl: setup.source, root: repo, context, artifacts: setup.artifacts, panelPolicy });
  expect(validation.issues).toEqual([]);
  expect(result.validation.valid).toBe(true);
}

async function expectNoCheckouts(harness: FakePanelHarness): Promise<void> {
  for (const call of harness.calls) await expect(lstat(call.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readdir(workspaceRoot)).toEqual([]);
}

describe("PanelCoordinator quorum", () => {
  // Slots a and b share an identity (same harness, version, provider, model and auth); c and d are distinct.
  const slots = [slot("a", 1, "shared"), slot("b", 1, "shared"), slot("c", 1), slot("d", 1)];
  const policy2 = panel(slots, { quorum: { stage1: 2, stage2: 0 } });

  it("is met by two completed runs with distinct identities", async () => {
    const harness = new FakePanelHarness({ behaviors: { a: clean, b: failing(), c: clean, d: failing("quota_exhausted") } });
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(policy2));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["completed", "failed", "completed", "quota_exhausted"]);
    expect(result.quorum[0]).toEqual({ stage: 1, required: 2, completed: 2, met: true });
    expect(result.report.coverageReasons.join("\n")).not.toContain(PANEL_QUORUM_UNMET);
    expect(result.slots.find(item => item.slotId === "d")?.reasons.join()).toMatch(/quota_exhausted fixture/);
    await expectValid(result, setup, policy2);
  });

  it("is unmet when the only two completions are a collapsed duplicate identity", async () => {
    const harness = new FakePanelHarness({ behaviors: { a: reporting("Wrong value"), b: clean, c: failing(), d: failing("malformed") } });
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(policy2));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["completed", "collapsed", "failed", "malformed"]);
    expect(result.quorum[0]).toEqual({ stage: 1, required: 2, completed: 1, met: false });
    expect(result.report.coverage).toBe("incomplete");
    expect(result.report.coverageReasons.some(reason => reason.startsWith(`${PANEL_QUORUM_UNMET}: stage 1`))).toBe(true);
    expect(result.report.verdict).not.toBe("ready");
    await expectValid(result, setup, policy2);
  });

  it("gives stage 2 every stage-1 finding the report admits, including one only a collapsed run reported", async () => {
    const harness = new FakePanelHarness({ behaviors: { a: clean, b: reporting("Lonely defect"), s: clean } });
    const panelPolicy = panel([slot("a", 1, "shared"), slot("b", 1, "shared"), slot("s", 2)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["completed", "collapsed", "completed"]);
    expect(result.report.findings.map(item => [item.title, item.origins.map(origin => origin.slotId)])).toEqual([["Lonely defect", ["b"]]]);
    expect(harness.input("s").prompt).toContain("Lonely defect");
    await expectValid(result, setup, panelPolicy);
  });

  it("never reaches ready without quorum, even when every requirement is implemented", async () => {
    const requirementsOutput = requirementsHarnessOutput();
    const harness = new FakePanelHarness({ behaviors: { r: () => requirementsOutput, s: failing() } });
    const panelPolicy = panel([slot("r", 1), slot("s", 1)], { quorum: { stage1: 2, stage2: 0 }, requirementsSlot: "r" });
    const result = await coordinator(harness).coordinator.run(request(panelPolicy));
    expect(result.report.requirementsReport?.verdict).toBe("ready");
    expect(result.report.verdict).toBe("needs_verification");
  });
});

function requirementsHarnessOutput(findings: Finding[] = []): SlotHarnessOutput {
  return slotOutput({
    requirements: [{ id: "R1", statement: "Return value", sources: [{ sourceId: "issue:1", anchor: "L1" }], category: "behavior", scope: "api", classification: "mandatory", dependencies: [], extraction: { harness: "fake", promptDigest: "prompt" } }],
    assessments: [{ requirementId: "R1", status: "implemented", evidenceIds: ["E1"], reasoning: "present", gaps: [], confidence: 1 }],
    evidence: [evidence()], findings, inspectedPaths: ["src/other.ts", "src/value.ts"],
  });
}

describe("PanelCoordinator stages and union", () => {
  it("always runs stage 2 after blocking stage-1 findings and gives it those findings", async () => {
    const harness = new FakePanelHarness({ behaviors: { r: () => requirementsHarnessOutput(), one: reporting("Off by one"), two: clean } });
    const panelPolicy = panel([slot("r", 1), slot("one", 1), slot("two", 2)], { quorum: { stage1: 2, stage2: 1 }, requirementsSlot: "r" });
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(harness.calls.map(call => call.slot.id).at(-1)).toBe("two");
    const prompt = harness.input("two").prompt;
    const stage1Findings = JSON.parse(prompt.slice(prompt.indexOf("Frozen review input:\n") + 21)).stage1Findings;
    expect(stage1Findings).toEqual([expect.objectContaining({ title: "Off by one", severity: "high", origins: ["one"] })]);
    expect(prompt).toMatch(/stage 1 missed/);
    expect(harness.input("one").prompt).not.toContain("stage1Findings");
    expect(result.report.slotRuns.map(run => [run.slotId, run.terminal])).toEqual([["r", "completed"], ["one", "completed"], ["two", "completed"]]);
    expect(result.report.verdict).toBe("changes_requested");
    await expectValid(result, setup, panelPolicy);
  });

  it("reports a finding from one slot alone and records agreement only in origins", async () => {
    const harness = new FakePanelHarness({ behaviors: { a: reporting("Shared defect"), b: reporting("Shared defect", "Lonely defect"), c: clean } });
    const panelPolicy = panel([slot("a", 1), slot("b", 1), slot("c", 2)], { quorum: { stage1: 2, stage2: 1 } });
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    const byTitle = Object.fromEntries(result.report.findings.map(item => [item.title, item]));
    expect(Object.keys(byTitle).sort()).toEqual(["Lonely defect", "Shared defect"]);
    expect(byTitle["Lonely defect"].origins).toEqual([{ slotId: "b", lens: "general" }]);
    expect(byTitle["Lonely defect"].disposition).toBe("reported");
    expect(byTitle["Shared defect"].origins.map(origin => origin.slotId)).toEqual(["a", "b"]);
    expect(byTitle["Shared defect"].evidenceIds).toEqual(["a/E1", "b/E1"]);
    expect(result.report.evidence.map(item => item.id).sort()).toEqual(["a/E1", "b/E1"]);
    // Without a requirements slot no requirement was assessed, so a blocking finding still cannot make the panel ready.
    expect(result.report.verdict).toBe("needs_verification");
    await expectValid(result, setup, panelPolicy);
  });

  it("excludes only a slot's invalid finding, with a stated reason", async () => {
    const bad = { ...finding("Unanchored"), evidenceIds: ["missing"] };
    const harness = new FakePanelHarness({ behaviors: { a: () => slotOutput({ evidence: [evidence()], findings: [finding("Valid"), bad], inspectedPaths: ["src/value.ts", "src/other.ts"] }) } });
    const panelPolicy = panel([slot("a", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.findings.map(item => item.title)).toEqual(["Valid"]);
    expect(result.report.coverageReasons.join("\n")).toMatch(/Slot a finding "Unanchored" was excluded: .*unknown evidence a\/missing/);
    expect(result.slots[0].admittedFindings).toBe(1);
    await expectValid(result, setup, panelPolicy);
  });
});

describe("PanelCoordinator isolation and voiding", () => {
  it("voids a slot that writes to its checkout and keeps the other slots' results", async () => {
    const harness = new FakePanelHarness({
      behaviors: {
        writer: async input => { await writeFile(path.join(input.workspace, "scratch.txt"), "notes"); return reporting("Writer finding")(); },
        reader: reporting("Reader finding"),
      },
    });
    const panelPolicy = panel([slot("writer", 1), slot("reader", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.find(run => run.slotId === "writer")).toMatchObject({ terminal: "void", voidReasons: ["workspace_mutated"] });
    expect(result.slots.find(item => item.slotId === "writer")?.reasons.join()).toMatch(/scratch\.txt/);
    expect(result.report.slotRuns.find(run => run.slotId === "reader")?.terminal).toBe("completed");
    expect(result.report.findings.map(item => item.title)).toEqual(["Reader finding"]);
    expect(harness.input("writer").workspace).not.toBe(harness.input("reader").workspace);
    await expectNoCheckouts(harness);
    await expectValid(result, setup, panelPolicy);
  });

  it("voids a run whose served model differs from the configured model", async () => {
    const harness = new FakePanelHarness({ behaviors: { swapped: () => ({ ...reporting("Swapped finding")(), observed: { model: "cheaper-model" } }), honest: () => ({ ...clean(), observed: { model: "model-honest", usage: { inputTokens: 10, outputTokens: 2, costUsd: -1 } } }) } });
    const panelPolicy = panel([slot("swapped", 1), slot("honest", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    const swapped = result.report.slotRuns.find(run => run.slotId === "swapped")!;
    expect(swapped).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: "cheaper-model" } });
    expect(result.report.slotRuns.find(run => run.slotId === "honest")).toMatchObject({ terminal: "completed", usage: { inputTokens: 10, outputTokens: 2 } });
    expect(result.report.slotRuns.find(run => run.slotId === "honest")?.usage).not.toHaveProperty("costUsd");
    expect(result.report.findings).toEqual([]);
    await expectValid(result, setup, panelPolicy);
  });

  it("never counts a run whose harness reports another version than the slot pins, nor one that used a forbidden tool", async () => {
    const harness = new FakePanelHarness({ behaviors: { drift: () => ({ ...clean(), observed: { harnessVersion: "2" } }), tools: () => ({ ...clean(), observed: { disallowedTools: ["shell"] } }) } });
    const panelPolicy = panel([slot("drift", 1), slot("tools", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => [run.terminal, run.voidReasons])).toEqual([["failed", []], ["void", ["disallowed_tool_use"]]]);
    expect(result.quorum[0].met).toBe(false);
    await expectValid(result, setup, panelPolicy);
  });
});

describe("PanelCoordinator budgets, concurrency and cleanup", () => {
  it("runs at most maxConcurrentSlots slots at once and removes every checkout", async () => {
    // Each run holds until a second run is active (or the last slot started), so the cap is reached whatever the host's
    // speed, and a missing cap shows as more than two at once.
    const slow = async (input: { signal?: AbortSignal }) => {
      for (let waited = 0; harness.active < 2 && harness.calls.length < 5 && waited < 10_000; waited += 5) await abortableDelay(5, input.signal);
      await abortableDelay(20, input.signal);
      return clean();
    };
    const harness: FakePanelHarness = new FakePanelHarness({ behaviors: Object.fromEntries(["s1", "s2", "s3", "s4", "s5"].map(id => [id, slow])) });
    const panelPolicy = panel(["s1", "s2", "s3", "s4", "s5"].map(id => slot(id, 1)), { maxConcurrentSlots: 2, quorum: { stage1: 5, stage2: 0 } });
    const result = await coordinator(harness).coordinator.run(request(panelPolicy));
    expect(harness.calls).toHaveLength(5);
    expect(harness.maxActive).toBe(2);
    expect(result.quorum[0]).toMatchObject({ completed: 5, met: true });
    await expectNoCheckouts(harness);
  });

  it("removes each checkout after a failure, a timeout and a harness that ignores abort", async () => {
    let earlier: string | undefined;
    const harness = new FakePanelHarness({
      behaviors: {
        thrower: input => { earlier = input.workspace; throw new Error("harness crashed"); },
        sleeper: async input => {
          // Slots run one at a time here, so the previous slot's checkout is already gone.
          await expect(lstat(earlier!)).rejects.toMatchObject({ code: "ENOENT" });
          await abortableDelay(60_000, input.signal); return clean();
        },
        stubborn: () => new Promise<SlotHarnessOutput>(() => undefined),
      },
    });
    const panelPolicy = panel([slot("thrower", 1), slot("sleeper", 1, undefined, { budget: { timeoutMs: 50, maxOutputBytes: 1_000_000 } }), slot("stubborn", 1, undefined, { budget: { timeoutMs: 50, maxOutputBytes: 1_000_000 } })], { maxConcurrentSlots: 1 });
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["failed", "timed_out", "timed_out"]);
    expect(result.slots[0].reasons.join()).toMatch(/harness crashed/);
    expect(result.slots[1].reasons.join()).toMatch(/exceeded its 50 ms timeout/);
    expect(result.slots[2].reasons.join()).toMatch(/did not stop/);
    expect(harness.input("sleeper").policy.limits.harnessTimeoutMs).toBe(50);
    await expectNoCheckouts(harness);
    await expectValid(result, setup, panelPolicy);
  });

  it("times out a slot whose output exceeds its byte budget", async () => {
    const harness = new FakePanelHarness({ behaviors: { big: reporting(...Array.from({ length: 20 }, (_, index) => `Finding ${index}`)), small: clean } });
    const panelPolicy = panel([slot("big", 1, undefined, { budget: { timeoutMs: 60_000, maxOutputBytes: 2_000 } }), slot("small", 1)]);
    const result = await coordinator(harness).coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["timed_out", "completed"]);
    expect(result.slots[0].reasons.join()).toMatch(/exceeded its 2000-byte limit/);
    expect(harness.input("big").policy.limits.maxOutputBytes).toBe(2_000);
    expect(result.report.findings).toEqual([]);
  });

  it("bounds a stage by harnessTimeoutMs and marks slots that could not start as timed out", async () => {
    const hang = async (input: { signal?: AbortSignal }) => { await abortableDelay(60_000, input.signal); return clean(); };
    const harness = new FakePanelHarness({ behaviors: { first: hang, second: clean, late: clean } });
    const panelPolicy = panel([slot("first", 1), slot("second", 1), slot("late", 2)], { maxConcurrentSlots: 1 });
    const started = Date.now();
    const result = await coordinator(harness).coordinator.run(request(panelPolicy, { policy: { ...policy, limits: { ...policy.limits, harnessTimeoutMs: 1_500 } } }));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["timed_out", "timed_out", "completed"]);
    expect(result.slots[0].reasons.join()).toMatch(/Stage 1 exhausted its 1500 ms budget while the slot ran/);
    expect(result.slots[1].reasons.join()).toMatch(/Stage 1 exhausted its 1500 ms budget before the slot started/);
    expect(harness.calls.map(call => call.slot.id)).toEqual(["first", "late"]);
  });

  it("cancels the whole run, never starts the remaining slots and removes every checkout", async () => {
    const controller = new AbortController();
    const harness = new FakePanelHarness({ behaviors: { running: async input => { controller.abort(); await abortableDelay(60_000, input.signal); return clean(); } } });
    const panelPolicy = panel([slot("running", 1), slot("queued", 1), slot("later", 2)], { maxConcurrentSlots: 1 });
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy, { signal: controller.signal }));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["canceled", "canceled", "canceled"]);
    expect(harness.calls.map(call => call.slot.id)).toEqual(["running"]);
    expect(result.report.coverageReasons).toContain("The panel run was canceled.");
    expect(result.report.verdict).not.toBe("ready");
    await expectNoCheckouts(harness);
    await expectValid(result, setup, panelPolicy);
  });
});

describe("PanelCoordinator incremental review", () => {
  const full: () => ChangeHunks = () => ({ version: 1, baseCommit: base, headCommit: head, files: [{ path: "src/other.ts", status: "added", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] }, { path: "src/value.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }] });
  const delta: () => ChangeHunks = () => ({ version: 1, baseCommit: middle, headCommit: head, files: [full().files[0]] });

  it("passes the delta hunks to lens slots and the full change to the requirements slot", async () => {
    const harness = new FakePanelHarness({ behaviors: { req: () => requirementsHarnessOutput(), lens: clean } });
    const panelPolicy = panel([slot("req", 1), slot("lens", 1)], { requirementsSlot: "req", incremental: "delta", quorum: { stage1: 2, stage2: 0 } });
    const source = new FakeSourceControlAdapter({ baseCommit: base, headCommit: head, changedPaths: ["src/other.ts", "src/value.ts"], hunks: { [base]: full(), [middle]: delta() } });
    const setup = coordinator(harness, { sourceControl: source });
    const result = await setup.coordinator.run(request(panelPolicy, { since: middle }));
    const lensPrompt = harness.input("lens").prompt;
    const lensScope = JSON.parse(lensPrompt.slice(lensPrompt.indexOf("Frozen review input:\n") + 21)).scope;
    expect(lensScope).toEqual({ mode: "delta", since: middle, primary: delta(), reference: { change: expect.objectContaining({ headCommit: head }), hunks: full() } });
    expect(harness.input("lens").outputSchema).toBeDefined();
    const requirementsPrompt = harness.input("req").prompt;
    const requirementsPanel = JSON.parse(requirementsPrompt.slice(requirementsPrompt.indexOf("Panel slot input:\n") + 18));
    expect(requirementsPanel.changeHunks).toEqual(full());
    expect(requirementsPrompt).not.toContain(`"mode": "delta"`);
    expect(harness.input("req").outputSchema).toBeUndefined();
    expect(result.report.changeDetail?.since).toBe(middle);
    expect(result.report.requirementsReport?.changeDetail).toEqual(result.report.changeDetail);
    expect(result.report.verdict).toBe("ready");
    expect(new Set(setup.artifacts.values.keys()).size).toBeGreaterThan(0);
    await expectValid(result, { ...setup, source }, panelPolicy);
  });

  it("gives every slot the full change in full mode even with since", async () => {
    const harness = new FakePanelHarness({ behaviors: { lens: clean } });
    const source = new FakeSourceControlAdapter({ baseCommit: base, headCommit: head, changedPaths: ["src/other.ts", "src/value.ts"], hunks: { [base]: full(), [middle]: delta() } });
    await coordinator(harness, { sourceControl: source }).coordinator.run(request(panel([slot("lens", 1)]), { since: middle }));
    const prompt = harness.input("lens").prompt;
    expect(JSON.parse(prompt.slice(prompt.indexOf("Frozen review input:\n") + 21)).scope).toEqual({ mode: "full", primary: { change: expect.anything(), hunks: full() } });
  });
});

describe("PanelCoordinator shared run path", () => {
  it("prepares once: one capture, one context fetch and one test execution for all slots", async () => {
    const harness = new FakePanelHarness();
    const setup = coordinator(harness);
    let captures = 0, fetches = 0, executions = 0;
    const capture = setup.source.capture.bind(setup.source); setup.source.capture = async () => { captures += 1; return capture(); };
    const context = new FakeContextAdapter("fixture", manifest); const fetch = context.fetch.bind(context); context.fetch = async request => { fetches += 1; return fetch(request); };
    const execution = new FakeExecutionAdapter(); const run = execution.run.bind(execution); execution.run = async (...args) => { executions += 1; return run(...args); };
    const panelPolicy = panel([slot("a", 1), slot("b", 1), slot("c", 2)]);
    await new PanelCoordinator({ sourceControl: setup.source, contexts: [context], execution, artifacts: setup.artifacts, harnesses: [harness], workspaceRoot }).run(request(panelPolicy));
    expect([captures, fetches, executions, harness.calls.length]).toEqual([1, 1, 1, 3]);
    expect([...setup.artifacts.values.keys()].filter(key => key.startsWith("panel-report-"))).toHaveLength(1);
    expect([...setup.artifacts.values.keys()].filter(key => key.startsWith("panel-slot-output-"))).toHaveLength(3);
  });

  it("refuses to start with an unknown lens or harness, or with Codex slots outside action-proxy on a pull request", async () => {
    const harness = new FakePanelHarness();
    await expect(coordinator(harness).coordinator.run(request(panel([slot("a", 1, undefined, { lens: "unknown" })])))).rejects.toMatchObject({ code: "REVIEWFN_PREFLIGHT_FAILED", details: { diagnostics: [expect.objectContaining({ code: "REVIEWFN_PANEL_LENS_UNKNOWN" })] } });
    await expect(coordinator(harness).coordinator.run(request(panel([slot("a", 1, undefined, { harness: { adapter: "codex", version: "1" } })]), { pullRequest: 3 }))).rejects.toMatchObject({ details: { diagnostics: expect.arrayContaining([expect.objectContaining({ code: "REVIEWFN_PANEL_HARNESS_MISSING" }), expect.objectContaining({ code: "REVIEWFN_PR_AUTH_REQUIRED" })]) } });
    expect(harness.calls).toEqual([]);
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  it("keeps the 0.1 single-harness review independent of the panel", async () => {
    const { ReviewCoordinator } = await import("@superfunctions/reviewfn-core");
    const { FakeHarnessAdapter } = await import("../src/index.js");
    const setup = coordinator(new FakePanelHarness());
    const single = new ReviewCoordinator({ sourceControl: setup.source, contexts: [new FakeContextAdapter("fixture", manifest)], harness: new FakeHarnessAdapter(requirementsHarnessOutput()), execution: new FakeExecutionAdapter(), artifacts: setup.artifacts });
    const result = await single.run({ root: repo, base, head, config, policy, issue: "ISS-1" });
    expect(result.report.verdict).toBe("ready");
  });
});

async function slotDocument(setup: ReturnType<typeof coordinator>, artifact: string | undefined): Promise<Record<string, unknown>> {
  expect(artifact).toBeDefined();
  return JSON.parse(Buffer.from((await setup.artifacts.get(artifact!))!).toString("utf8"));
}

describe("PanelCoordinator harness versions", () => {
  it("configures the adapter contract version and checks the slot's pinned version only against the reported version", async () => {
    // Like Codex: the adapter contract is "1" while the executable reports its own version.
    const harness = new FakePanelHarness({ reportedVersion: "fake-cli 2.0.1" });
    const other = new FakePanelHarness({ id: "other", version: "7", reportedVersion: "other-cli 3" });
    const panelPolicy = panel([slot("pinned", 1, undefined, { harness: { adapter: "fake", version: "fake-cli 2.0.1" } }), slot("foreign", 1, undefined, { harness: { adapter: "other", version: "other-cli 3" } }), slot("stale", 1, undefined, { harness: { adapter: "fake", version: "fake-cli 1.9" } })]);
    const setup = coordinator(harness, { harnesses: [harness, other], harnessContractVersions: { other: "7" } });
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(harness.preflights.map(item => item.harness.version)).toEqual(["1", "1"]);
    expect(other.preflights.map(item => item.harness.version)).toEqual(["7"]);
    expect(harness.input("pinned").configuration.harness.version).toBe("1");
    expect(result.report.slotRuns.map(run => [run.slotId, run.terminal, run.identity.harnessVersion])).toEqual([["pinned", "completed", "fake-cli 2.0.1"], ["foreign", "completed", "other-cli 3"], ["stale", "failed", "fake-cli 2.0.1"]]);
    expect(result.slots[2].reasons.join()).toMatch(/reported version fake-cli 2\.0\.1, not the pinned fake-cli 1\.9/);
    await expectValid(result, setup, panelPolicy);
  });

  it("never takes a contract version from capabilities.version, which a preflight may have overwritten", async () => {
    // Like Codex: every successful preflight overwrites capabilities.version with the executable's version.
    const harness = new FakePanelHarness({ reportedVersion: "fake-cli 2.0.1", overwriteVersionOnPreflight: true });
    const other = new FakePanelHarness({ id: "other", version: "7", reportedVersion: "other-cli 3", overwriteVersionOnPreflight: true });
    await other.preflight({ ...config, harness: { adapter: "other", version: "7" } });
    await harness.preflight(config);
    expect([harness.capabilities.version, other.capabilities.version]).toEqual(["fake-cli 2.0.1", "other-cli 3"]);
    const panelPolicy = panel([slot("pinned", 1, undefined, { harness: { adapter: "fake", version: "fake-cli 2.0.1" } }), slot("foreign", 1, undefined, { harness: { adapter: "other", version: "other-cli 3" } })]);
    // Without an explicit contract version for the foreign adapter, the run refuses to start.
    const refused = coordinator(harness, { harnesses: [harness, other] });
    await expect(refused.coordinator.run(request(panelPolicy))).rejects.toMatchObject({ code: "REVIEWFN_PREFLIGHT_FAILED", details: { diagnostics: [expect.objectContaining({ code: "REVIEWFN_PANEL_HARNESS_CONTRACT_UNKNOWN" })] } });
    const setup = coordinator(harness, { harnesses: [harness, other], harnessContractVersions: { other: "7" } });
    const result = await setup.coordinator.run(request(panelPolicy));
    expect([harness.input("pinned").configuration.harness.version, other.input("foreign").configuration.harness.version]).toEqual(["1", "7"]);
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["completed", "completed"]);
    await expectValid(result, setup, panelPolicy);
  });

  it("never records the slot's pin as the harness version when no version was observed", async () => {
    const inner = new FakePanelHarness();
    // Neither preflight nor the adapter reports a version.
    const silent: PanelHarnessAdapter = {
      capabilities: { ...inner.capabilities, version: "" },
      preflight: async (configuration, signal) => { const result = await inner.preflight(configuration, signal); return { ...result, resolved: { ...result.resolved!, harnessVersion: "" } }; },
      run: input => inner.run(input),
    };
    const panelPolicy = panel([slot("silent", 1)], { quorum: { stage1: 0, stage2: 0 } });
    const setup = coordinator(inner, { harnesses: [silent] });
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => [run.terminal, run.identity.harnessVersion])).toEqual([["failed", "unobserved"]]);
    expect(result.slots[0].reasons.join()).toMatch(/No harness version was observed, so the pinned 1 was not confirmed/);
    await expectValid(result, setup, panelPolicy);
  });

  it("binds each slot's lens and adapter contract version into the run identity", async () => {
    const lens = (version: string, instructions: string) => new LensRegistry([{ ...GENERAL_LENS, version, instructions }]);
    const panelPolicy = panel([slot("req", 1), slot("foreign", 1, undefined, { harness: { adapter: "other", version: "other-cli 3" } })], { requirementsSlot: "req", quorum: { stage1: 0, stage2: 0 } });
    const run = async (lenses: LensRegistry, contract: string) => {
      const harness = new FakePanelHarness({ behaviors: { req: () => requirementsHarnessOutput() } });
      const other = new FakePanelHarness({ id: "other", version: contract, reportedVersion: "other-cli 3" });
      // The identity does not depend on the checkouts, so plain directories stand in for them.
      const workspaces = () => ({ create: async (slotId: string) => { const directory = await mkdtemp(path.join(workspaceRoot, `${slotId}-`)); return { path: directory, verify: async () => ({ unchanged: true }), remove: () => rm(directory, { recursive: true, force: true }) }; } });
      const result = await coordinator(harness, { harnesses: [harness, other], harnessContractVersions: { other: contract }, lenses, workspaces }).coordinator.run(request(panelPolicy));
      return { panel: result.report.runId, requirements: result.report.requirementsReport!.runId };
    };
    const original = await run(lens("1", GENERAL_LENS.instructions), "7");
    const variants = [await run(lens("2", GENERAL_LENS.instructions), "7"), await run(lens("1", `${GENERAL_LENS.instructions} Also check naming.`), "7"), await run(lens("1", GENERAL_LENS.instructions), "8")];
    expect(await run(lens("1", GENERAL_LENS.instructions), "7")).toEqual(original);
    expect(new Set([original, ...variants].map(ids => ids.panel)).size).toBe(4);
    // The embedded requirements report's run identity follows the panel's, so a different lens prompt changes it too.
    expect(new Set([original, ...variants].map(ids => ids.requirements)).size).toBe(4);
  }, 20_000);

  it("refuses a foreign adapter without an explicit contract version, even when capabilities.version is untouched", async () => {
    const harness = new FakePanelHarness();
    const other = new FakePanelHarness({ id: "other", version: "7" });
    const panelPolicy = panel([slot("foreign", 1, undefined, { harness: { adapter: "other", version: "7" } })]);
    await expect(coordinator(harness, { harnesses: [harness, other] }).coordinator.run(request(panelPolicy))).rejects.toMatchObject({ code: "REVIEWFN_PREFLIGHT_FAILED" });
    expect(other.preflights).toEqual([]);
  });
});

describe("PanelCoordinator failure accounting", () => {
  it("gives every run that does not count a reason, even when the harness stated none", async () => {
    const harness = new FakePanelHarness({ behaviors: { quota: () => slotOutput({ terminal: "quota_exhausted", inspectedPaths: [] }), ok: clean } });
    const panelPolicy = panel([slot("quota", 1), slot("ok", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.slots.map(outcome => [outcome.terminal, outcome.reasons])).toEqual([["quota_exhausted", ["The harness reported quota_exhausted without a reason."]], ["completed", []]]);
    await expectValid(result, setup, panelPolicy);
  });
});

describe("PanelCoordinator coverage", () => {
  it("is incomplete when no slot completed, even with zero quorums", async () => {
    const harness = new FakePanelHarness({ behaviors: { a: failing(), b: failing("quota_exhausted") } });
    const panelPolicy = panel([slot("a", 1), slot("b", 2)], { quorum: { stage1: 0, stage2: 0 } });
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.quorum.every(item => item.met)).toBe(true);
    expect(result.report.coverage).toBe("incomplete");
    expect(result.report.coverageReasons).toContain("No slot completed, so nothing in the change was reviewed.");
    expect(result.report.verdict).not.toBe("ready");
    await expectValid(result, setup, panelPolicy);
  });

  it("is incomplete when a completed lens slot reports scope it could not inspect", async () => {
    const harness = new FakePanelHarness({ behaviors: { a: () => slotOutput({ inspectedPaths: ["src/value.ts", "src/other.ts"], uninspected: [{ scope: "src/other.ts tests", reason: "the test tool failed" }] }) } });
    const panelPolicy = panel([slot("a", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns[0].terminal).toBe("completed");
    expect(result.report.coverage).toBe("incomplete");
    expect(result.report.coverageReasons).toContain("Slot a did not inspect src/other.ts tests: the test tool failed");
    await expectValid(result, setup, panelPolicy);
  });
});

// Real Git checkouts plus deliberate waits: allow for a loaded host. The bounds asserted are the coordinator's, not this timeout.
describe("PanelCoordinator budget bounds", { timeout: 20_000 }, () => {
  /** Wrap each real checkout's comparison for the named slots. */
  function wrapVerify(wrapped: Record<string, (real: (signal?: AbortSignal) => Promise<WorkspaceCheck>, signal?: AbortSignal) => Promise<WorkspaceCheck>>) {
    return (options: ConstructorParameters<typeof GitSlotWorkspaceProvider>[0]) => {
      const real = new GitSlotWorkspaceProvider(options);
      return {
        create: async (slotId: string, signal?: AbortSignal) => {
          const workspace = await real.create(slotId, signal);
          const wrap = wrapped[slotId];
          return wrap ? { path: workspace.path, remove: () => workspace.remove(), verify: (verifySignal?: AbortSignal) => wrap(signal => workspace.verify(signal), verifySignal) } : workspace;
        },
      };
    };
  }

  it("times out, without voiding, a slot whose checkout comparison does not finish within its bound", async () => {
    const harness = new FakePanelHarness({ behaviors: { slow: clean, deaf: clean, fast: clean } });
    const panelPolicy = panel([slot("slow", 1), slot("deaf", 1), slot("fast", 1)], { maxConcurrentSlots: 3 });
    let sawSignal = false;
    const workspaces = wrapVerify({
      // Never finishes on its own; stops when its signal aborts, as the Git comparison does.
      slow: async (real, signal) => { sawSignal = signal !== undefined; await abortableDelay(60_000, signal).catch(() => undefined); return real(signal); },
      // Ignores its signal entirely.
      deaf: () => new Promise<WorkspaceCheck>(() => undefined),
    });
    // The bound leaves the real comparison of fast ample time on a loaded host.
    const setup = coordinator(harness, { workspaces, comparisonTimeoutMs: 1_500 });
    const started = Date.now();
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(sawSignal).toBe(true);
    expect(result.report.slotRuns.map(run => [run.slotId, run.terminal, run.voidReasons])).toEqual([["slow", "timed_out", []], ["deaf", "timed_out", []], ["fast", "completed", []]]);
    for (const outcome of result.slots.slice(0, 2)) expect(outcome.reasons.join()).toMatch(/comparison did not finish within its 1500 ms bound/);
    await expectNoCheckouts(harness);
    await expectValid(result, setup, panelPolicy);
  });

  it("gives a slot that finished just before its harness timeout its full comparison bound", async () => {
    // The harness returns about 150 ms before its timeout; the comparison then takes 400 ms plus the real comparison of
    // its 1,000 ms bound (a quarter of the 4,000 ms stage), which the harness timeout left before the stage deadline.
    const harness = new FakePanelHarness({ behaviors: { late: async input => { await abortableDelay(Math.max(0, input.policy.limits.harnessTimeoutMs - 150), input.signal); return clean(); } } });
    const panelPolicy = panel([slot("late", 1)]);
    const workspaces = wrapVerify({ late: async (real, signal) => { await abortableDelay(400, signal); return real(signal); } });
    const setup = coordinator(harness, { workspaces, abortGraceMs: 1 });
    const result = await setup.coordinator.run(request(panelPolicy, { policy: { ...policy, limits: { ...policy.limits, harnessTimeoutMs: 4_000 } } }));
    expect(harness.input("late").policy.limits.harnessTimeoutMs).toBeLessThanOrEqual(4_000 - 1_000 - 2);
    expect(result.report.slotRuns.map(run => [run.terminal, run.voidReasons])).toEqual([["completed", []]]);
    expect(result.report.coverage).toBe("complete");
    await expectValid(result, setup, panelPolicy);
  });

  it("ends a stage by its deadline even when a harness ignores abort and a comparison ignores its bound", async () => {
    // harnessTimeoutMs 2,000, abort grace 100 and comparison bound 300 ms: each harness gets at most 1,500 ms, so its
    // grace, the comparison and the comparison's grace all fit before the deadline.
    const createdAt = new Map<string, number>();
    const harness = new FakePanelHarness({ behaviors: { deaf: () => new Promise<SlotHarnessOutput>(() => undefined), slow: clean, probe: clean } });
    const panelPolicy = panel([slot("deaf", 1), slot("slow", 1), slot("probe", 2)], { maxConcurrentSlots: 2 });
    const wrapped = wrapVerify({ deaf: () => new Promise<WorkspaceCheck>(() => undefined), slow: () => new Promise<WorkspaceCheck>(() => undefined) });
    const workspaces = (options: ConstructorParameters<typeof GitSlotWorkspaceProvider>[0]) => {
      const provider = wrapped(options);
      return { create: (slotId: string, signal?: AbortSignal) => { createdAt.set(slotId, Date.now()); return provider.create(slotId, signal); } };
    };
    const setup = coordinator(harness, { workspaces, abortGraceMs: 100, comparisonTimeoutMs: 300 });
    const result = await setup.coordinator.run(request(panelPolicy, { policy: { ...policy, limits: { ...policy.limits, harnessTimeoutMs: 2_000 } } }));
    const stageOne = Math.min(createdAt.get("deaf")!, createdAt.get("slow")!);
    // Stage 2 starts once every stage-1 slot ended and its checkout was removed; only removal is outside the deadline.
    expect(createdAt.get("probe")! - stageOne).toBeLessThan(2_000 + 250);
    expect(harness.input("deaf").policy.limits.harnessTimeoutMs).toBeLessThanOrEqual(1_500);
    expect(result.report.slotRuns.map(run => [run.slotId, run.terminal, run.voidReasons])).toEqual([["deaf", "timed_out", []], ["slow", "timed_out", []], ["probe", "completed", []]]);
    expect(result.slots[0].reasons.join()).toMatch(/did not stop/);
    expect(result.slots[1].reasons.join()).toMatch(/comparison did not finish within its 300 ms bound/);
    await expectNoCheckouts(harness);
  });

  it("applies the output limit per channel, as the harness enforces it, and bounds the stored telemetry", async () => {
    const events = (count: number) => Array.from({ length: count }, (_, index) => ({ type: "progress", message: `step ${index} ${"x".repeat(40)}` })) as SlotHarnessOutput["events"];
    const sized = () => slotOutput({ inspectedPaths: ["src/value.ts", "src/other.ts"], uninspected: [], evidence: [evidence()], findings: [finding("Padded ".padEnd(400, "p"))] });
    const harness = new FakePanelHarness({ behaviors: {
      // Payload, transcript and events each within 2,000 bytes; together well over it.
      within: () => ({ ...sized(), transcript: "y".repeat(1_900), events: events(20) }),
      // The transcript alone over the limit, as a harness's output stream over its cap.
      verbose: () => ({ ...clean(), transcript: "z".repeat(5_000), events: events(1) }),
      // The events alone over the limit.
      chatty: () => ({ ...clean(), events: events(60) }),
      // The structured payload alone is over the limit.
      oversized: () => slotOutput({ inspectedPaths: ["src/value.ts", "src/other.ts", ...Array.from({ length: 200 }, (_, index) => `src/generated/${index}.ts`)] }),
    } });
    const budget = { timeoutMs: 60_000, maxOutputBytes: 2_000 };
    const panelPolicy = panel([slot("within", 1, undefined, { budget }), slot("verbose", 1, undefined, { budget }), slot("chatty", 1, undefined, { budget }), slot("oversized", 1, undefined, { budget })]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy, { config: { ...config, retainTranscript: true } }));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["completed", "timed_out", "timed_out", "timed_out"]);
    expect(result.slots[0].reasons).toEqual([]);
    expect(result.report.findings.map(item => item.origins[0].slotId)).toEqual(["within"]);
    expect(result.slots[1].reasons.join("\n")).toMatch(/transcript \(5000 bytes\) exceeded its 2000-byte limit/);
    expect(result.slots[2].reasons.join("\n")).toMatch(/60 events exceeded its 2000-byte limit/);
    expect(result.slots[3].reasons.join()).toMatch(/structured output \(\d+ bytes\) exceeded its 2000-byte limit/);
    // What is stored stays within the limit, channel by channel.
    const verbose = await slotDocument(setup, result.report.slotRuns[1].outputArtifact);
    const transcript = Buffer.from((await setup.artifacts.get(verbose.redactedTranscriptArtifact as string))!).toString("utf8");
    expect(transcript).toBe("z".repeat(2_000));
    const chatty = await slotDocument(setup, result.report.slotRuns[2].outputArtifact);
    const kept = (chatty.output as { events: unknown[] }).events;
    expect(kept.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(2_000);
    await expectValid(result, setup, panelPolicy);
  });
});

describe("PanelCoordinator slot outcome records", () => {
  it("stores an output artifact with the final terminal and reasons for every slot run, however it ended", async () => {
    const controller = new AbortController();
    const harness = new FakePanelHarness({ behaviors: { first: clean, twin: async input => { controller.abort(); await abortableDelay(60_000, input.signal); return clean(); } } });
    // first and duplicate share an identity; twin cancels the run, so queued never starts.
    const panelPolicy = panel([slot("first", 1, "shared"), slot("duplicate", 1, "shared"), slot("twin", 1), slot("queued", 1), slot("late", 2)], { maxConcurrentSlots: 1 });
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy, { signal: controller.signal }));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["completed", "collapsed", "canceled", "canceled", "canceled"]);
    for (const run of result.report.slotRuns) {
      const document = await slotDocument(setup, run.outputArtifact);
      expect(document).toMatchObject({ slotId: run.slotId, terminal: run.terminal, identity: run.identity });
      const outcome = result.slots.find(item => item.slotId === run.slotId)!;
      expect(document.reasons).toEqual(outcome.reasons);
    }
    const queued = await slotDocument(setup, result.report.slotRuns[3].outputArtifact);
    expect(queued.reasons).toEqual(["The panel run was canceled before the slot started."]);
    expect(queued).not.toHaveProperty("promptDigest");
    await expectValid(result, setup, panelPolicy);
  });

  it("stores the outcome of a slot whose checkout could not be created", async () => {
    const harness = new FakePanelHarness();
    const panelPolicy = panel([slot("broken", 1), slot("fine", 1)]);
    const workspaces = (options: ConstructorParameters<typeof GitSlotWorkspaceProvider>[0]) => {
      const real = new GitSlotWorkspaceProvider(options);
      return { create: async (slotId: string, signal?: AbortSignal) => { if (slotId === "broken") throw new Error("disk full"); return real.create(slotId, signal); } };
    };
    const setup = coordinator(harness, { workspaces });
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["failed", "completed"]);
    const document = await slotDocument(setup, result.report.slotRuns[0].outputArtifact);
    expect(document).toMatchObject({ terminal: "failed", reasons: ["The slot checkout could not be created: disk full"] });
  });
});

describe("PanelCoordinator stage-2 context", () => {
  it("gives stage 2 only the stage-1 findings the panel report would admit", async () => {
    const unanchored = { ...finding("Unanchored"), evidenceIds: ["missing"] };
    // The requirements slot uses the 0.1 output, which allows info findings; lens slots cannot emit them.
    const harness = new FakePanelHarness({ behaviors: { one: () => requirementsHarnessOutput([finding("Admitted"), finding("Informational", "info"), unanchored]), two: clean } });
    const panelPolicy = panel([slot("one", 1), slot("two", 2)], { requirementsSlot: "one" });
    const result = await coordinator(harness).coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns[0].terminal).toBe("completed");
    const prompt = harness.input("two").prompt;
    const stage1Findings = JSON.parse(prompt.slice(prompt.indexOf("Frozen review input:\n") + 21)).stage1Findings;
    expect(stage1Findings.map((item: { title: string }) => item.title)).toEqual(["Admitted"]);
  });
});

describe("PanelCoordinator harness terminals", () => {
  it("makes an unknown terminal malformed without disabling a sibling slot's finding validation", async () => {
    const unanchored = { ...finding("Unanchored"), evidenceIds: ["E9"] };
    const harness = new FakePanelHarness({
      behaviors: {
        bogus: () => ({ ...reporting("Bogus finding")(), terminal: "bogus" as HarnessOutput["terminal"] }),
        sibling: () => slotOutput({ evidence: [evidence()], findings: [finding("Valid"), unanchored], inspectedPaths: ["src/value.ts", "src/other.ts"] }),
      },
    });
    const panelPolicy = panel([slot("bogus", 1), slot("sibling", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => [run.slotId, run.terminal])).toEqual([["bogus", "malformed"], ["sibling", "completed"]]);
    expect(result.slots[0].reasons.join()).toMatch(/reported terminal "bogus", which is not a harness terminal outcome/);
    expect(result.report.findings.map(item => item.title)).toEqual(["Valid"]);
    expect(result.report.coverageReasons.join("\n")).toMatch(/Slot sibling finding "Unanchored" was excluded: .*sibling\/E9/);
    expect(result.slots.map(item => item.admittedFindings)).toEqual([0, 1]);
    await expectValid(result, setup, panelPolicy);
  });

  it.each([["collapsed"], ["void"], [undefined]])("never takes the panel's own outcomes from a harness (terminal %s)", async terminal => {
    // The slot pins a version the harness does not report, so a run taken at its word would also skip the version check.
    const harness = new FakePanelHarness({ behaviors: { liar: () => ({ ...reporting("Liar finding")(), terminal: terminal as HarnessOutput["terminal"] }), honest: clean } });
    const panelPolicy = panel([slot("liar", 1, undefined, { harness: { adapter: "fake", version: "9" } }), slot("honest", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => [run.terminal, run.voidReasons])).toEqual([["malformed", []], ["completed", []]]);
    expect(result.report.findings).toEqual([]);
    await expectValid(result, setup, panelPolicy);
  });
});

describe("PanelCoordinator late cancellation", () => {
  it("records a cancellation that arrives after every slot finished", async () => {
    const controller = new AbortController();
    const harness = new FakePanelHarness({ behaviors: { only: clean } });
    const panelPolicy = panel([slot("only", 1)]);
    const setup = coordinator(harness);
    const put = setup.artifacts.put.bind(setup.artifacts);
    setup.artifacts.put = async (kind, content) => { if (kind === "panel-slot-output") controller.abort(); return put(kind, content); };
    const result = await setup.coordinator.run(request(panelPolicy, { signal: controller.signal }));
    expect(result.report.slotRuns[0].terminal).toBe("completed");
    expect(result.report.coverage).toBe("incomplete");
    expect(result.report.coverageReasons).toContain("The panel run was canceled.");
    expect(result.report.verdict).not.toBe("ready");
    await expectValid(result, setup, panelPolicy);
  });

  it("rejects with REVIEWFN_CANCELED when the cancellation arrives while the report is stored", async () => {
    const controller = new AbortController();
    const harness = new FakePanelHarness({ behaviors: { only: clean } });
    const setup = coordinator(harness);
    const put = setup.artifacts.put.bind(setup.artifacts);
    setup.artifacts.put = async (kind, content) => { const stored = await put(kind, content); if (kind === "panel-report") controller.abort(); return stored; };
    await expect(setup.coordinator.run(request(panel([slot("only", 1)]), { signal: controller.signal }))).rejects.toMatchObject({ code: "REVIEWFN_CANCELED", details: { reportArtifact: expect.stringMatching(/^panel-report-/) } });
  });
});

describe("PanelCoordinator admitted findings", () => {
  it("counts only the findings the report records after the maxFindings bound", async () => {
    const harness = new FakePanelHarness({ behaviors: { a: () => slotOutput({ evidence: [evidence()], findings: [finding("Severe", "critical"), finding("Minor", "low")], inspectedPaths: ["src/value.ts", "src/other.ts"] }) } });
    const panelPolicy = panel([slot("a", 1)]);
    const setup = coordinator(harness);
    const result = await setup.coordinator.run(request(panelPolicy, { policy: { ...policy, limits: { ...policy.limits, maxFindings: 1 } } }));
    expect(result.report.findings.map(item => item.title)).toEqual(["Severe"]);
    expect(result.slots[0].admittedFindings).toBe(1);
    expect(result.report.coverageReasons.join("\n")).toMatch(/more than maxFindings \(1\); 1 lower-severity/);
  });
});

describe("PanelCoordinator run-level issues stay with their slot", () => {
  /** Checkouts for `failing` slots cannot be created. */
  function brokenCheckouts(...failing: string[]) {
    return (options: ConstructorParameters<typeof GitSlotWorkspaceProvider>[0]) => {
      const real = new GitSlotWorkspaceProvider(options);
      return { create: async (slotId: string, signal?: AbortSignal) => { if (failing.includes(slotId)) throw new Error("disk full"); return real.create(slotId, signal); } };
    };
  }
  // Preflight resolves another model than slot broken configures.
  const drifting = (behaviors: ConstructorParameters<typeof FakePanelHarness>[0]["behaviors"] = {}) => new FakePanelHarness({ behaviors, resolveModel: item => item.inference.model === "model-broken" ? "drifted" : item.inference.model });

  it("voids an early-exit run whose preflight resolved another model, and keeps the other slots' findings", async () => {
    const harness = drifting({ fine: reporting("Real bug") });
    const panelPolicy = panel([slot("broken", 1), slot("fine", 1)]);
    const setup = coordinator(harness, { workspaces: brokenCheckouts("broken") });
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => [run.slotId, run.terminal, run.voidReasons, run.identity.model])).toEqual([["broken", "void", ["model_mismatch"], "drifted"], ["fine", "completed", [], "model-fine"]]);
    expect(result.slots[0].reasons).toEqual(["The slot checkout could not be created: disk full", "Preflight resolved model drifted, not the configured model-broken."]);
    expect(result.report.findings.map(item => item.title)).toEqual(["Real bug"]);
    expect(result.report.coverageReasons.join("\n")).not.toMatch(/excluded/);
    await expectValid(result, setup, panelPolicy);
  });

  it("gives stage 2 the stage-1 findings of a sibling of an early-exit run, and voids a canceled one alike", async () => {
    const controller = new AbortController();
    const harness = drifting({ fine: reporting("Real bug"), stop: () => { controller.abort(); return clean(); } });
    // broken fails before its harness runs; stage 2 then sees fine's finding. The second run cancels before broken starts.
    const panelPolicy = panel([slot("broken", 1), slot("fine", 1), slot("second", 2)], { maxConcurrentSlots: 1 });
    const setup = coordinator(harness, { workspaces: brokenCheckouts("broken") });
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(harness.input("second").prompt).toContain("Real bug");
    expect(result.report.findings.map(item => item.title)).toEqual(["Real bug"]);
    await expectValid(result, setup, panelPolicy);

    const canceledPolicy = panel([slot("stop", 1), slot("broken", 1), slot("fine", 2)], { maxConcurrentSlots: 1 });
    const canceled = coordinator(drifting({ stop: () => { controller.abort(); return clean(); } }));
    const outcome = await canceled.coordinator.run(request(canceledPolicy, { signal: controller.signal }));
    expect(outcome.report.slotRuns.map(run => [run.slotId, run.terminal, run.voidReasons])).toEqual([["stop", "canceled", []], ["broken", "void", ["model_mismatch"]], ["fine", "canceled", []]]);
    await expectValid(outcome, canceled, canceledPolicy);
  });

  it("never records a run finishing before it started when the clock steps back", async () => {
    let tick = Date.parse("2026-06-01T00:00:00.000Z");
    const now = () => new Date(tick -= 1_000);
    const harness = new FakePanelHarness({ behaviors: { a: reporting("Wrong value") } });
    const panelPolicy = panel([slot("a", 1)]);
    const setup = coordinator(harness, { now });
    const result = await setup.coordinator.run(request(panelPolicy));
    const [run] = result.report.slotRuns;
    expect(Date.parse(run.finishedAt)).toBeGreaterThanOrEqual(Date.parse(run.startedAt));
    expect(result.report.findings.map(item => item.title)).toEqual(["Wrong value"]);
    await expectValid(result, setup, panelPolicy);
  });
});

describe("PanelCoordinator cancellation and the requirements report", () => {
  const panelPolicy = panel([slot("r", 1)], { requirementsSlot: "r" });

  it("supersedes a report stored while the run was canceled, and names the superseding report", async () => {
    const controller = new AbortController();
    const harness = new FakePanelHarness({ behaviors: { r: () => requirementsHarnessOutput() } });
    const setup = coordinator(harness);
    const put = setup.artifacts.put.bind(setup.artifacts);
    let reports = 0;
    setup.artifacts.put = async (kind, content) => { const stored = await put(kind, content); if (kind === "panel-report" && ++reports === 1) controller.abort(); return stored; };
    const error = await setup.coordinator.run(request(panelPolicy, { signal: controller.signal })).catch((caught: unknown) => caught) as { code: string; details: { reportArtifact: string; supersededReportArtifact: string; supersededArtifacts: string[] } };
    expect(error.code).toBe("REVIEWFN_CANCELED");
    const read = async (id: string) => JSON.parse(Buffer.from((await setup.artifacts.get(id))!).toString("utf8"));
    // The first report would have been ready; the one the error names records the cancellation instead.
    const superseded = await read(error.details.supersededReportArtifact);
    expect([superseded.verdict, superseded.requirementsReport.execution]).toEqual(["ready", "completed"]);
    const report = await read(error.details.reportArtifact);
    expect(error.details.reportArtifact).not.toBe(error.details.supersededReportArtifact);
    expect(report.coverage).toBe("incomplete");
    expect(report.coverageReasons).toContain("The panel run was canceled.");
    // Every artifact the first conclusion stored and the superseding one did not store again is named, including the
    // ready panel report and its completed requirements report.
    const reviewReports = [...setup.artifacts.values.keys()].filter(key => key.startsWith("review-report-"));
    const completedReviewReport = (await Promise.all(reviewReports.map(async key => [key, (await read(key)).execution] as const))).filter(([, execution]) => execution === "completed").map(([key]) => key);
    expect(completedReviewReport).toHaveLength(1);
    expect(error.details.supersededArtifacts).toEqual(expect.arrayContaining([error.details.supersededReportArtifact, ...completedReviewReport]));
    expect(error.details.supersededArtifacts).not.toContain(error.details.reportArtifact);
    expect(report.coverageReasons).toContain(`This report supersedes artifact(s) ${error.details.supersededArtifacts.join(", ")}, stored before the cancellation was observed.`);
    expect(report.verdict).not.toBe("ready");
    expect(report.slotRuns[0].terminal).toBe("canceled");
    expect(report.requirementsReport.execution).toBe("canceled");
    expect(report.requirementsReport.verdict).not.toBe("ready");
    const contextKey = [...setup.artifacts.values.keys()].find(key => key.startsWith("context-manifest-"))!;
    const context = await read(contextKey);
    expect((await validatePanelReport(report, policy, { sourceControl: setup.source, root: repo, context, artifacts: setup.artifacts, panelPolicy })).issues).toEqual([]);
  });

  it("never builds a completed requirements report after a cancellation that arrives once every slot finished", async () => {
    const controller = new AbortController();
    const harness = new FakePanelHarness({ behaviors: { r: () => requirementsHarnessOutput() } });
    const setup = coordinator(harness);
    const put = setup.artifacts.put.bind(setup.artifacts);
    setup.artifacts.put = async (kind, content) => { if (kind === "panel-slot-output") controller.abort(); return put(kind, content); };
    const result = await setup.coordinator.run(request(panelPolicy, { signal: controller.signal }));
    expect(result.report.coverageReasons).toContain("The panel run was canceled.");
    expect(result.report.verdict).not.toBe("ready");
    expect(result.report.requirementsReport?.execution).toBe("canceled");
    expect(result.slots[0].reasons.join()).toMatch(/canceled before the requirements report was recorded/);
    expect([...setup.artifacts.values.keys()].filter(key => key.startsWith("panel-report-"))).toEqual([result.reportArtifact]);
    await expectValid(result, setup, panelPolicy);
  });

  it("stores no completed requirements report once a cancellation arrives while the requirements report is assembled", async () => {
    const controller = new AbortController();
    const harness = new FakePanelHarness({ behaviors: { r: () => requirementsHarnessOutput() } });
    const setup = coordinator(harness);
    const put = setup.artifacts.put.bind(setup.artifacts);
    let events = 0;
    setup.artifacts.put = async (kind, content) => { const stored = await put(kind, content); if (kind === "normalized-events" && ++events === 1) controller.abort(); return stored; };
    const result = await setup.coordinator.run(request(panelPolicy, { signal: controller.signal }));
    expect(result.report.coverageReasons).toContain("The panel run was canceled.");
    expect(result.report.verdict).not.toBe("ready");
    expect(result.report.requirementsReport?.execution).toBe("canceled");
    const read = async (id: string) => JSON.parse(Buffer.from((await setup.artifacts.get(id))!).toString("utf8"));
    const reviewReports = [...setup.artifacts.values.keys()].filter(key => key.startsWith("review-report-"));
    expect(reviewReports).toHaveLength(1);
    expect((await read(reviewReports[0])).execution).toBe("canceled");
    // Each artifact the interrupted conclusion stored is either part of this report or named as superseded.
    // The one (canceled) review report is the canceled conclusion's own.
    const current = new Set([result.reportArtifact, ...reviewReports, ...result.report.slotRuns.map(run => run.outputArtifact), result.report.requirementsReport?.normalizedEventArtifact]);
    const stale = [...setup.artifacts.values.keys()].filter(key => /^(panel-slot-output|normalized-events|review-report|panel-report)-/.test(key) && !current.has(key));
    expect(result.supersededArtifacts ?? []).toEqual(expect.arrayContaining(stale));
    await expectValid(result, setup, panelPolicy);
  });
});
