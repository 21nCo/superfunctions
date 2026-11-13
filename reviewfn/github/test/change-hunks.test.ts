import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG, DEFAULT_POLICY, ReviewCoordinator, ReviewFnError, changeHunksDiffArguments, isolatedGitEnvironment, sha256, validateReport,
  type ArtifactStore, type ContextAdapter, type Evidence, type ContextManifest, type ExecutionAdapter, type HarnessAdapter, type HarnessOutput, type ReviewReport,
} from "@superfunctions/reviewfn-core";
import { GitSourceControlAdapter } from "../src/index.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function repository() {
  const root = await mkdtemp(path.join(tmpdir(), "reviewfn-hunks-"));
  roots.push(root);
  const git = async (...args: string[]) => (await promisify(execFile)("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, env: isolatedGitEnvironment() })).stdout.trim();
  const write = (file: string, content: string | Uint8Array) => writeFile(path.join(root, file), content);
  const commit = async (message: string) => { await git("add", "-A"); await git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); };
  await git("init", "-q", "--template=", "-b", "main");
  return { root, git, write, commit };
}

describe("GitSourceControlAdapter.changeHunks", { timeout: 30_000 }, () => {
  it("models added, modified, deleted, renamed, binary, no-newline, CRLF, and spaced non-ASCII paths", async () => {
    const { root, git, write, commit } = await repository();
    await write("modified.txt", "a\nb\nc\n");
    await write("deleted.txt", "x\ny\n");
    await write("old name.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    await write("image.bin", Buffer.from([0, 1, 2, 3]));
    await write("no-newline.txt", "z");
    await write("crlf.txt", "p\r\nq\r\nr\r\n");
    const base = await commit("base");
    await write("modified.txt", "a\nB\nc\nd\n");
    await unlink(path.join(root, "deleted.txt"));
    await git("mv", "old name.txt", "renamed näme.txt");
    await write("renamed näme.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n11\n");
    await write("image.bin", Buffer.from([0, 1, 2, 4]));
    await write("no-newline.txt", "zz");
    await write("crlf.txt", "p\r\nQ\r\nr\r\n");
    await write("añadido con espacio.txt", "new\n");
    const head = await commit("head");
    const captured = await new GitSourceControlAdapter().changeHunks(root, base, head, 1_000_000);
    expect(captured).toEqual({
      status: "parsed",
      hunks: {
        version: 1, baseCommit: base, headCommit: head,
        files: [
          { path: "añadido con espacio.txt", status: "added", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] },
          { path: "crlf.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }] },
          { path: "deleted.txt", status: "deleted", hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 }] },
          { path: "image.bin", status: "binary", hunks: [] },
          { path: "modified.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }, { oldStart: 3, oldLines: 0, newStart: 4, newLines: 1 }] },
          { path: "no-newline.txt", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] },
          { path: "renamed näme.txt", previousPath: "old name.txt", status: "renamed", hunks: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1 }] },
        ],
      },
    });
  });

  it("ignores repository diff configuration that would change the format", async () => {
    const { root, git, write, commit } = await repository();
    await write("a b.txt", "1\n2\n3\n4\n5\n");
    const base = await commit("base");
    await write("a b.txt", "1\nX\n3\nY\n5\n");
    const head = await commit("head");
    for (const [key, value] of [["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"], ["core.quotePath", "false"], ["diff.interHunkContext", "5"], ["diff.renames", "copies"], ["color.diff", "always"], ["diff.external", "false"], ["diff.relative", "true"]]) await git("config", key, value);
    const captured = await new GitSourceControlAdapter().changeHunks(root, base, head, 1_000_000);
    expect(captured).toEqual({ status: "parsed", hunks: { version: 1, baseCommit: base, headCommit: head, files: [{ path: "a b.txt", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }, { oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 }] }] } });
  });

  it("does not parse a diff over the byte limit", async () => {
    const { write, root, commit } = await repository();
    const base = await commit("base");
    await write("large.txt", "line\n".repeat(10_000));
    const head = await commit("head");
    expect(await new GitSourceControlAdapter().changeHunks(root, base, head, 1024)).toEqual({ status: "too_large", limitBytes: 1024 });
  });

  it("keeps a leading U+FEFF in quoted rename and added paths", async () => {
    const { root, git, write, commit } = await repository();
    await write("\uFEFFfrom.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    await write("plain.txt", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");
    const base = await commit("base");
    await git("mv", "\uFEFFfrom.txt", "\uFEFFto.txt");
    await write("\uFEFFto.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n11\n");
    await git("mv", "plain.txt", "\uFEFFnew.txt");
    await write("\uFEFFadded.txt", "new\n");
    const head = await commit("head");
    const diff = await git("diff", ...changeHunksDiffArguments(base, head));
    expect(diff).toContain('rename to "\\357\\273\\277to.txt"');
    const captured = await new GitSourceControlAdapter().changeHunks(root, base, head, 1_000_000);
    if (captured.status !== "parsed") throw new Error("expected parsed hunks");
    expect(captured.hunks.files.map(file => [file.path, file.previousPath, file.status])).toEqual([
      ["\uFEFFadded.txt", undefined, "added"],
      ["\uFEFFnew.txt", "plain.txt", "renamed"],
      ["\uFEFFto.txt", "\uFEFFfrom.txt", "renamed"],
    ]);
    expect([...captured.hunks.files[2].path].map(char => char.codePointAt(0))[0]).toBe(0xfeff);
    expect([...captured.hunks.files[2].previousPath!].map(char => char.codePointAt(0))[0]).toBe(0xfeff);
  });

  it("does not parse output whose decoded UTF-8 outgrows the byte limit", async () => {
    const { root, write, commit } = await repository();
    const base = await commit("base");
    await write("invalid.txt", Buffer.concat([Buffer.alloc(400, 0xff), Buffer.from("\n")]));
    const head = await commit("head");
    const raw = (await promisify(execFile)("git", ["diff", ...changeHunksDiffArguments(base, head)], { cwd: root, env: isolatedGitEnvironment(), encoding: "buffer" })).stdout.length;
    const decoded = Buffer.byteLength((await promisify(execFile)("git", ["diff", ...changeHunksDiffArguments(base, head)], { cwd: root, env: isolatedGitEnvironment() })).stdout);
    expect(decoded).toBeGreaterThan(raw + 700);
    const adapter = new GitSourceControlAdapter();
    expect(await adapter.changeHunks(root, base, head, raw)).toEqual({ status: "too_large", limitBytes: raw });
    expect(await adapter.changeHunks(root, base, head, decoded)).toMatchObject({ status: "parsed" });
  });

  it("applies the same budget and cancellation contract to a configured runner", async () => {
    const [from, to] = ["a".repeat(40), "b".repeat(40)];
    const calls: string[][] = [];
    const runnerWith = (output: string, onCall?: () => void) => new GitSourceControlAdapter({ runner: async args => { calls.push(args); onCall?.(); return output; } });
    // Over the limit: not parsed, so unparseable output does not raise REVIEWFN_DIFF_UNSUPPORTED.
    expect(await runnerWith("not a diff\n".repeat(20)).changeHunks(".", from, to, 100)).toEqual({ status: "too_large", limitBytes: 100 });
    // Decoded replacement characters count at their UTF-8 length.
    expect(await runnerWith("\uFFFD".repeat(40)).changeHunks(".", from, to, 100)).toEqual({ status: "too_large", limitBytes: 100 });
    const aborted = new AbortController(); aborted.abort();
    calls.length = 0;
    await expect(runnerWith("").changeHunks(".", from, to, 100, aborted.signal)).rejects.toThrow("Change hunk capture canceled.");
    expect(calls).toEqual([]);
    const during = new AbortController();
    await expect(runnerWith("", () => during.abort()).changeHunks(".", from, to, 100, during.signal)).rejects.toThrow("Change hunk capture canceled.");
    expect(calls).toHaveLength(1);
    expect(await runnerWith("").changeHunks(".", from, to, 100)).toEqual({ status: "parsed", hunks: { version: 1, baseCommit: from, headCommit: to, files: [] } });
  });

  it("rejects an already-aborted capture without running git", async () => {
    const { root, write, commit } = await repository();
    const base = await commit("base");
    await write("file.txt", "x\n");
    const head = await commit("head");
    const controller = new AbortController(); controller.abort();
    await expect(new GitSourceControlAdapter().changeHunks(root, base, head, 1_000_000, controller.signal)).rejects.toThrow("Change hunk capture canceled.");
  });

  it("checks ancestry and treats unknown objects as unrelated", async () => {
    const { root, commit } = await repository();
    const first = await commit("first");
    const second = await commit("second");
    const adapter = new GitSourceControlAdapter();
    expect(await adapter.isAncestor(root, first, second)).toBe(true);
    expect(await adapter.isAncestor(root, second, second)).toBe(true);
    expect(await adapter.isAncestor(root, second, first)).toBe(false);
    expect(await adapter.isAncestor(root, "0".repeat(40), second)).toBe(false);
    expect(await adapter.isAncestor(root, "HEAD", second)).toBe(false);
  });
});

