import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLICY, PANEL_PRIORITY_SEVERITY, PANEL_VALIDATION_CODES, credentialFingerprint, derivePanelVerdict, harnessOutputSchema, lensOutputSchema, panelFindingSchema, stableStringify, strictProviderSchema, validateStructuredOutput,
  panelPolicyDigest, panelPolicySchema, panelReportSchema, panelStructureIssues, serializeChangeHunks, sha256, slotIdentityKey, slotIdentitySchema, slotRunSchema,
  validatePanelFinding, validatePanelPolicy, validatePanelReport as validateWithOptions, validateReport, validateSlotIdentity, validateSlotRun,
  type ArtifactStore, type ContextManifest, type LensOutput, type PanelFinding, type PanelPolicy, type PanelReport, type PanelReportValidationOptions, type PanelStructure, type ReviewPolicy, type ReviewReport, type SlotRun, type SourceControlAdapter,
} from "../src/index.js";

const head = "b".repeat(40);
const mergeBase = "a".repeat(40);
// issue:1 may waive or suppress: suppression references are verified like 0.1 waivers.
const policy = { ...DEFAULT_POLICY, requiredCategories: ["behavior" as const], sourceAuthority: { ...DEFAULT_POLICY.sourceAuthority, waiverAuthorities: ["issue:1"] } };
const change = { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: mergeBase, headCommit: head, mergeBaseCommit: mergeBase, diffDigest: "d".repeat(64), changedPaths: ["src/value.ts"], capturedAt: "2026-01-01T00:00:00.000Z" };
const context: ContextManifest = { version: 1, sources: [{ id: "issue:1", type: "issue", status: "available", content: "Return the value", retrievedAt: "2026-01-01T00:00:00.000Z", digest: "d" }], selection: { candidates: [], selected: [], rule: "explicit" }, limits: { maxSources: 1, maxBytes: 100, maxDepth: 1 }, incompleteReasons: [], digest: "c".repeat(64) };
const sourceControl: SourceControlAdapter = { id: "fixture", capture: async () => change, currentHead: async () => head, verifyAnchor: async () => true };
const options = { sourceControl, root: ".", context };

class MemoryStore implements ArtifactStore {
  public readonly values = new Map<string, Uint8Array>();
  public async put(kind: string, content: string | Uint8Array) { const bytes = Buffer.from(content); const digest = sha256(bytes); const id = `${kind}-${digest}`; this.values.set(id, bytes); return { digest, id }; }
  public async get(id: string) { return this.values.get(id); }
  public async deleteExpired() { return { deleted: [], errors: [] }; }
}

/** The unchanged 0.1 single-harness report, as in the 0.1 core tests. */
function requirementsReport(): ReviewReport {
  return {
    schemaVersion: 1, runId: "run", attemptId: "attempt", createdAt: "2026-01-01T00:00:00.000Z", change: structuredClone(change),
    contextManifestDigest: "c".repeat(64), contextManifestArtifact: `context-manifest-${"c".repeat(64)}`,
    configuration: { schemaVersion: 1, policyDigest: "p", promptDigest: "q", harness: { id: "codex", version: "0.154.0" }, inference: { provider: "openai", model: "gpt-6.1-sol", auth: "chatgpt" }, execution: { adapter: "fixture", timeoutMs: 1, maxOutputBytes: 1 }, contextAdapters: ["fixture"], profile: "requirements" },
    execution: "completed", coverage: "complete", coverageReasons: [], verdict: "ready",
    requirements: [{ id: "R1", statement: "Return the value", sources: [{ sourceId: "issue:1", anchor: "L1" }], category: "behavior", scope: "public API", classification: "mandatory", dependencies: [], extraction: { harness: "fixture", promptDigest: "p" } }],
    assessments: [{ requirementId: "R1", status: "implemented", evidenceIds: ["E1"], reasoning: "covered", gaps: [], confidence: 1 }],
    evidence: [{ id: "E1", kind: "code", description: "implementation", code: { commit: head, path: "src/value.ts", startLine: 1 } }],
    findings: [], tests: [], inspectedPaths: ["src/value.ts"], uninspected: [], limitations: [],
  };
}

const account = credentialFingerprint("account-1");
const panelPolicy: PanelPolicy = {
  version: 1,
  slots: [
    { id: "lens-a", stage: 1, harness: { adapter: "codex", version: "0.154.0" }, inference: { provider: "openai", model: "gpt-6.1-sol", auth: "chatgpt" }, lens: "general", budget: { timeoutMs: 600_000, maxOutputBytes: 1_000_000 } },
    { id: "lens-b", stage: 1, harness: { adapter: "codex", version: "0.154.0" }, inference: { provider: "openai", model: "gpt-6.1-sol", auth: "chatgpt" }, lens: "security", budget: { timeoutMs: 600_000, maxOutputBytes: 1_000_000 } },
    { id: "lens-c", stage: 2, harness: { adapter: "claude-code", version: "2.1.0" }, inference: { provider: "anthropic", model: "claude-opus-5-5", auth: "api-key", credentialEnv: "ANTHROPIC_API_KEY" }, lens: "general", budget: { timeoutMs: 600_000, maxOutputBytes: 1_000_000 } },
    { id: "verifier", stage: "verifier", harness: { adapter: "codex", version: "0.154.0" }, inference: { provider: "openai", model: "gpt-6-astra", auth: "chatgpt" }, lens: "verifier", budget: { timeoutMs: 300_000, maxOutputBytes: 500_000 } },
  ],
  quorum: { stage1: 1, stage2: 1 },
  requirementsSlot: "lens-a",
  incremental: "full",
};

/** Panel policies by digest. A caller validates a report against the panel policy whose digest the report records. */
const policies = new Map<string, PanelPolicy>();
function sign(report: PanelReport, signed: PanelPolicy): void {
  report.panelPolicyDigest = panelPolicyDigest(signed);
  policies.set(report.panelPolicyDigest, signed);
}
/** `validatePanelReport` with the panel policy the report records, unless the options name another one (or none). */
const validatePanelReport = (value: unknown, reviewPolicy: ReviewPolicy, extra: PanelReportValidationOptions = {}) => {
  const digest = value && typeof value === "object" ? (value as { panelPolicyDigest?: unknown }).panelPolicyDigest : undefined;
  return validateWithOptions(value, reviewPolicy, { panelPolicy: typeof digest === "string" ? policies.get(digest) : undefined, ...extra });
};

function finding(fingerprint: string, overrides: Partial<PanelFinding>): PanelFinding {
  return {
    fingerprint, severity: "high", category: "correctness", title: `Defect ${fingerprint}`, trigger: "An empty input", impact: "The call throws", direction: "Guard the empty case",
    anchor: { commit: head, path: "src/value.ts", startLine: 1 }, evidenceIds: ["E1"], basis: "inferred", requirementIds: ["R1"], lifecycle: "new",
    origins: [{ slotId: "lens-a", lens: "general" }], confidence: 0.7, ruleIds: [], disposition: "reported", ...overrides,
  };
}

