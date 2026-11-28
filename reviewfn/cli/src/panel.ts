import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { ComposioLinearContextAdapter } from "@superfunctions/reviewfn-context-composio";
import {
  CODE_REFERENCES_ADAPTER_ID, CodeReferencesContextAdapter, codeReferencesOptions, effectiveRetention, FileArtifactStore, isPanelReport, isolatedGitEnvironment, loadPanelPolicy, PANEL_REPORT_COPY_NAMES, panelReportCanceled, panelStructureIssues, PanelCoordinator, RepositoryMarkdownContextAdapter, renderMarkdownReport, renderPanelMarkdownReport,
  ReviewFnError, safeDirectory, safeRead, validateConfig, validatePolicy,
  type ArtifactStore, type ContextAdapter, type ExecutionAdapter, type PanelHarnessAdapter, type PanelPolicy, type PanelReport, type ReviewFnConfig, type ReviewPolicy, type ReviewReport,
} from "@superfunctions/reviewfn-core";
import { GitSourceControlAdapter, redactRepositoryRemote } from "@superfunctions/reviewfn-github";

import { loadConfig, loadPolicy, loadTrustedConfigFromBase, loadTrustedPolicyFromBase } from "./config.js";
import { LocalIsolatedExecutionAdapter } from "./execution.js";

const execFileAsync = promisify(execFile);

export type Flags = Map<string, string | true>;
export interface Arguments { command?: string; flags: Flags; positionals: string[] }

export function parseArguments(argv: string[]): Arguments {
  const [command, ...rest] = argv;
  const flags: Flags = new Map();
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const separator = value.indexOf("=");
    const name = value.slice(2, separator < 0 ? undefined : separator);
    const inline = separator < 0 ? undefined : value.slice(separator + 1);
    if (inline !== undefined) flags.set(name, inline);
    else if (rest[index + 1] && !rest[index + 1].startsWith("--")) flags.set(name, rest[++index]);
    else flags.set(name, true);
  }
  return { command, flags, positionals };
}

