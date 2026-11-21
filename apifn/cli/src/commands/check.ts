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
import { lstat, mkdir, readFile, readlink, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, parseDocument, visit, isAlias, isCollection, isPair, isScalar } from "yaml";
import type { Alias, Node as YamlNode } from "yaml";
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
  unparseable: "cannot be read as YAML or JSON with a faithful JSON form",
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

/** The nearest ancestor of `target` (itself excluded) that exists, symlinks followed. */
function nearestExistingDir(target: string): string {
  let dir = path.dirname(target);
  while (!existsSync(dir) && path.dirname(dir) !== dir) {
    dir = path.dirname(dir);
  }
  return dir;
}

/**
 * Spellings of `target` in canonical directories: the leaf (and any missing components) as given
 * below the native realpath of the nearest existing directory, plus the native realpath of the
 * file itself when it exists (a leaf symlink followed, the on-disk case and Unicode form).
 */
function canonicalSpellings(target: string): string[] {
  const dir = nearestExistingDir(target);
  const spellings = [path.join(realpathSync.native(dir), path.relative(dir, target))];
  if (existsSync(target)) {
    spellings.unshift(realpathSync.native(target));
  }
  return spellings;
}

/**
 * The spec path as given (resolved, no symlink followed) relative to the logical repository root:
 * the deepest existing ancestor whose native realpath is the repository's. This is the path the
 * caller names even when an in-repository directory on the way is a symlink, and a symlinked
 * prefix above the repository (such as /var -> /private/var) still maps. Null when no ancestor is
 * the repository root, so a literal spelling that leaves the repository adds no candidate.
 */
