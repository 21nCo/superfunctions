/**
 * `apifn check [routerPath]` — the one contract check a developer or CI runs.
 *
 * 1. Generates the OpenAPI document from the router in memory (the `apifn generate` code path).
 * 2. Drift: the committed spec, parsed as YAML or JSON, differs from the generated document in
 *    canonical JSON. `--write` rewrites a drifted spec instead of failing.
 * 3. Validates the generated document with the existing validator.
 * 4. Diffs it against a base spec (`--base <git-ref>` or `--base-spec <path|url>`).
 * 5. Version rule: a breaking change passes only when the contract version (`info.version`, semver
 *    2.0) was bumped: head major > base major, or both majors 0 and head minor > base minor.
 *
 * Exit codes: 0 pass (warnings allowed) · 1 drift, invalid spec or a breaking change the version
 * rule does not cover · 2 usage or load error (message on stderr, no report).
 */

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { diffOpenAPI, parseOpenAPI, validateOpenAPI } from "@apifn/core";
import type { DiffEntry, DiffResult, OpenAPIDocument } from "@apifn/core";
import type { ApifnConfig } from "../config.js";
import type { Output } from "../utils/output.js";
import { buildSpecFromRouter, resolveSpecPath, serializeSpec } from "./generate.js";
import { loadSpec } from "./diff.js";

export const CHECK_FORMATS = ["text", "json", "markdown"] as const;
export type CheckFormat = (typeof CHECK_FORMATS)[number];

/** First line of the Markdown report; the API check workflow updates the PR comment holding it. */
export const CHECK_REPORT_MARKER = "<!-- apifn-ci-report -->";

export interface CheckCommandOptions {
  routerPath?: string;
  specPath?: string;
  /** Git ref whose committed spec is the base. */
  base?: string;
  /** Path or HTTP(S) URL of the base spec. */
  baseSpec?: string;
  allowBreaking?: boolean;
  write?: boolean;
  format?: string;
  reportPath?: string;
  cwd?: string;
  config: ApifnConfig;
  output: Output;
  writeStdout?: (text: string) => void;
}

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

class CheckUsageError extends Error {}

const DRIFT_PROBLEMS: Record<DriftState, string> = {
  none: "matches the router",
  missing: "does not exist",
  unparseable: "is not valid YAML or JSON",
  stale: "differs from the spec generated from the router",
};

function verdictOf(failures: string[], warnings: string[]): CheckVerdict {
  if (failures.length > 0) return "fail";
  return warnings.length > 0 ? "warn" : "pass";
}

function baseStatus(base: BaseSpec, diffed: boolean): CheckReport["base"]["status"] {
  if (base.source === "none") return "none";
  if (!base.doc) return "new-contract";
  return diffed ? "compared" : "skipped";
}

// ---------------------------------------------------------------------------
// Canonical JSON and semver
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // A null-prototype object keeps an own "__proto__" key as data instead of a prototype change.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Canonical JSON: keys sorted at every level, values that JSON drops (undefined) removed. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(JSON.parse(JSON.stringify(value ?? null))));
}

// semver.org 2.0 grammar: MAJOR.MINOR.PATCH, optional pre-release and build metadata.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export interface SemverCore {
  major: bigint;
  minor: bigint;
  patch: bigint;
}

/** Parses a semver 2.0 version; anything else is unversioned (null). */
export function parseSemver(version: string | null | undefined): SemverCore | null {
  if (typeof version !== "string") {
    return null;
  }
  const match = SEMVER.exec(version);
  if (!match) {
    return null;
  }
  return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]) };
}

/** D7: a breaking change is covered by a major bump, or by a minor bump while both majors are 0. */
export function versionCoversBreaking(base: string | null, head: string | null): boolean {
  const b = parseSemver(base);
  const h = parseSemver(head);
  if (!b || !h) {
    return false;
  }
  if (h.major > b.major) {
    return true;
  }
  return b.major === 0n && h.major === 0n && h.minor > b.minor;
}

