import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLICY, PANEL_PRIORITY_SEVERITY, PANEL_VALIDATION_CODES, credentialFingerprint, derivePanelVerdict, lensOutputSchema, panelFindingSchema,
  panelPolicyDigest, panelPolicySchema, panelReportSchema, panelStructureIssues, slotIdentityKey, slotIdentitySchema, slotRunSchema,
  validatePanelFinding, validatePanelPolicy, validatePanelReport, validateReport, validateSlotIdentity, validateSlotRun,
  type ContextManifest, type PanelFinding, type PanelPolicy, type PanelReport, type PanelStructure, type ReviewReport, type SourceControlAdapter,
} from "../src/index.js";

const head = "b".repeat(40);
const mergeBase = "a".repeat(40);
const policy = { ...DEFAULT_POLICY, requiredCategories: ["behavior" as const] };
const change = { repositoryId: "repo", host: "local", targetBranch: "main", baseCommit: mergeBase, headCommit: head, mergeBaseCommit: mergeBase, diffDigest: "d".repeat(64), changedPaths: ["src/value.ts"], capturedAt: "2026-01-01T00:00:00.000Z" };
const context: ContextManifest = { version: 1, sources: [{ id: "issue:1", type: "issue", status: "available", content: "Return the value", retrievedAt: "2026-01-01T00:00:00.000Z", digest: "d" }], selection: { candidates: [], selected: [], rule: "explicit" }, limits: { maxSources: 1, maxBytes: 100, maxDepth: 1 }, incompleteReasons: [], digest: "c".repeat(64) };
const sourceControl: SourceControlAdapter = { id: "fixture", capture: async () => change, currentHead: async () => head, verifyAnchor: async () => true };
const options = { sourceControl, root: ".", context };

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
  return {
    schemaVersion: 1, kind: "reviewfn-panel", runId: "panel-run", createdAt: "2026-01-01T00:10:00.000Z", change: structuredClone(change),
    panelPolicyDigest: panelPolicyDigest(panelPolicy), slots: structuredClone(panelPolicy.slots),
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
      { id: "V2", kind: "code", description: "the guard the refuted finding missed", code: { commit: mergeBase, path: "src/value.ts", startLine: 1 } },
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
}

const schemas: Record<PanelStructure, object> = { panelPolicy: panelPolicySchema, slotIdentity: slotIdentitySchema, slotRun: slotRunSchema, panelFinding: panelFindingSchema, panelReport: panelReportSchema, lensOutput: lensOutputSchema };
const ajv = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, new Ajv({ allErrors: true, strict: true }).compile(schema)])) as Record<PanelStructure, ReturnType<Ajv["compile"]>>;
const ajvValid = (kind: PanelStructure, value: unknown) => ajv[kind](value) as boolean;
const codes = (issues: Array<{ code: string }>) => [...new Set(issues.map(issue => issue.code))].sort();

function mutate(report: PanelReport, change: (value: PanelReport) => void): PanelReport {
  const value = structuredClone(report);
  change(value);
  return value;
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
      delete report.requirementsReport;
      for (const item of report.findings) item.requirementIds = [];
      report.findings[0].severity = "low";
      report.verdict = "needs_verification";
    });
    expect(await validatePanelReport(value, policy, options)).toMatchObject({ valid: true, verdict: "needs_verification" });
  });

  it("has no verdict when the requirements run did not complete", async () => {
    const value = mutate(panelReport(), report => { report.requirementsReport!.execution = "failed"; delete report.requirementsReport!.verdict; delete report.verdict; });
    expect(await validatePanelReport(value, policy, options)).toMatchObject({ valid: true, verdict: undefined });
    expect(codes((await validatePanelReport({ ...value, verdict: "changes_requested" }, policy, options)).issues)).toEqual(["REVIEWFN_PANEL_VERDICT_MISMATCH"]);
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
    ["panelReport", panel], ["panelPolicy", { ...panelPolicy, maxConcurrentSlots: 4 }], ["slotIdentity", panel.slotRuns[0].identity],
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