function literalRepoPath(target: string, root: string): string | null {
  const resolved = path.resolve(target);
  let dir = path.dirname(resolved);
  for (;;) {
    let real: string | null = null;
    try {
      real = realpathSync.native(dir);
    } catch {
      real = null;
    }
    if (real === root) {
      const relative = path.relative(dir, resolved).split(path.sep).join("/");
      return relative === "" || relative.startsWith("../") ? null : relative;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** NFC plus case folding: the key under which a case-insensitive filesystem treats names as one. */
function foldPath(value: string): string {
  return value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  path: string;
}

function parseTreeListing(listing: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const line of listing.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object] = line.slice(0, tab).split(" ");
    entries.push({ mode, type, object, path: line.slice(tab + 1) });
  }
  return entries;
}

/**
 * Reads the spec as committed at `ref`. Git resolves the ref once to a commit; every later call
 * uses that commit. Every path the spec may have been tracked under is a candidate: the path as
 * given relative to the repository root (an in-repository symlinked directory not followed), the
 * path as given and the file a write to it lands on (symlinks followed, dangling ones included), each in
 * its canonical directory spelling, and, when the repository ignores case, any tracked path equal
 * to a candidate under NFC and case folding. Returns null (a new contract) only when git lists no
 * entry for any candidate in that commit. Several distinct matching blobs, a match that is not a
 * regular file, or any git failure is an error.
 */
async function readSpecAtRef(ref: string, specPath: string): Promise<string | null> {
  if (ref.length === 0 || ref.startsWith("-")) {
    throw new CheckUsageError(`Invalid git ref '${ref}'`);
  }

  // The repository is the one holding the spec path as given.
  const dir = nearestExistingDir(specPath);
  const toplevelResult = await runGit(["rev-parse", "--show-toplevel"], dir);
  if (toplevelResult.code !== 0) {
    throw new CheckUsageError(
      `--base needs a git work tree; ${dir} is not inside one: ${toplevelResult.stderr.trim()}`
    );
  }
  const root = realpathSync.native(toplevelResult.stdout.trim());
  const inRepo = (absolute: string): string | null => {
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (relative === "" || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      return null;
    }
    return relative;
  };

  // The file the check reads and --write writes must be inside the repository.
  const destination = await writeDestination(specPath);
  const destinationSpellings = canonicalSpellings(destination);
  if (inRepo(destinationSpellings[0]) === null) {
    throw new CheckUsageError(
      `Spec ${specPath} (${destinationSpellings[0]}) is outside the git repository at ${root}`
    );
  }
  const literal = literalRepoPath(specPath, root);
  const candidates = [
    ...new Set(
      [
        ...[...destinationSpellings, ...canonicalSpellings(specPath)].map(inRepo),
        literal,
      ].filter((relative): relative is string => relative !== null)
    ),
  ];

  const resolved = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  if (resolved.code !== 0) {
    throw new CheckUsageError(
      `Unknown git ref '${ref}'${resolved.stderr.trim() ? `: ${resolved.stderr.trim()}` : ""}`
    );
  }
  const commit = resolved.stdout.trim();

  // --literal-pathspecs: each candidate is a path, never a pathspec pattern.
  const exact = parseTreeListing(
    await gitOk(["--literal-pathspecs", "ls-tree", "-z", commit, "--", ...candidates], root)
  ).filter((entry) => candidates.includes(entry.path));
  const matches = new Map(exact.map((entry) => [entry.path, entry]));

  const ignoreCase = await runGit(["config", "--type=bool", "--get", "core.ignorecase"], root);
  if (ignoreCase.code === 0 && ignoreCase.stdout.trim() === "true") {
    const folded = new Set(candidates.map(foldPath));
    const all = parseTreeListing(await gitOk(["ls-tree", "-r", "-z", "--full-tree", commit], root));
    for (const entry of all) {
      if (folded.has(foldPath(entry.path))) matches.set(entry.path, entry);
    }
  }
  if (matches.size === 0) {
    return null;
  }

  const files = [...matches.values()].filter(
    (entry) => entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")
  );
  const blobs = new Map(files.map((entry) => [entry.object, entry]));
  if (blobs.size > 1) {
    throw new CheckUsageError(
      `The spec matches several different files at ${ref} (${commit}): ${files.map((e) => e.path).join(", ")}. Pass --spec with the tracked path.`
    );
  }
  if (blobs.size === 0) {
    const entry = [...matches.values()][0];
    const kind = entry.mode === "120000" ? "symbolic link" : entry.type;
    throw new CheckUsageError(`${entry.path} at ${ref} (${commit}) is a ${kind}, not a spec file`);
  }
  const [entry] = blobs.values();
  return gitOk(["show", `${commit}:${entry.path}`], root);
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

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

/**
 * The most nodes a committed or base spec may hold once its YAML aliases are expanded. The yaml
 * package's default guard (`maxAliasCount: 100`) rejects any spec that `apifn generate` wrote
 * for a router reusing one object (a shared `security` array, say) more than about 100 times,
 * so the check bounds the expanded size instead: linear to measure, and far above any real spec.
 */
export const MAX_EXPANDED_SPEC_NODES = 5_000_000;

/**
 * Number of nodes the document expands to, every alias replaced by its anchored node. Rejects a
 * mapping key that is an alias or a collection: the yaml package checks key uniqueness on the
 * key nodes as written, so an alias key resolving to a literal key beside it would pass and one
 * of the two values would be lost when the mapping becomes JSON.
 */
function expandedNodeCount(doc: ReturnType<typeof parseDocument>): number {
  // An alias names the last node with that anchor before it in document order.
  const anchors = new Map<string, YamlNode>();
  const targets = new Map<Alias, YamlNode | undefined>();
  visit(doc, (_key, node) => {
    if (isPair(node) && (isAlias(node.key) || isCollection(node.key))) {
      const kind = isAlias(node.key) ? `the alias *${node.key.source}` : "a collection";
      throw new Error(`a mapping key is ${kind}, which JSON cannot represent faithfully`);
    }
    if (isAlias(node)) {
      targets.set(node, anchors.get(node.source));
    } else if ((isCollection(node) || isScalar(node)) && node.anchor) {
      anchors.set(node.anchor, node);
    }
  });

  const sizes = new Map<unknown, number>();
  const open = new Set<unknown>();
  const size = (node: unknown): number => {
    if (node === null || node === undefined) return 0;
    const known = sizes.get(node);
    if (known !== undefined) return known;
    if (open.has(node)) throw new Error("the YAML aliases form a cycle");
    open.add(node);
    let total: number;
    if (isAlias(node)) {
      const target = targets.get(node);
      if (!target) throw new Error(`unresolved alias *${node.source}`);
      total = size(target);
    } else if (isPair(node)) {
      total = size(node.key) + size(node.value);
    } else if (isCollection(node)) {
      total = 1;
      for (const item of node.items) total += size(item);
    } else {
      total = 1;
    }
    open.delete(node);
    sizes.set(node, total);
    return total;
  };
  return size(doc.contents);
}

/**
 * The one parser for a committed or base spec, YAML or JSON (which YAML 1.2 contains): duplicate
 * mapping keys are an error (JSON.parse would silently keep the last one), aliases are allowed in
 * any number, but the expanded document must stay under MAX_EXPANDED_SPEC_NODES, be acyclic,
 * use no alias or collection as a mapping key and have a faithful JSON form (toFaithfulJson).
 */
function parseSpecText(raw: string): unknown {
  const doc = parseDocument(raw, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw doc.errors[0];
  }
  const nodes = expandedNodeCount(doc);
  if (nodes > MAX_EXPANDED_SPEC_NODES) {
    throw new Error(
      `the YAML aliases expand to ${nodes} nodes (limit ${MAX_EXPANDED_SPEC_NODES})`
    );
  }
  return toFaithfulJson(doc.toJS({ maxAliasCount: -1, mapAsMap: true }));
}

/**
 * Converts a parsed document to plain JSON values, failing when it has no faithful JSON form:
 * a non-finite number (YAML `.nan`, `.inf`, or an overflowing literal), a value that is not a
 * string, finite number, boolean, null, array or mapping (a Set, Date, BigInt, binary...), a
 * mapping key that is not a string or finite number, or two keys of one mapping that become the
 * same string (`1` and `"1"`). JSON.stringify would silently turn each of these into another
 * document, so comparing or diffing them would hide a difference. Aliased (shared) nodes are
 * converted once; the caller has already rejected alias cycles.
 */
export function toFaithfulJson(value: unknown): unknown {
  const converted = new Map<object, unknown>();
  const convert = (node: unknown, at: string): unknown => {
    if (node === null || typeof node === "string" || typeof node === "boolean") {
      return node;
    }
    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        throw new Error(`${at} is ${node}, which JSON cannot represent`);
      }
      return node;
    }
    if (typeof node !== "object") {
      throw new Error(`${at} is a ${typeof node}, which JSON cannot represent`);
    }
    const done = converted.get(node);
    if (done !== undefined) {
      return done;
    }
    let result: unknown;
    if (Array.isArray(node)) {
      result = node.map((item, index) => convert(item, `${at}[${index}]`));
    } else if (node instanceof Map) {
      const record: Record<string, unknown> = {};
      for (const [rawKey, item] of node) {
        let key: string;
        if (typeof rawKey === "string") {
          key = rawKey;
        } else if (typeof rawKey === "number" && Number.isFinite(rawKey)) {
          key = String(rawKey);
        } else {
          throw new Error(`${at} has a ${rawKey === null ? "null" : typeof rawKey} key, which JSON cannot represent`);
        }
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          throw new Error(`${at} has two keys that are both "${key}" in JSON`);
        }
        // defineProperty keeps a "__proto__" key as data.
        Object.defineProperty(record, key, {
          value: convert(item, `${at}.${key}`),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      result = record;
    } else {
      const kind = (node as { constructor?: { name?: string } }).constructor?.name ?? "object";
      throw new Error(`${at} is a ${kind}, which JSON cannot represent`);
    }
    converted.set(node, result);
    return result;
  };
  return convert(value, "$");
}

/** A base spec, read by parseSpecText (the committed spec's strict parser), then parseOpenAPI. */
function parseBaseSpec(raw: string): OpenAPIDocument {
  if (!raw.trim()) {
    return parseOpenAPI(raw);
  }
  let parsed: unknown;
  try {
    parsed = parseSpecText(raw);
  } catch (error) {
    throw new Error(`Invalid OpenAPI input: failed to parse JSON or YAML (${errorMessage(error)})`);
  }
  return parseOpenAPI(parsed as Record<string, unknown>);
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
    return { state: "present", doc: parseSpecText(raw) };
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

/**
 * Writes the --write repair and returns how to undo it: the previous bytes are written back,
 * or the file the write created is removed (at the destination a symlinked spec points to).
 */
async function writeSpecRepair(specPath: string, text: string): Promise<() => Promise<void>> {
  let previous: Buffer | null;
  let destination: string;
  try {
    destination = await writeDestination(specPath);
    try {
      previous = await readFile(destination);
    } catch (error) {
      if (!isMissingPath(error)) throw error;
      previous = null;
    }
    await mkdir(path.dirname(specPath), { recursive: true });
    await writeFile(specPath, text, "utf8");
  } catch (error) {
    throw new CheckUsageError(`Failed to write spec ${specPath}: ${errorMessage(error)}`);
  }
  return async () => {
    try {
      if (previous === null) {
        await unlink(destination);
      } else {
        await writeFile(destination, previous);
      }
    } catch (error) {
      throw new CheckUsageError(
        `Failed to restore spec ${specPath} after an error; it holds the --write repair: ${errorMessage(error)}`
      );
    }
  };
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The path a write to `target` lands on: every existing symlink on the way, the leaf included,
 * is followed as the kernel would; components that do not exist yet are kept as given.
 */
async function writeDestination(target: string): Promise<string> {
  const absolute = path.resolve(target);
  let resolved = path.parse(absolute).root;
  const pending = absolute.slice(resolved.length).split(path.sep);
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, part);
    let link: string | null = null;
    try {
      if ((await lstat(candidate)).isSymbolicLink()) {
        link = await readlink(candidate);
      }
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    if (link === null) {
      resolved = candidate;
      continue;
    }
    links += 1;
    if (links > 40) {
      throw new CheckUsageError(`Too many symbolic links in ${target}.`);
    }
    if (path.isAbsolute(link)) {
      resolved = path.parse(link).root;
      pending.unshift(...link.slice(resolved.length).split(path.sep));
    } else {
      pending.unshift(...link.split(path.sep));
    }
  }
  return resolved;
}

/**
 * True when a write to `a` may land on the file `b` names. Both are compared where they lead
 * after symlinks (even where the file or its directory does not exist yet), conservatively: under
 * NFC and case folding, so a case or Unicode alias counts as the same file even on a filesystem
 * that would keep them apart. Once both exist, the same inode (a hard link) also counts.
 */
async function mayAlias(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([writeDestination(a), writeDestination(b)]);
  if (foldPath(left) === foldPath(right)) {
    return true;
  }
  try {
    const [l, r] = await Promise.all([stat(a), stat(b)]);
    return l.dev === r.dev && l.ino === r.ino;
  } catch {
    return false;
  }
}

interface RunFiles {
  specPath: string;
  /** The spec is a write destination (--write). */
  writeSpec: boolean;
  reportPath?: string;
  /** A local --base-spec file (never an HTTP URL). */
  baseSpecPath?: string;
}

/**
 * No write destination of the run may alias another file the run reads or writes: the report
 * never lands on the spec or the base spec, and --write never lands on the base spec (a later run
 * would compare the head with itself). Checked before any write, and again before the report is
 * written once --write has created the spec.
 */
async function assertNoWriteAliasing(files: RunFiles, flags: { report: string; baseSpec?: string }): Promise<void> {
  if (files.reportPath !== undefined && (await mayAlias(files.reportPath, files.specPath))) {
    throw new CheckUsageError(`--report ${flags.report} is the spec itself; write the report to another file.`);
  }
  if (files.baseSpecPath === undefined) {
    return;
  }
  if (files.reportPath !== undefined && (await mayAlias(files.reportPath, files.baseSpecPath))) {
    throw new CheckUsageError(
      `--report ${flags.report} is the --base-spec file ${flags.baseSpec}; write the report to another file.`
    );
  }
  if (files.writeSpec && (await mayAlias(files.specPath, files.baseSpecPath))) {
    throw new CheckUsageError(
      `--write would rewrite the --base-spec file ${flags.baseSpec}; pass a base spec other than the spec itself.`
    );
  }
}

/** `--base-spec` names an HTTP(S) URL, which `loadSpec` fetches, rather than a local file. */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
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
      return { source: "git", ref: options.base, doc: parseBaseSpec(raw) };
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
      return { source: "file", ref: options.baseSpec, doc: parseBaseSpec(raw) };
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
    const runFiles: RunFiles = {
      specPath,
      writeSpec: options.write === true,
      reportPath,
      baseSpecPath:
        options.baseSpec === undefined || isHttpUrl(options.baseSpec)
          ? undefined
          : path.resolve(cwd, options.baseSpec),
    };
    const flags = { report: options.reportPath ?? "", baseSpec: options.baseSpec };
    await assertNoWriteAliasing(runFiles, flags);

    // The head document is what `apifn generate` would commit, read back.
    // It is this process's own output, so its aliases (one per reused object) are not limited.
    const head = parseYaml(serializeSpec(generated), { maxAliasCount: -1 }) as OpenAPIDocument;
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
    // The --write repair is published only after the base diff (step 4), once the run is known
    // to end in a verdict: every exit-2 path leaves the committed spec byte-for-byte unchanged.
    if (drift && !options.write) {
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

    // 4. Diff against the base (loaded and diffed before any write, so an error changes nothing).
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

    // Publish the --write repair now that only a verdict (exit 0 or 1) can follow; a later
    // exit-2 path (the report write) restores the spec.
    let restoreSpec: (() => Promise<void>) | undefined;
    if (drift && options.write) {
      restoreSpec = await writeSpecRepair(specPath, serializeForPath(generated, specPath));
      warnings.push(`Rewrote ${specLabel} from the router (--write).`);
    }
    const written = restoreSpec !== undefined;

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
        // --write may have just created the spec: check again now that both files can exist.
        await assertNoWriteAliasing(runFiles, flags);
        try {
          await mkdir(path.dirname(reportPath), { recursive: true });
          await writeFile(reportPath, rendered, "utf8");
        } catch (error) {
          throw new CheckUsageError(`Failed to write report ${reportPath}: ${errorMessage(error)}`);
        }
      } catch (error) {
        if (restoreSpec) {
          try {
            await restoreSpec();
          } catch (restoreError) {
            throw new CheckUsageError(`${errorMessage(error)} ${errorMessage(restoreError)}`);
          }
        }
        throw error;
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
