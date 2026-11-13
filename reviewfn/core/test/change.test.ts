import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, ReviewFnError, parseChangeHunks, serializeChangeHunks, sha256, sinceRangeError, validateReport, verifyChangeDetail, type ArtifactStore, type ChangeHunks, type ContextManifest, type ReviewReport, type SourceControlAdapter } from "../src/index.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const SINCE = "c".repeat(40);

class MemoryStore implements ArtifactStore {
  public readonly values = new Map<string, Uint8Array>();
  public async put(kind: string, content: string | Uint8Array) { const bytes = Buffer.from(content); const digest = sha256(bytes); const id = `${kind}-${digest}`; this.values.set(id, bytes); return { digest, id }; }
  public async get(id: string) { return this.values.get(id); }
  public async deleteExpired() { return { deleted: [], errors: [] }; }
}

function code(error: unknown): string | undefined { return error instanceof ReviewFnError ? error.code : undefined; }
function parseError(diff: string): string | undefined { try { parseChangeHunks(diff, BASE, HEAD); return undefined; } catch (error) { return code(error); } }

describe("parseChangeHunks", () => {
  it("parses zero-context hunks, omitted counts, and no-newline markers", () => {
    const diff = [
      "diff --git a/src/value.ts b/src/value.ts", "index 1..2 100644", "--- a/src/value.ts", "+++ b/src/value.ts",
      "@@ -2 +2 @@ export", "-old", "+new", "@@ -9,0 +10,2 @@", "+one", "+two", "\\ No newline at end of file", "",
    ].join("\n");
    expect(parseChangeHunks(diff, BASE, HEAD)).toEqual({ version: 1, baseCommit: BASE, headCommit: HEAD, files: [{ path: "src/value.ts", status: "modified", hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }, { oldStart: 9, oldLines: 0, newStart: 10, newLines: 2 }] }] });
  });

  it("decodes C-quoted paths and keeps rename provenance", () => {
    const diff = ['diff --git a/old name.txt "b/n\\303\\244me \\"q\\".txt"', "similarity index 100%", "rename from old name.txt", 'rename to "n\\303\\244me \\"q\\".txt"', ""].join("\n");
    expect(parseChangeHunks(diff, BASE, HEAD).files).toEqual([{ path: 'näme "q".txt', previousPath: "old name.txt", status: "renamed", hunks: [] }]);
  });

  it("merges a type change into one modified path and sorts files", () => {
    const diff = [
      "diff --git a/z b/z", "new file mode 100644", "index 0..1", "--- /dev/null", "+++ b/z", "@@ -0,0 +1 @@", "+z",
      "diff --git a/link b/link", "deleted file mode 120000", "index 1..0", "--- a/link", "+++ /dev/null", "@@ -1 +0,0 @@", "-target", "\\ No newline at end of file",
      "diff --git a/link b/link", "new file mode 100644", "index 0..1", "--- /dev/null", "+++ b/link", "@@ -0,0 +1 @@", "+regular", "",
    ].join("\n");
    expect(parseChangeHunks(diff, BASE, HEAD).files).toEqual([
      { path: "link", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 }, { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] },
      { path: "z", status: "added", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] },
    ]);
  });

  it("accepts hunk header function-name trailers that contain CR or Unicode line separators", () => {
    const diff = ["diff --git a/f b/f", "index 1..2 100644", "--- a/f", "+++ b/f", "@@ -3 +3 @@ void run()\r", "-old\r", "+new\r", "@@ -8 +8 @@ label\u2028more\u2029end", "-x", "+y", ""].join("\n");
    expect(parseChangeHunks(diff, BASE, HEAD).files).toEqual([{ path: "f", status: "modified", hunks: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1 }, { oldStart: 8, oldLines: 1, newStart: 8, newLines: 1 }] }]);
  });

  it("accepts an empty diff", () => expect(parseChangeHunks("", BASE, HEAD).files).toEqual([]));

  it.each([
    ["combined diff", "diff --cc file\nindex 1,2..3\n--- a/file\n+++ b/file\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n +b\n"],
    ["word diff", "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n[-old-]{+new+}\n"],
    ["porcelain word diff", "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n~\n-old\n+new\n~\n"],
    ["external diff driver", "f: files differ\n"],
    ["context lines", "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n"],
    ["short hunk", "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1,2 +1 @@\n-old\n"],
    ["unprefixed paths", "diff --git f f\nindex 1..2 100644\n--- f\n+++ f\n@@ -1 +1 @@\n-old\n+new\n"],
    ["copy detection", "diff --git a/f b/g\nsimilarity index 100%\ncopy from f\ncopy to g\n"],
    ["truncated output", "diff --git a/f b/f\nindex 1..2 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new"],
    ["mode mismatch", "diff --git a/f b/f\nnew file mode 100644\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new\n"],
  ])("rejects %s with REVIEWFN_DIFF_UNSUPPORTED", (_name, diff) => expect(parseError(diff)).toBe("REVIEWFN_DIFF_UNSUPPORTED"));
});