function infoVersion(doc: unknown): string | null {
  const info = (doc as { info?: { version?: unknown } } | null)?.info;
  return typeof info?.version === "string" ? info.version : null;
}

// ---------------------------------------------------------------------------
// Base spec from git
// ---------------------------------------------------------------------------

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          // Spawn failure (git not installed, cwd missing), not a git exit status.
          reject(new CheckUsageError(`Failed to run git: ${error.message}`));
          return;
        }
        const code = error ? Number((error as { code?: number }).code ?? 1) : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

function gitFailure(args: string[], result: GitResult): CheckUsageError {
  const detail = result.stderr.trim() || `exit status ${result.code}`;
  return new CheckUsageError(`git ${args.join(" ")} failed: ${detail}`);
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0) {
    throw gitFailure(args, result);
  }
  return result.stdout;
}

/**
 * Reads the spec as committed at `ref`. Git resolves the ref once to a commit; every later call
 * uses that commit. Returns null only when git lists no entry for the spec path in that commit
 * (a new contract); any other git failure is an error.
 */
async function readSpecAtRef(ref: string, specPath: string): Promise<string | null> {
  if (ref.length === 0 || ref.startsWith("-")) {
    throw new CheckUsageError(`Invalid git ref '${ref}'`);
  }

  let dir = path.dirname(specPath);
  while (!existsSync(dir) && path.dirname(dir) !== dir) {
    dir = path.dirname(dir);
  }

  const toplevelResult = await runGit(["rev-parse", "--show-toplevel"], dir);
  if (toplevelResult.code !== 0) {
    throw new CheckUsageError(
      `--base needs a git work tree; ${dir} is not inside one: ${toplevelResult.stderr.trim()}`
    );
  }
  const root = realpathSync(toplevelResult.stdout.trim());
  const relative = path
    .relative(root, path.join(realpathSync(dir), path.relative(dir, specPath)))
    .split(path.sep)
    .join("/");
  if (relative === "" || relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) {
    throw new CheckUsageError(`Spec ${specPath} is outside the git repository at ${root}`);
  }

  const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  if (resolved.code !== 0) {
    throw new CheckUsageError(
      `Unknown git ref '${ref}'${resolved.stderr.trim() ? `: ${resolved.stderr.trim()}` : ""}`
    );
  }
  const commit = resolved.stdout.trim();

  // --literal-pathspecs: the spec path is a path, never a pathspec pattern.
  const listing = await gitOk(
    ["--literal-pathspecs", "ls-tree", "-z", commit, "--", relative],
    root
  );
  const entry = listing.split("\0").find((line) => line.endsWith(`\t${relative}`));
  if (!entry) {
    return null;
  }
  const type = entry.split(" ")[1];
  if (type !== "blob") {
    throw new CheckUsageError(`${relative} at ${ref} (${commit}) is a ${type}, not a spec file`);
  }

  return gitOk(["show", `${commit}:${relative}`], root);
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
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
  const where = base.source === "git" ? `git ref ${base.ref}` : `${base.ref}`;
  if (base.status === "new-contract") {
    return `${where}: no spec at this ref, new contract (diff skipped)`;
  }
  return base.status === "skipped" ? `${where}: diff skipped (generated spec is invalid)` : where;
}

function versionsLabel(report: CheckReport): string {
  return `base ${report.versions.base ?? "-"}, head ${report.versions.head ?? "-"}`;
}

