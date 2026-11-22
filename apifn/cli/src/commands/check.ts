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
 * Four rules hold the command together, each in its own module:
 * - baseline identity (check-git.ts): the git base is the blob one pinned commit holds at the
 *   spec's path; every git failure exits 2;
 * - validated comparison (check-compare.ts): the base must pass the validator, and both sides
 *   are dereferenced before they are diffed;
 * - faithful bounded parsing (check-parse.ts): committed, base and generated documents go
 *   through one strict parser with size budgets;
 * - safe publication (check-publish.ts): nothing is written until every exit-2 path has passed;
 *   outputs never land on inputs, are renamed into place and rolled back on a later failure.
 *
 * Exit codes: 0 pass (warnings allowed) · 1 drift, invalid spec or a breaking change the version
 * rule does not cover · 2 usage or load error (message on stderr, no report, nothing written).
 */

import path from "node:path";
import { diffOpenAPI } from "@apifn/core";
import type { OpenAPIDocument } from "@apifn/core";
import type { ApifnConfig } from "../config.js";
import type { Output } from "../utils/output.js";
import { buildSpecFromRouter, resolveSpecPath, serializeSpec } from "./generate.js";
import { comparable, validationErrorsOf } from "./check-compare.js";
import type { ValidationProblem } from "./check-compare.js";
import { readSpecAtRef } from "./check-git.js";
import { fetchBounded, isHttpUrl, readBoundedFile } from "./check-io.js";
import { MAX_SPEC_BYTES, canonicalJson, parseContract } from "./check-parse.js";
import type { JsonObject } from "./check-parse.js";
import { CheckUsageError, errorMessage, isMissingPath } from "./check-paths.js";
import { assertSeparateFiles, observe, publish } from "./check-publish.js";
import type { FileState, NamedFile, Observed, PlannedOutput, PublishHook } from "./check-publish.js";
import { CHECK_FORMATS, plural, renderReport } from "./check-report.js";
import type { CheckFormat, CheckReport, CheckVerdict, DriftState } from "./check-report.js";

export {
  CHECK_FORMATS,
  CHECK_REPORT_MARKER,
  formatCheckJson,
  formatCheckMarkdown,
  formatCheckText,
} from "./check-report.js";
export type { CheckFormat, CheckReport, CheckVerdict, DriftState } from "./check-report.js";
export { MAX_EXPANDED_SPEC_BYTES, MAX_EXPANDED_SPEC_NODES, MAX_SPEC_BYTES, canonicalJson, parseContract } from "./check-parse.js";

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
  /** The config file `config` was loaded from; no output may land on it. */
  configFile?: string;
  output: Output;
  /** Writes the report to stdout; a returned promise must settle once the write has completed. */
  writeStdout?: (text: string) => void | Promise<void>;
  /** Called between the publisher's steps (tests change the filesystem there). */
  publishHook?: PublishHook;
  /** Total time for an HTTP(S) --base-spec, body included (default 30 s). */
  httpTimeoutMs?: number;
}

const DRIFT_PROBLEMS: Record<DriftState, string> = {
  none: "matches the router",
  missing: "does not exist",
  unparseable: "cannot be read as YAML or JSON with a faithful JSON form",
  stale: "differs from the spec generated from the router",
};

// ---------------------------------------------------------------------------
// Semver and the version rule (D7)
// ---------------------------------------------------------------------------

const SEMVER_CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE_ID = /^(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)$/;
const BUILD_ID = /^[0-9a-zA-Z-]+$/;

export interface SemverCore {
  major: bigint;
  minor: bigint;
  patch: bigint;
}

/** Parses a semver 2.0 version (MAJOR.MINOR.PATCH[-pre-release][+build]); anything else is null. */
export function parseSemver(version: string | null | undefined): SemverCore | null {
  if (typeof version !== "string") return null;
  const plus = version.indexOf("+");
  const build = plus === -1 ? null : version.slice(plus + 1);
  const withoutBuild = plus === -1 ? version : version.slice(0, plus);
  const dash = withoutBuild.indexOf("-");
  const prerelease = dash === -1 ? null : withoutBuild.slice(dash + 1);
  const core = SEMVER_CORE.exec(dash === -1 ? withoutBuild : withoutBuild.slice(0, dash));
  if (!core) return null;
  if (prerelease !== null && !prerelease.split(".").every((id) => PRERELEASE_ID.test(id))) return null;
  if (build !== null && !build.split(".").every((id) => BUILD_ID.test(id))) return null;
  return { major: BigInt(core[1]), minor: BigInt(core[2]), patch: BigInt(core[3]) };
}