/** Three review slots (lens-b collapsed into lens-a, lens-c void for a model mismatch) plus the verifier, two clusters, and confirmed, dropped and suppressed findings. */
function panelReport(): PanelReport {
  const identity = { harnessAdapter: "codex", harnessVersion: "0.154.0", provider: "openai", model: "gpt-6.1-sol", auth: "chatgpt", credentialFingerprint: account };
  const report: PanelReport = {
    schemaVersion: 1, kind: "reviewfn-panel", runId: "panel-run", createdAt: "2026-01-01T00:10:00.000Z", change: structuredClone(change),
    panelPolicyDigest: "", slots: structuredClone(panelPolicy.slots),
    slotRuns: [
      { slotId: "lens-a", identity: { ...identity }, terminal: "completed", voidReasons: [], startedAt: "2026-01-01T00:01:00.000Z", finishedAt: "2026-01-01T00:04:00.000Z", outputArtifact: `slot-output-${"e".repeat(64)}`, outputDigest: "e".repeat(64), usage: { inputTokens: 1200, outputTokens: 300 } },
      { slotId: "lens-b", identity: { ...identity }, terminal: "collapsed", voidReasons: [], startedAt: "2026-01-01T00:01:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z" },
      { slotId: "lens-c", identity: { harnessAdapter: "claude-code", harnessVersion: "2.1.0", provider: "anthropic", model: "claude-sonnet-5-5", auth: "api-key", credentialFingerprint: credentialFingerprint("anthropic-key") }, terminal: "void", voidReasons: ["model_mismatch"], startedAt: "2026-01-01T00:04:00.000Z", finishedAt: "2026-01-01T00:06:00.000Z" },
      { slotId: "verifier", identity: { ...identity, model: "gpt-6-astra" }, terminal: "completed", voidReasons: [], startedAt: "2026-01-01T00:06:00.000Z", finishedAt: "2026-01-01T00:08:00.000Z", usage: { costUsd: 0.12 } },
    ],
    requirementsReport: requirementsReport(),
    gateReceipts: [],
    evidence: [
      { id: "E1", kind: "code", description: "the unguarded loop", code: { commit: head, path: "src/value.ts", startLine: 1 } },
      { id: "V1", kind: "code", description: "verifier reproduction of the unguarded loop", code: { commit: head, path: "src/value.ts", startLine: 1 } },
      { id: "V2", kind: "code", description: "the guard the refuted finding missed", code: { commit: head, path: "src/value.ts", startLine: 1 } },
    ],
    findings: [
      finding("f-confirmed", { verification: { verdict: "confirmed", slotId: "verifier", evidenceIds: ["V1"], onBase: "absent", reason: "The loop has no guard at head." } }),
      finding("f-refuted", { title: "Defect variant", verification: { verdict: "refuted", slotId: "verifier", evidenceIds: ["V2"], onBase: "not_checked", reason: "A guard precedes the loop." }, disposition: "dropped", dispositionReason: "Refuted by the verifier." }),
      finding("f-suppressed", { severity: "low", ruleIds: ["style-1"], disposition: "suppressed", dispositionReason: "Accepted by the issue.", suppressionReference: { sourceId: "issue:1", anchor: "L1" } }),
    ],
    clusters: [{ id: "cluster-1", findingFingerprints: ["f-confirmed", "f-refuted"] }, { id: "cluster-2", findingFingerprints: ["f-suppressed"] }],
    coverage: "complete", coverageReasons: [],
    verdict: "changes_requested",
  };
  sign(report, panelPolicy);
  return report;
}

const schemas: Record<PanelStructure, object> = { panelPolicy: panelPolicySchema, slotIdentity: slotIdentitySchema, slotRun: slotRunSchema, panelFinding: panelFindingSchema, panelReport: panelReportSchema, lensOutput: lensOutputSchema };
const ajv = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, new Ajv({ allErrors: true, strict: true }).compile(schema)])) as Record<PanelStructure, ReturnType<Ajv["compile"]>>;
const ajvValid = (kind: PanelStructure, value: unknown) => ajv[kind](value) as boolean;
const codes = (issues: Array<{ code: string }>) => [...new Set(issues.map(issue => issue.code))].sort();

/** A changed copy; a copy whose slots changed is signed with the panel policy that declares those slots. */
function mutate(report: PanelReport, change: (value: PanelReport) => void): PanelReport {
  const value = structuredClone(report);
  change(value);
  const signed = policies.get(value.panelPolicyDigest);
  if (signed && Array.isArray(value.slots) && stableStringify(signed.slots) !== stableStringify(value.slots) && validatePanelPolicy({ ...signed, slots: value.slots }).valid) sign(value, { ...signed, slots: value.slots });
  return value;
}

/** A panel whose policy skips requirement extraction: no requirements report, so findings cite no requirement. */
function withoutRequirements(report: PanelReport, requirementsSlot: string | null = null): void {
  delete report.requirementsReport;
  report.contextManifestDigest = context.digest;
  for (const item of report.findings) item.requirementIds = [];
  sign(report, { ...policies.get(report.panelPolicyDigest)!, requirementsSlot });
}

/** One negative fixture per validation code; each must produce exactly that code. */
const negatives: Array<[string, (value: PanelReport) => void]> = [
  ["REVIEWFN_PANEL_SCHEMA", value => { (value as { kind: string }).kind = "reviewfn-report"; }],
  ["REVIEWFN_PANEL_SLOT_DUPLICATE", value => { value.slotRuns[1].terminal = "completed"; }],
  ["REVIEWFN_PANEL_SLOT_UNKNOWN", value => { value.slotRuns.push({ ...structuredClone(value.slotRuns[3]), slotId: "ghost" }); }],
  ["REVIEWFN_PANEL_FINDING_INVALID", value => { (value.findings[2] as { severity: string }).severity = "info"; }],
  ["REVIEWFN_PANEL_ORIGIN_UNKNOWN", value => { value.findings[0].origins.push({ slotId: "lens-c", lens: "general" }); }],
  ["REVIEWFN_PANEL_VERIFICATION_INVALID", value => { value.slotRuns[3].identity.model = "gpt-6.1-sol"; value.slots[3].inference.model = "gpt-6.1-sol"; }],
  ["REVIEWFN_PANEL_DISPOSITION_INVALID", value => { value.findings[1].verification!.verdict = "inconclusive"; }],
  ["REVIEWFN_PANEL_VERDICT_MISMATCH", value => { value.verdict = "ready"; }],
];