describe("sinceRangeError", () => {
  const graph = new Map([[BASE, [BASE]], [SINCE, [BASE, SINCE]], [HEAD, [BASE, SINCE, HEAD]]]);
  const isAncestor = async (ancestor: string, descendant: string) => graph.get(descendant)?.includes(ancestor) ?? false;
  it("accepts since between the merge base and head, inclusive", async () => {
    for (const since of [BASE, SINCE, HEAD]) expect(await sinceRangeError(since, BASE, HEAD, isAncestor)).toBeUndefined();
  });
  it("rejects malformed, unrelated, and pre-merge-base commits", async () => {
    expect(await sinceRangeError("HEAD~1", BASE, HEAD, isAncestor)).toMatch(/full 40- or 64-hex/);
    expect(await sinceRangeError("d".repeat(40), BASE, HEAD, isAncestor)).toMatch(/not an ancestor of head/);
    expect(await sinceRangeError(BASE, SINCE, HEAD, isAncestor)).toMatch(/not a descendant of merge base/);
  });
});

const context: ContextManifest = { version: 1, sources: [{ id: "issue", type: "issue", status: "available", content: "Return 1", digest: sha256("Return 1"), retrievedAt: "now" }], selection: { candidates: ["issue"], selected: ["issue"], rule: "explicit" }, limits: { maxSources: 10, maxBytes: 1000, maxDepth: 3 }, incompleteReasons: [], digest: "digest" };
const policy = { ...DEFAULT_POLICY, requiredCategories: ["behavior" as const] };
const source: SourceControlAdapter = { id: "fake", capture: async () => report().change, currentHead: async () => HEAD, verifyAnchor: async () => true };
function report(): ReviewReport {
  return { schemaVersion: 1, runId: "run", attemptId: "attempt", createdAt: "now", change: { repositoryId: "test", host: "local", targetBranch: "main", baseCommit: BASE, headCommit: HEAD, mergeBaseCommit: BASE, diffDigest: "d".repeat(64), changedPaths: ["index.ts", "other.ts"], capturedAt: "now" }, contextManifestDigest: "digest", contextManifestArtifact: "context", configuration: { schemaVersion: 1, policyDigest: "p", promptDigest: "p", harness: { id: "fake", version: "1" }, inference: { provider: "fake", model: "fake", auth: "none" }, execution: { adapter: "fake", timeoutMs: 1, maxOutputBytes: 1 }, contextAdapters: [], profile: "test" }, execution: "completed", coverage: "complete", coverageReasons: [], verdict: "ready", requirements: [{ id: "r", statement: "Return 1", sources: [{ sourceId: "issue", anchor: "L1" }], category: "behavior", scope: "API", classification: "mandatory", dependencies: [], extraction: { harness: "fake", promptDigest: "p" } }], assessments: [{ requirementId: "r", status: "implemented", evidenceIds: ["e"], reasoning: "code", gaps: [], confidence: 1 }], evidence: [{ id: "e", kind: "code", description: "return", code: { commit: HEAD, path: "index.ts", startLine: 1 } }], findings: [], tests: [], inspectedPaths: ["index.ts", "other.ts"], uninspected: [], limitations: [] };
}
const full: ChangeHunks = { version: 1, baseCommit: BASE, headCommit: HEAD, files: [{ path: "index.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }, { path: "other.ts", status: "added", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }] }] };
const delta: ChangeHunks = { version: 1, baseCommit: SINCE, headCommit: HEAD, files: [full.files[1]] };
async function incremental(store = new MemoryStore()) {
  const value = report();
  const stored = await store.put("change-hunks", serializeChangeHunks(full));
  const storedDelta = await store.put("change-hunks", serializeChangeHunks(delta));
  value.changeDetail = { hunksArtifact: stored.id, hunksDigest: stored.digest, since: SINCE, deltaHunksArtifact: storedDelta.id, deltaHunksDigest: storedDelta.digest, deltaPaths: ["other.ts"] };
  return { value, store };
}
const errors = async (value: ReviewReport, store?: ArtifactStore, adapter = source) => (await validateReport(value, policy, adapter, ".", context, store)).errors;

describe("changeDetail validation", () => {
  it("validates a report without changeDetail as before", async () => expect(await errors(report())).toEqual([]));

  it("accepts verified full and delta hunks", async () => {
    const { value, store } = await incremental();
    expect(await errors(value, store)).toEqual([]);
  });

  it("rejects a tampered hunks artifact", async () => {
    const { value, store } = await incremental();
    const id = value.changeDetail!.hunksArtifact;
    store.values.set(id, Buffer.from(serializeChangeHunks({ ...full, files: [full.files[0]] })));
    expect((await errors(value, store)).join("\n")).toMatch(/REVIEWFN_CHANGE_DETAIL_MISMATCH: change hunks artifact .* does not match digest/);
  });

  it("rejects a tampered delta artifact, a forged digest, and edited deltaPaths", async () => {
    let { value, store } = await incremental();
    store.values.set(value.changeDetail!.deltaHunksArtifact!, Buffer.from(serializeChangeHunks({ ...delta, files: [] })));
    expect((await errors(value, store)).join("\n")).toMatch(/REVIEWFN_CHANGE_DETAIL_MISMATCH: delta hunks/);
    ({ value, store } = await incremental());
    value.changeDetail!.hunksDigest = "0".repeat(64);
    expect((await errors(value, store)).join("\n")).toMatch(/REVIEWFN_CHANGE_DETAIL_MISMATCH: change hunks artifact .* not the content-addressed/);
    ({ value, store } = await incremental());
    value.changeDetail!.deltaPaths = [];
    expect((await errors(value, store)).join("\n")).toMatch(/REVIEWFN_CHANGE_DETAIL_MISMATCH: deltaPaths do not match/);
  });

  it("rejects hunks for a different range or change, and delta fields without since", async () => {
    const store = new MemoryStore();
    const value = report();
    const other = await store.put("change-hunks", serializeChangeHunks({ ...full, baseCommit: SINCE }));
    value.changeDetail = { hunksArtifact: other.id, hunksDigest: other.digest, deltaPaths: [] };
    const result = (await errors(value, store)).join("\n");
    expect(result).toMatch(/change hunks cover c+\.\.b+, not the reviewed/);
    expect(result).toMatch(/delta hunks require since/);
    const narrowed = report(); narrowed.change.changedPaths = ["index.ts", "missing.ts"]; narrowed.inspectedPaths = ["index.ts", "missing.ts"];
    const stored = await store.put("change-hunks", serializeChangeHunks(full));
    narrowed.changeDetail = { hunksArtifact: stored.id, hunksDigest: stored.digest };
    expect((await errors(narrowed, store)).join("\n")).toMatch(/path other\.ts is not a changed path[\s\S]*changed path missing\.ts is missing from the change hunks/);
  });

  it("cannot verify changeDetail without the artifact store", async () => {
    const { value } = await incremental();
    expect(await verifyChangeDetail(value)).toMatchObject({ errors: ["REVIEWFN_CHANGE_DETAIL_MISMATCH: changeDetail cannot be verified without the artifact store."] });
  });

  it("requires every delta path to be inspected or explicitly uninspected", async () => {
    const { value, store } = await incremental();
    value.change.changedPaths = ["index.ts"];
    value.inspectedPaths = ["index.ts"];
    const mismatched = await errors(value, store);
    expect(mismatched).toContain("Delta path other.ts has no inspected or explicitly uninspected scope.");
    value.uninspected = [{ scope: "other.ts", reason: "generated" }]; value.coverage = "incomplete"; value.coverageReasons = ["generated"]; value.verdict = "needs_verification";
    expect((await errors(value, store)).filter(error => error.startsWith("Delta path"))).toEqual([]);
  });

  it("rechecks the recorded since range when the source control can", async () => {
    const { value, store } = await incremental();
    const adapter = { ...source, isAncestor: async (ancestor: string, descendant: string) => !(ancestor === SINCE && descendant === HEAD) };
    expect(await errors(value, store, { ...adapter, isAncestor: async (_root: string, a: string, d: string) => adapter.isAncestor(a, d) })).toContain(`REVIEWFN_SINCE_NOT_ANCESTOR: since ${SINCE} is not an ancestor of head ${HEAD}.`);
  });
});