/** D7: a breaking change is covered by a major bump, or by a minor bump while both majors are 0. */
export function versionCoversBreaking(base: string | null, head: string | null): boolean {
  const b = parseSemver(base);
  const h = parseSemver(head);
  if (!b || !h) return false;
  if (h.major > b.major) return true;
  return b.major === 0n && h.major === 0n && h.minor > b.minor;
}

function infoVersion(doc: JsonObject | null): string | null {
  const info = doc?.info;
  if (info === null || typeof info !== "object" || Array.isArray(info)) return null;
  return typeof info.version === "string" ? info.version : null;
}

/**
 * Applies D7 to the breaking changes: null when there are none or the version bump covers them,
 * a warning when they are allowed, otherwise a failure.
 */
function breakingVerdict(
  count: number,
  versions: CheckReport["versions"],
  options: Pick<CheckCommandOptions, "allowBreaking" | "config">
): { kind: "failure" | "warning"; message: string } | null {
  if (count === 0 || versionCoversBreaking(versions.base, versions.head)) return null;
  const changes = plural(count, "breaking change");
  if (options.allowBreaking) {
    return { kind: "warning", message: `${changes} allowed by --allow-breaking.` };
  }
  if (options.config.diff?.failOnBreaking === false) {
    return { kind: "warning", message: `${changes} reported only: diff.failOnBreaking is false.` };
  }
  const shown = `base ${versions.base ?? "-"}, head ${versions.head ?? "-"}`;
  if (!parseSemver(versions.base) || !parseSemver(versions.head)) {
    return {
      kind: "failure",
      message: `${changes} and the contract version is not semver MAJOR.MINOR.PATCH (${shown}). Use semver and bump the major version (or the minor version while it is 0.x).`,
    };
  }
  return {
    kind: "failure",
    message: `${changes} without a major version bump (${shown}). Bump the major version (or the minor version while it is 0.x), or pass --allow-breaking.`,
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

interface RunInputs {
  specPath: string;
  specLabel: string;
  generated: OpenAPIDocument;
  routerFile: string;
  /** A local --base-spec file (never an HTTP URL). */
  baseSpecFile?: string;
  reportPath?: string;
}

function checkedFormat(options: CheckCommandOptions): CheckFormat {
  const format = (options.format ?? "text") as CheckFormat;
  if (!CHECK_FORMATS.includes(format)) {
    throw new CheckUsageError(`Unknown --format '${options.format}'. Supported: ${CHECK_FORMATS.join(", ")}.`);
  }
  if (options.base !== undefined && options.baseSpec !== undefined) {
    throw new CheckUsageError("Pass only one of --base and --base-spec.");
  }
  return format;
}

async function generate(options: CheckCommandOptions, cwd: string): Promise<RunInputs> {
  let built: Awaited<ReturnType<typeof buildSpecFromRouter>>;
  try {
    built = await buildSpecFromRouter({ routerPath: options.routerPath, cwd, config: options.config });
  } catch (error) {
    throw new CheckUsageError(`Failed to generate the spec from the router: ${errorMessage(error)}`);
  }
  const specPath = resolveSpecPath({ specPath: options.specPath, cwd, config: options.config });
  const local = options.baseSpec !== undefined && !isHttpUrl(options.baseSpec);
  return {
    specPath,
    specLabel: path.relative(cwd, specPath).split(path.sep).join("/") || specPath,
    generated: built.doc,
    routerFile: built.routerFile,
    baseSpecFile: local ? path.resolve(cwd, options.baseSpec as string) : undefined,
    reportPath: options.reportPath === undefined ? undefined : path.resolve(cwd, options.reportPath),
  };
}

interface Targets {
  spec: Observed;
  report?: Observed;
}

/** No output of the run may land on a file it reads or on the other output. */
function assertOutputsSeparate(options: CheckCommandOptions, inputs: RunInputs, targets: Targets, cwd: string): void {
  const shown = (file: string) => path.relative(cwd, file) || file;
  const spec: NamedFile = { role: "the spec itself", file: inputs.specPath };
  const sources: NamedFile[] = [{ role: `the router module ${shown(inputs.routerFile)}`, file: inputs.routerFile }];
  if (options.configFile !== undefined) {
    sources.push({ role: `the config file ${shown(options.configFile)}`, file: options.configFile });
  }
  if (inputs.baseSpecFile !== undefined) {
    sources.push({ role: `the --base-spec file ${options.baseSpec}`, file: inputs.baseSpecFile });
  }
  const checks: Parameters<typeof assertSeparateFiles>[0] = [];
  if (inputs.reportPath !== undefined && targets.report !== undefined) {
    const output = { role: `--report ${options.reportPath}`, file: inputs.reportPath };
    checks.push({ output, at: targets.report, others: [spec, ...sources] });
  }
  if (options.write) {
    const output = { role: `--write (spec ${inputs.specLabel})`, file: inputs.specPath };
    checks.push({ output, at: targets.spec, others: sources });
  }
  assertSeparateFiles(checks);
}

type CommittedSpec =
  | { state: "present"; doc: JsonObject; raw: string; observed: FileState }
  | { state: "unparseable"; raw: string | null; observed: FileState }
  | { state: "missing"; observed: null };

function readCommittedSpec(specPath: string): CommittedSpec {
  let read: ReturnType<typeof readBoundedFile>;
  try {
    read = readBoundedFile(specPath);
  } catch (error) {
    if (isMissingPath(error)) return { state: "missing", observed: null };
    throw new CheckUsageError(`Failed to read spec ${specPath}: ${errorMessage(error)}`);
  }
  if (read.text === null) return { state: "unparseable", raw: null, observed: read.state };
  try {
    return { state: "present", doc: parseContract(read.text), raw: read.text, observed: read.state };
  } catch {
    return { state: "unparseable", raw: read.text, observed: read.state };
  }
}

interface BaseSpec {
  source: CheckReport["base"]["source"];
  ref: string | null;
  /** The base as read, or null for a new contract or no base. */
  doc: JsonObject | null;
  /** The validated, dereferenced form the differ reads. */
  comparable: OpenAPIDocument | null;
}

async function readBaseText(options: CheckCommandOptions, inputs: RunInputs): Promise<string> {
  const ref = options.baseSpec as string;
  try {
    if (inputs.baseSpecFile === undefined) {
      return await fetchBounded(ref, options.httpTimeoutMs);
    }
    const { text } = readBoundedFile(inputs.baseSpecFile);
    if (text === null) throw new Error(`the file is larger than ${MAX_SPEC_BYTES} bytes`);
    return text;
  } catch (error) {
    throw new CheckUsageError(`Failed to load base spec '${ref}': ${errorMessage(error)}`);
  }
}

/** Parses, dereferences and validates a base; any problem is a load error (exit 2). */
async function acceptBase(text: string, label: string): Promise<{ doc: JsonObject; comparable: OpenAPIDocument }> {
  let doc: JsonObject;
  let form: OpenAPIDocument;
  try {
    doc = parseContract(text);
    // Dereferenced first: it rejects references that leave the document, which the validator
    // would otherwise fetch.
    form = comparable(doc);
  } catch (error) {
    throw new CheckUsageError(`Failed to parse the base spec ${label}: ${errorMessage(error)}`);
  }
  const errors = await validationErrorsOf(doc);
  if (errors.length > 0) {
    const listed = errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join("; ");
    throw new CheckUsageError(`The base spec ${label} is invalid (${plural(errors.length, "error")}): ${listed}`);
  }
  return { doc, comparable: form };
}

async function loadBase(options: CheckCommandOptions, inputs: RunInputs): Promise<BaseSpec> {
  if (options.base !== undefined) {
    const baseline = readSpecAtRef(options.base, inputs.specPath);
    if (baseline.text === null) {
      return { source: "git", ref: options.base, doc: null, comparable: null };
    }
    const accepted = await acceptBase(baseline.text, `at ${options.base} (${baseline.path})`);
    return { source: "git", ref: options.base, ...accepted };
  }
  if (options.baseSpec !== undefined) {
    const accepted = await acceptBase(await readBaseText(options, inputs), `'${options.baseSpec}'`);
    return { source: "file", ref: options.baseSpec, ...accepted };
  }
  return { source: "none", ref: null, doc: null, comparable: null };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface Head {
  /** The generated document as `apifn generate` writes it, read back; null when unfaithful. */
  doc: JsonObject | null;
  yaml: string;
  validationErrors: ValidationProblem[];
}

async function readHead(generated: OpenAPIDocument): Promise<Head> {
  const yaml = serializeSpec(generated);
  let doc: JsonObject;
  try {
    doc = parseContract(yaml);
  } catch (error) {
    const message = `The generated spec has no faithful JSON form: ${errorMessage(error)}`;
    return { doc: null, yaml, validationErrors: [{ path: "openapi", message }] };
  }
  return { doc, yaml, validationErrors: await validationErrorsOf(doc) };
}

function driftOf(committed: CommittedSpec, head: Head): DriftState {
  if (committed.state !== "present") return committed.state;
  if (head.doc === null) return "stale";
  return canonicalJson(committed.doc) === canonicalJson(head.doc) ? "none" : "stale";
}

/**
 * `--write` keeps the committed file's format, told by its content: text that JSON.parse accepts
 * is JSON (flow-style YAML such as `{openapi: 3.1.0}` is not), other text that parsed is YAML, and
 * anything else (missing, too large, neither) follows the suffix of `destination`, the file the
 * publisher writes (a symlinked spec is written at its target, so the target's suffix decides).
 */
function repairText(head: Head, destination: string, committed: CommittedSpec): string {
  return repairAsJson(destination, committed) ? `${JSON.stringify(head.doc, null, 2)}\n` : head.yaml;
}

function isJsonText(raw: string): boolean {
  try {
    // A leading byte-order mark is not JSON whitespace, but editors write one.
    JSON.parse(raw.replace(/^\uFEFF/, ""));
    return true;
  } catch {
    return false;
  }
}

function repairAsJson(destination: string, committed: CommittedSpec): boolean {
  if (committed.state !== "missing" && typeof committed.raw === "string" && isJsonText(committed.raw)) return true;
  if (committed.state === "present") return false;
  return /\.json$/i.test(destination);
}

/** Diffs the dereferenced base and head. */
function compare(base: BaseSpec, head: Head, failures: string[]): CheckReport["diff"] {
  if (base.comparable === null || head.doc === null) return null;
  const valid = head.validationErrors.length === 0;
  try {
    const result = diffOpenAPI(base.comparable, comparable(head.doc));
    return { summary: result.summary, breaking: result.breaking, nonBreaking: result.nonBreaking };
  } catch (error) {
    if (valid) {
      throw new CheckUsageError(`Failed to diff against the base spec: ${errorMessage(error)}`);
    }
    // The invalid head is already a failure; report it instead of the diff crash.
    failures.push(`Diff against the base skipped: the generated spec is invalid (${errorMessage(error)}).`);
    return null;
  }
}

function baseStatus(base: BaseSpec, diffed: boolean): CheckReport["base"]["status"] {
  if (base.source === "none") return "none";
  if (base.doc === null) return "new-contract";
  return diffed ? "compared" : "skipped";
}

function verdictOf(failures: string[], warnings: string[]): CheckVerdict {
  if (failures.length > 0) return "fail";
  return warnings.length > 0 ? "warn" : "pass";
}

interface Evaluation {
  report: CheckReport;
  /** The --write repair, or null when nothing is rewritten. */
  repair: string | null;
}

function evaluate(
  options: CheckCommandOptions,
  inputs: RunInputs,
  base: BaseSpec,
  committed: CommittedSpec,
  head: Head,
  specDestination: string
): Evaluation {
  const failures: string[] = [];
  const warnings: string[] = [];

  // 2. Drift: a repair is written only when the generated spec has a faithful form.
  const driftState = driftOf(committed, head);
  const drift = driftState !== "none";
  const repair = drift && options.write && head.doc !== null ? repairText(head, specDestination, committed) : null;
  if (drift && repair === null) {
    failures.push(
      `Committed spec ${inputs.specLabel} ${DRIFT_PROBLEMS[driftState]}. Rerun this check with --write, then commit the spec.`
    );
  }

  // 3. Validation.
  const valid = head.validationErrors.length === 0;
  if (!valid) {
    failures.push(`Generated spec is invalid (${plural(head.validationErrors.length, "error")}).`);
  }

  // 4. Diff.
  const diff = compare(base, head, failures);
  if (repair !== null) warnings.push(`Rewrote ${inputs.specLabel} from the router (--write).`);

  // 5. Version rule (D7).
  const versions = { base: infoVersion(base.doc), head: infoVersion(head.doc) };
  const breaking = diff?.breaking ?? [];
  const breakingProblem = breakingVerdict(breaking.length, versions, options);
  if (breakingProblem?.kind === "failure") failures.push(breakingProblem.message);
  if (breakingProblem?.kind === "warning") warnings.push(breakingProblem.message);
  if (breaking.length === 0 && diff && diff.nonBreaking.length > 0 && versions.base === versions.head) {
    const changes = plural(diff.nonBreaking.length, "non-breaking change");
    warnings.push(`${changes} with an unchanged contract version (${versions.head ?? "-"}).`);
  }

  const report: CheckReport = {
    drift,
    valid,
    breaking,
    versions,
    verdict: verdictOf(failures, warnings),
    diff,
    spec: inputs.specLabel,
    driftState,
    written: repair !== null,
    validationErrors: head.validationErrors,
    base: { source: base.source, ref: base.ref, status: baseStatus(base, diff !== null) },
    failures,
    warnings,
  };
  return { report, repair };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Writes to process.stdout and settles once the write has completed or failed: a closed pipe
 * (EPIPE) is reported through the callback or an 'error' event after write() returned.
 */
function writeProcessStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = process.stdout;
    // Stays attached after a failure, so a later 'error' event is not an uncaught exception.
    const onError = (error: Error) => reject(error);
    stream.on("error", onError);
    stream.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      stream.off("error", onError);
      resolve();
    });
  });
}

