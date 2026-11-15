import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, DEFAULT_POLICY, PanelCoordinator, type PanelPolicy, type PanelRunRequest } from "@superfunctions/reviewfn-core";
import { FakeContextAdapter, FakeExecutionAdapter, FakeSourceControlAdapter, MemoryArtifactStore } from "@superfunctions/reviewfn-testing";

import { ClaudeCodeHarnessAdapter, type CommandRunner } from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => readFileSync(path.join(fixtures, `${name}.jsonl`), "utf8");
const environment = { PATH: process.env.PATH, ANTHROPIC_API_KEY: "panel-fixture-credential" };
const manifest = { version: 1 as const, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 10, maxBytes: 1000, maxDepth: 2 }, incompleteReasons: [] };
const config = { ...DEFAULT_CONFIG, harness: { adapter: "claude-code", version: "1" }, inference: { provider: "anthropic", model: "claude-opus-5-5", auth: "api-key", credentialEnv: "ANTHROPIC_API_KEY" }, context: [{ adapter: "fixture" }], execution: { ...DEFAULT_CONFIG.execution, adapter: "fake-execution" } };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

let repo: string, base: string, head: string, workspaceRoot: string;
beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "reviewfn-claude-panel-repo-"));
  workspaceRoot = await mkdtemp(path.join(tmpdir(), "reviewfn-claude-panel-run-"));
  git(repo, "init", "--quiet");
  await mkdir(path.join(repo, "src"));
  await writeFile(path.join(repo, "src", "index.ts"), "export const value = 0;\n");
  git(repo, "add", "--all"); git(repo, "commit", "--quiet", "-m", "base");
  base = git(repo, "rev-parse", "HEAD");
  await writeFile(path.join(repo, "src", "index.ts"), "export function parse(body) {\n  return body.length;\n}\n");
  git(repo, "commit", "--quiet", "-am", "head");
  head = git(repo, "rev-parse", "HEAD");
});
afterAll(async () => { await rm(repo, { recursive: true, force: true }); await rm(workspaceRoot, { recursive: true, force: true }); });

/** One stage-1 Claude Code slot per recorded stream; each slot's runner replays its own stream. */
function panelRun(streams: Record<string, string>) {
  const runner: CommandRunner = async (_command, args, options) => {
    if (args[0] === "--version") return { code: 0, signal: null, stdout: "2.1.325 (Claude Code)", stderr: "", timedOut: false, canceled: false };
    const slot = Object.keys(streams).find(id => options.stdin?.includes(`"id": "${id}"`)) ?? "";
    return { code: 0, signal: null, stdout: streams[slot] ?? "", stderr: "", timedOut: false, canceled: false };
  };
  const harness = new ClaudeCodeHarnessAdapter({ runner, environment });
  const panelPolicy: PanelPolicy = {
    version: 1,
    slots: Object.keys(streams).map(id => ({ id, stage: 1 as const, harness: { adapter: "claude-code", version: "2.1.325" }, inference: { provider: "anthropic", model: "claude-opus-5-5", auth: "api-key", credentialEnv: "ANTHROPIC_API_KEY" }, lens: "general", budget: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 } })),
    quorum: { stage1: 1, stage2: 0 }, requirementsSlot: null, incremental: "full",
  };
  const coordinator = new PanelCoordinator({ sourceControl: new FakeSourceControlAdapter({ baseCommit: base, headCommit: head, changedPaths: ["src/index.ts"] }), contexts: [new FakeContextAdapter("fixture", manifest)], execution: new FakeExecutionAdapter(), artifacts: new MemoryArtifactStore(), harnesses: [harness], workspaceRoot, abortGraceMs: 100, environment });
  const request = (extra: Partial<PanelRunRequest> = {}): PanelRunRequest => ({ root: repo, base, head, config, policy: DEFAULT_POLICY, panelPolicy, ...extra });
  return { coordinator, request };
}

describe("Claude Code slots in the panel", () => {
  it("records a completed slot, and voids slots with a disallowed tool or a mismatched model", async () => {
    const { coordinator, request } = panelRun({ complete: fixture("completed-review"), tool: fixture("disallowed-tool"), model: fixture("model-mismatch") });
    const result = await coordinator.run(request());
    const runs = Object.fromEntries(result.report.slotRuns.map(run => [run.slotId, run]));
    expect(runs.complete).toMatchObject({ terminal: "completed", voidReasons: [], identity: { harnessAdapter: "claude-code", harnessVersion: "2.1.325", model: "claude-opus-5-5" }, usage: { inputTokens: 2000, outputTokens: 420, costUsd: 0.1875 } });
    expect(runs.tool).toMatchObject({ terminal: "void", voidReasons: ["disallowed_tool_use"] });
    expect(runs.model).toMatchObject({ terminal: "void", voidReasons: ["model_mismatch"], identity: { model: "claude-sonnet-5-5" } });
    expect(result.quorum[0]).toMatchObject({ completed: 1, met: true });
  }, 60_000);

  it("fails panel preflight with REVIEWFN_PR_AUTH_REQUIRED for a pull-request identity", async () => {
    const { coordinator, request } = panelRun({ complete: fixture("completed-review") });
    const diagnostics = await coordinator.preflight(request({ pullRequest: 7 }));
    expect(diagnostics.filter(item => item.level === "error").map(item => item.code)).toContain("REVIEWFN_PR_AUTH_REQUIRED");
    expect((await coordinator.preflight(request())).filter(item => item.level === "error")).toEqual([]);
  }, 60_000);
});
