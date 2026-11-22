/** The `apifn check` report and its text, JSON and Markdown renderings. */

import type { DiffEntry, DiffResult } from "@apifn/core";

export const CHECK_FORMATS = ["text", "json", "markdown"] as const;
export type CheckFormat = (typeof CHECK_FORMATS)[number];

/** First line of the Markdown report; the API check workflow updates the PR comment holding it. */
export const CHECK_REPORT_MARKER = "<!-- apifn-ci-report -->";

export type CheckVerdict = "pass" | "warn" | "fail";
export type DriftState = "none" | "stale" | "missing" | "unparseable";

export interface CheckReport {
  /** The committed spec differed from the generated document (before any `--write`). */
  drift: boolean;
  valid: boolean;
  /** Breaking changes against the base, reported even when allowed. */
  breaking: DiffEntry[];
  versions: { base: string | null; head: string | null };
  verdict: CheckVerdict;
  /** Diff against the base, or null when it was skipped (see `base.status`). */
  diff: Pick<DiffResult, "summary" | "breaking" | "nonBreaking"> | null;
  spec: string;
  driftState: DriftState;
  written: boolean;
  validationErrors: Array<{ path: string; message: string }>;
  base: {
    source: "git" | "file" | "none";
    ref: string | null;
    /**
     * compared · new-contract (no spec at the git ref) · none (no base given) · skipped (the diff
     * could not run on the invalid generated spec)
     */
    status: "compared" | "new-contract" | "none" | "skipped";
  };
  failures: string[];
  warnings: string[];
}

export function plural(count: number, noun: string): string {
  return count === 1 ? `${count} ${noun}` : `${count} ${noun}s`;
}

function driftLabel(report: CheckReport): string {
  const suffix = report.written ? " (rewritten by --write)" : "";
  switch (report.driftState) {
    case "none":
      return "none";
    case "missing":
      return `committed spec missing${suffix}`;
    case "unparseable":
      return `committed spec is not YAML or JSON${suffix}`;
    default:
      return `committed spec differs from the router${suffix}`;
  }
}

function baseLabel(report: CheckReport): string {
  const { base } = report;
  if (base.source === "none") {
    return "none (diff skipped)";
  }
  const where = base.source === "git" ? `git ref ${base.ref}` : String(base.ref);
  if (base.status === "new-contract") {
    return `${where}: no spec at this ref, new contract (diff skipped)`;
  }
  return base.status === "skipped" ? `${where}: diff skipped (generated spec is invalid)` : where;
}

function versionsLabel(report: CheckReport): string {
  return `base ${report.versions.base ?? "-"}, head ${report.versions.head ?? "-"}`;
}

function validLabel(report: CheckReport): string {
  if (report.valid) return "yes";
  const count = plural(report.validationErrors.length, "error");
  return `no (${count})`;
}

function entryLines(entries: DiffEntry[]): string[] {
  return entries.map((entry) => `  - ${entry.description} (${entry.path})`);
}

export function formatCheckText(report: CheckReport): string {
  const lines: string[] = [
    `apifn check: ${report.verdict.toUpperCase()}`,
    `Spec:     ${report.spec}`,
    `Drift:    ${driftLabel(report)}`,
    `Valid:    ${validLabel(report)}`,
    ...report.validationErrors.map((error) => `  - ${error.path}: ${error.message}`),
    `Base:     ${baseLabel(report)}`,
    `Versions: ${versionsLabel(report)}`,
  ];
  if (report.diff) {
    lines.push(
      `Breaking changes: ${report.diff.breaking.length}`,
      ...entryLines(report.diff.breaking),
      `Non-breaking changes: ${report.diff.nonBreaking.length}`,
      ...entryLines(report.diff.nonBreaking)
    );
  }
  if (report.failures.length > 0) {
    lines.push("Failures:", ...report.failures.map((failure) => `  - ${failure}`));
  }
  if (report.warnings.length > 0) {
    lines.push("Warnings:", ...report.warnings.map((warning) => `  - ${warning}`));
  }
  return `${lines.join("\n")}\n`;
}

/** Folds every Markdown line ending (CRLF, LF and a bare CR) to a space: one field, one line. */
function oneLine(value: string): string {
  return value.replaceAll(/\r\n?|\n/g, " ");
}

/** Markdown text with every character that could start markup escaped (pipes included). */
function mdText(value: string): string {
  return oneLine(value).replaceAll(/[\\`*_[\]<>|]/g, String.raw`\$&`);
}

/** A code span holding `value` verbatim: its fence is longer than any backtick run inside. */
function mdCode(value: string): string {
  const text = oneLine(value);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return fence + pad + text + pad + fence;
}

/**
 * A code span inside a GFM table cell: the table splits cells on unescaped pipes before inline
 * parsing, then reads `\|` as a literal pipe, also inside code spans.
 */
function mdCodeCell(value: string): string {
  return mdCode(value).replaceAll("|", String.raw`\|`);
}

function mdEntry(entry: { path: string; message?: string; description?: string }): string {
  const detail = entry.message ?? entry.description ?? "";
  return `${mdCode(entry.path)}: ${mdText(detail)}`;
}

export function formatCheckMarkdown(report: CheckReport): string {
  const lines: string[] = [
    CHECK_REPORT_MARKER,
    `## ApiFn check: **${report.verdict.toUpperCase()}**`,
    "",
    "| Check | Result |",
    "|---|---|",
    `| Spec | ${mdCodeCell(report.spec)} |`,
    `| Drift | ${mdText(driftLabel(report))} |`,
    `| Valid | ${mdText(validLabel(report))} |`,
    `| Base | ${mdText(baseLabel(report))} |`,
    `| Versions | ${mdText(versionsLabel(report))} |`,
    `| Breaking | ${report.diff ? report.diff.breaking.length : "-"} |`,
    `| Non-breaking | ${report.diff ? report.diff.nonBreaking.length : "-"} |`,
  ];

  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push("", `### ${title}`, "", ...items.map((item) => `- ${item}`));
  };

  section("Failures", report.failures.map(mdText));
  section("Warnings", report.warnings.map(mdText));
  section("Validation errors", report.validationErrors.map(mdEntry));
  section("Breaking changes", report.breaking.map(mdEntry));
  section("Non-breaking changes", (report.diff?.nonBreaking ?? []).map(mdEntry));

  return `${lines.join("\n")}\n`;
}

export function formatCheckJson(report: CheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderReport(report: CheckReport, format: CheckFormat): string {
  if (format === "json") return formatCheckJson(report);
  if (format === "markdown") return formatCheckMarkdown(report);
  return formatCheckText(report);
}