class MemoryStore implements ArtifactStore {
  public readonly values = new Map<string, Uint8Array>();
  public async put(kind: string, content: string | Uint8Array) { const bytes = Buffer.from(content); const digest = sha256(bytes); const id = `${kind}-${digest}`; this.values.set(id, bytes); return { digest, id }; }
  public async get(id: string) { return this.values.get(id); }
  public async deleteExpired() { return { deleted: [], errors: [] }; }
}

const manifest: Omit<ContextManifest, "digest"> = { version: 1, sources: [{ id: "issue:1", type: "issue", retrievedAt: "2026-01-01T00:00:00.000Z", digest: "d".repeat(64), status: "available", content: "must return value" }], selection: { candidates: ["ISS-1"], selected: ["issue:1"], rule: "explicit" }, limits: { maxSources: 10, maxBytes: 1000, maxDepth: 2 }, incompleteReasons: [] };
const context: ContextAdapter = { id: "fixture", preflight: async () => ({ ok: true, diagnostics: [] }), fetch: async () => structuredClone(manifest) };
const execution: ExecutionAdapter = { id: "fake-execution", preflight: async () => ({ ok: true, diagnostics: [] }), run: async () => [] };
const config = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, categories: ["behavior" as const] }, harness: { adapter: "fake", version: "1" }, inference: { provider: "fake", model: "fixture", auth: "none" }, context: [{ adapter: "fixture", issue: "ISS-1" }], execution: { ...DEFAULT_CONFIG.execution, adapter: "fake-execution" } };
const policy = { ...DEFAULT_POLICY, requiredCategories: ["behavior" as const] };
function harness(inspectedPaths: string[], extraEvidence: (head: string) => Evidence[] = () => []): HarnessAdapter {
  return {
    capabilities: { id: "fake", version: "1", providers: ["fake"], authModes: ["none"], structuredOutput: true, observableEvents: true, usageMetrics: true, cancellation: true, toolControls: true, sandboxModes: ["isolated"] },
    preflight: async () => ({ ok: true, diagnostics: [] }),
    run: async input => ({
      terminal: "completed", events: [], findings: [], uninspected: [], inspectedPaths,
      requirements: [{ id: "R1", statement: "Return value", sources: [{ sourceId: "issue:1", anchor: "L1" }], category: "behavior", scope: "api", classification: "mandatory", dependencies: [], extraction: { harness: "fake", promptDigest: "prompt" } }],
      assessments: [{ requirementId: "R1", status: "implemented", evidenceIds: ["E1"], reasoning: "present", gaps: [], confidence: 1 }],
      evidence: [{ id: "E1", kind: "code", description: "value", code: { commit: input.change.headCommit, path: "value.ts", startLine: 1 } }, ...extraEvidence(input.change.headCommit)],
    } satisfies HarnessOutput),
  };
}

