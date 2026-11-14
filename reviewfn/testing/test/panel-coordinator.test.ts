import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG, DEFAULT_POLICY, GitSlotWorkspaceProvider, PANEL_QUORUM_UNMET, PanelCoordinator, validatePanelReport,
  type ChangeHunks, type Evidence, type Finding, type HarnessOutput, type PanelCoordinatorDependencies, type PanelPolicy, type PanelRunRequest, type PanelSlot, type SlotHarnessOutput,
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
    const slow = async (input: { signal?: AbortSignal }) => { await abortableDelay(40, input.signal); return clean(); };
    const harness = new FakePanelHarness({ behaviors: Object.fromEntries(["s1", "s2", "s3", "s4", "s5"].map(id => [id, slow])) });
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
    const setup = coordinator(harness, { harnesses: [harness, other] });
    const result = await setup.coordinator.run(request(panelPolicy));
    expect(harness.preflights.map(item => item.harness.version)).toEqual(["1", "1"]);
    expect(other.preflights.map(item => item.harness.version)).toEqual(["7"]);
    expect(harness.input("pinned").configuration.harness.version).toBe("1");
    expect(result.report.slotRuns.map(run => [run.slotId, run.terminal, run.identity.harnessVersion])).toEqual([["pinned", "completed", "fake-cli 2.0.1"], ["foreign", "completed", "other-cli 3"], ["stale", "failed", "fake-cli 2.0.1"]]);
    expect(result.slots[2].reasons.join()).toMatch(/reported version fake-cli 2\.0\.1, not the pinned fake-cli 1\.9/);
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

describe("PanelCoordinator budget bounds", () => {
  it("bounds the checkout comparison by the stage budget and voids the slot it could not clear", async () => {
    const harness = new FakePanelHarness({ behaviors: { slow: clean, fast: clean } });
    const panelPolicy = panel([slot("slow", 1), slot("fast", 1)]);
    let sawSignal = false;
    // The first checkout's comparison never finishes on its own; it stops only when its signal aborts.
    const workspaces = (options: ConstructorParameters<typeof GitSlotWorkspaceProvider>[0]) => {
      const real = new GitSlotWorkspaceProvider(options);
      return {
        create: async (slotId: string, signal?: AbortSignal) => {
          const workspace = await real.create(slotId, signal);
          if (slotId !== "slow") return workspace;
          return {
            path: workspace.path, remove: () => workspace.remove(),
            verify: async (verifySignal?: AbortSignal) => { sawSignal = verifySignal !== undefined; await abortableDelay(60_000, verifySignal).catch(() => undefined); return { unchanged: false, reason: "aborted" }; },
          };
        },
      };
    };
    const setup = coordinator(harness, { workspaces });
    const started = Date.now();
    const result = await setup.coordinator.run(request(panelPolicy, { policy: { ...policy, limits: { ...policy.limits, harnessTimeoutMs: 1_000 } } }));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(sawSignal).toBe(true);
    expect(result.report.slotRuns.map(run => [run.slotId, run.terminal, run.voidReasons])).toEqual([["slow", "void", ["workspace_mutated"]], ["fast", "completed", []]]);
    expect(result.slots[0].reasons.join()).toMatch(/comparison did not finish within the stage 1 budget/);
    await expectNoCheckouts(harness);
  });

  it("counts events and the transcript against the slot's output budget", async () => {
    const harness = new FakePanelHarness({ behaviors: { chatty: () => slotOutput({ inspectedPaths: ["src/value.ts", "src/other.ts"], events: Array.from({ length: 50 }, (_, index) => ({ type: "progress", message: `step ${index} ${"x".repeat(40)}` })) as SlotHarnessOutput["events"] }), verbose: () => ({ ...clean(), transcript: "y".repeat(5_000) }), quiet: clean } });
    const budget = { timeoutMs: 60_000, maxOutputBytes: 2_000 };
    const panelPolicy = panel([slot("chatty", 1, undefined, { budget }), slot("verbose", 1, undefined, { budget }), slot("quiet", 1, undefined, { budget })]);
    const result = await coordinator(harness).coordinator.run(request(panelPolicy));
    expect(result.report.slotRuns.map(run => run.terminal)).toEqual(["timed_out", "timed_out", "completed"]);
    expect(result.slots[0].reasons.join()).toMatch(/exceeded its 2000-byte limit/);
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