export function required(flags: Flags, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required.`);
  return value;
}

export function optional(flags: Flags, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/** Whether configuration is trusted only from the base revision: in GitHub Actions, or when asked. */
export function trustedFromBase(flags: Flags, environment: NodeJS.ProcessEnv = process.env): boolean {
  return flags.has("trusted-config-from-base") || environment.GITHUB_ACTIONS === "true";
}

/** The run configuration and review policy, from the base revision when trusted, otherwise from the working tree. */
export async function loadRunConfiguration(root: string, base: string, flags: Flags, environment: NodeJS.ProcessEnv = process.env): Promise<{ config: ReviewFnConfig; policy: ReviewPolicy }> {
  const trusted = trustedFromBase(flags, environment);
  const configRelative = optional(flags, "config") ?? ".reviewfn/config.json";
  const policyRelative = optional(flags, "policy") ?? ".reviewfn/policy.json";
  const config = trusted ? await loadTrustedConfigFromBase(root, base, configRelative) : await loadConfig(path.resolve(root, configRelative));
  const policy = trusted ? await loadTrustedPolicyFromBase(root, base, policyRelative) : await loadPolicy(path.resolve(root, policyRelative));
  if (config.output.mode !== policy.mode) throw new Error(`Configuration output mode ${config.output.mode} does not match trusted policy mode ${policy.mode}.`);
  return { config: validateConfig(config), policy: validatePolicy(policy) };
}

/**
 * The context adapters a configuration names. `code-references` takes its pairs and exclusions from the loaded panel
 * policy, and its defaults (no pairs, the default exclusions) without one.
 */
export function contextAdapters(config: ReviewFnConfig, panelPolicy?: PanelPolicy): ContextAdapter[] {
  const adapters = new Map<string, ContextAdapter>();
  for (const item of config.context) {
    if (item.adapter === "repository-markdown") adapters.set(item.adapter, new RepositoryMarkdownContextAdapter());
    else if (item.adapter === CODE_REFERENCES_ADAPTER_ID) adapters.set(item.adapter, new CodeReferencesContextAdapter(panelPolicy ? codeReferencesOptions(panelPolicy) : {}));
    else if (item.adapter === "composio-linear") adapters.set(item.adapter, new ComposioLinearContextAdapter());
  }
  return [...adapters.values()];
}

export interface ReviewSnapshot {
  /** A private clone checked out at `head`, without hooks, attribute filters or the original remote's credentials. */
  root: string;
  base: string;
  head: string;
  /** The target branch name, from `--target-branch`, the symbolic base, or `GITHUB_BASE_REF`. */
  targetBranch: string;
}

/** Resolve `ref` in `root` to a full commit ID. */
export async function resolveCommit(root: string, ref: string): Promise<string> {
  return (await execFileAsync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: root })).stdout.trim();
}

/**
 * Clone `root` into `<owned>/checkout` at the immutable head, as the review commands read it: no hooks, no attribute
 * filters, and a redacted remote.
 */
export async function createReviewSnapshot(root: string, owned: string, base: string, head: string, targetBranchFlag?: string, environment: NodeJS.ProcessEnv = process.env): Promise<ReviewSnapshot> {
  const snapshot = path.join(owned, "checkout");
  const snapshotEnvironment = isolatedGitEnvironment();
  const immutableHead = await resolveCommit(root, head);
  const immutableBase = await resolveCommit(root, base);
  await execFileAsync("git", ["-c", `core.hooksPath=${devNull}`, "clone", "--template=", "--no-local", "--no-checkout", root, snapshot], { env: snapshotEnvironment, maxBuffer: 1_000_000 });
  // info/attributes outranks every committed .gitattributes, including nested files.
  await mkdir(path.join(snapshot, ".git", "info"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(snapshot, ".git", "info", "attributes"), "* -text -eol -working-tree-encoding -filter -ident\n", { mode: 0o600 });
  await execFileAsync("git", ["-c", `core.hooksPath=${devNull}`, "-c", `core.attributesFile=${devNull}`, "-c", "core.autocrlf=false", "checkout", "--detach", immutableHead], { cwd: snapshot, env: snapshotEnvironment, maxBuffer: 1_000_000 });
  const remote = (await execFileAsync("git", ["config", "--get", "remote.origin.url"], { cwd: root }).catch(() => ({ stdout: "local" }))).stdout.trim();
  await execFileAsync("git", ["remote", "set-url", "origin", redactRepositoryRemote(remote)], { cwd: snapshot });
  const symbolicBase = (await execFileAsync("git", ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", base], { cwd: root })).stdout.trim();
  const targetBranch = targetBranchFlag ?? (symbolicBase.startsWith("refs/") ? symbolicBase.replace(/^refs\/(heads|remotes)\//, "") : environment.GITHUB_BASE_REF ?? "unknown");
  return { root: snapshot, base: immutableBase, head: immutableHead, targetBranch };
}

/** The closed set of `reviewfn panel` exit codes. The verdict never changes the exit code: panel output is advisory. */
export const PANEL_EXIT_CODES = Object.freeze({
  /** The run completed and its coverage is complete. */
  complete: 0,
  /** Any error not listed below. */
  error: 1,
  /** The run completed with incomplete coverage, or a stage's quorum was not met. */
  incomplete: 2,
  /** Preflight failed: configuration, panel policy, harness resolution or a component's preflight. */
  preflight: 3,
  /** The run was canceled. */
  canceled: 4,
});

/**
 * Supported harness adapters, by the `harness.adapter` a slot names: the package that provides it and the adapter class
 * it exports. Adapters are optional peer installs and are only ever loaded from this table, never from a module path.
 */
export const PANEL_HARNESS_PACKAGES: Readonly<Record<string, { packageName: string; exportName: string }>> = Object.freeze({
  codex: Object.freeze({ packageName: "@superfunctions/reviewfn-harness-codex", exportName: "CodexHarnessAdapter" }),
  "claude-code": Object.freeze({ packageName: "@superfunctions/reviewfn-harness-claude-code", exportName: "ClaudeCodeHarnessAdapter" }),
  cli: Object.freeze({ packageName: "@superfunctions/reviewfn-harness-cli", exportName: "CliHarnessAdapter" }),
});

/** Loads one package from `PANEL_HARNESS_PACKAGES` by name; the dynamic `import()` by default. */
export type HarnessModuleImporter = (packageName: string) => Promise<unknown>;

/** Options every harness adapter class receives from the CLI. */
export interface PanelHarnessConstructorOptions {
  /** The configured executable, for the adapter the run configuration names; the adapter's default otherwise. */
  executable?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface ResolvedPanelHarnesses {
  harnesses: PanelHarnessAdapter[];
  /** The adapter contract version of each adapter other than the configured one, read before any preflight. */
  contractVersions: Record<string, string>;
}

function moduleNotFound(error: unknown, packageName: string): boolean {
  const failure = error as { code?: unknown; message?: unknown } | undefined;
  // A missing dependency of an installed adapter is a broken install, not a missing adapter.
  return (failure?.code === "ERR_MODULE_NOT_FOUND" || failure?.code === "MODULE_NOT_FOUND") && typeof failure.message === "string" && failure.message.includes(`'${packageName}'`);
}

/**
 * Load and construct one adapter for each harness the panel's review slots name, through the fixed package table.
 * Fails with `REVIEWFN_HARNESS_NOT_INSTALLED` when an adapter's package is not installed, `REVIEWFN_HARNESS_UNSUPPORTED`
 * for an adapter the table does not name, and `REVIEWFN_HARNESS_LOAD_FAILED` for a package that does not provide a
 * usable adapter. Verifier slots are not run by this release, so their adapters are not loaded.
 */
export async function resolvePanelHarnesses(policy: PanelPolicy, config: ReviewFnConfig, importModule: HarnessModuleImporter = specifier => import(specifier), environment: NodeJS.ProcessEnv = process.env): Promise<ResolvedPanelHarnesses> {
  const bySlot = new Map<string, string[]>();
  for (const slot of policy.slots) if (slot.stage !== "verifier") bySlot.set(slot.harness.adapter, [...(bySlot.get(slot.harness.adapter) ?? []), slot.id]);
  const harnesses: PanelHarnessAdapter[] = [];
  const contractVersions: Record<string, string> = {};
  for (const [adapter, slots] of bySlot) {
    const entry = Object.hasOwn(PANEL_HARNESS_PACKAGES, adapter) ? PANEL_HARNESS_PACKAGES[adapter] : undefined;
    if (!entry) throw new ReviewFnError("REVIEWFN_HARNESS_UNSUPPORTED", `Slot(s) ${slots.join(", ")} name harness adapter ${JSON.stringify(adapter)}, which ReviewFn does not support. Supported adapters: ${Object.keys(PANEL_HARNESS_PACKAGES).join(", ")}.`, { adapter, slots });
    let loaded: unknown;
    try { loaded = await importModule(entry.packageName); }
    catch (error) {
      if (moduleNotFound(error, entry.packageName)) throw new ReviewFnError("REVIEWFN_HARNESS_NOT_INSTALLED", `Slot(s) ${slots.join(", ")} use the ${adapter} harness, but ${entry.packageName} is not installed. Install it next to @superfunctions/reviewfn-cli.`, { adapter, packageName: entry.packageName, slots });
      throw new ReviewFnError("REVIEWFN_HARNESS_LOAD_FAILED", `${entry.packageName} could not be loaded: ${error instanceof Error ? error.message : String(error)}`, { adapter, packageName: entry.packageName });
    }
    const constructor = (loaded as Record<string, unknown> | undefined)?.[entry.exportName];
    if (typeof constructor !== "function") throw new ReviewFnError("REVIEWFN_HARNESS_LOAD_FAILED", `${entry.packageName} does not export the adapter class ${entry.exportName}.`, { adapter, packageName: entry.packageName });
    const options: PanelHarnessConstructorOptions = { environment, ...(adapter === config.harness.adapter && config.harness.executable ? { executable: config.harness.executable } : {}) };
    const harness = new (constructor as new (options: PanelHarnessConstructorOptions) => PanelHarnessAdapter)(options);
    if (harness?.capabilities?.id !== adapter) throw new ReviewFnError("REVIEWFN_HARNESS_LOAD_FAILED", `${entry.packageName} provides harness ${String(harness?.capabilities?.id)}, not ${adapter}.`, { adapter, packageName: entry.packageName });
    // Read now: adapters such as Codex overwrite capabilities.version with the executable's version during preflight.
    if (adapter !== config.harness.adapter && typeof harness.capabilities.version === "string") contractVersions[adapter] = harness.capabilities.version;
    harnesses.push(harness);
  }
  return { harnesses, contractVersions };
}

/** Injection points for the panel command; the CLI uses the defaults. */
export interface PanelCommandDependencies {
  /** Loads harness packages named by `PANEL_HARNESS_PACKAGES`. */
  importHarnessModule?: HarnessModuleImporter;
  /** The trusted test execution; Docker-isolated execution by default. */
  execution?: (artifacts: ArtifactStore) => ExecutionAdapter;
  /** Aborting it cancels the run (exit 4). */
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Removes the run's private snapshot directory; a retried recursive `rm` by default. */
  removeSnapshot?: (directory: string) => Promise<void>;
  /** Clones the private snapshot; `createReviewSnapshot` by default. */
  createSnapshot?: typeof createReviewSnapshot;
  /** The store that checks, writes and expires the panel report copies; the panel `FileArtifactStore` by default. */
  reportCopiesStore?: (locations: Pick<PanelOutputLocations, "artifactsDirectory" | "outputDirectory">) => FileArtifactStore;
}

/** The single JSON error line every command writes to stderr. */
export function errorPayload(error: unknown): Record<string, unknown> {
  return error instanceof ReviewFnError ? { error: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } : { error: "REVIEWFN_UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
}

interface PanelInvocation {
  root: string;
  base: string;
  head: string;
  since?: string;
  issue?: string;
  pullRequest?: number;
  json: boolean;
  outputDirectory: string;
  artifactsDirectory: string;
}

/** Every `reviewfn panel` flag that takes a value; given bare or empty (`--output=`), it is an invalid argument (exit 1). */
const PANEL_VALUE_FLAGS = ["base", "head", "since", "issue", "pull-request", "panel", "output", "root", "config", "policy", "target-branch"] as const;

function requireValues(flags: Flags, names: readonly string[]): void {
  for (const name of names) if (flags.get(name) === true || flags.get(name) === "") throw new Error(`--${name} requires a value.`);
}

function panelInvocation(flags: Flags, environment: NodeJS.ProcessEnv): PanelInvocation {
  requireValues(flags, PANEL_VALUE_FLAGS);
  const root = path.resolve(optional(flags, "root") ?? process.cwd());
  const pullRequestText = optional(flags, "pull-request") ?? environment.GITHUB_EVENT_PULL_REQUEST_NUMBER;
  const pullRequest = pullRequestText === undefined ? undefined : Number(pullRequestText);
  if (pullRequestText !== undefined && (!/^[0-9]+$/.test(pullRequestText) || !Number.isSafeInteger(pullRequest) || pullRequest! <= 0)) throw new Error("--pull-request must be a positive integer.");
  return {
    root, base: required(flags, "base"), head: required(flags, "head"), since: optional(flags, "since"), issue: optional(flags, "issue"), pullRequest, json: flags.has("json"),
    outputDirectory: path.resolve(root, optional(flags, "output") ?? ".reviewfn/output"),
    artifactsDirectory: path.resolve(root, ".reviewfn/artifacts"),
  };
}

async function readArtifactJson(store: ArtifactStore, id: string): Promise<unknown> {
  const bytes = await store.get(id);
  if (!bytes) throw new ReviewFnError("REVIEWFN_ARTIFACT_UNSAFE", `Artifact ${id} is missing.`);
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}

/** Where a finished panel run saves its outputs, and the retention of the report copies. */
export interface PanelOutputLocations {
  /** The run's private artifact store, imported into `artifactsDirectory`. */
  ownedArtifacts: string;
  artifactsDirectory: string;
  outputDirectory: string;
  /** Retention of `panel-report.json` and `panel-report.md`, as of the stored report: the smaller of config and policy `reportDays`. */
  reportDays: number;
}

export interface SavedPanelRun {
  /** Undefined when the invocation was canceled before the report copies were written: nothing was written to the output directory. */
  reportPath?: string;
  rendered?: string;
  exitCode: number;
  /** The error that sets a nonzero exit code other than incomplete coverage, if any. */
  error?: unknown;
}

/**
 * Save a finished panel run: expire old artifacts and report copies, import the run's evidence into the artifact store,
 * then write `panel-report.json` and `panel-report.md` as a pair under report-copy retention. Cancellation is checked
 * once, after cleanup and before saving begins; nothing of the run is saved before that point. A cancellation before it,
 * or a failure while canceled before it, saves nothing and exits 4. Once saving begins it is not interrupted: the
 * saved report decides the exit code, and any failure exits 1 (4 only when the report records the cancellation), so an
 * exit 4 never leaves an uncanceled report of the run. `store` is a test seam.
 */
export async function savePanelRun(report: PanelReport, quorumMet: boolean, locations: PanelOutputLocations, signal?: AbortSignal, store: FileArtifactStore = new FileArtifactStore(locations.artifactsDirectory, locations.outputDirectory, PANEL_REPORT_COPY_NAMES)): Promise<SavedPanelRun> {
  const recordsCancellation = panelReportCanceled(report);
  let saving = false;
  try {
    const cleanup = await store.deleteExpired();
    const rendered = renderPanelMarkdownReport(report);
    if (signal?.aborted && !recordsCancellation) return { exitCode: PANEL_EXIT_CODES.canceled, error: new ReviewFnError("REVIEWFN_CANCELED", "The panel run was canceled before its report was saved; nothing of the run was saved.", { runId: report.runId }) };
    saving = true;
    // Merge retained artifacts without shortening expiration for prior references.
    await store.importFrom(locations.ownedArtifacts);
    await safeDirectory(locations.outputDirectory);
    await store.writeReportCopies(`${JSON.stringify(report, null, 2)}\n`, rendered, locations.reportDays);
    const reportPath = path.join(locations.outputDirectory, PANEL_REPORT_COPY_NAMES.json);
    if (recordsCancellation) return { reportPath, rendered, exitCode: PANEL_EXIT_CODES.canceled, error: new ReviewFnError("REVIEWFN_CANCELED", "The panel run was canceled; the saved report records the cancellation.", { runId: report.runId }) };
    if (cleanup.errors.length) return { reportPath, rendered, exitCode: PANEL_EXIT_CODES.error, error: new ReviewFnError("REVIEWFN_RETENTION_CLEANUP_FAILED", "Panel outputs were saved, but retention cleanup failed; inspect the artifact store and retry cleanup.", { errors: cleanup.errors }) };
    return { reportPath, rendered, exitCode: report.coverage !== "complete" || !quorumMet ? PANEL_EXIT_CODES.incomplete : PANEL_EXIT_CODES.complete };
  } catch (error) {
    // Before saving begins, a failure of a canceled run exits 4; once it has begun, only a report that records the
    // cancellation does.
    if (recordsCancellation || (!saving && signal?.aborted)) return { exitCode: PANEL_EXIT_CODES.canceled, error: new ReviewFnError("REVIEWFN_CANCELED", saving ? "The panel run was canceled, and saving its report, which records the cancellation, failed." : "The panel run was canceled before its report was saved; nothing of the run was saved.", { runId: report.runId, cause: errorPayload(error) }) };
    return { exitCode: PANEL_EXIT_CODES.error, error };
  }
}

function removeSnapshot(directory: string): Promise<void> { return rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

/**
 * `reviewfn panel`: run the panel over base..head and write `panel-report.json` and `panel-report.md` to the output
 * directory, with the run's evidence under `.reviewfn/artifacts`. Returns an exit code from `PANEL_EXIT_CODES`. Any
 * failure while the signal is aborted, before the report copies are written, exits 4.
 */
export async function runPanelCommand(flags: Flags, dependencies: PanelCommandDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? (text => void process.stdout.write(text));
  const stderr = dependencies.stderr ?? (text => void process.stderr.write(text));
  const environment = dependencies.environment ?? process.env;
  const signal = dependencies.signal;
  const fail = (code: number, error: unknown): number => { stderr(`${JSON.stringify(errorPayload(error))}\n`); return code; };
  const canceled = (error: unknown, stage: string): number => fail(PANEL_EXIT_CODES.canceled, error instanceof ReviewFnError && error.code === "REVIEWFN_CANCELED" ? error : new ReviewFnError("REVIEWFN_CANCELED", `The panel run was canceled ${stage}.`, { cause: errorPayload(error) }));
  let invocation: PanelInvocation;
  try { invocation = panelInvocation(flags, environment); }
  catch (error) { return fail(PANEL_EXIT_CODES.error, error); }
  let owned: string | undefined;
  // The saved report's stdout line, printed only after the private snapshot is removed and the exit code is final.
  let output: string | undefined;
  const reportCopiesStore = () => dependencies.reportCopiesStore?.(invocation) ?? new FileArtifactStore(invocation.artifactsDirectory, invocation.outputDirectory, PANEL_REPORT_COPY_NAMES);
  const code = await (async (): Promise<number> => { try {
    let coordinator: PanelCoordinator;
    let request: Parameters<PanelCoordinator["run"]>[0];
    let reportDays: number;
    let setup: { config: ReviewFnConfig; policy: ReviewPolicy; panelPolicy: PanelPolicy; harnesses: PanelHarnessAdapter[]; contractVersions: Record<string, string>; since?: string };
    // Preflight (exit 3): configuration, panel policy, harness resolution, refs that must name commits, and an output
    // directory whose lock is still held (such as one a killed run left behind).
    try {
      if (environment.GITHUB_TOKEN) throw new ReviewFnError("REVIEWFN_PREFLIGHT_FAILED", "Review execution must not receive GITHUB_TOKEN; use the separate publish command in a credentialed job.");
      const { root } = invocation;
      const { config, policy } = await loadRunConfiguration(root, invocation.base, flags, environment);
      reportDays = effectiveRetention(config, policy).reportDays;
      const { policy: panelPolicy } = await loadPanelPolicy({ root, base: invocation.base, head: invocation.head, trustedFromBase: trustedFromBase(flags, environment), path: optional(flags, "panel"), signal });
      const { harnesses, contractVersions } = await resolvePanelHarnesses(panelPolicy, config, dependencies.importHarnessModule, environment);
      for (const ref of [invocation.base, invocation.head]) await resolveCommit(root, ref);
      const since = invocation.since === undefined ? undefined : await resolveCommit(root, invocation.since);
      await reportCopiesStore().checkReportCopiesLock(signal);
      setup = { config, policy, panelPolicy, harnesses, contractVersions, since };
    } catch (error) {
      if (signal?.aborted) return canceled(error, "during preflight");
      return fail(PANEL_EXIT_CODES.preflight, error);
    }
    // Setup I/O (exit 1): the private snapshot and the run's artifact store.
    let ownedStore: FileArtifactStore;
    let ownedArtifacts: string;
    try {
      const { config, policy, panelPolicy, harnesses, contractVersions, since } = setup;
      owned = await mkdtemp(path.join(tmpdir(), "reviewfn-panel-cli-"));
      ownedArtifacts = path.join(owned, "artifacts");
      ownedStore = new FileArtifactStore(ownedArtifacts);
      const snapshot = await (dependencies.createSnapshot ?? createReviewSnapshot)(invocation.root, owned, invocation.base, invocation.head, optional(flags, "target-branch"), environment);
      await mkdir(ownedArtifacts, { recursive: true, mode: 0o700 });
      coordinator = new PanelCoordinator({
        sourceControl: new GitSourceControlAdapter({ targetBranch: snapshot.targetBranch }),
        contexts: contextAdapters(config, panelPolicy),
        harnesses,
        harnessContractVersions: contractVersions,
        execution: dependencies.execution?.(ownedStore) ?? new LocalIsolatedExecutionAdapter(ownedStore),
        artifacts: ownedStore,
        environment,
      });
      request = { root: snapshot.root, base: snapshot.base, head: snapshot.head, pullRequest: invocation.pullRequest, config, policy, issue: invocation.issue, panelPolicy, signal, ...(since === undefined ? {} : { since }) };
    } catch (error) {
      if (signal?.aborted) return canceled(error, "while the run was set up");
      return fail(PANEL_EXIT_CODES.error, error);
    }
    let report: PanelReport;
    let quorumMet: boolean;
    try {
      const result = await coordinator.run(request);
      report = result.report;
      quorumMet = result.quorum.every(item => item.met);
    } catch (error) {
      // Canceled while the report was stored: the superseding report records the cancellation; keep it as the output.
      const artifact = error instanceof ReviewFnError && error.code === "REVIEWFN_CANCELED" ? (error.details as { reportArtifact?: unknown } | undefined)?.reportArtifact : undefined;
      if (typeof artifact === "string") {
        report = await readArtifactJson(ownedStore, artifact) as PanelReport;
        quorumMet = false;
      } else if (signal?.aborted) return canceled(error, "while the panel ran");
      else if (error instanceof ReviewFnError && error.code === "REVIEWFN_PREFLIGHT_FAILED") return fail(PANEL_EXIT_CODES.preflight, error);
      else return fail(PANEL_EXIT_CODES.error, error);
    }
    const saved = await savePanelRun(report, quorumMet, { ownedArtifacts, artifactsDirectory: invocation.artifactsDirectory, outputDirectory: invocation.outputDirectory, reportDays }, signal, reportCopiesStore());
    // Exit 1 prints nothing on stdout, even when the report was saved (a retention cleanup failure).
    if (saved.reportPath !== undefined && saved.exitCode !== PANEL_EXIT_CODES.error) output = invocation.json ? `${JSON.stringify({ report: saved.reportPath, runId: report.runId })}\n` : `${saved.rendered}\n`;
    return saved.error === undefined ? saved.exitCode : fail(saved.exitCode, saved.error);
  } catch (error) {
    // Only reading a stored canceled report reaches here; nothing was written to the output directory.
    if (signal?.aborted) return canceled(error, "while its report was read");
    return fail(PANEL_EXIT_CODES.error, error);
  } })();
  // The private snapshot holds a copy of the repository. A run that cannot remove it always names it on stderr, prints
  // no report on stdout, and exits 1 instead of 0 or 2; exits 1, 3 and 4 keep their code.
  // stdout carries the report (Markdown or the `--json` line) only for exit 0, 2, or 4 with a saved report that records
  // the cancellation, and only once the snapshot is removed.
  if (owned !== undefined) {
    try { await (dependencies.removeSnapshot ?? removeSnapshot)(owned); }
    catch (error) {
      const leftover = fail(PANEL_EXIT_CODES.error, new ReviewFnError("REVIEWFN_SNAPSHOT_CLEANUP_FAILED", `The panel run's private snapshot ${owned} was not removed; delete it: ${error instanceof Error ? error.message : String(error)}`, { snapshot: owned }));
      return code === PANEL_EXIT_CODES.complete || code === PANEL_EXIT_CODES.incomplete ? leftover : code;
    }
  }
  if (output !== undefined) stdout(output);
  return code;
}