async function incrementalFixture() {
  const fixture = await repository();
  const { git, write, commit } = fixture;
  await write("base.txt", "base\n");
  const beforeMergeBase = await commit("before merge base");
  const mergeBase = await commit("merge base");
  await git("checkout", "-q", "-b", "other");
  await write("other.txt", "other\n");
  const unrelated = await commit("unrelated");
  await git("checkout", "-q", "main");
  await git("checkout", "-q", "-b", "feature");
  await write("value.ts", "export const value = 1;\n");
  const first = await commit("first review");
  await write("value.ts", "export const value = 2;\n");
  await write("fix.ts", "export const fix = true;\n");
  const head = await commit("fix push");
  return { ...fixture, beforeMergeBase, mergeBase, unrelated, first, head };
}

async function review(root: string, since: string | undefined, inspectedPaths = ["fix.ts", "value.ts"], store: ArtifactStore = new MemoryStore(), extraEvidence?: (head: string) => Evidence[]) {
  const sourceControl = new GitSourceControlAdapter();
  const coordinator = new ReviewCoordinator({ sourceControl, contexts: [context], harness: harness(inspectedPaths, extraEvidence), execution, artifacts: store });
  const result = await coordinator.run({ root, base: "main", head: "HEAD", config, policy, issue: "ISS-1", since });
  return { ...result, store, sourceControl };
}