describe("panel report v1", () => {
  it("validates the panel fixture and its JSON round trip", async () => {
    for (const value of [panelReport(), JSON.parse(JSON.stringify(panelReport()))]) {
      const result = await validatePanelReport(value, policy, options);
      expect(result.issues).toEqual([]);
      expect(result).toMatchObject({ valid: true, verdict: "changes_requested" });
      expect(ajvValid("panelReport", value)).toBe(true);
    }
  });

  it("covers every validation code with a negative fixture", () => {
    expect(negatives.map(([code]) => code).sort()).toEqual([...PANEL_VALIDATION_CODES].sort());
  });

  it.each(negatives)("returns exactly %s for its negative fixture", async (code, change) => {
    const value = mutate(panelReport(), change);
    expect(codes((await validatePanelReport(value, policy, options)).issues)).toEqual([code]);
  });

  it("reports 0.1 errors of the embedded requirements report", async () => {
    const value = mutate(panelReport(), report => { report.requirementsReport!.assessments = []; report.requirementsReport!.verdict = "changes_requested"; });
    const result = await validatePanelReport(value, policy, options);
    expect(codes(result.issues)).toEqual(["REVIEWFN_REPORT_INVALID"]);
    expect(result.issues.map(issue => issue.message)).toContain("Requirement R1 has 0 assessments; expected exactly one.");
    expect(result.issues.every(issue => issue.path === "/requirementsReport")).toBe(true);
  });

  it("rejects a requirements report for a different change", async () => {
    const value = mutate(panelReport(), report => { report.change.diffDigest = "f".repeat(64); });
    expect((await validatePanelReport(value, policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_REPORT_INVALID", path: "/requirementsReport/change" })]);
  });

  it("collapses identities only within a stage", async () => {
    // A stage-2 slot may share the stage-1 identity: it counts for its own stage's quorum.
    const value = mutate(panelReport(), report => {
      report.slots[2] = { ...report.slots[2], harness: { adapter: "codex", version: "0.154.0" }, inference: { provider: "openai", model: "gpt-6.1-sol", auth: "chatgpt" } };
      report.slotRuns[2] = { ...report.slotRuns[0], slotId: "lens-c", outputArtifact: undefined, outputDigest: undefined, usage: undefined };
    });
    expect((await validatePanelReport(value, policy, options)).issues).toEqual([]);
    const orphan = mutate(panelReport(), report => { report.slotRuns[0].identity.credentialFingerprint = credentialFingerprint("account-2"); });
    expect((await validatePanelReport(orphan, policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_SLOT_DUPLICATE", path: "/slotRuns/1/terminal" })]);
  });

  it("requires a model mismatch to void the run", async () => {
    const unvoided = mutate(panelReport(), report => { report.slotRuns[2].terminal = "completed"; report.slotRuns[2].voidReasons = []; });
    expect((await validatePanelReport(unvoided, policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_SCHEMA", path: "/slotRuns/2/terminal" })]);
    const configured = mutate(panelReport(), report => { report.slots[2].inference.model = "configured"; report.slotRuns[2].voidReasons = ["workspace_mutated"]; });
    expect((await validatePanelReport(configured, policy, options)).issues).toEqual([]);
  });

  it("derives the verdict from reported findings only", async () => {
    // A critical finding that was dropped or suppressed stays in the report but does not request changes.
    const value = mutate(panelReport(), report => {
      report.findings[0] = { ...report.findings[0], severity: "low" };
      report.findings[1].severity = "critical";
      report.findings[2].severity = "critical";
      report.verdict = "ready";
    });
    expect(derivePanelVerdict(value, policy)).toBe("ready");
    expect(await validatePanelReport(value, policy, options)).toMatchObject({ valid: true, verdict: "ready" });
    expect(value.findings.map(item => item.disposition)).toEqual(["reported", "dropped", "suppressed"]);
  });

  it("caps a panel without a requirements report at needs_verification", async () => {
    const value = mutate(panelReport(), report => {
      withoutRequirements(report);
      report.findings[0].severity = "low";
      report.verdict = "needs_verification";
    });
    expect(await validatePanelReport(value, policy, options)).toMatchObject({ valid: true, verdict: "needs_verification" });
  });

  it("has no verdict when the requirements run did not complete", async () => {
    // The requirements slot lens-a failed and recorded that in its report; lens-b, of the same identity, counts instead.
    const failed = (terminal: SlotRun["terminal"]) => mutate(panelReport(), report => {
      report.slotRuns[0].terminal = terminal;
      report.slotRuns[1].terminal = terminal === "completed" ? "collapsed" : "completed";
      for (const item of report.findings) item.origins = [{ slotId: "lens-b", lens: "security" }];
      report.requirementsReport!.execution = "failed"; delete report.requirementsReport!.verdict; delete report.verdict;
    });
    expect(await validatePanelReport(failed("failed"), policy, options)).toMatchObject({ valid: true, verdict: undefined });
    expect(codes((await validatePanelReport({ ...failed("failed"), verdict: "changes_requested" }, policy, options)).issues)).toEqual(["REVIEWFN_PANEL_VERDICT_MISMATCH"]);
    // A run that succeeded cannot carry a report whose execution failed.
    expect((await validatePanelReport(failed("completed"), policy, options)).issues.map(issue => `${issue.code} ${issue.path}`)).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport/execution"]);
  });

  it("rejects dropped or suppressed findings without their justification", () => {
    const base = panelReport().findings;
    expect(validatePanelFinding(base[1]).valid).toBe(true);
    expect(codes(validatePanelFinding({ ...base[1], verification: undefined }).issues)).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID"]);
    expect(codes(validatePanelFinding({ ...base[2], suppressionReference: undefined }).issues)).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID"]);
    expect(codes(validatePanelFinding({ ...base[2], dispositionReason: undefined }).issues)).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID"]);
    expect(codes(validatePanelFinding({ ...base[0], lifecycle: "still_valid" }).issues)).toEqual(["REVIEWFN_PANEL_FINDING_INVALID"]);
    expect(codes(validatePanelFinding({ ...base[0], origins: [] }).issues)).toEqual(["REVIEWFN_PANEL_SCHEMA"]);
  });

  it("requires independent, completed verifier slots with evidence", async () => {
    const lensVerifier = mutate(panelReport(), report => { report.findings[0].verification!.slotId = "lens-a"; });
    expect(codes((await validatePanelReport(lensVerifier, policy, options)).issues)).toEqual(["REVIEWFN_PANEL_VERIFICATION_INVALID"]);
    const unknown = mutate(panelReport(), report => { report.findings[0].verification!.slotId = "ghost"; });
    expect(codes((await validatePanelReport(unknown, policy, options)).issues)).toEqual(["REVIEWFN_PANEL_SLOT_UNKNOWN"]);
    const unsupported = mutate(panelReport(), report => { report.findings[0].verification!.evidenceIds = []; });
    expect(codes((await validatePanelReport(unsupported, policy, options)).issues)).toEqual(["REVIEWFN_PANEL_VERIFICATION_INVALID"]);
  });

  it("checks finding references, duplicates and clusters", async () => {
    const cases: Array<(report: PanelReport) => void> = [
      report => { report.findings[0].evidenceIds = ["missing"]; },
      report => { report.findings[2].fingerprint = "f-confirmed"; report.clusters = []; },
      report => { report.findings[0].requirementIds = ["R9"]; },
      report => { report.clusters[1].findingFingerprints.push("f-confirmed"); },
      report => { report.clusters[1].findingFingerprints = ["f-missing"]; },
      report => { report.findings[0].basis = "reproduced"; },
    ];
    for (const change of cases) expect(codes((await validatePanelReport(mutate(panelReport(), change), policy, options)).issues)).toEqual(["REVIEWFN_PANEL_FINDING_INVALID"]);
  });

  it("checks panel anchors against the reviewed head or merge base when source control is supplied", async () => {
    const stale = mutate(panelReport(), report => { report.evidence[0].code!.commit = "c".repeat(40); });
    expect((await validatePanelReport(stale, policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_FINDING_INVALID", path: "/evidence/0/code" })]);
  });
});

/** The fixture without a requirements report; it records the frozen context digest itself. */
function panelOnly(change: (report: PanelReport) => void = () => {}): PanelReport {
  return mutate(panelReport(), report => {
    withoutRequirements(report);
    report.findings[0].severity = "low";
    report.verdict = "needs_verification";
    change(report);
  });
}
const run = (report: PanelReport, slotId: string): SlotRun => report.slotRuns.find(item => item.slotId === slotId)!;

describe("slot run collapse and model mismatch", () => {
  // lens-a and lens-b are stage-1 slots with the same identity, lens-a first in policy order.
  const pair = (first: SlotRun["terminal"], second: SlotRun["terminal"]) => mutate(panelReport(), report => {
    for (const [slotId, terminal] of [["lens-a", first], ["lens-b", second]] as const) {
      Object.assign(run(report, slotId), { terminal, voidReasons: terminal === "void" ? ["workspace_mutated"] : [] });
    }
    // Findings name the counted slot as their origin; without one, no lens reported anything.
    const origin = first === "completed" ? { slotId: "lens-a", lens: "general" } : { slotId: "lens-b", lens: "security" };
    for (const item of report.findings) item.origins = [origin];
    if (first !== "completed" && second !== "completed") Object.assign(report, { findings: [], clusters: [] });
    // lens-a is the requirements slot: a run of it that did not succeed produced no requirements report.
    if (first !== "completed" && first !== "collapsed") withoutRequirements(report, "lens-a");
    report.verdict = derivePanelVerdict(report, policy);
  });
  const slotIssues = async (report: PanelReport) => (await validatePanelReport(report, policy, options)).issues.map(issue => `${issue.code} ${issue.path}`);

  it.each([
    ["failed", "completed"], ["void", "completed"], ["quota_exhausted", "completed"], ["timed_out", "completed"], ["malformed", "completed"], ["canceled", "completed"],
    ["completed", "failed"], ["completed", "void"], ["completed", "collapsed"],
  ] as const)("counts the first completed run of an identity: %s then %s is valid", async (first, second) => {
    expect(await slotIssues(pair(first, second))).toEqual([]);
  });

  it.each([
    ["completed", "completed", "/slotRuns/1/terminal"],
    ["void", "collapsed", "/slotRuns/1/terminal"],
    ["failed", "collapsed", "/slotRuns/1/terminal"],
    ["collapsed", "completed", "/slotRuns/0/terminal"],
  ] as const)("rejects %s then %s as a duplicate identity", async (first, second, path) => {
    expect(await slotIssues(pair(first, second))).toEqual([`REVIEWFN_PANEL_SLOT_DUPLICATE ${path}`]);
  });

  it.each(["completed", "failed", "canceled", "quota_exhausted", "timed_out", "malformed", "collapsed"] as const)("requires a mismatched model to void a %s run", async terminal => {
    const value = mutate(panelReport(), report => { Object.assign(run(report, "lens-c"), { terminal, voidReasons: [] }); });
    expect(await slotIssues(value)).toEqual(expect.arrayContaining(["REVIEWFN_PANEL_SCHEMA /slotRuns/2/terminal"]));
    expect(codes((await validatePanelReport(value, policy, options)).issues)).not.toContain("REVIEWFN_PANEL_FINDING_INVALID");
  });

  it("requires model_mismatch among a mismatched void run's reasons, and only then", async () => {
    const without = mutate(panelReport(), report => { run(report, "lens-c").voidReasons = ["workspace_mutated"]; });
    expect(await slotIssues(without)).toEqual(["REVIEWFN_PANEL_SCHEMA /slotRuns/2/voidReasons"]);
    const both = mutate(panelReport(), report => { run(report, "lens-c").voidReasons = ["model_mismatch", "workspace_mutated"]; });
    expect(await slotIssues(both)).toEqual([]);
    const spurious = mutate(panelReport(), report => { Object.assign(run(report, "lens-a"), { terminal: "void", voidReasons: ["model_mismatch"] }); run(report, "lens-b").terminal = "completed"; for (const item of report.findings) item.origins = [{ slotId: "lens-b", lens: "security" }]; withoutRequirements(report, "lens-a"); report.verdict = derivePanelVerdict(report, policy); });
    expect(await slotIssues(spurious)).toEqual(["REVIEWFN_PANEL_SCHEMA /slotRuns/0/voidReasons"]);
  });

  it("keeps the provenance of a collapsed lens: collapse affects quorum only", async () => {
    const collapsedOnly = mutate(panelReport(), report => { report.findings[0].origins = [{ slotId: "lens-b", lens: "security" }]; });
    expect(await slotIssues(collapsedOnly)).toEqual([]);
    const shared = mutate(panelReport(), report => { report.findings[0].origins = [{ slotId: "lens-a", lens: "general" }, { slotId: "lens-b", lens: "security" }]; });
    expect(await slotIssues(shared)).toEqual([]);
    const wrongLens = mutate(panelReport(), report => { report.findings[0].origins = [{ slotId: "lens-b", lens: "general" }]; });
    expect(await slotIssues(wrongLens)).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /findings/0/origins/0"]);
    // The verifier must still be independent of a collapsed origin's identity.
    const dependent = mutate(collapsedOnly, report => { report.slots[3].inference.model = "gpt-6.1-sol"; run(report, "verifier").identity.model = "gpt-6.1-sol"; });
    // findings[1] keeps its lens-a origin, which has the same identity.
    expect(await slotIssues(dependent)).toEqual(["REVIEWFN_PANEL_VERIFICATION_INVALID /findings/0/verification/slotId", "REVIEWFN_PANEL_VERIFICATION_INVALID /findings/1/verification/slotId"]);
  });

  it.each(["failed", "canceled", "quota_exhausted", "timed_out", "malformed", "void"] as const)("rejects an origin whose run ended %s", async terminal => {
    const value = mutate(pair("completed", terminal), report => { report.findings[0].origins = [{ slotId: "lens-b", lens: "security" }]; });
    expect(await slotIssues(value)).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /findings/0/origins/0"]);
  });

  it("records a harness version drift truthfully but never lets it count, so a version cannot escape collapse", async () => {
    const direct = mutate(panelReport(), report => { run(report, "verifier").identity.harnessVersion = "0.155.0"; });
    expect(await slotIssues(direct)).toEqual(["REVIEWFN_PANEL_SCHEMA /slotRuns/3/identity/harnessVersion"]);
    const drifted = (terminal: SlotRun["terminal"]) => mutate(panelReport(), report => { Object.assign(run(report, "lens-b"), { terminal, voidReasons: terminal === "void" ? ["workspace_mutated"] : [], identity: { ...run(report, "lens-b").identity, harnessVersion: "9.9.9" } }); });
    expect(await slotIssues(drifted("completed"))).toEqual(["REVIEWFN_PANEL_SCHEMA /slotRuns/1/identity/harnessVersion"]);
    expect(await slotIssues(drifted("collapsed"))).toEqual(["REVIEWFN_PANEL_SCHEMA /slotRuns/1/identity/harnessVersion", "REVIEWFN_PANEL_SLOT_DUPLICATE /slotRuns/1/terminal"]);
    for (const terminal of ["failed", "canceled", "quota_exhausted", "timed_out", "malformed", "void"] as const) expect(await slotIssues(drifted(terminal))).toEqual([]);
  });

  it("keeps the verifications of a collapsed verifier, which must still be independent", async () => {
    const twoVerifiers = (change: (report: PanelReport) => void = () => {}) => mutate(panelReport(), report => {
      report.slots.push({ ...structuredClone(report.slots[3]), id: "verifier-b" });
      report.slotRuns.push({ ...structuredClone(run(report, "verifier")), slotId: "verifier-b", terminal: "collapsed" });
      report.findings[0].verification!.slotId = "verifier-b";
      change(report);
    });
    expect(await slotIssues(twoVerifiers())).toEqual([]);
    expect(await slotIssues(twoVerifiers(report => { run(report, "verifier-b").terminal = "completed"; }))).toEqual(["REVIEWFN_PANEL_SLOT_DUPLICATE /slotRuns/4/terminal"]);
    expect(await slotIssues(twoVerifiers(report => { Object.assign(run(report, "verifier-b"), { terminal: "failed" }); }))).toEqual(["REVIEWFN_PANEL_VERIFICATION_INVALID /findings/0/verification/slotId"]);
    const dependent = twoVerifiers(report => {
      for (const slot of report.slots.filter(item => item.stage === "verifier")) slot.inference.model = "gpt-6.1-sol";
      for (const slotId of ["verifier", "verifier-b"]) run(report, slotId).identity.model = "gpt-6.1-sol";
      report.findings[1].verification!.slotId = "verifier-b";
    });
    expect(await slotIssues(dependent)).toEqual(["REVIEWFN_PANEL_VERIFICATION_INVALID /findings/0/verification/slotId", "REVIEWFN_PANEL_VERIFICATION_INVALID /findings/1/verification/slotId"]);
  });

  it("encodes two slots that resolve the same wrong model as two void runs, with no requirements report", async () => {
    const value = mutate(panelReport(), report => {
      for (const slotId of ["lens-a", "lens-b"]) Object.assign(run(report, slotId), { identity: { ...run(report, slotId).identity, model: "gpt-6-mini" }, terminal: "void", voidReasons: ["model_mismatch"] });
      report.findings = []; report.clusters = [];
      withoutRequirements(report, "lens-a");
      report.verdict = "needs_verification";
    });
    expect(await slotIssues(value)).toEqual([]);
    // A void requirements slot cannot supply the requirements report that would make the panel ready.
    const voidProducer = mutate(value, report => { report.requirementsReport = requirementsReport(); delete report.contextManifestDigest; report.verdict = "ready"; });
    expect(await slotIssues(voidProducer)).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport/execution"]);
  });

  it("binds the requirements report's execution to its requirements slot's run", async () => {
    const producedBy = (terminal: SlotRun["terminal"] | "missing", requirementsSlot: string | null = "lens-a", execution: "completed" | "failed" = "completed") => mutate(panelReport(), report => {
      // lens-b runs first in this variant, so lens-a may be completed, collapsed or end any other way.
      for (const item of report.findings) item.origins = [{ slotId: "lens-b", lens: "security" }];
      run(report, "lens-b").terminal = "completed";
      if (terminal === "missing") report.slotRuns = report.slotRuns.filter(item => item.slotId !== "lens-a");
      else Object.assign(run(report, "lens-a"), { terminal, voidReasons: terminal === "void" ? ["workspace_mutated"] : [] });
      [report.slots[0], report.slots[1]] = [report.slots[1], report.slots[0]];
      sign(report, { ...panelPolicy, slots: report.slots, requirementsSlot });
      if (execution !== "completed") { report.requirementsReport!.execution = execution; delete report.requirementsReport!.verdict; }
      report.verdict = derivePanelVerdict(report, policy);
    });
    expect(await slotIssues(producedBy("collapsed"))).toEqual([]);
    expect(await slotIssues(producedBy("collapsed", "lens-a", "failed"))).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport/execution"]);
    for (const terminal of ["failed", "canceled", "quota_exhausted", "timed_out", "malformed", "void"] as const) {
      // A run that did not succeed cannot supply a completed requirements report, but may record its failure.
      expect(await slotIssues(producedBy(terminal))).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport/execution"]);
      expect(await slotIssues(producedBy(terminal, "lens-a", "failed"))).toEqual([]);
    }
    expect(await slotIssues(producedBy("missing"))).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport"]);
    // The report must record the requirements slot's harness adapter and configured inference, and for a run that
    // succeeded the pinned harness version; a failed run may record the version it could observe.
    const configured = (terminal: SlotRun["terminal"], change: (configuration: ReviewReport["configuration"]) => void) => mutate(producedBy(terminal, "lens-a", terminal === "collapsed" ? "completed" : "failed"), report => change(report.requirementsReport!.configuration));
    for (const change of [
      (item: ReviewReport["configuration"]) => { item.harness.id = "claude-code"; },
      (item: ReviewReport["configuration"]) => { item.harness.version = "0.155.0"; },
      (item: ReviewReport["configuration"]) => { item.inference.provider = "anthropic"; },
      (item: ReviewReport["configuration"]) => { item.inference.model = "gpt-6-mini"; },
      (item: ReviewReport["configuration"]) => { item.inference.auth = "api-key"; },
    ]) expect(await slotIssues(configured("collapsed", change))).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport/configuration"]);
    expect(await slotIssues(configured("failed", item => { item.harness.version = "unknown"; }))).toEqual([]);
    expect(await slotIssues(configured("failed", item => { item.inference.model = "gpt-6-mini"; }))).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport/configuration"]);
    // The configured-model sentinel is compared as configured.
    const sentinel = mutate(panelReport(), report => { report.slots[0].inference.model = "configured"; report.requirementsReport!.configuration.inference.model = "configured"; });
    expect(await slotIssues(sentinel)).toEqual([]);
    expect(await slotIssues(mutate(sentinel, report => { report.requirementsReport!.configuration.inference.model = "gpt-6.1-sol"; }))).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport/configuration"]);
    expect(await slotIssues(producedBy("collapsed", null))).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport"]);
    // A succeeded requirements slot whose report is missing is reported too, so nothing disappears silently.
    const lost = mutate(panelReport(), report => { delete report.requirementsReport; report.contextManifestDigest = context.digest; for (const item of report.findings) item.requirementIds = []; report.verdict = derivePanelVerdict(report, policy); });
    expect(await slotIssues(lost)).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport"]);
  });

  it("binds the requirements report through the panel policy the report records, and fails closed without it", async () => {
    const issuesWith = async (value: PanelReport, panelPolicyOption: PanelPolicy | undefined) => (await validateWithOptions(value, policy, { ...options, panelPolicy: panelPolicyOption })).issues.map(issue => `${issue.code} ${issue.path}`);
    expect(await issuesWith(panelReport(), panelPolicy)).toEqual([]);
    expect(await issuesWith(panelReport(), undefined)).toEqual(["REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport"]);
    // A panel without a requirements report needs no panel policy.
    expect(await issuesWith(panelOnly(), undefined)).toEqual([]);
    expect(await issuesWith(panelReport(), { ...panelPolicy, maxConcurrentSlots: 3 })).toEqual(["REVIEWFN_PANEL_SCHEMA /panelPolicyDigest", "REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport"]);
    expect(await issuesWith(panelReport(), { ...panelPolicy, maxConcurrentSlots: 9 })).toEqual(["REVIEWFN_PANEL_SCHEMA /panelPolicyDigest", "REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport"]);
    // The slots differ from the policy's while the digest is still the policy's (mutate would re-sign the copy).
    const reslotted = panelReport();
    reslotted.slots[0].lens = "correctness";
    for (const item of reslotted.findings) item.origins = [{ slotId: "lens-a", lens: "correctness" }];
    expect(await issuesWith(reslotted, panelPolicy)).toEqual(["REVIEWFN_PANEL_SCHEMA /slots", "REVIEWFN_PANEL_ORIGIN_UNKNOWN /requirementsReport"]);
  });

  it("rejects timestamps that are not real UTC times, which Ajv's pattern also rejects when out of range", async () => {
    for (const time of ["2026-99-99T99:99:99Z", "2026-01-01T24:00:00Z"]) {
      const value = mutate(panelReport(), report => { report.slotRuns[0].startedAt = time; });
      expect(ajvValid("panelReport", value)).toBe(false);
      expect(codes((await validatePanelReport(value, policy, options)).issues)).toEqual(["REVIEWFN_PANEL_SCHEMA"]);
    }
    const leap = mutate(panelReport(), report => { report.slotRuns[0].finishedAt = "2026-02-30T00:00:00Z"; report.createdAt = "2026-02-29T00:00:00Z"; });
    expect(ajvValid("panelReport", leap)).toBe(true);
    expect((await validatePanelReport(leap, policy, options)).issues.map(issue => `${issue.code} ${issue.path}`)).toEqual(["REVIEWFN_PANEL_SCHEMA /createdAt", "REVIEWFN_PANEL_SCHEMA /slotRuns/0/finishedAt"]);
    expect((await validatePanelReport(mutate(panelReport(), report => { report.createdAt = "2028-02-29T00:00:00.123456789Z"; }), policy, options)).valid).toBe(true);
  });
});

describe("panel claims are verified like 0.1 claims", () => {
  const critical = (change: (report: PanelReport) => void) => mutate(panelReport(), report => { report.findings[2].severity = "critical"; change(report); });

  it("verifies suppression references as waivers against the frozen context", async () => {
    const result = (value: PanelReport, extra = {}) => validatePanelReport(value, policy, { ...options, ...extra });
    const fabricated = critical(report => { report.findings[2].suppressionReference = { sourceId: "nonexistent", anchor: "L1" }; });
    expect((await result(fabricated)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_DISPOSITION_INVALID", path: "/findings/2/suppressionReference" })]);
    const outOfRange = critical(report => { report.findings[2].suppressionReference = { sourceId: "issue:1", anchor: "L9" }; });
    expect(codes((await result(outOfRange)).issues)).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID"]);
    const unauthorized = await validatePanelReport(critical(() => {}), { ...policy, sourceAuthority: { ...policy.sourceAuthority, waiverAuthorities: [] } }, options);
    expect(codes(unauthorized.issues)).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID"]);
    // Without a context, or with a context the report did not record, nothing can be verified: fail closed.
    expect(codes((await validatePanelReport(panelOnly(), policy, { ...options, context: undefined })).issues)).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID"]);
    expect(codes((await validatePanelReport(panelOnly(), policy, { ...options, context: { ...context, digest: "f".repeat(64) } })).issues)).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID"]);
    expect(codes((await validatePanelReport(panelOnly(report => { delete report.contextManifestDigest; }), policy, options)).issues)).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID"]);
    expect((await validatePanelReport(panelOnly(), policy, options)).valid).toBe(true);
  });

  it("rejects a panel context digest that differs from the requirements report's", async () => {
    const value = mutate(panelReport(), report => { report.contextManifestDigest = "f".repeat(64); });
    // The supplied context matches neither digest, so the suppression reference fails closed as well.
    expect((await validatePanelReport(value, policy, options)).issues.map(issue => `${issue.code} ${issue.path}`).sort()).toEqual(["REVIEWFN_PANEL_DISPOSITION_INVALID /findings/2/suppressionReference", "REVIEWFN_REPORT_INVALID /requirementsReport/contextManifestDigest"]);
    expect((await validatePanelReport(mutate(panelReport(), report => { report.contextManifestDigest = context.digest; }), policy, options)).valid).toBe(true);
  });

  it("requires a reproduced finding's gate receipt logs to verify through the artifact store", async () => {
    const store = new MemoryStore();
    const stdout = await store.put("test-stdout", "FAIL empty input");
    const stderr = await store.put("test-stderr", "");
    const reproduced = (change: (report: PanelReport) => void = () => {}) => mutate(panelReport(), report => {
      report.gateReceipts = [{ id: "T1", command: ["npm", "test"], cwd: ".", commit: head, startedAt: "s", finishedAt: "f", runtimeMs: 1, exitCode: 1, signal: null, timedOut: false, canceled: false, stdoutArtifact: stdout.id, stderrArtifact: stderr.id, stdoutDigest: stdout.digest, stderrDigest: stderr.digest, limitations: [] }];
      report.evidence.push({ id: "T-E1", kind: "test", description: "the failing gate", receiptId: "T1" });
      Object.assign(report.findings[0], { basis: "reproduced", evidenceIds: ["E1", "T-E1"] });
      change(report);
    });
    expect((await validatePanelReport(reproduced(), policy, { ...options, artifacts: store })).issues).toEqual([]);
    expect((await validatePanelReport(reproduced(), policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_FINDING_INVALID", path: "/findings/0/basis" })]);
    const tampered = reproduced(report => { report.gateReceipts[0].stdoutDigest = "0".repeat(64); });
    expect((await validatePanelReport(tampered, policy, { ...options, artifacts: store })).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_FINDING_INVALID", path: "/findings/0/basis" })]);
    const stale = reproduced(report => { report.gateReceipts[0].commit = mergeBase; });
    expect(codes((await validatePanelReport(stale, policy, { ...options, artifacts: store })).issues)).toEqual(["REVIEWFN_PANEL_FINDING_INVALID"]);
  });

  it("fails closed on code anchors without source control, and still checks their commit", async () => {
    const result = await validatePanelReport(panelReport(), policy, { context });
    expect(codes(result.issues)).toEqual(["REVIEWFN_PANEL_FINDING_INVALID", "REVIEWFN_REPORT_INVALID"]);
    expect(result.issues.filter(issue => issue.code === "REVIEWFN_PANEL_FINDING_INVALID").map(issue => issue.path)).toEqual(["/evidence/0/code", "/evidence/1/code", "/evidence/2/code", "/findings/0/anchor", "/findings/1/anchor", "/findings/2/anchor"]);
    const stale = mutate(panelReport(), report => { report.evidence[0].code!.commit = "c".repeat(40); });
    expect((await validatePanelReport(stale, policy, { context })).issues.find(issue => issue.path === "/evidence/0/code")?.message).toMatch(/does not reference the reviewed head/);
  });

  it("applies the 0.1 anchor commit rule to finding anchors and evidence", async () => {
    // src/gone.ts is absent at head; every other path exists there.
    const absent = (paths: string[]) => ({ ...options, sourceControl: { ...sourceControl, pathExists: async (_root: string, _commit: string, path: string) => !paths.includes(path) } });
    const anchoredAt = (commit: string, path: string) => (report: PanelReport) => { report.evidence[0].code = { commit, path, startLine: 1 }; report.findings[0].anchor = { commit, path, startLine: 1 }; };
    const anchorIssuePaths = async (value: PanelReport, opts: Parameters<typeof validatePanelReport>[2]) => (await validatePanelReport(value, policy, opts)).issues.filter(issue => issue.code === "REVIEWFN_PANEL_FINDING_INVALID").map(issue => issue.path);
    // Merge base on an unchanged path: rejected for both the finding and its evidence, as 0.1 rejects it.
    const unchanged = mutate(panelReport(), anchoredAt(mergeBase, "src/other.ts"));
    expect(await anchorIssuePaths(unchanged, absent(["src/other.ts"]))).toEqual(["/evidence/0/code", "/findings/0/anchor"]);
    const legacy = requirementsReport();
    legacy.evidence[0].code = { commit: mergeBase, path: "src/other.ts", startLine: 1 };
    expect((await validateReport(legacy, policy, absent(["src/other.ts"]).sourceControl, ".", context)).errors).toContain(`Evidence E1 does not reference reviewed head ${head}.`);
    // Merge base on a changed path: accepted only once the path is verified absent at head.
    const deleted = mutate(panelReport(), anchoredAt(mergeBase, "src/value.ts"));
    expect((await validatePanelReport(deleted, policy, absent(["src/value.ts"]))).issues).toEqual([]);
    expect(await anchorIssuePaths(deleted, absent([]))).toEqual(["/evidence/0/code", "/findings/0/anchor"]);
    expect(await anchorIssuePaths(deleted, options)).toEqual(["/evidence/0/code", "/findings/0/anchor"]);

    // A since anchor: accepted only for a path the verified delta removed that is absent at head.
    const since = "c".repeat(40);
    const store = new MemoryStore();
    const hunks = await store.put("change-hunks", serializeChangeHunks({ version: 1, baseCommit: mergeBase, headCommit: head, files: [{ path: "src/value.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }] }));
    const deltaHunks = await store.put("change-hunks", serializeChangeHunks({ version: 1, baseCommit: since, headCommit: head, files: [{ path: "src/gone.ts", status: "deleted", hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 }] }] }));
    const incremental = (change: (report: PanelReport) => void) => panelOnly(report => { report.changeDetail = { hunksArtifact: hunks.id, hunksDigest: hunks.digest, since, deltaHunksArtifact: deltaHunks.id, deltaHunksDigest: deltaHunks.digest, deltaPaths: ["src/gone.ts"] }; change(report); });
    const removed = incremental(anchoredAt(since, "src/gone.ts"));
    expect((await validatePanelReport(removed, policy, { ...absent(["src/gone.ts"]), artifacts: store })).issues).toEqual([]);
    expect(await anchorIssuePaths(removed, { ...absent([]), artifacts: store })).toEqual(["/evidence/0/code", "/findings/0/anchor"]);
    // Without the verified delta (no artifact store), the since commit is not allowed.
    expect(await anchorIssuePaths(removed, absent(["src/gone.ts"]))).toEqual(["/evidence/0/code", "/findings/0/anchor"]);
    // A since anchor on a path the delta did not remove is rejected.
    expect(await anchorIssuePaths(incremental(anchoredAt(since, "src/value.ts")), { ...absent(["src/value.ts"]), artifacts: store })).toEqual(["/evidence/0/code", "/findings/0/anchor"]);
  });

  it("returns issues for an empty root without calling source control", async () => {
    const calls: string[] = [];
    const recording = { ...sourceControl, pathExists: async (root: string) => { calls.push(`pathExists ${root}`); if (!root) throw new Error("empty root"); return false; }, verifyAnchor: async (root: string) => { calls.push(`verifyAnchor ${root}`); return true; } };
    const deleted = mutate(panelReport(), report => { report.evidence[0].code = { commit: mergeBase, path: "src/value.ts", startLine: 1 }; report.findings[0].anchor = { commit: mergeBase, path: "src/value.ts", startLine: 1 }; });
    const result = await validatePanelReport(deleted, policy, { ...options, sourceControl: recording, root: "" });
    expect(calls).toEqual([]);
    expect(result.issues.filter(issue => issue.code === "REVIEWFN_PANEL_FINDING_INVALID").map(issue => issue.path)).toEqual(["/evidence/0/code", "/evidence/1/code", "/evidence/2/code", "/findings/0/anchor", "/findings/1/anchor", "/findings/2/anchor"]);
  });

  it("rejects anchors that source control does not confirm", async () => {
    const rejecting = { ...options, sourceControl: { ...sourceControl, verifyAnchor: async (_root: string, anchor: { startLine?: number }) => anchor.startLine !== 7 } };
    const moved = mutate(panelReport(), report => { report.evidence[0].code!.startLine = 7; report.findings[1].anchor!.startLine = 7; });
    expect((await validatePanelReport(moved, policy, rejecting)).issues.map(issue => `${issue.code} ${issue.path}`)).toEqual(["REVIEWFN_PANEL_FINDING_INVALID /evidence/0/code", "REVIEWFN_PANEL_FINDING_INVALID /findings/1/anchor"]);
  });

  it("bounds the panel findings, reported, dropped and suppressed alike, by maxFindings", async () => {
    const limited = (maxFindings: number) => ({ ...policy, limits: { ...policy.limits, maxFindings } });
    for (const value of [panelReport(), panelOnly()]) {
      expect(value.findings).toHaveLength(3);
      expect((await validatePanelReport(value, limited(3), options)).issues).toEqual([]);
      expect((await validatePanelReport(value, limited(2), options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_FINDING_INVALID", path: "/findings" })]);
    }
  });

  it("allows merge-base anchors only for on-base verification evidence", async () => {
    const onBase = { id: "B1", kind: "code" as const, description: "the base has no such loop", code: { commit: mergeBase, path: "src/other.ts", startLine: 1 } };
    const cited = (change: (report: PanelReport) => void = () => {}) => mutate(panelReport(), report => { report.evidence.push(onBase); report.findings[0].verification!.evidenceIds.push("B1"); change(report); });
    expect((await validatePanelReport(cited(), policy, options)).issues).toEqual([]);
    expect((await validatePanelReport(cited(), policy, { context })).issues.find(issue => issue.path === "/evidence/3/code")?.message).toMatch(/cannot be verified without source control/);
    const rejected = [expect.objectContaining({ code: "REVIEWFN_PANEL_FINDING_INVALID", path: "/evidence/3/code" })];
    // Also cited by a finding: it is implementation evidence and must follow the head rule.
    expect((await validatePanelReport(cited(report => { report.findings[0].evidenceIds.push("B1"); }), policy, options)).issues).toEqual(rejected);
    // Cited by a verification that did not check the base.
    expect((await validatePanelReport(cited(report => { report.findings[0].verification!.onBase = "not_checked"; }), policy, options)).issues).toEqual(rejected);
    expect((await validatePanelReport(cited(report => { report.findings[1].verification!.evidenceIds.push("B1"); }), policy, options)).issues).toEqual(rejected);
    // The allowance names the merge base only.
    expect((await validatePanelReport(cited(report => { report.evidence[3].code!.commit = "c".repeat(40); }), policy, options)).issues).toEqual(rejected);
  });

  it("reports root-level issues at the empty JSON Pointer", async () => {
    expect((await validatePanelReport(null, policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_SCHEMA", path: "" })]);
    expect(validatePanelPolicy([]).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_SCHEMA", path: "" })]);
  });

  it("verifies source, diff and artifact evidence", async () => {
    const withEvidence = (item: PanelReport["evidence"][number], change: (report: PanelReport) => void = () => {}) => mutate(panelReport(), report => { report.evidence.push(item); report.findings[0].verification!.evidenceIds.push(item.id); change(report); });
    const sourced = { id: "S1", kind: "source" as const, description: "the issue", source: { sourceId: "issue:1", excerpt: "Return the value", anchor: "L1" } };
    expect((await validatePanelReport(withEvidence(sourced), policy, options)).issues).toEqual([]);
    expect((await validatePanelReport(withEvidence({ ...sourced, source: { sourceId: "issue:1", anchor: "intro" } }), policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_FINDING_INVALID", path: "/evidence/3/source" })]);
    expect(codes((await validatePanelReport(withEvidence({ ...sourced, source: undefined }), policy, options)).issues)).toEqual(["REVIEWFN_PANEL_FINDING_INVALID"]);
    const diff = { id: "D1", kind: "diff" as const, description: "the change", code: { commit: head, path: "src/value.ts", startLine: 1 } };
    expect((await validatePanelReport(withEvidence(diff), policy, options)).issues).toEqual([]);
    expect((await validatePanelReport(withEvidence({ ...diff, code: { ...diff.code, path: "src/other.ts" } }), policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_FINDING_INVALID", path: "/evidence/3/code" })]);
    const store = new MemoryStore();
    const output = await store.put("slot-output", "{\"findings\":[]}");
    const artifact = { id: "A1", kind: "artifact" as const, description: "lens-a output", artifactDigest: output.digest };
    const retained = (report: PanelReport) => Object.assign(run(report, "lens-a"), { outputArtifact: output.id, outputDigest: output.digest });
    expect((await validatePanelReport(withEvidence(artifact, retained), policy, { ...options, artifacts: store })).issues).toEqual([]);
    expect((await validatePanelReport(withEvidence(artifact, retained), policy, options)).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_PANEL_FINDING_INVALID", path: "/evidence/3/artifactDigest" })]);
    expect(codes((await validatePanelReport(withEvidence(artifact), policy, { ...options, artifacts: store })).issues)).toEqual(["REVIEWFN_PANEL_FINDING_INVALID"]);
  });

  it("checks the incremental range and change detail of a panel without a requirements report", async () => {
    const since = "c".repeat(40);
    const store = new MemoryStore();
    const hunks = await store.put("change-hunks", serializeChangeHunks({ version: 1, baseCommit: mergeBase, headCommit: head, files: [{ path: "src/value.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }] }));
    const deltaHunks = await store.put("change-hunks", serializeChangeHunks({ version: 1, baseCommit: since, headCommit: head, files: [{ path: "src/value.ts", status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }] }));
    const value = panelOnly(report => { report.changeDetail = { hunksArtifact: hunks.id, hunksDigest: hunks.digest, since, deltaHunksArtifact: deltaHunks.id, deltaHunksDigest: deltaHunks.digest, deltaPaths: ["src/value.ts"] }; });
    const ancestry = (sinceIsAncestor: boolean) => ({ ...options, artifacts: store, sourceControl: { ...sourceControl, isAncestor: async (_root: string, ancestor: string) => ancestor !== since || sinceIsAncestor } });
    expect((await validatePanelReport(value, policy, ancestry(true))).issues).toEqual([]);
    expect((await validatePanelReport(value, policy, ancestry(false))).issues).toEqual([expect.objectContaining({ code: "REVIEWFN_SINCE_NOT_ANCESTOR", path: "/changeDetail/since" })]);
    expect(codes((await validatePanelReport(value, policy, options)).issues)).toEqual(["REVIEWFN_CHANGE_DETAIL_MISMATCH"]);
  });
});

describe("panel policy and slot identity", () => {
  it("validates the policy and digests it with the default concurrency", () => {
    expect(validatePanelPolicy(panelPolicy)).toEqual({ valid: true, issues: [] });
    expect(panelPolicyDigest(panelPolicy)).toBe(panelPolicyDigest({ ...panelPolicy, maxConcurrentSlots: 2 }));
    expect(panelPolicyDigest(panelPolicy)).not.toBe(panelPolicyDigest({ ...panelPolicy, maxConcurrentSlots: 3 }));
    expect(() => panelPolicyDigest({ ...panelPolicy, maxConcurrentSlots: 9 })).toThrow(/REVIEWFN_PANEL_SCHEMA/);
  });

  it("rejects duplicate slots, unknown requirement slots and malformed slot IDs", () => {
    expect(codes(validatePanelPolicy({ ...panelPolicy, slots: [...panelPolicy.slots, panelPolicy.slots[0]] }).issues)).toEqual(["REVIEWFN_PANEL_SLOT_DUPLICATE"]);
    expect(codes(validatePanelPolicy({ ...panelPolicy, requirementsSlot: "verifier" }).issues)).toEqual(["REVIEWFN_PANEL_SLOT_UNKNOWN"]);
    expect(codes(validatePanelPolicy({ ...panelPolicy, requirementsSlot: "ghost" }).issues)).toEqual(["REVIEWFN_PANEL_SLOT_UNKNOWN"]);
    expect(validatePanelPolicy({ ...panelPolicy, requirementsSlot: null }).valid).toBe(true);
    for (const id of ["Lens", "-lens", "a".repeat(64), "lens_a", ""]) expect(codes(validatePanelPolicy({ ...panelPolicy, slots: [{ ...panelPolicy.slots[0], id }] }).issues)).toEqual(["REVIEWFN_PANEL_SCHEMA"]);
    expect(validatePanelPolicy({ ...panelPolicy, slots: [{ ...panelPolicy.slots[0], id: `a${"-".repeat(62)}` }], requirementsSlot: null }).valid).toBe(true);
  });

  it("fingerprints credentials without exposing them", () => {
    const fingerprint = credentialFingerprint("sk-private-credential");
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).not.toContain("private");
    expect(() => credentialFingerprint("")).toThrow();
    const identity = panelReport().slotRuns[0].identity;
    expect(validateSlotIdentity(identity).valid).toBe(true);
    expect(validateSlotIdentity({ ...identity, credentialFingerprint: "sk-private-credential" }).valid).toBe(false);
    expect(slotIdentityKey(identity)).toBe(slotIdentityKey({ ...identity }));
    expect(slotIdentityKey(identity)).not.toBe(slotIdentityKey({ ...identity, credentialFingerprint: credentialFingerprint("account-2") }));
    expect(slotIdentityKey(identity)).not.toBe(slotIdentityKey({ ...identity, credentialFingerprint: undefined }));
  });

  it("transforms each schema subtree once into the provider-strict form", () => {
    // The previous implementation, which transformed every properties subtree twice per object level.
    const doubled = (schema: unknown): unknown => {
      if (Array.isArray(schema)) return schema.map(doubled);
      if (!schema || typeof schema !== "object") return schema;
      const input = schema as Record<string, unknown>;
      const output = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, doubled(value)]));
      if (input.type === "object" && input.properties) {
        const required = new Set(input.required as string[] ?? []);
        output.properties = Object.fromEntries(Object.entries(input.properties as Record<string, unknown>).map(([key, value]) => [key, required.has(key) ? doubled(value) : { anyOf: [doubled(value), { type: "null" }] }]));
        output.required = Object.keys(input.properties as object);
      }
      return output;
    };
    for (const schema of [harnessOutputSchema, lensOutputSchema, panelReportSchema]) expect(strictProviderSchema(schema)).toEqual(doubled(schema));
    expect(strictProviderSchema()).toEqual(doubled(harnessOutputSchema));
    let nested: Record<string, unknown> = { type: "string" };
    for (let depth = 0; depth < 30; depth += 1) nested = { type: "object", additionalProperties: false, required: depth % 2 ? ["child"] : [], properties: { child: nested, note: { type: "string" } } };
    const started = performance.now();
    const strict = strictProviderSchema(nested);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(validateStructuredOutput(strict as Record<string, unknown>, null)).not.toEqual([]);
  });

  it("lets the provider-strict schema decide which nulls the applicable branch allows", () => {
    const nullable = { anyOf: [{ type: "string" }, { type: "null" }] };
    const typed = (kind: string, properties: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: ["kind", "a"], properties: { kind: { const: kind }, ...properties } });
    const x = typed("x", { a: nullable, note: { type: "string" } });
    const y = typed("y", { a: { type: "string" }, note: { type: "string" } });
    const conditional = { type: "object", additionalProperties: false, required: ["kind", "a"], properties: { kind: { enum: ["x", "y"] }, a: nullable, note: { type: "string" } }, if: { properties: { kind: { const: "x" } } }, then: true, else: { properties: { a: { type: "string" } } } };
    for (const schema of [{ anyOf: [x, y] }, { oneOf: [x, y] }, conditional]) {
      const strict = strictProviderSchema(schema) as Record<string, unknown>;
      expect(validateStructuredOutput(strict, { kind: "x", a: null, note: null })).toEqual([]);
      expect(validateStructuredOutput(strict, { kind: "y", a: null, note: null })).not.toEqual([]);
      expect(validateStructuredOutput(strict, { kind: "y", a: "set", note: null })).toEqual([]);
    }
    // A null never stands in for a property that something applying to the same value requires.
    const object = (properties: Record<string, unknown>, required: string[] = [], extra = {}) => ({ type: "object", properties, required, ...extra });
    const accepts = (schema: Record<string, unknown>, value: unknown) => validateStructuredOutput(strictProviderSchema(schema) as Record<string, unknown>, value).length === 0;
    // required at the root as a nullable value, refined to a string by a typed else: a null is a value there.
    const refined = object({ kind: { enum: ["x", "y"] }, a: nullable }, ["kind", "a"], { if: object({ kind: { const: "x" } }), else: object({ a: { type: "string" } }) });
    expect(accepts(refined, { kind: "x", a: null })).toBe(true);
    expect(accepts(refined, { kind: "y", a: null })).toBe(false);
    // optional everywhere, constrained by an untyped then: a null is an absent property.
    expect(accepts(object({ kind: { const: "y" }, a: { type: "string" } }, ["kind"], { if: { properties: { kind: { const: "y" } } }, then: { properties: { a: { type: "string" } } } }), { kind: "y", a: null })).toBe(true);
    // optional at the root but required by an allOf member, non-nullable or nullable there.
    expect(accepts(object({ p: { type: "string" } }, [], { allOf: [object({ p: { type: "string" } }, ["p"])] }), { p: null })).toBe(false);
    expect(accepts(object({ p: { type: "string" } }, [], { allOf: [object({ p: nullable }, ["p"])] }), { p: null })).toBe(false);
    expect(accepts(object({ p: { type: "string" } }, [], { allOf: [object({ p: nullable }, ["p"])] }), { p: "set" })).toBe(true);
  });

  it("types lens findings with the panel severities the lens schema accepts", () => {
    const lensFinding: LensOutput["findings"][number] = { ...panelReport().findings[0], severity: "critical" };
    // @ts-expect-error a lens never emits info
    const info: LensOutput["findings"][number]["severity"] = "info";
    const output = (severity: string) => ({ findings: [{ fingerprint: lensFinding.fingerprint, severity, category: lensFinding.category, title: lensFinding.title, trigger: lensFinding.trigger, impact: lensFinding.impact, direction: lensFinding.direction, evidenceIds: [], basis: "inferred", requirementIds: [], lifecycle: "new" }], evidence: [], inspectedPaths: [], uninspected: [] });
    expect(panelStructureIssues("lensOutput", output(lensFinding.severity))).toEqual([]);
    expect(codes(panelStructureIssues("lensOutput", output(info)))).toEqual(["REVIEWFN_PANEL_FINDING_INVALID"]);
  });

  it("maps priorities onto severities without info", () => {
    expect(PANEL_PRIORITY_SEVERITY).toEqual({ P0: "critical", P1: "high", P2: "medium", P3: "low" });
  });

  it("requires void reasons exactly for void runs", () => {
    const run = panelReport().slotRuns[2];
    expect(validateSlotRun(run).valid).toBe(true);
    expect(codes(validateSlotRun({ ...run, voidReasons: [] }).issues)).toEqual(["REVIEWFN_PANEL_SCHEMA"]);
    expect(codes(validateSlotRun({ ...run, terminal: "failed" }).issues)).toEqual(["REVIEWFN_PANEL_SCHEMA"]);
    expect(codes(validateSlotRun({ ...run, voidReasons: ["model_mismatch", "model_mismatch"] }).issues)).toEqual(["REVIEWFN_PANEL_SCHEMA"]);
  });
});

describe("0.1 compatibility", () => {
  it("validates a 0.1 single-harness report as before and as an embedded schema document", async () => {
    const report = requirementsReport();
    expect(await validateReport(report, policy, sourceControl, ".", context)).toMatchObject({ valid: true, errors: [], verdict: "ready" });
    expect(ajvValid("panelReport", { ...panelReport(), requirementsReport: { ...report, normalizedEventArtifact: "events", tests: [{ id: "T1", command: ["npm", "test"], cwd: ".", commit: head, startedAt: "s", finishedAt: "f", runtimeMs: 1, exitCode: 0, signal: null, timedOut: false, canceled: false, stdoutDigest: "o", stderrDigest: "e", limitations: [] }] } })).toBe(true);
  });
});

/** Every structural variant of `value`: removed and unknown properties, emptied or duplicated arrays, and retyped values. */
function* variants(value: unknown): Generator<{ path: string; value: unknown }> {
  const replacements: unknown[] = [null, 0, 1, 1.5, -1, "", " ", "x", true, [], {}];
  function* walk(node: unknown, path: Array<string | number>): Generator<{ path: Array<string | number>; node: unknown }> {
    if (path.length) for (const replacement of replacements) yield { path, node: replacement };
    if (Array.isArray(node)) {
      yield { path, node: [] };
      if (node.length) yield { path, node: [...node, node[0]] };
      for (const [index, item] of node.entries()) yield* walk(item, [...path, index]);
    } else if (node && typeof node === "object") {
      yield { path, node: { ...node, unexpected: 1 } };
      for (const key of Object.keys(node)) {
        const { [key]: _removed, ...rest } = node as Record<string, unknown>;
        yield { path, node: rest };
        yield* walk((node as Record<string, unknown>)[key], [...path, key]);
      }
    }
  }
  for (const { path, node } of walk(value, [])) {
    if (!path.length) { yield { path: "/", value: node }; continue; }
    const copy = structuredClone(value) as Record<string | number, unknown>;
    let parent = copy;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    parent[path.at(-1)!] = node;
    yield { path: `/${path.join("/")}`, value: copy };
  }
}

describe("JSON Schema and TypeScript validator agreement", () => {
  const panel = panelReport();
  const lensOutput = { findings: [panel.findings[0]].map(({ origins: _o, confidence: _c, ruleIds: _r, verification: _v, disposition: _d, ...item }) => item), evidence: panel.evidence, inspectedPaths: ["src/value.ts"], uninspected: [{ scope: "docs", reason: "out of scope" }] };
  const documents: Array<[PanelStructure, unknown]> = [
    ["panelReport", panel], ["panelReport", { ...panelOnly(), slotRuns: [panel.slotRuns[2]], findings: [], clusters: [], coverage: "incomplete", coverageReasons: ["lens-c was void"] }], ["panelPolicy", { ...panelPolicy, maxConcurrentSlots: 4 }], ["slotIdentity", panel.slotRuns[0].identity],
    ["slotRun", panel.slotRuns[0]], ["slotRun", panel.slotRuns[2]], ["panelFinding", panel.findings[1]], ["panelFinding", panel.findings[2]], ["lensOutput", lensOutput],
  ];

  it("agrees on every negative fixture", () => {
    for (const [, change] of negatives) {
      const value = mutate(panelReport(), change);
      expect(ajvValid("panelReport", value)).toBe(panelStructureIssues("panelReport", value).length === 0);
    }
  });

  it.each(documents.map(([kind, value], index) => [`${kind} #${index}`, kind, value] as const))("agrees on every structural variant of %s", (_name, kind, document) => {
    expect(ajvValid(kind, document)).toBe(true);
    expect(panelStructureIssues(kind, document)).toEqual([]);
    const disagreements: string[] = [];
    let total = 0;
    for (const variant of variants(document)) {
      total++;
      const schema = ajvValid(kind, variant.value);
      const typescript = panelStructureIssues(kind, variant.value).length === 0;
      if (schema !== typescript) disagreements.push(`${variant.path}: Ajv ${schema ? "accepts" : "rejects"}, TypeScript ${typescript ? "accepts" : "rejects"}`);
    }
    expect(disagreements).toEqual([]);
    expect(total).toBeGreaterThan(20);
  });
});