export async function runCheckCommand(options: CheckCommandOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const writeStdout = options.writeStdout ?? writeProcessStdout;

  try {
    const format = checkedFormat(options);
    // 1. Generate in memory through the `apifn generate` code path.
    const inputs = await generate(options, cwd);
    const reportTarget = inputs.reportPath === undefined ? undefined : observe(inputs.reportPath);
    const specTarget = observe(inputs.specPath);
    assertOutputsSeparate(options, inputs, { spec: specTarget, report: reportTarget }, cwd);

    const base = await loadBase(options, inputs);
    const committed = readCommittedSpec(inputs.specPath);
    const head = await readHead(inputs.generated);
    const { report, repair } = evaluate(options, inputs, base, committed, head, specTarget.destination);
    const rendered = renderReport(report, format);

    // Every exit-2 path above has passed: publish the report file, then the repair, then stdout.
    const outputs: PlannedOutput[] = [];
    if (reportTarget !== undefined) {
      outputs.push({
        option: `--report ${options.reportPath}`,
        noun: "report",
        file: inputs.reportPath as string,
        target: reportTarget,
        observed: reportTarget.state,
        text: rendered,
      });
    }
    if (repair !== null) {
      outputs.push({
        option: "--write",
        noun: "spec",
        file: inputs.specPath,
        target: specTarget,
        observed: committed.observed,
        text: repair,
      });
    }
    await publish(outputs, () => writeStdout(rendered), options.publishHook);

    return report.verdict === "fail" ? 1 : 0;
  } catch (error) {
    const message = error instanceof CheckUsageError ? error.message : `apifn check failed: ${errorMessage(error)}`;
    options.output.error(message);
    return 2;
  }
}