/**
 * Check a stored report for publication and render it. A 0.1 report must be completed and match `--profile`. A panel
 * report must be structurally valid and not canceled, and publishes only under the `panel` profile, so it maintains
 * one summary comment and one neutral `ReviewFn / panel` check.
 */
export function publication(value: unknown, flags: Flags): { report: ReviewReport | PanelReport; rendered: string; profile: string } {
  if (isPanelReport(value)) {
    const issues = panelStructureIssues("panelReport", value);
    if (issues.length) throw new Error(`Artifact is not a valid panel report: ${issues.slice(0, 5).map(issue => `${issue.path || "/"} ${issue.message}`).join("; ")}`);
    const profile = optional(flags, "profile") ?? "panel";
    if (profile !== "panel") throw new Error("A panel report publishes only under the panel profile.");
    if (panelReportCanceled(value)) throw new Error("The panel run was canceled; a canceled panel report is never published.");
    return { report: value, rendered: renderPanelMarkdownReport(value), profile };
  }
  const report = value as ReviewReport;
  if (report.execution !== "completed" || report.configuration.profile !== required(flags, "profile")) throw new Error("Artifact does not match trusted publication identity or is not completed.");
  return { report, rendered: renderMarkdownReport(report), profile: report.configuration.profile };
}

/**
 * `reviewfn report [--panel] [--input FILE]`: re-render a stored report as Markdown on stdout. With `--panel` the input
 * (`.reviewfn/output/panel-report.json` by default) must be a structurally valid panel report.
 */