export function formatCheckText(report: CheckReport): string {
  const lines: string[] = [];
  lines.push(`apifn check: ${report.verdict.toUpperCase()}`);
  lines.push(`Spec:     ${report.spec}`);
  lines.push(`Drift:    ${driftLabel(report)}`);
  lines.push(
    `Valid:    ${report.valid ? "yes" : `no (${plural(report.validationErrors.length, "error")})`}`
  );
  for (const error of report.validationErrors) {
    lines.push(`  - ${error.path}: ${error.message}`);
  }
  lines.push(`Base:     ${baseLabel(report)}`);
  lines.push(`Versions: ${versionsLabel(report)}`);
  if (report.diff) {
    lines.push(`Breaking changes: ${report.diff.breaking.length}`);
    for (const entry of report.diff.breaking) {
      lines.push(`  - ${entry.description} (${entry.path})`);
    }
    lines.push(`Non-breaking changes: ${report.diff.nonBreaking.length}`);
    for (const entry of report.diff.nonBreaking) {
      lines.push(`  - ${entry.description} (${entry.path})`);
    }
  }
  if (report.failures.length > 0) {
    lines.push("Failures:");
    for (const failure of report.failures) lines.push(`  - ${failure}`);
  }
  if (report.warnings.length > 0) {
    lines.push("Warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

function mdCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

function mdCode(value: string): string {
  return `\`${value.replace(/`/g, "'").replace(/\r?\n/g, " ")}\``;
}

function mdText(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/([\\`*_[\]<>|])/g, "\\$1");
}

export function formatCheckMarkdown(report: CheckReport): string {
  const lines: string[] = [
    CHECK_REPORT_MARKER,
    `## ApiFn check: **${report.verdict.toUpperCase()}**`,
    "",
    "| Check | Result |",
    "|---|---|",
    `| Spec | ${mdCell(mdCode(report.spec))} |`,
    `| Drift | ${mdCell(mdText(driftLabel(report)))} |`,
    `| Valid | ${report.valid ? "yes" : `no (${plural(report.validationErrors.length, "error")})`} |`,
    `| Base | ${mdCell(mdText(baseLabel(report)))} |`,
    `| Versions | ${mdCell(mdText(versionsLabel(report)))} |`,
    `| Breaking | ${report.diff ? report.diff.breaking.length : "-"} |`,
    `| Non-breaking | ${report.diff ? report.diff.nonBreaking.length : "-"} |`,
  ];

  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push("", `### ${title}`, "");
    for (const item of items) lines.push(`- ${item}`);
  };

  section("Failures", report.failures.map(mdText));
  section("Warnings", report.warnings.map(mdText));
  section(
    "Validation errors",
    report.validationErrors.map((e) => `${mdCode(e.path)}: ${mdText(e.message)}`)
  );
  section(
    "Breaking changes",
    report.breaking.map((e) => `${mdCode(e.path)}: ${mdText(e.description)}`)
  );
  section(
    "Non-breaking changes",
    (report.diff?.nonBreaking ?? []).map((e) => `${mdCode(e.path)}: ${mdText(e.description)}`)
  );

  return `${lines.join("\n")}\n`;
}

export function formatCheckJson(report: CheckReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function renderReport(report: CheckReport, format: CheckFormat): string {
  if (format === "json") return formatCheckJson(report);
  if (format === "markdown") return formatCheckMarkdown(report);
  return formatCheckText(report);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type CommittedSpec = { state: "present"; doc: unknown } | { state: "missing" | "unparseable" };

async function readCommittedSpec(specPath: string): Promise<CommittedSpec> {
  let raw: string;
  try {
    raw = await readFile(specPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
    throw new CheckUsageError(`Failed to read spec ${specPath}: ${errorMessage(error)}`);
  }
  try {
    // YAML 1.2 is a superset of JSON, so this reads both forms.
    return { state: "present", doc: parseYaml(raw) };
  } catch {
    return { state: "unparseable" };
  }
}

/**
 * `--write` keeps the committed file's format: formatted JSON for a .json path, otherwise the
 * YAML `apifn generate` writes.
 */
function serializeForPath(generated: OpenAPIDocument, specPath: string): string {
  return /\.json$/i.test(specPath)
    ? `${JSON.stringify(generated, null, 2)}\n`
    : serializeSpec(generated);
}

/** True when both paths name the same file (same resolved path, or the same inode once both exist). */
async function sameFile(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) {
    return true;
  }
  try {
    const [left, right] = await Promise.all([stat(a), stat(b)]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

interface BaseSpec {
  source: CheckReport["base"]["source"];
  ref: string | null;
  doc: OpenAPIDocument | null;
}

async function loadBase(options: CheckCommandOptions, specPath: string, cwd: string): Promise<BaseSpec> {
  if (options.base !== undefined) {
    const raw = await readSpecAtRef(options.base, specPath);
    if (raw === null) {
      return { source: "git", ref: options.base, doc: null };
    }
    try {
      return { source: "git", ref: options.base, doc: parseOpenAPI(raw) };
    } catch (error) {
      throw new CheckUsageError(`Failed to parse the base spec at ${options.base}: ${errorMessage(error)}`);
    }
  }
  if (options.baseSpec !== undefined) {
    let raw: string;
    try {
      raw = await loadSpec(options.baseSpec, cwd);
    } catch (error) {
      throw new CheckUsageError(`Failed to load base spec '${options.baseSpec}': ${errorMessage(error)}`);
    }
    try {
      return { source: "file", ref: options.baseSpec, doc: parseOpenAPI(raw) };
    } catch (error) {
      throw new CheckUsageError(`Failed to parse base spec '${options.baseSpec}': ${errorMessage(error)}`);
    }
  }
  return { source: "none", ref: null, doc: null };
}

/**
 * Applies D7 to the breaking changes: null when there are none or the version bump covers them,
 * a warning when they are allowed, otherwise a failure.
 */
function breakingVerdict(
  count: number,
  baseVersion: string | null,
  headVersion: string | null,
  options: Pick<CheckCommandOptions, "allowBreaking" | "config">
): { kind: "failure" | "warning"; message: string } | null {
  if (count === 0 || versionCoversBreaking(baseVersion, headVersion)) {
    return null;
  }
  const changes = plural(count, "breaking change");
  if (options.allowBreaking) {
    return { kind: "warning", message: `${changes} allowed by --allow-breaking.` };
  }
  if (options.config.diff?.failOnBreaking === false) {
    return { kind: "warning", message: `${changes} reported only: diff.failOnBreaking is false.` };
  }
  if (!parseSemver(baseVersion) || !parseSemver(headVersion)) {
    return {
      kind: "failure",
      message: `${changes} and the contract version is not semver MAJOR.MINOR.PATCH (base ${baseVersion ?? "-"}, head ${headVersion ?? "-"}). Use semver and bump the major version (or the minor version while it is 0.x).`,
    };
  }
  return {
    kind: "failure",
    message: `${changes} without a major version bump (base ${baseVersion}, head ${headVersion}). Bump the major version (or the minor version while it is 0.x), or pass --allow-breaking.`,
  };
}

export async function runCheckCommand(options: CheckCommandOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const write = options.writeStdout ?? ((text: string) => process.stdout.write(text));

  try {
    const format = (options.format ?? "text") as CheckFormat;
    if (!CHECK_FORMATS.includes(format)) {
      throw new CheckUsageError(
        `Unknown --format '${options.format}'. Supported: ${CHECK_FORMATS.join(", ")}.`
      );
    }
    if (options.base !== undefined && options.baseSpec !== undefined) {
      throw new CheckUsageError("Pass only one of --base and --base-spec.");
    }

    // 1. Generate in memory through the `apifn generate` code path.
    let generated: OpenAPIDocument;
    try {
      ({ doc: generated } = await buildSpecFromRouter({
        routerPath: options.routerPath,
        cwd,
        config: options.config,
      }));
    } catch (error) {
      throw new CheckUsageError(`Failed to generate the spec from the router: ${errorMessage(error)}`);
    }
    const specPath = resolveSpecPath({ specPath: options.specPath, cwd, config: options.config });
    const reportPath =
      options.reportPath === undefined ? undefined : path.resolve(cwd, options.reportPath);
    if (reportPath !== undefined && (await sameFile(reportPath, specPath))) {
      throw new CheckUsageError(
        `--report ${options.reportPath} is the spec itself; write the report to another file.`
      );
    }

    // The head document is what `apifn generate` would commit, read back.
    const head = parseYaml(serializeSpec(generated)) as OpenAPIDocument;
    const failures: string[] = [];
    const warnings: string[] = [];
    const specLabel = path.relative(cwd, specPath).split(path.sep).join("/") || specPath;

    const base = await loadBase(options, specPath, cwd);

    // 2. Drift.
    const committed = await readCommittedSpec(specPath);
    let driftState: DriftState;
    if (committed.state === "present") {
      driftState = canonicalJson(committed.doc) === canonicalJson(head) ? "none" : "stale";
    } else {
      driftState = committed.state;
    }
    const drift = driftState !== "none";
    let written = false;
    if (drift && options.write) {
      try {
        await mkdir(path.dirname(specPath), { recursive: true });
        await writeFile(specPath, serializeForPath(generated, specPath), "utf8");
      } catch (error) {
        throw new CheckUsageError(`Failed to write spec ${specPath}: ${errorMessage(error)}`);
      }
      written = true;
      warnings.push(`Rewrote ${specLabel} from the router (--write).`);
    } else if (drift) {
      const problem = DRIFT_PROBLEMS[driftState];
      failures.push(
        `Committed spec ${specLabel} ${problem}. Run \`apifn check --write\` or \`apifn generate\` and commit it.`
      );
    }

    // 3. Validate (the validator dereferences in place, so give it a copy).
    let validationErrors: CheckReport["validationErrors"];
    try {
      const errors = await validateOpenAPI(parseOpenAPI(structuredClone(head) as never));
      validationErrors = errors
        .filter((e) => e.severity === "error")
        .map((e) => ({ path: e.path, message: e.message }));
    } catch (error) {
      validationErrors = [{ path: "openapi", message: errorMessage(error) }];
    }
    const valid = validationErrors.length === 0;
    if (!valid) {
      failures.push(`Generated spec is invalid (${plural(validationErrors.length, "error")}).`);
    }

    // 4. Diff against the base (loaded before any write, so a load error changes nothing).
    const headVersion = infoVersion(head);
    const baseVersion = base.doc ? infoVersion(base.doc) : null;
    let diff: CheckReport["diff"] = null;
    if (base.doc) {
      try {
        const result = diffOpenAPI(base.doc, parseOpenAPI(structuredClone(head) as never));
        diff = { summary: result.summary, breaking: result.breaking, nonBreaking: result.nonBreaking };
      } catch (error) {
        if (valid) {
          throw new CheckUsageError(`Failed to diff against the base spec: ${errorMessage(error)}`);
        }
        // The invalid head is already a failure; report it instead of the diff crash.
        failures.push(`Diff against the base skipped: the generated spec is invalid (${errorMessage(error)}).`);
      }
    }

    // 5. Version rule (D7).
    const breaking = diff?.breaking ?? [];
    const breakingProblem = breakingVerdict(breaking.length, baseVersion, headVersion, options);
    if (breakingProblem?.kind === "failure") failures.push(breakingProblem.message);
    if (breakingProblem?.kind === "warning") warnings.push(breakingProblem.message);
    if (breaking.length === 0 && diff && diff.nonBreaking.length > 0 && baseVersion === headVersion) {
      warnings.push(
        `${plural(diff.nonBreaking.length, "non-breaking change")} with an unchanged contract version (${headVersion ?? "-"}).`
      );
    }

    const report: CheckReport = {
      drift,
      valid,
      breaking,
      versions: { base: baseVersion, head: headVersion },
      verdict: verdictOf(failures, warnings),
      diff,
      spec: specLabel,
      driftState,
      written,
      validationErrors,
      base: {
        source: base.source,
        ref: base.ref,
        status: baseStatus(base, diff !== null),
      },
      failures,
      warnings,
    };

    const rendered = renderReport(report, format);
    if (reportPath !== undefined) {
      try {
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, rendered, "utf8");
      } catch (error) {
        throw new CheckUsageError(`Failed to write report ${reportPath}: ${errorMessage(error)}`);
      }
    }
    write(rendered);

    return report.verdict === "fail" ? 1 : 0;
  } catch (error) {
    if (error instanceof CheckUsageError) {
      options.output.error(error.message);
      return 2;
    }
    options.output.error(`apifn check failed: ${errorMessage(error)}`);
    return 2;
  }
}
