import { describe, expect, it } from "vitest";

import { isPanelReport, PANEL_CANCELED_REASON, panelReportCanceled, panelStructureIssues, renderPanelMarkdownReport, type PanelFinding, type PanelReport, type PanelSlot, type SlotRun } from "../src/index.js";

const head = "b".repeat(40);
const base = "a".repeat(40);

function slot(id: string, stage: PanelSlot["stage"], model: string): PanelSlot {
  return { id, stage, harness: { adapter: "codex", version: "codex-cli 1.0.0" }, inference: { provider: "openai", model, auth: "api-key" }, lens: "general", budget: { timeoutMs: 60_000, maxOutputBytes: 1_000_000 } };
}

function run(slotId: string, model: string, terminal: SlotRun["terminal"], voidReasons: SlotRun["voidReasons"] = []): SlotRun {
  return { slotId, identity: { harnessAdapter: "codex", harnessVersion: "codex-cli 1.0.0", provider: "openai", model, auth: "api-key" }, terminal, voidReasons, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:01:00.000Z" };
}

function finding(title: string, overrides: Partial<PanelFinding>): PanelFinding {
  return {
    fingerprint: `fp-${title.toLowerCase().replaceAll(" ", "-")}`, severity: "high", category: "correctness", title, trigger: `when ${title}`, impact: "wrong value", direction: "return the right value",
    evidenceIds: ["E1"], basis: "inferred", requirementIds: [], lifecycle: "new", origins: [{ slotId: "alpha", lens: "general" }], confidence: 0.8, ruleIds: [], disposition: "reported", ...overrides,
  };
}

/** A panel report with a completed, a collapsed, a void and a failed slot, an unrun verifier, and findings in every disposition. */
function fixture(): PanelReport {
  return {
    schemaVersion: 1, kind: "reviewfn-panel", runId: "f".repeat(64), createdAt: "2026-11-01T00:02:00.000Z",
    change: { repositoryId: "https://github.com/acme/repo", host: "github.com", pullRequest: 7, targetBranch: "main", baseCommit: base, headCommit: head, mergeBaseCommit: base, diffDigest: "d".repeat(64), changedPaths: ["src/a.ts", "src/b.ts"], capturedAt: "2026-11-01T00:00:00.000Z" },
    panelPolicyDigest: "e".repeat(64),
    slots: [slot("alpha", 1, "model-a"), slot("twin", 1, "model-a"), slot("swapped", 1, "model-s"), slot("broken", 2, "model-b"), slot("checker", "verifier", "model-v")],
    slotRuns: [run("alpha", "model-a", "completed"), run("twin", "model-a", "collapsed"), run("swapped", "cheaper-model", "void", ["model_mismatch", "workspace_mutated"]), run("broken", "model-b", "failed")],
    gateReceipts: [{ id: "test-0", command: ["npm", "test"], cwd: ".", commit: head, startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:01.000Z", runtimeMs: 1000, exitCode: 0, signal: null, timedOut: false, canceled: false, stdoutDigest: "1".repeat(64), stderrDigest: "2".repeat(64), limitations: [] }],
    evidence: [{ id: "E1", kind: "code", description: "value", code: { commit: head, path: "src/b.ts", startLine: 3 } }],
    findings: [
      finding("Low in b", { severity: "low", anchor: { commit: head, path: "src/b.ts", startLine: 9 } }),
      finding("Unanchored critical", { severity: "critical", origins: [{ slotId: "alpha", lens: "general" }, { slotId: "twin", lens: "general" }] }),
      finding("Critical in b", { severity: "critical", anchor: { commit: head, path: "src/b.ts", startLine: 3, endLine: 5 }, verification: { verdict: "confirmed", slotId: "checker", evidenceIds: ["E1"], onBase: "absent", reason: "reproduced at head" } }),
      finding("Critical in a", { severity: "critical", anchor: { commit: head, path: "src/a.ts", startLine: 1 }, verification: { verdict: "inconclusive", slotId: "checker", evidenceIds: [], onBase: "present", reason: "also on base" } }),
      finding("Refuted race", { severity: "medium", disposition: "dropped", dispositionReason: "The verifier showed the lock is held.", verification: { verdict: "refuted", slotId: "checker", evidenceIds: ["E1"], onBase: "not_checked", reason: "lock held" } }),
      finding("Waived <script> | pipe", { severity: "medium", disposition: "suppressed", dispositionReason: "Accepted by the issue owner.", suppressionReference: { sourceId: "issue:1", anchor: "waiver" } }),
    ],
    clusters: [],
    coverage: "incomplete",
    coverageReasons: ["REVIEWFN_PANEL_QUORUM_UNMET: stage 2 has 0 completed slot run(s) with distinct identities; its quorum is 1."],
    verdict: "needs_verification",
  };
}

describe("renderPanelMarkdownReport", () => {
  it("renders a structurally valid panel report fixture", async () => {
    const report = fixture();
    expect(panelStructureIssues("panelReport", report)).toEqual([]);
    await expect(renderPanelMarkdownReport(report)).toMatchFileSnapshot("__snapshots__/panel-report.md");
  });

  it("groups reported findings by severity, then file, with unanchored findings last", () => {
    const markdown = renderPanelMarkdownReport(fixture());
    const order = ["### Critical (P0)", "#### `src/a.ts`", "Critical in a", "#### `src/b.ts`", "Critical in b", "#### Not anchored to a file", "Unanchored critical", "### Low (P3)", "Low in b"].map(text => markdown.indexOf(text));
    expect(order.every(index => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("resolves every evidence ID a reported finding cites to its kind, description and location", () => {
    const report = fixture();
    report.evidence.push({ id: "E2", kind: "source", description: "issue text", source: { sourceId: "issue:1", anchor: "L2" } }, { id: "E3", kind: "test", description: "test run", receiptId: "test-0" });
    report.findings[1].evidenceIds = ["E1", "E2", "E3", "E9"];
    const markdown = renderPanelMarkdownReport(report);
    const unanchored = markdown.slice(markdown.indexOf("- **Unanchored critical**"), markdown.indexOf("### Low (P3)"));
    expect(unanchored).toContain(`    - E1 (code): value; \`src/b.ts:3\` at \`${head}\``);
    expect(unanchored).toContain("    - E2 (source): issue text; source issue:1\\#L2");
    expect(unanchored).toContain("    - E3 (test): test run; receipt test-0");
    expect(unanchored).toContain("    - E9: not in this report's evidence");
  });

  it("resolves the evidence a verification cites, including a base location the finding itself does not cite", () => {
    const report = fixture();
    report.evidence.push({ id: "B1", kind: "code", description: "same code on base", code: { commit: base, path: "src/a.ts", startLine: 1 } });
    const [, , , onBase, dropped] = report.findings;
    onBase.verification = { ...onBase.verification!, verdict: "confirmed", evidenceIds: ["B1"] };
    dropped.verification = { ...dropped.verification!, evidenceIds: ["B1"] };
    const markdown = renderPanelMarkdownReport(report);
    const reported = markdown.slice(markdown.indexOf("- **Critical in a**"), markdown.indexOf("#### `src/b.ts`"));
    const line = `    - B1 (code): same code on base; \`src/a.ts:1\` at \`${base}\``;
    expect(reported).toContain(`  - Verification: confirmed by checker: also on base; evidence B1\n${line}`);
    const setAside = markdown.slice(markdown.indexOf("- **Refuted race**"), markdown.indexOf("- **Waived"));
    expect(setAside).toContain(`  - Verification: refuted by checker: lock held; evidence B1\n${line}`);
    // Evidence cited by both the finding and its verification is expanded once.
    const shared = markdown.slice(markdown.indexOf("- **Critical in b**"), markdown.indexOf("#### Not anchored"));
    expect(shared.split("    - E1 (code)")).toHaveLength(2);
  });

  it("keeps dropped and suppressed findings out of the reported sections, inside one collapsed section with reasons", () => {
    const markdown = renderPanelMarkdownReport(fixture());
    const details = markdown.slice(markdown.indexOf("<details>"), markdown.indexOf("</details>"));
    expect(markdown.slice(0, markdown.indexOf("<details>"))).not.toContain("Refuted race");
    expect(details).toContain("Refuted race");
    expect(details).toContain("The verifier showed the lock is held");
    expect(details).toContain("Suppressed by: issue:1\\#waiver");
    // Untrusted text cannot open HTML or break a table.
    expect(details).toContain("Waived \\<script\\> \\| pipe");
  });

  it("explains collapsed and void slots, and lists slots that did not run", () => {
    const markdown = renderPanelMarkdownReport(fixture());
    expect(markdown).toContain("| twin | 1 | general | codex codex-cli 1\\.0\\.0 | openai/model-a | collapsed | collapsed: same identity as alpha, which counts toward quorum |");
    expect(markdown).toContain("| swapped | 1 | general | codex codex-cli 1\\.0\\.0 | openai/cheaper-model | void | void: model\\_mismatch, workspace\\_mutated |");
    expect(markdown).toContain("| checker | verifier | general | codex codex-cli 1\\.0\\.0 | openai/model-v | not run |  |");
  });

  it("marks an unverified model and lists a run's limitations", () => {
    const report = fixture();
    const twin = report.slotRuns.find(item => item.slotId === "twin")!;
    twin.identity = { ...twin.identity, modelVerified: false };
    twin.limitations = ["model_unverified", "sandbox_tree_verified_only"];
    const markdown = renderPanelMarkdownReport(report);
    expect(markdown).toContain("| openai/model-a \\(unverified\\) | collapsed | collapsed: same identity as alpha, which counts toward quorum; limitations: model\\_unverified, sandbox\\_tree\\_verified\\_only |");
  });

  it("escapes harness-supplied categories and every other untrusted string outside code spans", () => {
    const hostile = "@octocat <img src=x> [link](https://e.x) | `tick`\nnext";
    const report = fixture();
    const [reported, , , , dropped, suppressed] = report.findings;
    reported.category = hostile;
    for (const item of [reported, dropped, suppressed]) Object.assign(item, { title: hostile, trigger: hostile, impact: hostile, direction: hostile, evidenceIds: [hostile], origins: [{ slotId: "alpha", lens: hostile }] });
    dropped.dispositionReason = hostile;
    dropped.verification = { ...dropped.verification!, reason: hostile, evidenceIds: [hostile] };
    suppressed.suppressionReference = { sourceId: hostile, anchor: hostile };
    report.slots[0] = { ...report.slots[0], lens: hostile };
    report.slotRuns[0] = { ...report.slotRuns[0], identity: { ...report.slotRuns[0].identity, harnessVersion: hostile, model: hostile } };
    report.coverageReasons = [hostile];
    report.gateReceipts[0] = { ...report.gateReceipts[0], command: [hostile] };
    const markdown = renderPanelMarkdownReport(report);
    expect(markdown).toContain("- **&#64;octocat \\<img src=x\\> \\[link\\]\\(https://e\\.x\\) \\| \\`tick\\` next** (&#64;octocat \\<img src=x\\> \\[link\\]\\(https://e\\.x\\) \\| \\`tick\\` next; not checked against base)");
    // No mention, raw HTML, link, line break or unescaped pipe from the hostile text survives anywhere.
    expect(markdown).not.toContain("@octocat");
    expect(markdown).not.toMatch(/(^|[^\\])<img/);
    expect(markdown).not.toMatch(/(^|[^\\])\]\(/);
    expect(markdown).not.toMatch(/(^|[^\\])\| `tick/);
    expect(markdown.split("\n").some(line => line.startsWith("next"))).toBe(false);
  });

  it("identifies panel reports and canceled panel runs", () => {
    expect(isPanelReport(fixture())).toBe(true);
    expect(isPanelReport({ schemaVersion: 1, execution: "completed" })).toBe(false);
    expect(panelReportCanceled(fixture())).toBe(false);
    expect(panelReportCanceled({ coverageReasons: [PANEL_CANCELED_REASON] })).toBe(true);
  });
});
