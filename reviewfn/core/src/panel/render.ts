import type { CodeAnchor } from "../types.js";
import { PANEL_CANCELED_REASON, type PanelFinding, type PanelFindingSeverity, type PanelReport, type PanelSlot, type SlotRun } from "./types.js";
import { slotIdentityKey } from "./validate.js";

const SEVERITIES: readonly PanelFindingSeverity[] = ["critical", "high", "medium", "low"];
const SEVERITY_TITLES: Readonly<Record<PanelFindingSeverity, string>> = { critical: "Critical (P0)", high: "High (P1)", medium: "Medium (P2)", low: "Low (P3)" };
const ON_BASE_LABELS = { present: "also present on base", absent: "new in this change", not_checked: "not checked against base" } as const;
/** Findings without a code anchor are listed after every file. */
const NO_FILE = "Not anchored to a file";

/** Escape untrusted text for Markdown table cells and inline prose, as the 0.1 renderer does. */
function escape(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+.!|<>]/g, "\\$&").replace(/[\r\n\t]/g, " ").replaceAll("@", "&#64;");
}

/** Inline code that cannot be closed early by the value it shows. */
function code(value: string): string {
  const text = value.replace(/[\r\n\t]/g, " ");
  const fence = "`".repeat(Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length)) + 1);
  return `${fence}${fence.length > 1 || text.startsWith("`") || text.endsWith("`") ? ` ${text} ` : text}${fence}`;
}

/** Whether `value` is a panel report document (by its `kind`), as opposed to a 0.1 review report. */
export function isPanelReport(value: unknown): value is PanelReport {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "reviewfn-panel";
}

/** Whether the panel run that produced `report` was canceled; such a report records the cancellation as a coverage reason. */
export function panelReportCanceled(report: Pick<PanelReport, "coverageReasons">): boolean {
  return report.coverageReasons.includes(PANEL_CANCELED_REASON);
}

/**
 * Why a slot run ended as it did, for the slot table: the void reasons of a `void` run, and for a `collapsed` run the
 * earlier completed slot in its stage whose identity it shares. Other terminals carry no recorded reason.
 */
function slotRunReason(run: SlotRun, report: PanelReport, slots: Map<string, PanelSlot>): string {
  if (run.terminal === "void") return `void: ${run.voidReasons.join(", ")}`;
  if (run.terminal !== "collapsed") return "";
  const stage = slots.get(run.slotId)?.stage;
  const key = slotIdentityKey(run.identity);
  const counted = report.slotRuns.find(other => other.terminal === "completed" && other.slotId !== run.slotId && slots.get(other.slotId)?.stage === stage && slotIdentityKey(other.identity) === key);
  return counted ? `collapsed: same identity as ${counted.slotId}, which counts toward quorum` : "collapsed: same identity as an earlier completed slot";
}

function anchorText(anchor: CodeAnchor): string {
  const line = anchor.startLine === undefined ? anchor.symbol ?? "unknown" : anchor.endLine !== undefined && anchor.endLine !== anchor.startLine ? `${anchor.startLine}-${anchor.endLine}` : String(anchor.startLine);
  return `${code(`${anchor.path}:${line}`)} at ${code(anchor.commit)}`;
}

function verificationText(finding: PanelFinding): string {
  const verification = finding.verification;
  if (!verification) return "unverified";
  const evidence = verification.evidenceIds.length ? `; evidence ${verification.evidenceIds.map(escape).join(", ")}` : "";
  return `${verification.verdict} by ${escape(verification.slotId)}: ${escape(verification.reason)}${evidence}`;
}

function originsText(finding: PanelFinding): string {
  return finding.origins.map(origin => `${escape(origin.slotId)} (${escape(origin.lens)} lens)`).join(", ");
}

function findingLines(finding: PanelFinding): string[] {
  const onBase = ON_BASE_LABELS[finding.verification?.onBase ?? "not_checked"];
  const lines = [
    `- **${escape(finding.title)}** (${finding.category}; ${onBase})`,
    `  - Origins: ${originsText(finding)}`,
    `  - Verification: ${verificationText(finding)}`,
    `  - Trigger: ${escape(finding.trigger)}`,
    `  - Impact: ${escape(finding.impact)}`,
    `  - Fix: ${escape(finding.direction)}`,
    `  - Evidence: ${finding.evidenceIds.map(escape).join(", ") || "none"}; ${finding.basis}`,
  ];
  if (finding.anchor) lines.push(`  - Anchor: ${anchorText(finding.anchor)}`);
  return lines;
}

/** Group `findings` by severity (critical first), then by file in code-point order, findings without a file last. */
function groupedFindings(findings: PanelFinding[]): string[] {
  const lines: string[] = [];
  for (const severity of SEVERITIES) {
    const matching = findings.filter(finding => finding.severity === severity);
    if (!matching.length) continue;
    lines.push(`### ${SEVERITY_TITLES[severity]}`, "");
    // `undefined` keys findings without an anchor, so no anchored path can be mistaken for them.
    const files = new Map<string | undefined, PanelFinding[]>();
    for (const finding of matching) files.set(finding.anchor?.path, [...(files.get(finding.anchor?.path) ?? []), finding]);
    const ordered: Array<string | undefined> = [...files.keys()].filter((file): file is string => file !== undefined).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (files.has(undefined)) ordered.push(undefined);
    for (const file of ordered) lines.push(`#### ${file === undefined ? NO_FILE : code(file)}`, "", ...files.get(file)!.flatMap(findingLines), "");
  }
  return lines;
}

