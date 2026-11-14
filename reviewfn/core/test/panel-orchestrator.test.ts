import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG, DEFAULT_POLICY, GENERAL_LENS, GitSlotWorkspaceProvider, LensRegistry, ReviewFnError, applyRepositoryPanelPolicy, buildReviewPrompt, buildSlotPrompt,
  defaultLensRegistry, loadPanelPolicy, parsePanelPolicy, type ChangeHunks, type ChangeSnapshot, type ContextManifest, type PanelPolicy, type PanelSlot,
} from "../src/index.js";

function slot(id: string, overrides: Partial<PanelSlot> = {}): PanelSlot {
  return { id, stage: 1, harness: { adapter: "codex", version: "0.154.0" }, inference: { provider: "openai", model: "gpt-a", auth: "api-key" }, lens: "general", budget: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 }, ...overrides };
}

const trusted: PanelPolicy = {
  version: 1,
  slots: [slot("alpha"), slot("beta", { inference: { provider: "anthropic", model: "claude-b", auth: "api-key" } }), slot("gamma", { stage: 2 })],
  quorum: { stage1: 2, stage2: 1 },
  requirementsSlot: "alpha",
  maxConcurrentSlots: 3,
  incremental: "full",
};

function weakened(change: (policy: PanelPolicy) => void): unknown {
  const repository = structuredClone(trusted);
  change(repository);
  try { applyRepositoryPanelPolicy(trusted, repository); return undefined; } catch (error) { return error; }
}