async function hunksOf(store: ArtifactStore, id: string | undefined) { return JSON.parse(Buffer.from((await store.get(id!))!).toString("utf8")); }

describe("incremental review range", { timeout: 30_000 }, () => {
  it("records full-change hunks without since and keeps the report otherwise unchanged", async () => {
    const { root, mergeBase, head } = await incrementalFixture();
    const { report, store } = await review(root, undefined);
    expect(report.coverage).toBe("complete");
    expect(report.verdict).toBe("ready");
    expect(report.changeDetail).toEqual({ hunksArtifact: expect.stringMatching(/^change-hunks-[0-9a-f]{64}$/), hunksDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(await hunksOf(store, report.changeDetail?.hunksArtifact)).toMatchObject({ baseCommit: mergeBase, headCommit: head, files: [{ path: "fix.ts", status: "added" }, { path: "value.ts", status: "added" }] });
  });

  it("scopes the delta to commits since the previous review while keeping the full change", async () => {
    const { root, first, mergeBase, head } = await incrementalFixture();
    const { report, store } = await review(root, first);
    expect(report.coverage).toBe("complete");
    expect(report.changeDetail).toMatchObject({ since: first, deltaPaths: ["fix.ts", "value.ts"] });
    expect(await hunksOf(store, report.changeDetail?.deltaHunksArtifact)).toEqual({ version: 1, baseCommit: first, headCommit: head, files: [{ path: "fix.ts", status: "added", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] }, { path: "value.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }] });
    expect((await hunksOf(store, report.changeDetail?.hunksArtifact)).baseCommit).toBe(mergeBase);
    expect(report.runId).not.toBe((await review(root, undefined)).report.runId);
  });

  it("completes an empty delta when since is the head", async () => {
    const { root, head } = await incrementalFixture();
    const { report, store } = await review(root, head);
    expect(report.execution).toBe("completed");
    expect(report.coverage).toBe("complete");
    expect(report.coverageReasons).toEqual([]);
    expect(report.changeDetail).toMatchObject({ since: head, deltaPaths: [] });
    expect((await hunksOf(store, report.changeDetail?.deltaHunksArtifact)).files).toEqual([]);
  });

  it("makes the delta equal the full change when since is the merge base", async () => {
    const { root, mergeBase } = await incrementalFixture();
    const { report } = await review(root, mergeBase);
    expect(report.coverage).toBe("complete");
    expect(report.changeDetail?.deltaHunksDigest).toBe(report.changeDetail?.hunksDigest);
    expect(report.changeDetail?.deltaPaths).toEqual(report.change.changedPaths);
  });

  it.each([["is not an ancestor of head", "unrelated"], ["precedes the merge base", "beforeMergeBase"]] as const)("fails before review when since %s", async (_name, key) => {
    const fixture = await incrementalFixture();
    const run = review(fixture.root, fixture[key]);
    await expect(run).rejects.toBeInstanceOf(ReviewFnError);
    await expect(run).rejects.toMatchObject({ code: "REVIEWFN_SINCE_NOT_ANCESTOR" });
  });

  it("rejects a malformed since in preflight instead of falling back to a full review", async () => {
    const { root } = await incrementalFixture();
    await expect(review(root, "HEAD~1")).rejects.toMatchObject({ code: "REVIEWFN_PREFLIGHT_FAILED", details: { diagnostics: [{ code: "REVIEWFN_SINCE_INVALID" }] } });
  });

  it("records incomplete delta coverage when a delta path is not inspected", async () => {
    const { root, first } = await incrementalFixture();
    const { report } = await review(root, first, ["value.ts"]);
    expect(report.coverage).toBe("incomplete");
    expect(report.coverageReasons).toContain("Delta path fix.ts has no inspected or explicitly uninspected scope.");
  });

  it("fails validation when a stored hunks artifact is tampered with", async () => {
    const { root, first } = await incrementalFixture();
    const { report, store, sourceControl } = await review(root, first);
    const validate = async (value: ReviewReport) => validateReport(value, policy, sourceControl, root, { ...manifest, digest: report.contextManifestDigest }, store);
    expect((await validate(report)).errors).toEqual([]);
    const id = report.changeDetail!.hunksArtifact;
    const forged = await hunksOf(store, id);
    forged.files.pop();
    store.values.set(id, Buffer.from(JSON.stringify(forged)));
    const result = await validate(report);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/^REVIEWFN_CHANGE_DETAIL_MISMATCH: change hunks artifact .* does not match digest/m);
  });

  it("records incomplete coverage rather than parsing a diff over maxOutputBytes", async () => {
    const { root, first } = await incrementalFixture();
    const sourceControl = new GitSourceControlAdapter();
    const coordinator = new ReviewCoordinator({ sourceControl, contexts: [context], harness: harness(["fix.ts", "value.ts"]), execution, artifacts: new MemoryStore() });
    const { report } = await coordinator.run({ root, base: "main", head: "HEAD", config, policy: { ...policy, limits: { ...policy.limits, maxOutputBytes: 64 } }, issue: "ISS-1", since: first });
    expect(report.coverage).toBe("incomplete");
    expect(report.changeDetail).toBeUndefined();
    expect(report.coverageReasons.join("\n")).toMatch(/Change diff [0-9a-f]+\.\.[0-9a-f]+ exceeds maxOutputBytes \(64\)[\s\S]*Incremental review since [0-9a-f]+ has no recorded change detail/);
  });

  it("completes a fix push that deletes a file added after the merge base", async () => {
    const { root, git, write, commit } = await repository();
    await write("base.txt", "base\n");
    await commit("merge base");
    await git("checkout", "-q", "-b", "feature");
    await write("value.ts", "export const value = 1;\n");
    await write("gone.ts", "export const gone = true;\n");
    const first = await commit("first review");
    await unlink(path.join(root, "gone.ts"));
    await write("value.ts", "export const value = 2;\n");
    await commit("fix push removes gone.ts");
    const atSince = (file: string) => (): Evidence[] => [{ id: "E2", kind: "diff", description: "removed by the fix push", code: { commit: first, path: file, startLine: 1 } }];
    const { report, store, sourceControl } = await review(root, first, ["gone.ts", "value.ts"], new MemoryStore(), atSince("gone.ts"));
    expect(report.change.changedPaths).toEqual(["value.ts"]);
    expect(report.changeDetail).toMatchObject({ since: first, deltaPaths: ["gone.ts", "value.ts"] });
    expect(report.coverageReasons).toEqual([]);
    expect(report.coverage).toBe("complete");
    expect(report.verdict).toBe("ready");
    expect((await validateReport(report, policy, sourceControl, root, { ...manifest, digest: report.contextManifestDigest }, store)).errors).toEqual([]);

    // Anchors at since stay limited to paths the verified delta removed.
    const kept = await review(root, first, ["gone.ts", "value.ts"], new MemoryStore(), atSince("value.ts"));
    expect(kept.report.coverage).toBe("incomplete");
    expect(kept.report.coverageReasons).toContain(`Evidence E2 does not reference reviewed head ${kept.report.change.headCommit}.`);
  });

  it("records incomplete coverage when the artifact store refuses the change hunks", async () => {
    const { root, first } = await incrementalFixture();
    const store = new MemoryStore();
    const refusing: ArtifactStore = { put: async (kind, content) => { if (kind === "change-hunks") throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", "Artifact exceeds the size limit."); return store.put(kind, content); }, get: id => store.get(id), deleteExpired: () => store.deleteExpired() };
    const { report } = await review(root, first, ["fix.ts", "value.ts"], refusing);
    expect(report.execution).toBe("completed");
    expect(report.changeDetail).toBeUndefined();
    expect(report.coverage).toBe("incomplete");
    expect(report.verdict).toBe("needs_verification");
    expect(report.coverageReasons).toEqual(expect.arrayContaining(["Change hunks could not be stored: Artifact exceeds the size limit.", `Incremental review since ${first} has no recorded change detail.`]));
  });
});