function setAsideLines(finding: PanelFinding): string[] {
  const reference = finding.suppressionReference;
  const lines = [
    `- **${escape(finding.title)}** (${finding.severity}; ${finding.disposition})`,
    `  - Reason: ${escape(finding.dispositionReason ?? "no reason recorded")}`,
    `  - Origins: ${originsText(finding)}`,
    `  - Verification: ${verificationText(finding)}`,
  ];
  if (reference) lines.push(`  - Suppressed by: ${escape(`${reference.sourceId}#${reference.anchor}`)}`);
  if (finding.anchor) lines.push(`  - Anchor: ${anchorText(finding.anchor)}`);
  return lines;
}

/**
 * Render a panel report as Markdown: the run summary, every slot's terminal state with void and collapse reasons, the
 * requirements summary, reported findings grouped by severity then file (each with its origins, verification verdict
 * and on-base label), and dropped and suppressed findings with their reasons in a collapsed section. Advisory only.
 */
export function renderPanelMarkdownReport(report: PanelReport): string {
  const slots = new Map(report.slots.map(slot => [slot.id, slot]));
  const runs = new Map(report.slotRuns.map(run => [run.slotId, run]));
  const reported = report.findings.filter(finding => finding.disposition === "reported");
  const setAside = report.findings.filter(finding => finding.disposition !== "reported");
  const count = (disposition: PanelFinding["disposition"]) => report.findings.filter(finding => finding.disposition === disposition).length;
  const lines = [
    "# ReviewFn panel report",
    "",
    `- Run: ${code(report.runId)}`,
    `- Reviewed head: ${code(report.change.headCommit)}`,
    `- Base: ${code(report.change.baseCommit)} (merge base ${code(report.change.mergeBaseCommit)})`,
    ...(report.changeDetail?.since ? [`- Incremental since: ${code(report.changeDetail.since)}`] : []),
    `- Coverage: **${report.coverage}**`,
    `- Verdict: **${report.verdict ?? "no valid assessment"}** (advisory)`,
    `- Findings: ${count("reported")} reported, ${count("dropped")} dropped, ${count("suppressed")} suppressed`,
    `- Panel policy: ${code(report.panelPolicyDigest)}`,
    "",
  ];
  if (report.coverageReasons.length) lines.push("## Coverage limits", "", ...report.coverageReasons.map(reason => `- ${escape(reason)}`), "");
  lines.push("## Slots", "", "| Slot | Stage | Lens | Harness | Model | Terminal | Reason |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const slot of report.slots) {
    const run = runs.get(slot.id);
    const harness = run ? `${run.identity.harnessAdapter} ${run.identity.harnessVersion}` : `${slot.harness.adapter} ${slot.harness.version}`;
    const model = run ? `${run.identity.provider}/${run.identity.model}` : `${slot.inference.provider}/${slot.inference.model}`;
    lines.push(`| ${escape(slot.id)} | ${slot.stage} | ${escape(slot.lens)} | ${escape(harness)} | ${escape(model)} | ${run?.terminal ?? "not run"} | ${run ? escape(slotRunReason(run, report, slots)) : ""} |`);
  }
  lines.push("");
  const requirements = report.requirementsReport;
  if (requirements) {
    lines.push("## Requirements", "", `Requirements slot execution **${requirements.execution}**, coverage **${requirements.coverage}**.`, "");
    if (requirements.requirements.length) {
      lines.push("| Requirement | Assessment | Evidence / gap |", "| --- | --- | --- |");
      for (const requirement of requirements.requirements) {
        const assessment = requirements.assessments.find(item => item.requirementId === requirement.id);
        const detail = assessment ? [...assessment.evidenceIds, ...assessment.gaps.map(gap => `gap: ${gap}`)].join("; ") : "missing assessment";
        lines.push(`| ${escape(`${requirement.id}: ${requirement.statement}`)} | ${assessment?.status ?? "missing"} | ${escape(detail)} |`);
      }
      lines.push("");
    } else lines.push("No requirements were extracted.", "");
  }
  lines.push("## Findings", "");
  if (!reported.length) lines.push("No findings were reported.", "");
  else lines.push(...groupedFindings(reported));
  if (setAside.length) {
    lines.push("## Dropped and suppressed findings", "", "<details>", `<summary>${setAside.length} finding(s) set aside, with reasons</summary>`, "", ...setAside.flatMap(setAsideLines), "", "</details>", "");
  }
  lines.push("## Verification", "");
  if (!report.gateReceipts.length) lines.push("No tests were run.");
  else for (const receipt of report.gateReceipts) lines.push(`- ${escape(receipt.command.join(" "))}: ${receipt.exitCode === 0 && !receipt.timedOut && !receipt.canceled ? "passed" : "did not pass"} in ${receipt.runtimeMs} ms (receipt ${escape(receipt.id)})`);
  lines.push("", "_Advisory ReviewFn panel output; it cannot merge or push code._", "");
  return lines.join("\n");
}