describe("panel policy tightening", () => {
  it.each<[string, (policy: PanelPolicy) => void, RegExp]>([
    ["lowers a quorum", policy => { policy.quorum.stage1 = 1; }, /lowers quorum\.stage1 from 2 to 1/],
    ["removes a slot", policy => { policy.slots.splice(1, 1); }, /removes slot beta/],
    ["changes a model", policy => { policy.slots[0].inference.model = "gpt-cheaper"; }, /changes slot alpha inference/],
    ["changes a lens", policy => { policy.slots[0].lens = "style"; }, /changes slot alpha lens/],
    ["changes a stage", policy => { policy.slots[2].stage = 1; }, /changes slot gamma stage/],
    ["reorders slots", policy => { policy.slots.reverse(); }, /moves slot alpha/],
    ["raises a budget", policy => { policy.slots[1].budget.timeoutMs = 120_000; }, /raises slot beta budget\.timeoutMs/],
    ["raises concurrency", policy => { policy.maxConcurrentSlots = 4; }, /raises maxConcurrentSlots from 3 to 4/],
    ["changes incremental mode", policy => { policy.incremental = "delta"; }, /changes incremental/],
    ["skips requirement extraction", policy => { policy.requirementsSlot = null; }, /changes requirementsSlot/],
    ["adds a slot with a new model", policy => { policy.slots.push(slot("delta", { inference: { provider: "openai", model: "gpt-new", auth: "api-key" } })); }, /adds slot delta/],
    ["adds a slot with a larger budget than its pair", policy => { policy.slots.push(slot("delta", { lens: "security", budget: { timeoutMs: 120_000, maxOutputBytes: 1 } })); }, /larger budget\.timeoutMs/],
  ])("rejects a repository copy that %s", (_name, change, reason) => {
    const error = weakened(change);
    expect(error).toBeInstanceOf(ReviewFnError);
    expect((error as ReviewFnError).code).toBe("REVIEWFN_PANEL_POLICY_WEAKENED");
    expect((error as ReviewFnError).message).toMatch(reason);
  });

  it("treats an absent maxConcurrentSlots as the default of 2", () => {
    const base = { ...structuredClone(trusted), maxConcurrentSlots: undefined };
    expect(() => applyRepositoryPanelPolicy(base, { ...structuredClone(trusted), maxConcurrentSlots: 3 })).toThrow(/raises maxConcurrentSlots from 2 to 3/);
    expect(applyRepositoryPanelPolicy(trusted, { ...structuredClone(trusted), maxConcurrentSlots: undefined }).maxConcurrentSlots).toBeUndefined();
  });

  it("applies quorum raises, added lenses on existing pairs and lower budgets and concurrency", () => {
    const repository = structuredClone(trusted);
    repository.quorum = { stage1: 3, stage2: 2 };
    repository.maxConcurrentSlots = 1;
    repository.slots[1].budget = { timeoutMs: 30_000, maxOutputBytes: 500_000 };
    repository.slots.push(slot("alpha-security", { lens: "security" }), slot("gamma-tests", { stage: 2, lens: "tests" }));
    const applied = applyRepositoryPanelPolicy(trusted, repository);
    expect(applied).toEqual(repository);
    expect(applied.quorum).toEqual({ stage1: 3, stage2: 2 });
  });

  it("lists every weakening and rejects invalid documents as invalid configuration", () => {
    const error = weakened(policy => { policy.quorum.stage2 = 0; policy.slots[0].inference.model = "gpt-cheaper"; }) as ReviewFnError;
    expect(error.details?.reasons).toEqual(["lowers quorum.stage2 from 1 to 0", "changes slot alpha inference (provider, model, auth or credential)"]);
    expect(() => applyRepositoryPanelPolicy(trusted, { ...trusted, version: 2 })).toThrow(expect.objectContaining({ code: "REVIEWFN_CONFIG_INVALID" }));
    expect(() => parsePanelPolicy({ ...trusted, requirementsSlot: "missing" })).toThrow(/requirementsSlot missing names no stage-1 or stage-2 slot/);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

async function commitAll(repo: string, message: string): Promise<string> {
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

describe("panel policy loading", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "reviewfn-panel-policy-"));
    git(repo, "init", "--quiet");
    await mkdir(path.join(repo, ".reviewfn"));
  });
  afterAll(async () => { await rm(repo, { recursive: true, force: true }); });

  async function revision(policy: unknown, message: string): Promise<string> {
    if (policy === undefined) await rm(path.join(repo, ".reviewfn", "panel.json"), { force: true });
    else await writeFile(path.join(repo, ".reviewfn", "panel.json"), JSON.stringify(policy));
    return commitAll(repo, message);
  }

  it("trusts the base revision and only lets the head copy tighten it", async () => {
    const base = await revision(trusted, "base");
    const lowered = await revision({ ...trusted, quorum: { stage1: 1, stage2: 1 } }, "lower");
    await expect(loadPanelPolicy({ root: repo, base, head: lowered, trustedFromBase: true })).rejects.toMatchObject({ code: "REVIEWFN_PANEL_POLICY_WEAKENED" });
    const removed = await revision({ ...trusted, slots: trusted.slots.slice(0, 2) }, "remove");
    await expect(loadPanelPolicy({ root: repo, base, head: removed, trustedFromBase: true })).rejects.toMatchObject({ code: "REVIEWFN_PANEL_POLICY_WEAKENED" });
    const raised = await revision({ ...trusted, quorum: { stage1: 2, stage2: 2 } }, "raise");
    await expect(loadPanelPolicy({ root: repo, base, head: raised, trustedFromBase: true })).resolves.toEqual({ policy: { ...trusted, quorum: { stage1: 2, stage2: 2 } }, source: "base+repository" });
    const deleted = await revision(undefined, "delete");
    await expect(loadPanelPolicy({ root: repo, base, head: deleted, trustedFromBase: true })).resolves.toEqual({ policy: trusted, source: "base" });
    // The working tree is not consulted in trusted mode, so an uncommitted weakening has no effect.
    await writeFile(path.join(repo, ".reviewfn", "panel.json"), JSON.stringify({ ...trusted, quorum: { stage1: 0, stage2: 0 } }));
    await expect(loadPanelPolicy({ root: repo, base, head: base, trustedFromBase: true })).resolves.toEqual({ policy: trusted, source: "base" });
    await expect(loadPanelPolicy({ root: repo, base, head: base, trustedFromBase: false })).resolves.toMatchObject({ source: "working-tree", policy: { quorum: { stage1: 0, stage2: 0 } } });
    await rm(path.join(repo, ".reviewfn", "panel.json"));
  });

  it("requires a trusted base copy and repository-relative JSON", async () => {
    const empty = await revision(undefined, "none");
    await expect(loadPanelPolicy({ root: repo, base: empty, head: empty, trustedFromBase: true })).rejects.toMatchObject({ code: "REVIEWFN_CONFIG_INVALID", message: expect.stringMatching(/has no panel policy/) });
    await expect(loadPanelPolicy({ root: repo, base: empty, head: empty, trustedFromBase: true, path: "../panel.json" })).rejects.toMatchObject({ code: "REVIEWFN_CONFIG_INVALID" });
    await writeFile(path.join(repo, ".reviewfn", "panel.json"), "{not json");
    const broken = await commitAll(repo, "broken");
    await expect(loadPanelPolicy({ root: repo, base: broken, head: broken, trustedFromBase: true })).rejects.toMatchObject({ code: "REVIEWFN_CONFIG_INVALID", message: expect.stringMatching(/is not JSON/) });
    await rm(path.join(repo, ".reviewfn", "panel.json"));
  });
});