export async function renderStoredReport(flags: Flags, root: string): Promise<string> {
  requireValues(flags, ["input", "root"]);
  const panelValue = flags.get("panel");
  if (typeof panelValue === "string") throw new Error(`--panel takes no value; use --input ${panelValue} to choose the report.`);
  const panel = flags.has("panel");
  const input = path.resolve(root, optional(flags, "input") ?? (panel ? ".reviewfn/output/panel-report.json" : ".reviewfn/output/report.json"));
  const value: unknown = JSON.parse((await safeRead(input)).toString("utf8"));
  const kind = typeof value === "object" && value !== null ? (value as { kind?: unknown }).kind : undefined;
  if (!panel) {
    if (kind === "reviewfn-panel") throw new ReviewFnError("REVIEWFN_REPORT_INVALID", `${path.relative(root, input)} is a panel report; use reviewfn report --panel.`);
    return renderMarkdownReport(value as ReviewReport);
  }
  const issues = panelStructureIssues("panelReport", value);
  if (issues.length) throw new ReviewFnError("REVIEWFN_REPORT_INVALID", `${path.relative(root, input)} is not a valid panel report: ${issues.slice(0, 5).map(issue => `${issue.path || "/"} ${issue.message}`).join("; ")}`, { issues });
  return renderPanelMarkdownReport(value as PanelReport);
}