describe("lens registry", () => {
  it("ships only the general lens and rejects duplicate or malformed lenses", () => {
    const registry = defaultLensRegistry();
    expect(registry.list().map(lens => lens.id)).toEqual(["general"]);
    expect(registry.get("general")).toEqual(GENERAL_LENS);
    expect(() => registry.register({ ...GENERAL_LENS })).toThrow(/already registered/);
    expect(() => new LensRegistry([{ id: "Bad Lens", version: "1", instructions: "x" }])).toThrow(/must match/);
    expect(() => new LensRegistry([{ id: "empty", version: "1", instructions: " " }])).toThrow(/nonblank instructions/);
    expect(new LensRegistry([{ id: "security", version: "2", instructions: "Look for injection." }]).has("security")).toBe(true);
  });
});

describe("slot prompts", () => {
  const head = "b".repeat(40), mergeBase = "a".repeat(40), since = "c".repeat(40);
  const change: ChangeSnapshot = { repositoryId: "fixture", host: "local", targetBranch: "main", baseCommit: mergeBase, headCommit: head, mergeBaseCommit: mergeBase, diffDigest: "d".repeat(64), changedPaths: ["src/a.ts", "src/b.ts"], capturedAt: "2026-01-01T00:00:00.000Z" };
  const context: ContextManifest = { version: 1, sources: [], selection: { candidates: [], selected: [], rule: "none" }, limits: { maxSources: 1, maxBytes: 1, maxDepth: 1 }, incompleteReasons: [], digest: "e".repeat(64) };
  const hunks: ChangeHunks = { version: 1, baseCommit: mergeBase, headCommit: head, files: [{ path: "src/a.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }, { path: "src/b.ts", status: "added", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }] }] };
  const delta: ChangeHunks = { version: 1, baseCommit: since, headCommit: head, files: [hunks.files[1]] };
  const prior = [{ fingerprint: "f".repeat(64), severity: "high" as const, category: "correctness", title: "Null dereference", trigger: "empty input", origins: ["alpha"] }];
  const input = { lens: GENERAL_LENS, change, context, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, tests: [] };
  const payload = (prompt: string, marker = "Frozen review input:\n") => JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));

  it("gives lens slots the delta as primary scope and the full change as reference", () => {
    const lens = payload(buildSlotPrompt({ ...input, slot: slot("alpha"), scope: { mode: "delta", hunks, delta, since }, requirements: false }).prompt);
    expect(lens.scope).toEqual({ mode: "delta", since, primary: delta, reference: { change, hunks } });
    expect(lens.stage1Findings).toBeUndefined();
    const full = payload(buildSlotPrompt({ ...input, slot: slot("alpha"), scope: { mode: "full", hunks }, requirements: false }).prompt);
    expect(full.scope).toEqual({ mode: "full", primary: { change, hunks } });
  });

  it("tells stage-2 slots what stage 1 found, even when it found nothing", () => {
    const stageTwo = buildSlotPrompt({ ...input, slot: slot("gamma", { stage: 2 }), scope: { mode: "full", hunks }, priorFindings: prior, requirements: false }).prompt;
    expect(payload(stageTwo).stage1Findings).toEqual(prior);
    expect(stageTwo).toMatch(/look for|missed/i);
    expect(payload(buildSlotPrompt({ ...input, slot: slot("gamma", { stage: 2 }), scope: { mode: "full", hunks }, requirements: false }).prompt).stage1Findings).toEqual([]);
  });

  it("keeps the 0.1 requirements prompt over the full change for the requirements slot", () => {
    const built = buildSlotPrompt({ ...input, slot: slot("alpha", { stage: 2 }), scope: { mode: "full", hunks }, priorFindings: prior, requirements: true });
    expect(built.prompt.startsWith(buildReviewPrompt({ change, context, config: DEFAULT_CONFIG, policy: DEFAULT_POLICY, tests: [] }).prompt)).toBe(true);
    const panel = payload(built.prompt, "Panel slot input:\n");
    expect(panel.changeHunks).toEqual(hunks);
    expect(panel.stage1Findings).toEqual(prior);
    expect(built.prompt).not.toContain(`"since"`);
  });
});

describe("slot workspaces", () => {
  let repo: string, parent: string, head: string;
  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "reviewfn-workspace-repo-"));
    parent = await mkdtemp(path.join(tmpdir(), "reviewfn-workspace-run-"));
    git(repo, "init", "--quiet");
    await mkdir(path.join(repo, "src", "nested"), { recursive: true });
    // A committed attribute that would rewrite line endings on checkout must not make an untouched checkout look mutated.
    await writeFile(path.join(repo, ".gitattributes"), "* text eol=crlf\n");
    await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(repo, "src", "value.ts"), "export const value = 1;\n");
    await writeFile(path.join(repo, "src", "nested", "deep.ts"), "export {};\n");
    head = await commitAll(repo, "head");
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(parent, { recursive: true, force: true });
  });

  const provider = () => new GitSlotWorkspaceProvider({ objectStore: repo, headCommit: head, parent });

  it("checks out the head bytes without a remote and reports an untouched checkout as unchanged", async () => {
    const workspace = await provider().create("alpha");
    expect(await readFile(path.join(workspace.path, "src", "value.ts"), "utf8")).toBe("export const value = 1;\n");
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(workspace.path, "remote")).toBe("");
    await expect(workspace.verify()).resolves.toEqual({ unchanged: true });
    await workspace.remove();
    await expect(lstat(workspace.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each<[string, (root: string) => Promise<void>, RegExp]>([
    ["adds a file", root => writeFile(path.join(root, "notes.md"), "hi"), /notes\.md/],
    ["adds an ignored file", root => writeFile(path.join(root, "ignored.txt"), "hi"), /ignored\.txt/],
    ["edits a file", root => writeFile(path.join(root, "src", "value.ts"), "export const value = 2;\n"), /src\/value\.ts/],
    ["deletes a file", root => rm(path.join(root, "src", "nested", "deep.ts")), /src\/nested\/deep\.ts/],
    ["changes a file mode", root => chmod(path.join(root, "src", "value.ts"), 0o755), /src\/value\.ts/],
    ["creates an empty directory", root => mkdir(path.join(root, "src", "empty")), /src\/empty/],
    ["converts line endings", root => writeFile(path.join(root, "src", "value.ts"), "export const value = 1;\r\n"), /src\/value\.ts/],
  ])("reports a slot that %s as mutated", async (_name, mutate, reason) => {
    const workspace = await provider().create("beta");
    await mutate(workspace.path);
    const check = await workspace.verify();
    expect(check.unchanged).toBe(false);
    expect(check.reason).toMatch(reason);
    await workspace.remove();
  });

  it("ignores the slot's own Git metadata, which cannot hide a change", async () => {
    const workspace = await provider().create("gamma");
    await writeFile(path.join(workspace.path, "src", "value.ts"), "tampered\n");
    // Staging and committing the change inside the slot's own repository does not make the checkout match head.
    git(workspace.path, "add", "--all");
    git(workspace.path, "commit", "--quiet", "-m", "tamper");
    await writeFile(path.join(workspace.path, ".git", "info", "exclude"), "*\n");
    expect((await workspace.verify()).unchanged).toBe(false);
    await workspace.remove();
  });

  it("removes a checkout whose directories the slot made unreadable, and isolates concurrent checkouts", async () => {
    const [first, second] = await Promise.all([provider().create("delta"), provider().create("delta")]);
    expect(first.path).not.toBe(second.path);
    await writeFile(path.join(first.path, "src", "value.ts"), "changed\n");
    expect((await second.verify()).unchanged).toBe(true);
    await chmod(path.join(first.path, "src", "nested"), 0o000);
    await chmod(path.join(first.path, "src"), 0o500);
    await first.remove();
    await second.remove();
    await expect(lstat(path.dirname(first.path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails creation for a commit the object store does not have and leaves nothing behind", async () => {
    const missing = new GitSlotWorkspaceProvider({ objectStore: repo, headCommit: "0".repeat(40), parent });
    await expect(missing.create("epsilon")).rejects.toThrow();
    const leftovers = execFileSync("ls", [parent], { encoding: "utf8" }).split("\n").filter(name => name.startsWith("epsilon-"));
    expect(leftovers).toEqual([]);
  });
});
